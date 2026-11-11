'use strict';

// ------------------------------------------------------------ constants
const ROW_H = 32;
const LANE_W = 14;          // preferred lane width
const MIN_LANE_W = 7;       // lanes compress down to this before being clipped
const GRAPH_MAX_W = 220;    // the graph column never grows past this
const DOT_R = 4;
const MAX_ROW_REFS = 2;     // ref pills shown per row before collapsing into "+N"
const WORKTREE = 'WORKTREE';
const COLORS = ['#6366f1', '#f59e0b', '#10b981', '#f43f5e', '#06b6d4',
                '#a855f7', '#84cc16', '#ec4899', '#0ea5e9', '#f97316'];
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

// Settings live in ~/.config/ggit/prefs.json (the server inlines them into the page).
const prefs = window.GGIT_PREFS || {};
function setPref(key, value) {
  prefs[key] = value;
  fetch('/api/prefs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: value }),
  }).catch(() => {});
}

// Present when running inside the desktop window (GTK + WebKit).
const native = window.webkit?.messageHandlers?.ggit;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  repo: null,
  refs: [],
  refsByHash: new Map(),
  commits: [],
  index: new Map(),         // hash -> row index
  children: new Map(),      // hash -> [child hashes]
  branchSets: new Map(),    // ref.full -> Set of commit hashes in that branch's lineage
  activeLineage: new Set(), // commit hashes connected to currently selected commit
  hoveredRef: null,         // ref.full currently hovered in sidebar
  graphLanes: 1,
  selected: null,           // hash
  scope: prefs.scope || 'all',
  limit: 5000,
  truncated: false,
  search: '',
  matches: [],
  matchSet: new Set(),
  matchPos: -1,
  fingerprint: null,
  detailToken: 0,
  introStart: -1e9,        // when the graph "draw-in" animation started
  popAt: -1e9,             // when the selected dot last popped
  pending: 0,              // in-flight API requests (drives the progress bar)
};

// ------------------------------------------------------------ helpers
async function api(path) {
  state.pending++;
  const timer = setTimeout(() => $('#progress').classList.toggle('on', state.pending > 0), 150);
  try {
    const r = await fetch(path);
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || r.statusText);
    return j;
  } finally {
    clearTimeout(timer);
    if (--state.pending === 0) $('#progress').classList.remove('on');
  }
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 1800);
}

function hashHue(str) {
  let h = 0;
  for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return Math.abs(h) % 360;
}

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function avatar(name, email) {
  return `<span class="avatar" style="--h:${hashHue(email || name)}">${esc(initials(name))}</span>`;
}

