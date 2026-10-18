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
    readMessages: async session => ({
      messages: sessions.get(session.id)?.messages ?? [],
      context: 5000,
    }),
    models: async () => [{ id: '', name: '默认' }],
    summarize: async ({ text, model }) => {
      sent.push({ id: 'summary', text, model });
      return `摘要（${model || '默认'}）`;
    },
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

test('会话拖进来各自成球；一个球拖到另一个上融合；拖到工具区用这个球新建会话，项目取来源目录', () =>
  withServer(async ({ call, claude, codex }) => {
    const discussion = claude.add('c1', '方案定 A');
    const work = codex.add('x1', '已写完第一步');
    const extra = codex.add('x2', '不相干');
    const pool = await call('POST', '/api/pools', { name: '交接' });
    const first = await call('POST', `/api/pools/${pool.id}/sessions`, { ...discussion, cell: 0 });
    const ballA = first.pool.balls[0].id;
    assert.equal(first.pool.balls[0].sessions[0].context, 5000, '会话本身的上下文大小');
    const second = await call('POST', `/api/pools/${pool.id}/sessions`, { ...work, ball: ballA });
    assert.equal(second.pool.balls.length, 1, '拖到球上就并进去');
    await call('POST', `/api/pools/${pool.id}/sessions`, { ...extra, cell: 5 });
    const pools = await call('GET', '/api/pools');
    const ball = pools[0].balls.find(b => b.id === ballA);
    assert.ok(ball.tokens > 0, '融合球带着本地数出来的 token 数');
    const created = await call('POST', `/api/pools/${pool.id}/inject`, {
      tool: 'claude',
      ball: ballA,
    });
    assert.equal(created.status, 'sent');
    assert.equal(created.session.title, 'merge · 交接');
    assert.equal(claude.sent.at(-1).cwd, 'D:/work/app');
    assert.match(claude.sent.at(-1).text, /方案定 A[\s\S]*已写完第一步/);
    assert.doesNotMatch(claude.sent.at(-1).text, /不相干/, '别的球不跟着送');
    const single = await call('POST', `/api/pools/${pool.id}/inject`, {
      tool: 'codex',
      ball: ballA,
      source: 'codex:x1',
    });
    assert.equal(single.status, 'sent');
    assert.doesNotMatch(codex.sent.at(-1).text, /方案定 A/, '只送拖出来的那一段');
  }));

test('点球压缩：用设置里的处理工具和模型调一次，球变成压缩块，原会话离开池子', () =>
  withServer(async ({ call, claude, codex }) => {
    const discussion = claude.add('c1', '很长的讨论');
    const pool = await call('POST', '/api/pools', { name: '交接' });
    const added = await call('POST', `/api/pools/${pool.id}/sessions`, discussion);
    const ballId = added.pool.balls[0].id;
    await call('PUT', '/api/settings', { processor: { tool: 'codex', model: 'm1' } });
    const processors = await call('GET', '/api/processors');
    assert.deepEqual(
      processors.map(p => p.tool),
      ['claude', 'codex'],
    );
    const compressed = await call('POST', `/api/pools/${pool.id}/compress`, { ball: ballId });
    const ball = compressed.balls[0];
    assert.equal(codex.sent.at(-1).model, 'm1');
    assert.match(codex.sent.at(-1).text, /很长的讨论/);
    assert.equal(ball.sessions.length, 0);
    assert.equal(ball.compacts.length, 1);
    assert.equal(ball.compacts[0].text, undefined, '列表里不带压缩全文');
    await call('POST', `/api/pools/${pool.id}/inject`, { tool: 'claude', ball: ballId });
    assert.match(claude.sent.at(-1).text, /已压缩[\s\S]*摘要（m1）/);
  }));

test('整个球可以搬到另一个池子，也可以整个移出', () =>
  withServer(async ({ call, claude, codex }) => {
    const session = claude.add('c1', '搬家');
    const from = await call('POST', '/api/pools', { name: '甲' });
    const to = await call('POST', '/api/pools', { name: '乙' });
    const added = await call('POST', `/api/pools/${from.id}/sessions`, session);
    const moved = await call('POST', `/api/pools/${from.id}/move`, {
      ball: added.pool.balls[0].id,
      to: to.id,
    });
    assert.equal(moved.id, to.id);
    assert.equal(moved.balls[0].sessions[0].id, 'c1');
    const again = await call('POST', `/api/pools/${to.id}/sessions`, codex.add('x1', '另一个'));
    const removed = await call(
      'DELETE',
      `/api/pools/${to.id}/balls/${again.pool.balls.find(b => b.sessions[0].id === 'x1').id}`,
    );
    assert.equal(removed.balls.length, 1);
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
