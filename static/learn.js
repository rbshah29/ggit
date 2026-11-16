/* ggit — Learn mode.
 *
 * A self-contained git playground: commands typed into the terminal run against a
 * small simulated repository (nothing touches the real repo on disk), and every
 * command is broken into narrated steps that animate files and commits moving
 * between the working directory, staging area, local repository and remote.
 */
(() => {
  'use strict';

  const q = (s, root = document) => root.querySelector(s);
  const html = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const laneColor = (i) => {
    const pal = (typeof COLORS !== 'undefined' && COLORS) || ['#9d8189', '#e0899a', '#5f8f89', '#6b84a8'];
    return pal[i % pal.length];
  };
  const noMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  class GitError extends Error {}
  const fail = (msg) => { throw new GitError(msg); };

  // ============================================================ model
  let store;      // id -> commit {id, parents, msg, tree, seq}
  let seq;
  let S;          // sandbox state

  function freshState() {
    store = {};
    seq = 0;
    S = {
      local: { has: new Set(), branches: {}, tags: {}, head: { ref: 'main' }, tracking: {}, upstream: {} },
      remote: { has: new Set(), branches: {} },
      index: {},
      work: {},
      stash: [],
      merge: null,   // { theirs, msg, conflicts:Set }
      editCount: 0,
    };
  }

  const newId = () => {
    let id;
    do id = Math.floor(Math.random() * 0xfffffff).toString(16).padStart(7, '0');
    while (store[id]);
    return id;
  };
  function makeCommit(parents, msg, tree) {
    const c = { id: newId(), parents, msg, tree: { ...tree }, seq: seq++ };
    store[c.id] = c;
    return c;
  }

  const headId = () => (S.local.head.ref ? S.local.branches[S.local.head.ref] : S.local.head.id);
  const headTree = () => (headId() ? store[headId()].tree : {});
  const curBranch = () => S.local.head.ref || null;

  function ancestors(id, has) {
    const seen = new Set();
    const stack = id ? [id] : [];
    while (stack.length) {
      const c = stack.pop();
      if (seen.has(c) || (has && !has.has(c))) continue;
      seen.add(c);
      stack.push(...store[c].parents);
    }
    return seen;
  }
  const isAncestor = (a, b) => ancestors(b).has(a);
  function mergeBase(a, b) {
    const A = ancestors(a);
    let best = null;
    for (const id of ancestors(b)) if (A.has(id) && (!best || store[id].seq > store[best].seq)) best = id;
    return best;
  }

  function resolve(rev, { quiet = false } = {}) {
    const m = /^(.*?)((?:[~^]\d*)*)$/.exec(rev);
    let base = m[1];
    let id;
    const L = S.local;
    if (base === 'HEAD' || base === '@') id = headId();
    else if (L.branches[base]) id = L.branches[base];
    else if (L.tags[base]) id = L.tags[base];
    else if (L.tracking[base]) id = L.tracking[base];
    else if (/^[0-9a-f]{4,7}$/.test(base)) {
      const hits = [...L.has].filter((x) => x.startsWith(base));
      if (hits.length === 1) id = hits[0];
    }
    if (!id) {
      if (quiet) return null;
      fail(`ambiguous argument '${rev}': unknown revision or path not in the working tree.`);
    }
    for (const [, op, n] of m[2].matchAll(/([~^])(\d*)/g)) {
      const k = n === '' ? 1 : +n;
      if (op === '~') for (let i = 0; i < k && id; i++) id = store[id].parents[0];
      else id = k === 0 ? id : store[id].parents[k - 1];
      if (!id) { if (quiet) return null; fail(`'${rev}' points before the first commit.`); }
    }
    return id;
  }

  // File status helpers -------------------------------------------------
  function stagedChanges() {
    const head = headTree();
    const names = new Set([...Object.keys(head), ...Object.keys(S.index)]);
    const out = [];
    for (const n of [...names].sort()) {
      if (S.merge?.conflicts.has(n)) continue;
      if (head[n] === S.index[n]) continue;
      out.push({ name: n, kind: !(n in head) ? 'A' : !(n in S.index) ? 'D' : 'M' });
    }
    return out;
  }
  function workStatus(n) {
    if (S.merge?.conflicts.has(n)) return 'U';
    if (!(n in S.index)) return n in S.work ? '?' : '';
    if (!(n in S.work)) return 'D';
    return S.work[n] === S.index[n] ? '' : 'M';
  }
  const unstagedNames = () => [...new Set([...Object.keys(S.work), ...Object.keys(S.index)])]
    .filter((n) => workStatus(n) && workStatus(n) !== '?').sort();
  const untrackedNames = () => Object.keys(S.work).filter((n) => workStatus(n) === '?').sort();
  const isDirty = () => stagedChanges().length > 0 || unstagedNames().length > 0;

  // Refs that keep commits alive in each repo.
  function reachableLocal() {
    const tips = [headId(), ...Object.values(S.local.branches), ...Object.values(S.local.tags),
      ...Object.values(S.local.tracking), ...S.stash.map((s) => s.base)];
    if (S.merge) tips.push(S.merge.theirs);
    const set = new Set();
    for (const t of tips) if (t) for (const id of ancestors(t)) set.add(id);
    return set;
  }
  function reachableRemote() {
    const set = new Set();
    for (const t of Object.values(S.remote.branches)) for (const id of ancestors(t)) set.add(id);
    return set;
  }

  // ============================================================ DOM
  let root, stage, termOut, termIn, narr, fx;
  let busy = false;
  let speed = +(localStorage.getItem('ggit-learn-speed') || 1);
  let stepMode = localStorage.getItem('ggit-learn-step') === '1';
  let silent = false;
  const history = [];
  let histPos = 0;
  const prevEdges = { c: new Set(), r: new Set() };
  let nextResolver = null;

  const dur = (ms) => (noMotion ? 0 : Math.round(ms * speed));
  const wait = (ms) => new Promise((r) => setTimeout(r, dur(ms)));

  function build() {
    root = document.createElement('div');
    root.id = 'learn';
    root.className = 'learn hidden';
    root.innerHTML = `
      <div class="lr-top">
        <div class="lr-title">
          <svg viewBox="0 0 24 24"><path d="M22 9 12 4 2 9l10 5 10-5Z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5"/><path d="M22 9v6"/></svg>
          <span>Git playground</span>
          <span class="lr-sub">a safe sandbox — your real repository is never touched</span>
        </div>
        <div class="spacer"></div>
        <label class="lr-toggle" title="Pause after every step until you press Next (or Enter)">
          <input type="checkbox" id="lr-stepmode"> Step by step
        </label>
        <div class="seg" id="lr-speed" title="Animation speed">
          <button data-v="1.8">Slow</button><button data-v="1">Normal</button><button data-v="0.45">Fast</button>
        </div>
        <button class="pill-btn" id="lr-reset" title="Start this lesson (or the free sandbox) again">
          <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 2.64-6.36"/><path d="M3 3v6h6"/></svg><span>Reset</span>
        </button>
        <button class="icon-btn" id="lr-close" title="Close (Esc)">
          <svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="lr-body">
        <div class="lr-left">
          <div class="lr-lessons" id="lr-lessons"></div>
          <div class="lr-term">
            <div class="lr-term-out" id="lr-out"></div>
            <div class="lr-term-in">
              <span class="lr-prompt" id="lr-prompt"></span>
              <input id="lr-in" autocomplete="off" spellcheck="false" placeholder="type a git command…">
            </div>
          </div>
        </div>
        <div class="lr-right">
          <div class="lr-narr idle" id="lr-narr">
            <div class="lr-narr-step" id="lr-narr-step"></div>
            <div class="lr-narr-text" id="lr-narr-text"></div>
            <button class="btn primary hidden" id="lr-next">Next ▸</button>
          </div>
          <div class="lr-stage" id="lr-stage"></div>
        </div>
      </div>
      <div class="lr-fx" id="lr-fx"></div>`;
    document.body.appendChild(root);
    stage = q('#lr-stage', root);
    termOut = q('#lr-out', root);
    termIn = q('#lr-in', root);
    narr = q('#lr-narr', root);
    fx = q('#lr-fx', root);

    q('#lr-close', root).onclick = close;
    q('#lr-reset', root).onclick = () => { if (!busy) startLesson(lessonIdx); };
    q('#lr-next', root).onclick = () => nextResolver?.();
    const stepBox = q('#lr-stepmode', root);
    stepBox.checked = stepMode;
    stepBox.onchange = () => {
      stepMode = stepBox.checked;
      localStorage.setItem('ggit-learn-step', stepMode ? '1' : '0');
      if (!stepMode) nextResolver?.();
    };
    const speedSeg = q('#lr-speed', root);
    const syncSpeed = () => speedSeg.querySelectorAll('button')
      .forEach((b) => b.classList.toggle('on', +b.dataset.v === speed));
    speedSeg.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      speed = +b.dataset.v;
      localStorage.setItem('ggit-learn-speed', String(speed));
      syncSpeed();
    };
    syncSpeed();

    termIn.addEventListener('keydown', onKey);
    q('.lr-term', root).addEventListener('click', (e) => {
      if (!e.target.closest('button') && !getSelection().toString()) termIn.focus();
    });
    q('#lr-lessons', root).addEventListener('click', onLessonClick);
    stage.addEventListener('click', onStageClick);
  }

  function onKey(e) {
    e.stopPropagation();
    if (e.key === 'Escape') {
      if (termIn.value) termIn.value = '';
      else close();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (nextResolver) { nextResolver(); return; }
      if (busy) return;
      const line = termIn.value.trim();
      termIn.value = '';
      if (line) run(line);
      return;
    }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (!history.length) return;
      histPos = Math.max(0, Math.min(history.length, histPos + (e.key === 'ArrowUp' ? -1 : 1)));
      termIn.value = history[histPos] || '';
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      complete();
    }
    if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); termOut.innerHTML = ''; }
  }

  function complete() {
    const v = termIn.value;
    const words = v.split(' ');
    const last = words[words.length - 1];
    const pool = words.length <= 1 ? ['git ', 'touch ', 'echo ', 'edit ', 'cat ', 'ls', 'rm ', 'clear', 'help', 'teammate']
      : words.length === 2 && words[0] === 'git'
        ? ['add ', 'commit -m "', 'status', 'log', 'branch ', 'switch ', 'checkout ', 'merge ', 'rebase ',
          'reset ', 'restore ', 'diff', 'push', 'pull', 'fetch', 'stash', 'tag ', 'cherry-pick ', 'revert ', 'rm ']
        : [...new Set([...Object.keys(S.work), ...Object.keys(S.index), ...Object.keys(S.local.branches),
          ...Object.keys(S.local.tags), ...Object.keys(S.local.tracking)])];
    const hits = pool.filter((p) => p.startsWith(last) && p !== last);
    if (hits.length === 1) { words[words.length - 1] = hits[0]; termIn.value = words.join(' '); }
    else if (hits.length > 1) out(hits.join('   '), 'dim');
  }

  function prompt() {
    const b = curBranch() || `(${(headId() || '').slice(0, 7)}…)`;
    const extra = S.merge ? '|MERGING' : '';
    q('#lr-prompt', root).innerHTML = `<span class="pp-dir">~/playground</span> <span class="pp-br">(${html(b)}${extra})</span> $`;
  }

  function out(text, cls = '') {
    if (silent) return;
    const d = document.createElement('div');
    d.className = `lr-line ${cls}`;
    d.textContent = text;
    termOut.appendChild(d);
    termOut.scrollTop = termOut.scrollHeight;
  }

  // ============================================================ rendering
  function fileCard(name, zone, status, content) {
    const lines = content == null ? 0 : content.split('\n').filter(Boolean).length;
    const label = { '?': 'untracked', M: 'modified', D: 'deleted', A: 'new file', U: 'conflict' }[status] || 'unchanged';
    const preview = content == null ? '(deleted)' : (content.split('\n').filter(Boolean).pop() || '(empty)');
    return `<div class="lr-file st-${status === '?' ? 'u' : status || 'c'}" data-k="${zone}:${html(name)}"
      data-v="${html(content ?? '∅')}" data-file="${html(name)}" title="${html(content ?? '(deleted)')}">
      <div class="lf-ico"><span>${html(status === '?' ? 'U' : status || '✓')}</span></div>
      <div class="lf-body"><div class="lf-name">${html(name)}</div>
      <div class="lf-meta">${label} · ${lines} line${lines === 1 ? '' : 's'} · <i>${html(preview.slice(0, 28))}</i></div></div>
    </div>`;
  }

  function layout(ids, tipsOrder) {
    const list = [...ids].map((id) => store[id]).sort((a, b) => a.seq - b.seq);
    const col = new Map(list.map((c, i) => [c.id, i]));
    const lane = new Map();
    const occ = [];
    const fits = (l, a, b) => !(occ[l] || []).some(([x, y]) => a <= y + 0.5 && x <= b + 0.5);
    const chain = (tip) => {
      const seg = [];
      let cur = tip;
      while (cur && ids.has(cur) && !lane.has(cur)) { seg.push(cur); cur = store[cur].parents[0]; }
      if (!seg.length) return;
      const lo = cur && lane.has(cur) ? col.get(cur) : col.get(seg[seg.length - 1]);
      const hi = col.get(seg[0]);
      let l = 0;
      while (!fits(l, lo, hi)) l++;
      (occ[l] ||= []).push([lo, hi]);
      for (const id of seg) lane.set(id, l);
    };
    for (const t of tipsOrder) chain(t);
    for (const c of [...list].reverse()) chain(c.id);
    return { col, lane, lanes: Math.max(1, occ.length), n: list.length };
  }

  function graphHtml(kind) {
    const isLocal = kind === 'c';
    const XS = isLocal ? 74 : 46;
    const YS = isLocal ? 92 : 64;
    const L = S.local;
    const ids = isLocal ? L.has : S.remote.has;
    const branches = isLocal ? L.branches : S.remote.branches;
    const tips = ['main', 'master'].map((b) => branches[b]).filter(Boolean);
    if (isLocal) {
      tips.push(headId(), ...Object.keys(branches).sort().map((b) => branches[b]),
        ...Object.values(L.tracking), ...Object.values(L.tags));
    } else tips.push(...Object.keys(branches).sort().map((b) => branches[b]));
    const lay = layout(ids, tips.filter(Boolean));
    const alive = isLocal ? reachableLocal() : reachableRemote();

    // Labels stacked above each commit.
    const labels = new Map();
    const add = (id, h) => { if (id) (labels.get(id) || labels.set(id, []).get(id)).push(h); };
    const color = (id) => laneColor(lay.lane.get(id) || 0);
    if (isLocal) {
      for (const [n, id] of Object.entries(L.tracking)) {
        add(id, `<span class="lr-ref remote" data-k="o:${html(n)}" style="--rc:${color(id)}">☁ ${html(n)}</span>`);
      }
      for (const [n, id] of Object.entries(L.tags)) {
        add(id, `<span class="lr-ref tag" data-k="t:${html(n)}">⌂ ${html(n)}</span>`);
      }
      for (const [n, id] of Object.entries(L.branches)) {
        const cur = n === curBranch();
        add(id, `<span class="lr-ref branch${cur ? ' cur' : ''}" data-k="b:${html(n)}" style="--rc:${color(id)}">${html(n)}</span>`);
      }
      const hid = headId();
      if (hid) {
        const det = !curBranch();
        add(hid, `<span class="lr-ref head${det ? ' detached' : ''}" data-k="h:HEAD"
          title="${det ? 'Detached HEAD: you are on a commit, not a branch' : `HEAD points at ${curBranch()}`}">HEAD${det ? ' (detached)' : ` → ${html(curBranch())}`}</span>`);
      }
    } else {
      for (const [n, id] of Object.entries(branches)) {
        add(id, `<span class="lr-ref branch" data-k="rb:${html(n)}" style="--rc:${color(id)}">${html(n)}</span>`);
      }
    }
    let maxStack = 0;
    for (const v of labels.values()) maxStack = Math.max(maxStack, v.length);
    const padT = 26 + Math.min(maxStack, 4) * 21;
    const pos = (id) => ({ x: 58 + lay.col.get(id) * XS, y: padT + lay.lane.get(id) * YS });
    const W = 58 * 2 + Math.max(0, lay.n - 1) * XS;
    const H = padT + (lay.lanes - 1) * YS + 34;

    let svg = '';
    const edges = new Set();
    for (const id of ids) {
      const c = store[id];
      c.parents.forEach((p, i) => {
        if (!ids.has(p)) return;
        const a = pos(p), b = pos(id);
        const k = `${p}>${id}`;
        edges.add(k);
        // Branching off: bend right after the parent. Merging in: run along the lane, bend just before the child.
        const bend = XS * 0.9;
        const d = a.y === b.y ? `M${a.x} ${a.y} L${b.x} ${b.y}`
          : i === 0
            ? `M${a.x} ${a.y} C${a.x + bend * 0.55} ${a.y}, ${a.x + bend * 0.45} ${b.y}, ${a.x + bend} ${b.y} L${b.x} ${b.y}`
            : `M${a.x} ${a.y} L${b.x - bend} ${a.y} C${b.x - bend * 0.45} ${a.y}, ${b.x - bend * 0.55} ${b.y}, ${b.x} ${b.y}`;
        const lost = !alive.has(id);
        const fresh = !prevEdges[kind].has(k) && !silent;
        svg += `<path d="${d}" class="lr-edge${lost ? ' lost' : ''}${fresh ? ' draw' : ''}" pathLength="1"
          style="--lc:${color(i === 0 ? id : p)}${fresh ? `;--d:${dur(600)}ms` : ''}"/>`;
      });
    }
    prevEdges[kind] = edges;

    let nodes = '';
    for (const id of ids) {
      const c = store[id];
      const { x, y } = pos(id);
      const lost = !alive.has(id);
      const isHead = isLocal && id === headId();
      (labels.get(id) || []).forEach((h, i) => {
        const at = `left:${x}px;top:${y - 30 - i * 21}px;`;
        nodes += h.includes('style="') ? h.replace('style="', `style="${at}`) : h.replace('<span ', `<span style="${at}" `);
      });
      nodes += `<div class="lr-node${lost ? ' lost' : ''}${isHead ? ' head' : ''}${c.parents.length > 1 ? ' merge' : ''}"
        data-k="${kind}:${id}" data-commit="${id}" style="left:${x}px;top:${y}px;--lc:${color(id)}"
        title="${html(c.msg)}${lost ? '\n(no branch points here any more — git will eventually garbage-collect it)' : ''}">
        <div class="lr-cid">${id.slice(0, 4)}</div>
        <div class="lr-cmsg">${html(c.msg.length > 14 ? `${c.msg.slice(0, 13)}…` : c.msg)}</div>
      </div>`;
    }
    return `<div class="lr-graph" style="width:${W}px;height:${H}px">
      <svg width="${W}" height="${H}">${svg}</svg>${nodes}</div>`;
  }

  function render() {
    const work = Object.keys(S.work);
    const deleted = Object.keys(S.index).filter((n) => !(n in S.work));
    const wnames = [...new Set([...work, ...deleted])].sort();
    const staged = stagedChanges();
    const conflicted = S.merge ? [...S.merge.conflicts] : [];
    const remoteEmpty = !S.remote.has.size;
    const localEmpty = !S.local.has.size;

    const prevScroll = {};
    stage.querySelectorAll('[data-scroll]').forEach((el) => { prevScroll[el.dataset.scroll] = el.scrollLeft; });

    stage.innerHTML = `
      <div class="lr-zones">
        <section class="lr-zone z-work">
          <header><b>Working directory</b><small>the files on your disk</small></header>
          <div class="lr-cards">${wnames.length ? wnames.map((n) => fileCard(n, 'w', workStatus(n), S.work[n])).join('')
            : '<div class="lr-empty">No files yet — try <code>touch hello.txt</code></div>'}</div>
          ${S.stash.length ? `<div class="lr-shelf"><div class="lr-shelf-h">Stash</div>${S.stash.map((s, i) =>
            `<div class="lr-stash" data-k="st:${s.key}"><b>stash@{${i}}</b> ${html(s.msg)}</div>`).join('')}</div>` : ''}
        </section>
        <div class="lr-arrow"><span>git add</span><svg viewBox="0 0 24 24"><path d="M4 12h15m-5-5 5 5-5 5"/></svg></div>
        <section class="lr-zone z-stage">
          <header><b>Staging area</b><small>what the next commit will contain</small></header>
          <div class="lr-cards">${staged.map((s) => fileCard(s.name, 's', s.kind, S.index[s.name])).join('')}
            ${conflicted.map((n) => `<div class="lr-file st-U" data-k="s:${html(n)}"><div class="lf-ico"><span>!</span></div>
              <div class="lf-body"><div class="lf-name">${html(n)}</div><div class="lf-meta">conflict — fix it, then git add</div></div></div>`).join('')}
            ${!staged.length && !conflicted.length ? '<div class="lr-empty">Nothing staged. Changes you <code>git add</code> wait here.</div>' : ''}
          </div>
        </section>
        <div class="lr-arrow"><span>git push</span><svg viewBox="0 0 24 24"><path d="M4 9h15m-5-5 5 5-5 5"/><path d="M20 15H5m5-5-5 5 5 5" opacity=".45"/></svg><span class="dim">fetch / pull</span></div>
        <section class="lr-zone z-remote">
          <header><b>Remote · origin</b><small>the shared copy, e.g. on GitHub</small></header>
          <div class="lr-gwrap" data-scroll="r">${remoteEmpty
            ? '<div class="lr-empty">Empty. <code>git push</code> sends your commits here.</div>' : graphHtml('r')}</div>
        </section>
      </div>
      <section class="lr-zone z-repo">
        <header><b>Local repository</b><small>your commits (.git) — click a commit to inspect it</small>
          ${S.merge ? '<span class="lr-flag warn">merge in progress</span>' : ''}
          ${!curBranch() && headId() ? '<span class="lr-flag warn">detached HEAD</span>' : ''}
        </header>
        <div class="lr-gwrap" data-scroll="c">${localEmpty
          ? '<div class="lr-empty">No commits yet. Stage some files and run <code>git commit -m "first"</code>.</div>' : graphHtml('c')}</div>
      </section>`;
    stage.querySelectorAll('[data-scroll]').forEach((el) => {
      el.scrollLeft = prevScroll[el.dataset.scroll] ?? el.scrollWidth;
    });
    prompt();
  }

  function scrollGraphsToEnd() {
    stage.querySelectorAll('[data-scroll]').forEach((el) => { el.scrollLeft = el.scrollWidth; });
  }

  // ============================================================ animation
  function snapshot() {
    const m = new Map();
    stage.querySelectorAll('[data-k]').forEach((el) => m.set(el.dataset.k, { el, rect: el.getBoundingClientRect() }));
    return m;
  }

  function ghostOf(el, rect) {
    const g = el.cloneNode(true);
    g.removeAttribute('data-k');
    g.classList.add('lr-ghost');
    Object.assign(g.style, {
      left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    });
    fx.appendChild(g);
    return g;
  }

  async function animate(before, opts = {}) {
    if (opts.scroll !== false) scrollGraphsToEnd();
    const after = snapshot();
    const D = dur(620);
    const ease = 'cubic-bezier(.22, 1, .36, 1)';
    const spring = 'cubic-bezier(.34, 1.56, .64, 1)';
    const anims = [];
    const movedSvgs = new Set();
    if (!D) return;

    for (const [k, { el, rect }] of after) {
      const fromKey = before.has(k) ? k : opts.from?.[k];
      const old = fromKey && before.get(fromKey);
      if (old) {
        const dx = old.rect.left - rect.left;
        const dy = old.rect.top - rect.top;
        const sx = old.rect.width / (rect.width || 1);
        const sy = old.rect.height / (rect.height || 1);
        const moved = Math.abs(dx) + Math.abs(dy) > 0.5;
        const resized = fromKey !== k && (Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02);
        if (moved || resized) {
          el.style.transformOrigin = 'top left';
          anims.push(el.animate([
            { transform: `translate(${dx}px, ${dy}px) scale(${resized ? sx : 1}, ${resized ? sy : 1})` },
            { transform: 'none' },
          ], { duration: D, easing: ease }));
          const svg = el.closest('.lr-graph')?.querySelector('svg');
          if (svg && fromKey === k) movedSvgs.add(svg);
          el.classList.add('lr-moving');
          setTimeout(() => el.classList.remove('lr-moving'), D);
        }
        if (fromKey === k && old.el.dataset.v !== undefined && old.el.dataset.v !== el.dataset.v) {
          anims.push(el.animate([{ boxShadow: '0 0 0 0 var(--amber)' },
            { boxShadow: '0 0 0 6px color-mix(in srgb, var(--amber) 35%, transparent)' },
            { boxShadow: '0 0 0 0 transparent' }], { duration: D * 1.2 }));
        }
      } else {
        anims.push(el.animate([{ opacity: 0, transform: 'scale(.3)' }, { opacity: 1, transform: 'none' }],
          { duration: D, easing: spring, delay: opts.enterDelay ? D * 0.55 : 0, fill: 'backwards' }));
      }
    }
    for (const [k, { el, rect }] of before) {
      if (after.has(k) || opts.keep?.has(k)) continue;
      if (Object.values(opts.from || {}).includes(k) && !opts.ghostFrom?.includes(k)) continue;
      const g = ghostOf(el, rect);
      anims.push(g.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.6)' }],
        { duration: D * 0.7, easing: ease, fill: 'forwards' }).finished.then(() => g.remove()));
    }
    // Things that "fly" into something else, e.g. staged files into a new commit.
    for (const [fromKeys, toKey] of opts.fly || []) {
      const target = after.get(toKey);
      if (!target) continue;
      fromKeys.forEach((fk, i) => {
        const src = before.get(fk);
        if (!src) return;
        const g = ghostOf(src.el, src.rect);
        const tx = target.rect.left + target.rect.width / 2 - (src.rect.left + src.rect.width / 2);
        const ty = target.rect.top + target.rect.height / 2 - (src.rect.top + src.rect.height / 2);
        anims.push(g.animate([
          { transform: 'none', opacity: 1 },
          { transform: `translate(${tx * 0.5}px, ${ty * 0.5 - 30}px) scale(.6)`, opacity: 1, offset: 0.5 },
          { transform: `translate(${tx}px, ${ty}px) scale(.12)`, opacity: 0.2 },
        ], { duration: D * 1.15, delay: i * 70, easing: 'cubic-bezier(.5, 0, .3, 1)', fill: 'forwards' })
          .finished.then(() => g.remove()));
      });
    }
    if (movedSvgs.size) {
      for (const svg of movedSvgs) {
        anims.push(svg.animate([{ opacity: 0 }, { opacity: 0, offset: 0.55 }, { opacity: 1 }], { duration: D }));
      }
    }
    await Promise.all(anims.map((a) => (a.finished ? a.finished.catch(() => {}) : a)));
  }

  let stepNo = 0;
  async function step(text, mutate, opts = {}) {
    if (silent) { mutate?.(); return; }
    stepNo++;
    q('#lr-narr-step', root).textContent = `Step ${stepNo}`;
    const t = q('#lr-narr-text', root);
    t.innerHTML = text;
    narr.classList.remove('idle');
    t.animate?.([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: dur(260) });
    const d = document.createElement('div');
    d.className = 'lr-line narr';
    d.innerHTML = `<span class="n">${stepNo}</span> ${text}`;
    termOut.appendChild(d);
    termOut.scrollTop = termOut.scrollHeight;

    const before = snapshot();
    mutate?.();
    render();
    await animate(before, opts);
    await wait(opts.hold ?? 520);
    if (stepMode) {
      const btn = q('#lr-next', root);
      btn.classList.remove('hidden');
      await new Promise((r) => { nextResolver = r; });
      nextResolver = null;
      btn.classList.add('hidden');
    }
  }

  // ============================================================ commands
  function tokenize(line) {
    const toks = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(line))) toks.push(m[1] ?? m[2] ?? m[3]);
    return toks;
  }

  function parseFlags(args, withValue = []) {
    const flags = {};
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^-[a-zA-Z]{2,}$/.test(a) && !withValue.includes(a)) {
        for (const ch of a.slice(1)) flags[`-${ch}`] = withValue.includes(`-${ch}`) ? args[++i] : true;
      }
      else if (a.startsWith('-') && a.length > 1) {
        if (withValue.includes(a)) flags[a] = args[++i];
        else if (a.includes('=')) { const [k, v] = a.split('='); flags[k] = v; }
        else flags[a] = true;
      } else rest.push(a);
    }
    return { flags, rest };
  }

  function needRepo() { if (!S.local.has.size) fail('your current branch does not have any commits yet'); }
  const short = (id) => id.slice(0, 7);
  const code = (s) => `<code>${html(s)}</code>`;

  // Move between commits: update index/work for files that differ, refusing to clobber local changes.
  function checkoutPlan(targetId) {
    const from = headTree();
    const to = targetId ? store[targetId].tree : {};
    const names = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter((n) => from[n] !== to[n]);
    const blocked = names.filter((n) => S.index[n] !== from[n] || (S.work[n] !== from[n] && !(S.work[n] === to[n])));
    if (blocked.length) {
      fail(`Your local changes to the following files would be overwritten by checkout:\n\t${blocked.join('\n\t')}\nPlease commit your changes or stash them before you switch branches.`);
    }
    return () => {
      for (const n of names) {
        if (n in to) { S.index[n] = to[n]; S.work[n] = to[n]; } else { delete S.index[n]; delete S.work[n]; }
      }
    };
  }

  function threeWay(baseT, oursT, theirsT, theirLabel) {
    const names = new Set([...Object.keys(baseT), ...Object.keys(oursT), ...Object.keys(theirsT)]);
    const tree = {};
    const conflicts = [];
    for (const n of names) {
      const b = baseT[n], o = oursT[n], t = theirsT[n];
      let r;
      if (o === t) r = o;
      else if (o === b) r = t;
      else if (t === b) r = o;
      else {
        conflicts.push(n);
        r = `<<<<<<< HEAD\n${o ?? ''}\n=======\n${t ?? ''}\n>>>>>>> ${theirLabel}`;
      }
      if (r !== undefined) tree[n] = r;
    }
    return { tree, conflicts };
  }

  // Apply the change made by `commitId` (relative to its parent) on top of the current HEAD tree.
  function applyPatch(commitId, reverse = false) {
    const c = store[commitId];
    const parent = c.parents[0] ? store[c.parents[0]].tree : {};
    const [a, b] = reverse ? [c.tree, parent] : [parent, c.tree];
    const tree = { ...headTree() };
    const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((n) => a[n] !== b[n]);
    const conflicts = [];
    for (const n of names) {
      if (tree[n] === a[n] || tree[n] === b[n]) { if (n in b) tree[n] = b[n]; else delete tree[n]; }
      else conflicts.push(n);
    }
    return { tree, conflicts, changed: names };
  }

  const shell = {
    help() {
      out(`Shell:  touch <file> · echo "text" > <file> (or >>) · edit <file> · cat <file> · rm <file> · ls · clear
Git:    init · status · add <file|.> · commit -m "msg" [-a] [--amend] · log [--oneline]
        diff [--staged] · restore [--staged] <file> · rm <file>
        branch [name] [-d name] · switch [-c] <name> · checkout [-b] <name|commit>
        merge <branch> [--abort] · rebase <branch> · cherry-pick <commit> · revert <commit>
        reset [--soft|--mixed|--hard] <commit>   e.g. HEAD~1
        stash [pop|list] · tag [name] · fetch · pull · push [-u] [--force]
Extra:  teammate   — someone else pushes a commit to origin (then try fetch / pull)
Tip:    Tab completes, ↑/↓ for history, Ctrl+L clears. Click any commit to inspect it.`, 'dim');
    },
    clear() { termOut.innerHTML = ''; },
    ls() { out(Object.keys(S.work).sort().join('  ') || '(empty)'); },
    cat(args) {
      if (!args[0]) fail('usage: cat <file>');
      if (!(args[0] in S.work)) fail(`cat: ${args[0]}: No such file or directory`);
      out(S.work[args[0]] || '(empty file)');
    },
    async touch(args) {
      if (!args.length) fail('usage: touch <file>');
      const created = args.filter((f) => !(f in S.work));
      if (!created.length) { out('(file already exists — touch leaves it as is)', 'dim'); return; }
      const many = created.length > 1;
      await step(`New file${many ? 's' : ''} ${created.map(code).join(', ')} ${many ? 'appear' : 'appears'} in the <b>working directory</b>. Git notices ${many ? 'them' : 'it'} but isn't tracking ${many ? 'them' : 'it'} yet — ${many ? 'they are' : 'it is'} <b>untracked</b>.`,
        () => { for (const f of created) S.work[f] = ''; });
    },
    async echo(args, raw) {
      const m = /^echo\s+(?:"([^"]*)"|'([^']*)'|(.*?))\s*(>>?)\s*(\S+)\s*$/.exec(raw);
      if (!m) { out(args.join(' ')); return; }
      const text = m[1] ?? m[2] ?? m[3];
      const file = m[5];
      const append = m[4] === '>>';
      const existed = file in S.work;
      await step(`${existed ? (append ? 'Appending a line to' : 'Overwriting') : 'Creating'} ${code(file)} in the <b>working directory</b>. ${S.index[file] !== undefined ? 'It now differs from the staged copy, so git shows it as <b>modified</b>.' : 'Git sees it as <b>untracked</b>.'}`,
        () => { S.work[file] = append && existed && S.work[file] ? `${S.work[file]}\n${text}` : text; });
    },
    async edit(args) {
      if (!args[0]) fail('usage: edit <file>');
      const f = args[0];
      const existed = f in S.work;
      S.editCount++;
      const line = `change ${S.editCount}`;
      await step(`You edit ${code(f)} (adding the line “${html(line)}”). Only the <b>working directory</b> changes — the staging area and commits still hold the old version.`,
        () => { S.work[f] = existed && S.work[f] ? `${S.work[f]}\n${line}` : line; });
    },
    async rm(args) {
      const files = args.filter((a) => !a.startsWith('-'));
      if (!files.length) fail('usage: rm <file>');
      for (const f of files) if (!(f in S.work)) fail(`rm: cannot remove '${f}': No such file or directory`);
      await step(`Deleting ${files.map(code).join(', ')} from the <b>working directory</b>. Git still remembers ${files.length > 1 ? 'them' : 'it'} in the last commit, so this shows up as a <b>deleted</b> change.`,
        () => { for (const f of files) delete S.work[f]; });
    },
    async teammate() {
      const tip = S.remote.branches.main;
      if (!tip) fail('origin has no main branch yet — run git push first so your teammate has something to build on.');
      const tree = { ...store[tip].tree };
      const n = Object.keys(store).length;
      tree['team-notes.txt'] = `${tree['team-notes.txt'] ? `${tree['team-notes.txt']}\n` : ''}note from Sam #${n}`;
      const c = makeCommit([tip], `Sam: add note #${n}`, tree);
      await step(`Meanwhile your teammate Sam pushes commit ${code(short(c.id))} to <b>origin/main</b>. Your local repository doesn't know about it yet — nothing on your machine changed.`,
        () => { S.remote.has.add(c.id); S.remote.branches.main = c.id; });
      out('Sam pushed a commit to origin/main. Try: git fetch  (or git pull)', 'hint');
    },
  };

  const git = {
    async init() {
      if (S.local.has.size || Object.keys(S.work).length) {
        out('Reinitialized existing Git repository in ~/playground/.git/  (nothing changes)');
        return;
      }
      freshState();
      render();
      out('Initialized empty Git repository in ~/playground/.git/');
      out('(origin is pre-configured in this sandbox, so git push works straight away)', 'dim');
      await step('A brand-new repository: an empty working directory, an empty staging area and no commits. You are on the <b>main</b> branch, but it doesn\'t point anywhere until the first commit.', null);
    },

    status() {
      const b = curBranch();
      out(b ? `On branch ${b}` : `HEAD detached at ${short(headId())}`);
      const up = b && S.local.upstream[b];
      if (up && S.local.tracking[up]) {
        const lt = S.local.branches[b], rt = S.local.tracking[up];
        const ahead = [...ancestors(lt)].filter((x) => !ancestors(rt).has(x)).length;
        const behind = [...ancestors(rt)].filter((x) => !ancestors(lt).has(x)).length;
        if (!ahead && !behind) out(`Your branch is up to date with '${up}'.`);
        else if (ahead && !behind) out(`Your branch is ahead of '${up}' by ${ahead} commit${ahead > 1 ? 's' : ''}.  (use "git push")`);
        else if (!ahead) out(`Your branch is behind '${up}' by ${behind} commit${behind > 1 ? 's' : ''}.  (use "git pull")`);
        else out(`Your branch and '${up}' have diverged (${ahead} and ${behind} different commits).`);
      }
      if (S.merge) out('You have unmerged paths.  (fix conflicts and run "git commit")', 'warn');
      if (!S.local.has.size) out('\nNo commits yet');
      const staged = stagedChanges();
      const label = { A: 'new file:', M: 'modified:', D: 'deleted:' };
      if (S.merge?.conflicts.size) {
        out('\nUnmerged paths:');
        for (const n of S.merge.conflicts) out(`\tboth modified:   ${n}`, 'bad');
      }
      if (staged.length) {
        out('\nChanges to be committed:');
        for (const s of staged) out(`\t${label[s.kind].padEnd(12)}${s.name}`, 'good');
      }
      const un = unstagedNames().filter((n) => !S.merge?.conflicts.has(n));
      if (un.length) {
        out('\nChanges not staged for commit:');
        for (const n of un) out(`\t${(workStatus(n) === 'D' ? 'deleted:' : 'modified:').padEnd(12)}${n}`, 'bad');
      }
      const ut = untrackedNames();
      if (ut.length) {
        out('\nUntracked files:');
        for (const n of ut) out(`\t${n}`, 'bad');
      }
      if (!staged.length && !un.length && !ut.length && !S.merge) out('\nnothing to commit, working tree clean');
    },

    async add(args) {
      const { flags, rest } = parseFlags(args);
      const all = flags['-A'] || flags['--all'] || rest.includes('.');
      if (!all && !rest.length) fail('Nothing specified, nothing added. Maybe you wanted to say \'git add .\'?');
      const known = new Set([...Object.keys(S.work), ...Object.keys(S.index)]);
      const files = all ? [...known].sort() : rest;
      for (const f of files) if (!known.has(f)) fail(`pathspec '${f}' did not match any files`);
      const changing = files.filter((f) => S.index[f] !== S.work[f] || S.merge?.conflicts.has(f));
      if (!changing.length) { out('(nothing new to add — the staging area already matches)', 'dim'); return; }
      const from = {};
      for (const f of changing) from[`s:${f}`] = `w:${f}`;
      const resolved = changing.filter((f) => S.merge?.conflicts.has(f));
      await step(`Git copies the current version of ${changing.map(code).join(', ')} from the working directory into the <b>staging area</b>. ${resolved.length ? 'That also marks the conflict as <b>resolved</b>.' : 'This is the snapshot that the next commit will save.'}`,
        () => {
          for (const f of changing) {
            if (f in S.work) S.index[f] = S.work[f]; else delete S.index[f];
            S.merge?.conflicts.delete(f);
          }
        }, { from });
    },

    async commit(args) {
      const { flags } = parseFlags(args, ['-m']);
      if (flags['-a']) {
        const tracked = unstagedNames();
        if (tracked.length) {
          const from = {};
          for (const f of tracked) from[`s:${f}`] = `w:${f}`;
          await step(`<b>-a</b> first stages every change to files git already tracks: ${tracked.map(code).join(', ')}. (Untracked files are left alone.)`,
            () => { for (const f of tracked) { if (f in S.work) S.index[f] = S.work[f]; else delete S.index[f]; } }, { from });
        }
      }
      if (S.merge?.conflicts.size) fail('Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use \'git add <file>\'.');
      const amend = flags['--amend'];
      const staged = stagedChanges();
      let msg = flags['-m'];
      if (amend) {
        needRepo();
        msg = msg || store[headId()].msg;
      } else {
        if (!staged.length && !S.merge) fail(`nothing to commit${untrackedNames().length ? ' (untracked files present — use "git add" to track)' : ', working tree clean'}`);
        if (!msg || msg === true) {
          if (S.merge) msg = S.merge.msg;
          else fail('Please supply a message with -m "your message" (this sandbox has no editor).');
        }
      }
      const old = headId();
      const parents = amend ? store[old].parents : [old, S.merge?.theirs].filter(Boolean);
      const c = makeCommit(parents, msg, S.index);
      const b = curBranch();
      const fly = [[staged.map((s) => `s:${s.name}`), `c:${c.id}`]];
      await step(amend
        ? `<b>--amend</b> doesn't edit the old commit (commits never change). Git makes a <b>new</b> commit ${code(short(c.id))} with the staged snapshot and the same parent${parents.length > 1 ? 's' : ''}, replacing ${code(short(old))}.`
        : `Git takes a snapshot of everything in the staging area and saves it as commit ${code(short(c.id))} “${html(msg)}”.${parents.length > 1 ? ' It has <b>two parents</b>, which makes it a <b>merge commit</b>.' : parents.length ? ` Its parent is ${code(short(parents[0]))}, the commit you were on.` : ' It\'s the first commit, so it has no parent.'}`,
        () => { S.local.has.add(c.id); if (!b) S.local.head = { id: c.id }; else S.local.branches[b] = c.id; S.merge = null; },
        { fly, enterDelay: true });
      out(`[${b || 'detached HEAD'} ${short(c.id)}] ${msg}`);
      if (b) {
        await step(`The branch ${code(b)} moves forward to the new commit, and HEAD comes with it. A branch is just a <b>movable label</b> pointing at a commit.`, null, { hold: 300 });
      }
      if (staged.length) out(` ${staged.length} file${staged.length > 1 ? 's' : ''} changed`, 'dim');
    },

    log(args) {
      needRepo();
      const { flags } = parseFlags(args);
      const ids = [...ancestors(headId())].map((id) => store[id]).sort((a, b) => b.seq - a.seq);
      for (const c of ids) {
        const refs = [];
        if (c.id === headId()) refs.push(curBranch() ? `HEAD -> ${curBranch()}` : 'HEAD');
        for (const [n, id] of Object.entries(S.local.branches)) if (id === c.id && n !== curBranch()) refs.push(n);
        for (const [n, id] of Object.entries(S.local.tracking)) if (id === c.id) refs.push(n);
        for (const [n, id] of Object.entries(S.local.tags)) if (id === c.id) refs.push(`tag: ${n}`);
        const deco = refs.length ? ` (${refs.join(', ')})` : '';
        if (flags['--oneline']) out(`${short(c.id)}${deco} ${c.msg}`, 'log');
        else {
          out(`commit ${c.id}${deco}`, 'log');
          if (c.parents.length > 1) out(`Merge: ${c.parents.map(short).join(' ')}`, 'dim');
          out(`    ${c.msg}\n `);
        }
      }
    },

    diff(args) {
      const { flags, rest } = parseFlags(args);
      const staged = flags['--staged'] || flags['--cached'];
      const a = staged ? headTree() : S.index;
      const b = staged ? S.index : S.work;
      const names = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
        .filter((n) => (staged || n in S.index) && a[n] !== b[n] && (!rest.length || rest.includes(n)));
      if (!names.length) { out(staged ? '(no staged changes)' : '(no unstaged changes — try git diff --staged)', 'dim'); return; }
      for (const n of names) {
        out(`diff --git a/${n} b/${n}`, 'log');
        const al = (a[n] ?? '').split('\n').filter((x) => x !== '' || a[n] === undefined);
        const bl = (b[n] ?? '').split('\n').filter((x) => x !== '' || b[n] === undefined);
        let i = 0;
        while (i < al.length && i < bl.length && al[i] === bl[i]) i++;
        for (const l of al.slice(Math.max(0, i - 2), i)) out(`  ${l}`, 'dim');
        for (const l of al.slice(i)) if (a[n] !== undefined) out(`- ${l}`, 'bad');
        for (const l of bl.slice(i)) if (b[n] !== undefined) out(`+ ${l}`, 'good');
      }
    },

    async restore(args) {
      const { flags, rest } = parseFlags(args);
      if (!rest.length) fail('you must specify path(s) to restore');
      const files = rest.includes('.') ? [...new Set([...Object.keys(S.work), ...Object.keys(S.index)])] : rest;
      if (flags['--staged'] || flags['-S']) {
        const head = headTree();
        const ch = files.filter((f) => S.index[f] !== head[f]);
        if (!ch.length) { out('(nothing staged for those files)', 'dim'); return; }
        const from = {};
        for (const f of ch) from[`w:${f}`] = `s:${f}`;
        await step(`<b>Unstaging</b> ${ch.map(code).join(', ')}: the staging area goes back to the version in the last commit. Your edits are still safe in the working directory.`,
          () => { for (const f of ch) { if (f in head) S.index[f] = head[f]; else delete S.index[f]; } }, { from, ghostFrom: ch.map((f) => `s:${f}`) });
      } else {
        const ch = files.filter((f) => f in S.index && S.work[f] !== S.index[f]);
        for (const f of files) if (!(f in S.index) && !(f in S.work)) fail(`pathspec '${f}' did not match any file(s) known to git`);
        if (!ch.length) { out('(no unstaged changes to throw away)', 'dim'); return; }
        await step(`<b>Discarding</b> your changes to ${ch.map(code).join(', ')}: the file is overwritten with the staged version. ⚠️ Un-committed edits thrown away like this can't be recovered.`,
          () => { for (const f of ch) S.work[f] = S.index[f]; });
      }
    },

    async rm(args) {
      const { rest, flags } = parseFlags(args);
      if (!rest.length) fail('usage: git rm <file>');
      for (const f of rest) if (!(f in S.index)) fail(`pathspec '${f}' did not match any files`);
      await step(`${flags['--cached'] ? 'Removing' : 'Deleting'} ${rest.map(code).join(', ')} from the staging area${flags['--cached'] ? ' only (the file stays on disk, now untracked)' : ' and the working directory'}. The deletion is staged for the next commit.`,
        () => { for (const f of rest) { delete S.index[f]; if (!flags['--cached']) delete S.work[f]; } });
    },

    async branch(args) {
      const { flags, rest } = parseFlags(args);
      const del = flags['-d'] || flags['-D'] || flags['--delete'];
      if (del) {
        const n = rest[0];
        if (!n || !S.local.branches[n]) fail(`branch '${n}' not found.`);
        if (n === curBranch()) fail(`Cannot delete branch '${n}' checked out — switch to another branch first.`);
        if (!flags['-D'] && !isAncestor(S.local.branches[n], headId())) {
          fail(`The branch '${n}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${n}'.`);
        }
        const id = S.local.branches[n];
        await step(`Deleting the label ${code(n)}. Only the <b>pointer</b> goes away — ${isAncestor(id, headId()) ? 'its commits are still part of your current history.' : 'its commits are now unreachable (faded) and will eventually be garbage-collected.'}`,
          () => { delete S.local.branches[n]; });
        out(`Deleted branch ${n} (was ${short(id)}).`);
        return;
      }
      if (!rest.length) {
        for (const n of Object.keys(S.local.branches).sort()) out(`${n === curBranch() ? '* ' : '  '}${n}`, n === curBranch() ? 'good' : '');
        if (flags['-a'] || flags['-r']) for (const n of Object.keys(S.local.tracking)) out(`  remotes/${n}`, 'bad');
        if (!curBranch() && headId()) out(`* (HEAD detached at ${short(headId())})`, 'good');
        return;
      }
      needRepo();
      const n = rest[0];
      if (S.local.branches[n]) fail(`a branch named '${n}' already exists`);
      if (!/^[\w./-]+$/.test(n)) fail(`'${n}' is not a valid branch name`);
      const at = rest[1] ? resolve(rest[1]) : headId();
      await step(`Creating a new branch ${code(n)} pointing at ${code(short(at))}. Nothing is copied — it's just a new label. HEAD stays on ${code(curBranch() || short(headId()))}${rest[1] ? '' : ` (use ${code(`git switch ${n}`)} to move onto it)`}.`,
        () => { S.local.branches[n] = at; });
    },

    async switch(args) {
      const { flags, rest } = parseFlags(args, ['-c', '-C']);
      const create = flags['-c'] || flags['-C'];
      if (create) return switchTo(create, { create: true, start: rest[0] });
      if (!rest[0]) fail('missing branch name');
      if (!S.local.branches[rest[0]]) {
        if (S.local.tracking[`origin/${rest[0]}`]) return switchTo(rest[0], { create: true, start: `origin/${rest[0]}`, track: true });
        fail(`invalid reference: ${rest[0]}${resolve(rest[0], { quiet: true }) ? '\nhint: use git checkout (or git switch --detach) to visit a commit' : ''}`);
      }
      return switchTo(rest[0]);
    },

    async checkout(args) {
      const { flags, rest } = parseFlags(args, ['-b', '-B']);
      if (flags['-b'] || flags['-B']) return switchTo(flags['-b'] || flags['-B'], { create: true, start: rest[0] });
      if (rest[0] === '--' || (rest[0] && !S.local.branches[rest[0]] && (rest[0] in S.index) && !resolve(rest[0], { quiet: true }))) {
        return git.restore(rest.filter((r) => r !== '--'));
      }
      if (!rest[0]) fail('you must specify a branch or commit');
      if (S.local.branches[rest[0]]) return switchTo(rest[0]);
      if (S.local.tracking[`origin/${rest[0]}`]) return switchTo(rest[0], { create: true, start: `origin/${rest[0]}`, track: true });
      const id = resolve(rest[0]);
      const apply = checkoutPlan(id);
      await step(`HEAD now points <b>directly at commit</b> ${code(short(id))} instead of at a branch — this is called a <b>detached HEAD</b>. Files are updated to that snapshot. Look around freely; to keep new work, create a branch with ${code('git switch -c <name>')}.`,
        () => { apply(); S.local.head = { id }; });
    },

    async merge(args) {
      const { flags, rest } = parseFlags(args, ['-m']);
      if (flags['--abort']) {
        if (!S.merge) fail('There is no merge to abort.');
        const t = headTree();
        await step('Aborting the merge: the working directory and staging area go back to how they were before you ran <b>git merge</b>.',
          () => { S.index = { ...t }; S.work = { ...t }; S.merge = null; });
        return;
      }
      if (S.merge) fail('You have not concluded your merge. Fix conflicts and commit, or run git merge --abort.');
      needRepo();
      if (!rest[0]) fail('specify a branch to merge, e.g. git merge feature');
      const theirs = resolve(rest[0]);
      const ours = headId();
      if (isAncestor(theirs, ours)) { out('Already up to date.'); return; }
      if (isDirty()) fail('Your local changes would be overwritten by merge. Commit or stash them first.');
      const here = curBranch() || 'HEAD';
      if (isAncestor(ours, theirs) && !flags['--no-ff']) {
        const apply = checkoutPlan(theirs);
        out(`Updating ${short(ours)}..${short(theirs)}\nFast-forward`);
        await step(`${code(here)} is directly behind ${code(rest[0])}: there's nothing to combine. Git does a <b>fast-forward</b> — it simply slides the ${code(here)} label forward. No new commit is created.`,
          () => { apply(); if (curBranch()) S.local.branches[curBranch()] = theirs; else S.local.head = { id: theirs }; });
        return;
      }
      const base = mergeBase(ours, theirs);
      await step(`Both branches have new commits since they split at ${code(short(base))} (the <b>merge base</b>). Git compares each side against that common ancestor to work out what changed.`,
        null, { hold: 700 });
      const { tree, conflicts } = threeWay(base ? store[base].tree : {}, store[ours].tree, store[theirs].tree, rest[0]);
      const msg = flags['-m'] || `Merge branch '${rest[0]}'${curBranch() && curBranch() !== 'main' ? ` into ${curBranch()}` : ''}`;
      if (conflicts.length) {
        await step(`⚠️ <b>Conflict!</b> Both sides changed ${conflicts.map(code).join(', ')} differently, so git can't decide. It writes both versions into the file between <code>&lt;&lt;&lt;&lt;&lt;&lt;&lt;</code> and <code>&gt;&gt;&gt;&gt;&gt;&gt;&gt;</code> markers and pauses the merge.`,
          () => {
            for (const [n, v] of Object.entries(tree)) { if (!conflicts.includes(n)) S.index[n] = v; S.work[n] = v; }
            S.merge = { theirs, msg, conflicts: new Set(conflicts) };
          });
        out(`CONFLICT (content): Merge conflict in ${conflicts.join(', ')}\nAutomatic merge failed; fix conflicts and then commit the result.`, 'bad');
        out(`Fix it: e.g.  echo "final text" > ${conflicts[0]}   then   git add ${conflicts[0]}   then   git commit`, 'hint');
        return;
      }
      const c = makeCommit([ours, theirs], msg, tree);
      await step(`No conflicts — git combines both sides and creates a <b>merge commit</b> ${code(short(c.id))} with <b>two parents</b>: ${code(short(ours))} and ${code(short(theirs))}. ${code(here)} moves to it.`,
        () => {
          S.local.has.add(c.id);
          S.index = { ...tree }; S.work = { ...tree };
          if (curBranch()) S.local.branches[curBranch()] = c.id; else S.local.head = { id: c.id };
        }, { enterDelay: true });
      out(`Merge made by the 'ort' strategy.`);
    },

    async rebase(args) {
      const { rest, flags } = parseFlags(args);
      if (flags['--abort'] || flags['--continue']) fail('This sandbox replays rebases in one go, so there is nothing to continue or abort.');
      needRepo();
      const b = curBranch();
      if (!b) fail('You are not on a branch. Switch to the branch you want to rebase first.');
      if (!rest[0]) fail('specify what to rebase onto, e.g. git rebase main');
      const onto = resolve(rest[0]);
      const head = headId();
      if (isAncestor(onto, head)) { out(`Current branch ${b} is up to date.`); return; }
      if (isDirty()) fail('cannot rebase: You have unstaged changes. Commit or stash them first.');
      if (isAncestor(head, onto)) return git.merge([rest[0]]);
      const base = ancestors(onto);
      const todo = [...ancestors(head)].filter((id) => !base.has(id)).map((id) => store[id])
        .sort((a, b2) => a.seq - b2.seq).filter((c) => c.parents.length === 1);
      await step(`Git finds the commits on ${code(b)} that aren't on ${code(rest[0])}: ${todo.map((c) => code(short(c.id))).join(', ')}. It will <b>replay</b> them one by one on top of ${code(short(onto))}.`,
        null, { hold: 700 });
      let tip = onto;
      const saved = S.local.head;
      for (const old of todo) {
        S.local.head = { id: tip };
        const { tree, conflicts } = applyPatch(old.id);
        if (conflicts.length) {
          S.local.head = saved;
          fail(`could not apply ${short(old.id)}... ${old.msg}\n(this sandbox can't resolve rebase conflicts — try git merge ${rest[0]} instead)`);
        }
        const c = makeCommit([tip], old.msg, tree);
        await step(`Replaying ${code(short(old.id))} “${html(old.msg)}” → new commit ${code(short(c.id))}. Same change, but a <b>new parent</b> means a <b>new commit ID</b>.`,
          () => { S.local.has.add(c.id); S.local.head = { id: c.id }; },
          { fly: [[[`c:${old.id}`], `c:${c.id}`]], enterDelay: true, keep: new Set([`c:${old.id}`]) });
        tip = c.id;
      }
      const apply = (() => { S.local.head = saved; return checkoutPlan(tip); })();
      await step(`Finally ${code(b)} is moved to the last replayed commit. The original commits are left behind with no branch (faded) — history now looks like a straight line.`,
        () => { apply(); S.local.branches[b] = tip; S.local.head = { ref: b }; });
      out(`Successfully rebased and updated refs/heads/${b}.`);
    },

    async reset(args) {
      const { flags, rest } = parseFlags(args);
      needRepo();
      const mode = flags['--hard'] ? 'hard' : flags['--soft'] ? 'soft' : 'mixed';
      const target = rest[0] ? resolve(rest[0], { quiet: true }) : headId();
      if (!target) {
        // `git reset <file>` = unstage
        if (rest[0] && (rest[0] in S.index || rest[0] in headTree())) return git.restore(['--staged', ...rest]);
        resolve(rest[0]);
      }
      const old = headId();
      const b = curBranch();
      const tree = store[target].tree;
      if (target !== old) {
        await step(`<b>Step 1 (all modes):</b> move ${code(b || 'HEAD')} from ${code(short(old))} to ${code(short(target))}.${isAncestor(old, target) ? '' : ' Commits after it are no longer on the branch (they fade out, but git keeps them for a while — <code>git reflog</code> can find them).'}`,
          () => { if (b) S.local.branches[b] = target; else S.local.head = { id: target }; });
      }
      if (mode === 'soft') {
        await step('<b>--soft</b> stops here: the staging area and your files are untouched, so the undone commit\'s changes show up as <b>staged</b>, ready to commit again.', null);
        return;
      }
      const wasTracked = new Set(Object.keys(S.index));
      await step(`<b>Step 2 (${mode}):</b> the staging area is reset to match ${code(short(target))}.${mode === 'mixed' ? ' Your files on disk keep their changes — they\'re now <b>unstaged</b>.' : ''}`,
        () => { S.index = { ...tree }; });
      if (mode === 'hard') {
        await step('<b>Step 3 (--hard):</b> the working directory is overwritten to match too. ⚠️ Uncommitted changes are gone for good.',
          () => {
            for (const n of Object.keys(S.work)) if (wasTracked.has(n) || n in tree) delete S.work[n];
            Object.assign(S.work, tree);
          });
      }
      out(`HEAD is now at ${short(target)} ${store[target].msg}`);
    },

    async stash(args) {
      const sub = args[0] || 'push';
      if (sub === 'list') { S.stash.forEach((s, i) => out(`stash@{${i}}: ${s.msg}`)); if (!S.stash.length) out('(no stashes)', 'dim'); return; }
      if (sub === 'pop' || sub === 'apply') {
        if (!S.stash.length) fail('No stash entries found.');
        if (isDirty()) fail('Your local changes would be overwritten. Commit or stash them first.');
        const s = S.stash[0];
        await step(`Re-applying the stashed changes onto your working directory${sub === 'pop' ? ' and removing the stash entry' : ''}.`,
          () => {
            Object.keys(s.index).forEach((n) => { S.index[n] = s.index[n]; });
            for (const n of Object.keys(s.removedIdx)) delete S.index[n];
            Object.keys(s.work).forEach((n) => { S.work[n] = s.work[n]; });
            for (const n of Object.keys(s.removedWork)) delete S.work[n];
            if (sub === 'pop') S.stash.shift();
          }, { from: Object.fromEntries(Object.keys(s.work).map((n) => [`w:${n}`, `st:${s.key}`])) });
        return;
      }
      if (sub === 'drop') { if (!S.stash.length) fail('No stash entries found.'); await step('Dropping the newest stash entry.', () => S.stash.shift()); return; }
      needRepo();
      if (!isDirty()) { out('No local changes to save'); return; }
      const head = headTree();
      const changed = (a) => Object.fromEntries(Object.entries(a).filter(([n, v]) => head[n] !== v));
      const removed = (a) => Object.fromEntries(Object.keys(head).filter((n) => !(n in a)).map((n) => [n, 1]));
      const entry = { key: Math.random().toString(36).slice(2, 8), base: headId(),
        msg: `WIP on ${curBranch() || 'HEAD'}: ${short(headId())} ${store[headId()].msg}`,
        index: changed(S.index), work: Object.fromEntries(Object.entries(S.work).filter(([n, v]) => head[n] !== v && n in S.index)),
        removedIdx: removed(S.index), removedWork: Object.fromEntries(Object.keys(head).filter((n) => !(n in S.work)).map((n) => [n, 1])) };
      const moving = [...new Set([...Object.keys(entry.work), ...stagedChanges().map((s) => s.name)])];
      await step('Your uncommitted changes to tracked files are packed away on the <b>stash</b> shelf, and the working directory is reset to the last commit. Handy when you need a clean tree to switch branches.',
        () => {
          S.stash.unshift(entry);
          for (const n of Object.keys(S.work)) if (n in head || n in S.index) delete S.work[n];
          S.index = { ...head };
          Object.assign(S.work, head);
        }, { fly: [[moving.flatMap((n) => [`w:${n}`, `s:${n}`]), `st:${entry.key}`]] });
      out(`Saved working directory and index state ${entry.msg}`);
    },

    async tag(args) {
      const { rest, flags } = parseFlags(args, ['-m']);
      if (!rest.length) { for (const n of Object.keys(S.local.tags).sort()) out(n); return; }
      if (flags['-d']) { delete S.local.tags[rest[0]]; render(); out(`Deleted tag '${rest[0]}'`); return; }
      needRepo();
      if (S.local.tags[rest[0]]) fail(`tag '${rest[0]}' already exists`);
      const at = rest[1] ? resolve(rest[1]) : headId();
      await step(`Tag ${code(rest[0])} marks commit ${code(short(at))}. Unlike a branch, a tag <b>never moves</b> — perfect for release versions.`,
        () => { S.local.tags[rest[0]] = at; });
    },

    async 'cherry-pick'(args) {
      needRepo();
      if (!args[0]) fail('specify a commit to cherry-pick');
      if (isDirty()) fail('your local changes would be overwritten by cherry-pick.');
      const src = resolve(args[0]);
      if (store[src].parents.length > 1) fail('commit is a merge — this sandbox only cherry-picks normal commits.');
      const { tree, conflicts } = applyPatch(src);
      if (conflicts.length) fail(`could not apply ${short(src)}: conflict in ${conflicts.join(', ')}`);
      const c = makeCommit([headId()], store[src].msg, tree);
      await step(`Git takes the <b>change</b> introduced by ${code(short(src))} and applies it on top of ${code(curBranch() || 'HEAD')}, creating a copy ${code(short(c.id))} with a new ID.`,
        () => {
          S.local.has.add(c.id); S.index = { ...tree }; S.work = { ...tree };
          if (curBranch()) S.local.branches[curBranch()] = c.id; else S.local.head = { id: c.id };
        }, { fly: [[[`c:${src}`], `c:${c.id}`]], enterDelay: true });
    },

    async revert(args) {
      needRepo();
      if (!args[0]) fail('specify a commit to revert');
      if (isDirty()) fail('your local changes would be overwritten by revert.');
      const src = resolve(args[0]);
      if (!store[src].parents.length) fail('cannot revert the very first commit in this sandbox.');
      if (store[src].parents.length > 1) fail('reverting merges needs -m; not supported in this sandbox.');
      const { tree, conflicts } = applyPatch(src, true);
      if (conflicts.length) fail(`could not revert ${short(src)}: conflict in ${conflicts.join(', ')}`);
      const c = makeCommit([headId()], `Revert "${store[src].msg}"`, tree);
      await step(`Instead of rewriting history, git makes a <b>new commit</b> ${code(short(c.id))} that does the exact <b>opposite</b> of ${code(short(src))}. Safe for commits that were already pushed.`,
        () => {
          S.local.has.add(c.id); S.index = { ...tree }; S.work = { ...tree };
          if (curBranch()) S.local.branches[curBranch()] = c.id; else S.local.head = { id: c.id };
        }, { fly: [[[`c:${src}`], `c:${c.id}`]], enterDelay: true });
    },

    async fetch() {
      const missing = [...S.remote.has].filter((id) => !S.local.has.has(id)).sort((a, b) => store[a].seq - store[b].seq);
      const moves = Object.entries(S.remote.branches).filter(([n, id]) => S.local.tracking[`origin/${n}`] !== id);
      if (!missing.length && !moves.length) { out('(already up to date with origin)', 'dim'); return; }
      const from = Object.fromEntries(missing.map((id) => [`c:${id}`, `r:${id}`]));
      await step(`<b>Downloading</b> from origin: ${missing.length ? `${missing.length} new commit${missing.length > 1 ? 's' : ''} ${missing.map((id) => code(short(id))).join(', ')} ${missing.length > 1 ? 'arrive' : 'arrives'} in your local repository, and ` : ''}the remote-tracking labels (${moves.map(([n]) => code(`origin/${n}`)).join(', ')}) update. Your own branches and files are <b>not</b> touched.`,
        () => {
          for (const id of missing) S.local.has.add(id);
          for (const [n, id] of moves) S.local.tracking[`origin/${n}`] = id;
        }, { from: { ...from }, ghostFrom: [] , keep: new Set(Object.values(from)) });
      for (const [n, id] of moves) out(`   ${short(S.local.tracking[`origin/${n}`] || id)}  ${n} -> origin/${n}`, 'dim');
    },

    async pull() {
      const b = curBranch();
      if (!b) fail('You are not currently on a branch.');
      const up = S.local.upstream[b] || (S.remote.branches[b] ? `origin/${b}` : null);
      if (!up) fail(`There is no tracking information for the current branch.\n  git push -u origin ${b}   sets it up.`);
      out('git pull = git fetch + git merge', 'hint');
      await git.fetch();
      if (!S.local.tracking[up]) fail(`couldn't find remote ref ${up}`);
      await git.merge([up]);
    },

    async push(args) {
      const { flags, rest } = parseFlags(args);
      needRepo();
      const remoteName = rest[0] || 'origin';
      if (remoteName !== 'origin') fail(`'${remoteName}' does not appear to be a git repository (only origin exists here)`);
      const b = rest[1] || curBranch();
      if (!b) fail('You are not currently on a branch.');
      const local = S.local.branches[b];
      if (!local) fail(`src refspec ${b} does not match any`);
      if (!rest[1] && !S.local.upstream[b] && !(flags['-u'] || flags['--set-upstream'])) {
        if (S.remote.branches[b] === undefined) {
          fail(`The current branch ${b} has no upstream branch.\nTo push the current branch and set the remote as upstream, use\n\n    git push -u origin ${b}`);
        }
      }
      const remoteTip = S.remote.branches[b];
      const force = flags['--force'] || flags['-f'] || flags['--force-with-lease'];
      if (remoteTip === local) { out('Everything up-to-date'); if (flags['-u']) S.local.upstream[b] = `origin/${b}`; return; }
      if (remoteTip && !isAncestor(remoteTip, local) && !force) {
        fail(` ! [rejected]        ${b} -> ${b} (fetch first)\nerror: failed to push some refs\nhint: The remote has work that you do not have locally (someone else pushed).\nhint: Run 'git pull' first, then push again.`);
      }
      const missing = [...ancestors(local)].filter((id) => !S.remote.has.has(id)).sort((a, c) => store[a].seq - store[c].seq);
      const from = Object.fromEntries(missing.map((id) => [`r:${id}`, `c:${id}`]));
      await step(`<b>Uploading</b> ${missing.length ? `${missing.length} commit${missing.length > 1 ? 's' : ''} (${missing.map((id) => code(short(id))).join(', ')})` : 'the branch'} to origin. ${force && remoteTip && !isAncestor(remoteTip, local) ? '⚠️ <b>Force</b>: the remote\'s commits that you don\'t have are thrown away! ' : ''}The remote's ${code(b)} now points at ${code(short(local))}.`,
        () => {
          for (const id of missing) S.remote.has.add(id);
          S.remote.branches[b] = local;
          if (force) for (const id of [...S.remote.has]) if (!reachableRemote().has(id)) S.remote.has.delete(id);
        }, { from, keep: new Set(Object.values(from)) });
      await step(`Your remote-tracking label ${code(`origin/${b}`)} moves too, recording where origin's ${code(b)} is now.${flags['-u'] || flags['--set-upstream'] ? ` <b>-u</b> also links ${code(b)} to it, so plain ${code('git push')}/${code('git pull')} know where to go.` : ''}`,
        () => {
          S.local.tracking[`origin/${b}`] = local;
          if (flags['-u'] || flags['--set-upstream'] || !S.local.upstream[b]) S.local.upstream[b] = `origin/${b}`;
        }, { hold: 300 });
      out(`To github.com:you/playground.git\n   ${remoteTip ? short(remoteTip) : '[new branch]'}..${short(local)}  ${b} -> ${b}`);
    },
  };
  git.ci = git.commit; git.co = git.checkout; git.st = git.status; git.br = git.branch;

  async function switchTo(name, { create = false, start, track = false } = {}) {
    if (create) {
      if (S.local.branches[name]) fail(`a branch named '${name}' already exists`);
      if (!/^[\w./-]+$/.test(name)) fail(`'${name}' is not a valid branch name`);
    }
    if (!create && name === curBranch()) { out(`Already on '${name}'`); return; }
    const target = create ? (start ? resolve(start) : headId()) : S.local.branches[name];
    if (create && !target) {
      // New branch in a repo with no commits: just rename the unborn branch.
      S.local.head = { ref: name };
      render();
      out(`Switched to a new branch '${name}'`);
      return;
    }
    const apply = checkoutPlan(target);
    const changes = Object.keys(headTree()).length !== Object.keys(store[target].tree).length
      || Object.entries(store[target].tree).some(([n, v]) => headTree()[n] !== v);
    if (create) {
      await step(`Creating branch ${code(name)} at ${code(short(target))}${track ? ` from ${code(start)}` : ''} — a new label on the commit.`,
        () => { S.local.branches[name] = target; if (track) S.local.upstream[name] = start; });
    }
    await step(`<b>HEAD</b> moves to ${code(name)}. ${changes ? 'Your files are updated to match that branch\'s latest commit.' : 'Both point at the same snapshot, so no files change.'} New commits will now go on ${code(name)}.${isDirty() ? ' Your uncommitted changes come along with you.' : ''}`,
      () => { apply(); S.local.head = { ref: name }; });
    out(`Switched to ${create ? 'a new ' : ''}branch '${name}'`);
  }

  async function run(line) {
    history.push(line);
    histPos = history.length;
    const d = document.createElement('div');
    d.className = 'lr-line cmd';
    d.innerHTML = `${q('#lr-prompt', root).innerHTML} <b>${html(line)}</b>`;
    termOut.appendChild(d);
    termOut.scrollTop = termOut.scrollHeight;
    busy = true;
    root.classList.add('busy');
    stepNo = 0;
    let ok = false;
    try {
      await exec(line);
      ok = true;
    } catch (e) {
      if (e instanceof GitError) {
        const first = e.message.split('\n')[0];
        out(/^(error|fatal|hint|usage|[a-z]+:)/.test(first) || first.startsWith(' !') ? e.message : `fatal: ${e.message}`, 'bad');
      } else {
        console.error(e);
        out(`Oops, the playground hit a bug: ${e.message}`, 'bad');
      }
    } finally {
      busy = false;
      root.classList.remove('busy');
      if (stepNo) setTimeout(() => { if (!busy) narr.classList.add('idle'); }, 2500);
      render();
    }
    lessonProgress(line, ok);
  }

  async function exec(line) {
    for (const part of line.split(/\s*&&\s*/)) await execOne(part);
  }

  async function execOne(line) {
    const toks = tokenize(line);
    let [cmd, ...args] = toks;
    if (cmd === 'git') {
      [cmd, ...args] = args;
      if (!cmd) { shell.help(); return; }
      const fn = git[cmd];
      if (!fn) fail(`git: '${cmd}' is not a git command in this playground. Type help to see what's supported.`);
      return fn(args, line);
    }
    if (shell[cmd]) return shell[cmd](args, line);
    if (cmd === 'reflog' || line.startsWith('git reflog')) return null;
    fail(`${cmd}: command not found  (type help)`);
  }

  async function runSilent(lines) {
    silent = true;
    try { for (const l of lines) await exec(l); } finally { silent = false; }
  }

  // ============================================================ inspector
  function onStageClick(e) {
    const el = e.target.closest('[data-commit]');
    if (!el) return;
    const c = store[el.dataset.commit];
    const parent = c.parents[0] ? store[c.parents[0]].tree : {};
    const names = [...new Set([...Object.keys(parent), ...Object.keys(c.tree)])].filter((n) => parent[n] !== c.tree[n]);
    out(`commit ${c.id}${c.parents.length ? `  (parent${c.parents.length > 1 ? 's' : ''}: ${c.parents.map(short).join(', ')})` : '  (root commit)'}`, 'log');
    out(`    ${c.msg}`);
    out(`    snapshot: ${Object.keys(c.tree).sort().join(', ') || '(no files)'}`, 'dim');
    out(`    changed:  ${names.join(', ') || '(nothing)'}`, 'dim');
    out(`    tip: git checkout ${short(c.id)}  ·  git cherry-pick ${short(c.id)}  ·  git reset --hard ${short(c.id)}`, 'hint');
  }

  // ============================================================ lessons
  const BASE = ['git init', 'echo "# Playground" > README.md', 'git add README.md', 'git commit -m "Initial commit"',
    'git push -u origin main'];
  const LESSONS = [
    { title: 'Free sandbox', intro: 'No instructions — try anything. Type <code>help</code> to see every command.', setup: BASE, tasks: [] },
    {
      title: '1 · Your first commit',
      intro: 'Every change travels <b>working directory → staging area → repository</b>. Let\'s walk one file through it.',
      setup: ['git init'],
      tasks: [
        { say: 'Create a file.', cmd: 'touch hello.txt', re: /^touch\s+\S/ },
        { say: 'Ask git what it sees.', cmd: 'git status', re: /^git\s+st(atus)?\b/ },
        { say: 'Stage the file — pick it for the next snapshot.', cmd: 'git add hello.txt', re: /^git\s+add\b/ },
        { say: 'Save the snapshot as a commit.', cmd: 'git commit -m "Add hello"', re: /^git\s+(commit|ci)\b/ },
        { say: 'Change the file, then look at the difference.', cmd: 'echo "Hello, git!" > hello.txt', re: /^(echo|edit)\b/ },
        { say: 'See exactly what changed.', cmd: 'git diff', re: /^git\s+diff\b/ },
        { say: 'Stage and commit in one go (-a works for tracked files).', cmd: 'git commit -am "Say hello"', re: /^git\s+(commit|ci)\b/ },
        { say: 'Look at the history.', cmd: 'git log --oneline', re: /^git\s+log\b/ },
      ],
    },
    {
      title: '2 · Branches',
      intro: 'A branch is just a <b>label</b> on a commit. Creating one is instant, and HEAD tells git which label moves when you commit.',
      setup: BASE,
      tasks: [
        { say: 'Create a branch called feature.', cmd: 'git branch feature', re: /^git\s+branch\s+\S/ },
        { say: 'Switch to it — watch HEAD move.', cmd: 'git switch feature', re: /^git\s+(switch|checkout)\s/ },
        { say: 'Make a change on the branch.', cmd: 'echo "new idea" > idea.txt', re: /^(echo|touch|edit)\b/ },
        { say: 'Stage it.', cmd: 'git add .', re: /^git\s+add\b/ },
        { say: 'Commit — only feature moves forward.', cmd: 'git commit -m "Add idea"', re: /^git\s+(commit|ci)\b/ },
        { say: 'Go back to main. idea.txt disappears from your folder!', cmd: 'git switch main', re: /^git\s+(switch|checkout)\s+main/ },
        { say: 'Bring the work into main.', cmd: 'git merge feature', re: /^git\s+merge\s/ },
        { say: 'The label is no longer needed.', cmd: 'git branch -d feature', re: /^git\s+branch\s+-[dD]/ },
      ],
    },
    {
      title: '3 · Merge commits & conflicts',
      intro: 'When <b>both</b> branches move on, git can\'t just slide a label — it makes a merge commit. If both change the same file, you get a conflict.',
      setup: [...BASE, 'git switch -c feature', 'echo "blue" > color.txt', 'git add .', 'git commit -m "Pick blue"',
        'echo "Feature docs" >> README.md', 'git commit -am "Document feature"', 'git switch main'],
      tasks: [
        { say: 'Make main move on too, editing the same file differently.', cmd: 'echo "red" > color.txt', re: /^(echo|edit|touch)\b/ },
        { say: 'Stage and commit it on main.', cmd: 'git add . && git commit -m "Pick red"', re: /git\s+(commit|ci)\b/ },
        { say: 'Merge feature in. Expect a conflict!', cmd: 'git merge feature', re: /^git\s+merge\s+feature/ },
        { say: 'Peek at the conflicted file.', cmd: 'cat color.txt', re: /^(cat|git\s+status|git\s+diff)\b/ },
        { say: 'Resolve it by writing the version you want.', cmd: 'echo "purple" > color.txt', re: /^(echo|edit)\b/ },
        { say: 'Mark it resolved.', cmd: 'git add color.txt', re: /^git\s+add\b/ },
        { say: 'Finish the merge — a commit with two parents.', cmd: 'git commit -m "Merge feature"', re: /^git\s+(commit|ci)\b/ },
      ],
    },
    {
      title: '4 · Undoing things',
      intro: 'restore, reset and revert all “undo”, but at different levels. Watch which zones each one touches.',
      setup: [...BASE, 'echo "v1" > app.txt', 'git add .', 'git commit -m "App v1"', 'echo "v2" >> app.txt', 'git commit -am "App v2"'],
      tasks: [
        { say: 'Make a mistake and stage it.', cmd: 'echo "oops" >> app.txt', re: /^(echo|edit)\b/ },
        { say: 'Stage it.', cmd: 'git add app.txt', re: /^git\s+add\b/ },
        { say: 'Unstage it (your edit stays on disk).', cmd: 'git restore --staged app.txt', re: /^git\s+(restore\s+--staged|reset\b)/ },
        { say: 'Throw the edit away completely.', cmd: 'git restore app.txt', re: /^git\s+(restore|checkout)\b/ },
        { say: 'Undo the last commit but keep its changes staged.', cmd: 'git reset --soft HEAD~1', re: /^git\s+reset\s+--soft/ },
        { say: 'Commit it again with a better message.', cmd: 'git commit -m "App v2, take two"', re: /^git\s+(commit|ci)\b/ },
        { say: 'Safely undo a commit that might be shared: revert makes an opposite commit.', cmd: 'git revert HEAD', re: /^git\s+revert\b/ },
        { say: 'Nuke back to the first app commit — HEAD, staging and files.', cmd: 'git reset --hard HEAD~2', re: /^git\s+reset\s+--hard/ },
      ],
    },
    {
      title: '5 · Working with a remote',
      intro: '<b>origin</b> is the shared copy. push uploads, fetch downloads, pull = fetch + merge. The <code>origin/main</code> label is your last-known view of it.',
      setup: BASE,
      tasks: [
        { say: 'Make some local work.', cmd: 'echo "local work" > work.txt', re: /^(echo|edit|touch)\b/ },
        { say: 'Stage and commit it.', cmd: 'git add . && git commit -m "Local work"', re: /git\s+(commit|ci)\b/ },
        { say: 'Check: you\'re ahead of origin/main.', cmd: 'git status', re: /^git\s+st(atus)?\b/ },
        { say: 'Upload it.', cmd: 'git push', re: /^git\s+push\b/ },
        { say: 'Simulate a teammate pushing something.', cmd: 'teammate', re: /^teammate\b/ },
        { say: 'Download what changed (nothing on your branch moves yet).', cmd: 'git fetch', re: /^git\s+fetch\b/ },
        { say: 'Now combine it into main.', cmd: 'git merge origin/main', re: /^git\s+(merge|pull|rebase)\b/ },
        { say: 'Do it again, but in one command.', cmd: 'teammate', re: /^teammate\b/ },
        { say: 'pull = fetch + merge.', cmd: 'git pull', re: /^git\s+pull\b/ },
      ],
    },
    {
      title: '6 · Rebase',
      intro: 'Rebase <b>replays</b> your commits on top of another branch, giving a straight history. The commits get new IDs.',
      setup: [...BASE, 'git switch -c feature', 'echo "a" > a.txt', 'git add .', 'git commit -m "Feature A"',
        'echo "b" > b.txt', 'git add .', 'git commit -m "Feature B"', 'git switch main', 'echo "fix" > fix.txt',
        'git add .', 'git commit -m "Hotfix on main"'],
      tasks: [
        { say: 'Go to the feature branch.', cmd: 'git switch feature', re: /^git\s+(switch|checkout)\s+feature/ },
        { say: 'Replay it on top of main.', cmd: 'git rebase main', re: /^git\s+rebase\s/ },
        { say: 'Back to main…', cmd: 'git switch main', re: /^git\s+(switch|checkout)\s+main/ },
        { say: '…and now the merge is a simple fast-forward.', cmd: 'git merge feature', re: /^git\s+merge\s/ },
      ],
    },
    {
      title: '7 · Stash',
      intro: 'Need to switch branches with half-done work? <b>Stash</b> it on a shelf and bring it back later.',
      setup: [...BASE, 'git switch -c hotfix', 'echo "hotfix notes" >> README.md', 'git commit -am "Prep hotfix"',
        'git switch main', 'echo "half-done" >> README.md'],
      tasks: [
        { say: 'You have half-done edits in README.md. Try switching to hotfix — git refuses, because hotfix has a different README.md.', cmd: 'git switch hotfix', re: /^git\s+(switch|checkout)\s+hotfix/, allowFail: true },
        { say: 'Put your work on the shelf.', cmd: 'git stash', re: /^git\s+stash(\s+push)?\s*$/ },
        { say: 'Now switching works.', cmd: 'git switch hotfix', re: /^git\s+(switch|checkout)\s/ },
        { say: 'Do the urgent fix.', cmd: 'echo "urgent" > fix.txt', re: /^(echo|edit|touch)\b/ },
        { say: 'Stage and commit it.', cmd: 'git add . && git commit -m "Urgent fix"', re: /git\s+(commit|ci)\b/ },
        { say: 'Return to main.', cmd: 'git switch main', re: /^git\s+(switch|checkout)\s+main/ },
        { say: 'Take your work back off the shelf.', cmd: 'git stash pop', re: /^git\s+stash\s+(pop|apply)/ },
      ],
    },
  ];

  let lessonIdx = +(localStorage.getItem('ggit-learn-lesson') || 1);
  if (!LESSONS[lessonIdx]) lessonIdx = 1;
  let taskIdx = 0;

  function renderLessons() {
    const l = LESSONS[lessonIdx];
    const done = l.tasks.length && taskIdx >= l.tasks.length;
    q('#lr-lessons', root).innerHTML = `
      <div class="lr-lsel">
        <select id="lr-lesson">${LESSONS.map((x, i) => `<option value="${i}"${i === lessonIdx ? ' selected' : ''}>${html(x.title)}</option>`).join('')}</select>
        ${l.tasks.length ? `<span class="lr-prog">${Math.min(taskIdx, l.tasks.length)}/${l.tasks.length}</span>` : ''}
      </div>
      <p class="lr-intro">${l.intro}</p>
      ${l.tasks.length ? `<ol class="lr-tasks">${l.tasks.map((t, i) => `
        <li class="${i < taskIdx ? 'done' : i === taskIdx ? 'now' : ''}">
          ${t.say ? `<span>${t.say}</span>` : ''}
          <button class="lr-cmd" data-cmd="${html(t.cmd)}" title="Click to type it">${html(t.cmd)}</button>
        </li>`).join('')}</ol>` : ''}
      ${done ? `<div class="lr-done">🎉 Lesson complete! ${LESSONS[lessonIdx + 1] ? '<button class="btn primary" id="lr-nextlesson">Next lesson ▸</button>' : 'You\'ve finished them all — keep experimenting.'}</div>` : ''}`;
    const sel = q('#lr-lesson', root);
    sel.onchange = () => { if (!busy) startLesson(+sel.value); else sel.value = lessonIdx; };
    q('.lr-tasks li.now', root)?.scrollIntoView({ block: 'nearest' });
  }

  function onLessonClick(e) {
    const b = e.target.closest('.lr-cmd');
    if (b) { termIn.value = b.dataset.cmd; termIn.focus(); return; }
    if (e.target.id === 'lr-nextlesson') startLesson(lessonIdx + 1);
  }

  function lessonProgress(line, ok) {
    const l = LESSONS[lessonIdx];
    const t = l.tasks[taskIdx];
    if (t && (ok || t.allowFail) && t.re.test(line.trim())) {
      taskIdx++;
      renderLessons();
      if (taskIdx >= l.tasks.length) out('🎉 Lesson complete!', 'hint');
    }
  }

  async function startLesson(i) {
    lessonIdx = i;
    taskIdx = 0;
    localStorage.setItem('ggit-learn-lesson', String(i));
    freshState();
    prevEdges.c.clear(); prevEdges.r.clear();
    await runSilent(LESSONS[i].setup);
    termOut.innerHTML = '';
    out(`${LESSONS[i].title.replace(/^\d+ · /, '')} — type commands below, or click a highlighted command to fill it in.`, 'hint');
    out('Type help for all commands. Nothing here touches your real repository.', 'dim');
    narr.classList.add('idle');
    q('#lr-narr-step', root).textContent = '';
    q('#lr-narr-text', root).textContent = 'Each command is explained here, step by step, as it animates.';
    renderLessons();
    render();
    termIn.focus();
  }

  // ============================================================ open / close
  let started = false;
  function open() {
    if (!root) build();
    root.classList.remove('hidden');
    document.body.classList.add('learn-open');
    if (!started) { started = true; startLesson(lessonIdx); } else { render(); termIn.focus(); }
  }
  function close() {
    if (!root) return;
    nextResolver?.();
    termIn.blur();
    root.classList.add('hidden');
    document.body.classList.remove('learn-open');
  }
  const isOpen = () => !!root && !root.classList.contains('hidden');

  window.ggitLearn = { open, close, isOpen, rerender: () => isOpen() && render() };
})();
