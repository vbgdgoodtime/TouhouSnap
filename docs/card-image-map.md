# assets/cards — 卡牌图片目录与文件名对照表

> 本文件在 `docs/` 下（原名 `assets/cards/README.md`）；**图片本体在 `assets/cards/`**，
> 未加工的立绘素材在 `assets/source-art/`，取图规则见 `docs/开发规则.md` 规则 1。

把卡牌图片放到 `assets/cards/` 后，游戏会自动加载（`data/cards.js` 里每张卡已预配好 `img` 文件名）。
没放图之前，游戏会自动回退显示卡面上的 emoji，不会报错。

## 推荐图片规格

- **尺寸：512×512 像素**（至少 256×256），正方形
- **格式：WebP（质量 90）或 PNG（可带透明背景）**；JPEG 也可以，但透明背景会变白
- 人物主体放在**中央 80% 安全区**内：手牌/图鉴/放大视图按正方形完整显示；
  场上 2×2 缩略卡会做 cover 裁切，边缘最多裁掉约 10%，所以别把脸贴边
- 单张大小建议控制在 100 KB 以内，减少加载负担

## 各显示位置的最终尺寸（参考）

| 位置 | 图片区域 | 说明 |
| --- | --- | --- |
| 场上 2×2 卡位 | 整格铺满（cover） | 会裁切边缘，主体居中 |
| 手牌 | 约 74×74 | 完整正方形 |
| 图鉴 | 约 100×100 | 完整正方形 |
| 点击放大 | 约 240×240 | 完整正方形 |

## 文件名对照表（与 data/cards.js 中的 img 字段一一对应）

| 文件名 | 卡牌 | 费用 |
| --- | --- | --- |
| rumia.png | 露米娅 | 1 |
| cirno.png | 琪露诺 | 1 |
| lunachild.png | 露娜·切露德 | 1 |
| daiyousei.png | 大妖精 | 1 |
| star.png | 斯塔萨菲雅 | 1 |
| meiling.png | 红美铃 | 2 |
| sakuya.png | 十六夜咲夜 | 2 |
| mystia.png | 米斯蒂娅 | 2 |
| patchouli.png | 帕秋莉·诺蕾姬 | 3 |
| reimu.png | 博丽灵梦 | 3 |
| marisa.png | 雾雨魔理沙 | 3 |
| youmu.png | 魂魄妖梦 | 3 |
| medicine.png | 梅蒂欣·梅兰可莉 | 3 |
| remilia.png | 蕾米莉亚·斯卡蕾特 | 4 |
| yukari.png | 八云紫 | 5 |
| yuyuko.png | 西行寺幽幽子 | 4 |
| flandre.png | 芙兰朵露·斯卡蕾特 | 4 |
| sanae.png | 东风谷早苗 | 5 |
| tenshi.png | 比那名居天子 | 3 |
| eirin.png | 八意永琳 | 5 |
| aya.png | 射命丸文 | 5 |
| yuka.png | 风见幽香 | 6 |
| suika.png | 伊吹萃香 | 5 |
| mokou.png | 藤原妹红 | 2 |
| suwako.png | 洩矢诹访子 | 6 |
| seija.png | 鬼人正邪 | 6 |
| hina.png | 键山雏 | 3 |
| okuu.png | 灵乌路空 | 3 |
| hecatia.png | 赫卡提亚 | 6 |
| shion.png | 依神紫苑 | 5 |
| mamizou.png | 二岩猯藏 | 3 |
| tewi.png | 因幡帝 | 2 |
| akyuu.png | 稗田阿求 | 0 |
| letty.png | 蕾蒂 | 2 |
| sunny.png | 桑尼米尔克 | 1 |

