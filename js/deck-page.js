/* =========================================================
   东方逆转 · deck-page.js —— 卡组设置页面（入口：主页面「卡组设置」，DOM 在 index.html 的 #deckScreen）。
   上方 #deckSlots：浏览态 = 创建时间倒序的动态卡组列表（点卡组位任意位置进入修改）；编辑态 = 该卡组的
     12 个卡槽（已放 = 卡面、点击移出；未放 = 与卡面同构的虚线空位）。MAX_DECKS = 20 套、DECK_SIZE = 12 张。
   下方 #deckFilter + #deckGrid：费用筛选（全部 / 0-1 / 2 / 3 / 4 / 5 / 6 费+ / 衍生卡牌）；「衍生卡牌」=
     SPECIAL token（不含 un），仅可查看不可加入卡组；左键 = 放大查看（编辑态 = 加入卡组）、右键 = 放大查看。
   卡池与卡槽排序统一走 CardBrowser.orderDefs（见 sortDefsList）；待实装：对局使用自建卡组。
   入口 / 返回：DeckBuilder.open()（home.js 的 PAGES.deck）/ close() → Home.show()。
   依赖：game.js 的 gradOf / cardFaceHTML / showZoom；deck-storage.js 的 DeckStorage.load/save。
   ========================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var MAX_DECKS = 20;
  var DECK_SIZE = 12;  // 每套卡组张数
  /* 仅在本地无存档时使用；cards 存 POOL 里的 def 对象引用（同一张卡全池同一对象，可直接 indexOf 比对）。 */
  var DEFAULT_DECKS = [
    { id: 'deck-1', name: '占位卡组 A', cards: [] },
    { id: 'deck-2', name: '占位卡组 B', cards: [] },
  ];

  var DECKS = [];
  var deckSeq = 0;
  var activeDeckId = null;
  var editingDeckId = null;                   // 正在修改的卡组（null = 浏览态）
  var justAddedId = null;                     // 本次渲染需要播“新增入场”动画的卡组位
  var poolFilterKey = 'all';                  // 卡池筛选档（关闭页面后保留）

  var rendered = false; // 卡牌网格是否已渲染过（卡池是静态数据）
  /* ---------- 卡池筛选（与 card-browser.js 图鉴同款） ---------- */
  // costs=null 全部人物卡；min=N 表示 N 费及以上；token=true 衍生卡牌（SPECIAL，不含 un 占位）
  var COST_FILTERS = [
    { key: 'all', label: '全部', costs: null },
    { key: '01', label: '0-1 费', costs: [0, 1] },
    { key: '2', label: '2 费', costs: [2] },
    { key: '3', label: '3 费', costs: [3] },
    { key: '4', label: '4 费', costs: [4] },
    { key: '5', label: '5 费', costs: [5] },
    { key: '6', label: '6 费+', min: 6 },
    { key: 'token', label: '衍生卡牌', token: true },
  ];

  function allPoolDefs() {
    var POOL = (window.DS_CARDS && window.DS_CARDS.POOL) || {};
    var out = [];
    // 遍历卡池实际存在的费用档（含 7 / 8 费档），不写死 0~6
    Object.keys(POOL)
      .map(Number)
      .filter(function (c) { return isFinite(c); })
      .sort(function (a, b) { return a - b; })
      .forEach(function (c) {
        var arr = POOL[c];
        if (!arr) return;
        for (var i = 0; i < arr.length; i++) out.push(arr[i]);
      });
    return out;
  }
  function poolDefs() { return sortDefsList(allPoolDefs()); }
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
    if (f && f.token) return sortDefsList(tokenDefs());
    var costs = f ? f.costs : null;
    var min = f ? f.min : null;
    return sortDefsList(allPoolDefs()).filter(function (d) {
      if (min != null) return d.c >= min;
      return !costs || costs.indexOf(d.c) >= 0;
    });
  }
  function isTokenDef(def) {
    var SPECIAL = (window.DS_CARDS && window.DS_CARDS.SPECIAL) || {};
    for (var k in SPECIAL) {
      if (Object.prototype.hasOwnProperty.call(SPECIAL, k) && SPECIAL[k] === def) return !def.un;
    }
    return false;
  }
  // 法术卡（def.spell）没有战力——标题等文案里不要写成“威力 0”
  function powerText(def) {
    return (def && def.spell) ? '法术 · 无战力' : ('威力 ' + def.p);
  }

  function defByName(name) {
    if (!name) return null;
    var all = allPoolDefs();
    for (var i = 0; i < all.length; i++) if (all[i].n === name) return all[i];
    return null;
  }
  /* ---------- 排序 ----------
     口径 = 费用升序 → 同费用战力升序 → 同战力按卡名字典序（逐位比较字符编码）。
     比较器优先复用 `window.CardBrowser.orderDefs`（js/card-browser.js 在本文件之前加载）；
     取不到时（有人单独引入本文件）退回下面这份 localOrderDefs 等价实现，行为不变。 */
  function localOrderDefs(a, b) {
    var ca = a && a.c != null ? a.c : 0;
    var cb = b && b.c != null ? b.c : 0;
    if (ca !== cb) return ca - cb;
    var pa = a && a.p != null ? a.p : 0;
    var pb = b && b.p != null ? b.p : 0;
    if (pa !== pb) return pa - pb;
    var na = (a && a.n) || '';
    var nb = (b && b.n) || '';
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  function orderDefs() {
    var api = window.CardBrowser;
    if (api && typeof api.orderDefs === 'function') return api.orderDefs;
    return localOrderDefs;
  }
  // 排一份卡池列表（不改原数组；元素为空时排到末尾，避免比较器读到 null）
  function sortDefsList(list) {
    var base = orderDefs();
    return (list || []).slice().sort(function (a, b) {
      if (!a) return b ? 1 : 0;
      if (!b) return -1;
      return base(a, b);
    });
  }
  function sortDeckCards(deck) {
    if (!deck || !deck.cards) return;
    var base = orderDefs();
    deck.cards.sort(function (a, b) {
      if (!a) return b ? 1 : 0;
      if (!b) return -1;
      return base(a, b);
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
      // 读回来的卡组也整理成统一顺序 —— 主要照顾旧存档 / 手工改过的存档，
      // 保证一进编辑态看到的 12 个卡槽就是有序的，与加入 / 移出后的呈现一致。
      cards = sortDefsList(cards);
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
  // 卡组位：卡堆缩略（卡背叠放）+ 名称 + 张数，点任意位置 = 进入修改。
  // ⚠️ 🗑️ 与主体 button 是**兄弟节点**（button 不能嵌套 button），故不放在 .ds-main 内部。
  function deckSlotEl(deck) {
    var box = document.createElement('div');
    box.className = 'deck-slot'
      + (deck.id === activeDeckId ? ' active' : '')
      + (deck.id === justAddedId ? ' just-added' : '');
    box.dataset.deckId = deck.id;

    var main = document.createElement('button');
    main.type = 'button';
    main.className = 'ds-main';
    main.title = deck.name + '（' + deck.cards.length + '/' + DECK_SIZE + '）· 点击修改该卡组';
    main.addEventListener('click', function () { editDeck(deck.id); });

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
    emblem.textContent = deck.cards.length ? '🃏' : '＋';
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
    box.appendChild(deckActionsEl(deck));
    return box;
  }
  // 卡组位缩略图右上角悬浮按钮：只保留 🗑️ 删除（修改走「点卡组位任意位置」）
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
  // 最左的「＋ 新建卡组」位：点击即新建一套；到达上限后置灰并提示（结构与卡组位一致，无悬浮按钮）。
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
    hint.textContent = DECKS.length + ' / ' + MAX_DECKS;
    main.appendChild(hint);

    box.appendChild(main);
    return box;
  }
  // 动态列表：只渲染已创建的卡组位，每新建一个就多出一格。
  // ⚠️ 渲染成**创建时间倒序**（反序遍历 DECKS）；DECKS 本身仍按创建先后追加，故 id / 默认名不变。
  function renderSlots() {
    var box = $('deckSlots');
    if (!box) return;
    box.innerHTML = '';
    box.appendChild(newSlotEl());
    for (var i = DECKS.length - 1; i >= 0; i--) box.appendChild(deckSlotEl(DECKS[i]));
    justAddedId = null;
  }
  /* ---------- 编辑态：该卡组的 12 个卡槽 ---------- */
  function deckCardSlotEl(deck, def, index) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hand-card deck-card-slot filled';
    btn.style.setProperty('--cgrad', gradOf(def)); // 复用 game.js 的卡面配色
    btn.innerHTML = cardFaceHTML(def);
    btn.title = '第 ' + (index + 1) + ' 张：' + def.n + '（' + def.c + ' 费 / ' + powerText(def) + '）· 点击移出卡组';
    btn.addEventListener('click', function () { removeFromDeck(deck.id, def); });
    return btn;
  }
  // 空卡槽 = 与卡面同构的“幽灵卡”：内部结构（角标行 / 立绘区 / 卡名行）与 cardFaceHTML 一一对应，
  // 因此尺寸与已放卡槽完全一致 —— 不论空满，卡组栏高度都不跳。
  function deckEmptySlotEl(index) {
    var el = document.createElement('div');
    el.className = 'deck-card-slot empty';

    var top = document.createElement('span');
    top.className = 'dcs-top';

    var art = document.createElement('span');
    art.className = 'dcs-art';
    var n = document.createElement('span');
    n.className = 'dcs-idx';
    n.textContent = String(index + 1);
    art.appendChild(n);

    var hint = document.createElement('span');
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
    // 页面级编辑态标记（CSS 据此把上方卡组栏放高，保证 2×6 卡槽一次看全）
    var screen = $('deckScreen');
    if (screen) screen.classList.toggle('edit-mode', !!deck);
    toggleEl($('deckHint'), !deck);
    toggleEl($('deckRenameBtn'), !!deck);
    toggleEl($('deckClearBtn'), !!deck);
    toggleEl($('deckDoneBtn'), !!deck);
    var title = $('deckBarTitle');
    var used = $('deckUsed');
    var tip = $('deckBarTip');
    if (deck) {
      if (title) title.textContent = deck.name;
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
  /* ---------- 卡牌网格（下方 2/3）：编辑态下已在卡组中的卡牌加灰色遮罩且不可点击（移出一律走
     「点上方卡槽」），衍生卡牌仅可查看不可加入；右键放大查看在两种状态下都保留。 */
  function poolCardEl(def, deck) {
    var el = document.createElement('div');
    var token = isTokenDef(def);
    var inDeck = !!(!token && deck && deck.cards.indexOf(def) >= 0);
    el.className = 'hand-card deck-pool-card'
      + (def.img ? '' : ' no-img') // 与手牌一致：无图时 emoji 占正方形立绘区，高度统一
      + (token ? ' token-card' : '')
      + (inDeck ? ' in-deck' : '');
    el.style.setProperty('--cgrad', gradOf(def)); // 复用 game.js 的卡面配色与结构
    el.innerHTML = cardFaceHTML(def);
    if (token) {
      el.title = def.n + '（衍生卡牌 · 仅可查看，不可加入卡组）';
    } else if (inDeck) {
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
      if (d) {
        if (d.cards.indexOf(def) >= 0) return;
        addToDeck(d.id, def);
        return;
      }
      showZoom(def, true);
    });
    el.addEventListener('contextmenu', function (e) {
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
  function renderActiveLabel() {
    var el = $('deckActiveLabel');
    var tip = $('deckPoolTip');
    var deck = editingDeck();
    if (deck) {
      if (el) el.textContent = deck.name + '（' + deck.cards.length + ' / ' + DECK_SIZE + '）';
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
  function createDeck() {
    if (DECKS.length >= MAX_DECKS) {
      toast('卡组栏已满（' + DECKS.length + ' / ' + MAX_DECKS + ' 套）——先删除一套卡组再新建。');
      return null;
    }
    var name = '新卡组 ' + (DECKS.length + 1);
    var deck = { id: 'deck-' + (++deckSeq), name: name, cards: [] };
    DECKS.push(deck);
    justAddedId = deck.id;
    activeDeckId = deck.id;
    persistDecks();
    renderTop();
    renderActiveLabel();
    toast('已新建「' + name + '」，卡组栏扩展到 ' + DECKS.length + ' / ' + MAX_DECKS + ' 套（0 / ' + DECK_SIZE + '）。');
    return deck;
  }
  // 仅标记“当前卡组”（高亮 + 联动刷新），不弹提示、不进入编辑态
  function selectDeck(id) {
    var deck = findDeck(id);
    if (!deck) return null;
    activeDeckId = id;
    renderTop();
    renderActiveLabel();
    return deck;
  }
  // 进入编辑态：上方卡组栏变成该卡组的 12 个卡槽，下方卡池左键即加入、点卡槽移出。
  // 编辑中的改动先写在内存，点「保存」才持久化到本地。
  function editDeck(id) {
    var deck = findDeck(id);
    if (!deck) return;
    editingDeckId = deck.id;
    activeDeckId = deck.id;
    render();
    toast('已进入「' + deck.name + '」的编辑：点下方卡牌加入、点上方已放卡牌移出；改完后点「保存」。');
  }
  // 保存 = 写入 DeckStorage + 退出编辑态（卡序在加入 / 移出时已整理，这里不再重排）
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
  // 加入一张卡：同名限 1 张、满 12 张则提示；已在卡组中的卡在卡池里带灰色遮罩不可点击，
  // 移出一律走「点上方卡槽」；加入后立即重排卡槽。
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
  /* ---------- 卡组改名 ----------
     入口 = 编辑态顶部的「✏️ 改名」按钮；用专用小弹窗输入而不用 window.prompt（样式统一、可校验、
     jsdom 下不会卡住）。校验：非空 / 不超过 NAME_MAX 字 / 不与其他卡组重名（重名难分辨故阻止）。 */
  var NAME_MAX = 12;
  var renameDeckId = null;

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
      if (typeof input.select === 'function') input.select();
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
    var name = String(input.value || '').replace(/\s+/g, ' ').trim();
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
    if (oldName === name) {
      cancelRenameDeck();
      return deck;
    }
    deck.name = name;
    renameDeckId = null;
    var mask = renameMaskEl();
    if (mask) mask.classList.add('hidden');
    persistDecks();
    render();
    toast('卡组「' + oldName + '」已改名为「' + name + '」。');
    return deck;
  }
  /* ---------- 确认弹窗（删除 / 清空共用）---------- */
  var confirmAction = null;

  function confirmMaskEl() { return $('deckConfirmMask'); }
  function isConfirmOpen() {
    var m = confirmMaskEl();
    return !!m && !m.classList.contains('hidden');
  }
  function openConfirm(opts) {
    opts = opts || {};
    confirmAction = opts.onOk || null;
    var em = $('deckConfirmEmblem');
    if (em) em.textContent = opts.emblem || '❓';
    var ti = $('deckConfirmTitle');
    if (ti) {
      ti.textContent = opts.title || '确认操作？';
      ti.classList.toggle('safe', opts.danger === false);
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
    if (i < 0) return null;
    var removed = DECKS.splice(i, 1)[0];
    if (editingDeckId === id) editingDeckId = null;
    // 删掉的是当前选中卡组 → 改选「最近创建」的一套（DECKS 按创建先后存储，取末尾）
    if (activeDeckId === id) activeDeckId = DECKS.length ? DECKS[DECKS.length - 1].id : null;
    persistDecks();
    render();
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
    hydrateFromStorage(); // 优先从 DeckStorage 恢复卡组
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
    var rOk = $('deckRenameOk');
    if (rOk) rOk.addEventListener('click', confirmRenameDeck);
    var rNo = $('deckRenameCancel');
    if (rNo) rNo.addEventListener('click', cancelRenameDeck);
    var rMask = renameMaskEl();
    if (rMask) rMask.addEventListener('click', function (e) { if (e.target === rMask) cancelRenameDeck(); });
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
        // #zoomMask（游戏侧「放大查看」）打开时 Esc 交给游戏的处理器，不退出编辑态
        var zoom = $('zoomMask');
        if (zoom && !zoom.classList.contains('hidden')) return;
        if (editingDeck()) finishEdit();
        return;
      }
      if (e.key === 'Enter' && isRenameOpen()) confirmRenameDeck();
    });
    if (rendered) render();
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
    editDeck: editDeck,
    finishEdit: finishEdit,      // 保存：持久化 + 退出编辑态
    persistDecks: persistDecks,
    sortDeckCards: sortDeckCards,
    // 出战可选卡组（满 12 张；显示顺序 = 创建时间倒序，与卡组栏一致）
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
    addToDeck: addToDeck,
    removeFromDeck: removeFromDeck,
    askRenameDeck: askRenameDeck,
    confirmRename: confirmRenameDeck,
    cancelRename: cancelRenameDeck,
    isRenameOpen: isRenameOpen,
    askClearDeck: askClearDeck,
    editingDeck: editingDeck,
    askDeleteDeck: askDeleteDeck,
    confirmOk: runConfirm,
    cancelConfirm: cancelConfirm,
    isConfirmOpen: isConfirmOpen,
    toast: toast,
  };
})();
