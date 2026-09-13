// 东方逆转 · 访问时长统计（边缘注入，Cloudflare Workers + D1）。
// 只做三件事：① 给站点 HTML 插一段统计脚本；② 收心跳秒数写进 D1；③ 出一个看板。
// **不参与游戏逻辑**，游戏代码（index.html / js / data / worker）一行都不动；口径与坑见 README.md。
//
// 为什么只能放边缘：站点是纯静态（Cloudflare Pages），想不改 index.html / js/ 就统计，只能在这个域名的路由前面加一层。
// ⚠️ `game.2houvv.xyz/ws/*`（联机房间）比 `game.2houvv.xyz/*` 更具体 —— Cloudflare 按「最具体路由优先」，
//    所以联机仍走 worker/ 那个 Worker，本站点的对局完全不受影响。

const ORIGIN = "https://touhousnap.pages.dev"; // 回源地址（Pages 默认域名）。站点换项目 / 换域名时改这里
const SCRIPT_PATH = "/_pt.js"; // 注入的脚本
const BEACON_PATH = "/_pt"; // 客户端心跳（sendBeacon）
const REPORT_PATH = "/_pt-report"; // 看板，需要 ?key=<REPORT_KEY>

// 注入点固定为 `</head>` 前的一个 <script>：**不碰页面里的任何内容**。
// 尤其不能动 <meta name="page-version">：js/net.js 的「旧页面自检」只比对这个 meta，动了会让玩家被误判成旧版页面。
const INJECT = '<script src="/_pt.js" defer></script>';

// 注入的脚本：累加「标签页在前台可见」的墙钟时间，每 60 秒 + 切到后台 / 离开页面时各上报一次。
// 与游戏同源 ⇒ 可以直接读游戏自己的本地存档认出玩家（touhou2.player.v1 的昵称，见 js/home.js），
// 这就是「不改游戏代码也能按人统计」的关键。所有可能抛错的地方都吞掉：统计失败绝不影响游戏。
const SCRIPT = `(function () {
  try {
    var NICK_KEY = "touhou2.player.v1"; // 游戏自己的玩家资料（只读，别写）
    var ID_KEY = "touhou2.stats.v1"; // 统计自己的随机 ID（新键，不碰游戏的三个键）
    var GAP = 600000; // 单次间隔超过 10 分钟（休眠 / 断网）不计这一段：那不是「在线」
    var id = "";
    try { id = localStorage.getItem(ID_KEY) || ""; } catch (e) {}
    if (!id) {
      id = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem(ID_KEY, id); } catch (e) {}
    }
    function nick() {
      try {
        var p = JSON.parse(localStorage.getItem(NICK_KEY) || "{}");
        return (p && p.name) || "";
      } catch (e) { return ""; }
    }
    var acc = 0, last = document.visibilityState === "visible" ? Date.now() : 0;
    function tick() {
      if (!last) return; // 后台状态：不计时
      var now = Date.now(), d = now - last;
      last = now;
      if (d > 0 && d < GAP) acc += d;
    }
    function send() {
      tick();
      if (acc < 1000) return; // 不足 1 秒不值得发一次请求
      var sec = Math.round(acc / 1000);
      acc = 0;
      try { navigator.sendBeacon("/_pt", JSON.stringify({ id: id, name: nick(), sec: sec })); } catch (e) {}
    }
    setInterval(send, 60000);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") { last = Date.now(); } else { send(); last = 0; }
    });
    window.addEventListener("pagehide", send);
  } catch (e) {}
})();
`;

