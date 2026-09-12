/* =========================================================
   东方逆转 · net.js —— 联机对战（实时房间）

   一段话口径：房间＝云上的一台「消息转发器」（`worker/`，一个房间一个 Durable Object），
   它只转发、按 (回合, 座位) 去重；**对局本身完全跑在两位玩家的浏览器里**。
   两端各自算同一局：同一个种子、双方各带一套 12 张卡组、**建牌一律"房主在先"**；每回合双方各交一个
   「提交包」（本回合暗出的牌 / 移动 / 是否加倍 / 是否认输），灌回对局引擎后按同一套规则翻牌结算。
   本机恒坐 `p`、对手恒坐 `a`（两端状态互为镜像，房间座位序见 `js/game.js` 的 `state.seatOrder`），
   所以界面与全部文案都不需要改。

   谁在什么时候说话：
   - **加倍 / 认输**当场单独发一条（对手要来得及决定要不要撤退）；随后的提交包带同一个标记，两端幂等。
   - **超时判负**：等对手的提交包超过 `TURN_TIMEOUT` 就**直接判他认输**，本机不替他出牌、也不接管他的回合；
     同时发一条 `timeout` 告诉对手"你被判超时"（他若真掉线，这条自然发不到，判定结果两端一致）。
   - **每回合对账**：双方动作都灌完、翻牌之前各报一次状态指纹；不一致立刻停下并说明（分叉当场暴露）。
   - **不做断线重连**：刷新页面＝离开房间，对方会在超时后判你认输，本局结束。

   对外接口（`window.Net`）：`active()` / `awaitRemoteTurn` / `submitLocalTurn` / `sendSnap` / `sendRetreat` /
   `sendTimeout` / `reconcileRound` / `abort`，以及 `ui.*`（界面入口）。
   ========================================================= */
