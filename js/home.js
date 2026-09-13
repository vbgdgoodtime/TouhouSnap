/* =========================================================
   东方逆转 · home.js —— 主页面（首页）交互脚本。

   页面本体是 index.html 的静态标记 #homeScreen（<body class="in-home"> 时显示），
   首帧即为主页面、不依赖 JS 执行顺序；本文件只做：
     1) 主页面背景的随机漂浮装饰图标；2) 入口按钮事件接线；
     3) 暴露 window.Home（show / hide / openPage / isHome）；
     4) 出战卡组弹窗（仅满 12 张可选）—— 单机「开始对战」与联机前选卡组共用，见 openDeckPicker()；
     5) 新手引导 / 设置 / 图鉴 / 特殊牌池弹窗的开关与互斥。

   ⚠️ 跨文件收口：AI 强度档位的选项与中文文案唯一数据源＝js/ai.js 的 window.AI
      （ORDER / LEVELS[key].{name,desc,tip} / DEFAULT_LEVEL / getLevel / setLevel），
      日后增删档位只改 ai.js；图鉴内容全部由 js/card-browser.js 渲染，本文件只管开关。
   ⚠️ 主页面是 z-index 200 的全屏层，style.css 的 `body.in-home .modal-mask { display: none }`
      会连弹窗一起隐藏，故 #guideMask / #codexMask / #zoomMask 各需一条 `body.in-home …:not(.hidden)` 放开显示。

   注：game.js 底部的启动 restart() 保持原样（后台首局随机牌库初始化）。
   ========================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var PAGES = {
    dev: { label: '开发调试', ready: true, page: 'DevTools', tip: '「开发调试」页面正在开发中，后续版本加入。' },
    deck: { label: '卡组设置', ready: true, page: 'DeckBuilder', tip: '「卡组设置」页面正在开发中，后续版本加入。' },
  };

  var pickedDeckId = null;
  // 出战卡组弹窗的用途：'battle' ＝ 单机开战（选完直接开打）；'net' ＝ 联机选卡组（选完交给 openDeckPicker 传进来的
  // onPick，由 js/net.js 接着打开房间弹窗）。同一个弹窗两种用途，单机那条流程不经过 onPick 分支。
  var pickerMode = 'battle';
  var pickerOnPick = null;

  /* ---------- 提示条 ---------- */
  var toastTimer = null;
  function toast(text, ms) {
    var el = $('homeToast');
    if (!el) return;
    el.textContent = text;
    el.classList.remove('hidden');
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.classList.add('hidden');
      toastTimer = null;
    }, ms || 2600);
  }
  function hideToast() {
    var el = $('homeToast');
    if (el) el.classList.add('hidden');
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  }

  /* ---------- 背景装饰 ---------- */
  function buildDecor() {
    var box = $('homeDecor');
    if (!box || box.childElementCount) return;
    var icons = ['⛰️', '🏰', '🎋', '🕳️', '🥒', '🐉', '🌅', '🏯', '🌠', '🪦', '🔥', '♨️', '🏫', '🎰', '🎲', '🏚️', '🎤', '🌪️', '⛩️', '🐭', '🏮', '👻', '❓', '⚡', '🃏', '🍶', '✨', '🌸'];
    for (var i = 0; i < 18; i++) {
      var s = document.createElement('span');
      s.textContent = icons[Math.floor(Math.random() * icons.length)];
      s.style.left = (2 + Math.random() * 94).toFixed(1) + '%';
      s.style.top = (3 + Math.random() * 92).toFixed(1) + '%';
      s.style.fontSize = (16 + Math.random() * 30).toFixed(1) + 'px';
      s.style.setProperty('--rot', Math.round(Math.random() * 60 - 30) + 'deg');
      s.style.animationDuration = (5 + Math.random() * 6).toFixed(2) + 's';
      s.style.animationDelay = (-Math.random() * 6).toFixed(2) + 's';
      box.appendChild(s);
    }
  }

  /* ---------- 主页面显示 / 隐藏 ---------- */
  function isHome() { return document.body.classList.contains('in-home'); }

  function show() {
    document.body.classList.remove('in-dev');
    document.body.classList.add('in-home');
    var el = $('homeScreen');
    if (el) el.classList.remove('hidden');
    hideBattleDeckPicker();
    closeGuide();
    closeSettings();
    closeCodex();
    closePiles();
    syncSettingsSub();
  }

  function hide() {
    document.body.classList.remove('in-home');
    var el = $('homeScreen');
    if (el) el.classList.add('hidden');
    hideToast();
    hideBattleDeckPicker();
    closeGuide();
    closeSettings();
    closeCodex();
    closePiles();     // ⚠️ 不收起的话，进卡组页时它会从遮罩里重新露出来
  }

  /* ---------- 出战卡组选择 ---------- */

  function readyDecks() {
    if (window.DeckBuilder && typeof window.DeckBuilder.listReadyDecks === 'function') {
      return window.DeckBuilder.listReadyDecks();
    }
    return [];
  }

  function battleMask() { return $('battleDeckMask'); }
  function isBattlePickerOpen() {
    var m = battleMask();
    return !!m && !m.classList.contains('hidden');
  }

  function hideBattleDeckPicker() {
    pickedDeckId = null;
    pickerOnPick = null;
    var m = battleMask();
    if (m) m.classList.add('hidden');
    var ok = $('battleDeckOk');
    if (ok) ok.disabled = true;
  }

  function renderBattleDeckList() {
    var list = $('battleDeckList');
    var empty = $('battleDeckEmpty');
    var sub = $('battleDeckSub');
    var ok = $('battleDeckOk');
    var gotoBtn = $('battleDeckGoto');
    if (!list) return;
    list.innerHTML = '';
    pickedDeckId = null;
    if (ok) ok.disabled = true;

    var decks = readyDecks();
    var has = decks.length > 0;
    var net = pickerMode === 'net';
    if (empty) empty.classList.toggle('hidden', has);
    if (list) list.classList.toggle('hidden', !has);
    if (gotoBtn) gotoBtn.classList.toggle('hidden', has);
    if (ok) {
      ok.classList.toggle('hidden', !has);
      ok.textContent = net ? '用这套卡组联机' : '开始战斗';
    }
    if (sub) {
      sub.textContent = has
        ? (net
          ? '联机双方各带一套满 12 张的卡组 —— 先选好你这套，选完就打开房间弹窗（共 ' + decks.length + ' 套可选）'
          : '请选择一套已凑满 12 张的卡组后再开战（共 ' + decks.length + ' 套可选）')
        : '没有可出战的满编卡组';
    }

    for (var i = 0; i < decks.length; i++) {
      (function (deck) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'battle-deck-item';
        btn.setAttribute('role', 'option');
        btn.setAttribute('aria-selected', 'false');

        var nameEl = document.createElement('span');
        nameEl.className = 'bd-name';
        nameEl.textContent = deck.name;
        btn.appendChild(nameEl);
        btn.title = deck.name + '（12 / 12）';
        btn.addEventListener('click', function () {
          pickedDeckId = deck.id;
          list.querySelectorAll('.battle-deck-item').forEach(function (el) {
            el.classList.remove('selected');
            el.setAttribute('aria-selected', 'false');
          });
          btn.classList.add('selected');
          btn.setAttribute('aria-selected', 'true');
          if (ok) ok.disabled = false;
        });
        list.appendChild(btn);
      })(decks[i]);
    }
  }

  /* 打开出战卡组弹窗。opts.mode = 'net' 时只换文案（联机要整成套带出去），
     并在选定后把卡组交给 opts.onPick（js/net.js 接着打开房间弹窗），不碰对局与主页面显隐。 */
  function openDeckPicker(opts) {
    opts = opts || {};
    pickerMode = opts.mode === 'net' ? 'net' : 'battle';
    pickerOnPick = typeof opts.onPick === 'function' ? opts.onPick : null;
    renderBattleDeckList();
    closeCodex();
    var m = battleMask();
    if (m) m.classList.remove('hidden');
  }

  function openBattleDeckPicker() {
    if (!window.Game || typeof window.Game.restart !== 'function') {
      toast('游戏脚本未就绪，无法开始对战（请检查 game.js 是否加载成功）。');
      return;
    }
    openDeckPicker();
  }

  function confirmBattleDeck() {
    if (!pickedDeckId) return;
    var decks = readyDecks();
    var deck = null;
    for (var i = 0; i < decks.length; i++) {
      if (decks[i].id === pickedDeckId) { deck = decks[i]; break; }
    }
    if (!deck || !deck.cards || deck.cards.length !== 12) {
      toast('请选择一套满 12 张的卡组。');
      return;
    }
    var onPick = pickerOnPick;
    var net = pickerMode === 'net';
    hideBattleDeckPicker();
    if (net && onPick) { onPick(deck); return; } // 联机：卡组交给 js/net.js，由它去连房间
    hide();
    document.body.classList.remove('in-dev');
    try {
      var p = window.Game.restart({ playerDeckDefs: deck.cards.slice() });
      if (p && typeof p.catch === 'function') {
        p.catch(function (err) {
          console.error('[home] 开始对战失败：', err);
          show();
          toast('开局失败，已返回主页面（详情见控制台）。');
        });
      }
    } catch (err) {
      console.error('[home] 开始对战失败：', err);
      show();
      toast('开局失败，已返回主页面（详情见控制台）。');
    }
  }

  /* ---------- 开始对战：先选卡组 ---------- */
  function startBattle() {
    openBattleDeckPicker();
  }

  /* ---------- 新手引导弹窗 ----------
     文案全部写在 index.html（本文件不生成任何内容），这里只管开关 / 与其它主页面弹窗互斥 / Esc 兜底；
     弹窗内「⚔️ 开始对战」→ 关闭弹窗后走既有 startBattle()。 */
  function guideMask() { return $('guideMask'); }
  function isGuideOpen() {
    var m = guideMask();
    return !!m && !m.classList.contains('hidden');
  }
  function openGuide() {
    var m = guideMask();
    if (!m) { toast('新手引导弹窗缺失（请检查 index.html 是否完整）。'); return; }
    hideBattleDeckPicker();
    closeSettings();
    closeCodex();
    hideToast();
    m.classList.remove('hidden');
  }
  function closeGuide() {
    var m = guideMask();
    if (m) m.classList.add('hidden');
  }
  // 弹窗内「⚔️ 开始对战」：先关引导，再走既有的「选出战卡组 → 开战」流程
  function guideStartBattle() {
    closeGuide();
    startBattle();
  }

  /* ---------- 设置弹窗（对手 AI 强度） ----------
     ⚠️ 档位选项与中文说明**不写在本文件**——唯一数据源是 js/ai.js 的 window.AI（见文件头）；
     关闭途径：「关闭 ✕」「知道了」、点遮罩空白、Esc（Esc 优先级见 bind）。 */
  function settingsMask() { return $('settingsMask'); }
  function isSettingsOpen() {
    var m = settingsMask();
    return !!m && !m.classList.contains('hidden');
  }
  function aiApi() { return window.AI || null; }
  function currentAiKey() {
    var api = aiApi();
    if (!api || typeof api.getLevel !== 'function') return null;
    try { return api.getLevel(); } catch (e) { return null; }
  }
  function syncSettingsSub() {
    var el = $('homeSettingsSub');
    if (!el) return;
    var api = aiApi();
    var key = currentAiKey();
    var info = (api && key && api.LEVELS) ? api.LEVELS[key] : null;
    el.textContent = '昵称 / 头像 · 对手 AI 强度：' + (info ? info.name : '简单 / 普通 / 困难 / 月狂');
  }
  // 渲染四档选项（当前档加 .on 与「当前」徽标；默认档在非当前时加灰色「默认」徽标）
  function renderAiLevels() {
    var list = $('aiLevelList');
    var tip = $('settingsTip');
    var detail = $('aiLevelDetail');
    if (!list) return;
    list.innerHTML = '';
    var api = aiApi();
    if (!api || !api.LEVELS || typeof api.setLevel !== 'function') {
      if (tip) tip.textContent = '对手 AI 强度';
      if (detail) detail.textContent = '未找到 window.AI（js/ai.js 未加载或加载失败），暂时无法切换 AI 强度。';
      return;
    }
    var cur = currentAiKey();
    var defKey = api.DEFAULT_LEVEL || null;
    var keys = (api.ORDER && api.ORDER.length) ? api.ORDER : Object.keys(api.LEVELS);
    for (var i = 0; i < keys.length; i++) {
      (function (key) {
        var info = api.LEVELS[key] || {};
        var on = (key === cur);
        var isDefault = (key === defKey);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-level-opt' + (on ? ' on' : '');
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        btn.setAttribute('data-level', key);
        btn.title = info.tip ? (info.name + '：' + info.tip) : (info.name || key);
        var mark = document.createElement('span');
        mark.className = 'alo-mark';
        mark.textContent = on ? '✓' : '';
        var text = document.createElement('span');
        text.className = 'alo-text';
        var nameEl = document.createElement('span');
        nameEl.className = 'alo-name';
        nameEl.textContent = info.name || key;
        var descEl = document.createElement('span');
        descEl.className = 'alo-desc';
        descEl.textContent = info.desc || '';
        text.appendChild(nameEl);
        text.appendChild(descEl);
        btn.appendChild(mark);
        btn.appendChild(text);
        if (on || isDefault) {
          var badge = document.createElement('span');
          badge.className = 'alo-badge' + (on ? '' : ' soft');
          badge.textContent = on ? '当前' : '默认';
          btn.appendChild(badge);
        }
        btn.addEventListener('click', function () { setAiLevel(key); });
        list.appendChild(btn);
      })(keys[i]);
    }
    var curInfo = api.LEVELS[cur] || null;
    if (tip) tip.textContent = curInfo ? ('当前：对手 AI 强度「' + curInfo.name + '」') : '对手 AI 强度';
    if (detail) detail.textContent = curInfo && curInfo.tip ? curInfo.tip : '';
  }
  // 点选一档：**立刻生效**（本局与后续对局都用该强度；AI.setLevel 会写本地存储并记日志）
  function setAiLevel(key) {
    var api = aiApi();
    if (!api || typeof api.setLevel !== 'function') return;
    if (key === currentAiKey()) return; // 点的就是当前档：不重复记录
    try {
      api.setLevel(key);
    } catch (err) {
      console.error('[home] 切换 AI 强度失败：', err);
      toast('切换 AI 强度失败（详情见控制台）。');
      return;
    }
    var info = api.LEVELS[key] || {};
    // 弹窗开着时不弹 toast：主页面 toast 在遮罩之下看不见，弹窗内的 ✓／「当前」徽标已即时反馈
    if (!isSettingsOpen()) toast('对手 AI 强度已切换为「' + (info.name || key) + '」。');
    syncSettingsSub();
    renderAiLevels();
  }
  function openSettings() {
    var m = settingsMask();
    if (!m) { toast('设置弹窗缺失（请检查 index.html 是否完整）。'); return; }
    hideBattleDeckPicker();
    closeGuide();
    closeCodex();
    hideToast();
    loadProfile();      // 每次打开都从存储里重读一遍玩家资料（别的标签页改过也跟得上）
    syncPlayerInputs();
    renderAiLevels();
    syncSettingsSub();
    m.classList.remove('hidden');
  }
  function closeSettings() {
    var m = settingsMask();
    if (m) m.classList.add('hidden');
  }

  /* ---------- 玩家资料（联机时显示给对手的昵称 + 头像） ----------
     只记在本机（`localStorage: touhou2.player.v1`），联机握手时随 `hello` 发给对手（见 js/net.js）；不需要账号。
     ① 昵称必须清洗：**对手那边会把它写进结算弹窗的 HTML**（js/game.js 的 showModal 走 innerHTML），所以两端都过 `cleanName`；
     ② 头像只认「本机也真有这张卡图」的文件名：选项本身就是从卡池里现算的带图卡（`avatarDefs`），
        对手发来的文件名在 js/net.js 里再用 `knownAvatar` 核对一遍 —— 对不上一律退回 👤（防注入，也防两端卡图不一致时的裂图）。 */
  var PLAYER_KEY = 'touhou2.player.v1';
  var NAME_MAX = 12;
  var profile = { name: '', avatar: '' };
  var avatarDefsCache = null;

  function cleanName(v) {
    return String(v == null ? '' : v)
      .replace(/[<>&"']/g, '')                 // 会被写进 HTML 的字符一律不要
      .replace(/[\u0000-\u001f\u007f]/g, '')   // 控制字符
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, NAME_MAX);
  }
  // 可当头像的卡图：普通卡池 + 衍生卡池里**带 `img` 的卡**，按卡图文件名去重（同一张图被两张卡共用时只留一个）；
  // 顺序沿用图鉴的卡池排序（费用↑ → 战力↑ → 卡名，复用 window.CardBrowser.orderDefs）。
  function avatarDefs() {
    if (avatarDefsCache) return avatarDefsCache;
    var seen = {}, out = [];
    function push(d) {
      if (!d || !d.img || seen[d.img]) return;
      seen[d.img] = 1;
      out.push({ img: d.img, n: d.n || d.img, i: d.i || '🖼️' });
    }
    for (var i = 0; i < POOL_COST_KEYS.length; i++) {
      var arr = POOL[POOL_COST_KEYS[i]] || [];
      for (var j = 0; j < arr.length; j++) push(arr[j]);
    }
    if (TOKENS && typeof TOKENS === 'object') {
      for (var k in TOKENS) if (Object.prototype.hasOwnProperty.call(TOKENS, k)) push(TOKENS[k]);
    }
    var cb = window.CardBrowser;
    if (cb && typeof cb.orderDefs === 'function') out.sort(cb.orderDefs);
    avatarDefsCache = out;
    return out;
  }
  function avatarImgs() {
    var list = avatarDefs(), out = [];
    for (var i = 0; i < list.length; i++) out.push(list[i].img);
    return out;
  }
  // 存档里 / 对手发来的头像文件名：只认本机真有的那张卡图，其余一律当"没选"
  function knownAvatar(v) {
    if (!v || typeof v !== 'string') return '';
    var imgs = avatarImgs();
    for (var i = 0; i < imgs.length; i++) if (imgs[i] === v) return v;
    return '';
  }
  function avatarNameOf(img) {
    var list = avatarDefs();
    for (var i = 0; i < list.length; i++) if (list[i].img === img) return list[i].n;
    return '';
  }
  function loadProfile() {
    profile = { name: '', avatar: '' };
    try {
      var raw = window.localStorage ? window.localStorage.getItem(PLAYER_KEY) : null;
      var obj = raw ? JSON.parse(raw) : null;
      if (obj && typeof obj === 'object') {
        profile.name = cleanName(obj.name);
        profile.avatar = knownAvatar(obj.avatar);
      }
    } catch (e) { /* 读不出来就按"没设置过"来 */ }
    return profile;
  }
  function saveProfile() {
    try {
      if (window.localStorage) {
        window.localStorage.setItem(PLAYER_KEY, JSON.stringify({ name: profile.name, avatar: profile.avatar }));
      }
    } catch (e) { /* 存不了就只在本次会话里生效 */ }
  }
  function playerName() { return profile.name; }
  function playerAvatar() { return profile.avatar; }
  function syncPlayerTip() {
    var el = $('playerAvTip');
    if (!el) return;
    el.textContent = profile.avatar
      ? ('已选：' + avatarNameOf(profile.avatar))
      : '未选头像 —— 联机时对手看到的是 👤';
  }
  function setPlayerName(v) {
    profile.name = cleanName(v);
    saveProfile();
  }
  function setPlayerAvatar(img) {
    profile.avatar = knownAvatar(img);
    saveProfile();
    renderAvatarPick();
    notifyProfile();
  }
  // 资料变了就告诉联机层：在房间里会重报一次 hello，对手当场看到新昵称 / 新头像（不在房间或没连上就什么也不做）。
  // ⚠️ 昵称只在**失焦**时调它（见 bind）—— 每敲一个字都重报一次会刷一串消息。
  function notifyProfile() {
    if (window.Net && window.Net.ui && window.Net.ui.refreshHello) window.Net.ui.refreshHello();
  }
  function renderAvatarPick() {
    var box = $('avatarPick');
    if (!box) return;
    box.innerHTML = '';
    var list = avatarDefs();
    for (var i = 0; i < list.length; i++) {
      (function (def) {
        var on = (profile.avatar === def.img);
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'avatar-opt' + (on ? ' on' : '');
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', on ? 'true' : 'false');
        btn.title = def.i + ' ' + def.n;
        var img = document.createElement('img');
        img.src = 'assets/cards/' + encodeURIComponent(def.img);
        img.alt = def.n;
        img.loading = 'lazy';
        // 卡图缺失时退回该卡的 emoji（不裂图、不静默留空）
        img.addEventListener('error', function () {
          if (img.parentNode) img.parentNode.removeChild(img);
          var ico = document.createElement('span');
          ico.className = 'avatar-opt-ico';
          ico.textContent = def.i;
          btn.appendChild(ico);
        });
        btn.appendChild(img);
        btn.addEventListener('click', function () { setPlayerAvatar(def.img); });
        box.appendChild(btn);
      })(list[i]);
    }
    syncPlayerTip();
  }
  // 打开设置时把当前资料回填进输入框（值不同才写，免得打断正在打字的光标）
  function syncPlayerInputs() {
    var inp = $('playerNameInput');
    if (inp && inp.value !== profile.name) inp.value = profile.name;
    renderAvatarPick();
  }

  /* ---------- 主页面「📚 图鉴」入口（#homeBtnCodex） ----------
     ⚠️ 该按钮**当前带 `hidden` 类不显示**（index.html），故本段在主页面上暂时走不到；
        标记与接线都保留着，删掉那个类即可恢复。对局顶栏的「📖 图鉴」走 game.js → CardBrowser，与本段无关。
     只打开**既有**的图鉴弹窗 window.CardBrowser.openCodex()（与对局顶栏「📖 图鉴」同一个 #codexMask），
     故本文件不复制任何卡池 / 卡牌渲染逻辑，日后图鉴改版只改 js/card-browser.js。
     ⚠️ Esc 由 game.js 全局**逐层**关（先 #zoomMask 再 #codexMask），故这里不再往本文件的 Esc 链里加图鉴，
        避免一次 Esc 连关两层。 */
  function codexApi() { return window.CardBrowser || null; }
  function isCodexOpen() {
    var m = $('codexMask');
    return !!m && !m.classList.contains('hidden');
  }
  function openCodex() {
    var api = codexApi();
    if (!api || typeof api.openCodex !== 'function') {
      toast('图鉴脚本未就绪（请检查 js/card-browser.js 是否加载成功）。');
      return;
    }
    hideBattleDeckPicker(); // 与其它主页面弹窗互斥，避免多层遮罩叠加
    closeGuide();
    closeSettings();
    hideToast();
    try {
      api.openCodex();
    } catch (err) {
      console.error('[home] 打开图鉴失败：', err);
      toast('打开图鉴失败（详情见控制台）。');
    }
  }
  function closeCodex() {
    var api = codexApi();
    if (api && typeof api.closeCodex === 'function') {
      try { api.closeCodex(); } catch (e) {  }
    }
    var m = $('codexMask');
    if (m) m.classList.add('hidden');
    var z = $('zoomMask');
    if (z) z.classList.add('hidden');
    var pp = $('powerPanel');
    if (pp) pp.classList.add('hidden');
  }

  /* ---------- 收起特殊牌池弹窗（#pileMask，只在对局内可用） ----------
     本文件不渲染牌池内容（渲染在 js/game.js 的 renderPilePanel），只在回 / 离开主页面时兜底收起。
     ⚠️ body.in-home 会隐藏 .modal-mask，但 **body.in-deck 不会**——不在这里收起的话，
        之前打开过的牌池弹窗会在卡组设置页上重新露出来。 */
  function closePiles() {
    var api = window.Game && window.Game.ui;
    if (api && typeof api.closePiles === 'function') {
      try { api.closePiles(); } catch (e) {  }
    }
    var m = $('pileMask');
    if (m) m.classList.add('hidden');
  }

  /* ---------- 后续页面入口 ---------- */
  function openPage(key) {
    var def = PAGES[key];
    if (!def) return;
    if (def.ready) {
      var mod = def.page && window[def.page];
      if (mod && typeof mod.open === 'function') {
        hide();
        mod.open();
        return;
      }
      console.warn('[home] 页面「' + def.label + '」标记为已实装，但 window.' + def.page + '.open() 不存在。');
    }
    toast(def.tip);
  }

  function bind() {
    buildDecor();
    var battle = $('homeBtnBattle');
    var dev = $('homeBtnDev');
    var deck = $('homeBtnDeck');
    var guide = $('homeBtnGuide');
    var settings = $('homeBtnSettings');
    var codex = $('homeBtnCodex');
    var challenge = $('homeBtnChallenge');
    var net = $('homeBtnNet');
    if (battle) battle.addEventListener('click', startBattle);
    if (dev) dev.addEventListener('click', function () { openPage('dev'); });
    if (deck) deck.addEventListener('click', function () { openPage('deck'); });
    if (guide) guide.addEventListener('click', openGuide);
    if (settings) settings.addEventListener('click', openSettings);
    if (codex) codex.addEventListener('click', openCodex);
    // 挑战码入口：同一个弹窗的导入形态（生成方向在对局结算弹窗上）
    if (challenge) challenge.addEventListener('click', function () { window.Game.ui.onChallengeOpen(); });
    // 联机对战（房间弹窗在 js/net.js；这里只负责开门，通道逻辑不落在主页面脚本里）
    if (net) net.addEventListener('click', function () { if (window.Net) window.Net.ui.open(); });
    syncSettingsSub();
    loadProfile(); // 玩家资料：联机握手时就要用，开局前先读好（不能等打开设置才读）
    var nameInput = $('playerNameInput');
    if (nameInput) {
      nameInput.addEventListener('input', function () { setPlayerName(nameInput.value); });
      // 失焦时才把输入框回写成清洗后的值（打字过程中改会打断光标），并把新昵称报给对手
      nameInput.addEventListener('blur', function () { nameInput.value = profile.name; notifyProfile(); });
    }

    var sClose = $('settingsCloseBtn');
    var sOk = $('settingsOkBtn');
    if (sClose) sClose.addEventListener('click', closeSettings);
    if (sOk) sOk.addEventListener('click', closeSettings);
    var sMask = settingsMask();
    if (sMask) sMask.addEventListener('click', function (e) {
      if (e.target === sMask) closeSettings(); // 只认点遮罩空白，点弹窗内部不关
    });

    var gClose = $('guideCloseBtn');
    var gOk = $('guideOkBtn');
    var gStart = $('guideStartBtn');
    if (gClose) gClose.addEventListener('click', closeGuide);
    if (gOk) gOk.addEventListener('click', closeGuide);
    if (gStart) gStart.addEventListener('click', guideStartBattle);
    var gMask = guideMask();
    if (gMask) gMask.addEventListener('click', function (e) {
      if (e.target === gMask) closeGuide(); // 只认点遮罩空白，点弹窗内部不关
    });

    var cancel = $('battleDeckCancel');
    if (cancel) cancel.addEventListener('click', hideBattleDeckPicker);
    var ok = $('battleDeckOk');
    if (ok) ok.addEventListener('click', confirmBattleDeck);
    var gotoBtn = $('battleDeckGoto');
    if (gotoBtn) gotoBtn.addEventListener('click', function () {
      hideBattleDeckPicker();
      openPage('deck');
    });
    var mask = battleMask();
    if (mask) mask.addEventListener('click', function (e) {
      if (e.target === mask) hideBattleDeckPicker();
    });
    window.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      // 主页面弹窗按层级关（与 style.css 的 z-index 一致）：新手引导 212 > 设置 211 > 出战卡组 210；
      // 联机选卡组时引导 / 设置都关着，所以最后这条会命中它。
      if (isGuideOpen()) { closeGuide(); return; }
      if (isSettingsOpen()) { closeSettings(); return; }
      if (isBattlePickerOpen()) hideBattleDeckPicker();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();

  window.Home = {
    PAGES: PAGES,
    isHome: isHome,
    show: show,
    hide: hide,
    startBattle: startBattle,
    // 出战卡组弹窗的通用入口（js/net.js 用它做「联机前先选卡组」）
    openDeckPicker: openDeckPicker,
    openPage: openPage,
    toast: toast,
    openGuide: openGuide,
    closeGuide: closeGuide,
    isGuideOpen: isGuideOpen,
    // 设置弹窗（对手 AI 强度）：切换收口＝window.AI.setLevel()
    openSettings: openSettings,
    closeSettings: closeSettings,
    isSettingsOpen: isSettingsOpen,
    setAiLevel: setAiLevel,
    currentAiLevel: currentAiKey,
    // 玩家资料（联机时显示给对手的昵称 + 头像，见本文件「玩家资料」段）：
    // js/net.js 握手时读 playerName / playerAvatar；对手发来的昵称与头像文件名先过 cleanName / knownAvatar 再落地
    playerName: playerName,
    playerAvatar: playerAvatar,
    cleanName: cleanName,
    knownAvatar: knownAvatar,
    openCodex: openCodex,
    closeCodex: closeCodex,
    isCodexOpen: isCodexOpen,
  };
})();
