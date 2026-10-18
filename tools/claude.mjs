// Claude Code sessions through the official Agent SDK: list and read them, or
// start one whose first message is a pool. The Claude app does not pick up a
// session another program wrote, so the new one is brought in through the app's
// own claude://resume link, which imports and opens it.
//
// The Claude app and the terminal share one store of sessions; the app keeps its
// own index on top, with the titles it shows, its activity order and which
// sessions are archived. The app's sessions are listed from that index, so the
// list matches the app: archived ones and ones deleted there are left out (the
// SDK's own listing also misses some of them), and so are threads a remote
// Claude started through Remote Control, which the app keeps under Threads
// rather than the session list. Sessions started in the terminal come from the
// SDK and are marked CLI.
import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { COMPRESS, readJson } from '../home.mjs';
import { openLink } from '../openLink.mjs';

const failure = (message, status = 502) => Object.assign(new Error(message), { status });

// A parent Claude Code session's variables would make the SDK child reuse that
// session's host instead of the person's own login.
const PARENT_SESSION = /^(CLAUDECODE$|CLAUDE_PID$|CLAUDE_AGENT_SDK_|CLAUDE_CODE_)/;
export const childEnvironment = (env = process.env) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !PARENT_SESSION.test(name)));
/** Asked with each sent message, so the reply is short. */
const ACK = '\n\n请只回复一句：已收到，并说明来自哪些会话、共几段。';

const dateOf = value => (typeof value === 'number' ? new Date(value).toISOString() : value || null);

/** Where the Claude app keeps its index of Code sessions. */
function defaultDesktopDir() {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'Claude', 'claude-code-sessions');
}
const defaultProjectsDir = () =>
  path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

