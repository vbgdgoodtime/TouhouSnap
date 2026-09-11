/* =========================================================
   东方逆转 · card-browser.js（v92→v97；v178 改两层筛选；v181 加卡池排序）
   图鉴 / 开发者“指定卡牌”页面的筛选与卡牌网格渲染。
   v178：筛选改为**两层**结构 ——
     第 1 层「卡池」（`#codexPool` / `#pickPool`，`.pool-btn` 按钮组）：
       普通卡牌池（POOL 人物卡）/ 衍生卡牌池（SPECIAL token，不含静态占位「隙间」）。
       衍生卡牌**不再与 1~6 费并列成同一排 chip**，而是与「整个卡池」平级的顶层切换。
     第 2 层「费用」（`#codexFilter` / `#pickFilter`，`.chip`）：
       当前卡池内的费用档：全部 / 0-1 费 / 2 费 / 3 费 / 4 费 / 5 费 / **6 费+**（按 def.c）。
       （**v185**：原「6 费」档改为 **「6 费+」**＝6 费及以上，用于容纳新增的 **7 费**档「哆来咪」、以及 **v194 新增的 8 费**档「纯狐」；
        档内顺序仍是「费用↑ → 战力↑ → 卡名字典序」，故 6 费卡在前、7 费其次、8 费最后。）
       两池**各自**记住自己的费用档，来回切换不重置对方。
   卡牌点击：图鉴 = 放大查看；「指定卡牌」= 人物卡与**法术 token** 可加入手牌，
     其余衍生卡（石块/厄运/河童/幽灵/水银…）在衍生卡池里仅可查看。
    v181：**卡池内的展示顺序固定为「费用↑ → 战力↑ → 卡名字典序」**——两个卡池
      （普通卡牌池 / 衍生卡牌池）与两个页面（图鉴 / 指定卡牌）共用同一个比较器
      `orderDefs`，因此网格顺序与当前费用档无关（换档只是把同一有序列表切开看）。
   依赖（运行时）：window.DS_CARDS.POOL / .SPECIAL 与 game.js 暴露的
   gradOf / cardFaceHTML / showZoom / newCard / log / setStatus /
   renderHand / hidePowerPanel 与顶层 state（牌数/加牌）等。
   页面入口仍由 game.js 转发（uiOnCodex / uiOnPick … → window.CardBrowser）。
   注：0-1 档 = 0 费与 1 费合并（**v197 起 0 费档已无卡牌**：稗田阿求重做为 1 费并搬到 1 费组，
   故该档现在显示的 1 费卡里也含阿求；「衍生卡池」里的 0 费是幽灵）。
   ========================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var POOL = (window.DS_CARDS && window.DS_CARDS.POOL) || {};
  var SPECIAL = (window.DS_CARDS && window.DS_CARDS.SPECIAL) || {};
  // v185：POOL 实际存在的费用档键（升序）——新增 7 费档后卡池遍历自动跟随，不再写死 0~6
  var POOL_COST_KEYS = Object.keys(POOL)
    .map(Number)
    .filter(function (c) { return isFinite(c); })
    .sort(function (a, b) { return a - b; });

  // 衍生卡牌 = SPECIAL 中所有“可玩/可见”token（去掉 un 的静态占位，如隙间）
  var TOKEN_DEFS = [];
  Object.keys(SPECIAL).forEach(function (k) {
    var d = SPECIAL[k];
    if (d && !d.un) TOKEN_DEFS.push(d);
  });

  /* v178：两层筛选结构的定义 ——
     第 1 层「卡池」：普通卡牌池（POOL 人物卡）/ 衍生卡牌池（SPECIAL 里的 token）
     第 2 层「费用」：当前卡池内的费用档（按 def.c 过滤）
     衍生卡池里的印刷费用覆盖 0 / 1 / 3 / 4 / 6 费（2 费、5 费档在该池里为空，
     此时网格显示「该费用档暂无卡牌」提示，属正常）。
     v185：普通卡牌池新增 **7 费**档（「哆来咪」），因此该池在原「6 费」档位置改用
     **「6 费+」**（6 费及以上）；衍生卡池没有 ≥6 费之外的卡，故该档在衍生池里与原来等价。 */
  var POOL_TABS = [
    { key: 'normal', label: '普通卡牌池', tip: '人物卡（POOL）：可入卡组，按 0 费及以上分档（现为 0~8 费）' },
    { key: 'token', label: '衍生卡牌池', tip: '特殊卡 / token（SPECIAL）：不入牌库，按费用分档；法术 token 可加入手牌' },
  ];

  // 费用档定义（在“当前卡池”内生效）：costs=null 表示全部；min=N 表示“N 费及以上”
  // （v185：原「6 费」档改为「6 费+」= 6 费及以上，因为新增了 7 费档「哆来咪」；
  //  网格顺序仍由 orderDefs 决定＝费用↑ → 战力↑ → 卡名字典序，所以「6 费+」里 6 费在前、7 费在后）
  var COST_FILTERS = [
    { key: 'all', label: '全部', costs: null },
    { key: '01', label: '0-1 费', costs: [0, 1] },
    { key: '2', label: '2 费', costs: [2] },
    { key: '3', label: '3 费', costs: [3] },
    { key: '4', label: '4 费', costs: [4] },
    { key: '5', label: '5 费', costs: [5] },
    { key: '6', label: '6 费+', min: 6 },
  ];

  // 每页各自记住「当前卡池 + 各池各自的费用档 + 选中」（打开/关闭不清空，便于反复查看）
  var page = {
    codex: { pool: 'normal', cost: { normal: 'all', token: 'all' }, picked: null },
    pick: { pool: 'normal', cost: { normal: 'all', token: 'all' }, picked: null },
  };

  function allPoolDefs() {
    var out = [];
    for (var i = 0; i < POOL_COST_KEYS.length; i++) {
      var arr = POOL[POOL_COST_KEYS[i]];
      if (!arr) continue;
      for (var j = 0; j < arr.length; j++) out.push(arr[j]);
    }
    return out;
  }
  /** 当前页所在的卡池键：'normal' 普通卡牌池 / 'token' 衍生卡牌池 */
  function poolKey(kind) { return page[kind].pool === 'token' ? 'token' : 'normal'; }
  /** 当前页、当前卡池生效的费用档键（各池各自记忆） */
  function costKey(kind) {
    var k = page[kind].cost[poolKey(kind)];
    return k || 'all';
  }
  function poolLabel(kind) { return poolKey(kind) === 'token' ? '衍生卡牌池' : '普通卡牌池'; }
  /** 当前费用档对象 */
  function filterBy(kind) {
    var key = costKey(kind);
    for (var i = 0; i < COST_FILTERS.length; i++) {
      if (COST_FILTERS[i].key === key) return COST_FILTERS[i];
    }
    return COST_FILTERS[0];
  }
  /** 当前卡池的全部卡（尚未按费用过滤）：普通池 = POOL 人物卡；衍生池 = SPECIAL token（不含 un 占位） */
  function poolDefsOf(kind) {
    return poolKey(kind) === 'token' ? TOKEN_DEFS.slice() : allPoolDefs();
  }
  /* v181：卡池内的**固定展示顺序**——① 费用（`def.c`，印刷费用）从小到大 →
     ② 战力（`def.p`）从小到大 → ③ 卡名（`def.n`）字典序（按字符编码逐位比较；
     编码相同则视为同序，`Array.prototype.sort` 在现代浏览器里稳定、原顺序保留）。
     费用 / 战力都是数值比较（不是字符串），故 10 战力排在 12 战力之前、−7 战力排在 −3 之前。
     两个卡池与两个页面共用本函数：`poolDefsOf(kind).sort(orderDefs)` 的结果与当前费用档无关。 */
  function orderDefs(a, b) {
    if (a.c !== b.c) return a.c - b.c;
    if (a.p !== b.p) return a.p - b.p;
    var an = String(a.n), bn = String(b.n);
    return an < bn ? -1 : (an > bn ? 1 : 0);
  }
  function defsFor(kind) {
    var f = filterBy(kind);
    var costs = f.costs;
    // sort 直接作用于 poolDefsOf 返回的新数组（衍生池是 TOKEN_DEFS.slice()、
    // 普通池是 allPoolDefs() 现造的数组），不会污染源数据
    return poolDefsOf(kind).sort(orderDefs).filter(function (d) {
      if (f.min != null) return d.c >= f.min; // v185：「6 费+」= 6 费及以上（含 7 费「哆来咪」、v194 的 8 费「纯狐」）
      return !costs || costs.indexOf(d.c) >= 0;
    });
  }
  function isTokenDef(def) { return TOKEN_DEFS.indexOf(def) >= 0; }

  /* ---------- 第 1 层：卡池切换按钮（构建进 #codexPool / #pickPool） ---------- */
  function buildPoolTabs(kind) {
    var holder = $(kind === 'codex' ? 'codexPool' : 'pickPool');
    if (!holder) return;
    holder.innerHTML = '';
    POOL_TABS.forEach(function (p) {
      var on = poolKey(kind) === p.key;
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pool-btn' + (on ? ' active' : '');
      b.textContent = p.label;
      b.title = p.tip;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', function () {
        if (poolKey(kind) === p.key) return;
        page[kind].pool = p.key;
        page[kind].picked = null; // 换卡池后清空已选（两个池各自的费用档都保留）
        refresh(kind);
      });
      holder.appendChild(b);
    });
  }

  /* ---------- 第 2 层：当前卡池内的费用档 chip（构建进 #codexFilter / #pickFilter） ---------- */
  function buildChips(kind) {
    var holder = $(kind === 'codex' ? 'codexFilter' : 'pickFilter');
    if (!holder) return;
    holder.innerHTML = '';
    var cur = costKey(kind);
    COST_FILTERS.forEach(function (f) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (cur === f.key ? ' active' : '');
      b.textContent = f.label;
      b.title = poolLabel(kind) + ' · 只看「' + f.label + '」的卡牌';
      b.addEventListener('click', function () {
        if (costKey(kind) === f.key) return;
        page[kind].cost[poolKey(kind)] = f.key;
        page[kind].picked = null; // 换筛选后清空已选
        refresh(kind);
      });
      holder.appendChild(b);
    });
  }

  // 重新渲染整块筛选区：卡池切换 → 费用档 chip → 卡牌网格
  function refresh(kind) {
    buildPoolTabs(kind);
    buildChips(kind);
    renderGrid(kind);
  }

  /* ---------- 卡牌网格 ---------- */
  function renderGrid(kind) {
    var isCodex = kind === 'codex';
    var grid = $(isCodex ? 'codexGrid' : 'pickGrid');
    var defs = defsFor(kind);
    if (grid) grid.innerHTML = '';

    if (defs.length === 0) {
      var none = document.createElement('div');
      none.className = 'codex-empty';
      none.textContent = '「' + poolLabel(kind) + '」在该费用档暂无卡牌。';
      if (grid) grid.appendChild(none);
    }
    defs.forEach(function (def) {
      var el = document.createElement('div');
      // 无图卡加 .no-img：emoji 占正方形立绘区，与有图卡同高同宽（对齐手牌 v103 / 卡组池 v133）
      el.className = 'codex-card hand-card'
        + (def.img ? '' : ' no-img')
        + (isTokenDef(def) ? ' token-card' : '');
      el.style.setProperty('--cgrad', gradOf(def));
      el.innerHTML = cardFaceHTML(def);
      // v170：法术 token（def.spell）在「指定卡牌」页可以加入手牌（便于调试机制），
      // 其余衍生卡仍维持“仅可查看、不加入手牌”的口径
      el.title = def.n + (isTokenDef(def) ? (def.spell ? '（法术 · 衍生卡牌）' : '（衍生卡牌）') : '');
      if (isCodex) {
        el.addEventListener('click', function () { showZoom(def); });
      } else if (isTokenDef(def) && !def.spell) {
        // 衍生卡在“指定卡牌”页仅可查看，防止误选加入手牌
        el.addEventListener('click', function () { showZoom(def); });
        el.title = def.n + '（衍生卡牌 · 仅可查看）';
      } else {
        el.addEventListener('click', function () {
          page.pick.picked = def;
          if (grid) grid.querySelectorAll('.pick-picked').forEach(function (x) { x.classList.remove('pick-picked'); });
          el.classList.add('pick-picked');
          $('pickTip').textContent = '已选：「' + def.n + '」（' + def.c + ' 费 / '
            + ((def && def.spell) ? '法术 · 无战力' : ('威力 ' + def.p)) + '）';
        });
      }
      if (grid) grid.appendChild(el);
    });

    var f = filterBy(kind);
    if (isCodex) {
      // v178：计数里带上当前卡池名，让「两层筛选」的第一层一眼可见
      $('codexCount').textContent = defs.length + ' 种 · ' + poolLabel(kind)
        + (f.key !== 'all' ? '（' + f.label + '）' : '');
    } else {
      var extra = poolKey(kind) === 'token' ? ' · 衍生卡仅可查看、法术 token 可加入手牌' : '';
      $('pickTip').textContent = '当前手牌 ' + state.players.p.hand.length + '/7 — 点选 1 张后确认（'
        + poolLabel(kind) + ' · ' + f.label + '）' + extra;
    }
  }

  /* ---------- 图鉴 ---------- */
  function toggleCodex() {
    var mask = $('codexMask');
    if (mask.classList.contains('hidden')) openCodex();
    else closeCodex();
  }
  function openCodex() {
    page.codex.picked = null;
    refresh('codex');
    $('codexMask').classList.remove('hidden');
  }
  function closeCodex() {
    $('zoomMask').classList.add('hidden');
    $('codexMask').classList.add('hidden');
    hidePowerPanel();
  }

  /* ---------- 开发者：指定卡牌 ---------- */
  function togglePick() {
    var mask = $('pickMask');
    if (mask.classList.contains('hidden')) openPick();
    else closePick();
  }
  function openPick() {
    page.pick.picked = null;
    refresh('pick');
    $('pickMask').classList.remove('hidden');
  }
  function closePick() {
    $('pickMask').classList.add('hidden');
    page.pick.picked = null;
  }
  function confirmPick() {
    var def = page.pick.picked;
    if (!def) { setStatus('请先在弹窗里点选一张卡牌。'); return; }
    if (isTokenDef(def) && !def.spell) { setStatus('衍生卡牌仅可查看，不能加入手牌（法术 token 除外）。'); return; }
    var pl = state.players.p;
    if (pl.hand.length >= 7) {
      setStatus('手牌已满（' + pl.hand.length + '/7），无法加入「' + def.n + '」。');
      return;
    }
    var name = def.n;
    var card = newCard(def);
    card.side = 'p';
    card.justHandAdded = true; // v90：加入手牌演出
    pl.hand.push(card);
    log('sys', '🎯 开发者指令：指定「' + name + '」加入你的手牌（现 ' + pl.hand.length + '/7）。');
    setStatus('已将「' + name + '」加入手牌（' + pl.hand.length + '/7）。');
    page.pick.picked = null;
    $('pickMask').classList.add('hidden');
    renderHand();
  }

  window.CardBrowser = {
    POOL_TABS: POOL_TABS,
    COST_FILTERS: COST_FILTERS,
    TOKEN_DEFS: TOKEN_DEFS,
    orderDefs: orderDefs, // v181：卡池排序比较器（费用↑ → 战力↑ → 卡名字典序），供调试/复用
    toggleCodex: toggleCodex,
    openCodex: openCodex,
    closeCodex: closeCodex,
    togglePick: togglePick,
    openPick: openPick,
    closePick: closePick,
    confirmPick: confirmPick,
  };
})();
