// GFT-Merge page. Regions own their gestures: the tool buckets above belong to
// the tools, the pool list and workspace below belong to us. The workspace is
// a grid of balls: a session dropped in becomes a ball, a ball dropped on
// another fuses into it, and a click compresses it. Dragging a ball up starts
// a session with exactly what it holds. Every change shows at once; the server
// follows, and a failure reloads the saved state.
const $ = selector => document.querySelector(selector);
const el = (tag, { dataset, ...props } = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  Object.assign(node.dataset, dataset);
  for (const child of children.flat()) if (child != null) node.append(child);
  return node;
};
const SVG = 'http://www.w3.org/2000/svg';
const keyOf = item => `${item.tool}:${item.id}`;
const color = tool => `var(--${tool}, var(--muted))`;

const state = {
  tools: [],
  enabled: {},

  sessions: {}, // tool id → listed sessions
  processors: null, // tools that can compress, with their models; read when the menu first opens
  busy: new Set(), // tool ids starting a session now
  unavailable: {}, // tool id → why its sessions could not be read
  fresh: null, // key of the session just started, shown with a brief highlight
  compressing: new Set(), // ball ids this page asked to compress
  processor: null, // { tool, model } that compresses
  pools: [],
  selectedId: null,
  dragging: false,
};
const selected = () => state.pools.find(pool => pool.id === state.selectedId) || null;
const store = {
  get: key => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* A remembered choice is a convenience only. */
    }
  },
};

async function api(method, url, body) {
  // Writes are always JSON; the service refuses anything else from a browser.
  const write = method !== 'GET';
  const response = await fetch(url, {
    method,
    headers: write ? { 'Content-Type': 'application/json' } : {},
    body: write ? JSON.stringify(body ?? {}) : undefined,
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
  return value;
}

let toastTimer;
function toast(text) {
  const node = $('#toast');
  node.textContent = text;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
}

/** Runs a server change after the page already shows it; on failure the saved state returns. */
async function commit(run, done) {
  try {
    const result = await run();
    const message = done?.(result);
    if (message) toast(message);
    return result;
  } catch (error) {
    toast(error.message);
    await loadPools();
    return null;
  }
}

function ago(iso) {
  if (!iso) return '';
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)} 分钟前`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} 小时前`;
  return `${Math.round(minutes / 1440)} 天前`;
}
const project = cwd => (cwd ? cwd.split(/[\\/]/).filter(Boolean).at(-1) : '');

// ---- Top: buckets on a rail, panned by pressing the gaps ----
let railX = 0;
function setRail(x) {
  const room = $('#top').clientWidth - $('#rail').scrollWidth;
  railX = Math.min(0, Math.max(Math.min(0, room), x));
  $('#rail').style.transform = `translateX(${railX}px)`;
}

function renderTools() {
  const scrolls = [...document.querySelectorAll('.bucket ul')].map(list => list.scrollTop);
  $('#rail').replaceChildren(
    ...state.tools
      .filter(tool => state.enabled[tool.id] !== false)
      .map(tool => {
        // Not read yet is not the same as empty: until the list arrives it says so.
        const loaded = tool.id in state.sessions;
        const sessions = state.sessions[tool.id] || [];
        const header = el(
          'header',
          {},
          el('span', { className: 'dot', style: `background:${color(tool.id)}` }),
          tool.name,
          state.busy.has(tool.id) ? el('span', { className: 'spinner' }) : null,
          el('span', {
            className: 'count',
            textContent: loaded && !state.unavailable[tool.id] ? `${sessions.length} 个会话` : '',
          }),
        );
        const rows = sessions.map(item =>
          el(
            'li',
            {
              className: keyOf(item) === state.fresh ? 'session fresh' : 'session',
              dataset: { tool: item.tool, id: item.id },
              title: `${item.title}\n${item.cwd || ''}`,
            },
            el('span', { className: 'title', textContent: item.title }),
            el('span', { className: 'meta', textContent: ago(item.updatedAt) }),
            el('span', {
              className: 'meta',
              textContent: [project(item.cwd), item.origin].filter(Boolean).join(' · '),
            }),
          ),
        );
        return el(
          'div',
          // The whole bucket is the drop target: let go anywhere on it to start a session there.
          {
            className: 'bucket',
            dataset: { drop: `松手：在 ${tool.name} 新建会话`, tool: tool.id },
          },
          header,
          el(
            'ul',
            {},
            rows.length
              ? rows
              : el('li', {
                  className: 'empty',
                  textContent: !loaded ? '读取中…' : state.unavailable[tool.id] || '最近没有会话',
                }),
          ),
        );
      }),
  );
  // Keep each bucket where the person had scrolled it.
  document.querySelectorAll('.bucket ul').forEach((list, i) => (list.scrollTop = scrolls[i] || 0));
  setRail(railX);
}

