// GFT-merge page. Regions own their gestures: the tool buckets above belong to
// the tools, the pool list and workspace below belong to us. The workspace is
// a grid: a session dropped in waits in a cell; dragged into the middle it is
// fused. Dragging anything up injects exactly what was dragged: one waiting
// session, or the fused sessions. Every change shows at once; the server
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
          el('span', {
            className: 'count',
            textContent: loaded ? `${sessions.length} 个会话` : '',
          }),
        );
        const rows = sessions.map(item =>
          el(
            'li',
            {
              className: 'session',
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
              : el('li', { className: 'empty', textContent: loaded ? '最近没有会话' : '读取中…' }),
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
function drag(event, { start, move, end }) {
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
    if (!active) return;
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
const chip = item =>
  el(
    'span',
    { className: 'chip' },
    el('span', { className: 'dot', style: `background:${color(item.tool)}` }),
    item.title,
  );

// ---- Balls: hollow dashed vector circles ----
// The fused ball grows with its number of sessions, which stays stable while
// each session's content is compacted over time. It approaches a ceiling set by
// the cell size and never reaches it.
const SMALL = 14;
const fusedRadius = (count, g) => {
  const ceiling = Math.max(30, Math.min(g.w, g.h) * 0.45);
  return ceiling - (ceiling - 24) / Math.max(1, count);
};
function ball(r) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('width', 2 * r + 4);
  svg.setAttribute('height', 2 * r + 4);
  svg.setAttribute('class', 'ball');
  const circle = document.createElementNS(SVG, 'circle');
  circle.setAttribute('cx', r + 2);
  circle.setAttribute('cy', r + 2);
  circle.setAttribute('r', r);
  svg.append(circle);
  return svg;
}

// ---- Workspace grid: the middle 2×2 block holds the fused sessions ----
const CELL = 112;
function grid() {
  const r = $('#workspace').getBoundingClientRect();
  const cols = Math.max(5, Math.floor(r.width / CELL));
  const rows = Math.max(3, Math.floor(r.height / CELL));
  const w = r.width / cols;
  const h = r.height / rows;
  const c0 = Math.floor((cols - 2) / 2);
  const r0 = Math.floor((rows - 2) / 2);
  const middle = { left: c0 * w, top: r0 * h, width: 2 * w, height: 2 * h };
  const reserved = new Set([
    r0 * cols + c0,
    r0 * cols + c0 + 1,
    (r0 + 1) * cols + c0,
    (r0 + 1) * cols + c0 + 1,
  ]);
  const center = i => ({ x: (i % cols) * w + w / 2, y: Math.floor(i / cols) * h + h / 2 });
  return { rect: r, cols, rows, w, h, middle, reserved, center, count: cols * rows };
}
const local = (g, e) => ({ x: e.clientX - g.rect.left, y: e.clientY - g.rect.top });
const inMiddle = (g, p) =>
  p.x >= g.middle.left &&
  p.x <= g.middle.left + g.middle.width &&
  p.y >= g.middle.top &&
  p.y <= g.middle.top + g.middle.height;

/** The free cell nearest to `p`; `except` is the dragged session's own key. */
function nearestFree(g, p, except) {
  const taken = new Set(
    (selected()?.sessions || [])
      .filter(s => !s.fused && keyOf(s) !== except && Number.isInteger(s.cell))
      .map(s => s.cell),
  );
  let best = null;
  for (let i = 0; i < g.count; i++) {
    if (g.reserved.has(i) || taken.has(i)) continue;
    const c = g.center(i);
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (!best || d < best.d) best = { i, d };
  }
  return best?.i ?? null;
}

function showPreview(g, p, except) {
  const fuse = inMiddle(g, p);
  $('#workspace').classList.toggle('fusing', fuse);
  // An <svg> has no `hidden` property, so the attribute is set directly.
  const preview = $('#preview');
  const i = fuse ? null : nearestFree(g, p, except);
  preview.toggleAttribute('hidden', i === null);
  if (i === null) return;
  const c = g.center(i);
  Object.assign(preview.style, { left: `${c.x}px`, top: `${c.y}px` });
}
function hidePreview() {
  $('#preview').toggleAttribute('hidden', true);
  $('#workspace').classList.remove('fusing', 'receiving');
}

function renderGrid(g) {
  $('#gridlines').replaceChildren(
    ...Array.from({ length: g.count }, (_, i) => i)
      .filter(i => !g.reserved.has(i))
      .map(i =>
        el('div', {
          className: 'cell',
          style: `left:${(i % g.cols) * g.w}px;top:${Math.floor(i / g.cols) * g.h}px;width:${g.w}px;height:${g.h}px`,
        }),
      ),
    el('div', {
      className: 'cell middle',
      style: `left:${g.middle.left}px;top:${g.middle.top}px;width:${g.middle.width}px;height:${g.middle.height}px`,
    }),
  );
}

function renderWorkspace() {
  const space = $('#workspace');
  space.querySelectorAll('.item, .fused, .slot').forEach(node => node.remove());
  const g = grid();
  renderGrid(g);
  const pool = selected();
  const middleCenter = {
    x: g.middle.left + g.middle.width / 2,
    y: g.middle.top + g.middle.height / 2,
  };
  const slot = text =>
    space.append(
      el('div', {
        className: 'slot',
        style: `left:${middleCenter.x}px;top:${middleCenter.y}px`,
        textContent: text,
      }),
    );
  if (!pool) return slot('把上面的会话拖到这里');
  const waiting = pool.sessions.filter(s => !s.fused);
  const fused = pool.sessions.filter(s => s.fused);
  // A waiting session without a valid free cell (new, or after a resize) gets the nearest one.
  const used = new Set();
  for (const session of waiting) {
    const ok =
      Number.isInteger(session.cell) &&
      session.cell < g.count &&
      !g.reserved.has(session.cell) &&
      !used.has(session.cell);
    if (!ok) session.cell = nearestFree(g, { x: 0, y: 0 }, keyOf(session));
    used.add(session.cell);
  }
  for (const session of waiting) {
    const c = g.center(session.cell);
    const node = el(
      'div',
      {
        className: 'item',
        style: `left:${c.x}px;top:${c.y}px`,
        title: `${session.title}\n${session.cwd || ''}\n${session.messages ?? 0} 段`,
      },
      ball(SMALL),
      el('span', {
        className: 'label',
        textContent: session.title,
        style: `max-width:${g.w - 8}px`,
      }),
    );
    node.addEventListener('pointerdown', e => carryWaiting(e, session, node));
    space.append(node);
  }
  if (!fused.length) return slot(waiting.length ? '拖到这里＝融合' : '把上面的会话拖到这里');
  const box = el(
    'div',
    {
      className: 'fused',
      style: `left:${middleCenter.x}px;top:${g.middle.top + 8}px;width:${g.middle.width}px`,
      title: '拖到上面的会话＝注入；拖到工具名一栏＝新建会话',
    },
    ball(fusedRadius(fused.length, g)),
    el('div', { className: 'caption', textContent: `已融合 ${fused.length} 段会话` }),
    el(
      'div',
      { className: 'members' },
      fused.map(session => {
        const node = chip(session);
        node.title = '拖出中间＝拆回待融合；往上拖＝只注入这一段；拖出工作区＝移出池子';
        node.addEventListener('pointerdown', e => carryMember(e, session));
        return node;
      }),
    ),
  );
  box.querySelector('.ball').addEventListener('pointerdown', e => carryFused(e, box));
  space.append(box);
}

// ---- Where a carried thing would land ----
/** A target under the pointer: a tool's bucket, or another pool. */
function targetAt(e, { pools = false } = {}) {
  const under = document.elementFromPoint(e.clientX, e.clientY);
  const found = under?.closest(pools ? '.bucket, .pool-item' : '.bucket');
  if (found?.matches('.pool-item') && found.dataset.id === state.selectedId) return null;
  return found || null;
}
function highlight(target) {
  document
    .querySelectorAll('.target')
    .forEach(node => node !== target && node.classList.remove('target'));
  target?.classList.add('target');
}
/** Tracks a waiting session or member while carried: snap preview, targets, removal warning. */
function trackSmall(e, key) {
  const space = $('#workspace');
  const within = inside(space, e);
  const target = within ? null : targetAt(e, { pools: true });
  highlight(target);
  document.body.classList.toggle('carrying-up', !within && inside($('#top'), e));
  document.body.classList.toggle('removing', !within && !target && !inside($('#top'), e));
  if (within) showPreview(grid(), local(grid(), e), key);
  else hidePreview();
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

/**
 * Starts a session in the bucket's tool whose first message is the pool (or,
 * with `source`, one session of it). Sending into existing sessions is left
 * out: Codex refuses a session open in its app, and the Claude app does not
 * show what another program writes into one of its sessions.
 */
async function injectInto(target, source) {
  const pool = selected();
  const tool = target.dataset.tool;
  const result = await commit(() => api('POST', `/api/pools/${pool.id}/inject`, { tool, source }));
  await loadPools();
  if (result?.status === 'nothing-new') return toast('对方已经有这些内容');
  if (!result) return;
  // The session just written to is the tool's most recent one; show it first at once.
  const listedSessions = state.sessions[tool] || [];
  state.sessions[tool] = [
    { ...result.session, updatedAt: new Date().toISOString() },
    ...listedSessions.filter(s => s.id !== result.session.id),
  ];
  renderTools();
}

/** Puts a session of the selected pool in the middle (fused) or a cell (waiting). */
function placeLocally(session, e) {
  const g = grid();
  const p = local(g, e);
  if (inMiddle(g, p)) {
    session.fused = true;
    session.cell = null;
  } else {
    session.fused = false;
    session.cell = nearestFree(g, p, keyOf(session));
  }
  render();
  return { fused: session.fused, cell: session.cell };
}

function removeLocally(session) {
  const pool = selected();
  pool.sessions = pool.sessions.filter(s => keyOf(s) !== keyOf(session));
  render();
  commit(
    () => api('DELETE', `/api/pools/${pool.id}/sessions/${encodeURIComponent(keyOf(session))}`),
    () => `已移出「${session.title}」`,
  );
}

function moveLocally(session, toId) {
  const from = selected();
  const to = state.pools.find(pool => pool.id === toId);
  from.sessions = from.sessions.filter(s => keyOf(s) !== keyOf(session));
  to.sessions.push({ ...session, fused: false, cell: null });
  render();
  commit(
    () => api('POST', `/api/pools/${from.id}/move`, { key: keyOf(session), to: toId }),
    () => `已把「${session.title}」移到「${to.name}」`,
  ).then(loadPools);
}

/** What happens when a waiting session or a member is let go outside its own spot. */
function dropSmall(session, e) {
  const target = targetAt(e, { pools: true });
  if (target?.matches('.pool-item')) return moveLocally(session, target.dataset.id);
  if (target) return injectInto(target, keyOf(session));
  if (inside($('#top'), e)) return render(); // let go above but not on a target: back it goes
  return removeLocally(session);
}

// A session row dragged down into the workspace joins the selected pool.
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
      if (within) showPreview(grid(), local(grid(), e), keyOf(item));
      else hidePreview();
    },
    end: async e => {
      ghost.hidden = true;
      if (!inside($('#workspace'), e)) return;
      let pool = selected();
      if (pool?.sessions.some(s => keyOf(s) === keyOf(item))) return toast('这段会话已经在池子里');
      if (!pool) {
        // A new pool appears at once; the server confirms it.
        pool = { id: `local-${Date.now()}`, name: item.title, sessions: [], deliveries: [] };
        state.pools.unshift(pool);
        state.selectedId = pool.id;
      }
      const session = { ...item, messages: null };
      pool.sessions.push(session);
      const place = placeLocally(session, e);
      await commit(async () => {
        if (pool.id.startsWith('local-')) {
          const created = await api('POST', '/api/pools', { name: pool.name });
          pool.id = created.id;
          state.selectedId = created.id;
          store.set('gft-merge:selected', created.id);
        }
        return api('POST', `/api/pools/${pool.id}/sessions`, { ...item, ...place });
      });
      await loadPools();
    },
  });
});

