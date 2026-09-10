# 东方逆转（Touhou2）

> Marvel Snap 玩法 + 东方 Project 主题的**纯前端卡牌网页 Demo**：无构建工具、无后端、无网络请求。
> 6 回合 / 3 块随机地形 / 双倍下注 / 卡组构筑与本地存档。

## 快速开始

**方式一（最简单）**：直接用浏览器打开 `index.html`。
本项目没有 `fetch`/`XMLHttpRequest`/ES Module，所有脚本都是普通 `<script>`，`file://` 下可直接运行。

**方式二（推荐，本地存储更干净）**：起一个静态服务器再访问。

```bash
python -m http.server 8000        # 然后打开 http://localhost:8000/
# 或 npx serve .
```

首页入口：**开始对战**（先选满 12 张的出战卡组）、**卡组设置**（构筑/保存卡组）、**开发调试**（空牌库 + 固定地形 + 指定卡牌等调试工具）、**⚙️ 设置**（v174：切换对手 AI 强度 —— v175 起四档 **简单（默认）/ 普通 / 困难 / 月狂**，其中「简单」是最初版的贪心 AI；点选即生效并记在本地）；四个主入口**下方**另有 **📖 新手引导**（v172，只读的机制速览弹窗，不进入对局）。

## 目录结构

```
Touhou2/
├─ index.html            入口页面（静态标记 + 按顺序加载脚本）
├─ style.css             全部样式（单文件）
├─ js/                   运行时脚本
│  ├─ game.js            引擎主文件：对局流程、规则结算、渲染（体量最大）
│  ├─ ai.js              对手 AI（v173 重做 / v175 扩为四档：「简单」＝最初版贪心 AI aiThinkLegacy +
│  │                     其余三档＝影子盘面效果估值 mdEvaluate + 回合级束搜索 aiPlanMoves；
│  │                     简单/普通/困难/月狂，默认简单 —— 主页面「⚙️ 设置」或 AI.setLevel() / ?ai= 切换）
│  ├─ card-browser.js    图鉴与「指定卡牌」弹窗
│  ├─ deck-page.js       卡组设置页面（window.DeckBuilder）
│  ├─ deck-storage.js    卡组本地持久化（localStorage: touhou2.decks.v1）
│  ├─ home.js            主页面（window.Home）
│  └─ dev-page.js        开发调试模式（window.DevTools）
├─ data/                 游戏数据（改卡/改地形只动这里）
│  ├─ cards.js           人物卡 POOL + 特殊卡 SPECIAL
│  └─ locations.js       地形池 POOL
├─ assets/
│  ├─ cards/             运行时卡图（ASCII 文件名，被 data/cards.js 的 img 字段引用）
│  └─ source-art/        原始立绘素材（100px Q 版，取图来源，不进页面）
├─ docs/                 全部文档（见下方索引）
├─ tests/
│  └─ smoke-test.js      jsdom 冒烟测试：随机卡组 + 随机打牌 + 不变量校验
├─ package.json          仅用于测试依赖（jsdom）与 npm test
└─ .gitattributes / .gitignore
```

**加载顺序＝依赖顺序**：`data/*.js → js/game.js → js/ai.js → js/card-browser.js → js/home.js → js/deck-storage.js → js/deck-page.js → js/dev-page.js`。
各脚本之间靠全局对象（`window.Game` / `Home` / `DeckBuilder` / `DeckStorage` / `CardBrowser` / `DevTools`）与全局函数互调，**不要调整 `index.html` 里的脚本次序**。

## 运行测试

```bash
npm install          # 首次：安装 jsdom（唯一的开发依赖）
npm test             # 等价于 node tests/smoke-test.js
```

冒烟测试会：用卡组设置页 UI **随机构造 2 套 12 张卡组** → 校验 localStorage 存档 → 从主页面**随机选一套出战** →
**随机打若干局**（随机双倍/移动/暗出多张），逐回合校验能量账目、手牌与盘面渲染、区域总点数与领先着色、
翻牌顺序＝放置顺序、能量重置回归等不变量，最后跑图鉴/放大/认输流程。