// 看板样式：单文件直出、零依赖；浅绿配色跟游戏首页保持一致，窄屏只留「名次 / 玩家 / 时长」三列。
const REPORT_CSS = `
*{box-sizing:border-box}
body{margin:0;padding:20px 16px 40px;background:#f4f7ee;color:#23301f;
  font:15px/1.65 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:880px;margin:0 auto}
h1{margin:0 0 4px;font-size:22px;letter-spacing:.5px}
h1 span{font-size:13px;font-weight:400;color:#6b7a63;margin-left:8px}
.note{margin:0;color:#6b7a63;font-size:12.5px}
nav{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0 0}
nav a{padding:4px 12px;border-radius:999px;background:#fff;border:1px solid #dbe4d2;color:#3c4a36;
  text-decoration:none;font-size:13px}
nav a.on{background:#7fb069;border-color:#7fb069;color:#fff}
nav .br{width:1px;height:18px;background:#dbe4d2;margin:0 3px;align-self:center}
.totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0 22px}
.card{background:#fff;border:1px solid #e3eade;border-radius:12px;padding:11px 14px;box-shadow:0 1px 2px #23301f0d}
.card .k{font-size:12px;color:#6b7a63}
.card .v{font-size:19px;font-weight:600;margin-top:2px}
section{background:#fff;border:1px solid #e3eade;border-radius:14px;box-shadow:0 2px 6px #23301f0f;
  overflow:hidden;margin:0 0 18px}
section>h2{margin:0;padding:11px 16px;font-size:15px;background:#eef4e7;border-bottom:1px solid #e3eade}
section>h2 em{font-style:normal;font-weight:400;color:#6b7a63;font-size:12.5px;margin-left:8px}
.row{display:grid;grid-template-columns:34px 1fr 100px 52px 52px;gap:10px;align-items:center;
  padding:9px 16px;border-top:1px solid #f1f4ee}
.row.head{border-top:0;background:#fafcf7;color:#8b9a82;font-size:12px;padding:6px 16px}
.rk{color:#96a48d;text-align:right;font-variant-numeric:tabular-nums}
.rk.top{color:#c9821f;font-weight:700}
.who{min-width:0}
.who b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar{display:block;height:6px;border-radius:99px;background:#eef2e9;margin-top:5px;overflow:hidden}
.bar i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,#a8d18a,#6fa84f)}
.dur{text-align:right;font-weight:600;font-variant-numeric:tabular-nums}
.dim{text-align:right;color:#8b9a82;font-size:12.5px;font-variant-numeric:tabular-nums}
.empty{padding:30px 20px;background:#fff;border:1px dashed #cfdac5;border-radius:14px;text-align:center;color:#6b7a63}
/* 折叠开关：勾上才显示「不足 N 分钟」的那些记录（默认折叠）——纯 CSS 切换，页面不重新请求 */
.fold{display:flex;align-items:center;gap:7px;margin:0 0 14px;font-size:12.5px;color:#6b7a63;cursor:pointer;user-select:none}
.fold input{width:15px;height:15px;margin:0;accent-color:#7fb069;cursor:pointer}
.fold b{color:#3c4a36;font-weight:600}
.row.short{display:none}
body.show-short .row.short{display:grid}
section.all-short{display:none}
body.show-short section.all-short{display:block}
footer{margin-top:22px;color:#96a48d;font-size:12px}
@media(max-width:560px){
  body{padding:16px 10px 32px}
  h1{font-size:19px}
  .row{grid-template-columns:26px 1fr 78px;padding:9px 12px}
  .row .dim{display:none}
}
`;

// 看板的两条查询（都归一到 {day, label, sec, devices, last}）。
// 关键：**没填昵称的按本机 ID 区分**——否则两个人都没填就会并成同一条「（未填昵称）」。
// 默认「按昵称」＝同名合并成一行（换设备也算同一个人）；「按设备」＝每台设备一行，同名不同设备能拆开看。
const SQL_BY_NAME = `SELECT day,
       CASE WHEN name = '' THEN '（未填昵称） ' || substr(pid, -4) ELSE name END AS label,
       SUM(seconds) AS sec, COUNT(DISTINCT pid) AS devices, MAX(last_seen) AS last
  FROM playtime GROUP BY day, label ORDER BY day DESC, sec DESC LIMIT 5000`;

const SQL_BY_DEVICE = `SELECT day,
       CASE WHEN name = '' THEN '（未填昵称） ' || substr(pid, -4)
            ELSE name || ' · ' || substr(pid, -4) END AS label,
       seconds AS sec, 1 AS devices, last_seen AS last
  FROM playtime ORDER BY day DESC, sec DESC LIMIT 5000`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === SCRIPT_PATH) return script();
    if (url.pathname === BEACON_PATH) return beacon(request, env);
    if (url.pathname === REPORT_PATH) return report(url, env);

    return passthrough(request);
  },
};

// 回源 Pages：只对 HTML 注入，其余（js / css / 卡图）原样透传。
async function passthrough(request) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host"); // 让 fetch 按目标地址自己定 Host

  // HTML 一律不带条件请求头：带了的话老玩家会命中 304，浏览器直接用**缓存里那份没注入的旧 HTML**
  // ——他会一直统计不到（本站点每次发布才换 ETag，两次发布之间一直如此）。代价只是多传一次 ~62KB 的 HTML。
  if (url.pathname === "/" || url.pathname.endsWith(".html")) {
    headers.delete("if-none-match");
    headers.delete("if-modified-since");
  }

  const init = { method: request.method, headers, redirect: "manual" };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

  const response = await fetch(ORIGIN + url.pathname + url.search, init);
  const type = response.headers.get("content-type") || "";
  if (!type.includes("text/html")) return response;

  try {
    return new HTMLRewriter()
      .on("head", { element: (el) => el.append(INJECT, { html: true }) })
      .transform(response);
  } catch {
    return response; // 改写失败也不能挡住页面：宁可没有统计，也不能让玩家打不开游戏
  }
}