function relTime(ts) {
  const s = Date.now() / 1000 - ts;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800],
                 ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [u, n] of units) {
    if (Math.abs(s) >= n) {
      const v = Math.floor(s / n);
      return `${v} ${u}${v === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const absTime = (ts) => dateFmt.format(new Date(ts * 1000));
const short = (h) => h.slice(0, 7);

// ------------------------------------------------------------ data loading
async function loadAll({ keepScroll = false } = {}) {
  const list = $('#list');
  const scrollTop = list.scrollTop;
  $('#refresh').classList.add('spin');
  try {
    const [repo, refs] = await Promise.all([api('/api/repo'), api('/api/refs')]);
    state.repo = repo;
    state.refs = refs;
    buildScopeSelect();
    const log = await api(`/api/log?scope=${encodeURIComponent(state.scope)}&limit=${state.limit}`);
    let commits = log.commits;
    state.truncated = log.truncated;

    // Show uncommitted changes as a pseudo-commit on top of HEAD.
    if (repo.head && scopeIncludesHead()) {
      const status = await api('/api/status');
      if (status.length) {
        commits = [{
          hash: WORKTREE, parents: [repo.head], author: 'You', email: '',
          time: Date.now() / 1000,
          subject: `Uncommitted changes (${status.length} file${status.length === 1 ? '' : 's'})`,
        }, ...commits];
      }
    }
    state.commits = commits;

    if (!keepScroll) state.introStart = performance.now();
    indexCommits();
    layoutGraph();
    buildRefMap();
    computeBranchSets();
    updateActiveLineage();
    renderHeader();
    renderSidebar();
    applySearch(false);
    renderList(true);
    renderFoot();

    if (keepScroll) list.scrollTop = scrollTop;
    if (state.selected && state.index.has(state.selected)) {
      selectCommit(state.selected, { scroll: !keepScroll });
    } else {
      const start = state.index.has(WORKTREE) ? WORKTREE : state.repo.head;
      if (start && state.index.has(start)) selectCommit(start, { scroll: true });
      else if (state.commits.length) selectCommit(state.commits[0].hash, { scroll: true });
      else $('#details').innerHTML = '<div class="empty">This repository has no commits yet.</div>';
    }
    state.fingerprint = (await api('/api/fingerprint')).fingerprint;
  } catch (e) {
    $('#details').innerHTML = `<div class="error">${esc(e.message)}</div>`;
  } finally {
    $('#refresh').classList.remove('spin');
  }
}

function scopeIncludesHead() {
  if (state.scope === 'all' || state.scope === 'head') return true;
  return state.repo.branch && state.scope === `refs/heads/${state.repo.branch}`;
}

function indexCommits() {
  state.index = new Map();
  state.children = new Map();
  state.commits.forEach((c, i) => state.index.set(c.hash, i));
  for (const c of state.commits) {
    for (const p of c.parents) {
      if (!state.children.has(p)) state.children.set(p, []);
      state.children.get(p).push(c.hash);
    }
  }
}

// Compute first-parent + branch ancestry sets so hovering a branch animates its path.
function computeBranchSets() {
  state.branchSets = new Map();
  for (const r of state.refs) {
    const set = new Set();
    let cur = r.hash;
    let steps = 0;
    while (cur && state.index.has(cur) && steps < 400) {
      set.add(cur);
      const c = state.commits[state.index.get(cur)];
      cur = c && c.parents[0];
      steps++;
    }
    state.branchSets.set(r.full, set);
    const ci = state.index.get(r.hash);
    r.color = ci !== undefined ? state.commits[ci].color : COLORS[0];
  }
}

// Compute the lineage path passing through `state.selected` (its parents & children chain).
function updateActiveLineage() {
  const set = new Set();
  const sel = state.selected;
  if (sel && state.index.has(sel)) {
    set.add(sel);
    const c = state.commits[state.index.get(sel)];
    // Include immediate parents & first-parent chain (up to 25 commits) + immediate children
    if (c) {
      for (const p of c.parents) set.add(p);
      let cur = c.parents[0];
      let depth = 0;
      while (cur && state.index.has(cur) && depth < 18) {
        set.add(cur);
        const pc = state.commits[state.index.get(cur)];
        cur = pc && pc.parents[0];
        depth++;
      }
    }
    for (const kid of state.children.get(sel) || []) set.add(kid);
  }
  state.activeLineage = set;
}

// ------------------------------------------------------------ graph layout
// Assigns every commit a lane (column) and computes the line segments to
// draw in its row. Each segment is [fromLane, fromY, toLane, toY, color, targetHash]
// where Y is 0 (row top), 0.5 (dot) or 1 (row bottom).
function layoutGraph() {
  let lanes = [];       // lane -> hash of the commit this lane is waiting for
  let laneColor = [];
  let nextColor = 0;
  let maxLanes = 1;
  const free = () => { const i = lanes.indexOf(null); return i === -1 ? lanes.length : i; };

  for (const c of state.commits) {
    const before = lanes.slice();
    const beforeColor = laneColor.slice();
    const segs = [];

    let col = lanes.indexOf(c.hash);
    const isTip = col === -1;
    if (isTip) { col = free(); lanes[col] = c.hash; laneColor[col] = nextColor++; }
    const color = laneColor[col];

    // Lines coming in from children above (several if branches converge here).
    before.forEach((h, j) => {
      if (h === c.hash) segs.push([j, 0, col, 0.5, beforeColor[j], c.hash]);
    });
    lanes.forEach((h, j) => { if (j !== col && h === c.hash) lanes[j] = null; });

    // Lines going out to parents below.
    const ps = c.parents;
    if (!ps.length) {
      lanes[col] = null;
    } else {
      const existing = lanes.indexOf(ps[0]);
      if (existing !== -1 && existing !== col) {
        lanes[col] = null;
        segs.push([col, 0.5, existing, 1, laneColor[existing], ps[0]]);
      } else {
        lanes[col] = ps[0];
        segs.push([col, 0.5, col, 1, color, ps[0]]);
      }
      for (let i = 1; i < ps.length; i++) {
        let k = lanes.indexOf(ps[i]);
        if (k === -1) { k = free(); lanes[k] = ps[i]; laneColor[k] = nextColor++; }
        segs.push([col, 0.5, k, 1, laneColor[k], ps[i]]);
      }
    }

    // Lanes that just pass through this row.
    before.forEach((h, j) => {
      if (h !== null && h !== undefined && h !== c.hash) {
        segs.push([j, 0, j, 1, beforeColor[j], h]);
      }
    });

    while (lanes.length && lanes[lanes.length - 1] == null) { lanes.pop(); laneColor.pop(); }
    c.col = col;
    c.color = COLORS[color % COLORS.length];
    c.segs = segs.map(([a, b, x, y, k, th]) => [a, b, x, y, COLORS[k % COLORS.length], th]);
    maxLanes = Math.max(maxLanes, before.length, lanes.length, col + 1);
  }
  // Compress lanes to fit GRAPH_MAX_W; anything beyond that is clipped.
  state.laneW = Math.max(MIN_LANE_W, Math.min(LANE_W, Math.floor((GRAPH_MAX_W - 12) / maxLanes)));
  state.graphLanes = Math.min(maxLanes, Math.floor((GRAPH_MAX_W - 12) / state.laneW));
  const w = state.graphLanes * state.laneW + 12;
  document.documentElement.style.setProperty('--graph-w', `${Math.max(w, 56)}px`);
}

const laneX = (l) => 6 + l * state.laneW + state.laneW / 2;

function graphSvg(c, now, traceSet) {
  const w = state.graphLanes * state.laneW + 12;
  const r = Math.min(DOT_R, state.laneW * 0.36);
  const wt = c.hash === WORKTREE;
  // Negative delays keep looping animations in phase when rows are re-rendered on scroll.
  const phase = `--t:-${Math.round(now % 2400)}ms`;
  const flowPhase = `--f:-${Math.round(now % 900)}ms`;
  let s = `<svg width="${w}" height="${ROW_H}">`;
  for (const [a, ay, b, by, color, targetHash] of c.segs) {
    if (a >= state.graphLanes && b >= state.graphLanes) continue;
    const x1 = laneX(a), y1 = ay * ROW_H, x2 = laneX(b), y2 = by * ROW_H;
    // Lines that merely pass through this row recede so the commit's own lane stands out.
    const passing = a === b && a !== c.col;
    const attrs = wt ? 'stroke-dasharray="3 3"' : `class="g-line${passing ? ' pass' : ''}" pathLength="1"`;
    const d = x1 === x2 ? `M${x1} ${y1} L${x2} ${y2}`
      : `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
    s += `<path d="${d}" stroke="${color}" stroke-width="1.6" fill="none" stroke-linecap="round" ${attrs}/>`;

    // Render animated flow particles along traced branch or active commit lineage
    const segActive = !wt && traceSet && (traceSet.has(c.hash) && traceSet.has(targetHash));
    if (segActive && !reduceMotion) {
      s += `<path class="g-line-flow" d="${d}" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round" style="${flowPhase}"/>`;
    }
  }
  const cx = laneX(Math.min(c.col, state.graphLanes - 1)), cy = ROW_H / 2;
  if (wt) {
    s += `<circle class="g-ants" cx="${cx}" cy="${cy}" r="${r}" style="fill:var(--bg);stroke:var(--dim);${phase}" stroke-width="2" stroke-dasharray="3 2"/>`;
    return s + '</svg>';
  }
  if (c.hash === state.repo.head) {
    s += `<circle class="g-halo" cx="${cx}" cy="${cy}" r="${r + 3.5}" fill="${c.color}" style="${phase}"/>`;
  }
  const sinceSel = now - state.popAt;
  const pop = c.hash === state.selected && sinceSel < 400 ? ` pop" style="--p:-${Math.round(sinceSel)}ms` : '';
  if (c.parents.length > 1) {
    s += `<circle class="g-dot${pop}" cx="${cx}" cy="${cy}" r="${r}" style="fill:var(--bg)" stroke="${c.color}" stroke-width="2.5"/>`;
  } else {
    s += `<circle class="g-dot${pop}" cx="${cx}" cy="${cy}" r="${r}" fill="${c.color}" style="stroke:var(--bg)" stroke-width="1.5"/>`;
  }
  return s + '</svg>';
}

