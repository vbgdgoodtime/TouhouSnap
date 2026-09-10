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
     spawn= 可选：本区域“出现时”每方生成的卡牌。两种写法：
            ① { card: SPECIAL 键名, n: 张数 }——生成指定特殊卡（如虹龙洞 → 石块、
               幽灵洋馆 → 幽灵）；
            ② { cost: 费用, n: 张数 }——**从 POOL[费用] 随机抽人物卡**生成（v165，妖精神社：
               双方各 1 张随机 1 费卡；**每张独立随机抽取**，故双方可能拿到不同的卡）。
            生成方式统一走 placeToken：**落地即翻开、占格位、进入场上放置顺序队列**；
            是否触发被生成卡的「揭示」效果由 `reveal` 决定：
              · 缺省（不写）= **不触发揭示**（虹龙洞石块/黄瓜田河童/幽灵洋馆幽灵等 token 口径），
                但其持续 `og` / 时机 `fx` / 防摧毁 `surv` 等实时机制照常生效；
              · `reveal: true`（v166，妖精神社）= 生成后**立即结算这些卡自身的揭示效果**
                （如抽到「大妖精」当场给同区双方已翻开卡 +1；按落场顺序、先你方后敌方，
                同步结算无翻牌停顿）；注意像 `dw` 这类摧毁型揭示也会当场生效。
            ⚠️ 结算时机（v74/v151/v150）：该效果在**地形被揭晓时**（locationRevealStage）、
            **区域被「区域变形 xform」变成该地形时**（v151）、以及**开发者「🗻 指定地形」
            替换该列时**（v150，可勾选关闭）结算——即“该地形在本区出现”的三种时机。
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
    decay= 可选：回合结束战力衰减（如间歇泉 decay: 1）——每回合翻牌结算后，本区域
           **双方所有已翻开**的卡牌永久 −N 战力（见 game.js locTurnEndPowerEffects）。
           只作用于结算那一刻已翻开的卡（暗牌不吃、翻面后从下一个回合末起才被衰减）；
           永久生效、可叠加；含落场 token（石块/厄运/分身等）；un 免疫；带 surv/phx 的卡
           照常被减（这不是“摧毁”，不触发任何摧毁相关机制）。
     grow= 可选：回合结束战力成长（如寺子屋 grow: 1）——decay 的正向镜像：每回合翻牌
           结算后，本区域**双方所有已翻开**的卡牌永久 +N 战力（见 game.js
           locTurnEndPowerEffects，与 decay 共用同一套口径与结算点）。同样只作用于已翻开
           的卡、永久可叠加、含落场 token、un 免疫；这不是“增益揭示”，与 bf/ba 等
           一次性揭示无关，也不触发任何摧毁类机制。
     gamble= 可选：翻开时博彩（如驹草赌场 gamble: 1）——**在该区域翻开的卡牌**（暗牌
            翻面那一刻）**永久随机 +N 或 −N 战力**（各 50%），见 game.js
             runLocRevealEffects。结算点在翻牌流程内、该卡自身揭示效果**之前**
             （故 bl/oc 等按博彩后的威力判定）；只作用于“在本区被翻开”的卡——落地即
             翻开的落场 token（石块/厄运/分身等）与已翻开后被移入本区的卡不参与，
             地形出现前就已翻开的旧卡不追溯；双方一视同仁；永久生效（走 applyPermBuff：
             ±N 演出 + 战力影响历史按来源记录地形名）；被摧毁回手后再打出会重新博彩。
     dice= 可选：定时掷骰 { turn, n }（如骰子赌桌 dice: { turn: 4, n: 1 }）——在
           **第 turn 回合的回合结束时**（阶段 ⑤-0 地形回合结束效果内，先于场上
           「回合结束」卡牌效果），把本区域**所有卡牌**（双方，含落地即翻开的落场
           token）**各自**随机永久 +n 或 −n 战力（各 50%），见 game.js locDiceEffects。
           与 gamble 的区别：gamble 是“卡牌在本区被翻开时”逐张博彩、每张都会轮到；
           dice 只在指定的那一个回合末结算一次，且作用于**当时在本区的所有卡**
           （含此前就已翻开的旧卡、也含 token），一次性结算完就不再触发。
     rally= 可选：定时加成 { turn, add }（如演唱会 rally: { turn: 5, add: 2 }）——在
            **第 turn 回合结束时**（阶段 ⑤-0，先于场上「回合结束」卡牌效果），把本区域
            **双方所有已翻开卡牌**永久 +add 战力（add 可为负），见 game.js
            locRallyEffects。与 dice（定时掷骰）同类“定时一次性”机制，区别：rally 是
            **固定值**、dice 是**每张卡各自随机 ±n**；与 grow（每回合成长）的区别：
            grow 每个回合末都触发、rally 只在指定的那一个回合末触发一次。
     gust= 可选：揭示后吹飞（如魔力风暴 gust: true）——**在该区域翻开的卡牌**（走翻牌流程
           的那张暗牌）在**自身揭示效果结算完之后**「若可能」就移动到另外一个随机区域，
           见 game.js runLocAfterRevealEffects（移动核心与 roam 共用）。与 gamble 的区别：
           gamble 在翻面瞬间、自身揭示效果**之前**结算（会改 bl/oc 等判定），gust 在自身
           揭示效果**之后**结算（不改本次揭示结果）；只作用于“本回合在该区被翻开”的卡——
           已翻开的旧卡、落地即翻开的 token、被移入本区的卡都不受影响，地形出现前的旧卡
           不追溯；若自身效果已把该卡挪出本区（如八云紫 shift）则不再吹。
     collapse= 可选：回合结束崩塌 { cards, to }（如幽明结界 collapse: { cards: 6,
           to: 'underworld' }）——每回合翻牌结算后（阶段 ⑤-0 地形回合结束效果的**最后**
           一步）检查：若本区域**双方总卡牌数** ≥ `cards`（按“张数”计，大体积卡也算 1 张、
           暗牌与 token 都算），则把本区域地形**整体换成 `to` 指定的地形**（如冥界），
           见 game.js locCollapseEffects。口径与 xform 对齐（v151）：变形＝该地形在本区
           “出现”，换上后立刻结算目标地形的「出现时」效果（无 spawn 时为空操作）；
           已放卡不移动、不增删；换掉后本区不再带 collapse 字段，故只会崩塌一次；
           崩塌后的新地形**从下一回合起**按其规则参与（同一回合不再触发新地形的回合结束类效果）。
     prot= 可选：区域免摧毁（如睡鼠神祠 prot: true）——本区域**双方所有卡牌**都不会被
           摧毁：针对本区域的任何“摧毁”指向（卡牌 `dw`/`dwh`、地形 `purge` 等）一律失效，
           既不选目标，也不会触发防摧毁 `surv` / 凤凰重生 `phx`；保护含双方人物卡与
           落场 token、也含本区所有后续落下的卡。见 game.js locNoDestroy（与卡级 prot
           「蕾蒂」同一判定入口：地形带 prot 恒为真，随地形存亡——被 `xform`/`collapse`
           换掉后立即失效）。非“摧毁”类效果（增减/移动/换边等）照常生效。
   ⚠️ 回合结束结算顺序（v153）：每回合翻牌结算后**先结算地形类效果**
           （grow 成长 / decay 衰减 / dice 掷骰 / rally 定时加成 → purge 摧毁 →
           collapse 崩塌，见 game.js runLocTurnEndEffects），**再结算场上「回合结束」
           卡牌效果**（卡牌 def.fx.turnEnd，见 runTurnEndEffects），最后是手牌回合结束
           挂点（runHandEndEffects）。
   每局会从该池中按 pick 权重不放回抽 3 块互不相同的区域（池中种类不足 3 时才可能出现重复）。
   新增场地：直接向下方数组追加一条即可，无需改 game.js。
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
    { id: 'reactor', n: '聚变反应炉', icon: '🔥', wt: 1, dbl: 1, max: 4, purge: true, eff: '每回合结束：摧毁本区全场战力最低的牌（并列全删）' },
    { id: 'geyser',  n: '间歇泉', icon: '♨️', wt: 1, dbl: 1, max: 4, decay: 1, eff: '每回合结束：此区域双方所有已翻开卡牌 威力 -1（永久）' },
    { id: 'terakoya', n: '寺子屋', icon: '🏫', wt: 1, dbl: 1, max: 4, grow: 1, eff: '每回合结束：此区域双方所有已翻开卡牌 威力 +1（永久）' },
    { id: 'komakusa', n: '驹草赌场', icon: '🎰', wt: 1, dbl: 1, max: 4, gamble: 1, eff: '在此区域翻开的卡牌：永久随机 +1 或 -1 战力（各半）' },
    { id: 'dicetable', n: '骰子赌桌', icon: '🎲', wt: 1, dbl: 1, max: 4, dice: { turn: 4, n: 1 }, eff: '第 4 回合结束：此区域所有卡牌各自随机永久 +1 或 -1 战力' },
    { id: 'ghostmansion', n: '幽灵洋馆', icon: '🏚️', wt: 1, dbl: 1, max: 4, spawn: { card: 'ghost', n: 1 }, eff: '区域出现时：双方各生成 1 张「幽灵」' },
    { id: 'concert', n: '演唱会', icon: '🎤', wt: 1, dbl: 1, max: 4, rally: { turn: 5, add: 2 }, eff: '第 5 回合结束：此区域双方所有已翻开卡牌 威力 +2（永久）' },
    { id: 'magicstorm', n: '魔力风暴', icon: '🌪️', wt: 1, dbl: 1, max: 4, gust: true, eff: '在此区域翻开的卡牌：揭示效果结算后，若可能就移动到另一个随机区域' },
    { id: 'barrier', n: '幽明结界', icon: '⛩️', wt: 1, dbl: 1, max: 4, collapse: { cards: 6, to: 'underworld' }, eff: '每回合结束：若此区域双方总卡牌数 ≥ 6，则本区域变成「冥界」' },
    { id: 'dormouse', n: '睡鼠神祠', icon: '🐭', wt: 1, dbl: 1, max: 4, prot: true, eff: '此区域双方卡牌都不会被摧毁' },
    { id: 'fairyshrine', n: '妖精神社', icon: '🏮', wt: 1, dbl: 1, max: 4, spawn: { cost: 1, n: 1, reveal: true }, eff: '区域出现时：双方各生成 1 张随机 1 费卡牌（并结算其揭示）' },
  ],

  /* ---- 非随机地形（EXTRA）----
     不放进 POOL → 绝不会被每局开局的三区随机抽选抽到；仅作为“可按 id 引用的地形”存在。
     现仅「未揭示」：v74 起作为**每局开局三列的初始未揭示态**，由地形揭晓系统
     （game.js locationRevealStage）在第 1/2/3 回合开始时依次揭晓为真实地形。
     样式 = 基础面板（与「无名之丘」同款）。 */
  EXTRA: {
    // 未揭示：max 4 / 无特殊效果 / 样式与无名之丘相同 / 效果文案（中间带备注）显示「未揭示地形」。
    // ⚠️ id 不要用 'hidden'——全局 UI 有 .hidden{display:none} 类，列 class 直接取 def.id 会整列隐藏。
    unreveal: { id: 'unreveal', n: '未揭示', icon: '❓', wt: 1, dbl: 1, max: 4, eff: '未揭示地形' },
  },
};
