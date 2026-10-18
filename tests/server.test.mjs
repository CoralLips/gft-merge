import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createService, startServer } from '../server.mjs';

/** A tool backed by in-memory sessions; what it is sent is recorded. */
function fakeTool(id) {
  const sessions = new Map();
  const sent = [];
  return {
    id,
    name: id,
    sessions,
    sent,
    listSessions: async () => [...sessions.values()].map(item => item.session),
    readMessages: async session => sessions.get(session.id)?.messages ?? [],
    create: async ({ cwd, title, text }) => {
      const session = { tool: id, id: 'created', title, cwd };
      sent.push({ id: 'created', cwd, text });
      return { session };
    },
    add(sessionId, ...texts) {
      const entry = sessions.get(sessionId) || {
        session: { tool: id, id: sessionId, title: `${id}-${sessionId}`, cwd: 'D:/work/app' },
        messages: [],
      };
      for (const text of texts)
        entry.messages.push({
          id: `${sessionId}-${entry.messages.length}`,
          role: 'user',
          text,
          at: new Date(Date.now() + entry.messages.length).toISOString(),
        });
      sessions.set(sessionId, entry);
      return entry.session;
    },
  };
}

async function withServer(run) {
  const home = await mkdtemp(path.join(tmpdir(), 'gft-merge-server-'));
  const claude = fakeTool('claude');
  const codex = fakeTool('codex');
  const server = await startServer({
    port: 0,
    service: createService({ home, tools: [claude, codex] }),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const write = method !== 'GET';
    const response = await fetch(base + url, {
      method,
      headers: write ? { 'Content-Type': 'application/json' } : {},
      body: write ? JSON.stringify(body ?? {}) : undefined,
    });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status });
    return value;
  };
  try {
    await run({ call, claude, codex, base });
  } finally {
    server.close();
    await rm(home, { recursive: true, force: true });
  }
}

test('拖进池子、融合，拖到工具区：新建会话，第一条是融合的内容，项目取来源会话所在目录', () =>
  withServer(async ({ call, claude, codex }) => {
    const discussion = claude.add('c1', '方案定 A');
    const work = codex.add('x1', '已写完第一步');
    const pool = await call('POST', '/api/pools', { name: '交接' });
    await call('POST', `/api/pools/${pool.id}/sessions`, { ...discussion, cell: 0 });
    await call('POST', `/api/pools/${pool.id}/sessions`, { ...work, fused: true });
    const created = await call('POST', `/api/pools/${pool.id}/inject`, { tool: 'claude' });
    assert.equal(created.status, 'sent');
    assert.equal(created.session.title, 'merge · 交接');
    assert.equal(claude.sent.at(-1).cwd, 'D:/work/app');
    assert.match(claude.sent.at(-1).text, /已写完第一步/);
    assert.doesNotMatch(claude.sent.at(-1).text, /方案定 A/, '等着的会话不随融合内容送出');
    assert.deepEqual(
      created.pool.deliveries.map(d => [d.tool, d.id]),
      [['claude', 'created']],
    );
  }));

test('单个待融合会话可以单独新建；没有融合内容时拖融合球会被拒绝', () =>
  withServer(async ({ call, claude, codex }) => {
    const waiting = claude.add('c1', '只送这一段');
    const pool = await call('POST', '/api/pools', { name: '迁移' });
    await call('POST', `/api/pools/${pool.id}/sessions`, waiting);
    await assert.rejects(
      call('POST', `/api/pools/${pool.id}/inject`, { tool: 'codex' }),
      /还没有融合/,
    );
    const single = await call('POST', `/api/pools/${pool.id}/inject`, {
      tool: 'codex',
      source: 'claude:c1',
    });
    assert.equal(single.status, 'sent');
    assert.match(codex.sent.at(-1).text, /只送这一段/);
  }));

test('会话可以移到另一个池子', () =>
  withServer(async ({ call, claude }) => {
    const session = claude.add('c1', '搬家');
    const from = await call('POST', '/api/pools', { name: '甲' });
    const to = await call('POST', '/api/pools', { name: '乙' });
    await call('POST', `/api/pools/${from.id}/sessions`, session);
    const moved = await call('POST', `/api/pools/${from.id}/move`, { key: 'claude:c1', to: to.id });
    assert.equal(moved.id, to.id);
    assert.equal(moved.sessions[0].messages, 1);
    const pools = await call('GET', '/api/pools');
    assert.equal(pools.find(p => p.id === from.id).sessions.length, 0);
  }));

test('只接受本机同源的 JSON 写请求', () =>
  withServer(async ({ base }) => {
    const port = new URL(base).port;
    const form = await fetch(`${base}/api/pools`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(form.status, 403);
    const foreign = await fetch(`${base}/api/pools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://example.com' },
      body: '{}',
    });
    assert.equal(foreign.status, 403);
    const local = await fetch(`${base}/api/pools`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` },
      body: '{}',
    });
    assert.equal(local.status, 200);
  }));
