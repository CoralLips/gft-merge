// Codex sessions through the local Codex app-server: list and read them, or
// start one whose first message is a pool. That message is a real turn, so
// Codex lists the new session first, as if the person had written it.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const failure = (message, status = 502, extra = {}) =>
  Object.assign(new Error(message), { status, ...extra });
const dateOf = value =>
  typeof value === 'number'
    ? new Date(value < 1e12 ? value * 1000 : value).toISOString()
    : value || null;

/** A short-lived app-server connection. Requests from the server (approvals) are refused. */
export async function connectAppServer({
  binary = process.env.GFT_CODEX_BIN || 'codex',
  timeoutMs = 30000,
} = {}) {
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let sequence = 0;
  const pending = new Map();
  const listeners = new Set();
  const rejectAll = error => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };
  child.once('error', () => rejectAll(failure('无法启动本机 Codex，请确认已安装 Codex。')));
  // The tail of Codex's own error output says why it stopped, if it does.
  let errorTail = '';
  child.stderr.on('data', chunk => (errorTail = (errorTail + chunk).slice(-2000)));
  child.once('exit', code =>
    rejectAll(
      failure('本机 Codex 连接已关闭。', 502, {
        codexMessage: `exit ${code}: ${errorTail.trim()}`,
      }),
    ),
  );
  child.stdin.on('error', () => {});
  createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method && message.id !== undefined) {
      child.stdin.write(
        JSON.stringify({ id: message.id, error: { code: -32601, message: 'Not supported' } }) +
          '\n',
      );
      return;
    }
    if (message.method) {
      for (const listener of listeners) listener(message);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    if (message.error)
      request.reject(
        failure('Codex 没有完成这次操作，请稍后再试。', 502, {
          codexMessage: message.error.message || '',
        }),
      );
    else request.resolve(message.result);
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(failure('Codex 响应超时，请重试。', 504));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  /** Resolves with the first notification `method` for which `accept` holds, or null at `waitMs`. */
  const waitFor = (method, accept, waitMs) =>
    new Promise(resolve => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        resolve(null);
      }, waitMs);
      const listener = message => {
        if (message.method !== method || !accept(message.params)) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(message.params);
      };
      listeners.add(listener);
    });
  const close = () => {
    child.stdin.end();
    child.kill();
  };
  try {
    await request('initialize', {
      clientInfo: { name: 'gft_merge', title: 'GFT-Merge', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
    return { request, waitFor, close };
  } catch (error) {
    close();
    throw error;
  }
}

const describe = thread => ({
  tool: 'codex',
  id: thread.id,
  title: thread.name || thread.preview || thread.id,
  cwd: thread.cwd || null,
  updatedAt: dateOf(thread.updatedAt),
});

/**
 * A turn's condensed messages: what the person said and the final answer.
 * Commentary, tool calls and unfinished turns are left out.
 */
export function turnMessages(turn) {
  if (turn.status === 'inProgress') return [];
  const items = turn.items || [];
  const users = items
    .filter(item => item.type === 'userMessage')
    .map(item => ({
      id: String(item.id),
      role: 'user',
      text: (item.content || [])
        .filter(part => part?.type === 'text')
        .map(part => part.text)
        .join('\n')
        .trim(),
      at: dateOf(turn.startedAt),
    }));
  const answers = items.filter(item => item.type === 'agentMessage' && item.text?.trim());
  const final =
    answers.findLast(item => ['final', 'final_answer'].includes(item.phase)) || answers.at(-1);
  const reply = final
    ? [
        {
          id: String(final.id),
          role: 'assistant',
          text: final.text.trim(),
          at: dateOf(turn.completedAt),
        },
      ]
    : [];
  return [...users, ...reply].filter(message => message.text);
}

/** Codex quits at start when another app-server is setting up its state database. */
const startupClash = error => /initialize (sqlite )?state runtime/i.test(error.codexMessage || '');

/** Asked with each sent message, so the reply is short. */
const ACK = '\n\n请只回复一句：已收到，并说明来自哪些会话、共几段。';
const TURN_MS = 15 * 60 * 1000;

export function createCodexTool({ connect = connectAppServer, retryMs = 500 } = {}) {
  // One app-server starts at a time from here: two starting together clash over
  // Codex's state database. A clash with the Codex app starting up is retried once.
  let last = Promise.resolve();
  const opened = () => {
    const next = last
      .catch(() => {})
      .then(() =>
        connect().catch(async error => {
          if (!startupClash(error)) throw error;
          await new Promise(resolve => setTimeout(resolve, retryMs));
          return connect();
        }),
      );
    last = next;
    return next;
  };
  const withServer = async run => {
    const server = await opened();
    try {
      return await run(server.request);
    } finally {
      server.close();
    }
  };
  /**
   * Starts a turn and returns once Codex has taken it; the connection stays
   * open until the turn ends, since closing it would stop the reply.
   */
  const startTurn = async (server, threadId, text) => {
    const done = server.waitFor(
      'turn/completed',
      params => (params?.threadId ?? params?.turn?.threadId) === threadId,
      TURN_MS,
    );
    try {
      await server.request('turn/start', { threadId, input: [{ type: 'text', text: text + ACK }] });
    } catch (error) {
      server.close();
      throw error;
    }
    done.finally(() => server.close());
  };

  return {
    id: 'codex',
    name: 'Codex',

    listSessions: ({ since, limit = 60 } = {}) =>
      withServer(async request => {
        const result = await request('thread/list', {
          limit,
          sortKey: 'updated_at',
          sortDirection: 'desc',
          useStateDbOnly: true,
        });
        return (result?.data || [])
          .map(describe)
          .filter(session => !since || (session.updatedAt || '') >= since);
      }),

    /** Reads newest first and stops at a page holding a message the pool already has. */
    readMessages: (session, { known = new Set() } = {}) =>
      withServer(async request => {
        const turns = [];
        let cursor = null;
        do {
          const page = await request('thread/turns/list', {
            threadId: session.id,
            limit: 20,
            sortDirection: 'desc',
            itemsView: 'full',
            ...(cursor ? { cursor } : {}),
          });
          const data = page?.data || [];
          turns.push(...data);
          if (data.some(turn => turnMessages(turn).some(message => known.has(message.id)))) break;
          cursor = page?.nextCursor || null;
        } while (cursor);
        return turns.reverse().flatMap(turnMessages);
      }),

    /** Starts a session whose first message is `text`; Codex answers in the background. */
    async create({ cwd, title, text }) {
      const server = await opened();
      let thread;
      try {
        // The account's default model; an unset model may be one the account cannot use.
        const models = await server.request('model/list', { limit: 100 });
        const model = models?.data?.find(item => item.isDefault)?.model;
        ({ thread } = await server.request('thread/start', {
          cwd,
          ...(model ? { model } : {}),
          approvalPolicy: 'on-request',
          sandbox: 'workspace-write',
        }));
        await server.request('thread/name/set', { threadId: thread.id, name: title });
      } catch (error) {
        server.close();
        throw error;
      }
      await startTurn(server, thread.id, text);
      return { session: { ...describe(thread), title, updatedAt: new Date().toISOString() } };
    },
  };
}
