'use strict';

// ------------------------------------------------------------ constants
const ROW_H = 32;
const LANE_W = 16;
const DOT_R = 4.5;
const MAX_GRAPH_LANES = 24;
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
  hoveredRef: null,         // ref.full currently hovered in sidebar or topology
  showBranchMap: true,
  bmMode: 'branches',       // 'branches' (multi-branch schematic) | 'timeline' (all commits DAG)
  bmZoom: 1,
  bmExpanded: false,
  demoMode: false,
  demoData: null,
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

// ------------------------------------------------------------ multi-branch demo generator
function buildDemoData() {
  const now = Math.floor(Date.now() / 1000);
  const h = (n) => n.toString(16).padStart(8, '0').repeat(5);
  const raw = [
    // [id, [parents], author, email, minsAgo, subject, body, files]
    [24, [23], 'Avery Chen', 'avery@ggit.dev', 12, 'feat(graph): animate flowing branch pulses along active lanes',
      'Adds SVG dash-offset flow animations and lane-matched branch badges.',
      [['M', 'static/app.js', 84, 12], ['M', 'static/style.css', 52, 8]]],
    [23, [20], 'Avery Chen', 'avery@ggit.dev', 38, 'feat(ui): add interactive Branch Topology Map header',
      'Visualizes active branches, divergence points, and ahead/behind status.',
      [['M', 'static/index.html', 36, 4], ['M', 'static/app.js', 95, 6]]],
    [22, [21, 18], 'Ravi Shah', 'rbshah0029@gmail.com', 55, "Merge branch 'feat/glass-ui' into main",
      'Brings in the redesigned glassmorphic topbar, refined color tokens, and lineage card.',
      [['M', 'static/style.css', 120, 45], ['M', 'static/index.html', 28, 11]]],
    [21, [16, 19], 'Ravi Shah', 'rbshah0029@gmail.com', 95, "Merge branch 'fix/virtual-scroll' into main",
      'Fixes row phase alignment when scrolling rapidly through large commit graphs.',
      [['M', 'static/app.js', 19, 14]]],
    [20, [16], 'Avery Chen', 'avery@ggit.dev', 130, 'feat(graph): trace branch ancestry on sidebar hover',
      'Hovering any branch in the sidebar highlights its commits and dims unrelated lanes.',
      [['M', 'static/app.js', 64, 9], ['M', 'static/style.css', 24, 2]]],
    [19, [14], 'Maya Lin', 'maya@ggit.dev', 175, 'fix(scroll): preserve negative animation delay phase on re-render',
      'Keeps HEAD halo breathing and worktree marching ants smooth during virtual scroll.',
      [['M', 'static/app.js', 18, 11]]],
    [18, [17], 'Elena Rostova', 'elena@ggit.dev', 210, 'style(details): add animated commit lineage & merge diagram',
      'Shows parent -> commit -> child connections with interactive jump nodes.',
      [['M', 'static/app.js', 72, 3], ['M', 'static/style.css', 48, 0]]],
    [17, [13], 'Elena Rostova', 'elena@ggit.dev', 260, 'style(theme): refine dark & light surface tokens with ambient glow',
      'Updates surface contrast and view-transition circular theme ripple.',
      [['M', 'static/style.css', 86, 42], ['M', 'static/icon.svg', 34, 12]]],
    [16, [15, 12], 'Ravi Shah', 'rbshah0029@gmail.com', 320, "Merge branch 'release/v0.2' into main",
      'Sync release packaging updates back into main trunk.',
      [['M', 'packaging/build-deb.sh', 14, 3], ['M', 'README.md', 22, 6]]],
    [15, [13], 'Ravi Shah', 'rbshah0029@gmail.com', 400, 'feat(api): add /api/contains endpoint for branch & tag lookup',
      'Finds all local branches, remote branches, and tags containing a selected commit.',
      [['M', 'ggit.py', 24, 2], ['M', 'static/app.js', 31, 4]]],
    [14, [11], 'Maya Lin', 'maya@ggit.dev', 480, 'perf(list): virtualize commit rows for 50k+ commit repositories',
      'Only renders visible DOM rows plus a 10-row overscan buffer.',
      [['M', 'static/app.js', 58, 27], ['M', 'static/style.css', 16, 8]]],
    [13, [11], 'Ravi Shah', 'rbshah0029@gmail.com', 540, 'feat(desktop): remember window size and maximized state in prefs.json',
      'Persists GTK window geometry and splitter width across sessions.',
      [['M', 'desktop.py', 34, 8], ['M', 'ggit.py', 28, 5]]],
    [12, [10], 'Samir Patel', 'samir@ggit.dev', 620, 'chore(release): bump version to 0.2.0-rc1 and update apt workflow',
      'Prepares Debian package metadata and GitHub Pages APT repository.',
      [['M', 'packaging/build-deb.sh', 18, 4], ['M', '.github/workflows/release.yml', 26, 5]]],
    [11, [9, 8], 'Ravi Shah', 'rbshah0029@gmail.com', 740, "Merge branch 'feat/diff-viewer' into main",
      'Integrates collapsible file diffs, numstat change bars, and rename detection.',
      [['M', 'ggit.py', 52, 10], ['M', 'static/app.js', 112, 18]]],
    [10, [9], 'Samir Patel', 'samir@ggit.dev', 820, 'docs(readme): document one-line installer and keyboard shortcuts',
      'Adds installation options for Debian/Ubuntu and local user installs.',
      [['M', 'README.md', 48, 12], ['A', 'install.sh', 101, 0]]],
    [9, [6], 'Ravi Shah', 'rbshah0029@gmail.com', 960, 'feat(worktree): display uncommitted changes as top pseudo-commit',
      'Shows staged, unstaged, and untracked file counts with plain-English explanation.',
      [['M', 'ggit.py', 38, 4], ['M', 'static/app.js', 46, 7]]],
    [8, [7], 'Elena Rostova', 'elena@ggit.dev', 1100, 'feat(diff): auto-collapse large diffs over 4000 lines budget',
      'Keeps commit switching instant even on huge refactors.',
      [['M', 'static/app.js', 68, 12], ['M', 'static/style.css', 39, 6]]],
    [7, [5], 'Elena Rostova', 'elena@ggit.dev', 1280, 'feat(diff): parse unified diffs with line numbers and hunk headers',
      'Renders side-by-side old/new line numbers and syntax status badges.',
      [['M', 'ggit.py', 45, 6], ['M', 'static/app.js', 88, 0]]],
    [6, [5], 'Ravi Shah', 'rbshah0029@gmail.com', 1500, 'feat(search): instant filter across commit subject, author, and SHA',
      'Dims non-matching rows and supports Enter / Shift+Enter navigation.',
      [['M', 'static/app.js', 54, 8], ['M', 'static/index.html', 18, 2]]],
    [5, [4, 3], 'Ravi Shah', 'rbshah0029@gmail.com', 1850, "Merge branch 'feat/gtk-window' into main",
      'Adds native GTK 3 + WebKit2GTK desktop mode with browser fallback.',
      [['A', 'desktop.py', 210, 0], ['M', 'ggit.py', 42, 8]]],
    [4, [2], 'Ravi Shah', 'rbshah0029@gmail.com', 2200, 'feat(graph): assign topological lanes and cubic-bezier merge curves',
      'Computes lane allocation and SVG path segments for every commit row.',
      [['M', 'static/app.js', 96, 12], ['M', 'static/style.css', 44, 5]]],
    [3, [2], 'Maya Lin', 'maya@ggit.dev', 2400, 'feat(desktop): native GTK3 WebKit2 wrapper with repo folder picker',
      'Supports Ctrl+O repository switching and .desktop launcher installation.',
      [['A', 'desktop.py', 195, 0]]],
    [2, [1], 'Ravi Shah', 'rbshah0029@gmail.com', 2900, 'feat(server): local ThreadingHTTPServer with git log & refs endpoints',
      'Zero external Python dependencies; uses git plumbing commands directly.',
      [['M', 'ggit.py', 180, 12]]],
    [1, [], 'Ravi Shah', 'rbshah0029@gmail.com', 3600, 'Initial commit: ggit — a modern, friendly git history viewer',
      ' bootstrap project structure, static assets, and core git runner.',
      [['A', 'ggit.py', 120, 0], ['A', 'static/index.html', 90, 0], ['A', 'static/style.css', 160, 0], ['A', ' README.md', 35, 0]]],
  ];

  const commits = [];
  const detailsByHash = new Map();
  for (const [id, parents, author, email, minsAgo, subject, body, filesSpec] of raw) {
    const hash = h(id);
    const pHashes = parents.map(h);
    const time = now - minsAgo * 60;
    commits.push({ hash, parents: pHashes, author, email, time, subject });
    const files = filesSpec.map(([status, path, added, deleted]) => ({
      status, path, added, deleted, binary: false,
    }));
    const patch = files.map((f) => [
      `diff --git a/${f.path} b/${f.path}`,
      `--- a/${f.path}`,
      `+++ b/${f.path}`,
      `@@ -1,5 +1,${Math.max(3, Math.min(12, f.added + 3))} @@`,
      ` // ${f.path} — ${subject}`,
      ...(f.deleted ? [`-  const legacyMode = true; // removed in ${short(hash)}`] : []),
      `+  // Updated by ${author} (${short(hash)})`,
      `+  const branchFlowAnimated = true;`,
      `+  renderBranchTopology({ animate: branchFlowAnimated });`,
      `   return state;`,
    ].join('\n')).join('\n');
    detailsByHash.set(hash, {
      hash, parents: pHashes, author, email, time,
      committer: author, committerEmail: email, commitTime: time,
      message: `${subject}\n\n${body}`,
      files, patch, truncated: false,
    });
  }

  const refs = [
    { name: 'main', full: 'refs/heads/main', kind: 'branch', hash: h(22), upstream: 'origin/main', ahead: 2, behind: 0, gone: false },
    { name: 'feat/branch-anim', full: 'refs/heads/feat/branch-anim', kind: 'branch', hash: h(24), upstream: 'origin/feat/branch-anim', ahead: 1, behind: 0, gone: false },
    { name: 'feat/glass-ui', full: 'refs/heads/feat/glass-ui', kind: 'branch', hash: h(18), upstream: 'origin/feat/glass-ui', ahead: 0, behind: 0, gone: false },
    { name: 'fix/virtual-scroll', full: 'refs/heads/fix/virtual-scroll', kind: 'branch', hash: h(19) },
    { name: 'release/v0.2', full: 'refs/heads/release/v0.2', kind: 'branch', hash: h(12), upstream: 'origin/release/v0.2', ahead: 0, behind: 0, gone: false },
    { name: 'origin/main', full: 'refs/remotes/origin/main', kind: 'remote', hash: h(16) },
    { name: 'origin/feat/branch-anim', full: 'refs/remotes/origin/feat/branch-anim', kind: 'remote', hash: h(23) },
    { name: 'origin/feat/glass-ui', full: 'refs/remotes/origin/feat/glass-ui', kind: 'remote', hash: h(18) },
    { name: 'origin/release/v0.2', full: 'refs/remotes/origin/release/v0.2', kind: 'remote', hash: h(12) },
    { name: 'v0.2.0-rc1', full: 'refs/tags/v0.2.0-rc1', kind: 'tag', hash: h(12) },
    { name: 'v0.1.5', full: 'refs/tags/v0.1.5', kind: 'tag', hash: h(11) },
    { name: 'v0.1.0', full: 'refs/tags/v0.1.0', kind: 'tag', hash: h(5) },
  ];

  const worktree = {
    status: [
      { x: 'M', y: ' ', path: 'static/style.css' },
      { x: ' ', y: 'M', path: 'static/app.js' },
    ],
    files: [
      { status: 'M', path: 'static/style.css', added: 28, deleted: 4, binary: false },
      { status: 'M', path: 'static/app.js', added: 42, deleted: 6, binary: false },
    ],
    patch: [
      'diff --git a/static/style.css b/static/style.css',
      '--- a/static/style.css',
      '+++ b/static/style.css',
      '@@ -240,3 +240,6 @@',
      ' .g-line-flow {',
      '+  stroke-dasharray: 4 10;',
      '+  animation: laneFlow .9s linear infinite;',
      ' }',
      'diff --git a/static/app.js b/static/app.js',
      '--- a/static/app.js',
      '+++ b/static/app.js',
      '@@ -180,3 +180,5 @@',
      '+// Live uncommitted worktree preview in Multi-Branch Demo mode',
      '+const demoBranchesReady = true;',
    ].join('\n'),
    truncated: false,
  };

  return {
    repo: {
      path: state.repo?.path || '/demo/ggit',
      name: (state.repo?.name || 'ggit') + ' (demo)',
      head: h(22),
      branch: 'main',
      detached: false,
      state: null,
    },
    refs,
    commits,
    detailsByHash,
    worktree,
  };
}

