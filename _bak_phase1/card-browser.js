/* =========================================================
   东方逆转 · card-browser.js
   图鉴 / 开发者「指定卡牌」页：两层筛选（卡池 → 费用档）与卡牌网格渲染。
   卡池＝普通卡牌池（POOL 人物卡）/ 衍生卡牌池（SPECIAL token，不含 un 占位），两池各自记忆费用档。
   依赖运行时：window.DS_CARDS.POOL/.SPECIAL 与 game.js 暴露的 gradOf / cardFaceHTML / showZoom /
   newCard / log / setStatus / renderHand / hidePowerPanel 与顶层 state；入口由 game.js 转发
   ========================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var POOL = (window.DS_CARDS && window.DS_CARDS.POOL) || {};
  var SPECIAL = (window.DS_CARDS && window.DS_CARDS.SPECIAL) || {};
  // POOL 实际存在的费用档键（升序）：不写死档位，新增费用档时卡池遍历自动跟随
  var POOL_COST_KEYS = Object.keys(POOL)
    .map(Number)
    .filter(function (c) { return isFinite(c); })
    .sort(function (a, b) { return a - b; });

  // 衍生卡牌 = SPECIAL 中可玩/可见的 token（带 un 的静态占位如隙间除外）
  var TOKEN_DEFS = [];
  Object.keys(SPECIAL).forEach(function (k) {
    var d = SPECIAL[k];
    if (d && !d.un) TOKEN_DEFS.push(d);
  });

  /* 两层筛选定义：第 1 层「卡池」（POOL 人物卡 / SPECIAL token），第 2 层当前池内的「费用档」（按 def.c）。
     ⚠️ 衍生卡池里 2 费、5 费档为空，网格显示「该费用档暂无卡牌」属正常，不是筛选坏了。 */
  var POOL_TABS = [
    { key: 'normal', label: '普通卡牌池', tip: '人物卡（POOL）：可入卡组，按 0 费及以上分档（现为 0~8 费）' },
    { key: 'token', label: '衍生卡牌池', tip: '特殊卡 / token（SPECIAL）：不入牌库，按费用分档；法术 token 可加入手牌' },
  ];

  // 费用档定义（在当前卡池内生效）：costs=null 表示全部；min=N 表示「N 费及以上」；0-1 档 = 0 费与 1 费合并
  var COST_FILTERS = [
    { key: 'all', label: '全部', costs: null },
    { key: '01', label: '0-1 费', costs: [0, 1] },
    { key: '2', label: '2 费', costs: [2] },
    { key: '3', label: '3 费', costs: [3] },
    { key: '4', label: '4 费', costs: [4] },
    { key: '5', label: '5 费', costs: [5] },
    { key: '6', label: '6 费+', min: 6 },
  ];

  // 每页各自记住「当前卡池 + 各池各自的费用档 + 选中」（反复开关不清空）
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
  function poolKey(kind) { return page[kind].pool === 'token' ? 'token' : 'normal'; }
  function costKey(kind) {
    var k = page[kind].cost[poolKey(kind)];
    return k || 'all';
  }
  function poolLabel(kind) { return poolKey(kind) === 'token' ? '衍生卡牌池' : '普通卡牌池'; }
  function filterBy(kind) {
    var key = costKey(kind);
    for (var i = 0; i < COST_FILTERS.length; i++) {
      if (COST_FILTERS[i].key === key) return COST_FILTERS[i];
    }
    return COST_FILTERS[0];
  }
  function poolDefsOf(kind) {
    return poolKey(kind) === 'token' ? TOKEN_DEFS.slice() : allPoolDefs();
  }
  /* 卡池内的固定展示顺序：① 费用（def.c）→ ② 战力（def.p）→ ③ 卡名（def.n）字典序；
     费用/战力按数值比较（非字符串），现代浏览器的 sort 稳定。两个卡池与两个页面共用本函数，与当前费用档无关。 */
  function orderDefs(a, b) {
    if (a.c !== b.c) return a.c - b.c;
    if (a.p !== b.p) return a.p - b.p;
    var an = String(a.n), bn = String(b.n);
    return an < bn ? -1 : (an > bn ? 1 : 0);
  }
  function defsFor(kind) {
    var f = filterBy(kind);
    var costs = f.costs;
    // sort 作用于 poolDefsOf 现造/slice 出的新数组，不会污染 POOL / TOKEN_DEFS 源数据
    return poolDefsOf(kind).sort(orderDefs).filter(function (d) {
      if (f.min != null) return d.c >= f.min; // 「6 费+」= 6 费及以上，档内含 6/7/8 费
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
        page[kind].picked = null; // 换池清空已选（两个池各自的费用档都保留）
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
        page[kind].picked = null;
        refresh(kind);
      });
      holder.appendChild(b);
    });
  }

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
      // 无图卡加 .no-img：emoji 占正方形立绘区，与有图卡同高同宽（对齐手牌 / 卡组池）
      el.className = 'codex-card hand-card'
        + (def.img ? '' : ' no-img')
        + (isTokenDef(def) ? ' token-card' : '');
      el.style.setProperty('--cgrad', gradOf(def));
      el.innerHTML = cardFaceHTML(def);
      // 法术 token（def.spell）在「指定卡牌」页可加入手牌（便于调试机制）；其余衍生卡仅可查看
      el.title = def.n + (isTokenDef(def) ? (def.spell ? '（法术 · 衍生卡牌）' : '（衍生卡牌）') : '');
      if (isCodex) {
        el.addEventListener('click', function () { showZoom(def); });
      } else if (isTokenDef(def) && !def.spell) {
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
    card.justHandAdded = true;
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
    orderDefs: orderDefs, // 卡池排序比较器，供调试 / 复用
    toggleCodex: toggleCodex,
    openCodex: openCodex,
    closeCodex: closeCodex,
    togglePick: togglePick,
    openPick: openPick,
    closePick: closePick,
    confirmPick: confirmPick,
  };
})();