// ------------------------------------------------------------ refs
function buildRefMap() {
  const map = new Map();
  const byFull = new Map(state.refs.map((r) => [r.full, r]));
  const hidden = new Set();
  for (const r of state.refs) {
    r.synced = false;
    if (r.kind === 'branch' && r.upstream) {
      const up = byFull.get(`refs/remotes/${r.upstream}`);
      if (up && up.hash === r.hash) { r.synced = true; hidden.add(up.full); }
    }
  }
  for (const r of state.refs) {
    if (hidden.has(r.full)) continue;
    if (!map.has(r.hash)) map.set(r.hash, []);
    map.get(r.hash).push(r);
  }
  const order = { branch: 0, remote: 1, tag: 2 };
  for (const list of map.values()) {
    list.sort((a, b) => (isCurrent(b) - isCurrent(a)) || (order[a.kind] - order[b.kind]) || a.name.localeCompare(b.name));
  }
  state.refsByHash = map;
}

const isCurrent = (r) => r.kind === 'branch' && state.repo && r.name === state.repo.branch;

function refPill(r) {
  const ci = r.hash ? state.index.get(r.hash) : undefined;
  const laneColor = r.color || (ci !== undefined ? state.commits[ci].color : '');
  const style = laneColor ? ` style="--rc:${laneColor}"` : '';
  if (r.kind === 'branch') {
    const cur = isCurrent(r);
    const tip = cur ? 'The branch you are on (HEAD)' : 'Local branch';
    const sync = r.synced ? ' <i class="ico ico-cloud"></i>' : '';
    const syncTip = r.synced ? ` — same as ${r.upstream}` : '';
    return `<span class="ref ref-branch${cur ? ' ref-current' : ''}"${style} title="${esc(tip + syncTip)}"><span class="ref-name">${esc(r.name)}</span>${sync}</span>`;
  }
  if (r.kind === 'remote') {
    return `<span class="ref ref-remote" title="Remote branch: where '${esc(r.name)}' was on the server at your last fetch"><i class="ico ico-cloud"></i><span class="ref-name">${esc(r.name)}</span></span>`;
  }
  return `<span class="ref ref-tag" title="Tag"><i class="ico ico-tag"></i><span class="ref-name">${esc(r.name)}</span></span>`;
}

function refsHtml(hash, max = Infinity) {
  let html = '';
  if (state.repo.detached && hash === state.repo.head) {
    html += '<span class="ref ref-head" title="HEAD is detached: you are viewing this exact commit, not a branch">HEAD (detached)</span>';
  }
  const refs = state.refsByHash.get(hash) || [];
  for (const r of refs.slice(0, max)) html += refPill(r);
  if (refs.length > max) {
    const rest = refs.slice(max).map((r) => r.name).join('\n');
    html += `<span class="ref ref-more" title="${esc(rest)}">+${refs.length - max}</span>`;
  }
  return html;
}

// ------------------------------------------------------------ header & sidebar
function renderHeader() {
  const r = state.repo;
  $('#repo-name').textContent = r.name;
  $('#repo-name').title = r.path;
  document.title = `${r.name} — ggit`;
  const pill = $('#head-pill');
  if (!r.head) pill.innerHTML = 'No commits yet';
  else if (r.detached) pill.innerHTML = `Detached at <b>${short(r.head)}</b>`;
  else pill.innerHTML = `You're on <b>${esc(r.branch)}</b>`;
  const sp = $('#state-pill');
  sp.classList.toggle('hidden', !r.state);
  if (r.state) sp.textContent = `⚠ ${r.state} in progress`;
}

function buildScopeSelect() {
  const sel = $('#scope');
  const r = state.repo;
  const valid = new Set(['all', 'head', ...state.refs.map((x) => x.full)]);
  if (!valid.has(state.scope)) state.scope = 'all';
  const opt = (v, label) => `<option value="${esc(v)}"${v === state.scope ? ' selected' : ''}>${esc(label)}</option>`;
  let html = opt('all', 'All branches') + opt('head', r.branch ? `Only current branch (${r.branch})` : 'Only HEAD');
  const groups = [['branch', 'Local branches'], ['remote', 'Remote branches'], ['tag', 'Tags']];
  for (const [kind, label] of groups) {
    const items = state.refs.filter((x) => x.kind === kind);
    if (!items.length) continue;
    html += `<optgroup label="${label}">${items.map((x) => opt(x.full, `Only ${x.name}`)).join('')}</optgroup>`;
  }
  sel.innerHTML = html;
}

