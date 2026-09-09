/* =========================================================
   东方逆转 · 区域（场地）数据（从 game.js 拆出，便于扩展）
   =========================================================
   字段说明：
     id   = 内部标识（决定配色 class，如 double/slot2）
     n    = 区域名（中文显示名）
     icon = 顶部/中间带显示的小图标
     wt   = 赢得该区域计入的区域数权重（当前统一为 1）
     dbl  = 终局结算时该区双方总战力的倍率（1=不变, 2=×2）
     max  = 每方在该区域最多可放的卡数（4 或 2）
     eff  = 效果说明文字
     spawn= 可选：本区域“出现时”每方生成的卡牌 { card: SPECIAL 键名, n: 张数 }，
           生成的特殊卡牌落地即翻开、占用格位（如虹龙洞的「石块」）。
     aff = 可选：区域-阵营加成 { group: GROUPS 键名, add: 威力 }，
           给位于本区域、所属该阵营的卡牌常驻加威力（实时生效，见 game.js 的
           locRoleBonus/cardPowerIn；如红魔馆对 scarlet 阵营 +2）。
     fill= 可选：某一方在本区放满 max 张（实际卡数，含暗牌）时，该方总战力
           额外 +N（常驻实时判定；因摧毁/撤回导致不足 max 张则立即不生效）。
     cb  = 可选：费用加成 { c: 费用, add: 威力 }，位于本区域、费用恰为该值的
           卡牌（双方，含特殊卡）威力 +N（常驻实时，见 game.js locCostBonus）。
     inv = 可选：true 表示“反转区域”——本区域总战力更低的一方获胜。
           比较口径按负值参与（区域胜负/领先判定/总点数决胜/AI，见 game.js zoneEff）。
     minTurn= 可选：本区域到第 minTurn 回合起双方才可放牌（之前为锁定，
           见 game.js locOpen；如七夕坂 minTurn: 5）。
     all = 可选：区域全体修正（可为负，如冥界 -2）——本区域所有卡牌
           （双方、特殊卡）威力 +N（常驻实时，见 game.js locAllBonus）。
     purge= 可选：true 表示回合结束摧毁——每回合翻牌结算后，摧毁本区域
           “全场”（敌我混比）战力最低的卡牌，并列最低一并摧毁（见 game.js reactorPurge）。
   每局会从该池中按 pick 权重不放回抽 3 块互不相同的区域（池中种类不足 3 时才可能出现重复）。
   新增场地：直接向下方数组追加一条即可，无需改 game.js。
   ========================================================= */
window.DS_LOCATIONS = {
  POOL: [
    { id: 'plain',  n: '无名之丘', icon: '⛰️', wt: 1, dbl: 1, max: 4, eff: '无特殊效果' },
    { id: 'mansion', n: '红魔馆',   icon: '🏰', wt: 1, dbl: 1, max: 4, aff: { group: 'scarlet', add: 2 }, eff: '此区域的「红魔馆」角色 威力 +2' },
    { id: 'slot2',  n: '迷途竹林', icon: '🎋', wt: 1, dbl: 1, max: 2, eff: '双方在此区域最多各放 2 张牌' },
    { id: 'rainbow', n: '虹龙洞', icon: '🕳️', wt: 1, dbl: 1, max: 4, eff: '区域出现时：双方各生成 1 张「石块」', spawn: { card: 'stone', n: 1 } },
    { id: 'dragon',  n: '龙神像', icon: '🐉', wt: 1, dbl: 1, max: 4, fill: 5, eff: '放满 4 张的一方：本区战力额外 +5' },
    { id: 'lake',    n: '雾之湖', icon: '🌅', wt: 1, dbl: 1, max: 4, cb: { c: 1, add: 2 }, eff: '此区域所有 1 费卡牌 威力 +2' },
    { id: 'needle',  n: '辉针城', icon: '🏯', wt: 1, dbl: 1, max: 4, inv: true, pick: 0.28, eff: '本区域战力更低的一方获胜' },
    { id: 'tanabata', n: '七夕坂', icon: '🌠', wt: 1, dbl: 1, max: 4, minTurn: 5, eff: '第 5 回合起双方才能在此放牌' },
    { id: 'underworld', n: '冥界', icon: '🪦', wt: 1, dbl: 1, max: 4, all: -2, eff: '此区域所有卡牌 威力 -2' },
    { id: 'reactor', n: '聚变反应炉', icon: '🔥', wt: 1, dbl: 1, max: 4, purge: true, eff: '每回合结束：摧毁本区全场战力最低的牌（并列全删）' },
  ],
};
