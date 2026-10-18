import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { turnMessages, createCodexTool } from '../tools/codex.mjs';
import { condense, createClaudeTool } from '../tools/claude.mjs';
import { MARKER } from '../home.mjs';

const temporary = prefix => mkdtemp(path.join(tmpdir(), prefix));

test('Codex 每轮只留用户的话和最终回答，进行中的轮次不读', () => {
  const turn = {
    status: 'completed',
    startedAt: 1792160000,
    completedAt: 1792160060,
    items: [
      { type: 'userMessage', id: 'u', content: [{ type: 'text', text: '修好测试' }] },
      { type: 'agentMessage', id: 'c', phase: 'commentary', text: '我先看看' },
      { type: 'commandExecution', id: 'e' },
      { type: 'agentMessage', id: 'f', phase: 'final_answer', text: '已修好' },
    ],
  };
  assert.deepEqual(
    turnMessages(turn).map(item => [item.id, item.role, item.text]),
    [
      ['u', 'user', '修好测试'],
      ['f', 'assistant', '已修好'],
    ],
  );
  assert.deepEqual(turnMessages({ ...turn, status: 'inProgress' }), []);
});

test('Codex 从最新往回读，碰到池子里已有的消息就停，结果按时间正序', async () => {
  const turn = n => ({
    status: 'completed',
    items: [{ type: 'userMessage', id: `u${n}`, content: [{ type: 'text', text: `第${n}轮` }] }],
  });
  const pages = [
    { data: [turn(5), turn(4)], nextCursor: 'p2' },
    { data: [turn(3), turn(2)], nextCursor: 'p3' },
    { data: [turn(1)], nextCursor: null },
  ];
  const requested = [];
  const tool = createCodexTool({
    connect: async () => ({
      request: async (method, params) => {
        requested.push(params.cursor ?? 'p1');
        return pages[{ p1: 0, p2: 1, p3: 2 }[params.cursor ?? 'p1']];
      },
      close: () => {},
    }),
  });
  const messages = await tool.readMessages({ id: 't' }, { known: new Set(['u3']) });
  assert.deepEqual(requested, ['p1', 'p2'], '读到含已知消息的那一页就停');
  assert.deepEqual(
    messages.map(item => item.id),
    ['u2', 'u3', 'u4', 'u5'],
  );
});

test('Codex 进程一个一个启动；撞上 Codex 启动时重试一次，其他错误照实报', async () => {
  let starting = 0;
  let most = 0;
  let clashes = 1;
  const tool = createCodexTool({
    retryMs: 1,
    connect: async () => {
      starting++;
      most = Math.max(most, starting);
      await new Promise(resolve => setTimeout(resolve, 5));
      starting--;
      if (clashes-- > 0)
        throw Object.assign(new Error('x'), {
          codexMessage: 'exit 1: failed to initialize sqlite state runtime',
        });
      return { request: async () => ({ data: [] }), close: () => {} };
    },
  });
  await Promise.all([tool.listSessions(), tool.listSessions(), tool.readMessages({ id: 't' })]);
  assert.equal(most, 1);
  const broken = createCodexTool({
    connect: async () => {
      throw Object.assign(new Error('x'), { codexMessage: 'thread not found' });
    },
  });
  await assert.rejects(broken.listSessions(), error => error.codexMessage === 'thread not found');
});

