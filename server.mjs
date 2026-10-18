// Local HTTP service for the GFT-Merge page.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countTokens } from 'gpt-tokenizer';
import { homeDir, readJson, writeJson } from './home.mjs';
import { createPools, sessionKey } from './pools.mjs';
import { createCodexTool } from './tools/codex.mjs';
import { createClaudeTool } from './tools/claude.mjs';

export const DEFAULT_PORT = 4319;
const web = fileURLToPath(new URL('./web/', import.meta.url));
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const DAY = 24 * 60 * 60 * 1000;
/** Sessions older than this are not listed; the page has no time filter. */
const LISTED_DAYS = 30;

export function createService({
  home = homeDir(),
  tools = [createClaudeTool(), createCodexTool()],
} = {}) {
  const pools = createPools({ home });
  const toolOf = id => {
    const tool = tools.find(item => item.id === id);
    if (!tool) throw failure('未知工具');
    return tool;
  };
  const settingsFile = path.join(home, 'settings.json');
  const settings = async () => ({
    tools: Object.fromEntries(tools.map(tool => [tool.id, true])),
    // The tool and model that compress a ball: the first tool and its default model unless set.
    processor: { tool: tools[0]?.id, model: '' },
    ...(await readJson(settingsFile, {})),
  });
  const sessionOf = body => ({
    tool: body?.tool,
    id: body?.id,
    title: body?.title,
    cwd: body?.cwd ?? null,
  });

  // A ball's token count is counted locally from its text, and kept until the text changes.
  const counted = new Map();
  const tokensOf = text => {
    if (!counted.has(text)) {
      if (counted.size > 200) counted.clear();
      counted.set(text, countTokens(text));
    }
    return counted.get(text);
  };
  /** Balls being compressed now, as `poolId:ballId`. */
  const compressing = new Set();

  // Sessions added before context sizes were read get theirs once, in the background.
  const backfilled = new Set();
  const backfill = pool => {
    for (const session of pool.sessions) {
      const mark = `${pool.id}:${sessionKey(session)}`;
      if (session.context !== undefined || backfilled.has(mark)) continue;
      backfilled.add(mark);
      read(pool.id, session).catch(() => {});
    }
  };

  async function summary(pool) {
    backfill(pool);
    const balls = await Promise.all(
      pool.balls.map(async ball => {
        const { text } = await pools.ballContent(pool.id, ball.id);
        return {
          id: ball.id,
          cell: ball.cell,
          compacts: ball.compacts.map(({ text: _text, ...compact }) => compact),
          sessions: pool.sessions.filter(session => session.ball === ball.id),
          tokens: text ? tokensOf(text) : 0,
          compressing: compressing.has(`${pool.id}:${ball.id}`),
        };
      }),
    );
    return { id: pool.id, name: pool.name, createdAt: pool.createdAt, balls };
  }

  /** Reads one session's new messages and its own context size into the pool. */
  async function read(id, session, place) {
    const known = await pools.knownIds(id, session);
    const { messages, context } = await toolOf(session.tool).readMessages(session, { known });
    return pools.merge(id, session, messages, place, context);
  }

  /** Reads new messages of a ball's sessions (just `only` when given). */
  async function pull(id, ballId, only) {
    for (const session of (await pools.load(id)).sessions)
      if (session.ball === ballId && (!only || sessionKey(session) === only))
        await read(id, session);
  }

  /**
   * Starts a session in `toolId` whose first message is the ball's content (or
   * one session of it). Only new sessions: Codex refuses a session open in its
   * app, and the Claude app does not show what another program writes into one
   * of its sessions.
   */
  async function inject(id, toolId, ballId, only) {
    const tool = toolOf(toolId);
    const started = Date.now();
    await pull(id, ballId, only);
    const pulled = Date.now();
    const content = await pools.ballContent(id, ballId, { only });
    if (!content.count) return { status: 'nothing-new' };
    const { session } = await tool.create({
      cwd: await projectOf(id, ballId, only),
      title: `merge · ${(await pools.load(id)).name}`,
      text: content.text,
    });
    const tokens = tokensOf(content.text);
    console.log(
      `新建 ${tool.id}：${tokens} tokens，读取 ${pulled - started} ms，新建 ${Date.now() - pulled} ms`,
    );
    return { status: 'sent', session, tokens };
  }

  /** The project most of the ball's sessions came from, for a new session. */
  async function projectOf(id, ballId, only) {
    const pool = await pools.load(id);
    const ball = pool.balls.find(item => item.id === ballId);
    const projects = [
      ...pool.sessions
        .filter(session => session.ball === ballId && (!only || sessionKey(session) === only))
        .map(session => session.cwd),
      ...(only ? [] : (ball?.compacts || []).flatMap(compact => compact.from.map(f => f.cwd))),
    ].filter(Boolean);
    const count = cwd => projects.filter(p => p === cwd).length;
    const project = projects.sort((a, b) => count(b) - count(a))[0];
    if (!project) throw failure('不知道新会话该在哪个项目里');
    return project;
  }

  /**
   * Compresses a ball with the chosen processing tool: one model call over the
   * ball's content. Sessions fused in meanwhile stay outside the compact.
   */
  async function compress(id, ballId) {
    const mark = `${id}:${ballId}`;
    if (compressing.has(mark)) throw failure('这个球正在压缩');
    compressing.add(mark);
    try {
      await pull(id, ballId);
      const snapshot = await pools.ballContent(id, ballId);
      if (!snapshot.count) throw failure('这个球里没有内容');
      const { processor } = await settings();
      const started = Date.now();
      const text = await toolOf(processor.tool).summarize({
        text: snapshot.text,
        model: processor.model,
      });
      console.log(
        `压缩：${tokensOf(snapshot.text)} → ${tokensOf(text)} tokens，用 ${processor.tool} ${processor.model || '默认模型'}，${Date.now() - started} ms`,
      );
      await pools.seal(id, ballId, snapshot, {
        text,
        tokens: tokensOf(text),
        sourceTokens: tokensOf(snapshot.text),
        by: processor,
      });
    } finally {
      compressing.delete(mark);
    }
  }

  const routes = {
    'GET /api/state': async () => ({
      // Lets `open` tell this service from another program holding the port.
      product: 'gft-merge',
      tools: tools.map(({ id, name }) => ({ id, name })),
      settings: await settings(),
    }),
    'PUT /api/settings': async body => {
      const current = await settings();
      const next = {
        tools: Object.fromEntries(
          tools.map(tool => [tool.id, (body?.tools ?? current.tools)[tool.id] !== false]),
        ),
        processor: body?.processor
          ? { tool: toolOf(body.processor.tool).id, model: String(body.processor.model || '') }
          : current.processor,
      };
      await writeJson(settingsFile, next);
      return next;
    },
    /** Each tool that can compress, with the models it offers. */
    'GET /api/processors': async () =>
      (
        await Promise.all(
          tools.map(async tool => ({
            tool: tool.id,
            name: tool.name,
            models: tool.models ? await tool.models().catch(() => null) : null,
          })),
        )
      ).filter(item => item.models?.length),
    'GET /api/sessions': async (_, query) => {
      const since = new Date(Date.now() - LISTED_DAYS * DAY).toISOString();
      return toolOf(query.get('tool')).listSessions({ since });
    },
    'GET /api/pools': async () => Promise.all((await pools.list()).map(summary)),
    'POST /api/pools': async body => summary(await pools.create(body?.name)),
  };

  async function poolRoute(method, [id, action, rawKey], body) {
    const after = async () => summary(await pools.load(id));
    const key = rawKey && decodeURIComponent(rawKey);
    if (!action && method === 'PATCH') return summary(await pools.rename(id, body?.name));
    if (!action && method === 'DELETE') return pools.remove(id).then(() => ({ removed: id }));
    if (action === 'sessions' && method === 'POST') {
      // A session from a tool: into ball `ball`, or a new ball at `cell`.
      const session = sessionOf(body);
      if (!session.id) throw failure('缺少会话');
      toolOf(session.tool);
      const { added } = await read(id, session, { ball: body?.ball, cell: body?.cell });
      return { added, pool: await after() };
    }
    if (action === 'sessions' && method === 'DELETE' && key) {
      await pools.removeSession(id, key);
      return after();
    }
    if (action === 'split' && method === 'POST') {
      await pools.splitSession(id, body?.key, { ball: body?.ball, cell: body?.cell });
      return after();
    }
    if (action === 'balls' && method === 'PATCH' && key) {
      await pools.placeBall(id, key, body?.cell);
      return after();
    }
    if (action === 'balls' && method === 'DELETE' && key) {
      await pools.removeBall(id, key);
      return after();
    }
    if (action === 'fuse' && method === 'POST') {
      await pools.fuseBalls(id, body?.from, body?.into);
      return after();
    }
    if (action === 'move' && method === 'POST')
      return summary(await pools.moveBall(id, body?.ball, body?.to));
    if (action === 'inject' && method === 'POST') {
      // `source` names one session of the ball; without it the whole ball is sent.
      const result = await inject(id, body?.tool, body?.ball, body?.source);
      return { ...result, pool: await after() };
    }
    if (action === 'compress' && method === 'POST') {
      await compress(id, body?.ball);
      return after();
    }
    throw failure('不支持的操作', 404);
  }

  return async function handle(method, pathname, query, body) {
    const route = routes[`${method} ${pathname}`];
    if (route) return route(body, query);
    const match = pathname.match(/^\/api\/pools\/([\w-]+)(?:\/(\w+))?(?:\/(.+))?$/);
    if (match) return poolRoute(method, match.slice(1), body);
    throw failure('不存在', 404);
  };
}