function renderSidebar() {
  const filter = $('#ref-filter').value.trim().toLowerCase();
  const groups = [
    ['branch', 'Branches', 'branch'],
    ['remote', 'Remote', 'cloud'],
    ['tag', 'Tags', 'tag'],
  ];
  let html = '';
  for (const [kind, title, icon] of groups) {
    const items = state.refs.filter((r) => r.kind === kind && r.name.toLowerCase().includes(filter));
    items.sort((a, b) => (isCurrent(b) - isCurrent(a)) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (kind === 'tag') items.reverse();
    if (!items.length) continue;
    html += `<div class="ref-group"><h4><span>${title}</span><span>${items.length}</span></h4>`;
    for (const r of items) {
      const cur = isCurrent(r);
      const loaded = state.index.has(r.hash);
      const laneColor = r.color || 'var(--accent)';
      let extra = '';
      if (r.kind === 'branch' && r.upstream) {
        if (r.gone) extra = '<span class="ab" title="Its remote branch was deleted">gone</span>';
        else if (r.ahead || r.behind) {
          extra = `<span class="ab" title="${r.ahead} commit(s) not pushed, ${r.behind} not pulled (vs ${esc(r.upstream)})">` +
            `${r.ahead ? `<span class="ahead">↑${r.ahead}</span>` : ''}${r.behind ? `<span class="behind">↓${r.behind}</span>` : ''}</span>`;
        } else extra = `<span class="ab" title="In sync with ${esc(r.upstream)}">✓</span>`;
      }
      const tip = loaded ? `Click to jump to ${r.name} · Hover to animate branch path` : `${r.name} is not in the current view`;
      const swatch = kind === 'tag'
        ? `<span class="icon"><i class="ico ico-${icon}"></i></span>`
        : `<span class="lane-swatch"></span>`;
      html += `<div class="ref-item${cur ? ' current' : ''}${loaded ? '' : ' missing'}" style="--lane-c:${laneColor}" data-hash="${r.hash}" data-ref="${esc(r.full)}" title="${esc(tip)}">` +
        `${swatch}<span class="name">${esc(r.name)}</span>${extra}</div>`;
    }
    html += '</div>';
  }
  $('#ref-groups').innerHTML = html || '<div class="empty">No branches or tags</div>';
}

function renderFoot() {
  const n = state.commits.filter((c) => c.hash !== WORKTREE).length;
  const branchCount = state.refs.filter((r) => r.kind === 'branch').length;
  let html = `<span><b>${n.toLocaleString()}</b> commits</span><span>·</span><span><b>${branchCount}</b> local branch${branchCount === 1 ? '' : 'es'}</span>`;
  if (state.truncated) {
    html += `<span>— showing the newest ${n.toLocaleString()} only</span><button class="btn" id="load-more">Load more</button>`;
  }
  $('#list-foot').innerHTML = html;
  const more = $('#load-more');
  if (more) more.onclick = () => { state.limit *= 4; loadAll({ keepScroll: true }); };
}

// ------------------------------------------------------------ list (virtualised)
let renderQueued = false;
function renderList(resize = false) {
  const list = $('#list');
  if (resize) $('#spacer').style.height = `${state.commits.length * ROW_H}px`;
  const top = list.scrollTop;
  const start = Math.max(0, Math.floor(top / ROW_H) - 10);
  const end = Math.min(state.commits.length, Math.ceil((top + list.clientHeight) / ROW_H) + 10);
  const rows = $('#rows');
  rows.style.transform = `translateY(${start * ROW_H}px)`;
  const searching = state.search.length > 0;
  const hoveredSet = state.hoveredRef ? state.branchSets.get(state.hoveredRef) : null;
  const traceSet = hoveredSet || state.activeLineage;
  const now = performance.now();
  const sinceIntro = now - state.introStart;
  const firstVisible = Math.floor(top / ROW_H);
  let html = '';
  for (let i = start; i < end; i++) {
    const c = state.commits[i];
    const cls = ['row'];
    let styleVars = `--row-c:${c.color || 'var(--accent)'};`;
    if (!reduceMotion && sinceIntro < 1600) {
      const k = Math.max(0, i - firstVisible);
      if (k < 40) { cls.push('intro'); styleVars += `--d:${Math.round(k * 22 - sinceIntro)}ms;`; }
    }
    if (c.hash === state.selected) cls.push('sel');
    if (c.hash === state.repo.head) cls.push('head');
    if (c.hash === WORKTREE) cls.push('worktree');
    if (searching) cls.push(state.matchSet.has(i) ? 'match' : 'dim');
    else if (hoveredSet) {
      cls.push(hoveredSet.has(c.hash) ? 'branch-hi' : 'branch-dim');
    }
    html += `<div class="${cls.join(' ')}" data-i="${i}" style="${styleVars}">` +
      `<div class="graph">${graphSvg(c, now, traceSet)}</div>` +
      `<div class="msg">${c.hash === WORKTREE ? '' : `<span class="refs">${refsHtml(c.hash, MAX_ROW_REFS)}</span>`}<span class="subject" title="${esc(c.subject)}">${highlight(c.subject)}</span></div>` +
      `<div class="author" title="${esc(c.author)} <${esc(c.email)}>">${avatar(c.author, c.email)}<span>${highlight(c.author)}</span></div>` +
      `<div class="date" title="${absTime(c.time)}">${relTime(c.time)}</div>` +
      '</div>';
  }
  rows.innerHTML = html;
  placeSelection();
}

// The selection highlight is one element that glides from row to row.
function placeSelection() {
  const ind = $('#sel-ind');
  const i = state.index.get(state.selected);
  if (i === undefined) { ind.classList.remove('on'); return; }
  const c = state.commits[i];
  if (c && c.color) ind.style.setProperty('--sel-color', c.color);
  const first = !ind.classList.contains('on');
  if (first) ind.classList.add('instant');
  ind.style.transform = `translateY(${i * ROW_H}px)`;
  ind.classList.add('on');
  if (first) { void ind.offsetWidth; ind.classList.remove('instant'); }
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderList(); });
}