$('#top').addEventListener('pointerdown', event => {
  if (event.target.closest('.bucket')) return;
  const startX = event.clientX - railX;
  $('#top').classList.add('panning');
  const move = e => setRail(e.clientX - startX);
  const up = () => {
    $('#top').classList.remove('panning');
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
});
$('#top').addEventListener(
  'wheel',
  event => {
    const dx = event.deltaX || (event.shiftKey ? event.deltaY : 0);
    if (!dx) return;
    event.preventDefault();
    setRail(railX - dx);
  },
  { passive: false },
);
addEventListener('resize', () => {
  setRail(railX);
  renderWorkspace();
});

// ---- Shared drag: a press becomes a drag after a few pixels ----
/** A press that never moves far enough is a click. */
function drag(event, { start, move, end, click }) {
  const x0 = event.clientX;
  const y0 = event.clientY;
  let active = false;
  const onMove = e => {
    if (!active && Math.hypot(e.clientX - x0, e.clientY - y0) < 5) return;
    if (!active) {
      active = true;
      state.dragging = true;
      document.body.classList.add('dragging');
      start?.(e);
    }
    move?.(e);
  };
  const onUp = e => {
    removeEventListener('pointermove', onMove);
    removeEventListener('pointerup', onUp);
    if (!active) return click?.(e);
    state.dragging = false;
    document.body.classList.remove('dragging', 'removing', 'carrying-up', 'carrying-small');
    document.querySelectorAll('.target').forEach(node => node.classList.remove('target'));
    hidePreview();
    end?.(e);
  };
  addEventListener('pointermove', onMove);
  addEventListener('pointerup', onUp);
}
const ghost = $('#ghost');
const showGhost = (...content) => {
  ghost.replaceChildren(...content);
  ghost.hidden = false;
};
const moveGhost = e => {
  ghost.style.left = `${e.clientX}px`;
  ghost.style.top = `${e.clientY}px`;
};
const inside = (node, e) => {
  const r = node.getBoundingClientRect();
  return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
};
/** A session's name with its tool in front, since sessions in different tools share names. */
const TOOL_TAGS = { claude: 'Claude', codex: 'Codex' };
const sourceName = item => `${TOOL_TAGS[item.tool] || item.tool} · ${item.title}`;
/** The same name as nodes, with the tool in its color. */
const sourceNodes = item => [
  el('span', {
    className: 'tag',
    style: `color:var(--${item.tool}-text, var(--muted))`,
    textContent: TOOL_TAGS[item.tool] || item.tool,
  }),
  ` · ${item.title}`,
];
/** Several names, separated by 、 */
const sourceList = items =>
  items.flatMap((item, i) => [...(i ? ['、'] : []), ...sourceNodes(item)]);
const chip = item => el('span', { className: 'chip' }, ...sourceNodes(item));

// ---- Balls: hollow vector circles with their size in the middle ----
// A ball grows with how many sessions it holds and approaches a ceiling set by
// the cell, never reaching it. While it is compressed, its dashed ring turns.
const BASE = 26;
const membersOf = b => b.sessions.length + b.compacts.reduce((n, c) => n + c.from.length, 0);
const radiusOf = (b, g) => {
  const ceiling = Math.max(BASE + 4, Math.min(g.w, g.h) * 0.34);
  return ceiling - (ceiling - BASE) / Math.max(1, membersOf(b));
};
const short = n =>
  n >= 1e6
    ? `${(n / 1e6).toFixed(1)}M`
    : n >= 1e4
      ? `${Math.round(n / 1e3)}k`
      : n >= 1e3
        ? `${(n / 1e3).toFixed(1)}k`
        : `${n}`;
/**
 * The number in a ball. One plain session shows its own context size, read from
 * its tool; anything fused or compacted shows what dragging it up would send.
 */
function sizeOf(b) {
  const single = b.sessions.length === 1 && !b.compacts.length ? b.sessions[0] : null;
  if (single && Number.isFinite(single.context)) return short(single.context);
  return b.tokens ? `≈${short(b.tokens)}` : '';
}
/** The names of the sessions a ball holds, compacted ones included; the label cuts them short. */
const sourcesOf = b => [...b.compacts.flatMap(c => c.from), ...b.sessions];
const nameOf = b => sourcesOf(b).map(sourceName).join('、');
function ballSvg(r, { spinning = false, label = '' } = {}) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', 2 * r + 4);
  svg.setAttribute('height', 2 * r + 4);
  svg.setAttribute('class', `ball${spinning ? ' spinning' : ''}`);
  const circle = document.createElementNS(SVG, 'circle');
  circle.setAttribute('cx', r + 2);
  circle.setAttribute('cy', r + 2);
  circle.setAttribute('r', r);
  const text = document.createElementNS(SVG, 'text');
  text.setAttribute('x', r + 2);
  text.setAttribute('y', r + 2);
  text.textContent = label;
  svg.append(circle, text);
  return svg;
}

