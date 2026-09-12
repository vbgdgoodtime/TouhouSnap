/* =========================================================
   东方逆转 · 区域（场地）数据
   =========================================================
   ▍结构
     POOL  = 随机地形池：每局按 pick 权重不放回抽 3 块互不相同的地形（池中种类不足 3 时才可能重复）
     EXTRA = 非随机地形，不参与开局抽选、只供按 id 引用：
             unreveal 未揭示（每局开局三列的占位态，第 1/2/3 回合依次揭晓）、
             shattered 已破碎（天界摧毁后的占位态：max 0 / wt 0 / 不能放牌 / 不计分）
     新增地形：往 POOL 追加一条即可，无需改 game.js。id 不要写 'hidden'（全局 .hidden 会隐藏整列）。
   ▍基本字段
     id / n / icon = 内部标识（决定该列配色 class）/ 区域名 / 列头与中间带的小图标
     eff  = 中间带显示的效果文字（地形在游戏内唯一的展示文案）
     wt   = 赢得该区计入的区域数权重（当前都为 1）
     dbl  = 终局结算时该区双方总战力的倍率（1 = 不变，2 = ×2）
     max  = 每方在该区最多可放的卡数；pick = 抽取权重（缺省 1）
   ▍效果字段（完整口径见 docs/现有地形.md；「已翻开」＝暗牌不算）
     aff { group, add } 本区属该阵营的卡常驻 +add（实时）
     cb  { c, add }     本区印刷费用恰为 c 的卡常驻 +add
     all N              本区所有卡（双方，含 token）常驻 +N（可为负）
     fill N             某方在本区放满 max 张时，该方总战力额外 +N（不足 max 张立即不生效）
     inv true           反转区：本区总战力更低的一方获胜
     minTurn N          第 N 回合起双方才能在本区放牌（此前锁定）
     spawn { card | cost, n, reveal? }  本区「出现时」双方各生成 n 张，走 placeToken（落地即翻开、
                        占格位、进放置队列）：card = SPECIAL 键名；cost = 从 POOL[该费用] 每张独立
                        随机抽人物卡；reveal: true 时生成后立即结算这些卡自身的揭示（缺省不结算）
     prot true          本区双方所有卡都不会被摧毁（随地形存亡，被换掉即失效）
     noDown true        本区双方所有卡都不会被减攻（一切负战力增量在生效前被拦下）
     mute true          本区双方所有卡失去卡牌文字（卡面效果一律不发动；实时判定，卡离开本区即恢复）
     purge true         每回合结束摧毁本区「双方混比」战力最低的卡（并列最低一并摧毁）
     decay N / grow N   每回合结束本区双方已翻开卡永久 −N / +N（只作用于结算那一刻已翻开的卡）
     gamble N           在本区被翻开的卡永久随机 ±N（各半；结算点在该卡自身揭示之前）
     dice { turn, n }   第 turn 回合结束时，本区所有卡各自随机 ±n（一次性；含当时在场的旧卡与 token）
     rally { turn, add } 第 turn 回合结束时，本区双方已翻开卡永久 +add
     gust true          在本区被翻开的卡：自身揭示结算完之后「若可能」移到随机另一个区域
     gap N              每回合结束时双方各从后往前多封 N 格（该侧已放满则本次不加；换地形即清空）
     collapse { cards, to } 每回合结束时若本区双方总卡牌数 ≥ cards，则本区地形整体换成 to
     xformTurn { turn } 第 turn 回合开始时，本区地形整体换成地形池里随机另一个地形（只会变一次）
     shatter true       本区「出现时」摧毁另外两块地形连同其上的所有卡；被摧毁的列永久变「已破碎」
     extraRound N       本地形在场时本局总回合数为 6+N（上限 7；进入第 7 回合后锁定不再退回）
     repeatReveal true  在本区翻开的揭示牌，其揭示效果再重复结算一次（仅揭示，不含持续与时机效果）
   ▍时机
     「出现时」（spawn / shatter）＝ 地形揭晓、卡牌 xform 变形、xformTurn 定时变形、collapse 崩塌、
     开发者「指定地形」这五条路径；这五条路径换地形时都会重置该列的隙间与已封格数。
     每回合翻牌结算后的回合结束顺序：先地形类（grow / decay → dice → rally → purge → collapse → gap），
     再场上「回合结束」卡牌效果，最后手牌回合结束挂点。
   ========================================================= */