function scrollToRow(i) {
  const list = $('#list');
  const y = i * ROW_H;
  if (y < list.scrollTop + ROW_H) list.scrollTop = Math.max(0, y - list.clientHeight / 3);
  else if (y > list.scrollTop + list.clientHeight - 2 * ROW_H) list.scrollTop = y - list.clientHeight / 3;
}

// ------------------------------------------------------------ search
function highlight(text) {
  const q = state.search;
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i === -1) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

function applySearch(jump = true) {
  const q = state.search.toLowerCase();
  state.matches = [];
  if (q) {
    state.commits.forEach((c, i) => {
      if (c.subject.toLowerCase().includes(q) || c.author.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) || c.hash.startsWith(q)) state.matches.push(i);
    });
  }
  state.matchSet = new Set(state.matches);
  state.matchPos = -1;
  updateSearchCount();
  if (jump && state.matches.length) gotoMatch(1);
  renderList();
}

function updateSearchCount() {
  const el = $('#search-count');
  if (!state.search) { el.textContent = ''; return; }
  if (!state.matches.length) { el.textContent = 'no match'; return; }
  el.textContent = `${state.matchPos + 1 || '–'} / ${state.matches.length}`;
}

function gotoMatch(dir) {
  if (!state.matches.length) return;
  const cur = state.index.get(state.selected) ?? -1;
  let pos;
  if (dir > 0) {
    pos = state.matches.findIndex((i) => i > cur);
    if (pos === -1) pos = 0;
  } else {
    pos = -1;
    for (let k = state.matches.length - 1; k >= 0; k--) if (state.matches[k] < cur) { pos = k; break; }
    if (pos === -1) pos = state.matches.length - 1;
  }
  state.matchPos = pos;
  updateSearchCount();
  selectCommit(state.commits[state.matches[pos]].hash, { scroll: true });
}

// ------------------------------------------------------------ selection & details
function selectCommit(hash, { scroll = false } = {}) {
  const i = state.index.get(hash);
  if (i === undefined) { toast('That commit is not in the current view'); return; }
  if (state.selected !== hash) state.popAt = performance.now();
  state.selected = hash;
  updateActiveLineage();
  history.replaceState(null, '', hash === WORKTREE ? '#' : `#${hash}`);
  if (scroll) scrollToRow(i);
  renderList();
  loadDetails(state.commits[i]);
}

function moveSelection(delta) {
  const cur = state.index.get(state.selected) ?? -1;
  const next = Math.max(0, Math.min(state.commits.length - 1, cur + delta));
  if (state.commits[next]) selectCommit(state.commits[next].hash, { scroll: true });
}

async function loadDetails(c) {
  const token = ++state.detailToken;
  const det = $('#details');
  det.style.setProperty('--commit-c', c.color || 'var(--accent)');
  // Only show a skeleton if loading is slow enough to notice.
  const skel = setTimeout(() => {
    if (token === state.detailToken) det.innerHTML = '<div class="skeleton"><div></div><div></div><div></div><div></div></div>';
  }, 180);
  try {
    if (c.hash === WORKTREE) {
      const wt = await api('/api/worktree');
      if (token !== state.detailToken) return;
      det.innerHTML = `<div class="view">${renderWorktree(wt)}</div>`;
      wireDiffs(det, wt.patch, wt.files);
    } else {
      const d = await api(`/api/commit/${c.hash}`);
      if (token !== state.detailToken) return;
      det.innerHTML = `<div class="view">${renderCommit(d)}</div>`;
      wireDiffs(det, d.patch, d.files);
    }
    det.scrollTop = 0;
  } catch (e) {
    if (token === state.detailToken) det.innerHTML = `<div class="error">${esc(e.message)}</div>`;
  } finally {
    clearTimeout(skel);
  }
}

function commitLink(h) {
  const i = state.index.get(h);
  const subj = i !== undefined ? state.commits[i].subject : '';
  return `<span class="link hash" data-goto="${h}" title="${esc(subj)}">${short(h)}</span>` +
    (subj ? ` <span style="color:var(--faint)">${esc(subj.length > 60 ? subj.slice(0, 57) + '…' : subj)}</span>` : '');
}

function summarize(files) {
  let a = 0, d = 0;
  for (const f of files) { a += f.added; d += f.deleted; }
  return { a, d, n: files.length };
}