test('Claude 只留用户的话和每轮最后的回答，跳过工具、子任务与未结束的轮次', () => {
  const raw = [
    {
      type: 'user',
      uuid: 'u1',
      message: { content: '定方案<system-reminder>内部提示</system-reminder>' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      message: { content: [{ type: 'text', text: '我先查' }], stop_reason: 'tool_use' },
    },
    { type: 'user', uuid: 't1', message: { content: [{ type: 'tool_result', content: 'x' }] } },
    {
      type: 'assistant',
      uuid: 'sub',
      parent_tool_use_id: 'p',
      message: { content: [{ type: 'text', text: '子任务' }] },
    },
    {
      type: 'assistant',
      uuid: 'a2',
      message: { content: [{ type: 'text', text: '方案是 A' }], stop_reason: 'end_turn' },
    },
    { type: 'user', uuid: 'u2', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'user', uuid: 'u3', message: { content: '再想想' } },
    {
      type: 'assistant',
      uuid: 'a3',
      message: { content: [{ type: 'text', text: '还在想' }], stop_reason: null },
    },
  ];
  assert.deepEqual(
    condense(raw).map(item => [item.id, item.text]),
    [
      ['u1', '定方案'],
      ['a2', '方案是 A'],
      ['u3', '再想想'],
    ],
  );
});

test('Claude 列表跟着桌面端：不列已归档、在桌面端删掉的和远程开的线程，用桌面端的标题，终端里开的标上 CLI', async () => {
  const root = await temporary('gft-merge-claude-list-');
  try {
    const desktopDir = path.join(root, 'desktop');
    const projectsDir = path.join(root, 'projects');
    await mkdir(path.join(desktopDir, 'account', 'project'), { recursive: true });
    await mkdir(path.join(projectsDir, 'D--work'), { recursive: true });
    const now = Date.now();
    // In the app's index only: the SDK's own listing misses some of the app's sessions.
    const index = {
      kept: '桌面端的名字',
      archived: '归档了',
      unlisted: 'SDK 漏掉的',
      thread: '远程开的线程',
    };
    for (const [i, [id, title]] of Object.entries(index).entries())
      await writeFile(
        path.join(desktopDir, 'account', 'project', `local_${id}.json`),
        JSON.stringify({
          cliSessionId: id,
          title,
          cwd: 'D:/work',
          isArchived: id === 'archived',
          ...(id === 'thread' ? { remoteControlSpawn: { ccrSessionId: 'cse_1' } } : {}),
          lastActivityAt: now - i * 10000,
        }),
      );
    for (const [id, entrypoint] of [
      ['deleted', 'claude-desktop'],
      ['terminal', 'cli'],
    ])
      await writeFile(
        path.join(projectsDir, 'D--work', `${id}.jsonl`),
        `{"type":"user","entrypoint":"${entrypoint}"}\n`,
      );
    const sdk = async () => ({
      listSessions: async () =>
        ['kept', 'archived', 'deleted', 'terminal'].map((sessionId, i) => ({
          sessionId,
          summary: `第一句 ${sessionId}`,
          lastModified: now - i * 1000,
        })),
    });
    const listed = await createClaudeTool({ sdk, desktopDir, projectsDir }).listSessions();
    assert.deepEqual(
      listed.map(item => [item.id, item.title, item.origin]),
      [
        ['kept', '桌面端的名字', undefined],
        ['terminal', '第一句 terminal', 'CLI'],
        ['unlisted', 'SDK 漏掉的', undefined],
      ],
    );
    const withoutApp = await createClaudeTool({
      sdk,
      desktopDir: path.join(root, 'none'),
      projectsDir,
    }).listSessions();
    assert.equal(withoutApp.length, 4, '没有桌面端时全部列出');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('桌面端新记录不写会话编号时，按同一目录、开始时间紧跟其后对上会话文件', async () => {
  const root = await temporary('gft-merge-unnamed-');
  try {
    const desktopDir = path.join(root, 'desktop');
    const projectsDir = path.join(root, 'projects');
    await mkdir(path.join(desktopDir, 'account', 'project'), { recursive: true });
    await mkdir(path.join(projectsDir, 'D--work'), { recursive: true });
    const created = Date.now() - 60000;
    await writeFile(
      path.join(desktopDir, 'account', 'project', 'local_app-1.json'),
      JSON.stringify({
        sessionId: 'local_app-1',
        title: '测试',
        cwd: 'D:/work',
        createdAt: created,
        lastActivityAt: created,
      }),
    );
    const transcript = (id, entrypoint, cwd, at) =>
      writeFile(
        path.join(projectsDir, 'D--work', `${id}.jsonl`),
        `${JSON.stringify({ type: 'user', entrypoint, cwd, timestamp: new Date(at).toISOString() })}\n`,
      );
    await transcript('older', 'claude-desktop', 'D:/work', created - 3600000);
    await transcript('other-folder', 'claude-desktop', 'D:/elsewhere', created + 1000);
    await transcript('scripted', 'sdk-ts', 'D:/work', created + 1000);
    await transcript('right', 'claude-desktop', 'D:/work', created + 2000);
    const sdk = async () => ({ listSessions: async () => [] });
    const listed = await createClaudeTool({ sdk, desktopDir, projectsDir }).listSessions();
    assert.deepEqual(
      listed.map(item => [item.id, item.title]),
      [['right', '测试']],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/** A Codex app-server stand-in: records requests, can fail some, and ends turns on request. */
function fakeCodex({ fail = {} } = {}) {
  const requests = [];
  let closed = 0;
  const finish = [];
  const connect = async () => {
    const listeners = new Set();
    return {
      request: async (method, params) => {
        requests.push([method, params]);
        if (fail[method]) throw Object.assign(new Error('x'), { codexMessage: fail[method] });
        if (method === 'model/list') return { data: [{ model: 'gpt-test', isDefault: true }] };
        if (method === 'thread/start') return { thread: { id: 'new-thread', cwd: params.cwd } };
        if (method === 'turn/start')
          finish.push(() =>
            listeners.forEach(l =>
              l({ method: 'turn/completed', params: { threadId: params.threadId } }),
            ),
          );
        return {};
      },
      waitFor: (method, accept) =>
        new Promise(resolve =>
          listeners.add(m => m.method === method && accept(m.params) && resolve(m.params)),
        ),
      close: () => closed++,
    };
  };
  return { connect, requests, closed: () => closed, finishTurns: () => finish.forEach(f => f()) };
}

test('Codex 新建：用默认模型开会话、起名、发出第一条；不等回复就返回，回完才断开并在桌面端打开', async () => {
  const codex = fakeCodex();
  const opened = [];
  const created = await createCodexTool({
    connect: codex.connect,
    open: url => opened.push(url),
  }).create({
    cwd: 'D:/work/app',
    title: 'merge · 交接',
    text: `${MARKER}内容`,
  });
  assert.deepEqual(
    codex.requests.map(([method]) => method),
    ['model/list', 'thread/start', 'thread/name/set', 'turn/start'],
  );
  assert.equal(codex.requests[1][1].model, 'gpt-test');
  assert.equal(created.session.id, 'new-thread');
  assert.equal(created.session.title, 'merge · 交接');
  assert.equal(codex.closed(), 0, '回复没结束前不能断开，否则回复会被打断');
  assert.deepEqual(opened, []);
  codex.finishTurns();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(codex.closed(), 1);
  assert.deepEqual(opened, ['codex://threads/new-thread']);
});

test('Claude 新建走 SDK 的一轮对话：起好名字，再用桌面端的导入链接打开；失败照实报', async () => {
  const calls = [];
  const renamed = [];
  const opened = [];
  const sdk = async () => ({
    query: ({ prompt, options }) =>
      (async function* () {
        calls.push({ prompt, options });
        yield { type: 'system', session_id: 'c-new' };
        yield { type: 'result', is_error: false, session_id: 'c-new' };
      })(),
    renameSession: async (id, title) => renamed.push([id, title]),
  });
  const tool = createClaudeTool({ sdk, open: url => opened.push(url) });
  const created = await tool.create({
    cwd: 'D:/work',
    title: 'merge · 交接',
    text: `${MARKER}内容`,
  });
  assert.equal(created.session.id, 'c-new');
  assert.match(calls[0].prompt, /内容[\s\S]*已收到/);
  assert.equal(calls[0].options.cwd, 'D:/work');
  assert.ok(!('CLAUDECODE' in calls[0].options.env), '不沿用父会话的环境');
  assert.deepEqual(renamed, [['c-new', 'merge · 交接']]);
  assert.deepEqual(opened, ['claude://resume?session=c-new']);
  const failing = createClaudeTool({
    open: () => {},
    sdk: async () => ({
      query: () =>
        (async function* () {
          yield { type: 'result', is_error: true, session_id: 's', result: '额度不足' };
        })(),
    }),
  });
  await assert.rejects(failing.create({ cwd: 'D:/work', title: 't', text: 'x' }), /额度不足/);
});
