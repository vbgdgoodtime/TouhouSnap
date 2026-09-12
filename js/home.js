/* =========================================================
   东方逆转 · home.js —— 主页面（首页）交互脚本。

   页面本体是 index.html 的静态标记 #homeScreen（<body class="in-home"> 时显示），
   首帧即为主页面、不依赖 JS 执行顺序；本文件只做：
     1) 主页面背景的随机漂浮装饰图标；2) 入口按钮事件接线；
     3) 暴露 window.Home（show / hide / openPage / isHome）；
     4) 开始对战前弹「选出战卡组」（仅满 12 张可选）；5) 新手引导 / 设置 / 图鉴 / 特殊牌池弹窗的开关与互斥。

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
    if (empty) empty.classList.toggle('hidden', has);
    if (list) list.classList.toggle('hidden', !has);
    if (gotoBtn) gotoBtn.classList.toggle('hidden', has);
    if (ok) ok.classList.toggle('hidden', !has);
    if (sub) {
      sub.textContent = has
        ? '请选择一套已凑满 12 张的卡组后再开战（共 ' + decks.length + ' 套可选）'
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

  function openBattleDeckPicker() {
    if (!window.Game || typeof window.Game.restart !== 'function') {
      toast('游戏脚本未就绪，无法开始对战（请检查 game.js 是否加载成功）。');
      return;
    }
    renderBattleDeckList();
    closeCodex();
    var m = battleMask();
    if (m) m.classList.remove('hidden');
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
    hideBattleDeckPicker();
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
    el.textContent = info ? ('对手 AI 强度：' + info.name) : '对手 AI 强度 · 简单 / 普通 / 困难 / 月狂';
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
    renderAiLevels();
    syncSettingsSub();
    m.classList.remove('hidden');
  }
  function closeSettings() {
    var m = settingsMask();
    if (m) m.classList.add('hidden');
  }

  /* ---------- 主页面「📚 图鉴」入口（#homeBtnCodex） ----------
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
      // 主页面弹窗按层级关（与 style.css 的 z-index 一致）：新手引导 212 > 设置 211 > 出战卡组 210
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
    openCodex: openCodex,
    closeCodex: closeCodex,
    isCodexOpen: isCodexOpen,
  };
})();