(function () {
  'use strict';

  /* ⚠️ 部署完 worker/ 之后，把这里换成你自己的 Worker 地址（`wrangler deploy` 的输出，末尾不要带 / ）。
     用 http(s):// 写即可，代码会自动换成 ws(s)://。 */
  var SERVER = 'https://touhou2-pvp.touhou2-pvp.workers.dev';

  var TURN_TIMEOUT = 90; // 等对手提交包的秒数；到点直接判他认输
  var HURRY_AT = 30;     // 剩余多少秒时催对手一次（免得他不知道自己被等着）
  var CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 房间码字符集：去掉容易看错的 I O 0 1

  var $ = function (id) { return document.getElementById(id); };

  var ws = null;
  var room = '';
  var myName = '';
  var role = null;        // 'host' | 'guest'：本机在房间里的角色
  var peerOnline = false;
  var started = false;    // 是否已开局（开局后 active() 为真）
  var closed = false;     // 主动退出 / 中止后不再提示重连
  var myHello = null;     // { t, name, dataHash, engineHash, codes }
  var peerHello = null;
  var seed = null;
  var readySelf = false;
  var readyPeer = false;
  var engineHash = 'pending';

  var cachedRemote = {};  // 回合 → 对手先交上来的包（本机还没轮到阶段③时先存着）
  var pendingRemote = {}; // 回合 → 等包的 resolve
  var myHashes = {};      // 回合 → 本机对账指纹
  var peerHashes = {};    // 回合 → 对手对账指纹
  var hurriedSent = false; // 本回合是否已经催过对手交牌
  var hurryWarned = false; // 本回合是否已被对手催过

  /* ---------------- 小工具 ---------------- */
  function shortHash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; }
    return ('0000000' + h.toString(16)).slice(-8);
  }
  function randStr(n) {
    var a = new Uint32Array(n);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (var i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 4294967296);
    var out = '';
    for (var j = 0; j < n; j++) out += CHARS[a[j] % CHARS.length];
    return out;
  }
  // 引擎版本指纹：把本页所有 <script src> 的源码拼起来取哈希 —— 有一方跑着缓存里的旧页面，这里就对不上
  (function computeEngineHash() {
    var srcs = [], list = document.querySelectorAll('script[src]');
    for (var i = 0; i < list.length; i++) srcs.push(list[i].getAttribute('src'));
    if (!srcs.length || !window.fetch) { engineHash = 'none'; return; }
    Promise.all(srcs.map(function (s) {
      return fetch(s, { cache: 'no-cache' }).then(function (r) { return r.text(); }).catch(function () { return ''; });
    })).then(function (texts) { engineHash = shortHash(texts.join('\n/*---*/\n')); })
      .catch(function () { engineHash = 'none'; });
  })();
  function helloReady() {
    return new Promise(function (resolve) {
      if (engineHash !== 'pending') { resolve(); return; }
      var tries = 0;
      var iv = setInterval(function () {
        if (engineHash !== 'pending' || ++tries > 40) { clearInterval(iv); resolve(); }
      }, 100);
    });
  }

  /* ---------------- 界面（元素在 index.html，缺了一律静默跳过） ---------------- */
  var ui = {
    tip: function (text, warn) {
      var el = $('netTip');
      if (el) { el.textContent = text; el.className = 'net-tip' + (warn ? ' warn' : ''); }
      ui.bar();
    },
    // 顶栏的联机状态条（对局中一直可见）
    bar: function (extra) {
      var el = $('netBar');
      if (!el) return;
      if (!room || !started) { el.classList.add('hidden'); return; }
      el.classList.remove('hidden');
      var txt = '🌐 ' + room + '（' + (role === 'host' ? '房主' : '加入者') + '）· ' + (peerOnline ? '对手在线' : '⚠️ 对手已掉线');
      if (extra) txt += ' · ' + extra;
      el.textContent = txt;
    },
    open: function () {
      var m = $('netMask');
      if (!m) return;
      var srv = $('netServer');
      if (srv) srv.textContent = SERVER;
      var ri = $('netRoomInfo');
      if (ri) ri.textContent = room ? ('当前房间 ' + room + '（' + (role === 'host' ? '房主' : '加入者') + '）') : '还没有进入房间';
      if (!room) ui.tip('一台设备点「创建房间」，把 6 位房间码报给朋友，对方在同一个弹窗里「加入房间」。'
        + '双方页面必须是同一版本（先 Ctrl+F5 硬刷新），各自带一套满 12 张的卡组。'
        + '对局中每一手都要在 ' + TURN_TIMEOUT + ' 秒内交出来，超时直接判那一方认输；刷新页面等于离开房间。');
      m.classList.remove('hidden');
    },
    close: function () { var m = $('netMask'); if (m) m.classList.add('hidden'); },
    create: function () { if (serverReady()) connect(randStr(6)); },
    join: function () {
      if (!serverReady()) return;
      var inp = $('netRoomInput');
      var code = (inp && inp.value ? inp.value : '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 6) { ui.tip('房间码是 6 位字母或数字，请再确认一下。', true); return; }
      connect(code);
    },
    ready: function () {
      readySelf = true;
      send({ t: 'ready' });
      var b = $('netReady');
      if (b) b.disabled = true;
      ui.tip('已准备 —— 等对手也点「我已准备」就开局。');
      maybeStart();
    },
    leave: function () {
      closed = true;
      send({ t: 'bye' });
      try { if (ws) ws.close(); } catch (e) { /* ignore */ }
      ws = null;
      room = ''; role = null; started = false; peerOnline = false;
      readySelf = false; readyPeer = false; myHello = null; peerHello = null;
      ui.tip('已退出房间。');
      var el = $('netBar');
      if (el) el.classList.add('hidden');
    },
  };
  function serverReady() {
    if (!SERVER) {
      ui.tip('还没配置服务器地址：先把 worker/ 部署上去，再把地址填进 js/net.js 顶部的 SERVER。', true);
      return false;
    }
    return true;
  }

  /* ---------------- 连接 ---------------- */
  function connect(code) {
    closed = false;
    room = code;
    myName = '玩家' + randStr(4);
    readySelf = false; readyPeer = false; // 换房间要重新准备
    var readyBtn = $('netReady');
    if (readyBtn) readyBtn.disabled = false;
    ui.tip('正在连接房间 ' + room + ' …');
    var url = SERVER.replace(/\/+$/, '').replace(/^http/, 'ws') + '/ws/' + room
      + '?token=' + encodeURIComponent(randStr(10)) + '&name=' + encodeURIComponent(myName);
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error('[net] WebSocket 建立失败：', e);
      ui.tip('连不上房间（地址不对，或被浏览器拦了）—— 详情见控制台。', true);
      return;
    }
    ws.onmessage = function (ev) {
      var data = null;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      onServer(data);
    };
    ws.onclose = function () {
      if (closed) return;
      peerOnline = false;
      if (started) ui.tip('连接断了 —— 这一局到此为止：对面会在超时后判你认输（刷新页面等于离开房间）。', true);
      else if (!role) ui.tip('没能进这个房间 —— 多半是里面已经有两个人了，换一个房间码或让对方退出后重试。', true);
      else ui.tip('连接已关闭。', true);
      ui.bar();
    };
    ws.onerror = function () {
      ui.tip('连接出错 —— 若地址是 *.workers.dev，国内网络经常连不上（见 worker/README.md）。', true);
    };
  }

  function send(msg) {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ t: 'msg', msg: msg })); } catch (e) { console.error('[net] 发送失败：', e); }
  }

  function onServer(data) {
    if (data.t === 'error') {
      closed = true;
      if (data.code === 'full') ui.tip('这个房间里已经有两个人了 —— 换一个房间码，或等对方退出。', true);
      else ui.tip('房间报错：' + (data.text || data.code || '未知'), true);
      try { if (ws) ws.close(); } catch (e) { /* ignore */ }
      return;
    }
    if (data.t === 'welcome') {
      role = data.role;
      peerOnline = !!data.peer;
      ui.tip('已进入房间 ' + data.room + '，你是' + (role === 'host' ? '房主' : '加入者') + '。' + (peerOnline ? '' : '等对手进来…'));
      ui.bar();
      sendHello();
      return;
    }
    if (data.t === 'peer') {
      peerOnline = !!data.online;
      ui.bar();
      if (started) ui.tip(data.online ? '对手已回到房间。' : '对手的连接断了 —— 轮到他交牌时会在超时后判他认输。', !data.online);
      // 对手刚进来：把在场时发过、但当时房间里没人的消息**再报一次** —— 房间只转发、不保存，
      // 先到的人在自己连上时发的 hello / ready 都是"发给空气"的。不补这一下，后进来的一方会缺对手的卡组与版本。
      if (data.online && !started) {
        sendHello();
        if (readySelf) send({ t: 'ready' });
      }
      return;
    }
    if (data.t === 'msg') { onPeer(data.from, data.msg || {}); return; }
  }

  // 本机卡组（DeckStorage 按**卡名**保存）→ 卡牌码；没有满 12 张的卡组就不能联机
  function myDeckCodes() {
    var api = window.DeckStorage;
    var data = api && api.load ? api.load() : null;
    var decks = (data && data.decks) || [];
    var deck = null;
    for (var i = 0; i < decks.length; i++) if (decks[i].id === data.activeDeckId) { deck = decks[i]; break; }
    if (!deck) for (var j = 0; j < decks.length; j++) if (decks[j].cards && decks[j].cards.length === 12) { deck = decks[j]; break; }
    if (!deck || !deck.cards || deck.cards.length !== 12) return null;
    var g = window.Game;
    if (!g || !g.net || !g.net.codesOfNames) return null;
    var codes = g.net.codesOfNames(deck.cards);
    for (var k = 0; k < codes.length; k++) if (!codes[k]) return null;
    return codes;
  }

  function sendHello() {
    helloReady().then(function () {
      if (myHello) { send(myHello); maybeStart(); return; }
      var codes = myDeckCodes();
      if (!codes) { ui.tip('没有可用的出战卡组 —— 先去「卡组设置」组一套满 12 张的卡组，再回来联机。', true); return; }
      var g = window.Game;
      myHello = {
        t: 'hello', name: myName,
        dataHash: (g && g.dataHash) ? g.dataHash() : 'none',
        engineHash: engineHash, codes: codes,
      };
      send(myHello);
      maybeStart();
    });
  }

  function checkHello() {
    if (!myHello || !peerHello) return false;
    if (peerHello.dataHash !== myHello.dataHash) {
      ui.tip('双方卡牌数据版本不一致（对方 ' + peerHello.dataHash + ' / 本机 ' + myHello.dataHash
        + '）—— 请双方都按 Ctrl+F5 硬刷新页面再试。', true);
      return false;
    }
    // 引擎指纹拿不到（fetch 被拦）时只警告、不拦：数据哈希仍会把版本差异挡住
    var a = peerHello.engineHash, b = myHello.engineHash;
    if (a && b && a !== b && a !== 'none' && b !== 'none' && a !== 'pending' && b !== 'pending') {
      ui.tip('双方的页面版本不一致（有一方还在跑缓存里的旧页面）—— 请双方都按 Ctrl+F5 硬刷新再试。', true);
      return false;
    }
    return true;
  }

  function onPeer(from, msg) {
    switch (msg.t) {
      case 'hello':
        peerHello = msg;
        if (started) return;
        if (!checkHello()) { abort('双方版本不一致，未开局。'); return; }
        ui.tip('对手就位（' + (msg.name || '匿名') + '）—— 双方都点「我已准备」即可开局。');
        maybeStart();
        if (seed !== null) beginGame(); // 种子（房主的 start）先到、对方的 hello 后到：立刻补开局，不再干等
        return;
      case 'ready':
        readyPeer = true;
        ui.tip('对手已准备 —— ' + (readySelf ? '你已准备，正在开局…' : '轮到你了。'));
        maybeStart();
        return;
      case 'start':
        if (started) return;
        seed = msg.seed;
        beginGame();
        return;
      case 'snap':
        window.Game.net.applyPeerSnap('a');
        return;
      case 'retreat':
        window.Game.net.applyPeerRetreat('a');
        return;
      case 'timeout':
        // 对手等不到我的提交包，已经判我认输 —— 本机照他的判定收摊（两边结论一致）
        ui.tip('对手判定你超时未提交 —— 本局判你认输。', true);
        window.Game.net.forfeitSelf();
        return;
      case 'hurry':
        // 对手已经在等我交牌：让他别再干等（真正的判负由超时那条路走）
        hurryWarned = true;
        ui.bar('⚠️ 对手在等你交牌 —— 超时将判你认输');
        return;
      case 'turn':
        deliverRemote(msg);
        return;
      case 'hash':
        peerHashes[msg.round] = msg.fp;
        compareHash(msg.round);
        return;
      default:
        return;
    }
  }

  // 双方都准备 ⇒ 房主定种子发令开局（两端从同一个起点开始算）
  function maybeStart() {
    if (started || !readySelf || !readyPeer || !peerHello || !myHello) return;
    if (!checkHello()) return;
    if (role !== 'host') { ui.tip('对手已准备，等房主（对方）发令开局…'); return; }
    if (seed === null) seed = Math.floor(Math.random() * 4294967296) >>> 0;
    send({ t: 'start', seed: seed });
    beginGame();
  }

  function beginGame() {
    if (started) return;
    var host = role === 'host' ? (myHello && myHello.codes) : (peerHello && peerHello.codes);
    var guest = role === 'host' ? (peerHello && peerHello.codes) : (myHello && myHello.codes);
    if (seed === null || !host || !guest) {
      var miss = (seed === null ? '还没收到种子' : '') + (seed === null && (!host || !guest) ? '、' : '')
        + (!host || !guest ? '还没收到双方的卡组' : '');
      ui.tip('开局信息不全（' + miss + '）—— 本机已把版本与卡组再报一次；若几秒后仍是这样，双方各自点「退出房间」重来。', true);
      sendHello(); // 我这边缺的可能是对方的 hello：再报一次自己的，对面收到后会回敬一份
      return;
    }
    started = true;
    ui.bar('开局中…');
    if (window.Home && window.Home.hide) window.Home.hide();
    ui.close();
    var p = window.Game.net.restart({ role: role, seed: seed, hostCodes: host, guestCodes: guest });
    if (p && typeof p.catch === 'function') {
      p.catch(function (err) { console.error('[net] 开局失败：', err); abort('开局失败 —— 详情见控制台。'); });
    }
  }

  /* ---------------- 引擎侧接口 ---------------- */
  function active() { return started; }

  function deliverRemote(pkg) {
    cachedRemote[pkg.round] = pkg;
    var w = pendingRemote[pkg.round];
    if (w) { delete pendingRemote[pkg.round]; w(pkg); }
  }

  // 等对手本回合的提交包。返回 `null` ＝ 超时，由引擎判他认输（本机不替他出牌）。
  function awaitRemoteTurn(round) {
    if (cachedRemote[round]) {
      var got = cachedRemote[round];
      delete cachedRemote[round];
      return Promise.resolve(got);
    }
    ui.bar('已提交，等对手…');
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (v) { if (done) return; done = true; resolve(v); };
      pendingRemote[round] = finish;
      var t0 = Date.now();
      var iv = setInterval(function () {
        if (done) { clearInterval(iv); return; }
        var left = TURN_TIMEOUT - Math.floor((Date.now() - t0) / 1000);
        if (left <= 0) {
          clearInterval(iv); delete pendingRemote[round];
          ui.bar('对手超时 —— 判他认输');
          finish(null);
          return;
        }
        // 剩 30 秒时催他一次：让对面知道"有人在等你交牌"，而不是闷声到点判负
        if (left <= HURRY_AT && !hurriedSent) { hurriedSent = true; send({ t: 'hurry' }); }
        ui.bar('已提交，等对手… ' + left + 's（超时判他认输）');
      }, 1000);
    });
  }

  // 轮到我出牌：状态条上写清本回合的时限，免得"闷声被判超时"
  function localTurnStarted(round) {
    hurriedSent = false;
    if (hurryWarned) { hurryWarned = false; ui.tip('对手已经交牌在等你 —— 交出这一手后本回合就开始结算。'); }
    ui.bar('第 ' + round + ' 回合 · 等你出牌（超时 ' + TURN_TIMEOUT + ' 秒判负）');
  }

  function submitLocalTurn(pkg) {
    hurriedSent = false;
    send(pkg);
    ui.bar('已提交第 ' + pkg.round + ' 回合');
  }

  function sendSnap() { send({ t: 'snap' }); }
  function sendRetreat() { send({ t: 'retreat' }); }
  function sendTimeout() { send({ t: 'timeout' }); }

  // 每回合对账：双方动作都灌完、翻牌之前的那个同步点上各报一次状态指纹，不一致立刻停下
  function reconcileRound(round, fp) {
    myHashes[round] = fp;
    send({ t: 'hash', round: round, fp: fp });
    compareHash(round);
  }
  function compareHash(round) {
    if (!myHashes[round] || !peerHashes[round]) return;
    if (myHashes[round] === peerHashes[round]) { ui.bar('第 ' + round + ' 回合对账一致'); return; }
    abort('第 ' + round + ' 回合两端算出的盘面不一致（本机 ' + myHashes[round] + ' / 对手 ' + peerHashes[round]
      + '）—— 本局已停下。请把这句话连同双方控制台的记录发给开发者：对不上说明还有某个"按座位顺序取随机"的点没对齐。');
  }

  function abort(reason) {
    closed = true;
    ui.tip(reason, true);
    ui.bar('⚠️ 已中止');
    var el = $('statusText');
    if (el) el.textContent = reason;
    console.error('[net] ' + reason);
    send({ t: 'bye' });
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
  }

  window.Net = {
    active: active,
    awaitRemoteTurn: awaitRemoteTurn,
    localTurnStarted: localTurnStarted,
    submitLocalTurn: submitLocalTurn,
    sendSnap: sendSnap,
    sendRetreat: sendRetreat,
    sendTimeout: sendTimeout,
    reconcileRound: reconcileRound,
    abort: abort,
    room: function () { return room; },
    role: function () { return role; },
    peerOnline: function () { return peerOnline; },
    timeoutSeconds: TURN_TIMEOUT,
    ui: ui,
  };

  // 点弹窗空白处关闭（与其它弹窗同一习惯；Esc 不接管，免得与主页面既有的 Esc 逐层关闭打架）
  (function bindMask() {
    var m = $('netMask');
    if (m) m.addEventListener('click', function (e) { if (e.target === m) ui.close(); });
  })();
})();