function renderCommit(d) {
  const [subject, ...rest] = d.message.split('\n');
  const body = rest.join('\n').trim();
  const s = summarize(d.files);
  const kids = (state.children.get(d.hash) || []).filter((h) => h !== WORKTREE);

  let explain;
  if (!d.parents.length) {
    explain = `<b>This is the very first commit</b> in this history — everything here was added from scratch.`;
  } else if (d.parents.length > 1) {
    explain = `<b>This is a merge commit.</b> It joins ${d.parents.length} lines of work together. ` +
      `The changes below are what the merge brought in, compared to the first parent ` +
      `(<span class="hash">${short(d.parents[0])}</span>, the branch that was merged <i>into</i>).`;
  } else {
    explain = `This commit changed <b>${s.n} file${s.n === 1 ? '' : 's'}</b>: ` +
      `<span class="plus">+${s.a}</span> line${s.a === 1 ? '' : 's'} added, ` +
      `<span class="minus">−${s.d}</span> removed.`;
  }
  if (d.hash === state.repo.head) explain += ` <span class="you">HEAD</span> This is the commit you currently have checked out.`;

  const sameCommitter = d.committer === d.author && d.commitTime === d.time;
  return `
    <div class="d-head">
      <div class="d-refs">${refsHtml(d.hash)}</div>
      <h2 class="d-subject">${esc(subject)}</h2>
      ${body ? `<div class="d-body">${esc(body)}</div>` : ''}
      <div class="meta">
        <span class="k">Author</span>
        <span class="who">${avatar(d.author, d.email)} ${esc(d.author)} <span style="color:var(--faint)">&lt;${esc(d.email)}&gt;</span></span>
        <span class="k">Date</span>
        <span>${absTime(d.time)} <span style="color:var(--faint)">(${relTime(d.time)})</span></span>
        ${sameCommitter ? '' : `<span class="k" title="Who applied the commit (differs after rebase, cherry-pick or patches)">Committed by</span>
        <span>${esc(d.committer)} · ${absTime(d.commitTime)}</span>`}
        <span class="k">Commit</span>
        <span><span class="hash">${d.hash}</span><span class="copy" data-copy="${d.hash}" title="Copy full hash">Copy</span></span>
        <span class="k" title="The commit(s) this one was built on">${d.parents.length > 1 ? 'Parents' : 'Parent'}</span>
        <span>${d.parents.length ? d.parents.map(commitLink).join('<br>') : '<span style="color:var(--faint)">none</span>'}</span>
        ${kids.length ? `<span class="k" title="Commits built on top of this one">${kids.length > 1 ? 'Children' : 'Child'}</span>
        <span>${kids.map(commitLink).join('<br>')}</span>` : ''}
        <span class="k">Found in</span>
        <span id="contains"><span class="link" data-contains="${d.hash}">Show which branches & tags contain this commit</span></span>
      </div>
    </div>
    <div class="explain">${explain}</div>
    ${d.truncated ? '<div class="warn">This diff is very large; only the first part is shown.</div>' : ''}
    ${renderFileList(d.files)}
    <div class="diffs" id="diffs"></div>`;
}

function renderWorktree(wt) {
  const staged = wt.status.filter((e) => e.x !== ' ' && e.x !== '?');
  const unstaged = wt.status.filter((e) => e.y !== ' ' && e.y !== '?');
  const untracked = wt.status.filter((e) => e.x === '?');
  const statusByPath = new Map(wt.status.map((e) => [e.path, e]));
  for (const f of wt.files) {
    const e = statusByPath.get(f.path);
    if (!e) continue;
    const tags = [];
    if (e.x !== ' ' && e.x !== '?') tags.push('staged');
    if (e.y !== ' ' && e.y !== '?') tags.push('not staged');
    f.tagline = tags.join(' + ');
  }
  const files = wt.files.concat(untracked.map((e) => ({
    status: '?', path: e.path, added: 0, deleted: 0, binary: false, tagline: 'new, not tracked yet',
  })));
  const s = summarize(wt.files);
  return `
    <div class="d-head">
      <h2 class="d-subject">Uncommitted changes</h2>
      <div class="d-sub">Edits in your working folder that are not saved in any commit yet.</div>
    </div>
    <div class="explain">
      Compared with the last commit (<span class="hash">${short(state.repo.head)}</span>):
      <b>${s.n}</b> changed file${s.n === 1 ? '' : 's'} (<span class="plus">+${s.a}</span> <span class="minus">−${s.d}</span>)${untracked.length ? ` and <b>${untracked.length}</b> new untracked file${untracked.length === 1 ? '' : 's'}` : ''}.<br>
      <b>${staged.length}</b> staged (will go into the next <code>git commit</code>) ·
      <b>${unstaged.length}</b> not staged (need <code>git add</code> first) ·
      <b>${untracked.length}</b> untracked (git isn't watching them yet).
    </div>
    ${wt.truncated ? '<div class="warn">This diff is very large; only the first part is shown.</div>' : ''}
    ${renderFileList(files)}
    <div class="diffs" id="diffs"></div>`;
}

const STATUS_WORDS = { A: 'Added', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Conflict', '?': 'Untracked' };

function renderFileList(files) {
  if (!files.length) return '<div class="files"><h3>Files</h3><div style="color:var(--faint)">No file changes.</div></div>';
  const max = Math.max(1, ...files.map((f) => f.added + f.deleted));
  let html = `<div class="files"><h3>Files changed (${files.length})</h3>`;
  for (const f of files) {
    const code = f.status === '?' ? 'Q' : f.status;
    const label = f.status === '?' ? '?' : f.status;
    const tot = f.added + f.deleted;
    const w = Math.max(tot ? 4 : 0, Math.round((tot / max) * 60));
    const path = f.old ? `${f.old} → ${f.path}` : f.path;
    html += `<div class="file-row" data-file="${esc(f.path)}" title="${esc(STATUS_WORDS[f.status] || f.status)}: ${esc(path)}">
      <span class="st st-${code}">${label}</span>
      <span class="path">${esc(path)}${f.tagline ? ` <span class="tagline">· ${esc(f.tagline)}</span>` : ''}</span>
      <span class="nums">${f.binary ? 'binary' : `<span class="plus">+${f.added}</span> <span class="minus">−${f.deleted}</span>`}</span>
      <span class="bar" style="width:${w}px">${tot ? `<span class="a" style="width:${(f.added / tot) * 100}%"></span><span class="d" style="width:${(f.deleted / tot) * 100}%"></span>` : ''}</span>
    </div>`;
  }
  return html + '</div>';
}

// ------------------------------------------------------------ diff rendering
function parseDiff(text) {
  const files = [];
  let cur = null, inHeader = false, o = 0, n = 0;
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const rest = line.slice(11);
      cur = { path: rest.slice(2, (rest.length - 1) / 2), lines: [], binary: false, meta: [] };
      files.push(cur);
      inHeader = true;
      continue;
    }
    if (!cur) continue;
    if (inHeader && !line.startsWith('@@')) {
      // "--- a/x" comes before "+++ b/x"; the latter wins unless the file was deleted.
      if ((line.startsWith('--- ') || line.startsWith('+++ ')) && !line.endsWith(' /dev/null')) {
        cur.path = line.slice(6).replace(/\t$/, '');
      } else if (line.startsWith('rename to ')) cur.path = line.slice(10);
      else if (line.startsWith('Binary files')) cur.binary = true;
      else if (line.startsWith('old mode') || line.startsWith('new mode')) cur.meta.push(line);
      continue;
    }
    inHeader = false;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (m) { o = +m[1]; n = +m[2]; }
      cur.lines.push({ t: 'hunk', text: line });
    } else if (line[0] === '+') cur.lines.push({ t: 'add', n: n++, text: line.slice(1) });
    else if (line[0] === '-') cur.lines.push({ t: 'del', o: o++, text: line.slice(1) });
    else if (line[0] === '\\') cur.lines.push({ t: 'note', text: line.slice(2) });
    else cur.lines.push({ t: 'ctx', o: o++, n: n++, text: line.slice(1) });
  }
  return files;
}