function toggleDemoMode(force) {
  state.demoMode = typeof force === 'boolean' ? force : !state.demoMode;
  const btn = $('#demo-btn');
  const lbl = $('#demo-btn-label');
  btn.classList.toggle('active', state.demoMode);
  lbl.textContent = state.demoMode ? 'Exit Demo' : 'Demo Branches';
  state.selected = null;
  state.scope = 'all';
  loadAll();
  toast(state.demoMode
    ? 'Multi-Branch Demo active — hover branches or click commits to see branch animations!'
    : 'Returned to live repository');
}

// ------------------------------------------------------------ data loading
async function loadAll({ keepScroll = false } = {}) {
  const list = $('#list');
  const scrollTop = list.scrollTop;
  $('#refresh').classList.add('spin');
  try {
    if (state.demoMode) {
      state.demoData = buildDemoData();
      state.repo = state.demoData.repo;
      state.refs = state.demoData.refs;
      buildScopeSelect();
      let commits = state.demoData.commits.slice();
      if (state.scope !== 'all') {
        const targetHash = state.scope === 'head'
          ? state.repo.head
          : state.refs.find((r) => r.full === state.scope)?.hash;
        if (targetHash) {
          const reachable = computeReachable(targetHash, commits);
          commits = commits.filter((c) => reachable.has(c.hash));
        }
      }
      if (scopeIncludesHead()) {
        commits = [{
          hash: WORKTREE, parents: [state.repo.head], author: 'You', email: '',
          time: Date.now() / 1000,
          subject: 'Uncommitted changes (2 files)',
        }, ...commits];
      }
      state.commits = commits;
      state.truncated = false;
    } else {
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
    }

    if (!keepScroll) state.introStart = performance.now();
    indexCommits();
    layoutGraph();
    buildRefMap();
    computeBranchSets();
    updateActiveLineage();
    renderHeader();
    renderSidebar();
    renderBranchMap();
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
    if (!state.demoMode) {
      state.fingerprint = (await api('/api/fingerprint')).fingerprint;
    }
  } catch (e) {
    $('#details').innerHTML = `<div class="error">${esc(e.message)}</div>`;
  } finally {
    $('#refresh').classList.remove('spin');
  }
}

