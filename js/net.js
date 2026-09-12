/* =========================================================
   东方逆转 · net.js —— 联机对战（实时房间）

   一段话口径：房间＝云上的一台「消息转发器」（`worker/`，一个房间一个 Durable Object），
   它只转发、按 (回合, 发送方角色) 去重；**对局本身完全跑在两位玩家的浏览器里**。
   两端各自算同一局：同一个种子、各自选一套 12 张卡组、**建牌一律"房主在先"**；每回合双方各交一个
   「提交包」（本回合暗出的牌 / 移动 / 是否加倍 / 是否认输），灌回对局引擎后按同一套规则翻牌结算。
   本机恒坐 `p`、对手恒坐 `a`（两端状态互为镜像，房间座位序见 `js/game.js` 的 `state.seatOrder`），
   所以对局界面与全部文案都不需要改。

   谁在什么时候说话：
   - **进场**：`hello`（卡牌数据哈希 + 页面引擎指纹 + 卡组码）→ `ready`（可反复切换的准备开关，双方都准备后）→ 房主的 `start`（种子）。
   - **每回合**：`turn`（提交包）→ `hash`（对账指纹，双方动作都灌完、翻牌之前各报一次）；
     `status`（我这一手已经交了）让对手不必干等，也让他知道该轮到自己交了。
   - **当场**：`snap` / `retreat` —— 对手要来得及决定要不要撤退；随后的提交包带同一个标记，两端幂等。
   - **超时判负**：等对手的提交包超过 `TURN_TIMEOUT` 就**直接判他认输**，本机不替他出牌、也不接管他的回合；
     同时发一条 `timeout` 告诉对手"你被判超时"（他若真掉线，这条自然发不到，判定结果两端一致）。
   - **再来一局**：两端**各点一次**结算弹窗里的「🔁 再来一局」，由房主另定种子广播 `rematch`，两端原地重开。
   - **不做断线重连**：刷新页面＝离开房间，对方会在超时后判你认输，本局结束。

   对外接口（`window.Net`）：`active()` / `awaitRemoteTurn` / `submitLocalTurn` / `sendSnap` / `sendRetreat` /
   `sendTimeout` / `reconcileRound` / `abort` / `room()` / `role()` / `peerOnline()` / `peerName()` / `myName()`，
   以及 `ui.*`（房间弹窗、状态条、对手信息区、再来一局这些界面入口）。
   ========================================================= */