function diffTable(f) {
  if (f.binary) return '<div class="diff-note">Binary file — contents not shown.</div>';
  if (!f.lines.length) {
    return `<div class="diff-note">${f.meta.length ? esc(f.meta.join(' · ')) : 'No content changes (renamed or empty file).'}</div>`;
  }
  const rows = f.lines.map((l) => {
    if (l.t === 'hunk') return `<tr class="hunk"><td colspan="3">${esc(l.text)}</td></tr>`;
    if (l.t === 'note') return `<tr class="note"><td class="n"></td><td class="n"></td><td class="c">${esc(l.text)}</td></tr>`;
    const sign = l.t === 'add' ? '+' : l.t === 'del' ? '-' : ' ';
    return `<tr class="${l.t}"><td class="n">${l.o ?? ''}</td><td class="n">${l.n ?? ''}</td><td class="c">${sign} ${esc(l.text)}</td></tr>`;
  });
  return `<table class="diff">${rows.join('')}</table>`;
}

function wireDiffs(root, patch, files) {
  const parsed = parseDiff(patch);
  const container = root.querySelector('#diffs');
  if (!container || !parsed.length) return;
  const statusByPath = new Map(files.map((f) => [f.path, f]));
  let budget = 4000; // auto-expand diffs until this many lines are shown
  let html = '<h3>Changes</h3>';
  parsed.forEach((f, i) => {
    const info = statusByPath.get(f.path) || {};
    const lines = f.lines.length;
    const open = lines <= budget;
    if (open) budget -= lines;
    const label = info.old ? `${info.old} → ${f.path}` : f.path;
    html += `<div class="diff-file${open ? '' : ' collapsed'}" id="df-${i}" data-path="${esc(f.path)}">
      <div class="diff-file-head" data-toggle="${i}">
        <span class="chev"><svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg></span>
        ${info.status ? `<span class="st st-${info.status}">${info.status}</span>` : ''}
        <span class="path">${esc(label)}</span>
        ${open ? '' : `<span class="tagline">${lines} lines — click to show</span>`}
        ${info.binary ? '' : `<span class="nums"><span class="plus">+${info.added ?? 0}</span> <span class="minus">−${info.deleted ?? 0}</span></span>`}
      </div>
      <div class="diff-body"${open ? ' data-loaded="1"' : ''}>${open ? diffTable(f) : ''}</div>
    </div>`;
  });
  container.innerHTML = html;
  container._parsed = parsed;
}

