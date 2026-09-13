# 访问时长统计（Cloudflare Workers + D1）

统计**每个玩家每天在站点上待了多久**，游戏代码一行都不改。

做法：在 `game.2houvv.xyz` 的路由前面加一层 Worker，往站点 HTML 的 `</head>` 前插一段脚本；
脚本与游戏**同源**，所以能直接读游戏自己的本地存档认出玩家（`touhou2.player.v1` 的昵称，见 `js/home.js`），
按前台可见时间每 60 秒上报一次增量，Worker 累加进 D1。看板是 `/_pt-report?key=<REPORT_KEY>`。

## 口径

- **时长**＝标签页在前台可见的墙钟时间：主页、卡组设置、图鉴、设置、AI 对战、联机对战全都算，**挂机也算**。
  切到后台 / 锁屏停止计时，回到前台继续。
- **切天**按 **UTC+8**（Worker 算好写进 `day`）。
- **身份**＝本机昵称（玩家在「设置 → 玩家资料」里填的那个）；**没填昵称的按本机随机 ID 区分**（显示成「（未填昵称） a3f9」），所以两个人都不填也不会并成一条。
  本机随机 ID 存在 `localStorage: touhou2.stats.v1`（新键，不碰游戏那三个键），也用来数设备。
- **不计**：单次间隔超过 10 分钟的那一段（休眠 / 断网，脚本里的 `GAP`）。想连休眠也算就调大它。
- 上报内容只有：随机 ID、昵称、本段秒数、时间戳。不存 IP，不碰卡组与对局。

## 部署

```bash
cd analytics
npx.cmd wrangler d1 create touhou-stats        # 把输出的 database_id 填进 wrangler.toml
npx.cmd wrangler d1 execute touhou-stats --file=schema.sql --remote
npx.cmd wrangler secret put REPORT_KEY         # 自己挑一串随机字符，看板要用它
npx.cmd wrangler deploy
```

路由写在 `wrangler.toml` 里（`game.2houvv.xyz/*`），跟着这次 deploy 一起生效，控制台不用点。

⚠️ `d1 create` 提示里那份 `binding = "touhou_stats"` 别照抄：`wrangler.toml` 里的 binding 必须是 `DB`（代码读的是 `env.DB`），名字对不上时心跳会**静默**写不进库。

## 线上现状

- Worker `touhou-stats` + 路由 `game.2houvv.xyz/*`（`/ws/*` 更具体，仍归 `worker/` 的房间 Worker）；D1 `touhou-stats`（区域 WNAM，`database_id` 见 `wrangler.toml`）。
- 看板：`https://game.2houvv.xyz/_pt-report?key=<REPORT_KEY>`（`&days=7|14|30|90` 切时间窗，`&by=name|device` 切「按昵称 / 按设备」，`&min=<分钟>` 改折叠阈值 —— 默认 10，页面上也能点）。顶部是汇总卡片，每天一张卡（星期几 / 人数 / 合计 / 人均 / 设备），每行＝一个人的当天时长，带时长条、设备数与最近在线时间；窄屏自动收成「名次 / 玩家 / 时长」三列。
  **折叠**：所选区间内**合计**时长不足 `min` 分钟的人，其记录默认折叠（判据是区间合计、不是单日 —— 真人偶尔只玩三分钟的那天不该被藏起来），整天都在阈值以下时那张日卡也一起折叠；勾页面上的「显示不足 N 分钟的记录」即展开（纯前端切类，不重新请求），`&min=0` 则全部展开、不再出现勾选框。汇总卡片始终按**全部**数据算。
- 改完 `cd analytics && npx.cmd wrangler deploy`；想临时关掉统计＝把 `[[routes]]` 注释掉再 deploy。

## 验证（部署后自己过一遍）