> ⚠️ **保留备用（当前未被引用）**：`rumia.png` / `reimu.png` / `remilia.png` / `sanae.png` / `wriggle.png` 五张对应角色（露米娅 / 博丽灵梦 / 蕾米莉亚 / 东风谷早苗 / 莉格露）当前**不在卡池中**，文件先留着备用（**v169：「莉格露」已改名为「露娜·切露德」并换用 `lunachild.png`，`wriggle.png` 转为备用**）。
> 🪄 **v171：法术卡「三妖精集结」（3 费）暂无配图**——它没有对应角色立绘，`assets/source-art/` 里的
> 「桑尼米尔克 / 露娜切露德 / 斯塔萨菲雅」三张立绘已被三张 1 费人物卡占用，**不拿它们顶替**
> （按 `docs/开发规则.md` 规则 1 第 3 条），故本卡走卡面 emoji **🌈** 兜底；日后若提供专属图片，
> 复制到 `assets/cards/`（ASCII 文件名，如 `fairies.png`）并在 `data/cards.js` 该条加 `img: 'fairies.png'` 即可。
> ✅ 红美铃已作为新卡重新实装（2费/3力/mv，红魔馆成员），`meiling.png` 恢复引用。
> ✅ v70 伊吹萃香已作为**新卡重新实装**（5费/12力，大体积占 4 格；**v167 起为 5费/10力**），`suika.png` 恢复引用。

## 当前素材状态（本次目录整理后核对）

`assets/cards/` 现有 **36 张 PNG**，其中 **32 张被 `data/cards.js` 引用**
（覆盖 32 张有图人物卡；`hecatia.png` 由「赫卡提亚」与「赫卡提亚的分身」共用），另有 5 张保留备用（见上）。

- 人物卡 **38 张中 32 张有图**，其余 **7 张**（小妖精 / 小妖怪 / 中妖精 / 中妖怪 / 大妖怪 / 贤者 / **法术「三妖精集结」（v171）**）用卡面 emoji 兜底；
- 🪄 **v172：帕秋莉法术池的 5 张法术**（火神之光 🔥 / 祖母绿巨石 💚 / 绿色风暴 🌿 / 水银之毒 💧 / 金属疲劳 ⚙️，均 1 费 · 法术 · 无战力）**同样无配图**——它们是**法术（衍生物池 `SPECIAL`）**，按 `docs/开发规则.md` 规则 1 第 5 条走卡面 emoji 兜底，**不从 `assets/source-art/` 取图顶替**；日后若提供专属图片，复制到 `assets/cards/`（ASCII 文件名，如 `agni.png`）并在 `data/cards.js` 对应条目加 `img: 'agni.png'` 即可。
- token 中仅「赫卡提亚的分身」有图（共用 `hecatia.png`），石块 / 厄运 / 废弃列车 / 河童 / 幽灵 / **v172 新增的祖母绿巨石（💚）/ 水银（💧）** / 隙间 用 emoji 兜底；
- `assets/source-art/` 另有 **45 张**原始立绘（100px Q 版），其中 **8 张尚未复制**进 `assets/cards/`：
  上白泽慧音2 / 八云蓝 / 小恶魔 / 橙 / 爱丽丝 / 莉莉霍瓦特 / 蓬莱山辉夜 / 铃仙 / 露娜萨（对应角色尚无卡；v169 已取用「桑尼米尔克」「露娜切露德」「斯塔萨菲雅」三张新的 1 费素材）；
- 现有图片均为 100px Q 版立绘缩略图，放大视图会偏糊，建议日后换 512×512 大图。

以下为「文件 → 卡牌」对照（36 张，含 5 张保留备用者）：

