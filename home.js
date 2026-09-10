/* =========================================================
   东方逆转 · home.js（v120→v142）
   主页面（首页）交互脚本。

   页面本体是 index.html 里的静态标记 #homeScreen（<body class="in-home"> 时显示），
   首帧即为主页面、不依赖 JS 执行顺序；本文件只做：
     1) 主页面背景的随机漂浮装饰图标；
     2) 三个入口按钮的事件接线；
     3) 暴露 window.Home（show / hide / openPage / isHome）；
     4) v137：开始对战前弹出「选出战卡组」（仅满 12 张可选）。
     5) v142：开发调试走 DevTools.open()（空牌库直接开战）。

   按钮：
     - 开始对战（#homeBtnBattle）：先弹出 #battleDeckMask 选卡组 → 确认后隐藏主页面
       并调用 Game.restart({ playerDeckDefs })；取消则留在主页面。
     - 卡组设置（#homeBtnDeck）：隐藏主页面 → window.DeckBuilder.open()
     - 开发调试（#homeBtnDev）：隐藏主页面 → window.DevTools.open()
       （不校验卡组，直接开战；玩家空牌库、AI 随机）

   注：game.js 底部的启动 restart() 保持原样（后台首局随机牌库初始化）。
   ========================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var PAGES = {
    dev: { label: '开发调试', ready: true, page: 'DevTools', tip: '「开发调试」页面正在开发中，后续版本加入。' },
    deck: { label: '卡组设置', ready: true, page: 'DeckBuilder', tip: '「卡组设置」页面正在开发中，后续版本加入。' },
  };

  var pickedDeckId = null; // 出战卡组弹窗当前选中项

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
    var icons = ['⛰️', '🏰', '🎋', '🕳️', '🐉', '🌅', '🏯', '🌠', '🪦', '🔥', '❓', '⚡', '🃏', '🍶', '✨', '🌸'];
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
  }

  function hide() {
    document.body.classList.remove('in-home');
    var el = $('homeScreen');
    if (el) el.classList.add('hidden');
    hideToast();
    hideBattleDeckPicker();
  }

  /* ---------- v137：出战卡组选择 ---------- */
  function costCurveText(cards) {
    var counts = {};
    for (var i = 0; i < cards.length; i++) {
      var c = cards[i].c;
      counts[c] = (counts[c] || 0) + 1;
    }
    var parts = [];
    var keys = Object.keys(counts).map(Number).sort(function (a, b) { return a - b; });
    for (var k = 0; k < keys.length; k++) {
      parts.push(keys[k] + '费×' + counts[keys[k]]);
    }
    return parts.join(' · ');
  }

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
        btn.innerHTML =
          '<span class="bd-name"></span>' +
          '<span class="bd-curve"></span>' +
          '<span class="bd-count">12 / 12</span>';
        btn.querySelector('.bd-name').textContent = deck.name;
        btn.querySelector('.bd-curve').textContent = costCurveText(deck.cards);
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
    if (battle) battle.addEventListener('click', startBattle);
    if (dev) dev.addEventListener('click', function () { openPage('dev'); });
    if (deck) deck.addEventListener('click', function () { openPage('deck'); });

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
      if (e.key === 'Escape' && isBattlePickerOpen()) hideBattleDeckPicker();
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
  };
})();