(function () {
  'use strict';

  /* ⚠️ 部署完 worker/ 之后，把这里换成你自己的 Worker 地址（`wrangler deploy` 的输出，末尾不要带 / ）。
     用 http(s):// 写即可，代码会自动换成 ws(s)://。 */
  var SERVER = 'https://pvp.2houvv.xyz';

  var TURN_TIMEOUT = 90; // 等对手提交包的秒数；到点直接判他认输
  var HURRY_AT = 30;     // 倒计时剩这么多秒时状态条转告警色（只是提示，判负仍按 TURN_TIMEOUT）
  var CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 房间码字符集：去掉容易看错的 I O 0 1

  var $ = function (id) { return document.getElementById(id); };

  var ws = null;
  var room = '';
  var myName = '';
  var role = null;        // 'host' | 'guest'：本机在房间里的角色
  var peerOnline = false;
  var started = false;    // 是否已开局（开局后 active() 为真；本局打完仍为真，直到退出房间或重开）
  var closed = false;     // 主动退出 / 中止后不再提示重连
  var selfGone = false;   // 本机这根连接已经断了（不是主动退出）—— 与"对手掉线"要分开：状态条与提示不能把两件事说成一件
  var myHello = null;     // { t, name, dataHash, engineHash, codes }
  var peerHello = null;
  var seed = null;
  var readySelf = false;
  var readyPeer = false;
  var versionBad = false; // 双方版本对不上（数据哈希或引擎指纹），弹窗里并排列出两边的号
  var engineHash = 'pending';
  var chosenCodes = null; // 出战卡组的卡牌码（进房间弹窗之前选好的那套，握手交换的就是它）
  var chosenDeckName = ''; // 那套卡组的名字（只在房间弹窗里回显，让人确认自己带的是哪套）

  var cachedRemote = {};  // 回合 → 对手先交上来的包（本机还没轮到阶段③时先存着）
  var pendingRemote = {}; // 回合 → 等包的 resolve
  var myHashes = {};      // 回合 → 本机对账指纹
  var peerHashes = {};    // 回合 → 对手对账指纹
  var curRound = 0;       // 本回合的回合号（localTurnStarted 记下）
  var peerWaitRound = 0;  // 对手已经交了哪一回合（他自己的 status / 提交包都算）
  var mySubmitRound = 0;  // 我已经交了哪一回合
  var lastCompare = null; // 最近一次对账结果 { round, ok }：常驻在状态条上，不被下一句提示顶掉

  var rematchSelf = false; // 我点了「再来一局」
  var rematchPeer = false; // 对手点了「再来一局」

  // 状态条上本回合那一段（其余各段自己重绘）
  var barInfo = { phase: '', tone: '', left: null };

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
  function toggle(id, on) { var el = $(id); if (el) el.classList.toggle('hidden', !on); }
  function show(id, text) { var el = $(id); if (el) el.textContent = text; }
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

  /* ---------------- 顶栏联机状态条 ----------------
     六段各自成块：房间码 / 角色 / 对手在线 / 本回合阶段 / 倒计时 / 最近一次对账。
     配色口径：等你出牌＝中性、已提交＝蓝（sent）、对手离线或超时＝红（bad）、对账一致＝绿（ok）。 */
  function seg(id, text, tone) {
    var el = $(id);
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
    el.classList.remove('sent', 'bad', 'ok');
    if (tone) el.classList.add(tone);
  }
  function renderBar() {
    var el = $('netBar');
    if (!el) return;
    if (!room || !started) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    seg('nbRoom', room, '');
    seg('nbRole', role === 'host' ? '房主' : '加入者', '');
    // ⚠️ 本机自己断了要说"连接已断开"，不能说成"对手已掉线"（对手可能好好地坐在房间里等你回去）
    seg('nbPeer', selfGone ? '连接已断开' : (peerOnline ? '对手在线' : '对手已掉线'), (selfGone || !peerOnline) ? 'bad' : '');
    seg('nbPhase', barInfo.phase, barInfo.tone);
    // 倒计时：只有"等对手的提交包"才有秒数可数，进度条按 TURN_TIMEOUT 的比例缩短
    var time = $('nbTime');
    if (time) {
      var left = barInfo.left;
      var on = typeof left === 'number';
      time.classList.toggle('hidden', !on);
      if (on) {
        time.classList.toggle('hurry', left <= HURRY_AT);
        var fill = $('nbTimeFill'), val = $('nbTimeVal');
        if (fill) fill.style.width = Math.max(0, Math.min(100, (left / TURN_TIMEOUT) * 100)) + '%';
        if (val) val.textContent = left + 's';
      }
    }
    seg('nbHash', lastCompare
      ? ('第 ' + lastCompare.round + ' 回合对账' + (lastCompare.ok ? '一致' : '不一致'))
      : '', lastCompare && !lastCompare.ok ? 'bad' : 'ok');
  }

  /* ---------------- 玩家资料（昵称 / 头像）在联机里的用法 ----------------
     本机：昵称与头像取自「设置 → 玩家资料」（js/home.js 的 profile，存在本机 localStorage）；昵称没设置就沿用随机「玩家XXXX」。
     对手：`hello` 带来的昵称与头像**先清洗再落地** —— 昵称会进结算弹窗的 HTML（js/game.js 的 showModal 走 innerHTML），
     头像则只认本机卡池里真有的那张卡图（对不上就退回 👤；既防注入，也防两端卡图不一致时的裂图）。 */
  function myAvatar() {
    var h = window.Home;
    return (h && h.playerAvatar) ? (h.playerAvatar() || '') : '';
  }
  function cleanPeerName(n) {
    var h = window.Home;
    var s = (h && h.cleanName) ? h.cleanName(n) : String(n == null ? '' : n).replace(/[<>&"']/g, '').slice(0, 12);
    return s || '匿名';
  }
  function cleanPeerAvatar(v) {
    var h = window.Home;
    return (h && h.knownAvatar) ? h.knownAvatar(v) : '';
  }
  // 头像格：有卡图就放 <img>，没有就用 emoji 兜底（卡图文件名已过白名单核对，不会是指向别处的 URL）；
  // 值没变就不重写 —— syncMask() / renderAll() 调得很勤，每次重建 <img> 会让头像闪一下。
  // ⚠️ 但**只看标记不够**：单机口径（js/game.js 的 renderSide）会把侧栏那个格子直接写成 🤖，
  //    那时标记还是上一次的、内容却已经被改掉了 ⇒ 必须连内容一起核对，否则头像会永远停在 🤖。
  function setAv(id, img, ico) {
    var el = $(id);
    if (!el) return;
    var key = img || ('ico:' + ico);
    if (el.getAttribute('data-av') === key) {
      var first = el.firstChild;
      var intact = img ? !!(first && first.nodeName === 'IMG') : (el.textContent === ico);
      if (intact) return;
    }
    el.setAttribute('data-av', key);
    if (img) el.innerHTML = '<img src="assets/cards/' + encodeURIComponent(img) + '" alt="">';
    else el.textContent = ico;
  }

  /* ---------------- 对手信息区（侧栏） ----------------
     单机显示「对手（AI）」+ 🤖；联机换成对手昵称 + 他自己在设置里选的头像（没选/对不上本机卡图就 👤），
     并多一行"他这一手交了没有"。单机时这个头像格由 js/game.js 的 renderSide 写，联机时它不再碰（免得跟 setAv 打架）。 */
  function peerName() { return (peerHello && peerHello.name) || ''; }
  function syncOpponent() {
    var title = $('oppTitle');
    if (!title) return;
    var net = started;
    title.textContent = net ? ('对手（' + (peerName() || '联机') + '）') : '对手（AI）';
    var av = $('oppAvatar');
    if (av) {
      if (net) setAv('oppAvatar', peerHello && peerHello.avatar, '👤'); // 对手在设置里选的那张卡图（没选就 👤）
      // 单机：game.js 的 renderSide 已经写成 🤖，这里只清掉标记（否则下次进联机会被"值没变"跳过一次刷新）
      else { av.textContent = '🤖'; av.removeAttribute('data-av'); }
      av.classList.toggle('av-net', net);
    }
    var tag = $('oppTurnTag');
    if (!tag) return;
    tag.classList.toggle('hidden', !net);
    if (!net) return;
    var wait = curRound > 0 && peerWaitRound === curRound;
    tag.textContent = wait ? '✅ 已提交，等你出牌' : '⏳ 出牌中…';
    tag.classList.toggle('sent', wait);
  }

  /* 对方发来任何一条消息 ⇒ 他一定在线：状态条/侧栏上的"已掉线"若是别处（某根过期连接的迟到事件）留下的，到这里就地纠正。
     不能只等 worker 再发一条 `peer: online:true` —— 对方一直没断线的话那条永远不会来，错误的"已掉线"会一直挂到本局结束。 */
  function peerHeard() {
    if (peerOnline) return;
    peerOnline = true;
    renderBar();
    syncOpponent();
    syncMask();
  }

  /* ---------------- 房间弹窗 ----------------
     按状态显隐：未进房间 → 创建 / 加入 / 关闭；已进房间未开局 → 我已准备（可再点一次撤销）/ 复制房间码 / 退出房间；
     对局进行中 → 只留房间信息与退出（开局时弹窗已自动关上，这里兜住"对局中又点开入口"的情况）。 */
  function npState(id, text, tone) {
    var el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'np-state' + (tone ? ' ' + tone : '');
  }
  function syncMask() {
    var noRoom = !room;
    toggle('netCreate', noRoom);
    toggle('netJoin', noRoom);
    toggle('netRoomRow', noRoom);
    toggle('netReady', !noRoom && !started);
    toggle('netCopy', !noRoom && !started);
    toggle('netLeave', !noRoom);
    toggle('netClose', noRoom || started);
    toggle('netPlayers', !noRoom);

    show('netRoomInfo', noRoom
      ? '还没有进入房间'
      : ('房间码 ' + room + '（你是' + (role === 'host' ? '房主' : '加入者') + '）'
        + (started ? ' · 对局进行中' : (peerOnline ? ' · 对手已进入' : ' · 等对手进来'))));

    show('npSelfWho', '你（' + (role === 'host' ? '房主' : '加入者') + '）' + (myName ? ' ' + myName : ''));
    show('npPeerWho', '对手' + (peerName() ? '（' + peerName() + '）' : '（还没进来）'));
    setAv('npSelfAv', myAvatar(), '🙋');                      // 自己在设置里选的头像
    setAv('npPeerAv', peerHello && peerHello.avatar, '👤');   // 对手随 hello 带来的头像（已核对过本机有没有这张卡图）
    npState('npSelfState',
      started ? '对局进行中' : (readySelf ? '✓ 已准备' : '… 等你点「我已准备」'),
      !started && readySelf ? 'ok' : '');
    npState('npPeerState',
      started ? '对局进行中'
        : (versionBad ? '⚠️ 版本不一致'
          : (selfGone ? '⚠️ 你已断开'
            : (!peerHello ? '… 还没进来' : (!peerOnline ? '⚠️ 已掉线' : (readyPeer ? '✓ 已准备' : '… 等待中'))))),
      (started || readyPeer) && !versionBad ? 'ok' : (versionBad || selfGone || (peerHello && !peerOnline) ? 'warn' : ''));

    toggle('netVersion', versionBad);
    if (versionBad) {
      show('nvData', '本机 ' + ((myHello && myHello.dataHash) || '—') + ' / 对方 ' + ((peerHello && peerHello.dataHash) || '—'));
      show('nvEngine', '本机 ' + ((myHello && myHello.engineHash) || '—') + ' / 对方 ' + ((peerHello && peerHello.engineHash) || '—'));
    }
    // 准备按钮的文案跟着状态走：已准备时它就是"撤销"入口（两端都能撤销，只有双方都准备才开局）
    var readyBtn = $('netReady');
    if (readyBtn) readyBtn.textContent = readySelf ? '↩️ 取消准备' : '✅ 我已准备';
    syncAgainBtn();
  }

  /* ---------------- 结算弹窗的「🔁 再来一局」 ----------------
     联机时它等的是"两端各点一次"，按钮上要能看出轮到谁；单机（未开局）时保持默认文案。 */
  function syncAgainBtn() {
    var b = $('btnAgain');
    if (!b) return;
    if (!started) { b.disabled = false; b.textContent = '再来一局'; return; }
    b.disabled = rematchSelf;
    b.textContent = rematchSelf ? '等对手也点一下…' : (rematchPeer ? '🔁 对手想再来一局' : '🔁 再来一局');
  }

  /* ---------------- 一局打完、对手已经不在房间里 ----------------
     玩家最容易被卡住的一步：点了「🔁 再来一局」之后按钮一直写"等对手也点一下…"，而他分不清对手是掉线了还是在线只是没点
     （状态条在结算弹窗后面，很容易没看见）。所以**一局结束之后**一旦发现对手不在房间里：
     ① 弹一层**最靠前**的提示说明原因；② 本机直接退出房间（房间已经不完整了，留着也没用）。
     ⚠️ **对局进行中不这么做**：那时掉线仍按"等对方的提交包超过 TURN_TIMEOUT 就判他认输"处理（口径见 docs/联机对战.md §5），
        抢先退房会把这个判负也一起丢掉。 */
  function matchOver() {
    return !!(window.Game && window.Game.net && window.Game.net.matchOver && window.Game.net.matchOver());
  }
  function showPeerGone() {
    var m = $('peerGoneMask');
    if (!m || !m.classList.contains('hidden')) return false; // 已经弹着就别重复弹
    show('peerGoneTip', '他已经离开房间 —— 本机已退出房间，这一局之后不能再和他「再来一局」。'
      + '点「知道了」看本局结果；想再开一局就点顶部「← 主页」，从「🌐 联机对战」重新进。');
    m.classList.remove('hidden');
    return true;
  }
  // 返回 true ＝ 本次真的处理了（提示已弹出、房间已退）
  function peerGoneAfterMatch() {
    if (!started || !room || peerOnline) return false; // 还在房间 / 对手还在线：什么都不做
    if (selfGone) return false;                        // 是**本机**断了，不是对手走了（那种情况不该怪对手）
    if (!matchOver()) return false;                    // 对局进行中：交给超时判负
    if (!showPeerGone()) return false;
    ui.leave(); // 退出房间（提示里已写明）
    return true;
  }

  var ui = {
    tip: function (text, warn) {
      var el = $('netTip');
      if (el) { el.textContent = text; el.className = 'net-tip' + (warn ? ' warn' : ''); }
      renderBar();
    },
    // 顶栏状态条：只传这一段要改的（阶段文案 / 配色 / 剩余秒数），其余各段自己重绘 ——
    // 所以「第 N 回合对账一致」不会被下一句提示顶掉（结果存在 lastCompare 里）。
    bar: function (phase, tone, left) {
      if (phase !== undefined) barInfo.phase = phase;
      if (tone !== undefined) barInfo.tone = tone;
      if (left !== undefined) barInfo.left = left;
      renderBar();
    },
    syncOpponent: syncOpponent,
    // 一局结束（js/game.js 的 finishMatch 与 doRetreat）都走这里：清掉"再来一局"的按局标记、刷新按钮，再看对手还在不在
    onMatchEnd: function () {
      rematchSelf = false;
      rematchPeer = false;
      syncAgainBtn();
      peerGoneAfterMatch();
    },
    rematch: function () {
      if (!started || !room || rematchSelf) {
        // 房间已经退了（典型：上一局打完对手掉线，本机已自动退房并提示过）：这个按钮不能再重开一局，告诉他该往哪走
        if (!room) show('statusText', '房间已经退出（对手已离开房间）—— 想再开一局请点顶部「← 主页」，从「🌐 联机对战」重新进。');
        return;
      }
      if (peerGoneAfterMatch()) return; // 对手已经不在房间里：不进"等对手也点一下…"，直接提示 + 退房
      rematchSelf = true;
      send({ t: 'rematch' });
      ui.tip(rematchPeer ? '对手也在等 —— 房主正在定新种子重开…' : '已请求再来一局 —— 等对手也点「🔁 再来一局」。');
      syncAgainBtn();
      maybeRematch();
    },
    // 上面那层提示的「知道了」：只关掉这层提示 —— 本局结果（结算弹窗）留在后面给玩家看，房间在那之前就已经退了
    closePeerGone: function () {
      var m = $('peerGoneMask');
      if (m) m.classList.add('hidden');
    },
    // 设置里改了昵称 / 头像时由 js/home.js 调：在房间里就把 hello 重报一次，对手当场看到新的（见 refreshHello）
    refreshHello: refreshHello,
    // 主页面「🌐 联机对战」入口：**先选一套出战卡组**（与「开始对战」同一条流程：选完才进下一步），
    // 选完才打开房间弹窗；已经在房间里 / 对局进行中就只把弹窗放出来 —— 那时卡组已随握手发出去，换不得了。
    open: function () {
      if (room || started) { ui.showMask(); return; }
      pickDeck(function () { ui.showMask(); });
    },
    showMask: function () {
      var m = $('netMask');
      if (!m) return;
      show('netServer', SERVER);
      syncMask();
      if (!room) {
        ui.tip((chosenDeckName ? '出战卡组『' + chosenDeckName + '』已选定 —— ' : '')
          + '一台设备点「创建房间」，把 6 位房间码报给朋友，对方在同一个弹窗里「加入房间」。'
          + '要换一套卡组就关掉这个弹窗、重新点「🌐 联机对战」。'
          + '双方页面必须是同一版本（先 Ctrl+F5 硬刷新）；对局中每一手都要在 ' + TURN_TIMEOUT + ' 秒内交出来，'
          + '超时直接判那一方认输；刷新页面等于离开房间。');
      }
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
    // 准备是**可撤销的开关**：点一下＝已准备、再点一下＝撤销（两端都能撤销；撤销必须发一条，否则对方一直以为你已准备）。
    // 两端**都处于已准备**时才由房主开局；开局令（`start`）一旦发出，这一下就作废 —— 见 onPeer 的 ready 分支。
    ready: function () {
      if (started) return;
      readySelf = !readySelf;
      send({ t: 'ready', ok: readySelf ? 1 : 0 });
      ui.tip(readySelf
        ? '已准备 —— 等对手也点「我已准备」就开局（点错了可以再点一次取消）。'
        : '已取消准备 —— 想开局就再点一次「我已准备」。');
      syncMask();
      if (readySelf) maybeStart();
    },
    // 复制房间码（与挑战码那边的「📋 复制」同一个写法：不允许自动复制时提示手抄）
    copy: function () {
      if (!room) return;
      var clip = navigator.clipboard;
      if (clip && typeof clip.writeText === 'function') {
        clip.writeText(room).then(
          function () { ui.tip('房间码 ' + room + ' 已复制 —— 发给朋友，让他在同一个弹窗里点「加入房间」。'); },
          function () { ui.tip('这台浏览器不允许自动复制 —— 请手抄房间码：' + room, true); });
        return;
      }
      ui.tip('这台浏览器不支持自动复制 —— 请手抄房间码：' + room, true);
    },
    leave: function () {
      closed = true;
      send({ t: 'bye' });
      try { if (ws) ws.close(); } catch (e) { /* ignore */ }
      resetRoom();
      syncMask();
      syncOpponent();
      ui.tip('已退出房间。');
    },
  };
  function serverReady() {
    if (!SERVER) {
      ui.tip('还没配置服务器地址：先把 worker/ 部署上去，再把地址填进 js/net.js 顶部的 SERVER。', true);
      return false;
    }
    return true;
  }

  /* ---------------- 出战卡组 ----------------
     进房间弹窗**之前**先选卡组（与「开始对战」同一条流程：复用主页面的 #battleDeckMask，样式与数据都在那边）；
     选定后把卡组码记在 chosenCodes 里，握手发出去的 `hello.codes` 就是它 —— 协议不用改；
     chosenDeckName 只是把这个名字回显在房间弹窗里。卡组没选成（弹窗缺失 / 算不出码）就停在主页面，不放行。 */
  // 选卡组弹窗给的是 **def 引用列表**（与 `Game.restart({ playerDeckDefs })` 同一份数据），
  // 换算成卡组码由 `Game.net.codesOfCards` 收口；算不齐 12 张就返回 null，不放行。
  function deckCodes(cards) {
    var g = window.Game;
    if (!g || !g.net || !g.net.codesOfCards) return null;
    var codes = g.net.codesOfCards(cards);
    if (!codes || codes.length !== 12) return null;
    for (var i = 0; i < codes.length; i++) if (!codes[i]) return null;
    return codes;
  }
  function pickDeck(fn) {
    var home = window.Home;
    if (!home || typeof home.openDeckPicker !== 'function') {
      if (home && home.toast) home.toast('选卡组弹窗不可用 —— 请 Ctrl+F5 硬刷新页面后再试。');
      return;
    }
    home.openDeckPicker({
      mode: 'net',
      onPick: function (deck) {
        var codes = deckCodes(deck.cards);
        // 这里还在主页面（房间弹窗没开），提示走主页面的 toast，否则写进弹窗只会被藏起来
        if (!codes) { home.toast('这套卡组算不出联机用的卡组码 —— 请先 Ctrl+F5 硬刷新本页再试。'); return; }
        chosenCodes = codes;
        chosenDeckName = deck.name || '';
        fn();
      },
    });
  }

  /* ---------------- 连接 ---------------- */
  function connect(code) {
    // 上一根连接（重试 / 退出房间再进来留下的）：**先摘掉 `ws` 再关它**，这样它迟到的 close 会被下面的身份守卫丢掉，
    // 不会把当前房间的在线状态写成"对手已掉线"（那根连接还可能占着房间里的一个角色）。
    var prev = ws;
    resetRoom();
    if (prev) { try { prev.close(); } catch (e) { /* ignore */ } }
    closed = false;
    selfGone = false;
    room = code;
    myName = (window.Home && window.Home.playerName && window.Home.playerName()) || ('玩家' + randStr(4));
    ui.tip('正在连接房间 ' + room + ' …');
    syncMask();
    var url = SERVER.replace(/\/+$/, '').replace(/^http/, 'ws') + '/ws/' + room
      + '?token=' + encodeURIComponent(randStr(10)) + '&name=' + encodeURIComponent(myName);
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error('[net] WebSocket 建立失败：', e);
      ui.tip('连不上房间（地址不对，或被浏览器拦了）—— 详情见控制台。', true);
      return;
    }
    // 本次连接的身份：三个处理器**只认它** —— 过期连接（已被新连接顶替 / 已被 connect 主动关掉）的迟到事件一律丢弃。
    // 不判身份的话，那种连接的一句 `onclose` 就能把 `peerOnline` 写成 false，而对方没断线 ⇒ 没有任何事件能把它纠正回来。
    var sock = ws;
    sock.onmessage = function (ev) {
      if (sock !== ws) return;
      var data = null;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      onServer(data);
    };
    sock.onclose = function () {
      if (sock !== ws) return;
      if (closed) return;
      selfGone = true; // 是**本机**断了（不是主动退出）：状态条与提示都不能把这说成"对手掉线"
      peerOnline = false;
      if (started) ui.tip('连接断了 —— 这一局到此为止：对面会在超时后判你认输（刷新页面等于离开房间）。', true);
      else if (!role) ui.tip('没能进这个房间 —— 多半是里面已经有两个人了，换一个房间码或让对方退出后重试。', true);
      else ui.tip('连接已关闭。', true);
      renderBar();
      syncMask();
    };
    sock.onerror = function () {
      if (sock !== ws) return;
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
      syncMask();
      renderBar();
      sendHello();
      return;
    }
    if (data.t === 'peer') {
      peerOnline = !!data.online;
      renderBar();
      syncMask();
      if (started) {
        if (data.online) ui.tip('对手已回到房间。');
        // 对局进行中掉线：仍按"等他的提交包超时判负"（这条提示只在那时说）；一局打完他还没回来则由下面那步收摊
        else if (!matchOver()) ui.tip('对手的连接断了 —— 轮到他交牌时会在超时后判他认输。', true);
      }
      peerGoneAfterMatch(); // 一局已结束 + 对手不在房间 ⇒ 弹最靠前的提示并退出房间
      // 对手刚进来：把在场时发过、但当时房间里没人的消息**再报一次** —— 房间只转发、不保存，
      // 先到的人在自己连上时发的 hello / ready 都是"发给空气"的。不补这一下，后进来的一方会缺对手的卡组与版本。
      // 他刚连上 ⇒ 他那边是全新的（点过准备也清空），本机记的"他已准备"跟着清掉，免得上一次的准备顶掉这一次的确认。
      if (data.online && !started) {
        readyPeer = false;
        sendHello();
        if (readySelf) send({ t: 'ready', ok: 1 });
      }
      return;
    }
    if (data.t === 'msg') { onPeer(data.from, data.msg || {}); return; }
  }

  function sendHello() {
    helloReady().then(function () {
      if (myHello) { send(myHello); maybeStart(); return; }
      if (!chosenCodes) { ui.tip('还没有可出战的卡组 —— 关掉这个弹窗，重新点「🌐 联机对战」并选一套满 12 张的卡组。', true); return; }
      var g = window.Game;
      myHello = {
        t: 'hello', name: myName, avatar: myAvatar(),
        dataHash: (g && g.dataHash) ? g.dataHash() : 'none',
        engineHash: engineHash, codes: chosenCodes,
      };
      send(myHello);
      maybeStart();
    });
  }

  /* 玩家资料在房间里被改过（设置里换了昵称 / 头像）⇒ 把 hello 就地重报一次，对手那边会立刻更新显示（`onPeer` 的 hello 分支）。
     ⚠️ 与"卡组已随握手发出去、换不得了"不同：昵称与头像只是显示信息、不进任何状态指纹，随时可以改、改了当场生效。 */
  function refreshHello() {
    if (!room || !myHello || !ws || ws.readyState !== 1) return;
    myName = (window.Home && window.Home.playerName && window.Home.playerName()) || myName;
    myHello.name = myName;
    myHello.avatar = myAvatar();
    send(myHello);
    syncMask();       // 房间弹窗里"你"那一行的名字/头像跟着变
    syncOpponent();   // 状态条与侧栏也重绘一次
  }

  function checkHello() {
    if (!myHello || !peerHello) return false;
    var bad = false;
    if (peerHello.dataHash !== myHello.dataHash) {
      ui.tip('双方卡牌数据版本不一致 —— 请双方都按 Ctrl+F5 硬刷新页面再试（弹窗里已并排列出两边的版本号）。', true);
      bad = true;
    } else {
      // 引擎指纹拿不到（fetch 被拦）时只放行、不拦：数据哈希仍会把版本差异挡住
      var a = peerHello.engineHash, b = myHello.engineHash;
      if (a && b && a !== b && a !== 'none' && b !== 'none' && a !== 'pending' && b !== 'pending') {
        ui.tip('双方的页面版本不一致（有一方还在跑缓存里的旧页面）—— 请双方都按 Ctrl+F5 硬刷新再试（弹窗里已并排列出两边的指纹）。', true);
        bad = true;
      }
    }
    versionBad = bad;
    if (bad) syncMask();
    return !bad;
  }

  function onPeer(from, msg) {
    peerHeard(); // 能收到对手的消息＝他在线（见 peerHeard）
    switch (msg.t) {
      case 'hello':
        msg.name = cleanPeerName(msg.name);       // 对手昵称：清洗后再落地（它会被写进结算弹窗的 HTML）
        msg.avatar = cleanPeerAvatar(msg.avatar); // 对手头像：只认本机真有的那张卡图
        peerHello = msg;
        if (started) return;
        if (!checkHello()) { abort('双方版本不一致，未开局。'); return; }
        ui.tip('对手就位（' + (msg.name || '匿名') + '）—— 双方都点「我已准备」即可开局。');
        syncMask();
        syncOpponent();
        maybeStart();
        if (seed !== null) beginGame(); // 种子（房主的 start）先到、对方的 hello 后到：立刻补开局，不再干等
        return;
      case 'ready':
        // 已开局：这一下晚了（房主的开局令已经发出、两端都在这一局里），忽略它两端才不会拆开
        if (started) return;
        var wasReady = readyPeer;
        readyPeer = !!msg.ok; // ok:1 ＝对手点了「我已准备」，ok:0 ＝他撤销了
        if (readyPeer !== wasReady) {
          ui.tip(readyPeer
            ? '对手已准备 —— ' + (readySelf ? '你已准备，正在开局…' : '轮到你了。')
            : '对手取消了准备 —— 想开局要等他再点一次「我已准备」。');
        }
        syncMask();
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
      case 'status':
        // 对手这一手已经交了：他交完只差我这一手，状态条与侧栏都要立刻改口
        peerWaitRound = msg.round;
        syncOpponent();
        if (mySubmitRound !== msg.round) ui.bar('对手已提交第 ' + msg.round + ' 回合 —— 就等你出牌', '', null);
        return;
      case 'turn':
        deliverRemote(msg);
        return;
      case 'hash':
        peerHashes[msg.round] = msg.fp;
        compareHash(msg.round);
        return;
      case 'rematch':
        rematchPeer = true;
        if (typeof msg.seed === 'number') { seed = msg.seed; restartGame(); return; } // 房主的令：两端原地重开
        syncAgainBtn();
        // 请求要有地方能看见：结算弹窗被「确认」关掉的话，把它重新打开（按钮在那个弹窗里）
        if (window.Game.net.netReopenResult) window.Game.net.netReopenResult();
        ui.bar('对手想再来一局 —— 点结算弹窗里的「🔁 再来一局」', 'sent', null);
        maybeRematch();
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

  // 两端各点一次「再来一局」⇒ 房主另定种子广播出去，两端原地重开（卡组沿用本局那套）
  function maybeRematch() {
    if (!rematchSelf || !rematchPeer || role !== 'host') return;
    seed = Math.floor(Math.random() * 4294967296) >>> 0;
    send({ t: 'rematch', seed: seed });
    restartGame();
  }

  function restartGame() {
    resetRound();          // 新一局：把按局存在的通道状态清干净（缓存包 / 对账 / 倒计时 / 对账结果 / 备战标记）
    rematchSelf = false;
    rematchPeer = false;
    started = false;       // 让 beginGame() 重新走一遍开局
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
    ui.bar('开局中…', 'sent', null);
    if (window.Home && window.Home.hide) window.Home.hide();
    ui.close();
    syncMask();
    syncOpponent();
    var p = window.Game.net.restart({ role: role, seed: seed, hostCodes: host, guestCodes: guest });
    if (p && typeof p.catch === 'function') {
      p.catch(function (err) { console.error('[net] 开局失败：', err); abort('开局失败 —— 详情见控制台。'); });
    }
  }

  /* ---------------- 按房间 / 按局存在的状态 ----------------
     两端各算一遍的前提是"每局都从同一个起点开始"，所以这些状态一律**显式清空**，不靠"记得手动清"。 */
  function resetRound() {
    cachedRemote = {};
    pendingRemote = {};
    myHashes = {};
    peerHashes = {};
    curRound = 0;
    peerWaitRound = 0;
    mySubmitRound = 0;
    lastCompare = null;
    barInfo = { phase: '', tone: '', left: null };
    // 备战标记也按局清：下一局要重新「双方各点一次准备」（再来一局走 rematch，不再经过准备这一步）
    readySelf = false;
    readyPeer = false;
  }
  function resetRoom() {
    ws = null;
    room = '';
    role = null;
    started = false;
    peerOnline = false;
    selfGone = false;
    myHello = null;
    peerHello = null;
    seed = null;
    versionBad = false;
    rematchSelf = false;
    rematchPeer = false;
    resetRound();
  }

  /* ---------------- 引擎侧接口 ---------------- */
  function active() { return started; }

  function deliverRemote(pkg) {
    peerWaitRound = pkg.round;
    cachedRemote[pkg.round] = pkg;
    var w = pendingRemote[pkg.round];
    if (w) { delete pendingRemote[pkg.round]; w(pkg); }
    syncOpponent();
  }

  // 等对手本回合的提交包。返回 `null` ＝ 超时，由引擎判他认输（本机不替他出牌）。
  function awaitRemoteTurn(round) {
    curRound = round;
    if (cachedRemote[round]) {
      var got = cachedRemote[round];
      delete cachedRemote[round];
      syncOpponent();
      return Promise.resolve(got);
    }
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
          ui.bar('对手超时 —— 判他认输', 'bad', null);
          finish(null);
          return;
        }
        ui.bar('已提交，等对手交第 ' + round + ' 回合', 'sent', left);
      }, 1000);
      ui.bar('已提交，等对手交第 ' + round + ' 回合', 'sent', TURN_TIMEOUT);
    });
  }

  // 轮到我出牌：状态条写清本回合的时限，免得"闷声被判超时"（这一段没有本地倒计时，秒数由对手那边在数）
  function localTurnStarted(round) {
    curRound = round;
    ui.bar('第 ' + round + ' 回合 · 等你出牌（超时 ' + TURN_TIMEOUT + ' 秒判负）', '', null);
    syncOpponent();
  }

  function submitLocalTurn(pkg) {
    mySubmitRound = pkg.round;
    send(pkg);
    send({ t: 'status', round: pkg.round }); // 告诉对手"我交了"：他那一手交完就能立刻结算，不必干等
    ui.bar('已提交第 ' + pkg.round + ' 回合 —— 等对手', 'sent', null);
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
    var ok = myHashes[round] === peerHashes[round];
    lastCompare = { round: round, ok: ok }; // 常驻在状态条上（renderBar 每次重绘都带上）
    if (ok) { renderBar(); return; }
    abort('第 ' + round + ' 回合两端算出的盘面不一致（本机 ' + myHashes[round] + ' / 对手 ' + peerHashes[round]
      + '）—— 本局已停下。请把这句话连同双方控制台的记录发给开发者：对不上说明还有某个"按座位顺序取随机"的点没对齐。');
  }

  function abort(reason) {
    closed = true;
    ui.tip(reason, true);
    ui.bar('⚠️ 已中止', 'bad', null);
    show('statusText', reason);
    console.error('[net] ' + reason);
    send({ t: 'bye' });
    try { if (ws) ws.close(); } catch (e) { /* ignore */ }
    syncMask();
    syncOpponent();
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
    peerName: peerName,
    myName: function () { return myName; },
    timeoutSeconds: TURN_TIMEOUT,
    ui: ui,
  };

  // 点弹窗空白处关闭（与其它弹窗同一习惯；Esc 不接管，免得与主页面既有的 Esc 逐层关闭打架）
  (function bindMask() {
    var m = $('netMask');
    if (m) m.addEventListener('click', function (e) { if (e.target === m) ui.close(); });
  })();
})();
