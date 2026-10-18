import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPools, injectionText } from '../pools.mjs';
import { MARKER, writeJson } from '../home.mjs';

const claude = { tool: 'claude', id: 'c1', title: '讨论方案', cwd: 'D:/work/app' };
const codex = { tool: 'codex', id: 'x1', title: '实现功能', cwd: 'D:/work/app' };
const message = (id, role, text, at) => ({ id, role, text, at });
const fused = { fused: true };
/** A send that reached its target. */
const delivered = (pools, id, target, upto) => pools.recordDelivery(id, target, upto);

async function withPools(run) {
  const home = await mkdtemp(path.join(tmpdir(), 'gft-merge-pools-'));
  try {
    await run(createPools({ home }), home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('合并只追加新消息，跳过已收过的与注入标记；新会话默认待融合', () =>
  withPools(async pools => {
    const pool = await pools.create('交接');
    const first = await pools.merge(pool.id, claude, [
      message('a', 'user', '先定方案', '2026-10-16T10:00:00Z'),
      message('b', 'assistant', '方案是 A', '2026-10-16T10:01:00Z'),
    ]);
    assert.equal(first.added, 2);
    assert.equal(first.pool.sessions[0].fused, false);
    const again = await pools.merge(pool.id, claude, [
      message('a', 'user', '先定方案', '2026-10-16T10:00:00Z'),
      message('b', 'assistant', '方案是 A', '2026-10-16T10:01:00Z'),
      message('c', 'user', `${MARKER}别处注入来的`, '2026-10-16T10:02:00Z'),
      message('e', 'user', '〔GFT-merge〕改名前注入来的', '2026-10-16T10:02:30Z'),
      message('d', 'user', '继续', '2026-10-16T10:03:00Z'),
    ]);
    assert.equal(again.added, 1);
    assert.deepEqual(
      (await pools.messages(pool.id)).map(item => item.id),
      ['a', 'b', 'd'],
    );
  }));

test('只送已融合的会话；对方收过的不再送，也不把它自己的话送回去', () =>
  withPools(async pools => {
    const pool = await pools.create('交接');
    await pools.merge(
      pool.id,
      claude,
      [message('a', 'user', 'Claude 里定的', '2026-10-16T10:00:00Z')],
      fused,
    );
    await pools.merge(
      pool.id,
      codex,
      [message('x', 'assistant', 'Codex 写完了', '2026-10-16T10:05:00Z')],
      fused,
    );
    const toCodex = await pools.pending(pool.id, codex);
    assert.equal(toCodex.count, 1);
    assert.match(toCodex.text, /Claude 里定的/);
    assert.doesNotMatch(toCodex.text, /Codex 写完了/);
    assert.ok(toCodex.text.startsWith(MARKER));
    await delivered(pools, pool.id, codex, toCodex.upto);
    assert.equal((await pools.pending(pool.id, codex)).count, 0);
    await pools.merge(pool.id, claude, [message('b', 'user', '又补一句', '2026-10-16T10:10:00Z')]);
    const next = await pools.pending(pool.id, codex);
    assert.equal(next.count, 1);
    assert.match(next.text, /又补一句/);
  }));

test('待融合的会话不随融合内容送出；之后再融合，它的旧内容照样补送', () =>
  withPools(async pools => {
    const pool = await pools.create('交接');
    const target = { tool: 'codex', id: 'x9', title: '目标' };
    await pools.merge(pool.id, codex, [message('w', 'user', '还在等', '2026-10-16T09:00:00Z')]);
    await pools.merge(
      pool.id,
      claude,
      [message('a', 'user', '已融合', '2026-10-16T10:00:00Z')],
      fused,
    );
    const first = await pools.pending(pool.id, target);
    assert.equal(first.count, 1);
    assert.doesNotMatch(first.text, /还在等/);
    await delivered(pools, pool.id, target, first.upto);
    await pools.place(pool.id, 'codex:x1', { fused: true });
    const later = await pools.pending(pool.id, target);
    assert.equal(later.count, 1, '更早到达但刚融合的内容不能被跳过');
    assert.match(later.text, /还在等/);
  }));

test('单独送一个待融合的会话，只送它自己', () =>
  withPools(async pools => {
    const pool = await pools.create('交接');
    await pools.merge(
      pool.id,
      claude,
      [message('a', 'user', '融合的', '2026-10-16T10:00:00Z')],
      fused,
    );
    await pools.merge(pool.id, codex, [message('x', 'user', '单独的', '2026-10-16T10:01:00Z')]);
    const one = await pools.pending(
      pool.id,
      { tool: 'claude', id: 'c9' },
      { sources: ['codex:x1'] },
    );
    assert.equal(one.count, 1);
    assert.match(one.text, /单独的/);
    assert.doesNotMatch(one.text, /融合的/);
  }));

test('会话可以带着内容移到另一个池子，在那里待融合', () =>
  withPools(async pools => {
    const from = await pools.create('甲');
    const to = await pools.create('乙');
    await pools.merge(
      from.id,
      claude,
      [message('a', 'user', '要搬走的', '2026-10-16T10:00:00Z')],
      fused,
    );
    await pools.merge(from.id, codex, [message('x', 'user', '留下的', '2026-10-16T10:01:00Z')]);
    const moved = await pools.moveSession(from.id, 'claude:c1', to.id);
    assert.deepEqual(
      moved.sessions.map(item => [item.id, item.fused]),
      [['c1', false]],
    );
    assert.deepEqual(
      (await pools.messages(to.id)).map(item => item.text),
      ['要搬走的'],
    );
    assert.deepEqual(
      (await pools.messages(from.id)).map(item => item.text),
      ['留下的'],
    );
  }));

test('移出会话会带走它的内容，已送出的记录保留', () =>
  withPools(async pools => {
    const pool = await pools.create('交接');
    await pools.merge(pool.id, claude, [message('a', 'user', '甲', '2026-10-16T10:00:00Z')]);
    await pools.merge(pool.id, codex, [message('x', 'user', '乙', '2026-10-16T10:01:00Z')]);
    await delivered(pools, pool.id, { tool: 'codex', id: 'x9', title: '别处' }, { 'codex:x1': 2 });
    const after = await pools.removeSession(pool.id, 'claude:c1');
    assert.deepEqual(
      after.sessions.map(item => item.id),
      ['x1'],
    );
    assert.deepEqual(
      (await pools.messages(pool.id)).map(item => item.text),
      ['乙'],
    );
    assert.ok(after.deliveries['codex:x9']);
  }));

test('旧格式的池子按“全部已融合、每段会话同一送达位置”读取', () =>
  withPools(async (pools, home) => {
    const pool = await pools.create('旧');
    await pools.merge(pool.id, claude, [message('a', 'user', '旧内容', '2026-10-16T10:00:00Z')]);
    const raw = await pools.load(pool.id);
    for (const session of raw.sessions) delete session.fused;
    raw.deliveries['codex:x9'] = {
      tool: 'codex',
      id: 'x9',
      title: '旧目标',
      sentSeq: 1,
      deliveredSeq: 1,
      status: 'delivered',
    };
    await writeJson(path.join(home, 'pools', `${pool.id}.json`), raw);
    const upgraded = await pools.load(pool.id);
    assert.equal(upgraded.sessions[0].fused, true);
    assert.deepEqual(upgraded.deliveries['codex:x9'].sent, { 'claude:c1': 1 });
    assert.equal((await pools.pending(pool.id, { tool: 'codex', id: 'x9' })).count, 0);
  }));

test('超长时保留最新的内容，并写明省略了多少', () => {
  const pool = { name: '长', sessions: [claude] };
  const messages = Array.from({ length: 10 }, (_, i) => ({
    seq: i + 1,
    tool: 'claude',
    sessionId: 'c1',
    role: 'user',
    text: `第${i}段`.padEnd(100, '。'),
    at: `2026-10-16T10:0${i}:00Z`,
  }));
  const { text, omitted } = injectionText(pool, messages, 500);
  assert.ok(omitted > 0);
  assert.match(text, new RegExp(`更早的 ${omitted} 段因长度已省略`));
  assert.match(text, /第9段/);
  assert.doesNotMatch(text, /第0段/);
});