// ------------------------------------------------------------ events
function wireEvents() {
  const list = $('#list');
  list.addEventListener('scroll', queueRender);
  window.addEventListener('resize', queueRender);

  $('#rows').addEventListener('click', (e) => {
    const row = e.target.closest('.row');
    if (row) { selectCommit(state.commits[+row.dataset.i].hash); list.focus(); }
  });

  // Sidebar branch click & hover branch-path animation
  $('#ref-groups').addEventListener('click', (e) => {
    const item = e.target.closest('.ref-item');
    if (!item) return;
    if (state.index.has(item.dataset.hash)) selectCommit(item.dataset.hash, { scroll: true });
    else toast('Not in the current view — choose "All branches" or load more commits');
  });
  $('#ref-groups').addEventListener('mouseover', (e) => {
    const item = e.target.closest('.ref-item');
    const refFull = item ? item.dataset.ref : null;
    if (refFull !== state.hoveredRef) {
      state.hoveredRef = refFull;
      queueRender();
    }
  });
  $('#ref-groups').addEventListener('mouseleave', () => {
    if (state.hoveredRef) {
      state.hoveredRef = null;
      queueRender();
    }
  });
  $('#ref-filter').addEventListener('input', renderSidebar);

  $('#scope').addEventListener('change', (e) => {
    state.scope = e.target.value;
    setPref('scope', state.scope);
    loadAll();
  });

  const search = $('#search');
  let searchTimer;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    $('.search').classList.toggle('has-query', search.value.length > 0);
    searchTimer = setTimeout(() => { state.search = search.value.trim(); applySearch(); }, 120);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') {
      search.value = ''; state.search = '';
      $('.search').classList.remove('has-query');
      applySearch(); list.focus();
    }
  });
  $('#search-next').onclick = () => gotoMatch(1);
  $('#search-prev').onclick = () => gotoMatch(-1);

  $('#refresh').onclick = () => loadAll({ keepScroll: true });
  $('#head-pill').onclick = () => state.repo.head && selectCommit(state.repo.head, { scroll: true });
  $('#theme').onclick = () => {
    const root = document.documentElement;
    const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
    const apply = () => { root.dataset.theme = next; setPref('theme', next); };
    if (!document.startViewTransition || reduceMotion) return apply();
    // Ripple the new theme outward from the button.
    const b = $('#theme').getBoundingClientRect();
    const x = b.left + b.width / 2, y = b.top + b.height / 2;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.startViewTransition(apply).ready.then(() => root.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
      { duration: 600, easing: 'cubic-bezier(.22,1,.36,1)', pseudoElement: '::view-transition-new(root)' }));
  };
  $('#help-btn').onclick = () => $('#help').classList.remove('hidden');
  $('#help-close').onclick = () => $('#help').classList.add('hidden');
  $('#help').onclick = (e) => { if (e.target.id === 'help') $('#help').classList.add('hidden'); };

  // Details panel: links, copy, contains, file jump, diff toggle.
  $('#details').addEventListener('click', async (e) => {
    const t = e.target;
    const go = t.closest('[data-goto]');
    if (go) return selectCommit(go.dataset.goto, { scroll: true });
    const cp = t.closest('[data-copy]');
    if (cp) {
      await navigator.clipboard.writeText(cp.dataset.copy);
      cp.textContent = 'Copied'; cp.classList.add('done');
      setTimeout(() => { cp.textContent = 'Copy'; cp.classList.remove('done'); }, 1400);
      return;
    }
    const ct = t.closest('[data-contains]');
    if (ct) return showContains(ct.dataset.contains);
    const fr = t.closest('.file-row');
    if (fr) {
      const el = [...document.querySelectorAll('.diff-file')].find((d) => d.dataset.path === fr.dataset.file);
      if (el) { if (el.classList.contains('collapsed')) toggleDiff(el); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
      else toast('No diff to show for this file');
      return;
    }
    const tg = t.closest('[data-toggle]');
    if (tg) toggleDiff(tg.parentElement);
  });

  if (native) {
    const brand = $('.brand');
    brand.classList.add('can-open');
    brand.title = 'Open another repository (Ctrl+O)';
    brand.onclick = () => native.postMessage('open');
  }

  // Keyboard shortcuts.
  document.addEventListener('keydown', (e) => {
    if (native && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      native.postMessage('open');
      return;
    }
    const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName);
    if (e.key === 'Escape') {
      $('#help').classList.add('hidden');
      if (state.hoveredRef) { state.hoveredRef = null; queueRender(); }
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'j') { e.preventDefault(); moveSelection(1); }
    else if (k === 'ArrowUp' || k === 'k') { e.preventDefault(); moveSelection(-1); }
    else if (k === 'PageDown') { e.preventDefault(); moveSelection(Math.floor(list.clientHeight / ROW_H)); }
    else if (k === 'PageUp') { e.preventDefault(); moveSelection(-Math.floor(list.clientHeight / ROW_H)); }
    else if (k === 'Home') { e.preventDefault(); moveSelection(-Infinity); }
    else if (k === 'End') { e.preventDefault(); moveSelection(Infinity); }
    else if (k === '/') { e.preventDefault(); $('#search').focus(); $('#search').select(); }
    else if (k === 'n') gotoMatch(1);
    else if (k === 'N') gotoMatch(-1);
    else if (k === 'p') {
      const c = state.commits[state.index.get(state.selected)];
      if (c && c.parents[0]) selectCommit(c.parents[0], { scroll: true });
    } else if (k === 'h' && state.repo.head) selectCommit(state.repo.head, { scroll: true });
    else if (k === 'r') loadAll({ keepScroll: true });
    else if (k === '?') $('#help').classList.remove('hidden');
  });

  // Resizable details panel.
  const splitter = $('#splitter');
  const details = $('#details');
  const saved = prefs.detailsW;
  if (saved) details.style.width = saved;
  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    splitter.classList.add('drag');
    const move = (ev) => {
      const w = Math.max(320, Math.min(window.innerWidth - 400, window.innerWidth - ev.clientX));
      details.style.width = `${w}px`;
      queueRender();
    };
    const up = () => {
      splitter.classList.remove('drag');
      setPref('detailsW', details.style.width);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // Auto-refresh when you come back to the tab and something changed.
  const check = async () => {
    try {
      const { fingerprint } = await api('/api/fingerprint');
      if (state.fingerprint && fingerprint !== state.fingerprint) {
        await loadAll({ keepScroll: true });
        toast('Repository changed — refreshed');
      }
    } catch (_) { /* server may be gone */ }
  };
  window.addEventListener('focus', check);
  setInterval(() => { if (document.visibilityState === 'visible') check(); }, 5000);
}

function toggleDiff(el) {
  const i = +el.id.slice(3);
  const parsed = $('#diffs')._parsed;
  const body = el.querySelector('.diff-body');
  const collapsed = el.classList.toggle('collapsed');
  if (!collapsed && !body.dataset.loaded) { body.innerHTML = diffTable(parsed[i]); body.dataset.loaded = '1'; }
}

async function showContains(hash) {
  const el = $('#contains');
  el.textContent = 'Looking…';
  try {
    const r = await api(`/api/contains/${hash}`);
    const pills = [
      ...r.branches.map((n) => refPill({ kind: 'branch', name: n })),
      ...r.remotes.map((n) => refPill({ kind: 'remote', name: n })),
      ...r.tags.map((n) => refPill({ kind: 'tag', name: n })),
    ];
    el.innerHTML = pills.length
      ? `<div class="contains">${pills.join('')}</div>`
      : '<span style="color:var(--faint)">Not on any branch or tag (it may be lost if not referenced).</span>';
  } catch (e) {
    el.textContent = e.message;
  }
}

// ------------------------------------------------------------ boot
(function boot() {
  const theme = prefs.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  const fromUrl = location.hash.slice(1);
  if (/^[0-9a-f]{40,64}$/i.test(fromUrl)) state.selected = fromUrl;
  wireEvents();
  loadAll();
})();
