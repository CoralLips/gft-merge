// Pools: named collections of session messages, and what each target has received.
//
// A pool file holds its sessions and a delivery record per target; its messages
// live beside it, one JSON line each, numbered by `seq` in arrival order.
//
// A session in a pool is either waiting (`fused: false`, shown in a grid cell)
// or fused into the pool. Injecting sends either the fused sessions or one
// waiting session, so a target records, per source session, the last `seq` it
// was sent. Sending only what is past that mark is what keeps repeats empty.

import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { MARKER, homeDir, readJson, writeJson, appendLines, readLines } from './home.mjs';

export const sessionKey = ({ tool, id }) => `${tool}:${id}`;
const messageKey = message => sessionKey({ tool: message.tool, id: message.sessionId });

const failure = (message, status = 400) => Object.assign(new Error(message), { status });
/** Text GFT-Merge sent into a session, including that sent before the name was capitalised. */
const sentByUs = text => text.toLowerCase().startsWith(MARKER.toLowerCase());

/** Pools written before sessions could wait are read as fused, with a per-session delivery mark. */
function upgrade(pool) {
  for (const session of pool.sessions) {
    session.fused ??= true;
    session.cell ??= null;
  }
  for (const delivery of Object.values(pool.deliveries)) {
    if (!delivery.sent) {
      const seq = delivery.sentSeq ?? delivery.deliveredSeq ?? 0;
      delivery.sent = Object.fromEntries(pool.sessions.map(session => [sessionKey(session), seq]));
      delete delivery.sentSeq;
      delete delivery.deliveredSeq;
    }
    // Sends that once waited for a hook count as sent.
    if (delivery.queued)
      for (const [s, seq] of Object.entries(delivery.queued))
        delivery.sent[s] = Math.max(delivery.sent[s] ?? 0, seq);
    delete delivery.queued;
    delivery.status = 'delivered';
  }
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
    writeJson(poolFile(pool.id), { ...pool, updatedAt: new Date().toISOString() });
  const findSession = (pool, key) => {
    const session = pool.sessions.find(item => sessionKey(item) === key);
    if (!session) throw failure('这段会话不在池子里', 404);
    return session;
  };

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
      nextSeq: 1,
      deliveries: {},
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
   * Adds a session (waiting, unless `place` says otherwise) and its new messages;
   * known message IDs and text GFT-Merge injected earlier are skipped.
   */
  const merge = (id, session, messages, place = {}) =>
    serially(id, async () => {
      const pool = await load(id);
      const { tool, id: sessionId, title, cwd } = session;
      const existing = pool.sessions.find(item => sessionKey(item) === sessionKey(session));
      if (existing) Object.assign(existing, { title, cwd });
      else
        pool.sessions.push({
          tool,
          id: sessionId,
          title,
          cwd: cwd ?? null,
          fused: place.fused ?? false,
          cell: place.cell ?? null,
          addedAt: new Date().toISOString(),
        });
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
      return { pool, added: fresh.length };
    });

  /** Fuses or unfuses a session, or moves it to another cell. */
  const place = (id, key, { fused, cell }) =>
    serially(id, async () => {
      const pool = await load(id);
      const session = findSession(pool, key);
      if (fused !== undefined) session.fused = !!fused;
      if (cell !== undefined) session.cell = Number.isInteger(cell) ? cell : null;
      await save(pool);
      return pool;
    });

  /** Takes a session and its messages out of the pool. Earlier deliveries stand. */
  const removeSession = (id, key) =>
    serially(id, async () => {
      const pool = await load(id);
      findSession(pool, key);
      pool.sessions = pool.sessions.filter(item => sessionKey(item) !== key);
      const kept = (await readLines(messageFile(id))).filter(
        message => messageKey(message) !== key,
      );
      await rm(messageFile(id), { force: true });
      await appendLines(messageFile(id), kept);
      await save(pool);
      return pool;
    });

  /** Moves a session with its messages into another pool, where it waits unfused. */
  async function moveSession(fromId, key, toId) {
    if (fromId === toId) return load(toId);
    const session = findSession(await load(fromId), key);
    const carried = (await readLines(messageFile(fromId)))
      .filter(message => messageKey(message) === key)
      .map(({ id, role, text, at }) => ({ id, role, text, at }));
    await merge(toId, session, carried, { fused: false, cell: null });
    await removeSession(fromId, key);
    return load(toId);
  }

  /** The pool's messages in conversation order. */
  async function messages(id) {
    await load(id);
    return (await readLines(messageFile(id))).sort(byTime);
  }

  /**
   * What a target has not been sent yet from `sources` (session keys; the fused
   * sessions when omitted), as the text to inject. The target's own messages
   * are left out; past `limit` characters the oldest messages give way.
   */
  async function pending(id, target, { sources, limit = Infinity } = {}) {
    const pool = await load(id);
    const key = sessionKey(target);
    const chosen = new Set(
      sources ?? pool.sessions.filter(session => session.fused).map(sessionKey),
    );
    chosen.delete(key);
    const sent = pool.deliveries[key]?.sent ?? {};
    const mark = source => sent[source] ?? 0;
    const unseen = (await readLines(messageFile(id)))
      .filter(message => chosen.has(messageKey(message)))
      .filter(message => message.seq > mark(messageKey(message)))
      .sort(byTime);
    const upto = {};
    for (const message of unseen)
      upto[messageKey(message)] = Math.max(upto[messageKey(message)] ?? 0, message.seq);
    const formatted = injectionText(pool, unseen, limit);
    return { ...formatted, upto, count: unseen.length - formatted.omitted };
  }

  /** Records what a target was sent. */
  const recordDelivery = (id, target, upto) =>
    serially(id, async () => {
      const pool = await load(id);
      const key = sessionKey(target);
      const sent = { ...pool.deliveries[key]?.sent };
      for (const [source, seq] of Object.entries(upto))
        sent[source] = Math.max(sent[source] ?? 0, seq);
      pool.deliveries[key] = {
        tool: target.tool,
        id: target.id,
        title: target.title,
        cwd: target.cwd ?? null,
        sent,
        status: 'delivered',
        at: new Date().toISOString(),
      };
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
    place,
    removeSession,
    moveSession,
    knownIds,
    messages,
    pending,
    recordDelivery,
  };
}

const byTime = (a, b) => (a.at || '').localeCompare(b.at || '') || a.seq - b.seq;

const TOOL_NAMES = { claude: 'Claude Code', codex: 'Codex' };
const stamp = at => (at ? at.slice(5, 16).replace('T', ' ') : '');

/** Formats messages for injection, keeping the newest within `limit` characters. */
export function injectionText(pool, messages, limit = Infinity) {
  if (!messages.length) return { text: '', omitted: 0, chars: 0 };
  const titles = new Map(pool.sessions.map(session => [sessionKey(session), session.title]));
  const label = message =>
    `${TOOL_NAMES[message.tool] || message.tool}·${titles.get(messageKey(message)) || message.sessionId}`;
  const blocks = messages.map(
    message =>
      `—— ${label(message)} · ${message.role === 'user' ? '用户' : 'AI'}${message.at ? ` · ${stamp(message.at)}` : ''}\n${message.text}`,
  );
  let start = 0;
  let size = blocks.reduce((total, block) => total + block.length + 2, 0);
  while (start < blocks.length - 1 && size > limit) size -= blocks[start++].length + 2;
  const sources = [...new Set(messages.slice(start).map(label))].join('；');
  const header = [
    `${MARKER}来自池子「${pool.name}」的合并上下文：${sources}。共 ${blocks.length - start} 段，按时间排列。`,
    ...(start ? [`更早的 ${start} 段因长度已省略。`] : []),
    '这是其他会话里的讨论记录，供你接着工作参考；若内容被另存为文件，请先完整读取再继续。',
  ].join('\n');
  const text = `${header}\n\n${blocks.slice(start).join('\n\n')}`;
  return { text, omitted: start, chars: text.length };
}
