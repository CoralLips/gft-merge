import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPools } from '../pools.mjs';
import { MARKER, writeJson } from '../home.mjs';

const claude = { tool: 'claude', id: 'c1', title: '讨论方案', cwd: 'D:/work/app' };
const codex = { tool: 'codex', id: 'x1', title: '实现功能', cwd: 'D:/work/app' };
const message = (id, role, text, at) => ({ id, role, text, at });

async function withPools(run) {
  const home = await mkdtemp(path.join(tmpdir(), 'gft-merge-pools-'));
  try {
    await run(createPools({ home }), home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test('合并只追加新消息，跳过已收过的与注入标记（含改名前的旧标记）；新会话自成一个球', () =>
  withPools(async pools => {
    const pool = await pools.create('交接');
    const first = await pools.merge(
      pool.id,
      claude,
      [
        message('a', 'user', '先定方案', '2026-10-16T10:00:00Z'),
        message('b', 'assistant', '方案是 A', '2026-10-16T10:01:00Z'),
      ],
      { cell: 3 },
      1200,
    );
    assert.equal(first.added, 2);
    assert.equal(first.pool.balls.length, 1);
    assert.equal(first.pool.balls[0].cell, 3);
    assert.equal(first.pool.sessions[0].context, 1200);
    const again = await pools.merge(pool.id, claude, [
      message('a', 'user', '先定方案', '2026-10-16T10:00:00Z'),
      message('c', 'user', `${MARKER}别处注入来的`, '2026-10-16T10:02:00Z'),
      message('e', 'user', '〔GFT-merge〕改名前注入来的', '2026-10-16T10:02:30Z'),
      message('d', 'user', '继续', '2026-10-16T10:03:00Z'),
    ]);
    assert.equal(again.added, 1);
    assert.equal(again.pool.balls.length, 1, '已在池子里的会话不另起一个球');
  }));

test('一个球拖到另一个球上就融合；球的内容按时间排列，只含这个球里的会话', () =>
  withPools(async pools => {
    const pool = await pools.create('交接');
    const a = await pools.merge(pool.id, claude, [
      message('a', 'user', 'Claude 里定的', '2026-10-16T10:00:00Z'),
    ]);
    const b = await pools.merge(pool.id, codex, [
      message('x', 'assistant', 'Codex 写完了', '2026-10-16T10:05:00Z'),
    ]);
    const other = await pools.merge(pool.id, { ...codex, id: 'x2', title: '别的' }, [
      message('y', 'user', '不相干', '2026-10-16T10:06:00Z'),
    ]);
    const fused = await pools.fuseBalls(pool.id, a.ball, b.ball);
    assert.equal(fused.balls.length, 2);
    const content = await pools.ballContent(pool.id, b.ball);
    assert.equal(content.count, 2);
    assert.ok(content.text.startsWith(MARKER));
    assert.ok(content.text.indexOf('Claude 里定的') < content.text.indexOf('Codex 写完了'));
    assert.doesNotMatch(content.text, /不相干/);
    const single = await pools.ballContent(pool.id, b.ball, { only: 'claude:c1' });
    assert.equal(single.count, 1);
    assert.doesNotMatch(single.text, /Codex 写完了/);
    assert.ok(other.ball);
  }));

test('从球里拆出一个会话：放到空格子自成一球，放到别的球上就并进去；空球自动消失', () =>
  withPools(async pools => {
    const pool = await pools.create('交接');
    const a = await pools.merge(pool.id, claude, []);
    const b = await pools.merge(pool.id, codex, []);
    await pools.fuseBalls(pool.id, a.ball, b.ball);
    let saved = await pools.splitSession(pool.id, 'claude:c1', { cell: 7 });
    assert.equal(saved.balls.length, 2);
    assert.equal(saved.balls.find(x => x.id !== b.ball).cell, 7);
    saved = await pools.splitSession(pool.id, 'claude:c1', { ball: b.ball });
    assert.equal(saved.balls.length, 1, '拆走后空了的球不留');
  }));

test('压缩把快照里的会话封成一个压缩块，期间新融合的留在外面；送出时压缩块在前', () =>
  withPools(async pools => {
    const pool = await pools.create('交接');
    const a = await pools.merge(pool.id, claude, [
      message('a', 'user', '很长的讨论', '2026-10-16T10:00:00Z'),
    ]);
    const snapshot = await pools.ballContent(pool.id, a.ball);
    const late = await pools.merge(pool.id, codex, [
      message('x', 'user', '压缩期间新来的', '2026-10-16T10:05:00Z'),
    ]);
    await pools.fuseBalls(pool.id, late.ball, a.ball);
    const sealed = await pools.seal(pool.id, a.ball, snapshot, { text: '摘要：定了 A', tokens: 5 });
    assert.deepEqual(
      sealed.sessions.map(s => s.id),
      ['x1'],
      '被压缩的会话离开池子，新来的还在',
    );
    assert.deepEqual(
      sealed.balls[0].compacts.map(c => [c.text, c.from.map(f => f.id)]),
      [['摘要：定了 A', ['c1']]],
    );
    const content = await pools.ballContent(pool.id, a.ball);
    assert.match(content.text, /已压缩 · 来自 Claude Code·讨论方案\n摘要：定了 A/);
    assert.match(content.text, /压缩期间新来的/);
    assert.doesNotMatch(content.text, /很长的讨论/);
  }));

test('压缩期间快照里的会话被拆走，这次压缩作废', () =>
  withPools(async pools => {
    const pool = await pools.create('交接');
    const a = await pools.merge(pool.id, claude, [message('a', 'user', '甲', null)]);
    const snapshot = await pools.ballContent(pool.id, a.ball);
    await pools.removeSession(pool.id, 'claude:c1');
    await assert.rejects(
      pools.seal(pool.id, a.ball, snapshot, { text: 't', tokens: 1 }),
      /这个球不在池子里|作废/,
    );
  }));

test('整个球带着会话、内容和压缩块搬到另一个池子；移出球会带走它的内容', () =>
  withPools(async pools => {
    const from = await pools.create('甲');
    const to = await pools.create('乙');
    const a = await pools.merge(from.id, claude, [message('a', 'user', '要搬走的', null)]);
    const b = await pools.merge(from.id, codex, [message('x', 'user', '要移出的', null)]);
    const moved = await pools.moveBall(from.id, a.ball, to.id);
    assert.deepEqual(
      moved.sessions.map(s => s.id),
      ['c1'],
    );
    assert.deepEqual(
      (await pools.messages(to.id)).map(m => m.text),
      ['要搬走的'],
    );
    const left = await pools.removeBall(from.id, b.ball);
    assert.equal(left.balls.length, 0);
    assert.deepEqual(await pools.messages(from.id), []);
  }));

test('旧格式的池子：融合的会话合成一个球，等待中的各自一个球，留在原来的格子', () =>
  withPools(async (pools, home) => {
    const pool = await pools.create('旧');
    const raw = {
      ...pool,
      sessions: [
        { ...claude, fused: true, cell: null },
        { ...codex, fused: true, cell: null },
        { ...codex, id: 'x2', fused: false, cell: 4 },
      ],
      deliveries: { 'codex:x9': { sent: {} } },
    };
    delete raw.balls;
    await writeJson(path.join(home, 'pools', `${pool.id}.json`), raw);
    const upgraded = await pools.load(pool.id);
    assert.equal(upgraded.balls.length, 2);
    const [fused, waiting] = upgraded.balls;
    assert.deepEqual(
      upgraded.sessions.filter(s => s.ball === fused.id).map(s => s.id),
      ['c1', 'x1'],
    );
    assert.equal(waiting.cell, 4);
    assert.equal(upgraded.deliveries, undefined);
  }));
