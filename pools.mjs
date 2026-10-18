// Pools: named workbenches of session messages.
//
// A pool file holds its sessions and balls; its messages live beside it, one
// JSON line each, numbered by `seq` in arrival order.
//
// Every session sits in a ball. A ball holds one session or several fused ones,
// and may hold compacts: the model's condensed text of sessions that were fused
// and compressed. Compacted sessions leave the pool; a compact cannot be split.
// Dragging a ball up starts a session with the ball's content.
import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { MARKER, homeDir, readJson, writeJson, appendLines, readLines } from './home.mjs';

export const sessionKey = ({ tool, id }) => `${tool}:${id}`;
const messageKey = message => sessionKey({ tool: message.tool, id: message.sessionId });
const newId = () => randomUUID().slice(0, 8);

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
/** Text GFT-Merge sent into a session, including that sent before the name was capitalised. */
const sentByUs = text => text.toLowerCase().startsWith(MARKER.toLowerCase());

/**
 * Pools from before balls: the fused sessions become one ball, each waiting
 * session its own. Ball IDs follow the session order, so every read of a pool
 * not yet saved again gives the same IDs.
 */
function upgrade(pool) {
  if (!pool.balls) {
    pool.balls = [];
    let fused = null;
    for (const [index, session] of pool.sessions.entries()) {
      if (session.fused !== false) {
        fused ??= { id: 'fused', cell: null, compacts: [] };
        session.ball = fused.id;
      } else {
        const ball = { id: `waiting-${index}`, cell: session.cell ?? null, compacts: [] };
        pool.balls.push(ball);
        session.ball = ball.id;
      }
      delete session.fused;
      delete session.cell;
    }
    if (fused) pool.balls.unshift(fused);
  }
  delete pool.deliveries;
  return pool;
}

/** Drops balls left with neither sessions nor compacts. */
function tidy(pool) {
  pool.balls = pool.balls.filter(
    ball => ball.compacts.length || pool.sessions.some(session => session.ball === ball.id),
  );
  return pool;
}

