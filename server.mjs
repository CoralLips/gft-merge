// Local HTTP service for the GFT-Merge page.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    ...(await readJson(settingsFile, {})),
  });
  const targetOf = body => ({
    tool: body?.tool,
    id: body?.id,
    title: body?.title,
    cwd: body?.cwd ?? null,
  });

  async function summary(pool) {
    const messages = await pools.messages(pool.id);
    return {
      ...pool,
      sessions: pool.sessions.map(session => {
        const own = messages.filter(
          m => sessionKey({ tool: m.tool, id: m.sessionId }) === sessionKey(session),
        );
        return {
          ...session,
          messages: own.length,
          chars: own.reduce((n, m) => n + m.text.length, 0),
        };
      }),
      deliveries: Object.values(pool.deliveries),
    };
  }

  /** Reads new messages of the given sessions (all of the pool's when omitted). */
  async function pull(id, keys) {
    let added = 0;
    for (const session of (await pools.load(id)).sessions) {
      if (keys && !keys.includes(sessionKey(session))) continue;
      const known = await pools.knownIds(id, session);
      const messages = await toolOf(session.tool).readMessages(session, { known });
      added += (await pools.merge(id, session, messages)).added;
    }
    return added;
  }

  /** The fused sessions, or the one session named by `source`. */
  async function sourcesOf(id, source) {
    const pool = await pools.load(id);
    const keys = source ? [source] : pool.sessions.filter(session => session.fused).map(sessionKey);
    if (!keys.length) throw failure('池子里还没有融合的内容');
    if (source && !pool.sessions.some(session => sessionKey(session) === source))
      throw failure('这段会话不在池子里', 404);
    return { pool, keys };
  }

  /**
   * Starts a session in `toolId` whose first message is what `keys` hold. Only
   * new sessions: Codex refuses a session open in its app, and the Claude app
   * does not show what another program writes into one of its sessions.
   */
  async function inject(id, toolId, keys) {
    const tool = toolOf(toolId);
    const { text, upto, count, chars } = await pools.pending(
      id,
      { tool: tool.id, id: '-' },
      { sources: keys },
    );
    if (!count) return { status: 'nothing-new' };
    const { session } = await tool.create({
      cwd: await projectOf(id, keys),
      title: `merge · ${(await pools.load(id)).name}`,
      text,
    });
    await pools.recordDelivery(id, session, upto);
    return { status: 'sent', session, count, chars };
  }

  /** The project most of the sent sessions came from, for a new session. */
  async function projectOf(id, keys) {
    const projects = (await pools.load(id)).sessions
      .filter(session => keys.includes(sessionKey(session)) && session.cwd)
      .map(session => session.cwd);
    const count = cwd => projects.filter(p => p === cwd).length;
    const project = projects.sort((a, b) => count(b) - count(a))[0];
    if (!project) throw failure('不知道新会话该在哪个项目里');
    return project;
  }

  const routes = {
    'GET /api/state': async () => ({
      // Lets `open` tell this service from another program holding the port.
      product: 'gft-merge',
      tools: tools.map(({ id, name }) => ({ id, name })),
      settings: await settings(),
    }),
    'PUT /api/settings': async body => {
      const enabled = Object.fromEntries(
        tools.map(tool => [tool.id, body?.tools?.[tool.id] !== false]),
      );
      await writeJson(settingsFile, { tools: enabled });
      return { tools: enabled };
    },
    'GET /api/sessions': async (_, query) => {
      const since = new Date(Date.now() - LISTED_DAYS * DAY).toISOString();
      return toolOf(query.get('tool')).listSessions({ since });
    },
    'GET /api/pools': async () => {
      return Promise.all((await pools.list()).map(summary));
    },
    'POST /api/pools': async body => summary(await pools.create(body?.name)),
  };

  async function poolRoute(method, [id, action, key], body) {
    if (!action && method === 'PATCH') return summary(await pools.rename(id, body?.name));
    if (!action && method === 'DELETE') return pools.remove(id).then(() => ({ removed: id }));
    if (action === 'content' && method === 'GET') {
      const pool = await pools.load(id);
      const { text } = await pools.pending(
        id,
        { tool: '-', id: '-' },
        { sources: pool.sessions.map(sessionKey) },
      );
      return { name: pool.name, text };
    }
    if (action === 'sessions' && method === 'POST') {
      const session = targetOf(body);
      if (!session.id) throw failure('缺少会话');
      await toolOf(session.tool);
      const known = await pools.knownIds(id, session);
      const messages = await toolOf(session.tool).readMessages(session, { known });
      const { added } = await pools.merge(id, session, messages, {
        fused: !!body?.fused,
        cell: body?.cell,
      });
      return { added, pool: await summary(await pools.load(id)) };
    }
    if (action === 'sessions' && method === 'PATCH' && key)
      return summary(await pools.place(id, decodeURIComponent(key), body || {}));
    if (action === 'sessions' && method === 'DELETE' && key)
      return summary(await pools.removeSession(id, decodeURIComponent(key)));
    if (action === 'move' && method === 'POST')
      return summary(await pools.moveSession(id, body?.key, body?.to));
    if (action === 'inject' && method === 'POST') {
      // `source` names one waiting session; without it the fused sessions are sent.
      const { keys } = await sourcesOf(id, body?.source);
      await pull(id, keys);
      const result = await inject(id, body?.tool, keys);
      return { ...result, pool: await summary(await pools.load(id)) };
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
