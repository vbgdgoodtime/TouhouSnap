/* =========================================================
   东方逆转 · home.js（v120→v154，v174 增加「⚙️ 设置」）
   主页面（首页）交互脚本。

   页面本体是 index.html 里的静态标记 #homeScreen（<body class="in-home"> 时显示），
   首帧即为主页面、不依赖 JS 执行顺序；本文件只做：
     1) 主页面背景的随机漂浮装饰图标；
     2) 主页面的入口按钮事件接线；
     3) 暴露 window.Home（show / hide / openPage / isHome）；
     4) v137：开始对战前弹出「选出战卡组」（仅满 12 张可选）。
     5) v142：开发调试走 DevTools.open()（空牌库直接开战）。
     6) v154：出战卡组弹窗的卡组位**只显示卡组名**（去掉费用构成串与 12/12 徽标）。
     7) v172：主页面最下方新增「📖 新手引导」按钮（#homeBtnGuide）——打开只读的机制速览
        弹窗 #guideMask（文案全在 index.html 里，本文件只做开关、Esc / 点遮罩空白关闭，
        以及弹窗里的「⚔️ 开始对战」直接复用既有 startBattle() 流程）。
     8) v174：「卡组设置」下方新增「⚙️ 设置」按钮（#homeBtnSettings）——打开 #settingsMask，
        里面切换**对手 AI 强度**（v175 起为四档：简单（默认）/ 普通 / 困难 / 月狂）。三档→四档的
        选项与中文说明**不写在本文件**，统一从 js/ai.js 的 window.AI 读取
        （AI.ORDER / AI.LEVELS[key].{name,desc,tip} / AI.DEFAULT_LEVEL / AI.getLevel() / AI.setLevel()），
        因此日后增删难度档只改 ai.js；按钮副标题同步显示当前档位（#homeSettingsSub），
        非当前档的默认档会带一个灰色「默认」徽标。

   按钮：
     - 开始对战（#homeBtnBattle）：先弹出 #battleDeckMask 选卡组 → 确认后隐藏主页面
       并调用 Game.restart({ playerDeckDefs })；取消则留在主页面。
     - 卡组设置（#homeBtnDeck）：隐藏主页面 → window.DeckBuilder.open()
     - 设置（#homeBtnSettings，v174）：留在主页面 → 弹出 #settingsMask（对手 AI 强度）
     - 开发调试（#homeBtnDev）：隐藏主页面 → window.DevTools.open()
       （不校验卡组，直接开战；玩家空牌库、AI 随机）
     - 新手引导（#homeBtnGuide，v172）：留在主页面 → 弹出 #guideMask 机制速览弹窗
       （不进入对局；「关闭 ✕ / 知道了 / Esc / 点遮罩空白」均可关闭）

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
    closeGuide();     // v172：回到主页面时不残留新手引导弹窗
    closeSettings();  // v174：也不残留设置弹窗
    syncSettingsSub(); // v174：副标题始终显示当前 AI 强度（可能被别处改过）
  }

  function hide() {
    document.body.classList.remove('in-home');
    var el = $('homeScreen');
    if (el) el.classList.add('hidden');
    hideToast();
    hideBattleDeckPicker();
    closeGuide();     // v172：离开主页面时一并关闭新手引导
    closeSettings();  // v174：一并关闭设置弹窗
  }

  /* ---------- v137：出战卡组选择 ---------- */
  /* v154：出战卡组弹窗里每个卡组位**只显示卡组名**——原先还并排显示一串费用构成
     （「1费×2 · 2费×3 · …」）与「12 / 12」徽标，手机端一行放不下会把卡组名挤成省略号；
     列出的卡组本就全是满 12 张，12 张信息改由卡组位的悬停提示（title）承载。 */

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
        // v154：整行只放卡组名（不再显示费用构成串与 12/12 徽标，手机端不再挤省略号）
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

  /* ---------- v172：新手引导弹窗 ----------
     主页面最下方的「📖 新手引导」按钮（#homeBtnGuide）打开只读的机制速览弹窗 #guideMask。
     弹窗文案全部写在 index.html（静态标记，本文件不生成任何内容），这里只负责：
       ① 开关（openGuide / closeGuide）与状态查询（isGuideOpen）；
       ② 关闭途径：弹窗内「关闭 ✕」/「知道了」、点遮罩空白、Esc；
       ③ 弹窗内「⚔️ 开始对战」→ 关闭弹窗后走既有 startBattle()（选出战卡组 → 开新对局）。
     注：主页面是 z-index 200 的全屏层，而游戏弹窗默认在主页面态被隐藏
     （style.css 的 `body.in-home .modal-mask { display: none }`），因此 #guideMask 与
     #battleDeckMask 一样需要一条 `body.in-home #guideMask:not(.hidden) { display: flex }` 放开。 */
  function guideMask() { return $('guideMask'); }
  function isGuideOpen() {
    var m = guideMask();
    return !!m && !m.classList.contains('hidden');
  }
  function openGuide() {
    var m = guideMask();
    if (!m) { toast('新手引导弹窗缺失（请检查 index.html 是否完整）。'); return; }
    hideBattleDeckPicker(); // 与「选出战卡组」互斥，避免两层遮罩叠加
    closeSettings();        // v174：与「设置」互斥
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

  /* ---------- v174：设置弹窗（对手 AI 强度） ----------
     主页面「⚙️ 设置」按钮（#homeBtnSettings，位于「卡组设置」下方）打开 #settingsMask。
     ⚠️ 三档的**选项与中文文案不写在本文件**——统一从 js/ai.js 的 window.AI 读取：
        · AI.ORDER            —— 展示顺序 ['easy','normal','hard','lunatic']
        · AI.LEVELS[key]      —— { name, desc, tip }（玩家可见说明的唯一数据源）
        · AI.getLevel()       —— 当前档位（初值来自 localStorage: touhou2.ai.level / ?ai=）
        · AI.setLevel(key)    —— 切换（写 localStorage，并往对局日志记一条）
     因此日后增删/改档位只改 js/ai.js，index.html 与本文件都不用动。
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
  // 主页面按钮副标题：「对手 AI 强度：简单」
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
    // 弹窗开着时不再弹 toast（弹窗内的 ✓ / 「当前」徽标与提示行已经即时反馈，
    // 且主页面 toast 在遮罩之下看不见）；从控制台等别处调用时才用 toast 提示。
    if (!isSettingsOpen()) toast('对手 AI 强度已切换为「' + (info.name || key) + '」。');
    syncSettingsSub();
    renderAiLevels();
  }
  function openSettings() {
    var m = settingsMask();
    if (!m) { toast('设置弹窗缺失（请检查 index.html 是否完整）。'); return; }
    hideBattleDeckPicker(); // 与其它主页面弹窗互斥，避免多层遮罩叠加
    closeGuide();
    hideToast();
    renderAiLevels();
    syncSettingsSub();
    m.classList.remove('hidden');
  }
  function closeSettings() {
    var m = settingsMask();
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
    var guide = $('homeBtnGuide');     // v172：主页面最下方「新手引导」
    var settings = $('homeBtnSettings'); // v174：卡组设置下方的「设置」（对手 AI 强度）
    if (battle) battle.addEventListener('click', startBattle);
    if (dev) dev.addEventListener('click', function () { openPage('dev'); });
    if (deck) deck.addEventListener('click', function () { openPage('deck'); });
    if (guide) guide.addEventListener('click', openGuide);
    if (settings) settings.addEventListener('click', openSettings);
    syncSettingsSub(); // v174：按钮副标题显示当前 AI 强度

    // v174：设置弹窗的关闭途径（关闭 ✕ / 知道了 / 遮罩空白 / Esc）
    var sClose = $('settingsCloseBtn');
    var sOk = $('settingsOkBtn');
    if (sClose) sClose.addEventListener('click', closeSettings);
    if (sOk) sOk.addEventListener('click', closeSettings);
    var sMask = settingsMask();
    if (sMask) sMask.addEventListener('click', function (e) {
      if (e.target === sMask) closeSettings(); // 只认点遮罩空白，点弹窗内部不关
    });

    // v172：新手引导弹窗的关闭途径（关闭 ✕ / 知道了 / 遮罩空白 / Esc）与「开始对战」
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
      // v172 / v174：主页面弹窗按层级关（新手引导 212 > 设置 211 > 出战卡组 210）
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
    // v172：新手引导弹窗（主页面最下方入口）——暴露出来便于调试与自动化验证
    openGuide: openGuide,
    closeGuide: closeGuide,
    isGuideOpen: isGuideOpen,
    // v174：设置弹窗（对手 AI 强度）——切换本身走 window.AI.setLevel()
    openSettings: openSettings,
    closeSettings: closeSettings,
    isSettingsOpen: isSettingsOpen,
    setAiLevel: setAiLevel,
    currentAiLevel: currentAiKey,
  };
})();