// ---- Workspace grid: every ball sits in a cell ----
const CELL = 150;
function grid() {
  const r = $('#workspace').getBoundingClientRect();
  const cols = Math.max(3, Math.floor(r.width / CELL));
  const rows = Math.max(2, Math.floor(r.height / CELL));
  const w = r.width / cols;
  const h = r.height / rows;
  const center = i => ({ x: (i % cols) * w + w / 2, y: Math.floor(i / cols) * h + h / 2 - 12 });
  return { rect: r, cols, rows, w, h, center, count: cols * rows };
}
const local = (g, e) => ({ x: e.clientX - g.rect.left, y: e.clientY - g.rect.top });

/** The free cell nearest to `p`; `except` is the dragged ball's own ID. */
function nearestFree(g, p, except) {
  const taken = new Set(
    (selected()?.balls || [])
      .filter(b => b.id !== except && Number.isInteger(b.cell))
      .map(b => b.cell),
  );
  let best = null;
  for (let i = 0; i < g.count; i++) {
    if (taken.has(i)) continue;
    const c = g.center(i);
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (!best || d < best.d) best = { i, d };
  }
  return best?.i ?? null;
}

/** The ball under the pointer, other than `except`, which a carried thing would fuse into. */
function ballAt(e, except) {
  const g = grid();
  const p = local(g, e);
  return (
    (selected()?.balls || []).find(b => {
      if (b.id === except || !Number.isInteger(b.cell)) return false;
      const c = g.center(b.cell);
      return Math.hypot(c.x - p.x, c.y - p.y) <= radiusOf(b, g) + 10;
    }) || null
  );
}

function showPreview(g, p, except) {
  const preview = $('#preview');
  const i = nearestFree(g, p, except);
  // An <svg> has no `hidden` property, so the attribute is set directly.
  preview.toggleAttribute('hidden', i === null);
  if (i === null) return;
  const c = g.center(i);
  Object.assign(preview.style, { left: `${c.x}px`, top: `${c.y}px` });
}
function hidePreview() {
  $('#preview').toggleAttribute('hidden', true);
  $('#workspace').classList.remove('receiving');
}
/** While something is carried over the workspace: a ball to fuse into lights up, else the free cell shows. */
function trackWorkspace(e, exceptBall) {
  const into = ballAt(e, exceptBall);
  document
    .querySelectorAll('.orb.fuse-target')
    .forEach(node => node.dataset.ball !== into?.id && node.classList.remove('fuse-target'));
  if (into) {
    $(`.orb[data-ball="${into.id}"]`)?.classList.add('fuse-target');
    return $('#preview').toggleAttribute('hidden', true);
  }
  showPreview(grid(), local(grid(), e), exceptBall);
}
const clearFuseTarget = () =>
  document.querySelectorAll('.fuse-target').forEach(node => node.classList.remove('fuse-target'));