| 已就位文件 | 卡牌 | 备注 |
| --- | --- | --- |
| rumia.png | 露米娅 | ⚠️ 角色当前不在卡池，保留备用 |
| cirno.png | 琪露诺 | ⚠️ 素材为「晒黑的琪露诺」变体立绘，非标准版 |
| daiyousei.png | 大妖精 | |
| star.png | 斯塔萨菲雅 | 🔧 v169 新增：素材自 `assets/source-art/100px-斯塔萨菲雅（Q版立绘）.png`（**1 费 / 2 战力**，效果键 `energyNext`，阵营 light 光之三妖精） |
| lunachild.png | 露娜·切露德 | 🔧 v169：素材自 `assets/source-art/100px-露娜切露德（Q版立绘）.png`（原「莉格露」改名而来，配图由 `wriggle.png` 换为本图） |
| wriggle.png | 莉格露 | ⚠️ v169 起角色不在卡池——该卡位已改名为「露娜·切露德」并换用 `lunachild.png`，本图转为保留备用 |
| meiling.png | 红美铃 | |
| sakuya.png | 十六夜咲夜 | |
| mystia.png | 米斯蒂娅 | |
| patchouli.png | 帕秋莉·诺蕾姬 | 🔧 **v172 重做**：原 2 费 / 2 战力（bf +2）→ **3 费 / 2 战力**（回合开始从帕秋莉法术池抽 1 张法术入手牌），配图沿用本图、仅费用档位变更 |
| reimu.png | 博丽灵梦 | ⚠️ 角色当前不在卡池，保留备用 |
| marisa.png | 雾雨魔理沙 | |
| youmu.png | 魂魄妖梦 | |
| medicine.png | 梅蒂欣·梅兰可莉 | |
| remilia.png | 蕾米莉亚·斯卡蕾特 | ⚠️ 角色当前不在卡池，保留备用 |
| yukari.png | 八云紫 | |
| yuyuko.png | 西行寺幽幽子 | |
| flandre.png | 芙兰朵露·斯卡蕾特 | |
| sanae.png | 东风谷早苗 | ⚠️ 角色当前不在卡池，保留备用 |
| tenshi.png | 比那名居天子 | |
| eirin.png | 八意永琳 | |
| aya.png | 射命丸文 | |
| yuka.png | 风见幽香 | |
| suika.png | 伊吹萃香 | |
| mokou.png | 藤原妹红 | |
| suwako.png | 洩矢诹访子 | |
| hina.png | 键山雏 | 🔧 v57 新增：素材自 assets/source-art（100px Q 版立绘） |
| okuu.png | 灵乌路空 | 🔧 v60 新增：素材自 assets/source-art（100px Q 版立绘） |
| hecatia.png | 赫卡提亚 | 🔧 v61 新增：素材自 assets/source-art（100px Q 版立绘）；「赫卡提亚的分身」共用此图 |
| shion.png | 依神紫苑 | 🔧 v63 新增：素材自 assets/source-art（100px Q 版立绘） |
| mamizou.png | 二岩猯藏 | 🔧 v64 新增：素材自 assets/source-art（100px Q 版立绘） |
| tewi.png | 因幡帝 | 🔧 v66 新增：素材自 assets/source-art 的 `100px-因幡天为（Q版立绘）.png`（素材名“因幡天为”，卡牌名为“因幡帝”） |
| akyuu.png | 稗田阿求 | 🔧 v69 新增：素材自 assets/source-art（100px Q 版立绘）；0 费卡不入牌库 |
| letty.png | 蕾蒂 | 🔧 v77 新增：素材自 assets/source-art（100px Q 版立绘） |
| sunny.png | 桑尼米尔克 | 🔧 v169 新增：素材自 `assets/source-art/100px-桑尼米尔克（Q版立绘）.png`（**1 费 / 2 战力**，效果键 `costUp`，阵营 `light` 光之三妖精） |

## 新增卡牌时怎么做

1. 在 `data/cards.js` 对应费用分组里追加一条（复制现有条目改 `n/p/c/k/a/i/t`）；
2. 从 `assets/source-art/` 取图（规则见 `docs/开发规则.md` 规则 1），复制到 `assets/cards/` 并改成 ASCII 文件名；
3. 条目加 `img: 'newgirl.webp'` 即可；不配 `img` 就继续用 emoji。