/** Only this machine's page may call the API; writes must be same-origin JSON. */
function allowed(req, port) {
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host)) return false;
  if (req.method === 'GET') return true;
  const origin = req.headers.origin;
  return (
    (!origin || hosts.some(host => origin === `http://${host}`)) &&
    (req.headers['content-type'] || '').startsWith('application/json')
  );
}

async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1e6) throw failure('请求过大', 413);
  }
  return text ? JSON.parse(text) : {};
}

export function startServer({ port = DEFAULT_PORT, service = createService() } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    const send = (status, value, type = 'application/json') => {
      res.writeHead(status, {
        'Content-Type': `${type}; charset=utf-8`,
        'Cache-Control': 'no-store',
      });
      res.end(type === 'application/json' ? JSON.stringify(value) : value);
    };
    if (!allowed(req, server.address().port)) return send(403, { error: '只接受本机页面的请求' });
    try {
      if (url.pathname.startsWith('/api/'))
        return send(
          200,
          (await service(req.method, url.pathname, url.searchParams, await body(req))) ?? {},
        );
      const file = path.join(
        web,
        url.pathname === '/' ? 'index.html' : path.normalize(url.pathname),
      );
      if (!file.startsWith(web)) return send(404, { error: '不存在' });
      return send(
        200,
        await readFile(file),
        TYPES[path.extname(file)] || 'application/octet-stream',
      );
    } catch (error) {
      if (error.code === 'ENOENT') return send(404, { error: '不存在' });
      if (error.codexMessage) console.error(`${req.method} ${url.pathname}: ${error.codexMessage}`);
      return send(error.status || 500, { error: error.message || '出错了' });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