function renderGrid(g) {
  $('#gridlines').replaceChildren(
    ...Array.from({ length: g.count }, (_, i) =>
      el('div', {
        className: 'cell',
        style: `left:${(i % g.cols) * g.w}px;top:${Math.floor(i / g.cols) * g.h}px;width:${g.w}px;height:${g.h}px`,
      }),
    ),
  );
}

function renderWorkspace() {
  const space = $('#workspace');
  space.querySelectorAll('.orb, .slot').forEach(node => node.remove());
  const g = grid();
  renderGrid(g);
  const pool = selected();
  if (!pool?.balls.length)
    return space.append(
      el('div', {
        className: 'slot',
        style: `left:${g.rect.width / 2}px;top:${g.rect.height / 2}px`,
        textContent: '把上面的会话拖到这里；把一个球拖到另一个球上＝融合',
      }),
    );
  // A ball without a valid free cell (new, or after a resize) gets the nearest one.
  const used = new Set();
  for (const b of pool.balls) {
    const ok = Number.isInteger(b.cell) && b.cell < g.count && !used.has(b.cell);
    if (!ok) b.cell = nearestFree(g, { x: 0, y: 0 }, b.id);
    used.add(b.cell);
  }
  for (const b of pool.balls) {
    const c = g.center(b.cell);
    const r = radiusOf(b, g);
    const spinning = b.compressing || state.compressing.has(b.id);
    const svg = ballSvg(r, { spinning, label: sizeOf(b) });
    svg.addEventListener('pointerdown', e => carryBall(e, b, node));
    const name = spinning
      ? el('span', { className: 'label compressing', textContent: '压缩中…' })
      : el('span', { className: 'label', title: nameOf(b) }, ...sourceList(sourcesOf(b)));
    const parts = membersOf(b) > 1 || b.compacts.length ? composition(b) : null;
    const node = el(
      'div',
      {
        // In the lower half the composition opens up and to the side, inside the workspace.
        className: c.y > g.rect.height / 2 ? 'orb up' : 'orb',
        dataset: { ball: b.id },
        style: `left:${c.x}px;top:${c.y}px;--r:${r}px`,
        title: spinning ? '压缩中…' : '点一下＝压缩；拖到另一个球上＝融合；往上拖＝新建会话',
      },
      svg,
      el('div', { className: 'name', style: `max-width:${g.w - 12}px` }, name, parts),
    );
    space.append(node);
  }
}

/** The list shown when hovering a ball's name: compacts (sealed) and sessions (draggable out). */
function composition(b) {
  return el(
    'div',
    { className: 'parts' },
    ...b.compacts.map(compact =>
      el(
        'div',
        { className: 'part sealed', title: '已压缩，不能拆开' },
        '已压缩 · ',
        ...sourceList(compact.from),
        el('span', { className: 'meta', textContent: ` ${short(compact.tokens)}` }),
      ),
    ),
    ...b.sessions.map(session => {
      const node = el(
        'div',
        {
          className: 'part',
          title: '拖出去＝拆开；拖到另一个球上＝移过去；往上拖＝只用这一段新建会话',
        },
        chip(session),
        Number.isFinite(session.context)
          ? el('span', { className: 'meta', textContent: ` ${short(session.context)}` })
          : null,
      );
      node.addEventListener('pointerdown', e => carryPart(e, b, session));
      return node;
    }),
  );
}

