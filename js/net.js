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
     用 http(s):// 写即可，代码会自动换成 ws(s)://。这是**备用线路**：客户端优先用「和页面同一个域名」
     （见下面的 endpointList()），连不上才回落这里。 */
  var SERVER = 'https://pvp.2houvv.xyz';

  /* ---------------- 线路（为什么有两条） ----------------
     ① **同域线路**：`<页面自己的域名>/ws/<房间码>` —— 由同一条 Worker 的一条路由接（见 `worker/wrangler.toml`
        的 `[[routes]]`）。为什么需要它：国内部分网络"网页能打开、但连 `pvp.` 这个子域名的长连接被掐"
        （实测案例：玩家必须挂代理才能联机；而她的页面 HTTPS 是通的 ⇒ 同域长连接有机会直接过）。
     ② **备用线路**：正式地址 `SERVER`（`pvp.2houvv.xyz`）。
     ⚠️ 两条线路进的是**同一个房间**：房间对象按房间码命名（`ROOMS.idFromName(room)`），与从哪个入口进来无关
        —— 所以两端各走各的线路（一个走同域、一个走备用）照样能遇上。 */
  function endpointList() {
    var out = [];
    try {
      var loc = window.location;
      var okProto = (loc.protocol === 'https:') || (loc.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(loc.hostname));
      if (okProto && loc.host) out.push(loc.protocol + '//' + loc.host);
    } catch (e) { /* file:// 打开时没有同域线路 */ }
    out.push(SERVER);
    var seen = {}, uniq = [];
    for (var i = 0; i < out.length; i++) {
      var b = String(out[i]).replace(/\/+$/, '');
      if (!seen[b]) { seen[b] = 1; uniq.push(b); }
    }
    return uniq;
  }
  function netHostOf(base) { return String(base).replace(/^https?:\/\//, '').replace(/\/+$/, ''); }
  function wsUrlOf(base, code) {
    return String(base).replace(/^http/, 'ws') + '/ws/' + code
      + '?token=' + encodeURIComponent(myToken) + '&name=' + encodeURIComponent(myName);
  }

  var TURN_TIMEOUT = 90; // 等对手提交包的秒数；到点直接判他认输
  var HURRY_AT = 30;     // 倒计时剩这么多秒时状态条转告警色（只是提示，判负仍按 TURN_TIMEOUT）
  var CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 房间码字符集：去掉容易看错的 I O 0 1
  /* 房主专用「踢出对手」按钮：**当前关着**（`false`）—— 它不是纯客户端功能，房间服务得重新部署才认 `{"t":"kick"}`，
     没部署时点了不会发生任何事，索性先不露出来。要用：① 把这里改成 `true`；② `cd worker && npx wrangler deploy`。 */
  var KICK_ENABLED = false;

  var $ = function (id) { return document.getElementById(id); };

  var ws = null;
  // 线路状态：本页固定的 token（服务端认人："同一个 token 回来还是原角色"）、上次连通的线路、
  // 本次连接用的线路、本次是否已收到 welcome、本次是否已试过另一条线路、握手超时计时器
  var myToken = randStr(10);
  var netBase = null;
  var connectBase = null;
  var gotWelcome = false;
  var triedAlt = false;
  var connTimer = null;
  var room = '';
  var myName = '';
  var role = null;        // 'host' | 'guest'：本机在房间里的角色
  var peerOnline = false;
  var started = false;    // 是否已开局（开局后 active() 为真；本局打完仍为真，直到退出房间或重开）
  var closed = false;     // 主动退出 / 中止后不再提示重连
  var selfGone = false;   // 本机这根连接已经断了（不是主动退出）—— 与"对手掉线"要分开：状态条与提示不能把两件事说成一件
  var myHello = null;     // { t, name, avatar, device, dataHash, engineHash, codes }
  var peerHello = null;
  var seed = null;
  var readySelf = false;
  var readyPeer = false;
  var versionBad = false; // 双方版本对不上（数据哈希或引擎指纹），弹窗里并排列出两边的号
  var engineHash = 'pending';
  // 旧页面自检：发布时 tools/publish.ps1 会把「页面版本」烘进 index.html 的 <meta name="page-version">。
  // selfVersion＝本页加载时那一份（于是天然"冻结"在本页的版本上），liveVersion＝现拉的线上那份。
  // 两者不一致 ⇒ 本页是旧版（手机端标签页能活好几天，玩家不会主动刷新），在进房间之前就挡住。
  var stalePage = false;
  var selfVersion = '';
  var liveVersion = '';
  var versionChecking = false;  // 自检请求正在飞
  var versionAt = 0;            // 上次自检完成的时间（结果在 VERSION_TTL 内复用，避免每次点入口都发请求）
  var VERSION_TTL = 120000;
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

  /* ---------------- 旧页面自检 ----------------
     发布时 tools/publish.ps1 把「页面版本」烘进 index.html 的 <meta name="page-version">；
     本页加载时记下自己那份（selfVersion，于是它天然"冻结"在本页这一批上）。
     点「🌐 联机对战」时**在后台**拉一份不缓存的 index.html 比一比，不一致＝本页是旧版
     （手机端标签页能活好几天，玩家不会主动刷新）⇒ 在房间弹窗里拦住建房 / 加入 / 准备，并说清该怎么办。
     ⚠️ 自检**绝不挡操作**：拉取放在点入口之后的后台跑（结果 2 分钟内复用）。挡在点击路径上会让
        「联机对战」按钮像坏了一样——要等请求回来才弹选卡组，手机上一两秒就是这么来的。
     ⚠️ 两边任一取不到就放行（老页面没有这个 meta / file:// 打开 / 网络失败）——
        那种情况仍由握手时的引擎指纹兜底，这里只是"提前一步、说人话"。 */
  (function readSelfVersion() {
    var m = document.querySelector('meta[name="page-version"]');
    selfVersion = (m && m.getAttribute('content')) || '';
  })();
  function ensureVersionCheck() {
    if (!selfVersion || !window.fetch) return;                        // 拿不到版本号就什么都不做（见上）
    if (versionChecking) return;
    if (versionAt && (Date.now() - versionAt) < VERSION_TTL) return;  // 刚查过就不重复查（同一份文档不会变）
    versionChecking = true;
    // no-store ＋ 时间戳：连中间的透明代理 / 运营商缓存都绕开，拿到的必须是线上当前那份文档
    fetch('index.html?ts=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var m = /<meta\s+name="page-version"\s+content="([^"]+)"/i.exec(html);
        liveVersion = m ? m[1] : '';
        if (liveVersion && liveVersion !== selfVersion) {
          stalePage = true;
          ui.tip(staleTip(), true);   // 弹窗已经开着就当场看到；还没开则由 syncMask 常驻在提示区
          syncMask();
        }
      })
      .catch(function () { /* 拉不到就放行 */ })
      .then(function () { versionChecking = false; versionAt = Date.now(); });
  }
  // 旧版页面：把门挡住，并把两个版本号一起说出来（排查时一眼看得出本机是哪一批）
  function staleTip() {
    return '你的页面是旧版（本机 ' + (selfVersion || '—') + ' / 线上 ' + (liveVersion || '—')
      + '）—— 手机下拉刷新 / 电脑 Ctrl+F5 刷新后再进。';
  }
  function staleBlocked() {
    if (!stalePage) return false;
    ui.tip(staleTip(), true);
    return true;
  }
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
    // 双方设备（本机现算 / 对手随 `hello` 带来）：只用于显示；对手还没报或报不上来就只显示自己这半
    seg('nbDevice', '你 ' + DEVICE_TEXT[myDevice()]
      + (peerHello && peerHello.device ? ' · 对手 ' + DEVICE_TEXT[peerHello.device] : ''), '');
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
  /* ---------------- 本机是手机还是电脑 ----------------
     只用于显示（房间弹窗的双方名单 + 顶栏状态条），**不进任何指纹、不参与规则**。
     两条判据：UA 里的移动端关键字；或「触摸 + 粗指针」—— iPadOS 13+ 的 UA 装成 Macintosh，只能靠后者认出来。
     认不出的一律算电脑端。对手那头是 `hello.device`，先过白名单再落地（与昵称 / 头像同一条口径）。 */
  function myDevice() {
    if (/Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(navigator.userAgent || '')) return 'phone';
    try {
      if (navigator.maxTouchPoints > 0 && window.matchMedia('(pointer: coarse)').matches) return 'phone';
    } catch (e) { /* 老浏览器没有 matchMedia：按电脑端算 */ }
    return 'pc';
  }
  // 双方设备在两处显示（房间弹窗名单 / 顶栏状态条），都用「电脑 / 手机」四个字，不带图标
  var DEVICE_TEXT = { pc: '电脑', phone: '手机' };
  function cleanPeerDevice(v) { return (v === 'pc' || v === 'phone') ? v : ''; }
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
  // 角色名的唯一读法：**收到服务器的 `welcome` 之前一律"连接中…"**（早先默认写"加入者"，会让人误以为
  // 自己先当加入者、又瞬间变成房主 —— 其实是"对方根本没连上、房间是空的"）
  function roleName() {
    return role ? (role === 'host' ? '房主' : '加入者') : '连接中…';
  }
  function syncMask() {
    var noRoom = !room;
    // 旧版页面（见「旧页面自检」）：建房 / 加入 / 准备一律不露出来，并把"刷新本页"这句话常驻在提示区
    var stale = stalePage && !started;
    toggle('netCreate', noRoom && !stale);
    toggle('netJoin', noRoom && !stale);
    toggle('netTest', noRoom && !stale);
    toggle('netRoomRow', noRoom && !stale);
    toggle('netReady', !noRoom && !started && !stale);
    toggle('netCopy', !noRoom && !started);
    toggle('netLeave', !noRoom);
    if (stale) ui.tip(staleTip(), true);
    // 「踢出对手」：只有房主能看见，而且只在"没开局"或"一局已打完"时出现（对局进行中踢人＝替自己判对手负，容易误触）；
    // 对手已经断开时也不出现 —— 那时房间已经把他那个位置腾出来了，没东西可踢。留在房间里的"半死连接"才是它的用武之地。
    // KICK_ENABLED 当前是 false ⇒ 这个按钮不露出来（原因见文件顶部那个常量的注释）。
    toggle('netKick', KICK_ENABLED && !noRoom && role === 'host' && peerOnline && (!started || matchOver()));
    toggle('netClose', noRoom || started);
    toggle('netPlayers', !noRoom);

    show('netRoomInfo', noRoom
      ? '还没有进入房间'
      : (!role
        // 还没收到服务器的 `welcome`：只说"连接中"。⚠️ 早先这里在角色未知时就默认写"（你是加入者）"，
        // 于是"加入了一个其实没人的房间"看起来就像"我本来是加入者、一瞬间变成了房主"，白白误导玩家。
        ? ('房间码 ' + room + ' · 连接中…')
        : ('房间码 ' + room)));

    // 双方名单：**昵称在前、括号里的属性在后**（昵称（你 · 房主 · 电脑）/ 昵称（对手 · 手机））；
    // 括号只装属性（身份 / 设备），不装昵称；对手还没进来时没有昵称可放，就退回「（对手）还没进来」。
    // ⚠️ 身份只在这里报一次（上面的房间信息行不再复述）；**设备类型保留在这里** —— 联机排查时要一眼看出两端分别是什么设备。
    show('npSelfWho', (myName || '') + '（你 · ' + roleName() + ' · ' + DEVICE_TEXT[myDevice()] + '）');
    show('npPeerWho', peerHello
      ? (peerName() + '（对手' + (peerHello.device ? ' · ' + DEVICE_TEXT[peerHello.device] : '') + '）')
      : '（对手）还没进来');
    setAv('npSelfAv', myAvatar(), '🙋');                      // 自己在设置里选的头像
    setAv('npPeerAv', peerHello && peerHello.avatar, '👤');   // 对手随 hello 带来的头像（已核对过本机有没有这张卡图）
    npState('npSelfState',
      started ? '对局中' : (readySelf ? '已准备' : '等你准备'),
      !started && readySelf ? 'ok' : '');
    npState('npPeerState',
      started ? '对局中'
        : (versionBad ? '版本不一致'
          : (selfGone ? '你已断开'
            : (!peerHello ? '还没进来' : (!peerOnline ? '已掉线' : (readyPeer ? '已准备' : '等待中'))))),
      (started || readyPeer) && !versionBad ? 'ok' : (versionBad || selfGone || (peerHello && !peerOnline) ? 'warn' : ''));

    toggle('netVersion', versionBad);
    if (versionBad) {
      show('nvData', '本机 ' + ((myHello && myHello.dataHash) || '—') + ' / 对方 ' + ((peerHello && peerHello.dataHash) || '—'));
      show('nvEngine', '本机 ' + ((myHello && myHello.engineHash) || '—') + ' / 对方 ' + ((peerHello && peerHello.engineHash) || '—'));
    }
    // 准备按钮的文案跟着状态走：已准备时它就是"撤销"入口（两端都能撤销，只有双方都准备才开局）
    var readyBtn = $('netReady');
    if (readyBtn) readyBtn.textContent = readySelf ? '取消准备' : '我已准备';
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

  /* ---------------- 对手不在房间里 / 房主掉线 / 被房主移出 ----------------
     三种"房间没法继续"的情形，共用最靠前的那层提示（`#peerGoneMask`）与同一套收摊动作（退出房间）：
     ① **对手（加入者）不在房间**：只有"一局已经打完"才收摊 —— 玩家最容易被卡住的一步就是点了「🔁 再来一局」之后
        按钮一直写"等对手也点一下…"，而他分不清对手是掉线了还是在线只是没点（状态条在结算弹窗后面，很容易没看见）；
        ⚠️ 准备阶段加入者掉线**不散房**：房主留在房间里，可以等他自己回来，也可以用「🚪 踢出对手」把位置腾给下一个人。
     ② **房主掉线**（加入者这边看）：房间已经没法继续了 ⇒ 当场提示 + 退出房间 + 回主页面。
     ③ **被房主移出**：同上（区别只是原因文案）。
     ⚠️ **对局进行中一律不这么做**：那时掉线仍按"等对方的提交包超过 TURN_TIMEOUT 就判他认输"处理（口径见 docs/联机对战.md §5），
        抢先退房会把这个判负也一起丢掉 —— 等那一局判完（`onMatchEnd`）自然走到这里。 */
  function matchOver() {
    return !!(window.Game && window.Game.net && window.Game.net.matchOver && window.Game.net.matchOver());
  }
  // 提示的三副文案：`host` ＝ 房主掉线（加入者看）、`kicked` ＝ 被房主移出、其余 ＝ 对手（加入者）掉线
  var PEER_GONE_TXT = {
    peer: ['对手已掉线，将退出房间',
      '他已经离开房间，本机已退出 —— 点「知道了」看本局结果；想再开一局请回主页面重新进「联机对战」。'],
    host: ['房主已掉线，房间已解散',
      '房主离开了房间，房间没人管了，本机已退出 —— 点「知道了」回主页面；想再打一局就自己建一间。'],
    kicked: ['你已被房主移出房间',
      '房主把你请出了房间（多半是要腾位置）—— 想再打就点「联机对战」重新加入，或自己建一间。'],
  };
  var goHomeAfterGone = false; // 上面那层提示的「知道了」要不要顺带回主页面（房主掉线 / 被移出：要）
  function showPeerGone(kind) {
    var m = $('peerGoneMask');
    if (!m || !m.classList.contains('hidden')) return false; // 已经弹着就别重复弹
    var t = PEER_GONE_TXT[kind] || PEER_GONE_TXT.peer;
    show('peerGoneTitle', t[0]);
    show('peerGoneTip', t[1]);
    goHomeAfterGone = (kind === 'host' || kind === 'kicked');
    m.classList.remove('hidden');
    return true;
  }
  // 返回 true ＝ 本次真的处理了（提示已弹出、房间已退）
  function peerGoneCheck() {
    if (!room || peerOnline || selfGone) return false; // 不在房间 / 对手还在线 / 是本机自己断了：什么都不做
    var hostGone = (role === 'guest');                 // 对手是房主 ⇒ 房间没人管了
    if (started && !matchOver()) return false;         // 对局进行中：交给超时判负（判完由 onMatchEnd 再走到这里）
    if (!hostGone && !matchOver()) return false;        // 房主这边：准备阶段对手掉线只提示、不散房（可用「踢出对手」腾位置）
    if (!showPeerGone(hostGone ? 'host' : 'peer')) return false;
    ui.leave(); // 退出房间（提示里已写明）
    return true;
  }

  /* ---------------- 连接自检（「测试连接」） ----------------
     把「网页能不能开」与「长连接能不能建」分成两步报 —— 移动网络里这两件事经常一个通、一个不通：
     典型就是"页面正常、WebSocket 被浏览器云加速或运营商中间设备掐掉"（真事：玩家就因为这一条，
     在聊天软件里折腾了二十分钟，而两句错提示（"我是加入者→房主了"、"多半是房间满了"）一直在误导）。
     测的是**同一台房间服务**；用固定测试房号 ZZTEST，连上就读到应答立刻断开，不打扰任何真实房间。 */
  var TEST_ROOM = 'ZZTEST';
  var testing = false;
  function testSocket(base, done) {
    var url = String(base).replace(/^http/, 'ws') + '/ws/' + TEST_ROOM
      + '?token=' + randStr(10) + '&name=' + encodeURIComponent('连接测试');
    var sock = null, opened = false, settled = false;
    var finish = function (state) {
      if (settled) return;
      settled = true;
      try { if (sock) sock.close(); } catch (e) { /* ignore */ }
      done(state);
    };
    try { sock = new WebSocket(url); } catch (e) { finish('fail'); return; }
    var timer = setTimeout(function () { finish(opened ? 'noanswer' : 'fail'); }, 6000);
    sock.onopen = function () { opened = true; };
    // 收到任何一条服务端消息都算"长连接通了"（哪怕是"房间满"的报错 —— 那也证明连接建起来了）
    sock.onmessage = function () { clearTimeout(timer); finish('open'); };
    sock.onerror = function () { clearTimeout(timer); finish(opened ? 'noanswer' : 'fail'); };
    sock.onclose = function () { clearTimeout(timer); finish(opened ? 'noanswer' : 'fail'); };
  }
  function testConnection() {
    if (testing) return;
    testing = true;
    var list = endpointList();
    var lines = [], i = 0, anyWs = false, anyHttp = false;
    // 判据：**长连接能不能建**才是"能不能联机"；网页探测只是"网络到不到得了这台服务"的旁证。
    var step = function () {
      if (i >= list.length) {
        testing = false;
        var tail = anyWs
          ? ' —— 用标了「长连接能建立」的那条即可（两条进的是同一个房间）。'
          : anyHttp
            ? ' —— 网页能开、长连接不行：多半是浏览器或网络拦了它。依次试：① 换网络（Wi-Fi ↔ 流量）；'
              + '② 关掉浏览器的「云加速 / 极速模式 / 省流」，改用系统自带浏览器；③ 用代理。'
            : ' —— 连网页都打不开：先检查网络 / DNS，或换个网络再试。';
        ui.tip(lines.join('\n') + tail, !anyWs);
        return;
      }
      var base = list[i++];
      var tag = (base === SERVER ? '备用 ' : '同域 ') + netHostOf(base);
      // ⚠️ 探测必须用 no-cors：备用线路（pvp.）与页面**不同源**，普通 fetch 会被 CORS 拦掉
      //    （浏览器报 "No 'Access-Control-Allow-Origin'"，但状态其实是 200），把"其实通着"误报成"网页打不开"—— 实测踩过。
      //    no-cors 只问"请求能不能发出去"，正好是这里要的。
      var probeHttp = function (next) {
        if (!window.fetch) { next(true); return; }
        fetch(base + '/?ts=' + Date.now(), { mode: 'no-cors', cache: 'no-store' })
          .then(function () { next(true); })
          .catch(function () { next(false); });
      };
      probeHttp(function (httpOk) {
        if (httpOk) anyHttp = true;
        testSocket(base, function (sock) {
          var wsOk = (sock === 'open');
          if (wsOk) anyWs = true;
          lines.push((httpOk ? '✅ 网页能开' : '❌ 网页打不开') + ' ｜ '
            + (wsOk ? '✅ 长连接能建立' : sock === 'noanswer' ? '⚠️ 长连接无应答' : '❌ 长连接建不起来')
            + '　— ' + tag);
          step();
        });
      });
    };
    ui.tip('正在测试 ' + list.length + ' 条线路…');
    step();
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
      peerGoneCheck();
    },
    rematch: function () {
      if (!started || !room || rematchSelf) {
        // 房间已经退了（典型：上一局打完对手掉线，本机已自动退房并提示过）：这个按钮不能再重开一局，告诉他该往哪走
        if (!room) show('statusText', '房间已经退出（对手已离开房间）—— 想再开一局请点顶部「← 主页」，从「🌐 联机对战」重新进。');
        return;
      }
      if (peerGoneCheck()) return; // 对手已经不在房间里：不进"等对手也点一下…"，直接提示 + 退房
      rematchSelf = true;
      send({ t: 'rematch' });
      ui.tip(rematchPeer ? '对手也在等 —— 房主正在定新种子重开…' : '已请求再来一局 —— 等对手也点一次。');
      syncAgainBtn();
      maybeRematch();
    },
    // 上面那层提示的「知道了」：关掉这层提示；房主掉线 / 被移出这两种还要顺带回主页面（房间已经散了）
    closePeerGone: function () {
      var m = $('peerGoneMask');
      if (m) m.classList.add('hidden');
      if (goHomeAfterGone) {
        goHomeAfterGone = false;
        if (window.Game && window.Game.ui && window.Game.ui.closeResult) window.Game.ui.closeResult();
        if (window.Home && window.Home.show) window.Home.show();
      }
    },
    /* 房主专用「踢出对手」：请服务端把对手那根连接关掉（`{t:'kick'}`，房间收到后先给他一条 `kicked` 再 close）。
       只在"没开局"或"一局已打完"时可用：对局进行中踢人等于替自己判对手负，容易误触，那种情况让超时判负去收（见 docs/联机对战.md §5）。
       ⚠️ 当前 `KICK_ENABLED = false` ⇒ 按钮不露出来、这里也直接返回（房间服务要重新部署才认这条指令）。 */
    kick: function () {
      if (!KICK_ENABLED) return;
      if (role !== 'host' || !room) return;
      if (started && !matchOver()) {
        ui.tip('对局进行中不能踢人 —— 他真掉线的话，提交超时就会判他认输；打完了再踢。', true);
        return;
      }
      if (!peerOnline) { ui.tip('对手已断开、位置空出来了 —— 把房间码发给下一个人即可。'); return; }
      sendRaw({ t: 'kick' });
      ui.tip('已请房间移出对手 —— 位置随即空出，可以把房间码发给下一个人。');
      syncMask();
    },
    // 设置里改了昵称 / 头像时由 js/home.js 调：在房间里就把 hello 重报一次，对手当场看到新的（见 refreshHello）
    refreshHello: refreshHello,
    // 主页面「🌐 联机对战」入口：**先选一套出战卡组**（与「开始对战」同一条流程：选完才进下一步），
    // 选完才打开房间弹窗；已经在房间里 / 对局进行中就只把弹窗放出来 —— 那时卡组已随握手发出去，换不得了。
    open: function () {
      if (room || started) { ui.showMask(); return; }
      // 已知本页是旧版：直接把房间弹窗放出来说清楚，别让人白选一套卡组
      if (stalePage) { ui.showMask(); return; }
      // 其余情况**先按正常流程走**（选卡组 → 房间弹窗），自检在后台并行跑 ——
      // 结果若是不一致，会在房间弹窗里拦住建房 / 加入 / 准备（见 syncMask 与 staleBlocked）
      ensureVersionCheck();
      pickDeck(function () { ui.showMask(); });
    },
    showMask: function () {
      var m = $('netMask');
      if (!m) return;
      show('netServer', SERVER);
      syncMask();
      // 旧版页面：syncMask 已经给出"该刷新"的提示，这里别再覆盖成正常流程说明
      if (!room && !stalePage) {
        ui.tip((chosenDeckName ? '出战卡组『' + chosenDeckName + '』已选定 · ' : '')
          + '一方点「创建房间」把 6 位码报给对方，另一方填码后点「加入房间」。\n'
          + '换卡组请关掉本弹窗重进 · 每手 ' + TURN_TIMEOUT + ' 秒内交牌，超时判负 · 刷新页面＝离开房间。');
      }
      m.classList.remove('hidden');
    },
    close: function () { var m = $('netMask'); if (m) m.classList.add('hidden'); },
    // 「测试连接」：见上面「连接自检」段（网页 / 长连接两步分开报，专治"页面能开但连不上房间"）
    testConnection: testConnection,
    create: function () { if (staleBlocked()) return; askCreate(); },
    createRandom: createRandom,
    createCustom: createCustom,
    closeCodeAsk: closeCodeAsk,
    join: function () {
      if (staleBlocked()) return;
      if (!serverReady()) return;
      var code = readCode($('netRoomInput'));
      if (code.length !== 6) { ui.tip('房间码是 6 位字母或数字，请再确认一下。', true); return; }
      connect(code);
    },
    // 准备是**可撤销的开关**：点一下＝已准备、再点一下＝撤销（两端都能撤销；撤销必须发一条，否则对方一直以为你已准备）。
    // 两端**都处于已准备**时才由房主开局；开局令（`start`）一旦发出，这一下就作废 —— 见 onPeer 的 ready 分支。
    ready: function () {
      if (staleBlocked()) return;
      if (started) return;
      readySelf = !readySelf;
      send({ t: 'ready', ok: readySelf ? 1 : 0 });
      ui.tip(readySelf
        ? '已准备 —— 等对手也准备好就开局（可再点一次取消）。'
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
          function () { ui.tip('房间码 ' + room + ' 已复制 —— 发给朋友，让他「加入房间」。'); },
          function () { ui.tip('这台浏览器不允许自动复制 —— 请手抄房间码：' + room, true); });
        return;
      }
      ui.tip('这台浏览器不支持自动复制 —— 请手抄房间码：' + room, true);
    },
    leave: function () {
      closed = true;
      sendRaw({ t: 'bye' }); // 告别语是**说给房间**的（让房间马上把位置腾出来），不是转发给对手的消息
      try { if (ws) ws.close(); } catch (e) { /* ignore */ }
      resetRoom();
      syncMask();
      syncOpponent();
      ui.tip('已退出房间。');
    },
    /* 顶栏「←返回主页」在联机对局里走这三个（js/game.js 的 uiOnHome 调 leaveConfirm）：
       **开局后、终局前**才问一句 —— 此时退房＝这一局按提交超时判你输，而按钮常驻顶栏、手机上容易误触；
       还没开局 / 一局已打完都没什么可输的，直接退房回主页面。 */
    leaveConfirm: function () {
      if (!started || matchOver()) { leaveAndHome(); return; }
      var m = $('leaveConfirmMask');
      if (m) m.classList.remove('hidden');
    },
    leaveConfirmOk: function () {
      var m = $('leaveConfirmMask');
      if (m) m.classList.add('hidden');
      leaveAndHome();
    },
    leaveConfirmCancel: function () {
      var m = $('leaveConfirmMask');
      if (m) m.classList.add('hidden');
    },
  };
  // 确认之后的收尾：退房（与房间弹窗「退出房间」同一条路径）+ 回主页面 + 在主页面给一句回执
  function leaveAndHome() {
    ui.leave();
    if (window.Home && window.Home.show) window.Home.show();
    if (window.Home && window.Home.toast) window.Home.toast('已退出房间，回到主页面。');
  }
  function serverReady() {
    if (!SERVER) {
      ui.tip('还没配置服务器地址：先把 worker/ 部署上去，再把地址填进 js/net.js 顶部的 SERVER。', true);
      return false;
    }
    return true;
  }

  /* ---------------- 创建房间：随机码 / 自定义码 ----------------
     手机端开完房往往要切出去（QQ / 微信）把码报给对方，切后台很容易把连接弄断、回来发现自己已掉线；
     所以再给一条路：双方事先在聊天里约定同一串码，各自打开页面直接开房 / 进房，中途不用离开页面。
     ⚠️ 自定义码**不需要服务端配合**：房间按码现开（worker 的 `ROOMS.idFromName(room)`），
        角色按**到达顺序**分配（先到的那个当房主），走的与「加入房间」完全同一条连接逻辑。 */
  function codeMask() { return $('netCodeMask'); }
  function codeTip(text, warn) {
    var el = $('netCodeTip');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'net-tip' + (warn ? ' warn' : '');
  }
  // 房间码一律大写、只留 A-Z / 0-9（「加入房间」与「自定义码建房」共用这一套口径）
  function readCode(el) {
    return String((el && el.value) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
  function askCreate() {
    var m = codeMask();
    if (!m) { if (serverReady()) connect(randStr(6)); return; }   // 弹窗标记缺失（老页面）就按老路子随机建房
    var inp = $('netCodeInput');
    if (inp) inp.value = '';
    codeTip('');
    m.classList.remove('hidden');
    // ⚠️ 刻意**不**自动聚焦输入框：手机上一聚焦就弹软键盘、挡掉"随机房间码"那个按钮，
    //    而随机码这条老路是不该被多一步操作拖慢的（要自定义码的人自己会去点输入框）。
  }
  function closeCodeAsk() {
    var m = codeMask();
    if (m) m.classList.add('hidden');
  }
  function createRandom() {
    closeCodeAsk();
    if (serverReady()) connect(randStr(6));
  }
  function createCustom() {
    if (!serverReady()) return;
    var code = readCode($('netCodeInput'));
    if (code.length !== 6) { codeTip('房间码是 6 位字母或数字（A-Z / 0-9），请再确认一下。', true); return; }
    closeCodeAsk();
    connect(code);
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

  /* ---------------- 连接（同域线路优先，连不上自动回落备用线路） ---------------- */
  function connect(code, base) {
    var list = endpointList();
    var retry = !!base;                       // 带 base ＝ 已经在回落了（本次操作不再试第二条）
    if (!retry) {
      triedAlt = false;
      if (netBase && list.indexOf(netBase) < 0) netBase = null;  // 换过域名的老记录别再用
    }
    var use = base || netBase || list[0];
    // 上一根连接（重试 / 回落 / 退出房间再进来留下的）：**先摘掉 `ws` 再关它**，这样它迟到的 close 会被下面的身份守卫丢掉，
    // 不会把当前房间的在线状态写成"对手已掉线"（那根连接还可能占着房间里的一个角色）。
    var prev = ws;
    resetRoom();
    if (prev) { try { prev.close(); } catch (e) { /* ignore */ } }
    closed = false;
    selfGone = false;
    gotWelcome = false;
    connectBase = use;
    room = code;
    myName = (window.Home && window.Home.playerName && window.Home.playerName()) || ('玩家' + randStr(4));
    var lineName = (use === SERVER) ? '备用线路' : '同域线路';
    ui.tip('正在连接房间 ' + room + ' …' + (retry ? '（' + lineName + '重试）' : (use === SERVER ? '' : '（' + lineName + '）')));
    syncMask();
    try {
      ws = new WebSocket(wsUrlOf(use, room));
    } catch (e) {
      console.error('[net] WebSocket 建立失败：', e);
      ui.tip('连不上房间（地址不对，或被浏览器拦了）—— 详情见控制台。', true);
      return;
    }
    // 传输层没建起来（**一条服务端消息都没收到**）⇒ 换另一条线路再试一次，而不是直接报"连不上"。
    // 已经拿到 `welcome` 之后的断开不算（那是中途掉线，回落没有意义）；服务端明确回 `code:'full'` 也不算（onServer 里单独处理）。
    var fallback = function () {
      if (triedAlt || gotWelcome || closed) return false;
      var alt = null;
      for (var i = 0; i < list.length; i++) { if (list[i] !== use) { alt = list[i]; break; } }
      if (!alt) return false;
      triedAlt = true;
      console.warn('[net] 线路 ' + netHostOf(use) + ' 连不上，改用 ' + netHostOf(alt) + ' 再试一次');
      connect(code, alt);
      return true;
    };
    // 本次连接的身份：三个处理器**只认它** —— 过期连接（已被新连接顶替 / 已被 connect 主动关掉）的迟到事件一律丢弃。
    // 不判身份的话，那种连接的一句 `onclose` 就能把 `peerOnline` 写成 false，而对方没断线 ⇒ 没有任何事件能把它纠正回来。
    var sock = ws;
    // 同域线路没部署 / 被拦时可能既不报错也不断开 ⇒ 给一条 4.5 秒的线：还没等到 `welcome` 就当这条线路不通，回落备用线路
    connTimer = setTimeout(function () {
      if (sock !== ws || gotWelcome || closed) return;
      fallback();
    }, 4500);
    sock.onmessage = function (ev) {
      if (sock !== ws) return;
      var data = null;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      onServer(data);
    };
    sock.onclose = function () {
      if (sock !== ws) return;
      if (closed) return;
      if (!gotWelcome && fallback()) return;   // 换线路重连：这一下不算"断开"，也不提示
      selfGone = true; // 是**本机**断了（不是主动退出）：状态条与提示都不能把这说成"对手掉线"
      peerOnline = false;
      if (started) ui.tip('连接断了 —— 这一局到此为止，对面会在超时后判你认输。', true);
      // 没拿到 `welcome` 就断了 ⇒ 是**连不上房间服务**，不是"房间满"（房间满会收到服务端明确的 `code:'full'`，
      // 上面 onServer 那条分支单独处理）。这两件事过去被写成同一句，把玩家引去"换个房间码"，白折腾很久。
      else if (!role) {
        // 顺便清掉房间状态：否则屏幕上会留着一个房间码、像是已经进房了 —— 玩家截图里那句"我进了"就是这么来的
        resetRoom();
        ui.tip('没能连上房间服务 —— 换网络 / 关浏览器「云加速」/ 用系统自带浏览器再试，或点「测试连接」看哪一步不通。', true);
      }
      else ui.tip('连接已关闭。', true);
      renderBar();
      syncMask();
    };
    sock.onerror = function () {
      if (sock !== ws) return;
      if (!gotWelcome && fallback()) return;   // 同上：先换线路，别急着报错
      ui.tip('连接出错 —— 多半是网络或中间设备拦了长连接：换网络 / 关「云加速」/ 用系统自带浏览器，或点「测试连接」。', true);
    };
  }

  // 转发给对手的消息（房间原样转给对面那一个人）
  function send(msg) {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ t: 'msg', msg: msg })); } catch (e) { console.error('[net] 发送失败：', e); }
  }
  // 直接说给**房间**听的话（bye ＝ 我要走了；kick ＝ 请把对手移出）：这些不是"转发给对手的消息"，而是让服务端做事的指令，
  // 所以不能套 `{t:'msg'}` 那层壳（房间只认顶层的 `t`，套壳会被当成普通消息转给对方、什么也不会发生）。
  function sendRaw(obj) {
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify(obj)); } catch (e) { console.error('[net] 发送失败：', e); }
  }

  function onServer(data) {
    if (data.t === 'error') {
      closed = true;
      if (data.code === 'full') ui.tip('房间里已经有两个人了 —— 换一个房间码，或等对方退出。', true);
      else ui.tip('房间报错：' + (data.text || data.code || '未知'), true);
      try { if (ws) ws.close(); } catch (e) { /* ignore */ }
      resetRoom();   // 没拿到 `welcome` ⇒ 不在房间里：清掉房间状态，界面回到"还没有进入房间"（提示留在上面说明原因）
      syncMask();
      return;
    }
    if (data.t === 'welcome') {
      role = data.role;
      // 这一条线路通了：记下来（本页后续连接直接用它，不再白试一遍；也是回落逻辑的"已握手"闸门）
      gotWelcome = true;
      netBase = connectBase;
      if (connTimer) { clearTimeout(connTimer); connTimer = null; }
      peerOnline = !!data.peer;
      ui.tip(peerOnline
        ? '对手已就位 —— 双方各点一次「我已准备」即开局。'
        : '等对手进来 —— 双方各点一次「我已准备」即开局。');
      syncMask();
      renderBar();
      sendHello();
      return;
    }
    if (data.t === 'kicked') {
      // 房主把本机移出了房间（房间那边已经先发了这条、再关连接）：说清原因、退出房间、回主页面
      closed = true; // 别再把这次断开当成"网络断了"来提示
      showPeerGone('kicked');
      ui.leave();    // 退出房间（提示里已写明）；点「知道了」会回主页面
      return;
    }
    if (data.t === 'peer') {
      peerOnline = !!data.online;
      renderBar();
      syncMask();
      if (started) {
        if (data.online) ui.tip('对手已回到房间。');
        // 对局进行中掉线：仍按"等他的提交包超时判负"（这条提示只在那时说）；一局打完他还没回来则由下面那步收摊
        else if (!matchOver()) ui.tip('对手掉线 —— 轮到他交牌时会按超时判他认输。', true);
      }
      peerGoneCheck(); // 房主掉线（加入者）/ 一局打完对手不在 ⇒ 弹最靠前的提示并退出房间；准备阶段加入者掉线只提示、不散房
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
      if (!chosenCodes) { ui.tip('还没有可出战的卡组 —— 关掉本弹窗，重新点「联机对战」选一套满 12 张的。', true); return; }
      var g = window.Game;
      myHello = {
        t: 'hello', name: myName, avatar: myAvatar(), device: myDevice(),
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
      ui.tip('双方卡牌数据版本不一致 —— 请双方都按 Ctrl+F5 硬刷新（下面已列出两边的版本号）。', true);
      bad = true;
    } else {
      // 引擎指纹拿不到（fetch 被拦）时只放行、不拦：数据哈希仍会把版本差异挡住
      var a = peerHello.engineHash, b = myHello.engineHash;
      if (a && b && a !== b && a !== 'none' && b !== 'none' && a !== 'pending' && b !== 'pending') {
        ui.tip('双方页面版本不一致（有一方还在跑缓存的旧页面）—— 请双方都按 Ctrl+F5 硬刷新。', true);
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
        msg.device = cleanPeerDevice(msg.device); // 对手设备：只认 'pc' / 'phone'（只用于显示，认不出就什么都不显示）
        peerHello = msg;
        if (started) return;
        if (!checkHello()) { abort('双方版本不一致，未开局。'); return; }
        ui.tip('对手就位（' + (msg.name || '匿名') + '）—— 双方各点一次「我已准备」即开局。');
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
            : '对手取消了准备 —— 想开局要等他再点一次。');
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
      ui.tip('开局信息不全（' + miss + '）—— 已重报一次；几秒后仍这样，双方各自「退出房间」重来。', true);
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
    if (connTimer) { clearTimeout(connTimer); connTimer = null; }  // 别让上一次的握手超时线再触发一次回落
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
      + '）—— 本局已停下。请把这句话连同双方控制台的记录发给开发者。');
  }

  function abort(reason) {
    closed = true;
    ui.tip(reason, true);
    ui.bar('⚠️ 已中止', 'bad', null);
    show('statusText', reason);
    console.error('[net] ' + reason);
    sendRaw({ t: 'bye' }); // 同 ui.leave：告别语说给房间听（顶层 `t`，不套 msg 壳）
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

  // 「退出房间并返回主页面？」这层确认：点空白处＝取消（同上，Esc 不接管）
  (function bindLeaveConfirm() {
    var m = $('leaveConfirmMask');
    if (m) m.addEventListener('click', function (e) { if (e.target === m) ui.leaveConfirmCancel(); });
  })();

  // 选码弹窗（创建房间）：点空白处关闭；两个房间码输入框都**边打边清洗**成大写 A-Z / 0-9 ——
  // 约定好的码打在框里一眼就能对出有没有打错，输入框里显示的也就是真正会用的那串
  (function bindCodeMask() {
    var m = codeMask();
    if (m) m.addEventListener('click', function (e) { if (e.target === m) closeCodeAsk(); });
    var custom = $('netCodeInput');
    if (custom) {
      custom.addEventListener('input', function () { custom.value = readCode(custom); });
      custom.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); createCustom(); } });
    }
    var joinInput = $('netRoomInput');
    if (joinInput) joinInput.addEventListener('input', function () { joinInput.value = readCode(joinInput); });
  })();
})();