export function createPools({ home = homeDir() } = {}) {
  const directory = path.join(home, 'pools');
  const poolFile = id => path.join(directory, `${id}.json`);
  const messageFile = id => path.join(directory, `${id}.jsonl`);
  // One server owns the files; chaining per pool keeps its writes in order.
  const queues = new Map();
  const serially = (id, run) => {
    const next = (queues.get(id) || Promise.resolve()).catch(() => {}).then(run);
    queues.set(id, next);
    return next;
  };

  async function load(id) {
    if (!/^[\w-]+$/.test(id)) throw failure('池子编号无效');
    const pool = await readJson(poolFile(id));
    if (!pool) throw failure('池子不存在', 404);
    return upgrade(pool);
  }
  const save = pool =>
    writeJson(poolFile(pool.id), { ...tidy(pool), updatedAt: new Date().toISOString() });
  const findSession = (pool, key) => {
    const session = pool.sessions.find(item => sessionKey(item) === key);
    if (!session) throw failure('这段会话不在池子里', 404);
    return session;
  };
  const findBall = (pool, ballId) => {
    const ball = pool.balls.find(item => item.id === ballId);
    if (!ball) throw failure('这个球不在池子里', 404);
    return ball;
  };
  const newBall = (pool, cell = null) => {
    const ball = { id: newId(), cell: Number.isInteger(cell) ? cell : null, compacts: [] };
    pool.balls.push(ball);
    return ball;
  };
  /** Rewrites the message file without the given sessions' messages. */
  async function dropMessages(id, keys) {
    const kept = (await readLines(messageFile(id))).filter(
      message => !keys.has(messageKey(message)),
    );
    await rm(messageFile(id), { force: true });
    await appendLines(messageFile(id), kept);
  }

  async function list() {
    const names = await readdir(directory).catch(() => []);
    const pools = await Promise.all(
      names
        .filter(name => name.endsWith('.json'))
        .map(name => readJson(path.join(directory, name))),
    );
    return pools
      .filter(Boolean)
      .map(upgrade)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async function create(name) {
    const now = new Date().toISOString();
    const pool = {
      id: randomUUID(),
      name: String(name || '').trim() || '新池子',
      createdAt: now,
      updatedAt: now,
      sessions: [],
      balls: [],
      nextSeq: 1,
    };
    await save(pool);
    return pool;
  }

  const rename = (id, name) =>
    serially(id, async () => {
      const pool = await load(id);
      if (!String(name || '').trim()) throw failure('名字不能为空');
      pool.name = String(name).trim();
      await save(pool);
      return pool;
    });

  const remove = id =>
    serially(id, async () => {
      await load(id);
      await rm(poolFile(id), { force: true });
      await rm(messageFile(id), { force: true });
    });

  /** IDs of a session's messages already in the pool, so a reader can stop early. */
  async function knownIds(id, session) {
    return new Set(
      (await readLines(messageFile(id)))
        .filter(message => messageKey(message) === sessionKey(session))
        .map(message => message.id),
    );
  }

  /**
   * Adds a session's new messages, and the session itself if it is new: into
   * ball `place.ball` when given, else a new ball at `place.cell`. Known message
   * IDs and text GFT-Merge sent are skipped. `context` is the session's own
   * context size in tokens, as its tool reports it.
   */
  const merge = (id, session, messages, place = {}, context) =>
    serially(id, async () => {
      const pool = await load(id);
      const { tool, id: sessionId, title, cwd } = session;
      let existing = pool.sessions.find(item => sessionKey(item) === sessionKey(session));
      if (existing) Object.assign(existing, { title, cwd });
      else {
        const ball = pool.balls.find(item => item.id === place.ball) || newBall(pool, place.cell);
        existing = {
          tool,
          id: sessionId,
          title,
          cwd: cwd ?? null,
          ball: ball.id,
          addedAt: new Date().toISOString(),
        };
        pool.sessions.push(existing);
      }
      if (Number.isFinite(context)) existing.context = context;
      const known = await knownIds(id, session);
      const fresh = messages
        .filter(message => !known.has(message.id) && !sentByUs(message.text))
        .map(message => ({
          seq: pool.nextSeq++,
          tool,
          sessionId,
          id: message.id,
          role: message.role,
          text: message.text,
          at: message.at || null,
        }));
      await appendLines(messageFile(id), fresh);
      await save(pool);
      return { pool, added: fresh.length, ball: existing.ball };
    });

  /** Moves a ball to another cell. */
  const placeBall = (id, ballId, cell) =>
    serially(id, async () => {
      const pool = await load(id);
      findBall(pool, ballId).cell = Number.isInteger(cell) ? cell : null;
      await save(pool);
      return pool;
    });

  /** Fuses ball `fromId` into ball `intoId`: its sessions and compacts join it. */
  const fuseBalls = (id, fromId, intoId) =>
    serially(id, async () => {
      const pool = await load(id);
      const from = findBall(pool, fromId);
      const into = findBall(pool, intoId);
      if (from === into) return pool;
      for (const session of pool.sessions) if (session.ball === from.id) session.ball = into.id;
      into.compacts.push(...from.compacts);
      from.compacts = [];
      await save(pool);
      return pool;
    });

  /** Takes a session out of its ball: into ball `to.ball`, or a new ball at `to.cell`. */
  const splitSession = (id, key, to = {}) =>
    serially(id, async () => {
      const pool = await load(id);
      const session = findSession(pool, key);
      const ball = pool.balls.find(item => item.id === to.ball) || newBall(pool, to.cell);
      session.ball = ball.id;
      await save(pool);
      return pool;
    });

  /** Takes a session and its messages out of the pool. */
  const removeSession = (id, key) =>
    serially(id, async () => {
      const pool = await load(id);
      findSession(pool, key);
      pool.sessions = pool.sessions.filter(item => sessionKey(item) !== key);
      await dropMessages(id, new Set([key]));
      await save(pool);
      return pool;
    });

  /** Takes a ball, its sessions and their messages out of the pool. */
  const removeBall = (id, ballId) =>
    serially(id, async () => {
      const pool = await load(id);
      findBall(pool, ballId);
      const keys = new Set(
        pool.sessions.filter(session => session.ball === ballId).map(sessionKey),
      );
      pool.sessions = pool.sessions.filter(session => session.ball !== ballId);
      pool.balls = pool.balls.filter(ball => ball.id !== ballId);
      await dropMessages(id, keys);
      await save(pool);
      return pool;
    });

  /** Moves a ball with its sessions, messages and compacts into another pool. */
  async function moveBall(fromId, ballId, toId) {
    if (fromId === toId) return load(toId);
    const from = await load(fromId);
    const ball = findBall(from, ballId);
    const sessions = from.sessions.filter(session => session.ball === ballId);
    const lines = await readLines(messageFile(fromId));
    let target = null;
    for (const session of sessions) {
      const carried = lines
        .filter(message => messageKey(message) === sessionKey(session))
        .map(({ id, role, text, at }) => ({ id, role, text, at }));
      ({ ball: target } = await merge(toId, session, carried, { ball: target }, session.context));
    }
    await serially(toId, async () => {
      const to = await load(toId);
      const into = to.balls.find(item => item.id === target) || newBall(to);
      into.compacts.push(...ball.compacts);
      await save(to);
    });
    await removeBall(fromId, ballId);
    return load(toId);
  }

  /** The pool's messages in conversation order. */
  async function messages(id) {
    await load(id);
    return (await readLines(messageFile(id))).sort(byTime);
  }

  /**
   * A ball's content as the text to send: its compacts, then its sessions'
   * messages in time order. With `only`, just that one session of the ball.
   */
  async function ballContent(id, ballId, { only } = {}) {
    const pool = await load(id);
    const ball = findBall(pool, ballId);
    const keys = new Set(
      pool.sessions
        .filter(session => session.ball === ballId)
        .map(sessionKey)
        .filter(key => !only || key === only),
    );
    const compacts = only ? [] : ball.compacts;
    const lines = (await readLines(messageFile(id)))
      .filter(message => keys.has(messageKey(message)))
      .sort(byTime);
    const upto = {};
    for (const message of lines)
      upto[messageKey(message)] = Math.max(upto[messageKey(message)] ?? 0, message.seq);
    return {
      ...injectionText(pool, { compacts, messages: lines }),
      keys: [...keys],
      compactIds: compacts.map(compact => compact.id),
      upto,
      count: lines.length + compacts.length,
    };
  }

  /**
   * Replaces what a compression read (`snapshot`: the ball's sessions up to a
   * message, and its compacts) with one compact holding `text`. Sessions fused
   * in meanwhile stay as they are. A snapshot session that left the ball, or
   * a compact that left it, means the ball changed under the compression, which
   * is then dropped.
   */
  const seal = (id, ballId, snapshot, compact) =>
    serially(id, async () => {
      const pool = await load(id);
      const ball = findBall(pool, ballId);
      const inBall = new Set(
        pool.sessions.filter(session => session.ball === ballId).map(sessionKey),
      );
      if (
        !snapshot.keys.every(key => inBall.has(key)) ||
        !snapshot.compactIds.every(cid => ball.compacts.some(item => item.id === cid))
      )
        throw failure('压缩期间这个球的组成变了，这次压缩作废', 409);
      const sealed = pool.sessions.filter(session => snapshot.keys.includes(sessionKey(session)));
      const from = [
        ...ball.compacts
          .filter(item => snapshot.compactIds.includes(item.id))
          .flatMap(item => item.from),
        ...sealed.map(({ tool, id: sessionId, title, cwd }) => ({
          tool,
          id: sessionId,
          title,
          cwd,
        })),
      ];
      ball.compacts = [
        ...ball.compacts.filter(item => !snapshot.compactIds.includes(item.id)),
        { id: newId(), from, at: new Date().toISOString(), ...compact },
      ];
      pool.sessions = pool.sessions.filter(session => !snapshot.keys.includes(sessionKey(session)));
      await dropMessages(id, new Set(snapshot.keys));
      await save(pool);
      return pool;
    });

  return {
    list,
    create,
    rename,
    remove,
    load,
    merge,
    placeBall,
    fuseBalls,
    splitSession,
    removeSession,
    removeBall,
    moveBall,
    knownIds,
    messages,
    ballContent,
    seal,
  };
}

const byTime = (a, b) => (a.at || '').localeCompare(b.at || '') || a.seq - b.seq;

const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex' };
const stamp = at => (at ? at.slice(5, 16).replace('T', ' ') : '');
const labelOf = item => `${TOOL_NAMES[item.tool] || item.tool}·${item.title || item.id}`;

/** Formats a ball's compacts and messages as the text that starts a session. */
export function injectionText(pool, { compacts = [], messages = [] }) {
  if (!compacts.length && !messages.length) return { text: '', chars: 0 };
  const titles = new Map(pool.sessions.map(session => [sessionKey(session), session.title]));
  const label = message =>
    labelOf({ tool: message.tool, id: message.sessionId, title: titles.get(messageKey(message)) });
  const blocks = [
    ...compacts.map(
      compact => `—— 已压缩 · 来自 ${compact.from.map(labelOf).join('、')}\n${compact.text}`,
    ),
    ...messages.map(
      message =>
        `—— ${label(message)} · ${message.role === 'user' ? '用户' : 'AI'}${message.at ? ` · ${stamp(message.at)}` : ''}\n${message.text}`,
    ),
  ];
  const sources = [
    ...compacts.flatMap(compact => compact.from.map(labelOf)),
    ...new Set(messages.map(label)),
  ];
  const header = [
    `${MARKER}来自池子「${pool.name}」的合并上下文：${[...new Set(sources)].join('；')}。`,
    ...(compacts.length ? ['其中标“已压缩”的部分是压缩后的摘要，其余按时间排列。'] : []),
    '这是其他会话里的讨论记录，供你接着工作参考；若内容被另存为文件，请先完整读取再继续。',
  ].join('\n');
  const text = `${header}\n\n${blocks.join('\n\n')}`;
  return { text, chars: text.length };
}