// ---- Where a carried thing would land ----
/** A target under the pointer: a tool's bucket, or another pool. */
function targetAt(e, { pools = false } = {}) {
  // Found by position, not by what the browser reports under the pointer, so a
  // drop never misses its target and falls through to removing the ball.
  const hit = (selector, area) =>
    inside($(area), e) ? [...document.querySelectorAll(selector)].find(n => inside(n, e)) : null;
  const found = hit('.bucket', '#top') || (pools ? hit('.pool-item', '#pools') : null);
  if (found?.matches('.pool-item') && found.dataset.id === state.selectedId) return null;
  return found || null;
}
function highlight(target) {
  document
    .querySelectorAll('.target')
    .forEach(node => node !== target && node.classList.remove('target'));
  target?.classList.add('target');
}
/** Tracks anything carried from the workspace: fuse target or free cell inside, targets outside, removal warning. */
function trackCarried(e, exceptBall) {
  const space = $('#workspace');
  const within = inside(space, e);
  const target = within ? null : targetAt(e, { pools: true });
  highlight(target);
  document.body.classList.toggle('carrying-up', !within && inside($('#top'), e));
  document.body.classList.toggle('removing', !within && !target && !inside($('#top'), e));
  if (within) trackWorkspace(e, exceptBall);
  else {
    clearFuseTarget();
    hidePreview();
  }
  edgePan(e);
}
let edgeTimer = null;
function edgePan(e) {
  clearInterval(edgeTimer);
  const r = $('#top').getBoundingClientRect();
  if (e.clientY > r.bottom) return;
  if (e.clientX < r.left + 60) edgeTimer = setInterval(() => setRail(railX + 12), 16);
  else if (e.clientX > r.right - 60) edgeTimer = setInterval(() => setRail(railX - 12), 16);
}

// ---- Actions ----
const listed = target =>
  (state.sessions[target.dataset.tool] || []).find(s => s.id === target.dataset.id);
const poolPath = (...parts) =>
  `/api/pools/${selected().id}${parts.length ? '/' : ''}${parts.join('/')}`;
/** Applies a pool the server returned in place of the local one. */
function adopt(pool) {
  if (!pool?.id) return;
  state.pools = state.pools.map(p => (p.id === pool.id ? pool : p));
  render();
}

/**
 * Starts a session in the bucket's tool whose first message is the ball (or,
 * with `source`, one session of it). Sending into existing sessions is left
 * out: Codex refuses a session open in its app, and the Claude app does not
 * show what another program writes into one of its sessions.
 */
async function injectInto(target, ballId, source) {
  const tool = target.dataset.tool;
  // The drop lands at once: the bucket gives a short knock and spins until the session exists.
  state.busy.add(tool);
  renderTools();
  pulse(tool, 'hit');
  const result = await commit(() =>
    api('POST', poolPath('inject'), { tool, ball: ballId, source }),
  );
  state.busy.delete(tool);
  await loadPools();
  if (result?.status === 'nothing-new') toast('这个球里没有内容');
  if (result?.status !== 'sent') {
    renderTools();
    return pulse(tool, 'shake');
  }
  // The new session is the tool's most recent one; it rises to the top with a brief highlight.
  const listedSessions = state.sessions[tool] || [];
  state.sessions[tool] = [
    { ...result.session, updatedAt: new Date().toISOString() },
    ...listedSessions.filter(s => s.id !== result.session.id),
  ];
  state.fresh = keyOf(result.session);
  renderTools();
  $(`.bucket[data-tool="${tool}"] ul`)?.scrollTo({ top: 0 });
  setTimeout(() => {
    if (state.fresh === keyOf(result.session)) state.fresh = null;
  }, 1600);
}

/** Plays a one-off animation on a tool's bucket: 'hit' when something lands, 'shake' on failure. */
function pulse(tool, kind) {
  shakeNode($(`.bucket[data-tool="${tool}"]`), kind);
}
function shakeNode(node, kind = 'shake') {
  if (!node) return;
  node.classList.remove('hit', 'shake');
  void node.offsetWidth; // restart the animation if it is already playing
  node.classList.add(kind);
  node.addEventListener('animationend', () => node.classList.remove(kind), { once: true });
}

