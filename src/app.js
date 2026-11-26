(function () {
  "use strict";

  const COLS = 8, ROWS = 8;
  const TYPES = [
    { emoji: "🍓", bg: "#ff6f86", name: "草莓" },
    { emoji: "🍋", bg: "#ffd45c", name: "柠檬" },
    { emoji: "🍇", bg: "#b184f5", name: "葡萄" },
    { emoji: "🍉", bg: "#5ed39b", name: "西瓜" },
    { emoji: "🫐", bg: "#69a9f7", name: "蓝莓" },
    { emoji: "🍑", bg: "#ffa56a", name: "蜜桃" }
  ];
  const BADGE = { hline: "↔", vline: "↕", wrapped: "✦", bomb: "★" };
  const SP_NAME = [null, "hline", "vline", "wrapped", "bomb"];
  const LEVELS = [
    { moves: 20, goal: { kind: "collect", items: [{ type: 0, need: 12 }] } },
    { moves: 22, goal: { kind: "score", target: 1500 } },
    { moves: 24, goal: { kind: "collect", items: [{ type: 3, need: 14 }, { type: 4, need: 10 }] } }
  ];

  /* ===== 加载 C 语言编译出的 WebAssembly 核心 ===== */
  const WASM_B64 = "__WASM_BASE64__";
  let WASM = null, HEAP32 = null, P = null;
  (function initWasm() {
    const bin = Uint8Array.from(atob(WASM_B64), ch => ch.charCodeAt(0));
    const mod = new WebAssembly.Module(bin);
    const inst = new WebAssembly.Instance(mod);
    WASM = inst.exports;
    HEAP32 = new Int32Array(WASM.memory.buffer);
    const view = (fn, len) => new Int32Array(HEAP32.buffer, WASM[fn](), len);
    P = {
      type:      view("m3_board_type_ptr", 64),
      sp:        view("m3_board_sp_ptr", 64),
      match:     view("m3_match_cells_ptr", 160),
      runs:      view("m3_runs_ptr", 128),
      plan:      view("m3_plan_cells_ptr", 160),
      planSp:    view("m3_plan_sp_ptr", 160),
      clear:     view("m3_clear_cells_ptr", 160),
      collected: view("m3_clear_collected_ptr", 6),
      moveFrom:  view("m3_move_from_ptr", 64),
      moveType:  view("m3_move_type_ptr", 64)
    };
  })();

  const board = document.getElementById("board");
  const fx = document.getElementById("fx");
  const toastEl = document.getElementById("toast");
  const overlay = document.getElementById("overlay");
  const levelVal = document.getElementById("levelVal");
  const scoreVal = document.getElementById("scoreVal");
  const movesVal = document.getElementById("movesVal");
  const goalsEl = document.getElementById("goals");

  let grid = [];
  let uid = 0;
  let selected = null;
  let busy = false;
  let level = 1;
  let moves = 0;
  let score = 0;
  let goal = null;
  let boosters = { hint: 2, shuffle: 2, extra: 2 };
  let toastTimer = null;

  // ===== 关卡进度（本地保存） =====
  const STORE_KEY = "match3-progress-v1";
  const TOTAL_LEVELS = 30;
  let progress = loadProgress();
  function loadProgress() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (p && typeof p.unlocked === "number") {
          return { unlocked: Math.max(1, p.unlocked), cleared: p.cleared || {}, best: p.best || {} };
        }
      }
    } catch (e) { /* 隐私模式或 file:// 限制时忽略 */ }
    return { unlocked: 1, cleared: {}, best: {} };
  }
  function saveProgress() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(progress)); } catch (e) { /* 忽略 */ }
  }
  function recordClear(lv, finalScore) {
    progress.cleared[lv] = true;
    progress.best[lv] = Math.max(progress.best[lv] || 0, finalScore);
    progress.unlocked = Math.max(progress.unlocked, Math.min(TOTAL_LEVELS, lv + 1));
    saveProgress();
  }

  // ===== 音效与背景音乐（Web Audio 合成，无外部资源） =====
  const Sound = (function () {
    let ctx = null, master = null, musicGain = null, sfxGain = null;
    let musicOn = true, sfxOn = true, musicTimer = null, melodyStep = 0, started = false;
    const melody = [523.25, 587.33, 659.25, 783.99, 659.25, 587.33, 523.25, 440.00,
                    493.88, 587.33, 659.25, 880.00, 783.99, 659.25, 587.33, 523.25];

    function ensure() {
      if (!ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
        musicGain = ctx.createGain(); musicGain.gain.value = 0.10; musicGain.connect(master);
        sfxGain = ctx.createGain(); sfxGain.gain.value = 0.4; sfxGain.connect(master);
      }
      if (ctx.state === "suspended") ctx.resume();
      return ctx;
    }
    function tone(freq, dur, opt) {
      if (!ctx) return;
      opt = opt || {};
      const t0 = ctx.currentTime + (opt.delay || 0);
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = opt.type || "sine";
      osc.frequency.setValueAtTime(freq, t0);
      if (opt.slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, opt.slide), t0 + dur);
      const vol = opt.vol == null ? 0.5 : opt.vol;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g); g.connect(opt.music ? musicGain : sfxGain);
      osc.start(t0); osc.stop(t0 + dur + 0.02);
    }
    function musicTick() {
      if (!musicOn || !ctx) return;
      const f = melody[melodyStep % melody.length];
      tone(f, 0.24, { type: "triangle", vol: 0.22, music: true });
      if (melodyStep % 8 === 0) tone(130.81, 1.7, { type: "sine", vol: 0.16, music: true });
      melodyStep++;
    }
    function startMusic() {
      if (!musicOn || musicTimer || !ensure()) return;
      started = true;
      musicTick();
      musicTimer = setInterval(musicTick, 290);
    }
    function stopMusic() {
      if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
    }
    return {
      unlock() { if (musicOn) startMusic(); },
      pop(n) {
        if (!sfxOn || !ensure()) return;
        const k = Math.min(n || 3, 10);
        tone(600 + k * 22, 0.13, { type: "sine", slide: 980, vol: 0.45 });
        tone(880 + k * 15, 0.09, { type: "triangle", vol: 0.22, delay: 0.04 });
      },
      combo(chain) {
        if (!sfxOn || !ctx) return;
        const base = 523.25 * Math.pow(1.12, Math.min(chain, 5));
        [0, 1, 2].forEach(i => tone(base * Math.pow(1.26, i), 0.14, { type: "triangle", vol: 0.35, delay: i * 0.07 }));
      },
      swap() { if (sfxOn && ensure()) tone(440, 0.06, { type: "sine", vol: 0.18 }); },
      invalid() { if (sfxOn && ensure()) tone(180, 0.18, { type: "sawtooth", slide: 120, vol: 0.14 }); },
      special() {
        if (!sfxOn || !ctx) return;
        [1046.5, 1318.5, 1568, 2093].forEach((f, i) => tone(f, 0.1, { type: "sine", vol: 0.22, delay: i * 0.045 }));
      },
      bonus() {
        if (!sfxOn || !ensure()) return;
        [659.25, 783.99, 987.77].forEach((f, i) => tone(f, 0.16, { type: "triangle", vol: 0.3, delay: i * 0.09 }));
      },
      win() {
        if (!sfxOn || !ensure()) return;
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, 0.28, { type: "triangle", vol: 0.4, delay: i * 0.12 }));
      },
      lose() {
        if (!sfxOn || !ensure()) return;
        [392, 349.23, 293.66, 220].forEach((f, i) => tone(f, 0.3, { type: "sine", vol: 0.32, delay: i * 0.14 }));
      },
      toggleMusic() {
        musicOn = !musicOn;
        if (musicOn) { ensure(); startMusic(); } else stopMusic();
        return musicOn;
      },
      toggleSfx() { sfxOn = !sfxOn; if (sfxOn) ensure(); return sfxOn; },
      status() { return { musicOn, sfxOn, started, running: !!musicTimer }; }
    };
  })();

  document.addEventListener("pointerdown", function unlockOnce() {
    Sound.unlock();
    document.removeEventListener("pointerdown", unlockOnce);
  }, { once: true });

  const wait = (ms) => new Promise(res => setTimeout(res, ms));
  const rnd = (n) => Math.floor(Math.random() * n);
  const key = (r, c) => r + "," + c;
  const parse = (k) => { const p = k.split(",").map(Number); return { r: p[0], c: p[1] }; };
  const idx = (r, c) => r * COLS + c;
  const posOf = (i) => ({ r: Math.floor(i / COLS), c: i % COLS });

  function configFor(n) {
    if (n <= LEVELS.length) return LEVELS[n - 1];
    const extra = n - LEVELS.length;
    const firstColor = rnd(TYPES.length);
    let secondColor = rnd(TYPES.length);
    while (secondColor === firstColor) secondColor = rnd(TYPES.length);
    const moves = 24 + Math.min(10, extra * 2);
    return {
      moves: moves,
      goal: extra % 2 === 0
        ? { kind: "collect", items: [{ type: firstColor, need: 15 + extra * 2 }, { type: secondColor, need: 10 + extra }] }
        : { kind: "score", target: 900 + extra * 200 }
    };
  }

  function makeTile(type, row, col, special) {
    const el = document.createElement("div");
    el.className = "tile";
    el.dataset.id = String(++uid);
    const t = TYPES[type];
    el.style.background = "linear-gradient(160deg, " + t.bg + ", " + shade(t.bg, -18) + ")";
    const face = document.createElement("span");
    face.className = "face";
    face.textContent = special === "bomb" ? "🌈" : t.emoji;
    el.appendChild(face);
    if (special) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = BADGE[special];
      el.appendChild(badge);
    }
    board.appendChild(el);
    const tile = { id: uid, type, special: special || null, row, col, el };
    positionTile(tile, row, col, false);
    return tile;
  }

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const clamp = (v) => Math.max(0, Math.min(255, v));
    return "#" + [clamp((n >> 16) + amt), clamp(((n >> 8) & 255) + amt), clamp((n & 255) + amt)]
      .map(v => v.toString(16).padStart(2, "0")).join("");
  }

  function positionTile(tile, row, col, animate) {
    if (!animate) tile.el.style.transition = "none";
    tile.row = row; tile.col = col;
    tile.el.style.left = "calc(" + col + " * (var(--cell) + var(--gap)))";
    tile.el.style.top = "calc(" + row + " * (var(--cell) + var(--gap)))";
    if (!animate) {
      void tile.el.offsetWidth;
      tile.el.style.transition = "";
    }
  }

  function clearBoardDom() {
    board.innerHTML = "";
    fx.innerHTML = "";
    grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  }

  function refreshTile(tile, type, special) {
    tile.type = type;
    tile.special = special || null;
    tile.el.innerHTML = '<span class="face">' + (special === "bomb" ? "🌈" : TYPES[type].emoji) + "</span>" +
      (special ? '<span class="badge">' + BADGE[special] + "</span>" : "");
    tile.el.style.background = "linear-gradient(160deg, " + TYPES[type].bg + ", " + shade(TYPES[type].bg, -18) + ")";
  }

  /* ===== 以下核心逻辑由 C/WASM 计算，JS 只做 DOM 动画 ===== */

  function buildBoard() {
    clearBoardDom();
    WASM.m3_seed((Math.random() * 0xffffffff) >>> 0);
    WASM.m3_build_board();
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = idx(r, c);
        grid[r][c] = makeTile(P.type[i], r, c, SP_NAME[P.sp[i]]);
      }
    }
  }

  function findMatches() {
    const n = WASM.m3_find_matches();
    const cells = new Set();
    for (let i = 0; i < n; i++) cells.add(P.match[i]);
    const runs = [];
    for (let i = 0; i < WASM.m3_run_count(); i++) {
      const dir = P.runs[i * 4], type = P.runs[i * 4 + 1];
      const start = P.runs[i * 4 + 2], len = P.runs[i * 4 + 3];
      const cs = [];
      for (let k = 0; k < len; k++) {
        const p = posOf(dir === 1 ? start + k : start + k * COLS);
        cs.push([p.r, p.c]);
      }
      runs.push({ dir: dir === 1 ? "h" : "v", type: type, cells: cs });
    }
    return { cells, runs };
  }

  function validSwapByData(a, b) {
    const ia = idx(a.row, a.col), ib = idx(b.row, b.col);
    WASM.m3_swap(ia, ib);
    const ok = WASM.m3_find_matches() > 0 || a.special === "bomb" || b.special === "bomb" ||
      (a.special && b.special);
    WASM.m3_swap(ia, ib);
    return ok;
  }

  function findValidSwap() {
    const v = WASM.m3_find_valid_swap();
    if (!v) return null;
    const a = Math.floor((v - 1) / 64), b = (v - 1) % 64;
    const pa = posOf(a), pb = posOf(b);
    return [grid[pa.r][pa.c], grid[pb.r][pb.c]];
  }

  function swapTiles(a, b) {
    const ar = a.row, ac = a.col, br = b.row, bc = b.col;
    grid[ar][ac] = b; grid[br][bc] = a;
    WASM.m3_swap(idx(ar, ac), idx(br, bc));
    positionTile(a, br, bc, true);
    positionTile(b, ar, ac, true);
  }

  function planSpecials(runs, preferred) {
    const pref = preferred ? idx(preferred.row, preferred.col) : -1;
    WASM.m3_plan_specials(pref);
    const plan = new Map();
    for (let i = 0; i < WASM.m3_plan_count(); i++) {
      const p = posOf(P.plan[i]);
      plan.set(key(p.r, p.c), SP_NAME[P.planSp[i]]);
    }
    return plan;
  }

  function centroid(cellSet) {
    let r = 0, c = 0, n = 0;
    for (const k of cellSet) { const p = parse(k); r += p.r; c += p.c; n++; }
    return n ? { r: r / n, c: c / n } : { r: ROWS / 2, c: COLS / 2 };
  }

  function floatScore(points, pos) {
    const el = document.createElement("div");
    el.className = "float-score";
    el.textContent = "+" + points;
    el.style.left = "calc(" + (pos.c + .5) + " * (var(--cell) + var(--gap)) - var(--gap) / 2)";
    el.style.top = "calc(" + pos.r + " * (var(--cell) + var(--gap)) + var(--cell) / 2)";
    fx.appendChild(el);
    setTimeout(() => el.remove(), 950);
  }

  function comboBanner(chain) {
    const el = document.createElement("div");
    el.className = "combo-banner";
    el.textContent = typeof chain === "number" ? "连锁 x" + chain + "!" : chain;
    fx.appendChild(el);
    setTimeout(() => el.remove(), 850);
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1500);
  }

  function addScore(points) {
    score += points;
    scoreVal.textContent = score.toLocaleString();
    scoreVal.classList.remove("pulse");
    void scoreVal.offsetWidth;
    scoreVal.classList.add("pulse");
    renderGoals();
  }

  function renderGoals() {
    if (!goal) return;
    if (goal.kind === "score") {
      goalsEl.innerHTML = '<span class="goal-chip" id="scoreGoal">🏆 得分 <b>' +
        Math.min(score, goal.target).toLocaleString() + " / " + goal.target.toLocaleString() + "</b></span>";
      return;
    }
    goalsEl.innerHTML = goal.items.map((item, i) => {
      const done = item.got >= item.need;
      return '<span class="goal-chip' + (done ? " done" : "") + '">' +
        TYPES[item.type].emoji + " " + TYPES[item.type].name +
        " <b>" + Math.min(item.got, item.need) + "/" + item.need + "</b>" + (done ? " ✓" : "") + "</span>";
    }).join("");
  }

  function consumeCleared() {
    if (goal.kind === "score") return;
    for (let t = 0; t < TYPES.length; t++) {
      const item = goal.items.find(g => g.type === t);
      if (item) item.got += P.collected[t];
    }
  }

  async function clearAndRefill(cellSet, plan) {
    /* 1. 播放消除动画 */
    for (const k of cellSet) {
      const p = parse(k);
      const t = grid[p.r][p.c];
      if (t) t.el.classList.add("clearing");
    }
    await wait(260);

    /* 2. 移除被清除的 DOM，并让 C 核心完成清除/重力/补充 */
    for (const k of cellSet) {
      const p = parse(k);
      const t = grid[p.r][p.c];
      if (t) { t.el.remove(); grid[p.r][p.c] = null; }
    }
    WASM.m3_apply_clear();

    /* 3. 按 C 给出的移动表重建棋盘与 DOM（保持掉落动画） */
    const old = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) old[idx(r, c)] = grid[r][c];
    const next = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    for (let i = 0; i < 64; i++) {
      const p = posOf(i);
      const from = P.moveFrom[i];
      let t = null;
      if (from >= 0) {
        t = old[from];
        if (t) positionTile(t, p.r, p.c, true);
      }
      if (!t) {
        t = makeTile(P.moveType[i] >= 0 ? P.moveType[i] : P.type[i], p.r, p.c, null);
        positionTile(t, p.r, p.c, true);
        t.el.classList.add("spawn");
        setTimeout(() => t.el.classList.remove("spawn"), 320);
      }
      refreshTile(t, P.type[i], SP_NAME[P.sp[i]]);
      next[p.r][p.c] = t;
    }
    grid = next;
    await wait(340);
  }

  async function cascadeLoop(firstSwap) {
    let chain = 0;
    let preferred = firstSwap || null;
    while (true) {
      const found = findMatches();
      if (!found.cells.size) break;
      chain++;
      const plan = planSpecials(found.runs, preferred);
      preferred = null;
      WASM.m3_compute_clear(chain, -1);
      const cleared = new Set();
      for (let i = 0; i < WASM.m3_clear_count(); i++) {
        const p = posOf(P.clear[i]);
        cleared.add(key(p.r, p.c));
      }
      consumeCleared();
      const gained = WASM.m3_clear_score();
      addScore(gained);
      floatScore(gained, centroid(cleared));
      Sound.pop(cleared.size);
      if (chain > 1) { comboBanner(chain); Sound.combo(chain); }
      if (plan.size) Sound.special();
      await clearAndRefill(cleared, plan);
    }
  }

  function adjacent(a, b) {
    return Math.abs(a.row - b.row) + Math.abs(a.col - b.col) === 1;
  }

  async function attemptSwap(a, b) {
    if (busy || !a || !b || !adjacent(a, b)) return;
    busy = true;
    clearSelection();
    swapTiles(a, b);
    Sound.swap();
    await wait(200);

    const bombInvolved = a.special === "bomb" || b.special === "bomb" || (a.special && b.special);
    const matched = WASM.m3_find_matches() > 0;
    if (!matched && !bombInvolved) {
      swapTiles(a, b);
      await wait(200);
      Sound.invalid();
      toast("这样交换不能消除哦");
      busy = false;
      return;
    }

    moves--;
    movesVal.textContent = moves;
    renderGoals();

    if (bombInvolved) {
      WASM.m3_bomb_clear(idx(a.row, a.col), idx(b.row, b.col), 1);
      const cleared = new Set();
      for (let i = 0; i < WASM.m3_clear_count(); i++) {
        const p = posOf(P.clear[i]);
        cleared.add(key(p.r, p.c));
      }
      consumeCleared();
      const gained = WASM.m3_clear_score();
      addScore(gained);
      floatScore(gained, centroid(cleared));
      Sound.pop(cleared.size);
      Sound.special();
      comboBanner(cleared.size > 12 ? "全屏消除!" : "特殊消除!");
      await clearAndRefill(cleared, new Map());
      await cascadeLoop(null);
    } else {
      await cascadeLoop({ row: b.row, col: b.col });
    }

    await finishTurn();
    busy = false;
  }

  async function finishTurn() {
    renderGoals();
    const complete = goal.kind === "score"
      ? score >= goal.target
      : goal.items.every(g => g.got >= g.need);
    if (complete) { recordClear(level, score); showOverlay(true); return; }
    if (moves <= 0) { showOverlay(false); return; }
    if (!WASM.m3_find_valid_swap()) {
      toast("没有可消除的组合，自动洗牌");
      await wait(400);
      shuffleTiles(false);
    }
  }

  function showOverlay(won) {
    if (won) Sound.win(); else Sound.lose();
    document.getElementById("ovIcon").textContent = won ? "🏆" : "😵";
    document.getElementById("ovTitle").textContent = won ? "恭喜过关！" : "步数用完了";
    document.getElementById("ovText").textContent = won
      ? "第 " + level + " 关完成，得分 " + score.toLocaleString() + "。"
      : "还差一点目标，试试特殊糖果和道具再挑战一次。";
    const primary = document.getElementById("ovPrimary");
    primary.textContent = won ? "下一关 →" : "再试一次";
    primary.onclick = () => {
      overlay.classList.add("hidden");
      if (won) { level++; startLevel(); }
      else startLevel();
    };
    document.getElementById("ovSecondary").onclick = () => {
      overlay.classList.add("hidden");
      startLevel();
    };
    document.getElementById("ovLevelsBtn").onclick = () => {
      overlay.classList.add("hidden");
      openLevels();
    };
    overlay.classList.remove("hidden");
  }

  function openLevels() {
    const gridEl = document.getElementById("levelsGrid");
    const count = Object.keys(progress.cleared).length;
    document.getElementById("levelsSub").textContent =
      "已通关 " + count + " 关 · 已解锁至第 " + progress.unlocked + " 关（通关后自动解锁下一关，进度保存在本机）";
    let html = "";
    for (let n = 1; n <= TOTAL_LEVELS; n++) {
      const done = !!progress.cleared[n];
      const locked = n > progress.unlocked;
      const cls = locked ? "locked" : done ? "done" : (n === level ? "current" : "");
      const stars = done ? "★★★" : locked ? "🔒" : (n === level ? "当前" : "可挑战");
      const best = done && progress.best[n] ? progress.best[n].toLocaleString() + "分" : "";
      html += '<div class="level-cell ' + cls + '" data-level="' + n + '">' +
        '<span class="num">' + n + "</span>" +
        '<span class="stars">' + stars + "</span>" +
        '<span class="score">' + best + "</span></div>";
    }
    gridEl.innerHTML = html;
    document.getElementById("levelsPanel").classList.remove("hidden");
  }

  function clearSelection() {
    if (selected) selected.el.classList.remove("selected");
    selected = null;
  }

  function selectTile(tile) {
    if (selected === tile) { clearSelection(); return; }
    if (!selected) {
      selected = tile;
      tile.el.classList.add("selected");
      return;
    }
    if (adjacent(selected, tile)) {
      const a = selected;
      clearSelection();
      attemptSwap(a, tile);
    } else {
      clearSelection();
      selected = tile;
      tile.el.classList.add("selected");
    }
  }

  function tileFromEvent(e) {
    const el = e.target.closest(".tile");
    if (!el) return null;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++)
      if (grid[r][c] && grid[r][c].el === el) return grid[r][c];
    return null;
  }

  let dragStart = null;
  let suppressClick = false;
  board.addEventListener("pointerdown", (e) => {
    if (busy) return;
    const t = tileFromEvent(e);
    if (t) dragStart = t;
  });
  board.addEventListener("pointerup", (e) => {
    if (busy || !dragStart) return;
    const t = tileFromEvent(e);
    const start = dragStart;
    dragStart = null;
    if (!t || t === start) return;
    if (adjacent(start, t)) {
      suppressClick = true;
      clearSelection();
      attemptSwap(start, t);
    }
  });
  board.addEventListener("pointercancel", () => { dragStart = null; });
  board.addEventListener("click", (e) => {
    if (suppressClick) { suppressClick = false; return; }
    if (busy) return;
    const t = tileFromEvent(e);
    if (t) selectTile(t);
  });

  function showHint() {
    if (boosters.hint <= 0 || busy) return;
    const v = WASM.m3_find_valid_swap();
    if (!v) { toast("当前没有可交换的组合"); return; }
    boosters.hint--;
    document.getElementById("hintCount").textContent = boosters.hint;
    document.getElementById("hintBtn").disabled = boosters.hint <= 0;
    [Math.floor((v - 1) / 64), (v - 1) % 64].forEach(i => {
      const p = posOf(i);
      const t = grid[p.r][p.c];
      if (t) { t.el.classList.add("hint"); setTimeout(() => t.el.classList.remove("hint"), 1450); }
    });
  }

  function shuffleTiles(useBooster) {
    if (busy) return;
    if (useBooster) {
      if (boosters.shuffle <= 0) return;
      boosters.shuffle--;
      document.getElementById("shuffleCount").textContent = boosters.shuffle;
      document.getElementById("shuffleBtn").disabled = boosters.shuffle <= 0;
    }
    clearSelection();
    WASM.m3_shuffle();
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const i = idx(r, c);
        if (grid[r][c]) refreshTile(grid[r][c], P.type[i], null);
      }
    }
    Sound.bonus();
    toast("棋盘已重新洗牌");
  }

  function addExtraMoves() {
    if (boosters.extra <= 0 || busy) return;
    boosters.extra--;
    document.getElementById("extraCount").textContent = boosters.extra;
    document.getElementById("extraBtn").disabled = boosters.extra <= 0;
    moves += 5;
    movesVal.textContent = moves;
    Sound.bonus();
    toast("步数 +5");
  }

  function startLevel() {
    const cfg = configFor(level);
    moves = cfg.moves;
    score = 0;
    goal = JSON.parse(JSON.stringify(cfg.goal));
    goal.items && goal.items.forEach(g => { g.got = 0; });
    boosters = { hint: 2, shuffle: 2, extra: 2 };
    ["hint", "shuffle", "extra"].forEach(k => {
      const btn = document.getElementById(k + "Count");
      btn.textContent = "2";
      document.getElementById(k + "Btn").disabled = false;
    });
    levelVal.textContent = level;
    scoreVal.textContent = "0";
    movesVal.textContent = moves;
    selected = null;
    busy = false;
    overlay.classList.add("hidden");
    buildBoard();
    renderGoals();
  }

  document.getElementById("restartBtn").onclick = () => startLevel();
  document.getElementById("levelsBtn").onclick = openLevels;
  document.getElementById("closeLevelsBtn").onclick = () => document.getElementById("levelsPanel").classList.add("hidden");
  document.getElementById("levelsGrid").addEventListener("click", (e) => {
    const cell = e.target.closest(".level-cell");
    if (!cell || cell.classList.contains("locked")) return;
    document.getElementById("levelsPanel").classList.add("hidden");
    level = Number(cell.dataset.level);
    startLevel();
  });
  document.getElementById("hintBtn").onclick = showHint;
  document.getElementById("shuffleBtn").onclick = () => shuffleTiles(true);
  document.getElementById("extraBtn").onclick = addExtraMoves;
  document.getElementById("musicBtn").onclick = (e) => {
    const on = Sound.toggleMusic();
    e.currentTarget.textContent = on ? "🎵 音乐开" : "🎵 音乐关";
    e.currentTarget.classList.toggle("off", !on);
  };
  document.getElementById("soundBtn").onclick = (e) => {
    const on = Sound.toggleSfx();
    e.currentTarget.textContent = on ? "🔊 音效开" : "🔇 音效关";
    e.currentTarget.classList.toggle("off", !on);
  };

  window.__match3 = {
    state: () => ({ level, score, moves, goal: JSON.parse(JSON.stringify(goal)), boosters: { ...boosters }, busy }),
    grid: () => grid.map(row => row.map(t => t ? {
      type: P.type[idx(t.row, t.col)],
      special: SP_NAME[P.sp[idx(t.row, t.col)]],
      row: t.row, col: t.col
    } : null)),
    validSwap: () => {
      const v = WASM.m3_find_valid_swap();
      if (!v) return null;
      const a = posOf(Math.floor((v - 1) / 64)), b = posOf((v - 1) % 64);
      return [{ row: a.r, col: a.c }, { row: b.r, col: b.c }];
    },
    startLevel: startLevel,
    gotoLevel: (n) => { level = n; startLevel(); },
    progress: () => JSON.parse(JSON.stringify(progress)),
    resetProgress: () => { progress = { unlocked: 1, cleared: {}, best: {} }; saveProgress(); },
    audio: () => Sound.status(),
    engine: () => "C/WebAssembly",
    swap: (r1, c1, r2, c2) => attemptSwap(grid[r1][c1], grid[r2][c2])
  };

  startLevel();
})();
