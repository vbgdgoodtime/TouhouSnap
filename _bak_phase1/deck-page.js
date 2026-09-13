/* =========================================================
   东方逆转 · deck-page.js —— 卡组设置页面（入口：主页面「卡组设置」，DOM 在 index.html 的 #deckScreen）。
   上方 #deckSlots：浏览态 = 创建时间倒序的动态卡组列表（点卡组位任意位置进入修改）；编辑态 = 该卡组的
     12 个卡槽（已放 = 卡面、点击移出；未放 = 与卡面同构的虚线空位）。MAX_DECKS = 20 套、DECK_SIZE = 12 张。
   下方 #deckFilter + #deckGrid：费用筛选（全部 / 0-1 / 2 / 3 / 4 / 5 / 6 费+ / 衍生卡牌）；「衍生卡牌」=
     SPECIAL token（不含 un），仅可查看不可加入卡组；左键 = 放大查看（编辑态 = 加入卡组）、右键 = 放大查看。
   卡池与卡槽排序统一走 CardBrowser.orderDefs（见 sortDefsList）；对局侧由 home.js 的
     「开始对战 · 选出战卡组」消费 listReadyDecks()（仅满 12 张的卡组）。
   导出 / 导入：一套卡组 ⇄ 一行文本码（`TH2D1:` + 明文卡组名 + `:` + base64(UTF-8 JSON {n, c:[卡名…]})），
     名字明文写在最前面（一屏多个码时肉眼可辨）；名字含空白或 `:` 时省略明文名，退回不带名的两段形式。
     码里按**卡名**记录（POOL 内同名唯一，与 deck-storage.js 的存档口径一致）；
     导入只**新建**一套卡组，不覆盖既有卡组，也不改动当前编辑中的内容。
     入口 = 顶栏「📤 导出」/「📥 导入」；两种形态共用弹窗 #deckImportMask，由 openCodeDialog 切换。
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
  var exportDeckId = null;                    // 导出弹窗当前展示的卡组（导入形态下为 null）

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
  // 卡名要拼进 HTML 属性（如 title="「卡名」…"）时先转义——卡名来路目前只有 data/cards.js，
  // 但属性里的引号一旦混进来就会破坏卡面 DOM，故一律收口到这里。
  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
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

  /* ---------- 卡组码：一行文本码 ⇄ 一套卡组 ----------
     格式 = `TH2D1:` + **明文卡组名** + `:` + base64(UTF-8 的 JSON `{ n: 卡组名, c: [卡名…] }`)。
     · 名字**明文放在最前面**：一屏多个卡组码时肉眼就能认出哪行是哪套卡组，不用逐个导入。
     · 名字里只要出现空白或 `:` 就**不写明文**（退回 `TH2D1:` + base64 的两段形式）——
       导入时按剥掉空白后的字符串认码，明文里带空白会把码截断；JSON 里始终有完整名字，不影响导入。
     · 用 base64 是因为码要经聊天工具 / 剪贴板转手：卡组名里的空格、`+`、`/` 直接写会串行。
     · 手写 UTF-8 编解码、不用 TextEncoder / TextDecoder——本文件通篇 ES5 写法，保持同一取向。
     · 解析同时接受两段（无明文名）与三段（有明文名）形式；校验不过一律返回 null（不抛异常）。 */
  var CODE_PREFIX = 'TH2D1:';

  // 明文名只接受「非空、无空白、无冒号」（码本身也要能原样贴回来）
  function plainNameOf(name) {
    var s = String(name == null ? '' : name);
    if (!s || /\s/.test(s) || s.indexOf(':') >= 0) return '';
    return s;
  }

  function utf8Encode(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) {
        bytes.push(c);
      } else if (c < 0x800) {
        bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        var lo = str.charCodeAt(i + 1); // 代理对（emoji 等）合成一个码点
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          var cp = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
          i++;
          bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          continue;
        }
        bytes.push(0xef, 0xbf, 0xbd); // 落单的高代理 → U+FFFD
      } else if (c >= 0xd800 && c <= 0xdfff) {
        bytes.push(0xef, 0xbf, 0xbd); // 落单的低代理 → U+FFFD
      } else {
        bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return bytes;
  }
  function utf8Decode(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length;) {
      var b = bytes[i];
      if (b < 0x80) { out += String.fromCharCode(b); i += 1; continue; }
      if (b >= 0xc0 && b < 0xe0 && i + 1 < bytes.length) {
        out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
        i += 2; continue;
      }
      if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) {
        out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
        i += 3; continue;
      }
      if (b >= 0xf0 && b < 0xf8 && i + 3 < bytes.length) {
        var cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
        cp -= 0x10000;
        out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        i += 4; continue;
      }
      out += '\ufffd'; i += 1; // 残缺序列：以替换字符吞掉，后面的内容照常解出
    }
    return out;
  }
  function codeOf(name, cardNames) {
    var plain = String(name == null ? '' : name);
    var json = JSON.stringify({ n: plain, c: cardNames || [] });
    var bytes = utf8Encode(json);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    var easy = plainNameOf(plain);
    return CODE_PREFIX + (easy ? easy + ':' : '') + btoa(bin);
  }
  // 返回 { n, c, label } 或 null（前缀 / 编码 / 结构任一步不过关都算格式不对）
  // label = 码里明文写的名字（没有明文名时退回 JSON 里的名字），供「这码属于哪套卡组」的提示用
  function deckFromCode(code) {
    var raw = String(code == null ? '' : code).replace(/\s+/g, ''); // 聊天工具常按行折断
    if (raw.indexOf(CODE_PREFIX) !== 0) return null;
    var body = raw.slice(CODE_PREFIX.length);
    var data = null;
    for (var cut = body.length; cut > 0; cut--) { // 明文名里即使混进 `:` 也能靠「后半截是不是 base64」找回
      if (body.charAt(cut - 1) !== ':') continue;
      data = decodeCodeBody(body.slice(cut));
      if (data) break;
    }
    if (!data) data = decodeCodeBody(body); // 两段形式（无明文名）
    if (!data) return null;
    if (typeof data.n !== 'string' || !Array.isArray(data.c)) return null;
    for (var k = 0; k < data.c.length; k++) {
      if (typeof data.c[k] !== 'string') return null;
    }
    return { n: data.n, c: data.c, label: plainNameOf(data.n) || data.n };
  }
  function decodeCodeBody(b64) {
    if (!b64) return null;
    try {
      var bin = atob(b64);
      var bytes = [];
      for (var i = 0; i < bin.length; i++) bytes.push(bin.charCodeAt(i) & 0xff);
      var data = JSON.parse(utf8Decode(bytes));
      return (data && typeof data === 'object') ? data : null;
    } catch (e) {
      return null;
    }
  }
  // 一套卡组 → 码。卡池里查不到的名字照原样写进去（导入端会报出来，不静默丢卡）。
  function deckCodeOfDeck(deck) {
    if (!deck) return '';
    var names = (deck.cards || []).map(function (d) { return d && d.n; }).filter(Boolean);
    return codeOf(deck.name, names);
  }
  // 码里的卡名 → 去重后的 def 列表；顺带报出被跳过的名字（本次卡池里没有，或只是衍生卡牌）
  function resolveCodeCards(names) {
    var cards = [];
    var skipped = [];
    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      if (!name || skipped.indexOf(name) >= 0) continue;
      var def = defByName(name);
      if (!def || isTokenDef(def)) { skipped.push(name); continue; } // 改名 / 已删 / token → 跳过并报出
      if (cards.indexOf(def) >= 0) continue;                         // 同名限 1（与加入卡组的规则一致）
      cards.push(def);
    }
    return { cards: cards, skipped: skipped };
  }
  // 导入用的卡组名：裁到 NAME_MAX 字；与既有卡组重名时后缀递增到不撞为止（导入是新建动作，
  // 直接报「重名」会把用户卡住；改名按钮随时可再改）
  function uniqueDeckName(raw) {
    var base = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) || '导入卡组';
    function taken(name) {
      for (var i = 0; i < DECKS.length; i++) if (DECKS[i].name === name) return true;
      return false;
    }
    if (!taken(base)) return base;
    for (var n = 2; n < 100; n++) {
      var suffix = ' ' + n;
      var candidate = base.slice(0, Math.max(1, NAME_MAX - suffix.length)) + suffix;
      if (!taken(candidate)) return candidate;
    }
    return base;
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
  function findDeckByName(name) {
    if (!name) return null;
    for (var i = 0; i < DECKS.length; i++) if (DECKS[i].name === name) return DECKS[i];
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
    btn.title = '第 ' + (index + 1) + ' 张：' + escapeAttr(def.n) + '（' + def.c + ' 费 / ' + powerText(def) + '）· 点击移出卡组';
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
      el.title = escapeAttr(def.n) + '（衍生卡牌 · 仅可查看，不可加入卡组）';
    } else if (inDeck) {
      el.setAttribute('aria-disabled', 'true');
      el.title = escapeAttr(def.n) + '（已在卡组中）· 点上方卡槽可移出 · 右键放大查看';
    } else {
      el.title = escapeAttr(def.n) + '（' + def.c + ' 费 / ' + powerText(def) + '）· ' + (deck ? '点击加入卡组' : '点击放大查看');
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
  /* ---------- 导出 / 导入（弹窗 #deckImportMask，两种形态共用） ---------- */
  function importMaskEl() { return $('deckImportMask'); }
  function isImportOpen() {
    var m = importMaskEl();
    return !!m && !m.classList.contains('hidden');
  }
  function setImportTip(text, warn) {
    var el = $('deckImportTip');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('warn', !!warn);
  }
  // 唯一入口：mode='export' 只读展示当前卡组的码并给「📋 复制」；mode='import' 空框等粘贴
  function openCodeDialog(mode) {
    var mask = importMaskEl();
    var input = $('deckImportInput');
    if (!mask || !input) return false;
    exportDeckId = mode === 'export' ? activeDeckId : null;
    var em = $('deckImportEmblem');
    var ti = $('deckImportTitle');
    var ok = $('deckImportOk');
    var copy = $('deckImportCopy');
    input.readOnly = false;
    input.value = '';
    if (mode === 'export') {
      var deck = exportDeckId ? findDeck(exportDeckId) : null;
      if (!deck) { toast('先点一套卡组把它设为当前卡组，再导出。'); return false; }
      input.value = deckCodeOfDeck(deck);
      input.readOnly = true; // 只读：导出码不该在框里被误改
      if (em) em.textContent = '📤';
      if (ti) ti.textContent = '导出卡组';
      if (ok) ok.classList.add('hidden');
      if (copy) copy.classList.remove('hidden');
      setImportTip('「' + deck.name + '」共 ' + deck.cards.length + ' / ' + DECK_SIZE +
        ' 张 · 复制这行码发给别人，对方在「📥 导入」里粘贴即可。', false);
    } else {
      if (em) em.textContent = '📥';
      if (ti) ti.textContent = '导入卡组';
      if (ok) ok.classList.remove('hidden');
      if (copy) copy.classList.add('hidden');
      setImportTip('粘贴一行以 ' + CODE_PREFIX + ' 开头的卡组码（开头的名字就是卡组名）；导入会新建一套卡组（不覆盖现有卡组）。', false);
    }
    mask.classList.remove('hidden');
    input.focus();
    if (mode === 'export' && typeof input.select === 'function') input.select();
    return true;
  }
  function askExportDeck() { return openCodeDialog('export'); } // 没选中卡组时 openCodeDialog 已给提示
  function askImportDeck() { return openCodeDialog('import'); }
  function cancelImportDeck() {
    exportDeckId = null;
    var mask = importMaskEl();
    if (mask) mask.classList.add('hidden');
  }
  function confirmExportCopy() {
    var input = $('deckImportInput');
    var text = input ? String(input.value || '') : '';
    copyText(text);
  }
  // 剪贴板不可用（非 https / 无权限 / 老浏览器）不是错误：框里内容已全选，手动作业即可
  function copyText(text) {
    if (!text) return false;
    var input = $('deckImportInput');
    if (input && typeof input.select === 'function') input.select();
    var clip = navigator.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      clip.writeText(text).then(function () {
        toast('卡组码已复制，粘贴到别处即可分享。');
      }, function () {
        toast('这台浏览器不允许自动复制——码已全选，请按 Ctrl+C 手动复制。');
      });
      return true;
    }
    toast('这台浏览器不支持自动复制——码已全选，请按 Ctrl+C 手动复制。');
    return false;
  }
  // 「📥 导入」：先校验 + 预览，确认后才真正新建卡组
  function confirmImportDeck() {
    var input = $('deckImportInput');
    var data = deckFromCode(input ? input.value : '');
    if (!data) {
      setImportTip('这不是一个有效的卡组码（应以 ' + CODE_PREFIX + ' 开头，可能复制时被截断或改动了）。', true);
      if (input) input.focus();
      return null;
    }
    var resolved = resolveCodeCards(data.c);
    var cards = resolved.cards.slice(0, DECK_SIZE); // 超过 12 张只取前 12 张
    var trimmed = resolved.cards.length > DECK_SIZE ? resolved.cards.length - DECK_SIZE : 0;
    if (!cards.length) {
      setImportTip('码是有效的，但里面 ' + data.c.length + ' 张卡在本卡池里都找不到（可能卡牌已改名或删除），没有可导入的卡。', true);
      if (input) input.focus();
      return null;
    }
    if (DECKS.length >= MAX_DECKS) {
      toast('卡组栏已满（' + DECKS.length + ' / ' + MAX_DECKS + ' 套）——先删除一套卡组再导入。');
      return null;
    }
    var name = uniqueDeckName(data.n);
    var lines = ['导入为「' + name + '」，共 ' + cards.length + ' / ' + DECK_SIZE + ' 张。'];
    // 码里的卡组名：明文写在码最前面，提示里再点一次，避免「这码是哪套卡组」的犹豫
    if (data.n) lines.push('码里的卡组名：' + data.n + (data.n === name ? '。' : '（已按卡组命名规则调整）。'));
    if (data.n && findDeckByName(data.n)) lines.push('你这里已经有一套「' + data.n + '」了，导入会新增一套，不会覆盖它。');
    if (trimmed) lines.push('码里共 ' + resolved.cards.length + ' 张，只取前 ' + DECK_SIZE + ' 张，忽略 ' + trimmed + ' 张。');
    if (resolved.skipped.length) lines.push('跳过 ' + resolved.skipped.length + ' 张本卡池没有的卡：' + resolved.skipped.join('、'));
    openConfirm({
      emblem: '📥',
      title: '确认导入卡组？',
      lines: lines,
      okText: '确认导入',
      danger: false,
      onOk: function () { doImportDeck(name, cards); },
    });
    return cards;
  }
  // 真正落库：新建一套并选中它（不碰当前编辑中的卡组内容）；排序走与加入卡组同一套口径
  function doImportDeck(name, cards) {
    var deck = { id: 'deck-' + (++deckSeq), name: name, cards: sortDefsList(cards) };
    DECKS.push(deck);
    justAddedId = deck.id;
    activeDeckId = deck.id;
    persistDecks();
    cancelImportDeck();
    render();
    toast('已导入「' + name + '」（' + deck.cards.length + ' / ' + DECK_SIZE + ' 张）。');
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
    cancelImportDeck();
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
    var exp = $('deckExportBtn');
    if (exp) exp.addEventListener('click', askExportDeck);
    var imp = $('deckImportBtn');
    if (imp) imp.addEventListener('click', askImportDeck);
    var iOk = $('deckImportOk');
    if (iOk) iOk.addEventListener('click', confirmImportDeck);
    var iCopy = $('deckImportCopy');
    if (iCopy) iCopy.addEventListener('click', confirmExportCopy);
    var iNo = $('deckImportCancel');
    if (iNo) iNo.addEventListener('click', cancelImportDeck);
    var iMask = importMaskEl();
    if (iMask) iMask.addEventListener('click', function (e) { if (e.target === iMask) cancelImportDeck(); });
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
        if (isImportOpen()) { cancelImportDeck(); return; }
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
    // 导出 / 导入（弹窗 #deckImportMask；导出走 activeDeckId，导入只新建卡组）
    askExportDeck: askExportDeck,
    askImportDeck: askImportDeck,
    confirmExportCopy: confirmExportCopy,
    confirmImport: confirmImportDeck,
    cancelImport: cancelImportDeck,
    isImportOpen: isImportOpen,
    editingDeck: editingDeck,
    askDeleteDeck: askDeleteDeck,
    confirmOk: runConfirm,
    cancelConfirm: cancelConfirm,
    isConfirmOpen: isConfirmOpen,
    toast: toast,
  };
})();