/** Compresses a ball with the processing tool; it spins until the compact replaces its content. */
async function compressBall(b) {
  if (b.compressing || state.compressing.has(b.id)) return;
  state.compressing.add(b.id);
  renderWorkspace();
  const pool = await commit(() => api('POST', poolPath('compress'), { ball: b.id }));
  state.compressing.delete(b.id);
  if (pool) return adopt(pool);
  renderWorkspace();
  shakeNode($(`.orb[data-ball="${b.id}"]`));
}

/** Fuses ball `from` into ball `into`, shown at once. */
function fuseLocally(from, into) {
  into.sessions.push(...from.sessions);
  into.compacts.push(...from.compacts);
  selected().balls = selected().balls.filter(b => b !== from);
  render();
  commit(() => api('POST', poolPath('fuse'), { from: from.id, into: into.id })).then(adopt);
}

/** A whole ball carried: onto a ball fuses, into a free cell moves, up starts a session, onto a pool moves there, out removes it. */
function carryBall(event, b, node) {
  event.stopPropagation();
  drag(event, {
    click: () => compressBall(b),
    start: () => {
      document.body.classList.add('carrying-small');
      node.classList.add('lifted');
    },
    move: e => {
      const p = local(grid(), e);
      Object.assign(node.style, { left: `${p.x}px`, top: `${p.y}px` });
      trackCarried(e, b.id);
    },
    end: e => {
      clearInterval(edgeTimer);
      clearFuseTarget();
      const pool = selected();
      if (inside($('#workspace'), e)) {
        const into = ballAt(e, b.id);
        if (into) return fuseLocally(b, into);
        const cell = nearestFree(grid(), local(grid(), e), b.id);
        b.cell = cell;
        render();
        return commit(() => api('PATCH', poolPath('balls', b.id), { cell })).then(adopt);
      }
      const target = targetAt(e, { pools: true });
      if (target?.matches('.pool-item')) {
        pool.balls = pool.balls.filter(item => item !== b);
        render();
        return commit(
          () => api('POST', poolPath('move'), { ball: b.id, to: target.dataset.id }),
          () => `已把「${nameOf(b)}」移到另一个池子`,
        ).then(loadPools);
      }
      if (target) {
        render();
        return injectInto(target, b.id);
      }
      if (inside($('#top'), e)) return render(); // let go above but not on a target: back it goes
      pool.balls = pool.balls.filter(item => item !== b);
      render();
      commit(
        () => api('DELETE', poolPath('balls', b.id)),
        () => `已移出「${nameOf(b)}」`,
      ).then(adopt);
    },
  });
}

/** One session carried out of a ball's list: onto a ball moves it there, into a free cell splits it off, up starts a session with it alone, out removes it. */
function carryPart(event, b, session) {
  event.stopPropagation();
  const key = keyOf(session);
  drag(event, {
    start: e => {
      document.body.classList.add('carrying-small');
      showGhost(chip(session));
      moveGhost(e);
    },
    move: e => {
      moveGhost(e);
      trackCarried(e, b.id);
    },
    end: e => {
      clearInterval(edgeTimer);
      clearFuseTarget();
      ghost.hidden = true;
      const pool = selected();
      if (inside($('#workspace'), e)) {
        const into = ballAt(e, b.id);
        if (!into && ballAt(e) === b) return render(); // let go on its own ball: nothing changes
        const cell = into ? undefined : nearestFree(grid(), local(grid(), e), null);
        b.sessions = b.sessions.filter(s => keyOf(s) !== key);
        if (into) into.sessions.push(session);
        else
          pool.balls.push({
            id: `local-${Date.now()}`,
            cell,
            sessions: [session],
            compacts: [],
            tokens: 0,
          });
        render();
        return commit(() => api('POST', poolPath('split'), { key, ball: into?.id, cell })).then(
          adopt,
        );
      }
      const target = targetAt(e);
      if (target) {
        render();
        return injectInto(target, b.id, key);
      }
      if (inside($('#top'), e)) return render();
      b.sessions = b.sessions.filter(s => keyOf(s) !== key);
      render();
      commit(
        () => api('DELETE', poolPath('sessions', encodeURIComponent(key))),
        () => `已移出「${session.title}」`,
      ).then(adopt);
    },
  });
}

