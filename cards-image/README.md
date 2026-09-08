# cards-image — 卡牌图片素材目录

把卡牌图片放到本目录后，游戏会自动加载（`data/cards.js` 里每张卡已预配好 `img` 文件名）。
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
| wriggle.png | 莉格露 | 1 |
| daiyousei.png | 大妖精 | 1 |
| meiling.png | 红美铃 | 2 |
| sakuya.png | 十六夜咲夜 | 2 |
| mystia.png | 米斯蒂娅 | 2 |
| patchouli.png | 帕秋莉·诺蕾姬 | 2 |
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
| suika.png | 伊吹萃香 | 6 |
| mokou.png | 藤原妹红 | 6 |
| suwako.png | 洩矢诹访子 | 6 |
| seija.png | 鬼人正邪 | 6 |

> ⚠️ **版本更新（人物更名）**：露米娅 / 博丽灵梦 / 蕾米莉亚 / 东风谷早苗 / 伊吹萃香 已更名（小妖精 / 中妖精 / 中妖怪 / 大妖怪 / 贤者），这些卡 `img` 已清除、**暂时用 emoji 兜底**——对应文件（rumia/reimu/remilia/sanae/suika.png）当前**未被引用**，保留备用。
> ✅ 红美铃已作为新卡重新实装（2费/3力/mv，红魔馆成员），`meiling.png` 恢复引用。

## 当前素材状态（2026-09-08 第三次同步 · 已补齐）

已从 `/图片素材` 复制并改名就位 **24 张 = 全部卡牌**（原图为 100px Q 版立绘缩略图，放大视图会偏糊，建议日后用更大尺寸替换）：

| 已就位文件 | 卡牌 | 备注 |
| --- | --- | --- |
| rumia.png | 露米娅 | |
| cirno.png | 琪露诺 | ⚠️ 素材为「晒黑的琪露诺」变体立绘，非标准版 |
| daiyousei.png | 大妖精 | |
| wriggle.png | 莉格露 | |
| meiling.png | 红美铃 | |
| sakuya.png | 十六夜咲夜 | |
| mystia.png | 米斯蒂娅 | |
| patchouli.png | 帕秋莉·诺蕾姬 | |
| reimu.png | 博丽灵梦 | |
| marisa.png | 雾雨魔理沙 | |
| youmu.png | 魂魄妖梦 | |
| medicine.png | 梅蒂欣·梅兰可莉 | |
| remilia.png | 蕾米莉亚·斯卡蕾特 | |
| yukari.png | 八云紫 | |
| yuyuko.png | 西行寺幽幽子 | |
| flandre.png | 芙兰朵露·斯卡蕾特 | |
| sanae.png | 东风谷早苗 | |
| tenshi.png | 比那名居天子 | |
| eirin.png | 八意永琳 | |
| aya.png | 射命丸文 | |
| yuka.png | 风见幽香 | |
| suika.png | 伊吹萃香 | |
| mokou.png | 藤原妹红 | |
| suwako.png | 洩矢诹访子 | |

✅ **24 张卡全部有图**，游戏里将不再显示 emoji 兜底。

> 素材目录中另有 上白泽慧音2 / 八云蓝 / 因幡天为 / 小恶魔 / 橙 / 爱丽丝 / 莉莉霍瓦特 / 蓬莱山辉夜 / 蕾蒂 / 铃仙 / 露娜萨 等图片，对应角色目前不在本游戏卡池中，未复制。

## 新增卡牌时怎么做

1. 在 `data/cards.js` 对应费用分组里追加一条（复制现有条目改 `n/p/c/k/a/i/t`）；
2. 给自己起个英文文件名（如 `newgirl.webp`）放进本目录；
3. 条目加 `img: 'newgirl.webp'` 即可；不配 `img` 就继续用 emoji。