function script() {
  return new Response(SCRIPT, {
    headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache" },
  });
}

// 收一次心跳：按 (day, pid) 累加秒数。单次上报封顶 1 小时（防伪造 / 防异常数据）。
async function beacon(request, env) {
  if (request.method !== "POST") return new Response(null, { status: 405 });

  let data = null;
  try {
    data = await request.json();
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object") return new Response(null, { status: 204 });

  const seconds = Math.min(Math.round(Number(data.sec) || 0), 3600);
  if (seconds < 1) return new Response(null, { status: 204 });

  const pid = String(data.id || "").slice(0, 64) || "unknown";
  const name = String(data.name || "").trim().slice(0, 24); // 没填昵称就存空串：看板靠 pid 区分，别在这里统一成一个占位文本
  const now = Date.now();
  const day = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10); // 按 UTC+8 切天

  try {
    await env.DB.prepare(
      `INSERT INTO playtime (day, pid, name, seconds, first_seen, last_seen)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(day, pid) DO UPDATE SET
         seconds = seconds + excluded.seconds,
         name = excluded.name,
         last_seen = excluded.last_seen`
    )
      .bind(day, pid, name, seconds, now)
      .run();
  } catch {
    // 写库失败最多丢这一分钟（客户端上报后即清空本地累计），不影响「每天玩了多久」的判断
  }

  return new Response(null, { status: 204 });
}