```bash
MATCHES=6 DECKS=4 SEED=3 node tests/smoke-test.js   # 加量；SEED 相同即可复现同一次运行
COVERAGE_BIAS=0 node tests/smoke-test.js            # 关掉「优先打没出过的卡」的覆盖率引导
```

失败时退出码非 0，并打印盘面诊断与去重后的问题清单（页面 `console.error`、`window` 报错、jsdomError 也算失败）。

## 文档索引（`docs/`）

| 文档 | 内容 |
| --- | --- |
| `docs/现有机制.md` | **引擎机制的权威口径（v168 起）**：流程管线与阶段挂点、卡牌效果键与时机效果、卡级机制、区域字段总表与各机制口径、数值口径、其它已实装系统 |
| `docs/现有地形.md` | 地形（区域）清单与字段口径 —— 地形改动只写这里 |
| `docs/现有人物卡牌.md` | 人物卡当前清单（费用/威力/效果/配图） —— 人物卡改动只写这里 |
| `docs/现有特殊卡牌.md` | token（石块/厄运/分身/废弃列车/河童/幽灵/隙间）清单 —— 特殊卡改动只写这里 |
| `docs/GAME_REFERENCE.md` | **跨模块总纲**（一局结构 / 牌库与抽牌 / 胜负与赌注）+ **专项文档索引**；§5 只保留历史版本记录的索引（正文已迁至 `docs/历史版本.md`） |
| `docs/历史版本.md` | **历史版本记录（v1 ~ v167 精简版）**：历史变更记录的**唯一存放处**；v168 起新改动只写各专项文档的行内版本标记 |
| `docs/开发规则.md` | 全局开发规则：新卡取图流程（规则 1）、改动只写专项文档（规则 2）、机制术语口径（规则 3）、**数值记法「A-B = A 费 / B 战力」（规则 4）**、验证由用户负责/AI 不自行测试（规则 5）、不确定先问用户（规则 6） |
| `docs/card-image-map.md` | 卡图文件名对照表、素材状态、新增卡配图流程 |

**改动约定**（见 `docs/开发规则.md` 规则 2）：加卡 / 改机制 / 改地形 / 改特殊卡**只更新对应的专项文档**，
`docs/GAME_REFERENCE.md` 不再重复收录这些清单与口径，只维护总纲与索引；历史记录只放 `docs/历史版本.md`
（v168 起不再逐版本追加，留痕走专项文档里的行内版本标记）。
另：用户口述的卡牌数值 **「A-B」= A 费 / B 战力**（规则 4）。

## 已知待办（素材侧）

- `assets/cards/` 中 `rumia.png` / `reimu.png` / `remilia.png` / `sanae.png` 四张对应角色尚未进卡池（保留备用）；
- 6 张「泛用妖怪/妖精」卡、**法术卡「三妖精集结」（v171）** 与 **v172 新增的 5 张法术**（火神之光 / 祖母绿巨石 / 绿色风暴 / 水银之毒 / 金属疲劳，均为 **1 费 · 法术 · 无战力**，属「帕秋莉法术池」，由帕秋莉回合开始抽入手牌）**均无专属配图**（emoji 🌈 / 🔥 / 💚 / 🌿 / 💧 / ⚙️ 兜底）；另有 7 张 token（石块 / 厄运 / 废弃列车 / 河童 / 幽灵 / **v172 的祖母绿巨石 / 水银**；以及渲染层占位「隙间」）同样走 emoji 兜底；
- `assets/source-art/` 还有 9 张立绘（上白泽慧音2 / 八云蓝 / 小恶魔 / 橙 / 爱丽丝 / 莉莉霍瓦特 / 蓬莱山辉夜 / 铃仙 / 露娜萨）对应角色尚无卡；
- 阵营 `light`「光之三妖精」三人已在 1 费池凑齐（桑尼米尔克 / 露娜·切露德 / 斯塔萨菲雅，v169）；但**还没有对应的地形加成**——若日后要加，照红魔馆的 `aff: { group: 'light', add: N }` 写一条地形即可（v171 起的法术「三妖精集结」已用 `gather: { group: 'light', add: 1 }` 引用这个阵营键）；
- 卡图为 100px Q 版缩略图，放大视图偏糊，日后可换 512×512 大图。