function computeReachable(startHash, commits) {
  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const seen = new Set();
  const stack = [startHash];
  while (stack.length) {
    const h = stack.pop();
    if (!h || seen.has(h)) continue;
    seen.add(h);
    const c = byHash.get(h);
    if (c) for (const p of c.parents) stack.push(p);
  }
  return seen;
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
  state.graphLanes = Math.min(maxLanes, MAX_GRAPH_LANES);
  const w = state.graphLanes * LANE_W + 12;
  document.documentElement.style.setProperty('--graph-w', `${Math.max(w, 56)}px`);
}

const laneX = (l) => 6 + l * LANE_W + LANE_W / 2;

function graphSvg(c, now, traceSet) {
  const w = state.graphLanes * LANE_W + 12;
  const wt = c.hash === WORKTREE;
  // Negative delays keep looping animations in phase when rows are re-rendered on scroll.
  const phase = `--t:-${Math.round(now % 2400)}ms`;
  const flowPhase = `--f:-${Math.round(now % 900)}ms`;
  let s = `<svg width="${w}" height="${ROW_H}">`;
  for (const [a, ay, b, by, color, targetHash] of c.segs) {
    const x1 = laneX(a), y1 = ay * ROW_H, x2 = laneX(b), y2 = by * ROW_H;
    const attrs = wt ? 'stroke-dasharray="3 3"' : 'class="g-line" pathLength="1"';
    const d = x1 === x2 ? `M${x1} ${y1} L${x2} ${y2}`
      : `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
    s += `<path d="${d}" stroke="${color}" stroke-width="2" fill="none" stroke-linecap="round" ${attrs}/>`;

    // Render animated flow particles along traced branch or active commit lineage
    const segActive = !wt && traceSet && (traceSet.has(c.hash) && traceSet.has(targetHash));
    if (segActive && !reduceMotion) {
      s += `<path class="g-line-flow" d="${d}" stroke="${color}" stroke-width="2.6" fill="none" stroke-linecap="round" style="${flowPhase}"/>`;
    }
  }
  const cx = laneX(c.col), cy = ROW_H / 2;
  if (wt) {
    s += `<circle class="g-ants" cx="${cx}" cy="${cy}" r="${DOT_R}" style="fill:var(--bg);stroke:var(--dim);${phase}" stroke-width="2" stroke-dasharray="3 2"/>`;
    return s + '</svg>';
  }
  if (c.hash === state.repo.head) {
    s += `<circle class="g-halo" cx="${cx}" cy="${cy}" r="${DOT_R + 4}" fill="${c.color}" style="${phase}"/>`;
  }
  const sinceSel = now - state.popAt;
  const pop = c.hash === state.selected && sinceSel < 400 ? ` pop" style="--p:-${Math.round(sinceSel)}ms` : '';
  if (c.parents.length > 1) {
    s += `<circle class="g-dot${pop}" cx="${cx}" cy="${cy}" r="${DOT_R}" style="fill:var(--bg)" stroke="${c.color}" stroke-width="2.5"/>`;
  } else {
    s += `<circle class="g-dot${pop}" cx="${cx}" cy="${cy}" r="${DOT_R}" fill="${c.color}" style="stroke:var(--bg)" stroke-width="1.5"/>`;
  }
  return s + '</svg>';
}

// ------------------------------------------------------------ interactive horizontal branch topology
function svgPillBadge(x, y, { name, color, hashText, abText, isCurrentBranch, isTag }) {
  if (isTag) {
    const text = `🏷 ${name}`;
    const w = Math.max(48, text.length * 6.2 + 14);
    return `<rect class="bm-tag-bg" x="${x - w / 2}" y="${y - 10}" width="${w}" height="19" rx="6"/>
      <text x="${x}" y="${y + 3}" text-anchor="middle" class="bm-tag-lbl">${esc(text)}</text>`;
  }
  const label = `${name}${isCurrentBranch ? ' ★' : ''}`;
  const meta = [hashText, abText].filter(Boolean).join(' · ');
  const nameW = label.length * 6.6;
  const metaW = meta ? meta.length * 5.8 + 10 : 0;
  const totalW = Math.round(nameW + metaW + 22);
  const pillH = 22;
  return `<rect class="bm-pill-bg" x="${x}" y="${y - pillH / 2}" width="${totalW}" height="${pillH}" rx="7" stroke="${color}" stroke-opacity="0.45"/>
    <circle cx="${x + 9}" cy="${y}" r="3.2" fill="${color}"/>
    <text x="${x + 17}" y="${y + 3.8}" class="bm-label" style="fill:${color}">${esc(label)}</text>
    ${meta ? `<text x="${x + 19 + nameW}" y="${y + 3.5}" class="bm-meta-lbl">${esc(meta)}</text>` : ''}`;
}

function buildBranchSchematicSvg() {
  const realCommits = state.commits.filter((c) => c.hash !== WORKTREE);
  const branches = state.refs.filter((r) => r.kind === 'branch');
  const remotes = state.refs.filter((r) => r.kind === 'remote');
  const tags = state.refs.filter((r) => r.kind === 'tag');

  // Determine primary trunk branch (current branch or first branch or HEAD)
  const sortedBranches = (branches.length ? branches : remotes).slice()
    .sort((a, b) => (isCurrent(b) - isCurrent(a)) || a.name.localeCompare(b.name));

  const baseBranch = sortedBranches[0] || {
    name: state.repo.branch || 'HEAD',
    full: 'HEAD',
    kind: 'branch',
    hash: state.repo.head || realCommits[0]?.hash,
    color: COLORS[0],
  };

  // Walk base trunk first-parent chain (newest -> oldest, then reverse to oldest -> newest)
  const trunkChain = [];
  const trunkSet = new Set();
  let curHash = baseBranch.hash || realCommits[0]?.hash;
  while (curHash && state.index.has(curHash) && trunkChain.length < 40) {
    trunkChain.push(curHash);
    trunkSet.add(curHash);
    const c = state.commits[state.index.get(curHash)];
    curHash = c?.parents[0];
  }
  trunkChain.reverse(); // oldest on left -> newest on right

  // Collect secondary branches: named branches + (if few named branches) historical merged branches
  const otherBranches = sortedBranches.slice(1, 8).map((b) => ({ ...b }));
  const representedTips = new Set( sortedBranches.map((b) => b.hash) );

  if (otherBranches.length < 5) {
    for (const h of trunkChain.slice().reverse()) {
      const c = state.commits[state.index.get(h)];
      if (c && c.parents.length > 1) {
        const secParent = c.parents[1];
        if (secParent && state.index.has(secParent) && !representedTips.has(secParent)) {
          const sc = state.commits[state.index.get(secParent)];
          const m = /Merge branch '([^']+)'/.exec(c.subject);
          otherBranches.push({
            name: m ? m[1] : `merged/${short(secParent)}`,
            full: `merged/${secParent}`,
            kind: 'branch',
            hash: secParent,
            color: sc?.color || COLORS[(otherBranches.length + 1) % COLORS.length],
            mergedInto: h,
          });
          representedTips.add(secParent);
          if (otherBranches.length >= 6) break;
        }
      }
    }
  }

  // Assign well-spaced alternating vertical track offsets (48px between tracks on same side)
  const trackSteps = [-48, 48, -96, 96, -144, 144, -192, 192];
  const activeOffsets = [0, ...otherBranches.map((_, i) => trackSteps[i] || ((i % 2 ? 1 : -1) * 48 * Math.ceil((i + 1) / 2)))];
  const minOffset = Math.min(...activeOffsets);
  const maxOffset = Math.max(...activeOffsets);
  const padTop = 52;
  const padBottom = 52;
  const mainY = padTop - minOffset;
  const svgH = mainY + maxOffset + padBottom;

  // Map trunk commits to X coordinates
  const trunkLen = Math.max(1, trunkChain.length);
  const xStart = 64;
  const stepX = Math.max(68, Math.min(110, Math.floor(640 / Math.max(4, trunkLen))));
  const xEnd = xStart + Math.max(420, (trunkLen - 1) * stepX);
  const svgW = xEnd + 270;

  const trunkX = new Map();
  trunkChain.forEach((h, idx) => {
    const x = trunkLen === 1 ? (xStart + xEnd) / 2 : xStart + (idx / (trunkLen - 1)) * (xEnd - xStart);
    trunkX.set(h, Math.round(x));
  });

  // Also map which trunk merge commit merges which secondary commit
  const mergedIntoTrunkAt = new Map();
  for (const h of trunkChain) {
    const c = state.commits[state.index.get(h)];
    if (c && c.parents.length > 1) {
      for (const p of c.parents.slice(1)) mergedIntoTrunkAt.set(p, h);
    }
  }

  const hoveredRef = state.hoveredRef;
  const baseColor = baseBranch.color || COLORS[0];
  const baseDimmed = hoveredRef && hoveredRef !== baseBranch.full;
  const baseHi = hoveredRef && hoveredRef === baseBranch.full;

  let svgPaths = '';
  let svgNodes = '';

  // 1. Draw main trunk line & animated flow
  svgPaths += `<path class="bm-track${baseDimmed ? ' dimmed' : ''}${baseHi ? ' hi' : ''}" data-ref="${esc(baseBranch.full)}" d="M ${xStart - 18} ${mainY} L ${xEnd} ${mainY}" stroke="${baseColor}" style="color:${baseColor}"/>`;
  svgPaths += `<path class="bm-flow${baseDimmed ? ' dimmed' : ''}" d="M ${xStart - 18} ${mainY} L ${xEnd} ${mainY}" stroke="${baseColor}"/>`;

  // Track which trunk commits are fork or merge points
  const forkPoints = new Map(); // trunkHash -> color

  // 2. Draw each secondary branch track with real fork, branch commits, and merge curve
  otherBranches.forEach((b, idx) => {
    const color = b.color || COLORS[(idx + 1) % COLORS.length];
    const dy = trackSteps[idx] || 48;
    const y = mainY + dy;
    const dimmed = hoveredRef && hoveredRef !== b.full;
    const hi = hoveredRef && hoveredRef === b.full;

    // Walk branch commits back until hitting trunkSet
    const bChain = [];
    let cur = b.hash;
    let forkHash = null;
    while (cur && state.index.has(cur) && bChain.length < 15) {
      if (trunkSet.has(cur)) {
        forkHash = cur;
        break;
      }
      bChain.push(cur);
      const c = state.commits[state.index.get(cur)];
      cur = c?.parents[0];
    }
    bChain.reverse(); // oldest -> newest on this branch

    const mergeTargetHash = b.mergedInto || mergedIntoTrunkAt.get(b.hash);
    const mergeX = mergeTargetHash && trunkX.has(mergeTargetHash) ? trunkX.get(mergeTargetHash) : null;

    let forkX = forkHash && trunkX.has(forkHash)
      ? trunkX.get(forkHash)
      : Math.max(xStart + 20, (mergeX || xEnd) - 180 - (idx % 3) * 45);

    if (mergeX && forkX >= mergeX - 70) {
      forkX = Math.max(xStart, mergeX - 150);
    }
    if (forkHash) forkPoints.set(forkHash, color);

    const curveSpan = 52;
    const startBranchX = forkX + curveSpan;
    const tipX = mergeX
      ? Math.max(startBranchX + 36, mergeX - curveSpan - 12)
      : Math.min(xEnd + 18, Math.max(startBranchX + 80, forkX + 155 + (idx % 2) * 35));

    const pathD = mergeX
      ? `M ${forkX} ${mainY} C ${forkX + curveSpan * 0.65} ${mainY}, ${startBranchX - curveSpan * 0.45} ${y}, ${startBranchX} ${y} L ${tipX} ${y} C ${tipX + curveSpan * 0.5} ${y}, ${mergeX - curveSpan * 0.5} ${mainY}, ${mergeX} ${mainY}`
      : `M ${forkX} ${mainY} C ${forkX + curveSpan * 0.65} ${mainY}, ${startBranchX - curveSpan * 0.45} ${y}, ${startBranchX} ${y} L ${tipX} ${y}`;

    svgPaths += `<path class="bm-track${dimmed ? ' dimmed' : ''}${hi ? ' hi' : ''}" data-ref="${esc(b.full)}" d="${pathD}" stroke="${color}" style="color:${color}"/>`;
    svgPaths += `<path class="bm-flow${dimmed ? ' dimmed' : ''}" d="${pathD}" stroke="${color}"/>`;

    // Fork ring on main trunk if not already a trunk node
    if (!forkHash || !trunkX.has(forkHash)) {
      svgNodes += `<circle cx="${forkX}" cy="${mainY}" r="4.2" fill="var(--surface)" stroke="${color}" stroke-width="2.2"/>`;
    }

    // Plot up to 4 commits along this branch track
    const shownCommits = bChain.length ? bChain.slice(-4) : [b.hash];
    shownCommits.forEach((ch, cIdx) => {
      const isTip = cIdx === shownCommits.length - 1;
      const cx = shownCommits.length === 1
        ? tipX
        : Math.round(startBranchX + (cIdx / (shownCommits.length - 1)) * (tipX - startBranchX));
      const isSel = ch === state.selected;
      const isCur = isTip && isCurrent(b);
      svgNodes += `<g class="bm-node-group${dimmed ? ' dimmed' : ''}" data-goto="${ch}" data-ref="${esc(b.full)}" style="color:${color}">
        ${isCur ? `<circle class="g-halo" cx="${cx}" cy="${y}" r="11" fill="${color}"/>` : ''}
        ${isSel ? `<circle class="bm-sel-ring" cx="${cx}" cy="${y}" r="9.5" stroke="${color}"/>` : ''}
        <circle class="bm-node" cx="${cx}" cy="${y}" r="${isTip ? 5.6 : 4.2}" fill="${color}" stroke="var(--surface)" stroke-width="1.8"/>
      </g>`;
    });

    // Branch pill badge at tip
    const abText = b.ahead || b.behind ? `${b.ahead ? `↑${b.ahead}` : ''}${b.behind ? `↓${b.behind}` : ''}` : '';
    const pillX = mergeX ? Math.round((startBranchX + tipX) / 2 - 48) : tipX + 11;
    const pillY = mergeX ? y + (dy < 0 ? -17 : 17) : y;
    svgNodes += `<g class="bm-node-group${dimmed ? ' dimmed' : ''}" data-goto="${b.hash}" data-ref="${esc(b.full)}" style="color:${color}">
      ${svgPillBadge(pillX, pillY, {
        name: b.name,
        color,
        hashText: short(b.hash),
        abText,
        isCurrentBranch: isCurrent(b),
      })}
    </g>`;
  });

  // 3. Draw trunk commit nodes, tags, and main trunk pill badge
  const tagsByHash = new Map();
  for (const t of tags) {
    if (!tagsByHash.has(t.hash)) tagsByHash.set(t.hash, []);
    tagsByHash.get(t.hash).push(t);
  }

  // Sample trunk commits if there are many so dots never crowd each other
  const maxTrunkDots = 12;
  const stepIdx = Math.max(1, Math.ceil(trunkChain.length / maxTrunkDots));
  trunkChain.forEach((h, idx) => {
    const isTip = idx === trunkChain.length - 1;
    const isRoot = idx === 0;
    const c = state.commits[state.index.get(h)];
    const isMerge = c && c.parents.length > 1;
    const isFork = forkPoints.has(h);
    const hasTag = tagsByHash.has(h);
    const isSel = h === state.selected;
    if (!isTip && !isRoot && !isMerge && !isFork && !hasTag && !isSel && idx % stepIdx !== 0) return;

    const x = trunkX.get(h);
    const isHead = h === state.repo.head;
    const ringColor = isFork ? forkPoints.get(h) : baseColor;
    const hollow = isMerge || isFork;

    svgNodes += `<g class="bm-node-group${baseDimmed ? ' dimmed' : ''}" data-goto="${h}" data-ref="${esc(baseBranch.full)}" style="color:${baseColor}">
      ${isHead ? `<circle class="g-halo" cx="${x}" cy="${mainY}" r="11.5" fill="${baseColor}"/>` : ''}
      ${isSel ? `<circle class="bm-sel-ring" cx="${x}" cy="${mainY}" r="10" stroke="${baseColor}"/>` : ''}
      <circle class="bm-node" cx="${x}" cy="${mainY}" r="${isTip ? 6.2 : hollow ? 5 : 4.2}"
        fill="${hollow && !isTip ? 'var(--surface)' : baseColor}"
        stroke="${hollow && !isTip ? ringColor : 'var(--surface)'}"
        stroke-width="${hollow && !isTip ? 2.4 : 1.6}"/>
    </g>`;

    if (hasTag) {
      const t = tagsByHash.get(h)[0];
      svgNodes += `<g class="bm-tag-group" data-goto="${h}">
        ${svgPillBadge(x, mainY - 22, { name: t.name, isTag: true })}
      </g>`;
    }
  });

  // Base branch pill at trunk tip (right end)
  const baseAb = baseBranch.ahead || baseBranch.behind
    ? `${baseBranch.ahead ? `↑${baseBranch.ahead}` : ''}${baseBranch.behind ? `↓${baseBranch.behind}` : ''}`
    : '';
  svgNodes += `<g class="bm-node-group${baseDimmed ? ' dimmed' : ''}" data-goto="${baseBranch.hash}" data-ref="${esc(baseBranch.full)}" style="color:${baseColor}">
    ${svgPillBadge(xEnd + 12, mainY, {
      name: baseBranch.name,
      color: baseColor,
      hashText: baseBranch.hash ? short(baseBranch.hash) : '',
      abText: baseAb,
      isCurrentBranch: isCurrent(baseBranch) || baseBranch.hash === state.repo.head,
    })}
  </g>`;

  return { svgW, svgH, svgPaths, svgNodes, multiBranch: otherBranches.length > 0 };
}

function buildFullTimelineSvg() {
  // Full Commit-by-Commit Horizontal DAG (oldest on left -> newest on right)
  const slice = state.commits.slice(0, 45).reverse(); // oldest -> newest
  const maxLane = Math.max(0, ...slice.map((c) => c.col || 0));
  const laneStepY = 44;
  const stepX = 64;
  const padX = 56;
  const padY = 52;
  const svgW = Math.max(680, padX * 2 + Math.max(1, slice.length - 1) * stepX + 190);
  const svgH = Math.max(140, padY * 2 + maxLane * laneStepY);

  const posByHash = new Map();
  slice.forEach((c, idx) => {
    posByHash.set(c.hash, {
      x: padX + idx * stepX,
      y: padY + (c.col || 0) * laneStepY,
      c,
    });
  });

  const hoveredSet = state.hoveredRef ? state.branchSets.get(state.hoveredRef) : null;
  const traceSet = hoveredSet || state.activeLineage;
  let svgPaths = '';
  let svgNodes = '';

  // Draw edges from parents to children
  for (const { x: x2, y: y2, c } of posByHash.values()) {
    const wt = c.hash === WORKTREE;
    for (let pi = 0; pi < c.parents.length; pi++) {
      const pHash = c.parents[pi];
      const pPos = posByHash.get(pHash);
      if (!pPos) continue;
      const { x: x1, y: y1 } = pPos;
      const edgeColor = pi > 0 ? c.color : (pPos.c.color || c.color);
      const d = y1 === y2
        ? `M ${x1} ${y1} L ${x2} ${y2}`
        : `M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}`;
      const active = !wt && traceSet && traceSet.has(c.hash) && traceSet.has(pHash);
      const dimmed = hoveredSet && !active;
      svgPaths += `<path class="bm-track${dimmed ? ' dimmed' : ''}${active && hoveredSet ? ' hi' : ''}" d="${d}" stroke="${edgeColor}" ${wt ? 'stroke-dasharray="4 3"' : ''} style="color:${edgeColor}"/>`;
      if (active && !reduceMotion) {
        svgPaths += `<path class="bm-flow" d="${d}" stroke="${edgeColor}"/>`;
      }
    }
  }

  // Draw commit nodes and branch/tag pills
  for (const { x, y, c } of posByHash.values()) {
    const wt = c.hash === WORKTREE;
    const isHead = c.hash === state.repo.head;
    const isSel = c.hash === state.selected;
    const isMerge = c.parents.length > 1;
    const dimmed = hoveredSet && !hoveredSet.has(c.hash);
    const refs = state.refsByHash.get(c.hash) || [];
    const primaryRef = refs[0];

    svgNodes += `<g class="bm-node-group${dimmed ? ' dimmed' : ''}" data-goto="${c.hash}" ${primaryRef ? `data-ref="${esc(primaryRef.full)}"` : ''} style="color:${c.color}">
      ${isHead ? `<circle class="g-halo" cx="${x}" cy="${y}" r="11.5" fill="${c.color}"/>` : ''}
      ${isSel ? `<circle class="bm-sel-ring" cx="${x}" cy="${y}" r="10" stroke="${c.color}"/>` : ''}
      <circle class="bm-node" cx="${x}" cy="${y}" r="${isHead || isSel ? 6 : 4.8}"
        fill="${wt || isMerge ? 'var(--surface)' : c.color}"
        stroke="${wt ? 'var(--dim)' : isMerge ? c.color : 'var(--surface)'}"
        stroke-width="${isMerge || wt ? 2.4 : 1.6}"
        ${wt ? 'stroke-dasharray="3 2"' : ''}/>
      <text x="${x}" y="${y + 16}" text-anchor="middle" class="bm-commit-lbl">${wt ? 'worktree' : short(c.hash)}</text>
    </g>`;

    if (primaryRef) {
      svgNodes += `<g class="bm-node-group${dimmed ? ' dimmed' : ''}" data-goto="${c.hash}" data-ref="${esc(primaryRef.full)}">
        ${svgPillBadge(x - 28, y - 22, {
          name: primaryRef.name,
          color: primaryRef.color || c.color,
          abText: refs.length > 1 ? `+${refs.length - 1}` : '',
          isCurrentBranch: isCurrent(primaryRef),
          isTag: primaryRef.kind === 'tag',
        })}
      </g>`;
    }
  }

  return { svgW, svgH, svgPaths, svgNodes, multiBranch: maxLane > 0 };
}

function renderBranchMap({ keepScroll = false } = {}) {
  const el = $('#branch-map');
  if (!el) return;
  el.classList.toggle('collapsed', !state.showBranchMap);
  el.classList.toggle('expanded', state.bmExpanded);
  if (!state.commits.length) {
    el.innerHTML = '';
    return;
  }

  const prevWrap = el.querySelector('.bm-canvas-wrap');
  const prevScrollLeft = prevWrap ? prevWrap.scrollLeft : null;
  const prevScrollTop = prevWrap ? prevWrap.scrollTop : null;

  const branches = state.refs.filter((r) => r.kind === 'branch');
  const tags = state.refs.filter((r) => r.kind === 'tag');

  const { svgW, svgH, svgPaths, svgNodes, multiBranch } = state.bmMode === 'timeline'
    ? buildFullTimelineSvg()
    : buildBranchSchematicSvg();

  const scaledW = Math.round(svgW * state.bmZoom);
  const scaledH = Math.round(svgH * state.bmZoom);
  const zoomPct = Math.round(state.bmZoom * 100);

  const demoAction = !multiBranch && !state.demoMode
    ? `<button class="btn" id="bm-try-demo" title="Simulate a multi-branch repository with animated forks & merges">✨ Preview Multi-Branch Animation</button>`
    : '';

  el.innerHTML = `
    <div class="bm-head">
      <div class="bm-title">
        <span>Branch Topology</span>
        <span class="bm-badge">${branches.length} branch${branches.length === 1 ? '' : 'es'}${tags.length ? ` · ${tags.length} tag${tags.length === 1 ? '' : 's'}` : ''}</span>
        ${state.demoMode ? '<span class="demo-banner-chip">Demo Mode</span>' : ''}
      </div>
      <div class="bm-toolbar">
        ${demoAction}
        <div class="bm-seg" title="Switch horizontal graph view">
          <button data-bm-mode="branches" class="${state.bmMode === 'branches' ? 'on' : ''}">Branches</button>
          <button data-bm-mode="timeline" class="${state.bmMode === 'timeline' ? 'on' : ''}">All Commits</button>
        </div>
        <div class="bm-zoom-bar" title="Zoom & fit horizontal graph (Ctrl + Scroll)">
          <button class="bm-zbtn" data-bm-zoom="-0.15" title="Zoom out">−</button>
          <button class="bm-zbtn" data-bm-zoom="reset" title="Reset zoom & center">${zoomPct}%</button>
          <button class="bm-zbtn" data-bm-zoom="0.15" title="Zoom in">+</button>
        </div>
        <button class="bm-zbtn" id="bm-expand" title="Expand / compact Branch Topology view (f)" style="border:1px solid var(--line-strong);border-radius:7px;padding:0 8px;height:24px;background:var(--bg)">
          ${state.bmExpanded ? '⤡ Compact' : '⤢ Expand'}
        </button>
      </div>
    </div>
    <div class="bm-canvas-wrap" id="bm-canvas-wrap">
      <svg class="bm-svg" width="${scaledW}" height="${scaledH}" viewBox="0 0 ${svgW} ${svgH}" preserveAspectRatio="xMidYMid meet">
        ${svgPaths}
        ${svgNodes}
      </svg>
    </div>`;

  const wrap = $('#bm-canvas-wrap');
  if (wrap) {
    if (keepScroll && prevScrollLeft !== null) {
      wrap.scrollLeft = prevScrollLeft;
      wrap.scrollTop = prevScrollTop;
    } else {
      // Scroll to rightmost end (newest commits / branch tips) on initial render
      requestAnimationFrame(() => {
        wrap.scrollLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
      });
    }
  }

  const tryBtn = $('#bm-try-demo');
  if (tryBtn) tryBtn.onclick = () => toggleDemoMode(true);
}

function showBmTooltip(hash, clientX, clientY) {
  const tt = $('#bm-tooltip');
  if (!tt) return;
  const i = state.index.get(hash);
  if (i === undefined) { tt.classList.add('hidden'); return; }
  const c = state.commits[i];
  const refs = hash === WORKTREE ? '' : refsHtml(hash);
  tt.innerHTML = `
    <div class="tt-top">
      <span class="hash" style="color:${c.color || 'var(--accent)'};font-weight:700">${hash === WORKTREE ? 'WORKTREE' : short(hash)}</span>
      ${refs}
    </div>
    <div class="tt-subj">${esc(c.subject)}</div>
    <div class="tt-who">${avatar(c.author, c.email)} <span>${esc(c.author)}</span> · <span>${relTime(c.time)}</span></div>`;
  tt.classList.remove('hidden');
  const pad = 14;
  const rect = tt.getBoundingClientRect();
  const left = Math.min(window.innerWidth - rect.width - pad, Math.max(pad, clientX + 14));
  const top = clientY + rect.height + 24 > window.innerHeight
    ? Math.max(pad, clientY - rect.height - 12)
    : clientY + 16;
  tt.style.left = `${left}px`;
  tt.style.top = `${top}px`;
}

function hideBmTooltip() {
  const tt = $('#bm-tooltip');
  if (tt) tt.classList.add('hidden');
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
    return `<span class="ref ref-branch${cur ? ' ref-current' : ''}"${style} title="${esc(tip + syncTip)}">${esc(r.name)}${sync}</span>`;
  }
  if (r.kind === 'remote') {
    return `<span class="ref ref-remote" title="Remote branch: where '${esc(r.name)}' was on the server at your last fetch"><i class="ico ico-cloud"></i>${esc(r.name)}</span>`;
  }
  return `<span class="ref ref-tag" title="Tag"><i class="ico ico-tag"></i>${esc(r.name)}</span>`;
}

function refsHtml(hash) {
  let html = '';
  if (state.repo.detached && hash === state.repo.head) {
    html += '<span class="ref ref-head" title="HEAD is detached: you are viewing this exact commit, not a branch">HEAD (detached)</span>';
  }
  for (const r of state.refsByHash.get(hash) || []) html += refPill(r);
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
  if (state.demoMode) {
    html += `<span>·</span><span class="demo-banner-chip">Multi-Branch Demo Active</span>`;
  }
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
      `<div class="msg">${c.hash === WORKTREE ? '' : refsHtml(c.hash)}<span class="subject" title="${esc(c.subject)}">${highlight(c.subject)}</span></div>` +
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
  renderBranchMap({ keepScroll: true });
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
    if (state.demoMode) {
      if (c.hash === WORKTREE) {
        const wt = state.demoData.worktree;
        det.innerHTML = `<div class="view">${renderWorktree(wt)}</div>`;
        wireDiffs(det, wt.patch, wt.files);
      } else {
        const d = state.demoData.detailsByHash.get(c.hash);
        det.innerHTML = `<div class="view">${renderCommit(d)}</div>`;
        wireDiffs(det, d.patch, d.files);
      }
      det.scrollTop = 0;
      return;
    }
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

// Animated SVG Commit Lineage & Branch Flow Card inside Details
function renderLineageCard(d, kids) {
  const ci = state.index.get(d.hash);
  const curColor = (ci !== undefined && state.commits[ci]?.color) || 'var(--accent)';
  const parents = d.parents || [];
  const w = 480, h = 68, cy = 34, cx = 240;

  let edges = '';
  let nodes = '';

  // Parents on the left -> flowing into current commit in center
  if (!parents.length) {
    edges += `<text x="72" y="${cy + 4}" text-anchor="middle" class="lin-sub">Root commit (initial)</text>`;
  } else {
    parents.slice(0, 3).forEach((p, idx) => {
      const pi = state.index.get(p);
      const pColor = (pi !== undefined && state.commits[pi]?.color) || COLORS[idx % COLORS.length];
      const py = parents.length === 1 ? cy : idx === 0 ? cy - 16 : idx === 1 ? cy + 16 : cy;
      const px = 78;
      const pathD = `M ${px} ${py} C ${(px + cx) / 2} ${py}, ${(px + cx) / 2} ${cy}, ${cx} ${cy}`;
      edges += `<path class="lin-edge" d="${pathD}" stroke="${pColor}"/>`;
      edges += `<path class="lin-flow" d="${pathD}" stroke="${pColor}"/>`;
      nodes += `<g class="lin-node" data-goto="${p}">
        <title>Parent: ${short(p)} (click to jump)</title>
        <circle cx="${px}" cy="${py}" r="5.5" fill="${pColor}" stroke="var(--surface)" stroke-width="1.5"/>
        <text x="${px - 10}" y="${py + 3.5}" text-anchor="end" class="lin-lbl">${short(p)}</text>
      </g>`;
    });
  }

  // Current commit -> flowing out to children on the right
  if (!kids.length) {
    edges += `<text x="${w - 72}" y="${cy + 4}" text-anchor="middle" class="lin-sub">Branch tip</text>`;
  } else {
    kids.slice(0, 3).forEach((k, idx) => {
      const ki = state.index.get(k);
      const kColor = (ki !== undefined && state.commits[ki]?.color) || curColor;
      const ky = kids.length === 1 ? cy : idx === 0 ? cy - 16 : idx === 1 ? cy + 16 : cy;
      const kx = w - 78;
      const pathD = `M ${cx} ${cy} C ${(cx + kx) / 2} ${cy}, ${(cx + kx) / 2} ${ky}, ${kx} ${ky}`;
      edges += `<path class="lin-edge" d="${pathD}" stroke="${kColor}"/>`;
      edges += `<path class="lin-flow" d="${pathD}" stroke="${kColor}"/>`;
      nodes += `<g class="lin-node" data-goto="${k}">
        <title>Child: ${short(k)} (click to jump)</title>
        <circle cx="${kx}" cy="${ky}" r="5.5" fill="${kColor}" stroke="var(--surface)" stroke-width="1.5"/>
        <text x="${kx + 10}" y="${ky + 3.5}" text-anchor="start" class="lin-lbl">${short(k)}</text>
      </g>`;
    });
  }

  // Center selected commit node
  const isMerge = parents.length > 1;
  nodes += `<g>
    <circle class="g-halo" cx="${cx}" cy="${cy}" r="12" fill="${curColor}"/>
    <circle cx="${cx}" cy="${cy}" r="7" fill="${isMerge ? 'var(--surface)' : curColor}" stroke="${curColor}" stroke-width="3"/>
    <text x="${cx}" y="${cy - 13}" text-anchor="middle" class="lin-lbl" style="fill:${curColor}">${short(d.hash)}</text>
    <text x="${cx}" y="${cy + 22}" text-anchor="middle" class="lin-sub">${isMerge ? 'Merge Commit' : kids.length > 1 ? 'Branch Fork' : 'Selected'}</text>
  </g>`;

  const flowLabel = isMerge
    ? `Merges ${parents.length} branches`
    : kids.length > 1
      ? `Forks into ${kids.length} branches`
      : 'Commit lineage flow';

  return `
    <div class="lineage-card">
      <div class="lineage-title">
        <span>Branch & Commit Flow</span>
        <span>${esc(flowLabel)}</span>
      </div>
      <svg class="lineage-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
        ${edges}
        ${nodes}
      </svg>
    </div>`;
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
    ${renderLineageCard(d, kids)}
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
      renderBranchMap({ keepScroll: true });
      queueRender();
    }
  });
  $('#ref-groups').addEventListener('mouseleave', () => {
    if (state.hoveredRef) {
      state.hoveredRef = null;
      renderBranchMap({ keepScroll: true });
      queueRender();
    }
  });
  $('#ref-filter').addEventListener('input', renderSidebar);

  // Branch Map click, mode switch, zoom, expand, pan & hover tooltip
  const bmap = $('#branch-map');
  let bmDidPan = false;

  bmap.addEventListener('click', (e) => {
    if (bmDidPan) { bmDidPan = false; return; }
    const modeBtn = e.target.closest('[data-bm-mode]');
    if (modeBtn) {
      state.bmMode = modeBtn.dataset.bmMode;
      renderBranchMap();
      return;
    }
    const zBtn = e.target.closest('[data-bm-zoom]');
    if (zBtn) {
      const val = zBtn.dataset.bmZoom;
      state.bmZoom = val === 'reset' ? 1 : Math.max(0.55, Math.min(2.2, +(state.bmZoom + parseFloat(val)).toFixed(2)));
      renderBranchMap({ keepScroll: val !== 'reset' });
      return;
    }
    if (e.target.closest('#bm-expand')) {
      state.bmExpanded = !state.bmExpanded;
      renderBranchMap({ keepScroll: true });
      setTimeout(queueRender, 300);
      return;
    }
    const g = e.target.closest('[data-goto]');
    if (g && state.index.has(g.dataset.goto)) {
      selectCommit(g.dataset.goto, { scroll: true });
    }
  });

  bmap.addEventListener('mousemove', (e) => {
    const node = e.target.closest('[data-goto]');
    if (node && state.index.has(node.dataset.goto)) {
      showBmTooltip(node.dataset.goto, e.clientX, e.clientY);
    } else {
      hideBmTooltip();
    }
    const refEl = e.target.closest('[data-ref]');
    const refFull = refEl ? refEl.dataset.ref : null;
    if (refFull !== state.hoveredRef) {
      state.hoveredRef = refFull;
      bmap.querySelectorAll('.bm-track').forEach((p) => {
        const pr = p.dataset.ref;
        p.classList.toggle('dimmed', Boolean(refFull && pr && pr !== refFull));
        p.classList.toggle('hi', Boolean(refFull && pr && pr === refFull));
      });
      queueRender();
    }
  });

  bmap.addEventListener('mouseleave', () => {
    hideBmTooltip();
    if (state.hoveredRef) {
      state.hoveredRef = null;
      renderBranchMap({ keepScroll: true });
      queueRender();
    }
  });

  // Mouse wheel zoom (Ctrl+Wheel) & horizontal scroll inside Branch Topology
  bmap.addEventListener('wheel', (e) => {
    const wrap = $('#bm-canvas-wrap');
    if (!wrap) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.12 : -0.12;
      state.bmZoom = Math.max(0.55, Math.min(2.2, +(state.bmZoom + delta).toFixed(2)));
      renderBranchMap({ keepScroll: true });
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && wrap.scrollWidth > wrap.clientWidth) {
      e.preventDefault();
      wrap.scrollLeft += e.deltaY;
    }
  }, { passive: false });

  // Click-and-drag panning inside Branch Topology canvas
  bmap.addEventListener('mousedown', (e) => {
    const wrap = e.target.closest('.bm-canvas-wrap');
    if (!wrap || e.button !== 0) return;
    const startX = e.clientX, startY = e.clientY;
    const sl = wrap.scrollLeft, st = wrap.scrollTop;
    bmDidPan = false;
    const move = (ev) => {
      const dx = ev.clientX - startX, dy = ev.clientY - startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        bmDidPan = true;
        wrap.classList.add('panning');
        hideBmTooltip();
      }
      if (bmDidPan) {
        wrap.scrollLeft = sl - dx;
        wrap.scrollTop = st - dy;
      }
    };
    const up = () => {
      wrap.classList.remove('panning');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });

  // Vertical drag resizer for Branch Topology panel height
  const bmResizer = $('#bm-resizer');
  if (bmResizer) {
    bmResizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      bmResizer.classList.add('drag');
      bmap.classList.add('dragging');
      state.bmExpanded = false;
      bmap.classList.remove('expanded');
      const startY = e.clientY;
      const startH = bmap.getBoundingClientRect().height;
      const move = (ev) => {
        const h = Math.max(150, Math.min(window.innerHeight * 0.75, startH + (ev.clientY - startY)));
        bmap.style.setProperty('--bm-h', `${Math.round(h)}px`);
        queueRender();
      };
      const up = () => {
        bmResizer.classList.remove('drag');
        bmap.classList.remove('dragging');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  $('#branch-map-btn').onclick = () => {
    state.showBranchMap = !state.showBranchMap;
    $('#branch-map-btn').classList.toggle('active', state.showBranchMap);
    $('#branch-map').classList.toggle('collapsed', !state.showBranchMap);
    setTimeout(queueRender, 320);
  };

  $('#demo-btn').onclick = () => toggleDemoMode();

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
    else if (k === 'b') $('#branch-map-btn').click();
    else if (k === 'f') {
      state.bmExpanded = !state.bmExpanded;
      renderBranchMap({ keepScroll: true });
      setTimeout(queueRender, 300);
    }
    else if (k === 'd') toggleDemoMode();
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
    if (state.demoMode) return;
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
    if (state.demoMode) {
      const branches = state.refs.filter((r) => r.kind === 'branch' && state.branchSets.get(r.full)?.has(hash)).map((r) => r.name);
      const remotes = state.refs.filter((r) => r.kind === 'remote' && state.branchSets.get(r.full)?.has(hash)).map((r) => r.name);
      const tags = state.refs.filter((r) => r.kind === 'tag' && state.branchSets.get(r.full)?.has(hash)).map((r) => r.name);
      const pills = [
        ...branches.map((n) => refPill({ kind: 'branch', name: n })),
        ...remotes.map((n) => refPill({ kind: 'remote', name: n })),
        ...tags.map((n) => refPill({ kind: 'tag', name: n })),
      ];
      el.innerHTML = pills.length
        ? `<div class="contains">${pills.join('')}</div>`
        : '<span style="color:var(--faint)">Reachable via merge commit on main.</span>';
      return;
    }
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