// 看板：按「天 × 昵称」列出时长；只认 ?key=<REPORT_KEY>（用 wrangler secret put REPORT_KEY 配，别写进仓库）。
async function report(url, env) {
  const key = env.REPORT_KEY || "";
  if (!key || url.searchParams.get("key") !== key) {
    return text(403, "需要 key：/_pt-report?key=<REPORT_KEY>（REPORT_KEY 用 npx.cmd wrangler secret put REPORT_KEY 配置）\n");
  }
  if (!env.DB) return text(500, "没有绑定 D1（检查 wrangler.toml 的 d1_databases 与 database_id）\n");

  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "14", 10) || 14, 1), 90);
  const by = url.searchParams.get("by") === "device" ? "device" : "name";
  // 折叠阈值（分钟）：一个人在这个区间里的**合计**时长不足它就默认折叠（`?min=0` 全展开；默认 10）
  const rawMin = url.searchParams.get("min");
  const min = rawMin === null ? 10 : Math.min(Math.max(parseInt(rawMin, 10) || 0, 0), 600);
  const thr = min * 60;

  let rows = [];
  try {
    const result = await env.DB.prepare(by === "device" ? SQL_BY_DEVICE : SQL_BY_NAME).all();
    rows = result.results || [];
  } catch (e) {
    return text(500, "查询失败：" + e.message + "\n");
  }

  const byDay = new Map();
  for (const row of rows) {
    if (!byDay.has(row.day)) byDay.set(row.day, []);
    byDay.get(row.day).push(row);
  }
  const shown = [...byDay.keys()].sort().reverse().slice(0, days);

  // 折叠判据用「这个人在所选区间里的合计时长」，不是单日 —— 真人偶尔只玩三分钟的那天不该被藏起来；
  // 顺手记进每一行的 title，鼠标悬停就能看出它为什么被折叠
  const windowTotal = new Map();
  for (const day of shown) {
    for (const row of byDay.get(day)) windowTotal.set(row.label, (windowTotal.get(row.label) || 0) + row.sec);
  }
  const windowSec = (label) => windowTotal.get(label) || 0;

  let total = 0;
  for (const day of shown) for (const row of byDay.get(day)) total += row.sec;

  // 人数按 label 去重：按昵称时＝同名合并，按设备时＝每台设备算一个
  const labels = new Set();
  for (const day of shown) for (const row of byDay.get(day)) labels.add(row.label);
  const unit = by === "device" ? "台" : "人";

  const keyParam = encodeURIComponent(url.searchParams.get("key") || "");
  const nav =
    ["name", "device"]
      .map((mode) => {
        const text = mode === "name" ? "按昵称" : "按设备";
        return `<a class="${by === mode ? "on" : ""}" href="/_pt-report?key=${keyParam}&by=${mode}&days=${days}&min=${min}">${text}</a>`;
      })
      .join("") +
    `<span class="br"></span>` +
    [7, 14, 30, 90]
      .map((n) => `<a class="${n === days ? "on" : ""}" href="/_pt-report?key=${keyParam}&by=${by}&days=${n}&min=${min}">近 ${n} 天</a>`)
      .join("");

  let body = "";
  let shortRows = 0; // 被折叠的行数
  let shortDays = 0; // 整张卡都被折叠的天数（那天所有人都没到阈值）
  for (const day of shown) {
    const list = byDay.get(day);
    const dayTotal = list.reduce((sum, r) => sum + r.sec, 0);
    const devices = list.reduce((sum, r) => sum + r.devices, 0);
    const max = Math.max(...list.map((r) => r.sec), 1);
    const shortCount = list.filter((r) => windowSec(r.label) < thr).length;
    const allShort = thr > 0 && shortCount === list.length;
    shortRows += shortCount;
    if (allShort) shortDays++;

    body +=
      `<section${allShort ? ' class="all-short"' : ""}><h2>${day}<em>${week(day)} · ${list.length} ${unit} · 合计 ${human(dayTotal)} · ` +
      `人均 ${human(dayTotal / list.length)} · 设备 ${devices}${allShort ? " · 不足 " + min + " 分钟" : ""}</em></h2>` +
      `<div class="row head"><span class="rk">#</span><span>${by === "device" ? "设备" : "玩家"}</span><span class="dur">时长</span>` +
      `<span class="dim">设备</span><span class="dim">最近</span></div>`;

    list.forEach((r, i) => {
      const width = Math.max(2, Math.round((r.sec / max) * 100));
      const short = thr > 0 && windowSec(r.label) < thr;
      body +=
        `<div class="row${short ? " short" : ""}"><span class="rk${i === 0 ? " top" : ""}">${i + 1}</span>` +
        `<span class="who"><b title="${esc(r.label)}">${esc(r.label)}</b><span class="bar"><i style="width:${width}%"></i></span></span>` +
        `<span class="dur" title="近 ${shown.length} 天合计 ${human(windowSec(r.label))}">${human(r.sec)}</span>` +
        `<span class="dim">${r.devices}</span><span class="dim">${clock(r.last)}</span></div>`;
    });
    body += "</section>";
  }

  // 折叠开关（纯前端：勾一下切 body 上的类，不重新请求）。全部都在阈值以上时不出现
  const fold = shortRows
    ? `<label class="fold"><input type="checkbox" id="showShort" />显示不足 ${min} 分钟的记录` +
      `<b>${shortRows} 条${shortDays ? ` / ${shortDays} 天` : ""}</b></label>`
    : "";
  if (!shown.length) {
    body =
      `<div class="empty">还没有数据。<br />把游戏页开着待一会儿（心跳每 60 秒一次，` +
      `切到别的标签页会立刻补报一条），再刷新这里。</div>`;
  }

  return html(
    `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8" />` +
      `<meta name="viewport" content="width=device-width, initial-scale=1" />` +
      `<title>东方逆转 · 在线时长</title><style>${REPORT_CSS}</style></head><body><div class="wrap">` +
      `<h1>东方逆转 · 在线时长<span>每天每人待了多久</span></h1>` +
      `<p class="note">口径：标签页在前台可见的墙钟时间（调卡组 / 打 AI / 联机全都算，挂机也算）；按 UTC+8 切天；` +
      `身份＝本机昵称，<b>没填昵称的按本机随机 ID 区分</b>；「按昵称」同名算一个人，「按设备」每台设备各算一行；` +
      `区间内<b>合计不足 ${min} 分钟</b>的默认折叠（只影响列表，上方汇总仍是全部数据）。</p>` +
      `<nav>${nav}</nav>` +
      fold +
      `<div class="totals">${card("统计天数", `${shown.length} 天`)}${card(by === "device" ? "参与设备" : "参与玩家", `${labels.size} ${unit}`)}` +
      `${card("合计时长", human(total))}${card("日均时长", human(total / Math.max(shown.length, 1)))}</div>` +
      body +
      `<footer>数据来自 D1「touhou-stats」· 口径与部署见 analytics/README.md</footer>` +
      `</div>` +
      // 折叠开关只切一个类，不重新请求
      `<script>(function(){var c=document.getElementById("showShort");if(!c)return;` +
      `c.addEventListener("change",function(){document.body.classList.toggle("show-short",c.checked);});})();</script>` +
      `</body></html>`
  );
}

function human(sec) {
  const min = Math.round(sec / 60);
  if (min < 1) return sec > 0 ? "不到 1 分" : "0 分";
  const hour = Math.floor(min / 60);
  return hour ? `${hour} 小时 ${min % 60} 分` : `${min} 分`;
}

// 2026-09-13 → 周日（星期是日期自带的，按 UTC 解析这个日期串即可）
function week(day) {
  return "周" + "日一二三四五六"[new Date(day + "T00:00:00Z").getUTCDay()];
}

function card(key, value) {
  return `<div class="card"><div class="k">${key}</div><div class="v">${value}</div></div>`;
}

function clock(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(11, 16);
}

// 昵称是玩家自己填的，进 HTML 前必须转义
function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function text(status, body) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function html(body) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}