/** The start of a transcript: what its first lines say about the session. */
async function headOf(file) {
  const handle = await open(file).catch(() => null);
  if (!handle) return null;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(65536), 0, 65536, 0);
    const text = buffer.toString('utf8', 0, bytesRead);
    const field = name => text.match(new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`))?.[1];
    return {
      entrypoint: field('entrypoint') ?? null,
      cwd: field('cwd') ? JSON.parse(`"${field('cwd')}"`) : null,
      startedAt: field('timestamp') ?? null,
    };
  } finally {
    await handle.close();
  }
}

/** Where a session was started, from the start of its transcript ('cli', 'claude-desktop', …). */
async function entrypointOf(projectsDir, sessionId) {
  for (const project of await readdir(projectsDir).catch(() => [])) {
    const head = await headOf(path.join(projectsDir, project, `${sessionId}.jsonl`));
    if (head) return head.entrypoint;
  }
  return null;
}

const samePath = (a, b) =>
  !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * Newer app records leave out the transcript's ID. Such a record is matched to
 * the app-started transcript in its folder that no record claims and that began
 * soonest after the record was created.
 */
async function matchUnnamed(records, claimed, projectsDir) {
  const unnamed = records.filter(record => !record.cliSessionId && record.createdAt);
  if (!unnamed.length) return;
  const since = Math.min(...unnamed.map(record => record.createdAt));
  const candidates = [];
  for (const project of await readdir(projectsDir).catch(() => []))
    for (const name of await readdir(path.join(projectsDir, project)).catch(() => [])) {
      const id = name.replace(/\.jsonl$/, '');
      if (id === name || claimed.has(id)) continue;
      const file = path.join(projectsDir, project, name);
      if (((await stat(file).catch(() => null))?.mtimeMs ?? 0) < since) continue;
      const head = await headOf(file);
      if (head?.entrypoint === 'claude-desktop' && head.startedAt)
        candidates.push({ id, ...head, at: Date.parse(head.startedAt) });
    }
  for (const record of unnamed.sort((a, b) => a.createdAt - b.createdAt)) {
    const match = candidates
      .filter(item => !claimed.has(item.id) && item.at >= record.createdAt - 5000)
      .filter(item => samePath(item.cwd, record.cwd))
      .sort((a, b) => a.at - b.at)[0];
    if (!match) continue;
    record.cliSessionId = match.id;
    claimed.add(match.id);
  }
}

/** The app's index as a map from session ID to its record, or null without the app. */
async function readDesktopIndex(directory, projectsDir) {
  const records = [];
  let found = false;
  for (const account of await readdir(directory).catch(() => []))
    for (const project of await readdir(path.join(directory, account)).catch(() => [])) {
      const folder = path.join(directory, account, project);
      for (const name of await readdir(folder).catch(() => [])) {
        if (!/^local_.*\.json$/.test(name)) continue;
        found = true;
        const record = await readJson(path.join(folder, name));
        if (record) records.push(record);
      }
    }
  if (!found) return null;
  await matchUnnamed(
    records,
    new Set(records.map(record => record.cliSessionId).filter(Boolean)),
    projectsDir,
  );
  return new Map(
    records.filter(record => record.cliSessionId).map(record => [record.cliSessionId, record]),
  );
}

const fromSdk = (session, origin) => ({
  tool: 'claude',
  id: session.sessionId,
  title: session.customTitle || session.summary || session.firstPrompt || session.sessionId,
  cwd: session.cwd || null,
  updatedAt: dateOf(session.lastModified),
  ...(origin ? { origin } : {}),
});

const fromDesktop = record => ({
  tool: 'claude',
  id: record.cliSessionId,
  title: record.title || record.cliSessionId,
  cwd: record.cwd || null,
  updatedAt: dateOf(record.lastActivityAt),
});

/** Visible text of a message, without tool blocks and system reminders. */
function textOf(content) {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter(block => block?.type === 'text')
            .map(block => block.text)
            .join('\n')
        : '';
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}

/**
 * Condensed messages: what the person said, and the last answer of each turn.
 * Tool traffic, subagents and an unfinished last turn are left out.
 */
export function condense(raw) {
  const messages = [];
  let answer = null;
  const flush = () => {
    if (answer) messages.push(answer);
    answer = null;
  };
  for (const item of raw) {
    if (item.parent_tool_use_id || item.parent_agent_id || item.isMeta || item.isCompactSummary)
      continue;
    const content = item.message?.content;
    if (item.type === 'user') {
      if (Array.isArray(content) && content.some(block => block?.type === 'tool_result')) continue;
      const text = textOf(content);
      if (!text || text.startsWith('<command-') || text.startsWith('<local-command')) continue;
      flush();
      messages.push({ id: item.uuid, role: 'user', text, at: item.timestamp || null });
    } else if (item.type === 'assistant') {
      const text = textOf(content);
      if (!text) continue;
      answer = {
        id: item.uuid,
        role: 'assistant',
        text,
        at: item.timestamp || null,
        done: item.message?.stop_reason === 'end_turn',
      };
    }
  }
  // The last turn counts once its answer has ended.
  if (answer?.done) flush();
  return messages.map(({ done, ...message }) => message);
}

async function defaultSdk() {
  try {
    return await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    throw failure('缺少 Claude Code 读取组件，请在 GFT-Merge 目录运行 npm install。');
  }
}

/** One turn through the SDK; resolves with the session ID once Claude has answered. */
async function run(api, text, options) {
  let sessionId = null;
  let result = null;
  for await (const message of api.query({
    prompt: text + ACK,
    options: { ...options, env: childEnvironment(), settingSources: [], tools: [], maxTurns: 1 },
  })) {
    sessionId ||= message.session_id || null;
    if (message.type === 'result') result = message;
  }
  if (!sessionId || result?.is_error)
    throw failure(`Claude 没有完成这次发送：${result?.result || '没有返回会话'}`);
  return sessionId;
}

export function createClaudeTool({
  sdk = defaultSdk,
  desktopDir = defaultDesktopDir(),
  projectsDir = defaultProjectsDir(),
  open = openLink,
} = {}) {
  /** Brings a session the SDK wrote into the Claude app, which opens it. */
  const reveal = sessionId => open(`claude://resume?session=${sessionId}`);

  return {
    id: 'claude',
    name: 'Claude Code',

    async listSessions({ since, limit = 60 } = {}) {
      const api = await sdk();
      const index = await readDesktopIndex(desktopDir, projectsDir);
      // Same set as the terminal's /resume: scripted and SDK runs are left out.
      const sdkSessions = await api.listSessions({
        includeWorktrees: false,
        includeProgrammatic: false,
        limit: limit * 2,
      });
      const listed = [];
      if (!index) listed.push(...sdkSessions.map(session => fromSdk(session)));
      else {
        for (const record of index.values())
          if (!record.isArchived && !record.remoteControlSpawn) listed.push(fromDesktop(record));
        // Not in the app's index: started in the terminal, or deleted in the app.
        for (const session of sdkSessions)
          if (
            !index.has(session.sessionId) &&
            (await entrypointOf(projectsDir, session.sessionId)) === 'cli'
          )
            listed.push(fromSdk(session, 'CLI'));
      }
      return listed
        .filter(session => !since || (session.updatedAt || '') >= since)
        .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
        .slice(0, limit);
    },

    /** Starts a session in `cwd` whose first message is `text`. */
    async create({ cwd, title, text }) {
      const api = await sdk();
      const id = await run(api, text, { cwd });
      await api.renameSession(id, title, { dir: cwd }).catch(() => {});
      reveal(id);
      return {
        session: { tool: 'claude', id, title, cwd, updatedAt: new Date().toISOString() },
      };
    },

    // Read by ID alone: the SDK finds the transcript in any project folder, which
    // a folder hint can miss (it does for some of the app's sessions).
    async readMessages(session) {
      const api = await sdk();
      const raw =
        (await api.getSessionMessages(session.id, { includeSystemMessages: false })) || [];
      return { messages: condense(raw), context: contextOf(raw) };
    },

    /** Model aliases the Claude Agent SDK accepts; an empty ID is the person's default. */
    models: async () => [
      { id: '', name: '默认' },
      { id: 'haiku', name: 'Haiku' },
      { id: 'sonnet', name: 'Sonnet' },
      { id: 'opus', name: 'Opus' },
    ],

    /** One answer to the compression request, in a session that is not kept. */
    async summarize({ text, model }) {
      const api = await sdk();
      let result = null;
      for await (const message of api.query({
        prompt: COMPRESS + text,
        options: {
          ...(model ? { model } : {}),
          env: childEnvironment(),
          settingSources: [],
          tools: [],
          maxTurns: 1,
          persistSession: false,
        },
      }))
        if (message.type === 'result') result = message;
      if (!result || result.is_error || !result.result?.trim())
        throw failure(`Claude 没有给出压缩结果：${result?.result || '没有返回'}`);
      return result.result.trim();
    },
  };
}

/**
 * A session's context size in tokens: what its last answer read and wrote, as
 * the API reported it on that message.
 */
function contextOf(raw) {
  const usage = raw.findLast(item => item.type === 'assistant' && item.message?.usage)?.message
    ?.usage;
  if (!usage) return null;
  return (
    (usage.input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.output_tokens || 0)
  );
}
