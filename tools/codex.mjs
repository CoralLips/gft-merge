// Codex sessions through the local Codex app-server: list and read them, or
// start one whose first message is a pool. That message is a real turn, so
// Codex lists the new session first, as if the person had written it.
import { spawn } from 'node:child_process';
import { open as openFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { BRIEF, COMPRESS } from '../home.mjs';
import { openLink } from '../openLink.mjs';

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

/** A session's context size: the last token count Codex wrote into its rollout file. */
async function contextOf(file) {
  const handle = await openFile(file).catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, 1 << 20);
    const { buffer } = await handle.read(Buffer.alloc(length), 0, length, size - length);
    const line = buffer
      .toString('utf8')
      .split('\n')
      .findLast(item => item.includes('"token_count"') && item.includes('last_token_usage'));
    return line ? (JSON.parse(line).payload?.info?.last_token_usage?.total_tokens ?? null) : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

const TURN_MS = 15 * 60 * 1000;

export function createCodexTool({
  connect = connectAppServer,
  retryMs = 500,
  open = openLink,
} = {}) {
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
   * open until the turn ends, since closing it would stop the reply. Then the
   * Codex app opens the thread: it does not notice on its own, at a steady
   * time, a thread another app-server wrote, and it cannot take a thread over
   * while this connection still writes to it.
   */
  const startTurn = async (server, threadId, text) => {
    const done = server.waitFor(
      'turn/completed',
      params => (params?.threadId ?? params?.turn?.threadId) === threadId,
      TURN_MS,
    );
    try {
      await server.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: text + BRIEF }],
      });
    } catch (error) {
      server.close();
      throw error;
    }
    done.finally(() => {
      server.close();
      open(`codex://threads/${threadId}`);
    });
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
        // Threads Codex does not keep (such as a compression's) are not the person's sessions.
        return (result?.data || [])
          .filter(thread => !thread.ephemeral)
          .map(describe)
          .filter(session => !since || (session.updatedAt || '') >= since);
      }),

    /** Reads newest first and stops at a page holding a message the pool already has. */
    /**
     * New messages, newest first until a page holds one the pool already has,
     * returned in time order; and the session's own context size in tokens.
     */
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
        const path = (await request('thread/read', { threadId: session.id }).catch(() => null))
          ?.thread?.path;
        return {
          messages: turns.reverse().flatMap(turnMessages),
          context: path ? await contextOf(path) : null,
        };
      }),

    /** The models this Codex account can use, default first. */
    models: () =>
      withServer(async request =>
        ((await request('model/list', { limit: 100 }))?.data || [])
          .filter(item => !item.hidden)
          .sort((a, b) => b.isDefault - a.isDefault)
          .map(item => ({ id: item.model, name: item.displayName || item.model })),
      ),

    /** One answer to the compression request, in a thread Codex does not keep. */
    async summarize({ text, model }) {
      const server = await opened();
      try {
        const { thread } = await server.request('thread/start', {
          ephemeral: true,
          ...(model ? { model } : {}),
          approvalPolicy: 'never',
          sandbox: 'read-only',
        });
        const done = server.waitFor(
          'turn/completed',
          params => (params?.threadId ?? params?.turn?.threadId) === thread.id,
          TURN_MS,
        );
        await server.request('turn/start', {
          threadId: thread.id,
          input: [{ type: 'text', text: COMPRESS + text }],
        });
        const result = await done;
        const answer = (result?.turn?.items || [])
          .filter(item => item.type === 'agentMessage' && item.text?.trim())
          .at(-1)?.text;
        if (!answer) throw failure('Codex 没有给出压缩结果');
        return answer.trim();
      } finally {
        server.close();
      }
    },

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