// A session row dragged down into the workspace joins the selected pool: onto a ball it fuses, elsewhere it is a new ball.
$('#rail').addEventListener('pointerdown', event => {
  const row = event.target.closest('.session');
  if (!row) return;
  const item = listed(row);
  drag(event, {
    start: e => {
      showGhost(chip(item));
      moveGhost(e);
    },
    move: e => {
      moveGhost(e);
      const within = inside($('#workspace'), e);
      $('#workspace').classList.toggle('receiving', within);
      if (within) trackWorkspace(e, null);
      else {
        clearFuseTarget();
        hidePreview();
      }
    },
    end: async e => {
      ghost.hidden = true;
      clearFuseTarget();
      if (!inside($('#workspace'), e)) return;
      let pool = selected();
      if (pool?.balls.some(b => b.sessions.some(s => keyOf(s) === keyOf(item))))
        return toast('这段会话已经在池子里');
      if (!pool) {
        // A new pool appears at once; the server confirms it.
        pool = { id: `local-${Date.now()}`, name: item.title, balls: [] };
        state.pools.unshift(pool);
        state.selectedId = pool.id;
      }
      const into = ballAt(e, null);
      const cell = into ? undefined : nearestFree(grid(), local(grid(), e), null);
      const session = { ...item };
      if (into) into.sessions.push(session);
      else
        pool.balls.push({
          id: `local-${Date.now()}`,
          cell,
          sessions: [session],
          compacts: [],
          tokens: 0,
        });
      render();
      const result = await commit(async () => {
        if (pool.id.startsWith('local-')) {
          const created = await api('POST', '/api/pools', { name: pool.name });
          pool.id = created.id;
          state.selectedId = created.id;
          store.set('gft-merge:selected', created.id);
        }
        return api('POST', `/api/pools/${pool.id}/sessions`, { ...item, ball: into?.id, cell });
      });
      if (result) adopt(result.pool);
    },
  });
});

// ---- Bottom: pool list ----
function renderList() {
  $('#pools').replaceChildren(
    ...state.pools.map(pool => {
      const name = el('span', { className: 'name', textContent: pool.name });
      return el(
        'li',
        {
          className: `pool-item${pool.id === state.selectedId ? ' selected' : ''}`,
          dataset: { id: pool.id },
          onclick: () => select(pool.id),
        },
        name,
        el('span', {
          className: 'meta',
          textContent: `${pool.balls.reduce((n, b) => n + membersOf(b), 0)}`,
        }),
        el('button', {
          className: 'edit',
          textContent: '✎',
          title: '改名',
          onclick: e => {
            e.stopPropagation();
            const input = el('input', { value: pool.name, className: 'name' });
            name.replaceWith(input);
            input.focus();
            input.select();
            input.onclick = k => k.stopPropagation();
            input.onkeydown = k => k.key === 'Enter' && input.blur();
            input.onblur = () => {
              const next = input.value.trim();
              if (!next || next === pool.name) return render();
              pool.name = next;
              render();
              commit(() => api('PATCH', `/api/pools/${pool.id}`, { name: next }));
            };
          },
        }),
        el('button', {
          className: 'edit',
          textContent: '×',
          title: '删除池子',
          onclick: e => {
            e.stopPropagation();
            if (!confirm(`删除池子「${pool.name}」？会话本身不受影响。`)) return;
            state.pools = state.pools.filter(p => p.id !== pool.id);
            if (state.selectedId === pool.id) state.selectedId = state.pools[0]?.id ?? null;
            render();
            commit(
              () => api('DELETE', `/api/pools/${pool.id}`),
              () => `已删除「${pool.name}」`,
            );
          },
        }),
      );
    }),
  );
}
function select(id) {
  state.selectedId = id;
  store.set('gft-merge:selected', id);
  render();
}
$('#add-pool').onclick = async () => {
  const created = await commit(() => api('POST', '/api/pools', { name: '新池子' }));
  if (!created) return;
  state.pools.unshift(created);
  select(created.id);
};

