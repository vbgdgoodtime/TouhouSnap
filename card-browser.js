/* =========================================================
   东方逆转 · card-browser.js（v92→v97）
   图鉴 / 开发者“指定卡牌”页面的费用筛选与卡牌网格渲染。
   筛选档：全部 / 0-1 费 / 2 费 / 3 费 / 4 费 / 5 费 / 6 费 / 衍生卡牌。
   —— 衍生卡牌：展示所有特殊卡 token（石块/厄运/赫卡提亚的分身/废弃列车），
      静态占位「隙间」不列入；图鉴中可点击放大查看；
      “指定卡牌”页里衍生卡仅可查看（不参与“加入手牌”选择）。
   依赖（运行时）：window.DS_CARDS.POOL / .SPECIAL 与 game.js 暴露的
   gradOf / cardFaceHTML / showZoom / newCard / log / setStatus /
   renderHand / hidePowerPanel 与顶层 state（牌数/加牌）等。
   页面入口仍由 game.js 转发（uiOnCodex / uiOnPick … → window.CardBrowser）。
   注：0-1 档 = 0 费（稗田阿求，暂不入牌库）与 1 费合并。
   ========================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var POOL = (window.DS_CARDS && window.DS_CARDS.POOL) || {};
  var SPECIAL = (window.DS_CARDS && window.DS_CARDS.SPECIAL) || {};

  // 衍生卡牌 = SPECIAL 中所有“可玩/可见”token（去掉 un 的静态占位，如隙间）
  var TOKEN_DEFS = [];
  Object.keys(SPECIAL).forEach(function (k) {
    var d = SPECIAL[k];
    if (d && !d.un) TOKEN_DEFS.push(d);
  });

  // 筛选档定义：costs=null 表示全部；token=true 表示“衍生卡牌”
  var COST_FILTERS = [
    { key: 'all', label: '全部', costs: null },
    { key: '01', label: '0-1 费', costs: [0, 1] },
    { key: '2', label: '2 费', costs: [2] },
    { key: '3', label: '3 费', costs: [3] },
    { key: '4', label: '4 费', costs: [4] },
    { key: '5', label: '5 费', costs: [5] },
    { key: '6', label: '6 费', costs: [6] },
    { key: 'token', label: '衍生卡牌', token: true },
  ];

  // 每页各自记住筛选与选中（打开/关闭不清空筛选，便于反复查看）
  var page = {
    codex: { filterKey: 'all', picked: null },
    pick: { filterKey: 'all', picked: null },
  };

  function allPoolDefs() {
    var out = [];
    for (var c = 0; c <= 6; c++) {
      var arr = POOL[c];
      if (!arr) continue;
      for (var i = 0; i < arr.length; i++) out.push(arr[i]);
    }
    return out;
  }
  function filterBy(kind) {
    var key = page[kind].filterKey;
    for (var i = 0; i < COST_FILTERS.length; i++) {
      if (COST_FILTERS[i].key === key) return COST_FILTERS[i];
    }
    return COST_FILTERS[0];
  }
  function defsFor(kind) {
    var f = filterBy(kind);
    if (f && f.token) return TOKEN_DEFS.slice();
    var costs = f ? f.costs : null;
    return allPoolDefs().filter(function (d) { return !costs || costs.indexOf(d.c) >= 0; });
  }
  function isTokenDef(def) { return TOKEN_DEFS.indexOf(def) >= 0; }

  /* ---------- 筛选按钮条（构建进 #codexFilter / #pickFilter） ---------- */
  function buildChips(kind) {
    var holder = $(kind === 'codex' ? 'codexFilter' : 'pickFilter');
    if (!holder) return;
    holder.innerHTML = '';
    COST_FILTERS.forEach(function (f) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (page[kind].filterKey === f.key ? ' active' : '');
      b.textContent = f.label;
      b.title = f.token ? '只看特殊卡（token 衍生卡牌）' : ('只看 ' + f.label + ' 的卡牌');
      b.addEventListener('click', function () {
        if (page[kind].filterKey === f.key) return;
        page[kind].filterKey = f.key;
        page[kind].picked = null; // 换筛选后清空已选
        refresh(kind);
      });
      holder.appendChild(b);
    });
  }

  function refresh(kind) {
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
      none.textContent = '该筛选档暂无卡牌。';
      if (grid) grid.appendChild(none);
    }
    defs.forEach(function (def) {
      var el = document.createElement('div');
      el.className = 'codex-card hand-card' + (isTokenDef(def) ? ' token-card' : '');
      el.style.setProperty('--cgrad', gradOf(def));
      el.innerHTML = cardFaceHTML(def);
      el.title = def.n + (isTokenDef(def) ? '（衍生卡牌）' : '');
      if (isCodex) {
        el.addEventListener('click', function () { showZoom(def); });
      } else if (isTokenDef(def)) {
        // 衍生卡在“指定卡牌”页仅可查看，防止误选加入手牌
        el.addEventListener('click', function () { showZoom(def); });
        el.title = def.n + '（衍生卡牌 · 仅可查看）';
      } else {
        el.addEventListener('click', function () {
          page.pick.picked = def;
          if (grid) grid.querySelectorAll('.pick-picked').forEach(function (x) { x.classList.remove('pick-picked'); });
          el.classList.add('pick-picked');
          $('pickTip').textContent = '已选：「' + def.n + '」（' + def.c + ' 费 / 威力 ' + def.p + '）';
        });
      }
      if (grid) grid.appendChild(el);
    });

    var f = filterBy(kind);
    if (isCodex) {
      $('codexCount').textContent = defs.length + ' 种' + (f.key !== 'all' ? '（' + f.label + '）' : '');
    } else {
      var extra = f.token ? ' · 衍生卡仅可查看，不加入手牌' : '';
      $('pickTip').textContent = '当前手牌 ' + state.players.p.hand.length + '/7 — 点选 1 张后确认（当前：' + f.label + '）' + extra;
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
    if (isTokenDef(def)) { setStatus('衍生卡牌仅可查看，不能加入手牌。'); return; }
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
    COST_FILTERS: COST_FILTERS,
    TOKEN_DEFS: TOKEN_DEFS,
    toggleCodex: toggleCodex,
    openCodex: openCodex,
    closeCodex: closeCodex,
    togglePick: togglePick,
    openPick: openPick,
    closePick: closePick,
    confirmPick: confirmPick,
  };
})();