1. 注入成功：`curl.exe -s https://game.2houvv.xyz/ | findstr _pt` → 应看到 `<script src="/_pt.js" defer></script>`。
2. 心跳：打开 `https://game.2houvv.xyz/`，DevTools 的 Network 里每 60 秒一条 `/_pt`（204）；切到别的标签页应停止，切回来继续。
3. 看板：`https://game.2houvv.xyz/_pt-report?key=<REPORT_KEY>` → 应看到自己的当天时长。
4. **联机回归**（最重要）：`curl.exe -s -o NUL -w "%{http_code}" https://game.2houvv.xyz/ws/ZZA123` 仍是 **426**，并实际开一局联机 —— `/ws/*` 比 `/*` 更具体，仍走 `worker/` 那个 Worker。
5. 游戏本身照旧：主页 / 对局 / 卡组页正常，点「🌐 联机对战」**不应**弹"旧页面，请下拉刷新"（说明没破坏 `page-version` 自检）。

想临时关掉统计：把 `wrangler.toml` 里的 `[[routes]]` 段注释掉，重新 deploy 即可（页面随即恢复成完全不经过 Worker）。

## 额度（免费计划，十几人 ~ 一百人都远远够）

心跳 1 次/分钟 ⇒ **每分钟在线 ≈ 1 个请求 + 1 行写入**：

| 项目 | 免费额度 | 这个用法的消耗 |
| --- | --- | --- |
| Workers 请求 | 10 万 / 天 | 每分钟在线 1 次（外加每次打开页面 1 次 HTML；卡图/脚本也被这条路由带着走，但浏览器有 `immutable` 缓存，量很小） |
| D1 写入行 | 约 10 万行 / 天 | 同上，每分钟在线 1 行 |
| D1 读取 / 存储 | 500 万行 / 天、5 GB | 看板偶尔查一次；一天 100 人也就 100 行 |

⇒ 合计能撑**每天约 1500 人·小时**的在线总量。例：100 人 × 每人 3 小时 = 300 人·小时 = 约 20% 额度；十几个人连 5% 都用不到。

超额的后果与兜底：Worker 超当日额度会返回 **1027 / 429**，**连游戏页面一起打不开**（这就是唯一的风险点）。
兜底很简单：注释掉 `[[routes]]` 再 deploy，站点立刻恢复；`/ws/*` 是另一个 Worker，联机自始至终不受影响。

## 坑

- **回源必须打 `touhousnap.pages.dev`**，不能 `fetch(request)`（官方明确写「Routes cannot be the target of a same-zone fetch」，回源地址换项目时改 `src/index.js` 顶部的 `ORIGIN`）。
- **覆盖范围只有 `game.2houvv.xyz`**：`touhousnap.pages.dev` 不在这个 zone 里，路由加不上去 ⇒ 发给玩家的链接要发自定义域名，否则那部分人统计不到。
- **注入只加一个 `<script>`**，不能动 `<meta name="page-version">`：`js/net.js` 的「旧页面自检」比对这个 meta，动了会让玩家被误判成旧版页面。
- **HTML 请求会被去掉条件请求头**（`If-None-Match` / `If-Modified-Since`）：不去掉的话，之前来过的玩家会命中 304、用浏览器缓存里那份**没有注入**的旧 HTML，直到站点下次发布（换 ETag）为止都统计不到他。代价只是每次多传一遍 ~62KB 的 HTML。
- **身份是昵称**：两个人填了同一个昵称会被合并成一条（看板切「按设备」就能拆开看）；改昵称会另起一条；**没填昵称的按本机 ID 区分，不会互相合并**；同一台机器开两个窗口会各算一遍（时长翻倍）。
- **数字是下限**：广告拦截插件、无痕窗口、禁用 localStorage 都会少算。
- 站点文案「纯前端演示 · 单机零网络请求」（`index.html`）与 `README.md` 开头那句，在统计上线后不再准确，口径待定。

## 直接查数（Cloudflare 面板 → D1 → touhou-stats → Console）

```sql
-- 今天的榜单
SELECT name, seconds / 60 AS minutes FROM playtime
WHERE day = date('now', '+8 hours') ORDER BY minutes DESC;

-- 近 14 天，每人每天
SELECT day, name, seconds / 60 AS minutes FROM playtime
WHERE day >= date('now', '+8 hours', '-13 days') ORDER BY day DESC, minutes DESC;

-- 只保留 90 天
DELETE FROM playtime WHERE day < date('now', '+8 hours', '-90 days');
```