// ---- Settings: the gear menu at the top right ----
const THEMES = [
  ['light', '浅色'],
  ['dark', '深色'],
  ['system', '跟随系统'],
];
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}
function renderMenu() {
  const theme = store.get('gft-merge:theme') || 'system';
  $('#theme-group').replaceChildren(
    ...THEMES.map(([value, label]) =>
      el('button', {
        type: 'button',
        textContent: label,
        ariaPressed: String(value === theme),
        onclick: () => {
          store.set('gft-merge:theme', value);
          applyTheme(value);
          renderMenu();
        },
      }),
    ),
  );
  $('#tool-group').replaceChildren(
    ...state.tools.map(tool =>
      el('button', {
        type: 'button',
        textContent: tool.name,
        ariaPressed: String(state.enabled[tool.id] !== false),
        onclick: async () => {
          state.enabled[tool.id] = state.enabled[tool.id] === false;
          renderMenu();
          render();
          await commit(() => api('PUT', '/api/settings', { tools: state.enabled }));
          await loadSessions();
        },
      }),
    ),
  );
}
/** The processing tool: one choice of tool and model, listed once the menu first opens. */
function renderProcessor() {
  const select = $('#processor');
  const current = state.processor ? `${state.processor.tool}|${state.processor.model}` : '';
  if (!state.processors) {
    select.replaceChildren(el('option', { textContent: '读取中…' }));
    return;
  }
  select.replaceChildren(
    ...state.processors.map(item =>
      el(
        'optgroup',
        { label: item.name },
        ...item.models.map(model =>
          el('option', {
            value: `${item.tool}|${model.id}`,
            textContent: `${item.name} · ${model.name}`,
            selected: `${item.tool}|${model.id}` === current,
          }),
        ),
      ),
    ),
  );
}
$('#processor').addEventListener('change', event => {
  const [tool, model] = event.target.value.split('|');
  state.processor = { tool, model };
  commit(() => api('PUT', '/api/settings', { processor: state.processor }));
});
$('#menu').addEventListener('toggle', async () => {
  if (!$('#menu').open || state.processors) return;
  renderProcessor();
  state.processors = await api('GET', '/api/processors').catch(() => []);
  renderProcessor();
});
$('#menu').addEventListener('keydown', event => {
  if (event.key === 'Escape') $('#menu').open = false;
});
document.addEventListener('pointerdown', event => {
  if (!event.target.closest('#menu')) $('#menu').open = false;
});

// ---- Loading ----
function render() {
  renderTools();
  renderList();
  renderWorkspace();
}

let poolsSeen = '';
/** `quiet` loads redraw only on change, so the periodic check never cuts a click short. */
async function loadPools({ quiet = false } = {}) {
  const pools = await api('GET', '/api/pools');
  const seen = JSON.stringify(pools);
  const changed = !quiet || seen !== poolsSeen;
  poolsSeen = seen;
  state.pools = pools;
  if (!state.pools.some(pool => pool.id === state.selectedId))
    state.selectedId = state.pools[0]?.id ?? null;
  if (changed && !state.dragging) render();
}

async function loadSessions() {
  await Promise.all(
    state.tools
      .filter(tool => state.enabled[tool.id] !== false)
      .map(async tool => {
        // A tool that can't be read (not installed, say) says so in its own column, without a popup each time.
        try {
          state.sessions[tool.id] = await api('GET', `/api/sessions?tool=${tool.id}`);
          delete state.unavailable[tool.id];
        } catch (error) {
          state.sessions[tool.id] = [];
          state.unavailable[tool.id] =
            `${error.message}不用这个工具的话，可以在右上角设置里关掉这一栏。`;
        }
      }),
  );
  if (!state.dragging) renderTools();
}

const initial = await api('GET', '/api/state');
state.tools = initial.tools;
state.enabled = initial.settings.tools;
state.processor = initial.settings.processor;
state.selectedId = store.get('gft-merge:selected');
renderMenu();
await loadPools();
await loadSessions();
// New sessions appear when the person comes back.
addEventListener('focus', () => loadSessions());
setInterval(() => {
  if (document.visibilityState === 'visible' && !state.dragging)
    loadPools({ quiet: true }).catch(() => {});
}, 5000);