window.DS_LOCATIONS = {
  POOL: [
    { id: 'plain',  n: '无名之丘', icon: '⛰️', wt: 1, dbl: 1, max: 4, eff: '无特殊效果' },
    { id: 'mansion', n: '红魔馆',   icon: '🏰', wt: 1, dbl: 1, max: 4, aff: { group: 'scarlet', add: 2 }, eff: '此区域的「红魔馆」角色 威力 +2' },
    { id: 'slot2',  n: '迷途竹林', icon: '🎋', wt: 1, dbl: 1, max: 2, eff: '双方在此区域最多各放 2 张牌' },
    { id: 'rainbow', n: '虹龙洞', icon: '🕳️', wt: 1, dbl: 1, max: 4, eff: '区域出现时：双方各生成 1 张「石块」', spawn: { card: 'stone', n: 1 } },
    { id: 'cucumber', n: '黄瓜田', icon: '🥒', wt: 1, dbl: 1, max: 4, eff: '区域出现时：双方各生成 1 张「河童」', spawn: { card: 'kappa', n: 1 } },
    { id: 'dragon',  n: '龙神像', icon: '🐉', wt: 1, dbl: 1, max: 4, fill: 5, eff: '放满 4 张的一方：本区战力额外 +5' },
    { id: 'lake',    n: '雾之湖', icon: '🌅', wt: 1, dbl: 1, max: 4, cb: { c: 1, add: 2 }, eff: '此区域所有 1 费卡牌 威力 +2' },
    { id: 'needle',  n: '辉针城', icon: '🏯', wt: 1, dbl: 1, max: 4, inv: true, pick: 0.28, eff: '本区域战力更低的一方获胜' },
    { id: 'tanabata', n: '七夕坂', icon: '🌠', wt: 1, dbl: 1, max: 4, minTurn: 5, eff: '第 5 回合起双方才能在此放牌' },
    { id: 'underworld', n: '冥界', icon: '🪦', wt: 1, dbl: 1, max: 4, all: -2, eff: '此区域所有卡牌 威力 -2' },
    { id: 'reactor', n: '聚变反应炉', icon: '🔥', wt: 1, dbl: 1, max: 4, purge: true, eff: '每回合结束：摧毁本区全场战力最低的牌' },
    { id: 'geyser',  n: '间歇泉', icon: '♨️', wt: 1, dbl: 1, max: 4, decay: 1, eff: '每回合结束：此区域双方所有已翻开卡牌 威力 -1' },
    { id: 'terakoya', n: '寺子屋', icon: '🏫', wt: 1, dbl: 1, max: 4, grow: 1, eff: '每回合结束：此区域双方所有已翻开卡牌 威力 +1' },
    { id: 'komakusa', n: '驹草赌场', icon: '🎰', wt: 1, dbl: 1, max: 4, gamble: 1, eff: '在此区域翻开的卡牌：永久随机 +1 或 -1 战力' },
    { id: 'dicetable', n: '骰子赌桌', icon: '🎲', wt: 1, dbl: 1, max: 4, dice: { turn: 4, n: 1 }, eff: '第 4 回合结束：此区域所有卡牌各自随机永久 +1 或 -1 战力' },
    { id: 'ghostmansion', n: '幽灵洋馆', icon: '🏚️', wt: 1, dbl: 1, max: 4, spawn: { card: 'ghost', n: 1 }, eff: '区域出现时：双方各生成 1 张「幽灵」' },
    { id: 'concert', n: '演唱会', icon: '🎤', wt: 1, dbl: 1, max: 4, rally: { turn: 5, add: 2 }, eff: '第 5 回合结束：此区域双方所有已翻开卡牌 威力 +2' },
    { id: 'magicstorm', n: '魔力风暴', icon: '🌪️', wt: 1, dbl: 1, max: 4, gust: true, eff: '在此区域翻开的卡牌：揭示效果结算后，若可能就移动到另一个随机区域' },
    { id: 'barrier', n: '幽明结界', icon: '⛩️', wt: 1, dbl: 1, max: 4, collapse: { cards: 6, to: 'underworld' }, eff: '每回合结束：若此区域双方总卡牌数 ≥ 6，则本区域变成「冥界」' },
    { id: 'dormouse', n: '睡鼠神祠', icon: '🐭', wt: 1, dbl: 1, max: 4, prot: true, eff: '此区域双方卡牌都不会被摧毁' },
    { id: 'fairyshrine', n: '妖精神社', icon: '🏮', wt: 1, dbl: 1, max: 4, spawn: { cost: 1, n: 1, reveal: true }, eff: '区域出现时：双方各生成 1 张随机 1 费卡牌' },
    { id: 'sealingclub', n: '秘封俱乐部', icon: '📿', wt: 1, dbl: 1, max: 4, xformTurn: { turn: 5 }, eff: '第 5 回合开始时：本区域变成随机另一个地形' },
    { id: 'yukarihouse', n: '八云紫的家', icon: '🌌', wt: 1, dbl: 1, max: 4, gap: 1, eff: '回合结束时：双方各从后往前添加 1 张「隙间」' },
    { id: 'houraipharmacy', n: '蓬莱药局', icon: '💊', wt: 1, dbl: 1, max: 4, noDown: true, eff: '此区域双方所有卡牌都不会被减攻' },
    { id: 'calmsea', n: '静海', icon: '🌊', wt: 1, dbl: 1, max: 4, mute: true, eff: '此区域双方所有卡牌失去卡牌文字' },
    { id: 'falsemoon', n: '虚假之月', icon: '🌕', wt: 1, dbl: 1, max: 4, pick: 1, extraRound: 1, eff: '此地形在场时：本局共有第 7 回合' },
    // pick 0.28（与辉针城同款稀有度）：避免“一局只剩一个可用区”这种剧变机制太常见。
    { id: 'heaven', n: '天界', icon: '☁️', wt: 1, dbl: 1, max: 4, pick: 0.28, shatter: true, eff: '出现时：摧毁另外两块地形，此后只剩本区域可用' },
    // 只重复「在本区被翻开」的牌：落场 token、复活卡与“已翻开后才被移入本区”的卡都不参与；
    // 含法术（重复点排在法术消散之前）；重复那一次不再递归加倍。
    { id: 'moriyashrine', n: '守矢神社', icon: '🌾', wt: 1, dbl: 1, max: 4, pick: 1, repeatReveal: true, eff: '在此区域翻开的揭示牌：其揭示效果再重复触发一次' },
  ],

  /* ---- 非随机地形（EXTRA）----
     不进 POOL ⇒ 开局抽 3 块时绝不会抽到，也不会成为 xformTurn / collapse 的目标（两者只从 POOL 取候选）。 */
  EXTRA: {
    unreveal: { id: 'unreveal', n: '未揭示', icon: '❓', wt: 1, dbl: 1, max: 4, eff: '未揭示地形' },

    // max 0 ⇒ 两侧一格不剩（不能放牌/移动/落场生成/复活）；wt 0 ⇒ 不计入赢下的区域数；
    // 外观由渲染层整列替换成损坏面板（看不出原地形、没有点数与格位）。
    shattered: { id: 'shattered', n: '已破碎', icon: '💥', wt: 0, dbl: 1, max: 0, eff: '此区域已被摧毁：不能放牌、不计分' },
  },
};