function carryWaiting(event, session, node) {
  event.stopPropagation();
  const before = { fused: session.fused, cell: session.cell };
  drag(event, {
    start: () => {
      document.body.classList.add('carrying-small');
      node.classList.add('lifted');
    },
    move: e => {
      const p = local(grid(), e);
      Object.assign(node.style, { left: `${p.x}px`, top: `${p.y}px` });
      trackSmall(e, keyOf(session));
    },
    end: e => {
      clearInterval(edgeTimer);
      if (!inside($('#workspace'), e)) return dropSmall(session, e);
      const place = placeLocally(session, e);
      if (place.fused === before.fused && place.cell === before.cell) return;
      commit(
        () =>
          api(
            'PATCH',
            `/api/pools/${selected().id}/sessions/${encodeURIComponent(keyOf(session))}`,
            place,
          ),
        () => (place.fused ? `已融合「${session.title}」` : null),
      );
    },
  });
}

function carryMember(event, session) {
  event.stopPropagation();
  drag(event, {
    start: e => {
      document.body.classList.add('carrying-small');
      showGhost(chip(session));
      moveGhost(e);
    },
    move: e => {
      moveGhost(e);
      trackSmall(e, keyOf(session));
    },
    end: e => {
      clearInterval(edgeTimer);
      ghost.hidden = true;
      if (!inside($('#workspace'), e)) return dropSmall(session, e);
      if (inMiddle(grid(), local(grid(), e))) return;
      const place = placeLocally(session, e);
      commit(
        () =>
          api(
            'PATCH',
            `/api/pools/${selected().id}/sessions/${encodeURIComponent(keyOf(session))}`,
            place,
          ),
        () => `「${session.title}」已拆回待融合，不再随融合内容注入`,
      );
    },
  });
}

/** The fused ball travels up; rows and bucket headers light up under it. */
function carryFused(event, box) {
  event.stopPropagation();
  let target = null;
  drag(event, {
    start: e => {
      document.body.classList.add('carrying-up');
      box.classList.add('lifted');
      showGhost(ball(16));
      moveGhost(e);
    },
    move: e => {
      moveGhost(e);
      target = targetAt(e);
      highlight(target);
      edgePan(e);
    },
    end: () => {
      clearInterval(edgeTimer);
      ghost.hidden = true;
      box.classList.remove('lifted');
      if (target) injectInto(target);
    },
  });
}

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
        el('span', { className: 'meta', textContent: `${pool.sessions.length}` }),
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
        try {
          state.sessions[tool.id] = await api('GET', `/api/sessions?tool=${tool.id}`);
        } catch (error) {
          state.sessions[tool.id] = [];
          toast(`${tool.name}：${error.message}`);
        }
      }),
  );
  if (!state.dragging) renderTools();
}

const initial = await api('GET', '/api/state');
state.tools = initial.tools;
state.enabled = initial.settings.tools;
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
