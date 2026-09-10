/* =========================================================
   东方逆转 · deck-page.js（v121~v135）
   卡组设置页面（主页面「卡组设置」入口）。

   页面构成（版面比例 ≈ 上 1/3 : 下 2/3，均在 index.html 的 #deckScreen 内）：
     - 上方 卡组栏：#deckSlots —— 两种形态：
         · 浏览态（默认）：**动态列表** =「＋ 新建卡组」位 + 已创建的卡组位
           （无固定空位，**每新建一个卡组就动态扩展出一格**，横向滚动）；
           显示顺序为**创建时间倒序**（v123：越晚创建越靠左、越早创建越靠右）；
           卡组位缩略图上悬浮**一个** 🗑️ 删除按钮（v124 加入、v129 去掉 ✏️）；
           **点卡组位任意位置（含图片）直接进入修改模式**（v129，不再需要 ✏️）。
         · 编辑态（v125，点卡组位进入）：把该卡组的 **12 个卡槽**排成网格
           （已放 = 卡面，点它移出；未放 = 与卡面同构的虚线「幽灵卡」空位带序号）。
       容量上限 DeckBuilder.MAX_DECKS = 20 套，每套 DeckBuilder.DECK_SIZE = 12 张。
     - 下方 卡牌区：#deckFilter + #deckGrid ——
       **v131：费用筛选条与游戏图鉴同款**（全部 / 0-1 费 / 2~6 费 / 衍生卡牌）；
       「全部」与费用档展示 POOL 人物卡；「衍生卡牌」展示 SPECIAL token（不含隙间），
       **仅可查看、不可加入卡组**（与指定卡牌页口径一致）。
       浏览态：左键 / 右键 = 放大查看（复用游戏 showZoom()）；
       编辑态：**左键 = 加入卡组**（v126：已在卡组中的卡牌加**灰色遮罩且不可点击**，
       移出改走「点上方卡槽」），右键 = 放大查看。

   已实装：卡组栏动态扩展、新建 / 删除 / 修改（加入·移出·清空）/ **改名**（v129）/
          **费用筛选**（v131）/ **本地持久化**（v135，`deck-storage.js`）/
          **编辑中即时按费用→战力排序**（v136）；
   待实装：对局使用自建卡组。

   入口 / 返回：
     window.DeckBuilder.open()  ← home.js 的 PAGES.deck（ready:true）
     window.DeckBuilder.close() → 回到主页面（Home.show()）
   依赖（game.js 暴露的全局）：gradOf / cardFaceHTML / showZoom；
   依赖（deck-storage.js）：window.DeckStorage.load/save。
   ========================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var MAX_DECKS = 20;  // 卡组栏容量（可存储的卡组套数）
  var DECK_SIZE = 12;  // 每套卡组张数（与牌库费用曲线 12 张一致）

  /* 默认占位卡组（仅在本地无存档时使用）；
     cards 存的是 POOL 里的 def 对象引用（同一张卡在全卡池里是同一对象，可直接比对）。 */
  var DEFAULT_DECKS = [
    { id: 'deck-1', name: '占位卡组 A', cards: [] },
    { id: 'deck-2', name: '占位卡组 B', cards: [] },
  ];

  var DECKS = [];
  var deckSeq = 0;
  var activeDeckId = null;
  var editingDeckId = null;                   // v125：正在修改的卡组（null = 浏览态）
  var justAddedId = null;                     // 本次渲染需要播“新增入场”动画的卡组位
  var poolFilterKey = 'all';                  // v131：卡池筛选档（打开/关闭保留）

  var rendered = false; // 卡牌网格是否已渲染过（卡池是静态数据）

  /* ---------- 卡池筛选（与 card-browser.js 图鉴同款） ---------- */
  // costs=null 表示全部人物卡；token=true 表示衍生卡牌（SPECIAL，不含 un 占位）
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

  function allPoolDefs() {
    var POOL = (window.DS_CARDS && window.DS_CARDS.POOL) || {};
    var out = [];
    for (var c = 0; c <= 6; c++) {
      var arr = POOL[c];
      if (!arr) continue;
      for (var i = 0; i < arr.length; i++) out.push(arr[i]);
    }
    return out;
  }
  // 对外兼容：poolDefs = 全部人物卡（不含筛选）
  function poolDefs() { return allPoolDefs(); }
  function tokenDefs() {
    var SPECIAL = (window.DS_CARDS && window.DS_CARDS.SPECIAL) || {};
    var out = [];
    Object.keys(SPECIAL).forEach(function (k) {
      var d = SPECIAL[k];
      if (d && !d.un) out.push(d);
    });
    return out;
  }
  function currentFilter() {
    for (var i = 0; i < COST_FILTERS.length; i++) {
      if (COST_FILTERS[i].key === poolFilterKey) return COST_FILTERS[i];
    }
    return COST_FILTERS[0];
  }
  function filteredDefs() {
    var f = currentFilter();
    if (f && f.token) return tokenDefs();
    var costs = f ? f.costs : null;
    return allPoolDefs().filter(function (d) { return !costs || costs.indexOf(d.c) >= 0; });
  }
  function isTokenDef(def) {
    var SPECIAL = (window.DS_CARDS && window.DS_CARDS.SPECIAL) || {};
    for (var k in SPECIAL) {
      if (Object.prototype.hasOwnProperty.call(SPECIAL, k) && SPECIAL[k] === def) return !def.un;
    }
    return false;
  }
  // v170：法术卡（def.spell）没有战力——标题等文案里不要写成“威力 0”
  function powerText(def) {
    return (def && def.spell) ? '法术 · 无战力' : ('威力 ' + def.p);
  }

  function defByName(name) {
    if (!name) return null;
    var all = allPoolDefs();
    for (var i = 0; i < all.length; i++) if (all[i].n === name) return all[i];
    return null;
  }

  /* ---------- 排序（加入/移出时，v136）：费用升序 → 同费用战力升序 → 同战力按卡名 ---------- */
  function sortDeckCards(deck) {
    if (!deck || !deck.cards) return;
    deck.cards.sort(function (a, b) {
      var ca = a && a.c != null ? a.c : 0;
      var cb = b && b.c != null ? b.c : 0;
      if (ca !== cb) return ca - cb;
      var pa = a && a.p != null ? a.p : 0;
      var pb = b && b.p != null ? b.p : 0;
      if (pa !== pb) return pa - pb;
      var na = (a && a.n) || '';
      var nb = (b && b.n) || '';
      return na < nb ? -1 : na > nb ? 1 : 0;
    });
  }

  /* ---------- 本地持久化（经 deck-storage.js） ---------- */
  function serializeDecks() {
    return DECKS.map(function (d) {
      return {
        id: d.id,
        name: d.name,
        cards: (d.cards || []).map(function (def) { return def && def.n; }).filter(Boolean),
      };
    });
  }
  function persistDecks() {
    if (!window.DeckStorage) return false;
    return window.DeckStorage.save({
      deckSeq: deckSeq,
      activeDeckId: activeDeckId,
      decks: serializeDecks(),
    });
  }
  function hydrateFromStorage() {
    var stored = window.DeckStorage && window.DeckStorage.load();
    function applyDefaults() {
      DECKS.length = 0;
      for (var i = 0; i < DEFAULT_DECKS.length; i++) {
        DECKS.push({
          id: DEFAULT_DECKS[i].id,
          name: DEFAULT_DECKS[i].name,
          cards: DEFAULT_DECKS[i].cards.slice(),
        });
      }
      deckSeq = DECKS.length;
      activeDeckId = DECKS.length ? DECKS[0].id : null;
    }
    if (!stored || !stored.decks || !stored.decks.length) {
      applyDefaults();
      return false;
    }
    var next = [];
    for (var i = 0; i < stored.decks.length && next.length < MAX_DECKS; i++) {
      var row = stored.decks[i];
      if (!row || !row.id) continue;
      var cards = [];
      var names = Array.isArray(row.cards) ? row.cards : [];
      for (var j = 0; j < names.length && cards.length < DECK_SIZE; j++) {
        var def = defByName(names[j]);
        if (!def) continue;
        if (cards.indexOf(def) >= 0) continue; // 同名限 1
        cards.push(def);
      }
      next.push({
        id: String(row.id),
        name: String(row.name || ('卡组 ' + (next.length + 1))).slice(0, 12),
        cards: cards,
      });
    }
    if (!next.length) {
      applyDefaults();
      return false;
    }
    DECKS.length = 0;
    for (var n = 0; n < next.length; n++) DECKS.push(next[n]);
    deckSeq = Math.max(stored.deckSeq | 0, DECKS.length);
    for (var k = 0; k < DECKS.length; k++) {
      var m = /^deck-(\d+)$/.exec(DECKS[k].id);
      if (m) deckSeq = Math.max(deckSeq, parseInt(m[1], 10));
    }
    var want = stored.activeDeckId;
    var found = false;
    if (want) {
      for (var f = 0; f < DECKS.length; f++) if (DECKS[f].id === want) { found = true; break; }
    }
    activeDeckId = found ? want : DECKS[DECKS.length - 1].id;
    return true;
  }

  function buildFilterChips() {
    var holder = $('deckFilter');
    if (!holder) return;
    holder.innerHTML = '';
    COST_FILTERS.forEach(function (f) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip' + (poolFilterKey === f.key ? ' active' : '');
      b.textContent = f.label;
      b.title = f.token
        ? '只看特殊卡（token 衍生卡牌 · 不可加入卡组）'
        : ('只看 ' + f.label + ' 的卡牌');
      b.addEventListener('click', function () {
        if (poolFilterKey === f.key) return;
        poolFilterKey = f.key;
        renderPool();
      });
      holder.appendChild(b);
    });
  }

  function findDeck(id) {
    for (var i = 0; i < DECKS.length; i++) if (DECKS[i].id === id) return DECKS[i];
    return null;
  }
  function editingDeck() { return editingDeckId ? findDeck(editingDeckId) : null; }
  function toggleEl(el, show) { if (el) el.classList.toggle('hidden', !show); }

  /* ---------- 提示条 ---------- */
  var toastTimer = null;
  function toast(text, ms) {
    var el = $('deckToast');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden', 'pop');
    void el.offsetWidth; // 强制 reflow：连续点击也能重播出现动画
    el.classList.add('pop');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.add('hidden');
      toastTimer = null;
    }, ms || 2600);
  }
  function hideToast() {
    var el = $('deckToast');
    if (el) el.classList.add('hidden');
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  }

  /* ---------- 浏览态：卡组位 ---------- */
  // 一个卡组位：卡堆缩略（卡背叠放）+ 名称 + 张数；
  // v124：卡组位本身是容器 div，主体（缩略图 + 名称 + 张数）放在内部 button 里；
  // v129：**点卡组位（含图片）直接进入修改模式**（不再需要单独的 ✏️ 按钮），
  //       缩略图上只保留**一个**悬浮按钮 —— 🗑️ 删除卡组（合法嵌套、互不串点击）。
  function deckSlotEl(deck) {
    var box = document.createElement('div');
    box.className = 'deck-slot'
      + (deck.id === activeDeckId ? ' active' : '')
      + (deck.id === justAddedId ? ' just-added' : ''); // 新建的卡组位播入场动画
    box.dataset.deckId = deck.id;

    var main = document.createElement('button');
    main.type = 'button';
    main.className = 'ds-main';
    main.title = deck.name + '（' + deck.cards.length + '/' + DECK_SIZE + '）· 点击修改该卡组';
    main.addEventListener('click', function () { editDeck(deck.id); }); // v129：直接进入修改

    var thumb = document.createElement('span');
    thumb.className = 'ds-thumb';
    var stack = document.createElement('span');
    stack.className = 'ds-stack';
    for (var i = 0; i < 3; i++) {
      var back = document.createElement('span');
      back.className = 'ds-back';
      stack.appendChild(back);
    }
    var emblem = document.createElement('span');
    emblem.className = 'ds-emblem';
    emblem.textContent = deck.cards.length ? '🃏' : '＋'; // 空卡组：占位「＋」
    stack.appendChild(emblem);
    thumb.appendChild(stack);
    main.appendChild(thumb);

    var name = document.createElement('span');
    name.className = 'ds-name';
    name.textContent = deck.name;
    main.appendChild(name);

    var count = document.createElement('span');
    count.className = 'ds-count' + (deck.cards.length >= DECK_SIZE ? ' full' : '');
    count.textContent = deck.cards.length + ' / ' + DECK_SIZE;
    main.appendChild(count);

    box.appendChild(main);
    box.appendChild(deckActionsEl(deck)); // 缩略图上的悬浮按钮（仅删除）
    return box;
  }

  // 卡组位缩略图右上角悬浮按钮：v129 起**只保留 🗑️ 删除卡组**
  //（修改卡组改为「点卡组位任意位置」直接进入）
  function deckActionsEl(deck) {
    var wrap = document.createElement('div');
    wrap.className = 'ds-actions';

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'ds-act del';
    del.textContent = '🗑️';
    del.title = '删除卡组「' + deck.name + '」';
    del.setAttribute('aria-label', '删除卡组「' + deck.name + '」');
    del.addEventListener('click', function () { askDeleteDeck(deck.id); });

    wrap.appendChild(del);
    return wrap;
  }

  // 最左的「＋ 新建卡组」位（参考图左上角的新建格）：点击即新建一套卡组，
  // 卡组栏随之动态扩展出一格；到达容量上限后置灰并提示。
  // 结构与卡组位一致（容器 .deck-slot + 内部 .ds-main 承载内容），只是没有悬浮按钮。
  function newSlotEl() {
    var full = DECKS.length >= MAX_DECKS;
    var box = document.createElement('div');
    box.className = 'deck-slot new' + (full ? ' full' : '');

    var main = document.createElement('button');
    main.type = 'button';
    main.className = 'ds-main';
    main.title = full
      ? '卡组栏已满（' + MAX_DECKS + ' / ' + MAX_DECKS + ' 套）'
      : '新建卡组（空卡组，默认名「新卡组 ' + (DECKS.length + 1) + '」）';
    main.addEventListener('click', createDeck);

    var thumb = document.createElement('span');
    thumb.className = 'ds-thumb';
    var plus = document.createElement('span');
    plus.className = 'ds-plus big';
    plus.textContent = '＋';
    thumb.appendChild(plus);
    main.appendChild(thumb);

    var name = document.createElement('span');
    name.className = 'ds-name';
    name.textContent = '新建卡组';
    main.appendChild(name);

    var hint = document.createElement('span');
    hint.className = 'ds-count';
    hint.textContent = DECKS.length + ' / ' + MAX_DECKS; // 已用 / 容量
    main.appendChild(hint);

    box.appendChild(main);
    return box;
  }

  // 动态列表：只渲染已创建的卡组位——每新建一个卡组，卡组栏就多出一格。
  // v123 显示顺序：**创建时间倒序** —— 越晚创建的卡组越靠左（紧挨「＋ 新建卡组」，
  // 新建后立刻出现在眼前），越早创建的越靠右。DECKS 本身仍按创建先后追加存储
  // （仅渲染时反序），因此 id / 默认名「新卡组 N」/ 张数统计都不受影响。
  function renderSlots() {
    var box = $('deckSlots');
    if (!box) return;
    box.innerHTML = '';
    box.appendChild(newSlotEl());
    for (var i = DECKS.length - 1; i >= 0; i--) box.appendChild(deckSlotEl(DECKS[i]));
    justAddedId = null; // 入场动画只在本次渲染生效
  }

  /* ---------- 编辑态：该卡组的 12 个卡槽 ---------- */
  // 已放卡槽：卡面（复用 cardFaceHTML），点击移出卡组
  function deckCardSlotEl(deck, def, index) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hand-card deck-card-slot filled';
    btn.style.setProperty('--cgrad', gradOf(def)); // 复用 game.js 的卡面配色
    btn.innerHTML = cardFaceHTML(def);             // 复用 game.js 的卡面结构
    btn.title = '第 ' + (index + 1) + ' 张：' + def.n + '（' + def.c + ' 费 / ' + powerText(def) + '）· 点击移出卡组';
    btn.addEventListener('click', function () { removeFromDeck(deck.id, def); });
    return btn;
  }
  // 空卡槽：v126 起做成与卡面同构的“幽灵卡”——
  // 内部结构与 cardFaceHTML 一一对应（角标行 / 正方形立绘区 / 卡名行），
  // 因此**尺寸与已放卡槽完全一致**（不论卡组是空是满，卡组栏高度都稳定不跳）。
  function deckEmptySlotEl(index) {
    var el = document.createElement('div');
    el.className = 'deck-card-slot empty';

    var top = document.createElement('span'); // 对应「费用 / 战力」角标行
    top.className = 'dcs-top';

    var art = document.createElement('span'); // 对应正方形立绘区
    art.className = 'dcs-art';
    var n = document.createElement('span');
    n.className = 'dcs-idx';
    n.textContent = String(index + 1);
    art.appendChild(n);

    var hint = document.createElement('span'); // 对应卡名行
    hint.className = 'dcs-hint';
    hint.textContent = '空位';

    el.appendChild(top);
    el.appendChild(art);
    el.appendChild(hint);
    return el;
  }
  function renderEditStrip(deck) {
    var box = $('deckSlots');
    if (!box) return;
    box.innerHTML = '';
    for (var i = 0; i < DECK_SIZE; i++) {
      var def = deck.cards[i];
      box.appendChild(def ? deckCardSlotEl(deck, def, i) : deckEmptySlotEl(i));
    }
  }

  /* ---------- 上方卡组栏：按状态渲染（浏览态列表 / 编辑态卡槽）---------- */
  function renderTop() {
    var box = $('deckSlots');
    var deck = editingDeck();
    if (box) box.classList.toggle('edit-mode', !!deck);
    // 页面级编辑态标记（v126：手机端据此把上方卡组栏放高一点，保证 2×6 卡槽一次看全）
    var screen = $('deckScreen');
    if (screen) screen.classList.toggle('edit-mode', !!deck);
    // 编辑态才出现的三个按钮 + 浏览态提示
    toggleEl($('deckHint'), !deck);
    toggleEl($('deckRenameBtn'), !!deck);
    toggleEl($('deckClearBtn'), !!deck);
    toggleEl($('deckDoneBtn'), !!deck);
    var title = $('deckBarTitle');
    var used = $('deckUsed');
    var tip = $('deckBarTip');
    if (deck) {
      if (title) title.textContent = deck.name; // v130：去掉「正在修改：」前缀，只显示卡组名
      if (used) {
        used.textContent = deck.cards.length + ' / ' + DECK_SIZE;
        used.classList.toggle('full', deck.cards.length >= DECK_SIZE);
      }
      if (tip) tip.textContent = '点下方卡牌加入 / 点上方卡牌移出（同名卡限 1 张）';
      renderEditStrip(deck);
    } else {
      if (title) title.textContent = '我的卡组';
      if (used) {
        used.textContent = DECKS.length + ' / ' + MAX_DECKS;
        used.classList.remove('full');
      }
      if (tip) tip.textContent = '新建的卡组排在最左（越早创建的越靠右）· 点卡组位直接进入修改';
      renderSlots();
    }
  }

  /* ---------- 卡牌网格（下方 2/3）----------
     v126：编辑态下**已在卡组里的卡牌加灰色遮罩且不可点击**（灰色 + 无效态），
     移出方式改为「点上方卡槽」；右键放大查看在两种状态下都保留。
     v131：衍生卡牌仅可查看（虚线描边），不可加入卡组。 */
  function poolCardEl(def, deck) {
    var el = document.createElement('div');
    var token = isTokenDef(def);
    var inDeck = !!(!token && deck && deck.cards.indexOf(def) >= 0);
    el.className = 'hand-card deck-pool-card'
      + (def.img ? '' : ' no-img') // 与手牌一致：无图时 emoji 占正方形立绘区，高度统一
      + (token ? ' token-card' : '')
      + (inDeck ? ' in-deck' : '');
    el.style.setProperty('--cgrad', gradOf(def)); // 复用 game.js 的卡面配色
    el.innerHTML = cardFaceHTML(def);             // 复用 game.js 的卡面结构
    if (token) {
      el.title = def.n + '（衍生卡牌 · 仅可查看，不可加入卡组）';
    } else if (inDeck) {
      // 已在卡组：灰色遮罩 + 不可点击（仅保留右键放大查看与悬停说明）
      el.setAttribute('aria-disabled', 'true');
      el.title = def.n + '（已在卡组中）· 点上方卡槽可移出 · 右键放大查看';
    } else {
      el.title = def.n + '（' + def.c + ' 费 / ' + powerText(def) + '）· ' + (deck ? '点击加入卡组' : '点击放大查看');
    }
    el.addEventListener('click', function () {
      if (token) { // 衍生卡：任何状态都只放大查看
        showZoom(def, true);
        return;
      }
      var d = editingDeck();
      if (d) { // 编辑态：左键 = 加入卡组（已在卡组中的卡牌已被遮罩挡住，不响应）
        if (d.cards.indexOf(def) >= 0) return;
        addToDeck(d.id, def);
        return;
      }
      showZoom(def, true); // 浏览态：放大查看（复用游戏弹窗）
    });
    el.addEventListener('contextmenu', function (e) { // 任何状态都能右键放大查看
      e.preventDefault();
      showZoom(def, true);
    });
    return el;
  }

  function renderPool() {
    var grid = $('deckGrid');
    if (!grid) return;
    buildFilterChips();
    var defs = filteredDefs();
    var deck = editingDeck();
    var f = currentFilter();
    grid.innerHTML = '';
    if (defs.length === 0) {
      var none = document.createElement('div');
      none.className = 'codex-empty';
      none.textContent = '该筛选档暂无卡牌。';
      grid.appendChild(none);
    } else {
      for (var i = 0; i < defs.length; i++) grid.appendChild(poolCardEl(defs[i], deck));
    }
    var count = $('deckPoolCount');
    if (count) {
      var filterNote = f.key === 'all' ? '' : '（' + f.label + '）';
      var tokenNote = f.token ? ' · 仅可查看' : '';
      count.textContent = '共 ' + defs.length + ' 种' + filterNote + tokenNote +
        (deck && !f.token ? ' · 已在卡组 ' + deck.cards.length + ' 张' : '');
    }
    rendered = true;
    renderActiveLabel();
  }

  // 下方卡牌区标题栏右侧的“当前卡组”提示
  function renderActiveLabel() {
    var el = $('deckActiveLabel');
    var tip = $('deckPoolTip');
    var deck = editingDeck();
    if (deck) {
      if (el) el.textContent = deck.name + '（' + deck.cards.length + ' / ' + DECK_SIZE + '）'; // v130：同样去掉前缀
      if (tip) tip.textContent = '点上方卡槽移出 · 右键放大查看';
      return;
    }
    var cur = activeDeckId ? findDeck(activeDeckId) : null;
    if (el) {
      el.textContent = cur
        ? '当前卡组：' + cur.name + '（' + cur.cards.length + ' / ' + DECK_SIZE + '）'
        : '尚未选中卡组';
    }
    if (tip) tip.textContent = '点击卡牌可放大查看';
  }

  function render() {
    renderTop();
    renderPool();
  }

  /* ---------- 卡组操作 ---------- */
  // 新建卡组：往 DECKS 追加一套空卡组 → 卡组栏动态扩展出一格（并自动选中）
  function createDeck() {
    if (DECKS.length >= MAX_DECKS) {
      toast('卡组栏已满（' + DECKS.length + ' / ' + MAX_DECKS + ' 套）——先删除一套卡组再新建。');
      return null;
    }
    var name = '新卡组 ' + (DECKS.length + 1);
    var deck = { id: 'deck-' + (++deckSeq), name: name, cards: [] };
    DECKS.push(deck);
    justAddedId = deck.id;  // 新卡组位播“入场”动画
    activeDeckId = deck.id; // 新建即选中
    persistDecks();
    renderTop();
    renderActiveLabel();
    toast('已新建「' + name + '」，卡组栏扩展到 ' + DECKS.length + ' / ' + MAX_DECKS + ' 套（0 / ' + DECK_SIZE + '）。');
    return deck;
  }

  // 选中/标记某套卡组为“当前卡组”（仅高亮 + 刷新联动显示，不弹提示、不进入编辑）
  function selectDeck(id) {
    var deck = findDeck(id);
    if (!deck) return null;
    activeDeckId = id;
    renderTop();
    renderActiveLabel();
    return deck;
  }

  // 修改卡组（v125）：进入编辑态 —— 上方卡组栏变成该卡组的 12 个卡槽，
  // 下方卡池左键即加入、点卡槽移出（v129：点卡组位任意位置即可进入本模式）。
  // 编辑中改动先写在内存；点「💾 保存」才排序并持久化到本地（v135）。
  function editDeck(id) {
    var deck = findDeck(id);
    if (!deck) return;
    editingDeckId = deck.id;
    activeDeckId = deck.id; // 编辑即选中
    render();
    toast('已进入「' + deck.name + '」的编辑：点下方卡牌加入、点上方已放卡牌移出；改完后点「保存」。');
  }

  // v135→v136：保存 = 写入 DeckStorage → 退出编辑态
  // （卡序在每次加入/移出时已按费用→战力整理，保存不再重排）
  function finishEdit() {
    var deck = editingDeck();
    editingDeckId = null;
    var ok = persistDecks();
    render();
    if (!deck) {
      toast('已退出卡组修改。');
      return;
    }
    toast(ok
      ? '「' + deck.name + '」已保存（' + deck.cards.length + ' / ' + DECK_SIZE + '）· 已写入本地。'
      : '「' + deck.name + '」已退出编辑（' + deck.cards.length + ' / ' + DECK_SIZE + '），但本地写入失败（可能是浏览器禁用了存储）。');
  }

  // 把一张卡加入卡组（同名卡限 1 张；满 12 张则提示）。
  // v126：已在卡组中的卡牌在卡池里带灰色遮罩、不可点击，移出一律走「点上方卡槽」。
  // v136：加入后立即按费用→战力重排卡槽。
  function addToDeck(deckId, def) {
    var deck = findDeck(deckId);
    if (!deck || !def) return false;
    if (isTokenDef(def)) {
      toast('「' + def.n + '」是衍生卡牌，不能加入卡组（仅可查看）。');
      return false;
    }
    if (deck.cards.indexOf(def) >= 0) {
      toast('「' + def.n + '」已经在卡组里了（点上方卡槽可移出）。');
      return false;
    }
    if (deck.cards.length >= DECK_SIZE) {
      toast('卡组已满（' + deck.cards.length + ' / ' + DECK_SIZE + '）——先点上方已放卡牌把它移出。');
      return false;
    }
    deck.cards.push(def);
    sortDeckCards(deck);
    renderTop();
    renderPool();
    toast('已加入「' + def.n + '」（' + deck.cards.length + ' / ' + DECK_SIZE + '）。');
    return true;
  }

  // 从卡组移出一张卡（v136：移出后立即按费用→战力重排）
  function removeFromDeck(deckId, def) {
    var deck = findDeck(deckId);
    if (!deck || !def) return false;
    var i = deck.cards.indexOf(def);
    if (i < 0) return false;
    deck.cards.splice(i, 1);
    sortDeckCards(deck);
    renderTop();
    renderPool();
    toast('已移出「' + def.n + '」（' + deck.cards.length + ' / ' + DECK_SIZE + '）。');
    return true;
  }

  // 清空当前编辑卡组（走通用确认弹窗）
  function askClearDeck() {
    var deck = editingDeck();
    if (!deck) return;
    if (!deck.cards.length) { toast('「' + deck.name + '」已经是空卡组。'); return; }
    var n = deck.cards.length;
    openConfirm({
      emblem: '🧹',
      title: '确认清空卡组？',
      lines: [
        '确认清空「' + deck.name + '」中的 ' + n + ' 张卡牌？',
        '清空后卡组张数变为 0 / ' + DECK_SIZE + '，卡牌本身不会从卡池消失。',
      ],
      okText: '确认清空',
      danger: true,
      onOk: function () {
        var d = editingDeck();
        if (!d) return;
        d.cards = [];
        renderTop();
        renderPool();
        toast('已清空「' + d.name + '」的 ' + n + ' 张卡牌。');
      },
    });
  }

  /* ---------- 卡组改名（v129）----------
     入口：编辑态顶部的「✏️ 改名」按钮。用专用小弹窗输入（不用 window.prompt：
     样式统一、可校验、jsdom 下也不会卡住）。校验：不能为空、超过 NAME_MAX 字、
     与其他卡组重名（重名会让卡组位难以分辨，故阻止）。 */
  var NAME_MAX = 12;      // 卡组名最大字数
  var renameDeckId = null; // 正在改名的卡组 id

  function renameMaskEl() { return $('deckRenameMask'); }
  function isRenameOpen() {
    var m = renameMaskEl();
    return !!m && !m.classList.contains('hidden');
  }
  function setRenameTip(text, warn) {
    var el = $('deckRenameTip');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('warn', !!warn);
  }

  function askRenameDeck() {
    var deck = editingDeck();
    if (!deck) return;
    renameDeckId = deck.id;
    var input = $('deckRenameInput');
    if (input) input.value = deck.name;
    setRenameTip('最多 ' + NAME_MAX + ' 个字；不能为空，也不能与其他卡组重名。');
    var mask = renameMaskEl();
    if (mask) mask.classList.remove('hidden');
    if (input) {
      input.focus();
      if (typeof input.select === 'function') input.select(); // 预选原名，直接输入即替换
    }
  }

  function cancelRenameDeck() {
    renameDeckId = null;
    var mask = renameMaskEl();
    if (mask) mask.classList.add('hidden');
  }

  function confirmRenameDeck() {
    var deck = findDeck(renameDeckId);
    var input = $('deckRenameInput');
    if (!deck || !input) { cancelRenameDeck(); return null; }
    var name = String(input.value || '').replace(/\s+/g, ' ').trim(); // 折叠空白
    if (!name) {
      setRenameTip('卡组名称不能为空，请重新输入。', true);
      input.focus();
      return null;
    }
    if (name.length > NAME_MAX) {
      setRenameTip('名称最多 ' + NAME_MAX + ' 个字（当前 ' + name.length + ' 个）。', true);
      input.focus();
      return null;
    }
    for (var i = 0; i < DECKS.length; i++) {
      if (DECKS[i].id !== deck.id && DECKS[i].name === name) {
        setRenameTip('已经有一套叫「' + name + '」的卡组了，换个名字吧。', true);
        input.focus();
        return null;
      }
    }
    var oldName = deck.name;
    if (oldName === name) { // 没改就退出，不打扰
      cancelRenameDeck();
      return deck;
    }
    deck.name = name;
    renameDeckId = null;
    var mask = renameMaskEl();
    if (mask) mask.classList.add('hidden');
    persistDecks();
    render(); // 标题行 / 卡组位名称 / 悬停提示全部刷新
    toast('卡组「' + oldName + '」已改名为「' + name + '」。');
    return deck;
  }

  /* ---------- 确认弹窗（v124 删除卡组 → v125 通用化，删除 / 清空共用）---------- */
  var confirmAction = null; // 待确认操作

  function confirmMaskEl() { return $('deckConfirmMask'); }
  function isConfirmOpen() {
    var m = confirmMaskEl();
    return !!m && !m.classList.contains('hidden');
  }
  // opts: { emblem, title, lines[], okText, danger, onOk }
  function openConfirm(opts) {
    opts = opts || {};
    confirmAction = opts.onOk || null;
    var em = $('deckConfirmEmblem');
    if (em) em.textContent = opts.emblem || '❓';
    var ti = $('deckConfirmTitle');
    if (ti) {
      ti.textContent = opts.title || '确认操作？';
      ti.classList.toggle('safe', opts.danger === false); // danger:false → 标题用普通配色
    }
    var tx = $('deckConfirmText');
    if (tx) {
      tx.innerHTML = ''; // 文案全部用 textContent 组装，避免卡组名注入
      var lines = opts.lines || [];
      for (var i = 0; i < lines.length; i++) {
        if (i) tx.appendChild(document.createElement('br'));
        tx.appendChild(document.createTextNode(lines[i]));
      }
    }
    var ok = $('deckConfirmOk');
    if (ok) {
      ok.textContent = opts.okText || '确认';
      ok.className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger');
    }
    var mask = confirmMaskEl();
    if (mask) mask.classList.remove('hidden');
  }
  function cancelConfirm() {
    confirmAction = null;
    var mask = confirmMaskEl();
    if (mask) mask.classList.add('hidden');
  }
  function runConfirm() {
    var fn = confirmAction;
    confirmAction = null;
    var mask = confirmMaskEl();
    if (mask) mask.classList.add('hidden');
    if (typeof fn === 'function') fn();
  }

  /* ---------- 删除卡组 ---------- */
  function askDeleteDeck(id) {
    var deck = findDeck(id);
    if (!deck) return;
    openConfirm({
      emblem: '🗑️',
      title: '确认删除卡组？',
      lines: [
        '确认删除卡组「' + deck.name + '」？',
        '该卡组内的 ' + deck.cards.length + ' 张卡牌配置将一并移除，删除后无法恢复。',
        '当前卡组栏：' + DECKS.length + ' / ' + MAX_DECKS + ' 套。',
      ],
      okText: '确认删除',
      danger: true,
      onOk: function () { doDeleteDeck(id); },
    });
  }
  function doDeleteDeck(id) {
    var i = -1;
    for (var k = 0; k < DECKS.length; k++) if (DECKS[k].id === id) { i = k; break; }
    if (i < 0) return null; // 防御：已不存在
    var removed = DECKS.splice(i, 1)[0];
    if (editingDeckId === id) editingDeckId = null; // 删的正是编辑中的卡组 → 退出编辑态
    // 删掉的是当前选中卡组 → 改选「最近创建」的一套（DECKS 按创建先后存储，取末尾）
    if (activeDeckId === id) activeDeckId = DECKS.length ? DECKS[DECKS.length - 1].id : null;
    persistDecks();
    render(); // 卡组栏收回一格（动态列表）
    toast('已删除「' + removed.name + '」，卡组栏剩 ' + DECKS.length + ' / ' + MAX_DECKS + ' 套。');
    return removed;
  }

  /* ---------- 页面开关 ---------- */
  function isOpen() { return document.body.classList.contains('in-deck'); }

  function open() {
    if (window.Home && window.Home.isHome && window.Home.isHome()) window.Home.hide();
    document.body.classList.add('in-deck');
    var el = $('deckScreen');
    if (el) el.classList.remove('hidden');
    hideToast();
    render();
  }

  function close() {
    // 编辑中直接返回：静默持久化（卡序在加入/移出时已整理）
    if (editingDeck()) {
      editingDeckId = null;
      persistDecks();
    }
    document.body.classList.remove('in-deck');
    var el = $('deckScreen');
    if (el) el.classList.add('hidden');
    editingDeckId = null;
    cancelConfirm();
    cancelRenameDeck();
    hideToast();
    if (window.Home) window.Home.show();
  }

  function bind() {
    hydrateFromStorage(); // v135：优先从 DeckStorage 恢复卡组
    var cap = $('deckCap');
    if (cap) cap.textContent = MAX_DECKS;
    var size = $('deckSize');
    if (size) size.textContent = DECK_SIZE;
    var back = $('deckBackBtn');
    if (back) back.addEventListener('click', close);
    var done = $('deckDoneBtn');
    if (done) done.addEventListener('click', finishEdit);
    var clear = $('deckClearBtn');
    if (clear) clear.addEventListener('click', askClearDeck);
    var rename = $('deckRenameBtn');
    if (rename) rename.addEventListener('click', askRenameDeck);
    // 改名弹窗：确定 / 取消按钮、点遮罩空白、Esc / Enter 均可操作
    var rOk = $('deckRenameOk');
    if (rOk) rOk.addEventListener('click', confirmRenameDeck);
    var rNo = $('deckRenameCancel');
    if (rNo) rNo.addEventListener('click', cancelRenameDeck);
    var rMask = renameMaskEl();
    if (rMask) rMask.addEventListener('click', function (e) { if (e.target === rMask) cancelRenameDeck(); });
    // 确认弹窗：确认 / 取消按钮、点遮罩空白、Esc 均可关闭
    var ok = $('deckConfirmOk');
    if (ok) ok.addEventListener('click', runConfirm);
    var no = $('deckConfirmCancel');
    if (no) no.addEventListener('click', cancelConfirm);
    var mask = confirmMaskEl();
    if (mask) mask.addEventListener('click', function (e) { if (e.target === mask) cancelConfirm(); });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (isConfirmOpen()) { cancelConfirm(); return; }
        if (isRenameOpen()) { cancelRenameDeck(); return; }
        // 游戏侧「放大查看」弹窗（#zoomMask）打开时，Esc 交给游戏自己的处理器，不退出编辑态
        var zoom = $('zoomMask');
        if (zoom && !zoom.classList.contains('hidden')) return;
        if (editingDeck()) finishEdit(); // 编辑态按 Esc 退出修改
        return;
      }
      if (e.key === 'Enter' && isRenameOpen()) confirmRenameDeck(); // 改名弹窗内回车 = 确定
    });
    if (rendered) render(); // 二次进入只需刷新卡组栏 / 卡池标记
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.DeckBuilder = {
    MAX_DECKS: MAX_DECKS,
    DECK_SIZE: DECK_SIZE,
    NAME_MAX: NAME_MAX,
    DECKS: DECKS,
    poolDefs: poolDefs,
    findDeck: findDeck,
    isOpen: isOpen,
    open: open,
    close: close,
    render: render,
    createDeck: createDeck,
    selectDeck: selectDeck,      // 仅设为“当前卡组”（高亮/联动显示），不进入编辑
    editDeck: editDeck,          // 进入修改卡组（编辑态；v129 起点卡组位即进入）
    finishEdit: finishEdit,      // 保存：排序 + 持久化 + 退出编辑态
    persistDecks: persistDecks,
    sortDeckCards: sortDeckCards,
    // v137：出战可选卡组（满 12 张；显示顺序 = 创建时间倒序，与卡组栏一致）
    listReadyDecks: function () {
      var out = [];
      for (var i = DECKS.length - 1; i >= 0; i--) {
        var d = DECKS[i];
        if (!d || !d.cards || d.cards.length !== DECK_SIZE) continue;
        out.push({
          id: d.id,
          name: d.name,
          cards: d.cards.slice(), // def 引用副本列表，供 Game.restart 使用
        });
      }
      return out;
    },
    addToDeck: addToDeck,        // 加入一张卡（def）
    removeFromDeck: removeFromDeck,
    askRenameDeck: askRenameDeck,
    confirmRename: confirmRenameDeck,
    cancelRename: cancelRenameDeck,
    isRenameOpen: isRenameOpen,
    askClearDeck: askClearDeck,  // 清空卡组（带确认）
    editingDeck: editingDeck,
    askDeleteDeck: askDeleteDeck,
    confirmOk: runConfirm,       // 通用确认弹窗：确认 / 取消
    cancelConfirm: cancelConfirm,
    isConfirmOpen: isConfirmOpen,
    toast: toast,
  };
})();
