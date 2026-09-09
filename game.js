/* =========================================================
   东方逆转 · 极简演示 —— Marvel Snap 玩法 · 东方 Project 换皮
   3 区域 / 6 回合 / 能量预算多张出牌 / 暗牌翻面 /
   揭示效果 / 区域特效 / 双倍下注(snap) / 认输 / 重置暗牌
   流程阶段管线：游戏开始 → 每回合(回合开始效果/能量抽牌/放置移动/
   翻牌揭示结算/全场回合结束/区域回合末/手牌回合末) → 游戏结束效果 → 结算胜负
   （v54 拆分显式阶段 / v55 加入场上放置顺序队列 + fx 时机效果；详见 playRound 上方注释）
   ========================================================= */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 基础数据 ----------------
   卡牌与区域数据已拆到独立文件（data/cards.js / data/locations.js），
   在 index.html 中必须先于 game.js 加载。 */
const GRADS = {
  1: 'linear-gradient(150deg,#2e5f96,#7cc0ff)',
  2: 'linear-gradient(150deg,#2a7350,#5fdd9f)',
  3: 'linear-gradient(150deg,#8a6220,#f2c14e)',
  4: 'linear-gradient(150deg,#5b3a94,#c79bff)',
  5: 'linear-gradient(150deg,#8e2f5e,#ff9ac7)',
  6: 'linear-gradient(150deg,#a02f22,#ff9066)',
};
const BACK_GRAD = 'linear-gradient(160deg,#2b314a,#151929)';

const POOL = (window.DS_CARDS && window.DS_CARDS.POOL) || {};
const KIND_LABEL = (window.DS_CARDS && window.DS_CARDS.KIND_LABEL) || {};
const TOKENS = (window.DS_CARDS && window.DS_CARDS.SPECIAL) || {};
const GROUPS = (window.DS_CARDS && window.DS_CARDS.GROUPS) || {};
const LOCATION_POOL = (window.DS_LOCATIONS && window.DS_LOCATIONS.POOL) || [];

// 卡面渐变：有自定义 cg（如特殊卡牌「石块」的土黄色）则优先，否则按费用档位取色
const gradOf = (def) => (def && def.cg) || GRADS[def.c];

const DECK_CURVE = [1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6, 6];
// 兜底抽牌顺序：费用平滑，保证前几回合有牌可打
const FALLBACK_DRAW = [1, 2, 1, 3, 1, 2, 4, 2, 3, 5, 6, 6];

// 抽牌顺序是否“开局友好”：前 3 抽必有 1 费，前 4 抽至少 2 张 ≤2 费
function goodOpen(seq) {
  const is1 = (v) => v === 1;
  const cheap = (v) => v <= 2;
  return (is1(seq[0]) || is1(seq[1]) || is1(seq[2]))
    && (cheap(seq[0]) + cheap(seq[1]) + cheap(seq[2]) + cheap(seq[3]) >= 2);
}

/* ---------------- 工具 ---------------- */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function uid() { return (state.cardSeq++); }
function cardPower(card) { return card.def.p + card.buff; }
// 区域-阵营加成：区域 aff 给“所属该阵营（card.def.g）”的卡牌加固定威力。
// 属于常驻实时加成：该卡在此区域的任何实时读取（卡面/总数/摧毁/落后判定/图鉴放大）都计入。
function locRoleBonus(locIdx, card) {
  const aff = locDef(locIdx).aff;
  if (!aff || !card || card.def.un) return 0;
  return card.def.g === aff.group ? aff.add : 0;
}
// 区域-费用加成：区域 cb={c,add} 给位于本区域、费用恰为该值的卡牌加威力
// （如雾之湖对 1 费卡牌 +2；双方卡与特殊卡都算）。
function locCostBonus(locIdx, card) {
  const cb = locDef(locIdx).cb;
  if (!cb || !card || card.def.un) return 0;
  return card.def.c === cb.c ? cb.add : 0;
}
// 区域-全体修正：区域 all=N（可为负，如冥界 -2）给本区域所有卡牌（双方、特殊卡）加 N 威力
function locAllBonus(locIdx, card) {
  if (!card || card.def.un) return 0;
  return locDef(locIdx).all || 0;
}
// 持续效果（og，原「在场光环」，如比那名居天子）：该卡已翻开且仍在己方某区时，
// 己方所有带匹配 tk 标记的卡牌（如己方石块）常驻 +N。动态读取：源卡被摧毁即消失。
function cardAuraBonus(card) {
  if (!card || !card.def.tk || !card.side) return 0;
  let b = 0;
  for (let j = 0; j < 3; j++) {
    for (const c of state.players[card.side].zones[j]) {
      if (c.revealed && !c.def.un && c.def.og && c.def.og.tk === card.def.tk) b += c.def.og.add;
    }
  }
  return b;
}
// 卡牌在指定区域的实时战力 = 基础威力 + 永久增益 + 区域加成（阵营/费用/全区）+ 持续效果
function cardPowerIn(locIdx, card) {
  return cardPower(card) + locRoleBonus(locIdx, card) + locCostBonus(locIdx, card) + locAllBonus(locIdx, card) + cardAuraBonus(card);
}
// ---- 占格（occ）口径：普通卡占 1 格；大体积卡（如伊吹萃香 occ:4）占满多格 ----
// 出牌/生成/移动/放满等所有“还能放几张”的判定统一走这里，避免只用 zone.length 误判。
function occOf(card) { return (card && card.def && card.def.occ) || 1; }
function sideUsed(side, locIdx) { return state.players[side].zones[locIdx].reduce((s, c) => s + occOf(c), 0); }
function sideRoom(side, locIdx) { return locDef(locIdx).max - sideUsed(side, locIdx); }
// 大体积卡只允许放入“上限恰为其占格数”的区域（如 occ4 只能进 max=4）
function occZoneOk(card, locIdx) { return occOf(card) <= 1 || locDef(locIdx).max === occOf(card); }
// 放满加成：区域 fill=N 时，某一方在本区实际占满 max 格（含大体积卡，如 4/4）则该方
// 总战力额外 +N；因摧毁/撤回等原因不足 max 格时立即不生效（4→3 不加）。
function zoneFillBonus(side, locIdx) {
  const def = locDef(locIdx);
  if (!def.fill) return 0;
  return sideUsed(side, locIdx) >= def.max ? def.fill : 0;
}
// 区域总点数：默认只统计“已翻开的牌”（暗牌不计入，翻面后才计入）；includeHidden=true 供 AI 估值。
function zoneTotals(side, locIdx, includeHidden) {
  return state.players[side].zones[locIdx].reduce(
    (s, c) => (includeHidden || c.revealed ? s + cardPowerIn(locIdx, c) : s),
    0
  ) + zoneFillBonus(side, locIdx);
}
// 区域“有效战力”（比较口径）：总点数 × dbl 后，若是反转区域（inv，如辉针城）
// 则取负值 —— 实际战力更低的一方在比较中反而更大（= 低者胜）。
function zoneEff(side, locIdx, includeHidden) {
  const t = zoneTotals(side, locIdx, includeHidden) * locDef(locIdx).dbl;
  return locDef(locIdx).inv ? -t : t;
}
// 区域对放牌是否“开放”：带 minTurn 的区域（如七夕坂第 5 回合起）在到达前双方都不能放牌
function locOpen(locIdx) {
  const mt = locDef(locIdx).minTurn;
  return !mt || state.turn >= mt;
}
function locDef(locIdx) { return state.locs[locIdx].def; }

/* ---------------- 状态 ---------------- */
const state = {
  gen: 0,
  cardSeq: 0,
  turn: 1,
  energyTotal: 1,
  energyLeft: 1,
  phase: 'idle',       // idle | play | busy | over
  stakes: 1,
  pSnapped: false,
  aSnapped: false,
  locs: [],
  players: {
    p: { key: 'p', name: '你', zones: [[], [], []], deck: [], hand: [] },
    a: { key: 'a', name: '对手', zones: [[], [], []], deck: [], hand: [] },
  },
  selected: -1,        // 手牌下标
  playerMoves: [],     // 本回合玩家已暗出的牌 [{cardId, loc}]
  aiMoves: [],         // 本回合对手已暗出的牌
  fieldQueue: [],      // 场上放置顺序队列：双方卡牌按“放入场上”先后记录（v55），供回合开始/结束/终局按序结算
  playHandOrder: [],   // 本回合开始时玩家手牌 id 顺序（供重置暗牌时恢复）
  moveCardId: null,    // “每回合可移动一次”的牌：当前正在选目标区域的卡 id
  flyMoved: new Set(), // 本回合已自移过的卡 id（如射命丸文）
  flyMovedFrom: {},    // 本回合自移过的卡：卡 id → 回合初所在区域下标（供重置）
  logCount: 0,
};

let pendingResolve = null;
let pickDef = null; // 开发者“指定卡牌”弹窗当前选中（人物卡 def 或 null）

/* ---------------- 流程主循环 ---------------- */
function restart() {
  state.gen++;
  const gen = state.gen;

  state.cardSeq = 0;
  state.turn = 1;
  state.phase = 'idle';
  state.stakes = 1;
  state.pSnapped = false;
  state.aSnapped = false;
  state.selected = -1;
  state.playerMoves = [];
  state.aiMoves = [];
  state.fieldQueue = []; // 场上放置顺序队列（v55）
  state.playHandOrder = [];
  state.players.p.zones = [[], [], []]; state.players.p.hand = [];
  state.players.a.zones = [[], [], []]; state.players.a.hand = [];

  // 造牌库：费用曲线随机 + 起手友好保证（同费用内不重复）
  state.players.p.deck = buildDeckCards();
  state.players.a.deck = buildDeckCards();

  // 初始手牌各 3 张
  for (let i = 0; i < 3; i++) drawOne('p');
  for (let i = 0; i < 3; i++) drawOne('a');

  // 选 3 块区域：按抽选权重（pick，默认 1）不放回抽 3 块，保证互不相同；
  // 辉针城 pick 0.28 → 每局出现率约 10%（约 10 局 1 次）。
  // 区域池不足 3 种时退回旧逻辑（允许重复、仅避免三块完全相同）作兜底。
  let picks;
  if (LOCATION_POOL.length >= 3) {
    picks = [];
    const remain = LOCATION_POOL.slice();
    while (picks.length < 3 && remain.length > 0) {
      let total = 0;
      for (const d of remain) total += d.pick || 1;
      if (!(total > 0)) break;
      let r = Math.random() * total;
      let idx = 0;
      for (let i = 0; i < remain.length; i++) {
        const w = remain[i].pick || 1;
        if (r < w) { idx = i; break; }
        r -= w;
      }
      picks.push(remain.splice(idx, 1)[0]);
    }
  } else {
    picks = [];
    while (picks.length < 3) {
      const def = LOCATION_POOL[Math.floor(Math.random() * LOCATION_POOL.length)];
      if (picks.length === 2 && picks[0] === def && picks[1] === def) continue;
      picks.push(def);
    }
  }
  state.locs = picks.map((def) => ({ def }));
  state.moveCardId = null;
  state.flyMoved = new Set();
  state.flyMovedFrom = {};

  // DOM 骨架
  buildBoard();
  hideModal();
  $('undoMask').classList.add('hidden');
  clearLog();
  log('sys', '新对局开始！区域已揭晓，先手暗牌后统一翻面。');
  // 区域“出现时”效果（如虹龙洞）：立即给双方生成特殊卡牌，落地即翻开、占用格位。
  // 生成卡不在 playerMoves/aiMoves 中，不会参与回合翻牌流程；会被增益/削弱/摧毁等正常影响。
  state.locs.forEach((loc, locIdx) => {
    const sp = loc.def.spawn;
    if (!sp) return;
    const def = TOKENS[sp.card];
    if (!def) return;
    const cnt = sp.n || 1;
    for (const side of ['p', 'a']) {
      placeToken(side, locIdx, def, cnt);
    }
    log('sys', `${loc.def.icon}「${loc.def.n}」出现：双方各生成 ${cnt} 张「${def.n}」，已落场翻开。`);
  });
  runGameStartEffects(); // ⓪ 游戏开始效果挂点（现无注册效果）：第 1 回合开始前执行
  renderAll();
  playRound(gen);
}

function buildDeckCards() {
  // 每种费用的卡牌随机分配（同费用内不重复）
  const buckets = {};
  for (const c of [1, 2, 3, 4, 5, 6]) buckets[c] = shuffle(POOL[c].slice());
  // 反复洗费用序列，直到满足「开局友好」；极限次数后使用平滑兜底序列
  let draw = null;
  for (let t = 0; t < 300 && !draw; t++) {
    const seq = shuffle(DECK_CURVE.slice());
    if (goodOpen(seq)) draw = seq;
  }
  if (!draw) draw = FALLBACK_DRAW.slice();
  // 按抽牌顺序生成卡牌；drawOne() 从队尾取牌，因此反转存储
  const inDrawOrder = draw.map((c) => {
    const def = buckets[c].pop();
    return newCard(def || POOL[c][0]);
  });
  inDrawOrder.reverse();
  return inDrawOrder;
}

function newCard(defProto) {
  const def = { ...defProto };
  // powerLog：战力影响历史台账（v56）——记录该卡受到的“永久 buff”来源明细，
  // 由效果结算写入（bf/de/ba/bl/oc 等）；区域加成/持续效果为实时派生，不进台账。
  return { id: uid(), def, buff: 0, powerLog: [], revealed: false, justRevealed: false };
}

function drawOne(side) {
  const pl = state.players[side];
  if (pl.deck.length === 0 || pl.hand.length >= 7) return null;
  const card = pl.deck.pop();
  card.side = side; // 记属方：供“持续效果”等按己方判定
  pl.hand.push(card);
  return card;
}

// 把特殊卡落到某方某区：落地即翻开、占用格位、记录属方；放满则放不下
function placeToken(side, locIdx, tkDef, cnt) {
  let placed = 0;
  const zone = state.players[side].zones[locIdx];
  for (let i = 0; i < cnt; i++) {
    if (sideRoom(side, locIdx) < 1) break; // 按占格口径（大体积卡占满时无法再落）
    const card = newCard(tkDef);
    card.side = side;
    card.revealed = true;
    zone.push(card);
    enqueueField(card); // 落场 token：按落场先后进入放置队列（v55）
    placed++;
  }
  return placed;
}

/* ========================================================
   流程阶段管线（v54→v55：主循环按显式阶段执行；v55 加入
   “场上放置顺序队列”，供时机类效果按双方放置先后结算）：
   游戏开始 restart：建牌库 → 发初始手牌 → 抽选 3 区域 → 区域“出现时”生成
     → runGameStartEffects（⓪ 开局效果挂点，现空）→ 第 1 回合
   每回合 playRound 依次：
     ① roundStart：runTurnStartEffects（全场“回合开始”效果，按放置队列序结算）
                   → 能量结算 + 抽牌（回合 2+，第 1 回合的 3 张已在开局发放）
                   → 清空回合临时状态
     ② 玩家放置与移动（waitPlayer：出牌 / 移动 / 重置 / 双倍 / 认输均在此阶段）
     ③ 对手放置（aiThink）
     ④ revealRound：翻开暗牌，逐张按放置顺序结算「揭示」效果
     ⑤ runTurnEndEffects：全场“回合结束”效果（按放置队列序结算）
     ⑥ runZoneEndEffects：区域回合结束效果（现：purge 型，如聚变反应炉）
     ⑦ runHandEndEffects：手牌回合结束效果（挂点，现空）
   第 6 回合 ⑤⑥⑦ 之后：
     ⑧ runGameEndEffects：全场“游戏结束”效果（按放置队列序）→ finishMatch 结算胜负
   注：①⑤⑧ 结算的都是“带时机效果 fx 的场上卡牌”，先后顺序 = 场上放置顺序队列
       （双方卡牌放入场上的先后，谁先放谁先结算）；新机制的数值/盘面修改写进对应
       阶段函数；与暗牌口径、重置(undo)、AI 估值的交互规则随该机制一并定义。
   ======================================================== */

// fx 时机键：卡牌 def 可用 fx = { turnStart?, turnEnd?, gameEnd? } 声明“回合开始 /
// 回合结束 / 游戏结束”时触发的效果；每个条目与揭示 def 同构（k/a/spawn/xf/give/t）。

// ---- 场上放置顺序队列（v55）----
// 记录双方卡牌“放入场上”的先后（含开局/效果生成的落场特殊卡，如石块），供时机类
// 效果（回合开始/回合结束/游戏结束）按“谁先放谁先结算”遍历。
// 入队：手牌打出（玩家/AI）、placeToken 落场；出队：被摧毁、重置暗牌撤回手牌。
// 移动（mv / fly）只是换区域，不改变放置顺序。
function enqueueField(card) { state.fieldQueue.push(card); }
function dequeueField(card) {
  const i = state.fieldQueue.indexOf(card);
  if (i >= 0) state.fieldQueue.splice(i, 1);
}
// 场上某张卡当前所在区域下标（按其属方查）；不在场上返回 -1（防御）
function fieldLocOf(card) {
  const pl = state.players[card.side];
  if (!pl) return -1;
  for (let j = 0; j < 3; j++) if (pl.zones[j].indexOf(card) >= 0) return j;
  return -1;
}
// 按放置队列先后，结算全场卡牌在指定时机的 fx 效果（只有带该时机效果的卡才触发）
function resolveTimedEffects(timing) {
  for (const card of state.fieldQueue.slice()) { // 快照：结算中可能增删卡（spawn/摧毁）
    const fx = card.def.fx && card.def.fx[timing];
    if (!fx || !fx.k) continue;
    const locIdx = fieldLocOf(card);
    if (locIdx < 0) continue; // 防御：已不在场上
    applyEffect(card.side, locIdx, card, fx);
  }
}

// 阶段挂点 ⓪：游戏开始效果 —— restart 完成建库/发牌/选区/区域生成后、第 1 回合前执行（现无注册效果）
function runGameStartEffects() {}

// 阶段 ①-a：全场“回合开始”效果 —— 每回合最先执行（先于能量结算与抽牌），
// 按场上放置顺序队列先后结算各卡 def.fx.turnStart（现无卡注册该时机效果）
function runTurnStartEffects() {
  resolveTimedEffects('turnStart');
}

// 阶段 ⑤：全场“回合结束”效果 —— 每回合翻牌结算后执行，
// 按场上放置顺序队列先后结算各卡 def.fx.turnEnd（现无卡注册该时机效果）
function runTurnEndEffects() {
  resolveTimedEffects('turnEnd');
}

// 阶段 ⑥：区域回合结束效果 —— 每回合翻牌结算后执行（含第 6 回合、终局结算前）。
// 现仅「purge」型区域（聚变反应炉，见 reactorPurge）；后续新机制在此追加。
function runZoneEndEffects() {
  reactorPurge();
}

// 阶段 ⑦：手牌回合结束效果 —— 区域回合末之后执行（现无注册效果）
function runHandEndEffects() {}

// 阶段 ⑧：全场“游戏结束”效果 —— 第 6 回合所有阶段结束后、结算胜负前执行：
// 1) 按场上放置顺序队列先后结算各卡 def.fx.gameEnd；
// 2) 带 leave 的卡（如稗田阿求）终局离场：从场上消失（非摧毁，不触发摧毁类机制、
//    增益随卡一并消失），不再计入终局结算。
function runGameEndEffects() {
  resolveTimedEffects('gameEnd');
  for (const card of state.fieldQueue.slice()) {
    if (!card.def.leave) continue;
    const locIdx = fieldLocOf(card);
    if (locIdx < 0) continue;
    const zone = state.players[card.side].zones[locIdx];
    const i = zone.indexOf(card);
    if (i >= 0) zone.splice(i, 1);
    dequeueField(card);
    log('sys', `📖 「${card.def.n}」在游戏结束时从场上消失（增益随之一同消失）。`);
  }
}

// 阶段 ①：回合开始 —— 回合开始效果 → 能量结算 + 抽牌 → 回合状态重置
function roundStartStage() {
  const st = state;
  runTurnStartEffects(); // ①-1 全场“回合开始”效果（按放置队列序）
  if (st.turn > 1) { drawOne('p'); drawOne('a'); } // ①-2 抽牌（第 1 回合的 3 张已在开局发放）
  st.energyTotal = Math.min(st.turn, 6);           // ①-2 能量结算
  st.energyLeft = st.energyTotal;
  st.phase = 'play';
  st.selected = -1;
  st.moveCardId = null;
  st.flyMoved = new Set();
  st.flyMovedFrom = {};
  st.playerMoves = [];
  st.aiMoves = [];
  // 记录本回合开始时的玩家手牌顺序（重置暗牌时按此顺序放回）
  st.playHandOrder = st.players.p.hand.map((c) => c.id);
  renderAll();
  if (st.turn > 1) log('sys', `—— 第 ${st.turn} 回合 · 双方各抓 1 张 ——`);
  setStatus(`第 ${st.turn} 回合 · 能量 ${st.energyTotal}：可一次暗出多张牌（总费用不超过能量），出完点「结束回合」；点能量框可重置本回合暗牌。`);
}

async function playRound(gen) {
  if (gen !== state.gen) return;
  const st = state;
  roundStartStage(); // 阶段 ①：回合开始（回合开始效果 / 能量结算 / 抽牌）

  // 阶段 ②：玩家放置与移动（出牌 / 跳过 / 认输 / 双倍 / 移动 / 重置均在此阶段触发）
  const act = await waitPlayer();
  if (gen !== state.gen) return;
  if (act.type === 'retreat') { doRetreat(); return; }

  // 阶段 ③：对手放置
  state.phase = 'busy';
  renderControls();
  setStatus('对手思考中…');
  await sleep(600);
  if (gen !== state.gen) return;
  aiThink();
  renderAll();
  await sleep(600);
  if (gen !== state.gen) return;

  // 阶段 ④：翻牌结算（翻开暗牌，逐张按放置顺序结算「揭示」效果）
  await revealRound();
  if (gen !== state.gen) return;

  // 阶段 ⑤ 全场“回合结束”效果（按放置队列序）→ 阶段 ⑥ 区域回合结束 → 阶段 ⑦ 手牌回合结束
  runTurnEndEffects();
  runZoneEndEffects();
  runHandEndEffects();
  renderAll();

  if (st.turn >= 6) {
    // 阶段 ⑧：游戏结束效果（按放置队列序）→ 结算胜负（第 6 回合的 ⑤⑥⑦ 同样先于终局执行）
    runGameEndEffects();
    finishMatch();
    return;
  }
  st.turn++;
  playRound(gen);
}

function waitPlayer() {
  return new Promise((r) => { pendingResolve = r; });
}
function resolvePlayer(obj) {
  if (pendingResolve) { const fn = pendingResolve; pendingResolve = null; fn(obj); }
}

/* ---------------- 玩家操作 ---------------- */
function selectHand(index) {
  const st = state;
  if (st.phase !== 'play') return;
  st.moveCardId = null; // 开始选牌即取消“移动牌”模式
  const card = st.players.p.hand[index];
  if (!card) return;
  if (card.def.c > st.energyLeft) { setStatus('剩余能量不足，换一张更便宜的吧。'); return; }
  st.selected = (st.selected === index) ? -1 : index;
  renderAll();
}

// 找出玩家场上的某张卡（按其所在区域）
function findPlayerCard(cardId) {
  const zones = state.players.p.zones;
  for (let j = 0; j < 3; j++) {
    const i = zones[j].findIndex((c) => c.id === cardId);
    if (i >= 0) return { zone: zones[j], j, card: zones[j][i] };
  }
  return null;
}

// 点击“每回合可移动一次”的己方已翻开卡（如射命丸文）：进入/取消选目标
function uiMoveFly(cardId) {
  const st = state;
  if (st.phase !== 'play') return;
  const found = findPlayerCard(cardId);
  if (!found || !found.card.def.fly || !found.card.revealed) return;
  if (st.moveCardId === cardId) {
    st.moveCardId = null;
    setStatus('已取消移动。');
    renderZones();
    return;
  }
  if (st.flyMoved.has(cardId)) { setStatus('这张卡本回合已经移动过一次。'); return; }
  st.moveCardId = cardId;
  setStatus('已选中移动目标：点另一个区域完成移动（每回合一次；再点该卡取消）。');
  renderZones();
}

// 移动模式下点击某区域：把目标卡移过去（未满且已开放；其它情况只提示）
function tryMoveFlyTo(locIdx) {
  const st = state;
  if (st.moveCardId == null) return false;
  const found = findPlayerCard(st.moveCardId);
  if (!found) { st.moveCardId = null; renderZones(); return true; }
  const card = found.card;
  if (st.flyMoved.has(card.id)) { setStatus('这张卡本回合已经移动过一次。'); st.moveCardId = null; renderZones(); return true; }
  if (locIdx === found.j) { setStatus('这张卡本来就在这个区域，选别的区域吧。'); return true; }
  if (!locOpen(locIdx)) { setStatus(`「${locDef(locIdx).n}」还没开放，不能移过去。`); return true; }
  const dz = st.players.p.zones[locIdx];
  if (sideRoom('p', locIdx) < 1) { setStatus('目标区域已放满，不能移过去。'); return true; }
  st.flyMovedFrom[card.id] = found.j; // 记录回合初所在区域，供“能量重置”退回
  found.zone.splice(found.zone.indexOf(card), 1);
  dz.push(card);
  st.flyMoved.add(card.id);
  st.moveCardId = null;
  log('p', `⇄ 「${card.def.n}」移动到了「${st.locs[locIdx].def.n}」（本回合不可再移）。`);
  setStatus(`已把「${card.def.n}」移到「${st.locs[locIdx].def.n}」。`);
  renderAll();
  return true;
}

function tryPlayAt(locIdx) {
  const st = state;
  if (st.phase !== 'play') return false;
  if (st.selected < 0) {
    setStatus('先在下方手牌里选一张卡。');
    return false;
  }
  const card = st.players.p.hand[st.selected];
  if (!card || card.def.c > st.energyLeft) return false;
  const zone = st.players.p.zones[locIdx];
  if (!locOpen(locIdx)) {
    setStatus(`「${locDef(locIdx).n}」还没开放，要到第 ${locDef(locIdx).minTurn} 回合才能放牌。`);
    return false;
  }
  if (occOf(card) > 1 && !occZoneOk(card, locIdx)) {
    setStatus(`「${card.def.n}」需要占满 ${occOf(card)} 格，只能放在最大可放数为 ${occOf(card)} 的区域（且己方该区为空）。`);
    return false;
  }
  if (sideRoom('p', locIdx) < occOf(card)) {
    setStatus('这个区域已经放满，选别的区域吧。');
    return false;
  }
  zone.push(card);
  enqueueField(card); // 暗出：进入场上放置顺序队列（v55）
  st.players.p.hand.splice(st.selected, 1);
  st.selected = -1;
  st.energyLeft -= card.def.c;
  st.playerMoves.push({ cardId: card.id, loc: locIdx });
  log('p', `你暗出「${card.def.n}」(${card.def.c}费) → ${st.locs[locIdx].def.n}`);
  renderAll();
  if (st.energyLeft <= 0) {
    setStatus('能量已用完，点「结束回合」交给对手。');
  } else {
    setStatus(`剩余能量 ${st.energyLeft}：还可以继续出牌，或点「结束回合」。`);
  }
  return true;
}

function uiSnap() {
  const st = state;
  if (st.phase !== 'play' && st.phase !== 'busy') return;
  if (st.stakes >= 8) { setStatus('赌注已达上限 8。'); return; }
  st.stakes = Math.min(8, st.stakes * 2);
  st.pSnapped = true;
  log('snap', `⚡ 你双倍下注！赌注升至 ${st.stakes}`);
  setStatus(`你双倍下注！当前赌注 ${st.stakes}`);
  // 对手随机跟进
  if (!st.aSnapped && st.stakes < 8 && Math.random() < 0.5) {
    st.aSnapped = true;
    st.stakes = Math.min(8, st.stakes * 2);
    log('snap', `⚡ 对手跟进双倍下注！赌注升至 ${st.stakes}`);
    setStatus(`对手跟进双倍！当前赌注 ${st.stakes}`);
  }
  renderAll();
}

// 结束玩家出牌阶段：没出牌=跳过；出过牌=把回合交给对手
function uiEndTurn() {
  const st = state;
  if (st.phase !== 'play') return;
  st.selected = -1;
  st.moveCardId = null; // 结束出牌即取消“移动牌”模式
  if (st.playerMoves.length === 0) {
    log('p', '你选择跳过本回合。');
  } else {
    log('p', `你结束出牌，本回合共暗出 ${st.playerMoves.length} 张。`);
  }
  resolvePlayer({ type: 'end' });
}

/* ---------------- 重置本回合暗牌（点能量框） ---------------- */
function uiEnergyReset() {
  const st = state;
  if (st.phase !== 'play') { setStatus('只有在出牌阶段才能重置暗牌。'); return; }
  if (st.playerMoves.length === 0 && st.flyMoved.size === 0) {
    setStatus('本回合还没有暗出的牌或移动，无需重置。');
    return;
  }
  $('undoMask').classList.remove('hidden');
}

function cancelEnergyReset() {
  $('undoMask').classList.add('hidden');
}

function confirmEnergyReset() {
  $('undoMask').classList.add('hidden');
  const st = state;
  if (st.phase !== 'play') return;
  if (st.playerMoves.length === 0 && st.flyMoved.size === 0) return;
  undoPlacedCards(); // 暗牌放回手牌、能量返还
  undoFlyMoves();    // 本回合“每回合移动一次”的卡移回回合初区域、恢复移动次数
  renderAll();
}

// 把本回合已暗出的牌按放置前的顺序放回手牌，能量全额返还
function undoPlacedCards() {
  const st = state;
  const pl = st.players.p;
  // 1) 从区域里取回暗牌
  const removed = [];
  for (const mv of st.playerMoves) {
    const zone = pl.zones[mv.loc];
    const ci = zone.findIndex((c) => c.id === mv.cardId);
    if (ci >= 0) {
      const [card] = zone.splice(ci, 1);
      removed.push(card);
      dequeueField(card); // 撤回暗牌：移出放置队列（再次打出时重新入队）
    }
  }
  if (removed.length === 0) { st.playerMoves = []; st.selected = -1; renderAll(); return; }
  // 2) 按回合开始时的手牌顺序重建
  const pool = new Map();
  for (const c of pl.hand) pool.set(c.id, c);
  for (const c of removed) pool.set(c.id, c);
  const restored = [];
  for (const id of st.playHandOrder) {
    const c = pool.get(id);
    if (c) { restored.push(c); pool.delete(id); }
  }
  for (const c of pool.values()) restored.push(c); // 理论兜底
  pl.hand = restored;
  // 3) 能量返还
  st.energyLeft = Math.min(st.energyTotal, st.energyLeft + removed.reduce((s, c) => s + c.def.c, 0));
  st.selected = -1;
  st.playerMoves = [];
  log('p', `↺ 你重置了本回合暗出的 ${removed.length} 张牌，已放回手牌，能量返还。`);
  renderAll();
}

// 重置：把本回合“每回合移动一次”移过的卡移回回合初所在区域，并恢复移动次数
function undoFlyMoves() {
  const st = state;
  const froms = st.flyMovedFrom || {};
  st.moveCardId = null;
  for (const idStr of Object.keys(froms)) {
    const id = Number(idStr);
    const from = froms[id];
    const found = findPlayerCard(id);
    if (!found || found.j === from) { st.flyMoved.delete(id); continue; }
    const back = st.players.p.zones[from];
    if (back.length >= locDef(from).max) continue; // 理论不会发生：先重置暗牌已腾位
    found.zone.splice(found.zone.indexOf(found.card), 1);
    back.push(found.card);
    st.flyMoved.delete(id);
    log('p', `↺ 移动重置：「${found.card.def.n}」回到「${st.locs[from].def.n}」，本回合可再移动。`);
  }
  st.flyMovedFrom = {};
}

function uiRetreat() {
  const st = state;
  if (st.phase !== 'play') return;
  resolvePlayer({ type: 'retreat' });
}

function doRetreat() {
  const st = state;
  st.phase = 'over';
  renderAll();
  log('danger', `你认输了，输掉 ${st.stakes} 立方。`);
  showModal('🏳️', '你认输了', '对手获得本局胜利。', -st.stakes);
}

/* ---------------- AI ---------------- */
function hypotheticScore(card, locIdx) {
  let score = 0;
  for (let j = 0; j < 3; j++) {
    let mine = zoneTotals('a', j, true);
    let opp = zoneTotals('p', j, true);
    if (j === locIdx) {
      mine += cardPowerIn(locIdx, card);
      // 若这一手正好把该区放满，预判计入放满加成
      const def = state.locs[j].def;
      if (def.fill && sideUsed('a', j) + occOf(card) >= def.max) mine += def.fill;
    }
    // 反转区域（辉针城）比较口径取负：数值更低反而领先
    const eff = state.locs[j].def.inv ? -1 : 1;
    const adv = eff * (mine - opp);
    score += state.locs[j].def.wt * (adv + (adv > 0 ? 5 : adv < 0 ? -3 : 0));
  }
  return score;
}

function aiThink() {
  const st = state;
  const pl = st.players.a;
  // AI 视局势考虑双倍
  if (!st.aSnapped && st.turn >= 3 && Math.random() < 0.6) {
    let adv = 0;
    for (let j = 0; j < 3; j++) adv += state.locs[j].def.wt * (zoneEff('a', j, true) - zoneEff('p', j, true));
    if (adv > 4 && st.stakes < 8) {
      st.stakes = Math.min(8, st.stakes * 2);
      st.aSnapped = true;
      log('snap', `⚡ 对手双倍下注！赌注升至 ${st.stakes}`);
    }
  }
  // 贪心循环：把剩余能量花完为止
  let rem = st.energyTotal;
  while (true) {
    const affordable = pl.hand.filter((c) => c.def.c <= rem);
    if (affordable.length === 0) break;
    const cands = [];
    for (const card of affordable) {
      // AI 策略：区域变形到辉针城的卡（鬼人正邪）只在自己落后该区 ≥10 点时考虑
      const isNeedle = card.def.k === 'xform' && card.def.xf === 'needle';
      for (let j = 0; j < 3; j++) {
        if (sideRoom('a', j) < occOf(card)) continue; // 占格口径：大体积卡需要整区空位（occ4 只进 max4 空区）
        if (!locOpen(j)) continue;
        if (isNeedle) {
          const myT = zoneTotals('a', j, true);
          const opT = zoneTotals('p', j, true);
          if (opT - myT < 10) continue; // 落后不足 10 点：本回合不打
        }
        let sc = hypotheticScore(card, j);
        if (locDef(j).purge) sc *= 0.25; // 聚变反应炉：权重 -75%，尽量少打
        cands.push({ card, loc: j, score: sc });
      }
    }
    if (cands.length === 0) break;
    cands.sort((x, y) => y.score - x.score);
    const best = cands[0].score;
    const pool = cands.filter((c) => c.score >= best - 3);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    pl.zones[pick.loc].push(pick.card);
    enqueueField(pick.card); // 对手暗出：进入场上放置顺序队列（v55）
    pl.hand.splice(pl.hand.indexOf(pick.card), 1);
    rem -= pick.card.def.c;
    st.aiMoves.push({ cardId: pick.card.id, loc: pick.loc });
    log('a', `对手在「${st.locs[pick.loc].def.n}」暗出一张牌(${pick.card.def.c}费)。`);
  }
  if (st.aiMoves.length === 0) {
    log('a', '对手没有可打出的牌，选择跳过。');
  }
}

/* ---------------- 翻牌与效果 ---------------- */
// 按“结算胜利标准”判断当前盘面（只看已翻开的牌）的领先方；
// 领先 = 赢下区域更多；若区域数打平（必然存在平局区域）则比三区总点数。均等则返回 null。
function currentLeaderSide() {
  let pw = 0, aw = 0, pT = 0, aT = 0;
  for (let j = 0; j < 3; j++) {
    const d = state.locs[j].def;
    // 反转区域（辉针城）按有效口径：低战力一方视为“领先”该区
    const pt = zoneEff('p', j);
    const at = zoneEff('a', j);
    pT += pt; aT += at;
    if (pt > at) pw += d.wt;
    else if (at > pt) aw += d.wt;
  }
  if (pw > aw) return 'p';
  if (aw > pw) return 'a';
  if (pT > aT) return 'p';
  if (aT > pT) return 'a';
  return null;
}

async function revealRound() {
  const st = state;
  // 决定先后翻牌：首回合随机；其后按当前领先方（结算口径）先翻，持平则随机。
  // 同一方的多张牌严格按“放置顺序”翻。
  let first;
  if (st.turn === 1) {
    first = Math.random() < 0.5 ? 'p' : 'a';
    log('sys', `首回合随机决定翻牌顺序：由${first === 'p' ? '你' : '对手'}先翻开。`);
  } else {
    first = currentLeaderSide();
    if (first) log('sys', `翻牌顺序：当前${first === 'p' ? '你' : '对手'}领先，由${first === 'p' ? '你' : '对手'}先翻开。`);
    else {
      first = Math.random() < 0.5 ? 'p' : 'a';
      log('sys', '翻牌顺序：当前形势持平，随机决定先后。');
    }
  }
  const order = [];
  const sideOrder = first === 'p' ? ['p', 'a'] : ['a', 'p'];
  for (const side of sideOrder) {
    const moves = side === 'p' ? st.playerMoves : st.aiMoves;
    for (const mv of moves) order.push({ side, ...mv });
  }
  for (const mv of order) {
    const pl = st.players[mv.side];
    const card = pl.zones[mv.loc].find((c) => c.id === mv.cardId);
    if (!card) continue;
    card.revealed = true;
    card.justRevealed = true;
    renderZones(); // 翻面后该牌战力才计入区域总点数
    log(mv.side, `「${card.def.n}」翻牌 — 威力 ${cardPowerIn(mv.loc, card)}`);
    if (card.def.k) {
      // 只有效果“真的会造成变化”时才停顿展示（如对方/己方没有已翻开卡可被加减时直接结算）
      if (revealEffectWillChange(mv.side, mv.loc, card)) await sleep(400);
      applyEffect(mv.side, mv.loc, card);
    }
    renderZones();
    await sleep(500); // 效果结算后停顿，再进入下一张翻牌
  }
  st.playerMoves = [];
  st.aiMoves = [];
}

// 预判：该牌的“揭示”效果是否真的会造成数值/盘面变化
// （用于跳过“结算前 500ms 停顿”——如对没有已翻开卡的区域打增减、条件不满足等空转情况）
function revealEffectWillChange(side, locIdx, card) {
  const st = state;
  const other = side === 'p' ? 'a' : 'p';
  const mine = st.players[side].zones[locIdx];
  const theirs = st.players[other].zones[locIdx];
  const def = card.def;
  const vis = theirs.filter((c) => c.revealed && !c.def.un);
  switch (def.k) {
    case 'bf': return mine.some((c) => c !== card && !c.def.un && c.revealed);
    case 'de': return vis.length > 0;
    case 'ba': return true; // 至少自己已翻开会吃到 +N
    case 'bl': return zoneEff(side, locIdx) < zoneEff(other, locIdx);
    case 'dw':
    case 'dwh': return vis.length > 0;
    case 'mv': {
      if (vis.length === 0) return false;
      for (let j = 0; j < 3; j++) {
        if (j !== locIdx && locOpen(j) && sideRoom(other, j) >= 1) return true;
      }
      return false;
    }
    case 'spawn': {
      const sp = def.spawn;
      const tk = sp && TOKENS[sp.card];
      if (!tk) return false;
      const cnt = sp.n || 1;
      const room = (s) => Math.min(cnt, sideRoom(s, locIdx));
      return room(side) + room(other) > 0;
    }
    case 'spawnO': {
      const sp = def.spawnO;
      const tk = sp && TOKENS[sp.card];
      if (!tk) return false;
      const cnt = sp.n || 1;
      // 只投放到“对方一侧”：对方该区有空位才算会真的变化
      return Math.min(cnt, sideRoom(other, locIdx)) > 0;
    }
    case 'clone': {
      const sp = def.clone;
      const tk = sp && TOKENS[sp.card];
      if (!tk) return false;
      const cnt = sp.n || 1;
      // 另两区（不含本区）自己一侧：任一区有可放空位（且已开放）才算会变化
      for (let j = 0; j < 3; j++) {
        if (j === locIdx || !locOpen(j)) continue;
        const room = Math.min(cnt, sideRoom(side, j));
        if (room > 0) return true;
      }
      return false;
    }
    case 'switch':
      // 换边只有在“对方该区没放满”时才真的会变化
      return sideRoom(other, locIdx) >= 1;
    case 'morph':
      // 变身只有在“对方手牌有卡”时才会变化（目标是随机的）
      return st.players[other].hand.length > 0;
    case 'gift': {
      // 换边己方最低已翻开卡：需要“本区有其他已翻开的己方卡”且“对方该区有空位”才真会变化
      if (sideRoom(other, locIdx) < 1) return false;
      return st.players[side].zones[locIdx].some((c) => c !== card && c.revealed && !c.def.un);
    }
    case 'give': return st.players[side].hand.length < 7;
    case 'xform': {
      const t = LOCATION_POOL.find((l) => l.id === def.xf);
      if (!t) return false;
      return !(['p', 'a'].some((s) => sideUsed(s, locIdx) > t.max));
    }
    case 'oc': {
      const opp = side === 'p' ? st.aiMoves : st.playerMoves;
      return opp.some((m) => m.loc === locIdx);
    }
    default: return false;
  }
}

// ---- 战力影响历史（v56）----
// addBuffLog：给目标卡登记一条“永久 buff”来源（d=增减，srcCard=来源卡；
// 来源=目标自身时视为“卡牌效果”，如 bl/oc）。记录点在 applyEffect 的增减结算处。
// tag 可选：自定义来源名（如「防摧毁」），在战力影响历史中优先显示。
function addBuffLog(card, d, srcCard, tag) {
  if (!card) return;
  if (!Array.isArray(card.powerLog)) card.powerLog = [];
  card.powerLog.push({ d, src: srcCard ? { id: srcCard.id, n: srcCard.def.n, t: srcCard.def.t } : null, tag: tag || null });
}

// 防摧毁（def.surv=N，现仅灵乌路空 surv:2）：该卡被任何“摧毁”指向时不会离场，
// 取而代之**永久降低 N 点战力**（每次触发再降 N、可多次；若被反应炉类反复点名会反复降低）。
// 返回 true = 已替代（卡仍在场、由本函数自行记账）；false = 按原样移除摧毁。
function surviveDestroy(card) {
  const surv = card && card.def && card.def.surv;
  if (!surv) return false;
  card.buff -= surv;
  addBuffLog(card, -surv, null, '防摧毁');
  const locIdx = fieldLocOf(card);
  log('danger', `💥 「${card.def.n}」被摧毁时触发了防摧毁：没有被摧毁，取而代之永久降低 ${surv} 点战力（现 ${locIdx >= 0 ? cardPowerIn(locIdx, card) : cardPower(card)}）。`);
  return true;
}

// 凤凰重生（def.phx=N，现仅藤原妹红 phx:2）：被任何“摧毁”指向时**不消失**，
// 而是从场上移除后**返回自己手牌**并**永久 +N 战力**（每次触发 +N、可重复打出并再次触发）；
// 手牌已满 7 张则重生失败、按原样被摧毁。
// 返回 true = 本次摧毁已由本函数处理完毕（调用方不得再移除该卡）；false = 按原样移除摧毁。
function phoenixRevive(card, locIdx) {
  const phx = card && card.def && card.def.phx;
  if (!phx) return false;
  const st = state;
  const side = card.side;
  const zone = st.players[side].zones[locIdx];
  const i = zone.indexOf(card);
  if (i >= 0) zone.splice(i, 1);
  dequeueField(card); // 离开场上：移出放置队列（回手后再打出时重新入队）
  if (st.players[side].hand.length < 7) {
    card.buff += phx;
    addBuffLog(card, phx, null, '凤凰重生');
    card.revealed = false; // 回手后再次打出需重新暗出/翻面
    st.players[side].hand.push(card);
    log('danger', `🔥 「${card.def.n}」被摧毁时触发凤凰重生：返回手牌并永久 +${phx} 战力（下次打出威力 ${cardPower(card)}）。`);
  } else {
    log('danger', `🔥 「${card.def.n}」被摧毁时想凤凰重生，但手牌已满（7 张），重生失败、被摧毁。`);
  }
  return true;
}

function applyEffect(side, locIdx, card, spec) {
  const st = state;
  const other = side === 'p' ? 'a' : 'p';
  const mine = st.players[side].zones[locIdx];
  const theirs = st.players[other].zones[locIdx];
  const def = card.def;
  // 效果规格：揭示（默认，spec 缺省）= 整张卡的 def；时机效果（v55）= def.fx[timing] 条目。
  // 条目字段与 def 同构（k/a/spawn/xf/give/t），结算逻辑完全复用。
  const fx = spec || def;
  // 日志文案：条目自带 t > 卡面效果文案(def.t) > 卡名
  const txt = fx.t || (fx === def ? def.t : def.n);

  switch (fx.k) {
    case 'bf': {
      // 只作用于“结算时已翻开”的其他友军：暗牌不会预领增益（后翻开的牌错过本次结算）
      let n = 0;
      for (const c of mine) if (c !== card && !c.def.un && c.revealed) { c.buff += fx.a; addBuffLog(c, fx.a, card); n++; }
      log(side, `✦ ${txt}${n ? `（影响 ${n} 张）` : '（但该区没有已翻开的其他友军）'}`);
      break;
    }
    case 'de': {
      // 只削弱“结算时已翻开”的对方卡牌：对方暗牌不会提前被降
      let n = 0;
      for (const c of theirs) { if (c.def.un || !c.revealed) continue; c.buff -= fx.a; addBuffLog(c, -fx.a, card); n++; }
      log(side, `✦ ${txt}${n ? `（影响 ${n} 张）` : '（但没有已翻开的对方卡牌可影响）'}`);
      break;
    }
    case 'ba': {
      // 双方同增同样只作用于结算时已翻开的卡牌
      for (const c of mine) if (!c.def.un && c.revealed) { c.buff += fx.a; addBuffLog(c, fx.a, card); }
      for (const c of theirs) if (!c.def.un && c.revealed) { c.buff += fx.a; addBuffLog(c, fx.a, card); }
      log(side, `✦ ${txt}`);
      break;
    }
    case 'bl': {
      const myT = zoneEff(side, locIdx);
      const opT = zoneEff(other, locIdx);
      if (myT < opT) { card.buff += fx.a; addBuffLog(card, fx.a, card); log(side, `✦ 落后触发：${def.n} 威力 +${fx.a}（现 ${cardPowerIn(locIdx, card)}）`); }
      else log(side, `✦ ${def.n} 未落后，效果不触发。`);
      break;
    }
    case 'dw': {
      if (theirs.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但该区空无一人。`); break; }
      // 只能以“已翻开”的对方卡牌为目标：暗牌不可被提前摧毁；un 占位卡不可被摧毁
      const vis = theirs.filter((c) => c.revealed && !c.def.un);
      if (vis.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但对方在此区的牌都还没翻开。`); break; }
      let minP = Infinity, target = null;
      for (const c of vis) {
        const p = cardPowerIn(locIdx, c);
        if (p < minP) { minP = p; target = c; }
      }
      if (phoenixRevive(target, locIdx)) break; // 凤凰重生（如藤原妹红）：回手 +N 战力
      if (surviveDestroy(target)) break; // 防摧毁（如灵乌路空）：替代为降战力、卡不离场
      theirs.splice(theirs.indexOf(target), 1);
      dequeueField(target); // 被摧毁：移出放置队列（后续时机不再结算它）
      log('danger', `✦ ${def.n} 摧毁了对方「${target.def.n}」（威力 ${minP}）`);
      break;
    }
    case 'spawn': {
      // 揭示：给本区域双方各生成特殊卡（如「比那名居天子」给双方各 1 张石块）
      const spc = fx.spawn;
      const tk = spc && TOKENS[spc.card];
      if (spc && tk) {
        const cnt = spc.n || 1;
        const total = cnt * 2;
        const placed = placeToken(side, locIdx, tk, cnt) + placeToken(other, locIdx, tk, cnt);
        log(side, `✦ ${def.n}：本区域双方各生成 ${cnt} 张「${tk.n}」${placed < total ? '（部分区域已放满）' : ''}`);
      }
      break;
    }
    case 'spawnO': {
      // 揭示：给本区域“对方一侧”生成特殊卡（如「键山雏」给敌方添 1 张「厄运」）
      const spc = fx.spawnO;
      const tk = spc && TOKENS[spc.card];
      if (spc && tk) {
        const cnt = spc.n || 1;
        const placed = placeToken(other, locIdx, tk, cnt);
        log(side, placed
          ? `✦ ${def.n}：在对方一侧添加 ${cnt} 张「${tk.n}」`
          : `✦ ${def.n} 想把「${tk.n}」放到对方一侧，但对方该区已放满，未能落下。`);
      }
      break;
    }
    case 'clone': {
      // 揭示：向“另外两个区域”的自己一侧各生成 n 张分身特殊卡（如赫卡提亚 → 分身）；
      // 目标区自己一侧放满或未开放（locOpen）则跳过该区。分身按本卡**揭示时 cardPower**
      // （基础 + 永久 buff）快照对齐战力：差值记在分身 buff 上，之后分身可被增益/削弱独立影响。
      const spc = fx.clone;
      const tk = spc && TOKENS[spc.card];
      if (spc && tk) {
        const cnt = spc.n || 1;
        const snap = cardPower(card);
        let added = 0, zones = 0;
        for (let j = 0; j < 3; j++) {
          if (j === locIdx || !locOpen(j)) continue;
          zones++;
          const zone = st.players[side].zones[j];
          for (let i = 0; i < cnt && sideRoom(side, j) >= 1; i++) {
            const c2 = newCard(tk);
            c2.side = side;
            c2.revealed = true;
            c2.buff += snap - c2.def.p; // 快照对齐本体揭示时战力
            addBuffLog(c2, snap - c2.def.p, null, '分身快照'); // 记入战力影响历史
            zone.push(c2);
            enqueueField(c2); // 分身也按落场先后进入放置队列（v55）
            added++;
          }
        }
        log(side, added
          ? `✦ ${def.n}：向另外两个区域自己一侧各添加 ${cnt} 张「${tk.n}」（分身快照战力=${snap}${added < cnt * zones ? '，部分区域放不下' : ''}）`
          : `✦ ${def.n} 想生成「${tk.n}」，但另外两个区域自己一侧都放不下或未开放。`);
      }
      break;
    }
    case 'switch': {
      // 揭示：换边——翻开后从自己一侧转移到“对方该区域一侧”（依神紫苑，-7 战力随身上对方侧）；
      // 对方该区已放满则换边失败、牌留在自己一侧。换边后归属对方（card.side 同步），
      // 之后作为对方已翻开卡参与结算；场上的放置顺序不变。
      const dst = st.players[other].zones[locIdx];
      if (sideRoom(other, locIdx) < occOf(card)) {
        log('danger', `✦ ${def.n} 想换边到对方一侧，但对方该区已放满，换边失败（仍留在自己一侧）。`);
        break;
      }
      const src = st.players[side].zones[locIdx];
      const idx = src.indexOf(card);
      if (idx < 0) break; // 防御：理论不会发生
      src.splice(idx, 1);
      dst.push(card);
      card.side = other; // 归属换边
      log('danger', `✦ ${def.n} 换边：转移到了对方一侧（${def.p < 0 ? `以 ${-def.p} 负战力计入对方该区` : '该卡现在位于对方一侧'}）。`);
      break;
    }
    case 'morph': {
      // 揭示：变身（二岩猯藏）——从对方手牌随机取一张，把自身完全变成该卡的**复制体**
      // （原卡留在对方手牌）。变身后立即按新 def 的效果文本再结算一次：新卡若带 k（揭示）
      // 则立刻触发该揭示；持续 og / 每回合移动 fly / 时机效果 fx / 防摧毁 surv 等
      // 由新 def 实时驱动，自动生效。
      const hand = st.players[other].hand;
      if (hand.length === 0) { log(side, `✦ ${def.n} 想变身，但对方手牌为空，没有变化。`); break; }
      const oldN = def.n;
      const pick = hand[Math.floor(Math.random() * hand.length)];
      // 大体积目标限制：若随机目标是占多格的大体积卡（如萃香 occ:4），只有本区域 max
      // 恰为该占格数、且己方该区（明牌+暗牌一起数）有且仅有变身者这一张卡时才能变身，
      // 否则变身失败、保持原样（避免变身成萃香后与其他卡共存导致占格超限）。
      if (occOf(pick) > 1) {
        const ownZone = st.players[side].zones[locIdx];
        const legal = locDef(locIdx).max === occOf(pick)
          && ownZone.length === 1 && ownZone[0] === card;
        if (!legal) {
          log('danger', `✦ ${def.n} 想变身成「${pick.def.n}」（占 ${occOf(pick)} 格），但本区域不满足条件（需 max=${occOf(pick)} 且己方该区只有 ${def.n} 这一张卡），变身失败、保持原样。`);
          break;
        }
      }
      card.def = { ...pick.def }; // 变身：整体替换卡面（名称/费用/威力/效果/配图）
      log('danger', `✦ ${oldN} 变身为对方手牌中的「${card.def.n}」！`);
      if (card.def.k === 'morph') {
        // 防死循环：变身目标同样是变身卡则不再次变形
        log(side, `✦ 变身目标是同样会变形的卡，不再二次变形。`);
      } else if (card.def.k) {
        applyEffect(side, locIdx, card); // 重新触发新卡的揭示文本
      }
      break;
    }
    case 'gift': {
      // 揭示：把本区己方“战力最低的已翻开卡”换边到对方（因幡帝；不含自己）。
      // 多张并列最低则随机选一张；对方该区已放满则换边失败。换边后卡归属对方，
      // 其持续效果（og，如天子）按新归属方生效。
      const dst = st.players[other].zones[locIdx];
      if (sideRoom(other, locIdx) < 1) { // 移走的目标为普通占格卡，需对方至少 1 格空位
        log('danger', `✦ ${def.n} 想把己方卡换边，但对方该区已放满，换边失败。`);
        break;
      }
      const own = st.players[side].zones[locIdx].filter((c) => c !== card && c.revealed && !c.def.un);
      if (own.length === 0) {
        log(side, `✦ ${def.n} 想换边己方最低的卡，但本区没有其他已翻开的己方卡。`);
        break;
      }
      let minP = Infinity, poolT = [];
      for (const c of own) {
        const p = cardPowerIn(locIdx, c);
        if (p < minP) { minP = p; poolT = [c]; }
        else if (p === minP) poolT.push(c);
      }
      const target = poolT[Math.floor(Math.random() * poolT.length)]; // 并列最低随机
      st.players[side].zones[locIdx].splice(st.players[side].zones[locIdx].indexOf(target), 1);
      dst.push(target);
      target.side = other; // 归属换边
      log('danger', `✦ ${def.n}：把己方「${target.def.n}」（威力 ${minP}）换边到了对方一侧。`);
      break;
    }
    case 'xform': {
      // 揭示：把本区域变成目标地形（fx.xf = locations 池 id，如辉针城 needle）
      const target = LOCATION_POOL.find((l) => l.id === fx.xf);
      if (!target) break;
      const over = ['p', 'a'].some((s2) => sideUsed(s2, locIdx) > target.max);
      if (over) { log('danger', `✦ ${def.n} 想把本区变成「${target.n}」，但双方牌数超出其上限，变形失败。`); break; }
      state.locs[locIdx].def = target;
      refreshLocHeader(locIdx); // 更新列名/图标/效果文字/配色（隙间随 max=4 自动消失）
      log('danger', `✦ ${def.n} 将本区域变成了「${target.n}」！`);
      break;
    }
    case 'mv': {
      // 揭示：把本区“对方战力最低”的已翻开卡移到另外两区随机一处；
      // 候选区必须该侧未满且已开放（避开锁定的七夕坂等）；全满/全不可达则移动失败。
      const vis = theirs.filter((c) => c.revealed && !c.def.un);
      if (vis.length === 0) { log(side, `✦ ${def.n} 想移走对方卡牌，但对方本区没有已翻开的可移动卡牌。`); break; }
      let minP = Infinity, target = null;
      for (const c of vis) {
        const p = cardPowerIn(locIdx, c);
        if (p < minP) { minP = p; target = c; }
      }
      const cands = [];
      for (let j = 0; j < 3; j++) {
        if (j === locIdx) continue;
        // 移入目标侧空余需 ≥ 被移卡的占格数（occ）：萃香(occ4) 只能移入该侧完全空出的 max4 区域
        if (locOpen(j) && sideRoom(other, j) >= occOf(target)) cands.push(j);
      }
      if (cands.length === 0) { log('danger', `✦ ${def.n} 想把对方「${target.def.n}」移走，但另外两个区域都放不下，移动失败。`); break; }
      const dst = cands.length === 1 ? cands[0] : cands[Math.floor(Math.random() * cands.length)];
      theirs.splice(theirs.indexOf(target), 1);
      st.players[other].zones[dst].push(target);
      log('danger', `✦ ${def.n} 把对方「${target.def.n}」（威力 ${minP}）移到了「${st.locs[dst].def.n}」。`);
      break;
    }
    case 'give': {
      // 揭示：把指定特殊卡加入自己手牌（手牌衍生物，如八云紫 → 废弃列车）
      const gv = fx.give;
      const tk = gv && TOKENS[gv.card];
      if (gv && tk) {
        const cnt = gv.n || 1;
        const hand = st.players[side].hand;
        let added = 0;
        for (let i = 0; i < cnt; i++) {
          if (hand.length >= 7) break;
          const c2 = newCard(tk);
          c2.side = side;
          hand.push(c2);
          added++;
        }
        log(side, `✦ ${txt}${added < cnt ? '（手牌已满，部分未能加入）' : ''}`);
      }
      break;
    }
    case 'dwh': {
      // 揭示：摧毁本区对方一张“已翻开且战力最高”的卡（平局取第一张最高者）
      if (theirs.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但该区空无一人。`); break; }
      const vis = theirs.filter((c) => c.revealed && !c.def.un);
      if (vis.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但对方在此区的牌都还没翻开。`); break; }
      let maxP = -Infinity, target = null;
      for (const c of vis) {
        const p = cardPowerIn(locIdx, c);
        if (p > maxP) { maxP = p; target = c; }
      }
      if (phoenixRevive(target, locIdx)) break; // 凤凰重生（如藤原妹红）：回手 +N 战力
      if (surviveDestroy(target)) break; // 防摧毁（如灵乌路空）：替代为降战力、卡不离场
      theirs.splice(theirs.indexOf(target), 1);
      dequeueField(target); // 被摧毁：移出放置队列（后续时机不再结算它）
      log('danger', `✦ ${def.n} 摧毁了对方「${target.def.n}」（威力 ${maxP}）`);
      break;
    }
    case 'oc': {
      // 揭示：翻开当回合，对方是否在本区域放置过至少一张牌（本回合落牌记录）
      const oppMoves = side === 'p' ? st.aiMoves : st.playerMoves;
      const present = oppMoves.some((m) => m.loc === locIdx);
      if (present) {
        card.buff += fx.a;
        addBuffLog(card, fx.a, card);
        log(side, `✦ 对方本回合在本区放过牌：${def.n} 威力 +${fx.a}（现 ${cardPowerIn(locIdx, card)}）`);
      } else {
        log(side, `✦ 对方本回合没有在本区放牌，${def.n} 效果未触发。`);
      }
      break;
    }
    default: break;
  }
}

/* ---------------- 终局结算 ---------------- */

// 回合结束摧毁（purge：如聚变反应炉）：每回合翻牌结算后，把本区域“全场”战力最低的
// 卡牌摧毁（敌我双方所有已翻开卡混比；并列最低的一并摧毁）。
// 带防摧毁（def.surv，如灵乌路空）的卡不会离场，改为永久降 N 战力（见 surviveDestroy）。
function reactorPurge() {
  const st = state;
  for (let j = 0; j < 3; j++) {
    const def = locDef(j);
    if (!def.purge) continue;
    const zoneP = st.players.p.zones[j];
    const zoneA = st.players.a.zones[j];
    // un 占位卡（如隙间）不可被任何效果摧毁
    const all = zoneP.concat(zoneA).filter((c) => !c.def.un);
    if (all.length === 0) continue;
    let min = Infinity;
    for (const c of all) min = Math.min(min, cardPowerIn(j, c));
    const doomed = all.filter((c) => cardPowerIn(j, c) === min);
    const removed = [];
    for (const c of doomed) {
      if (phoenixRevive(c, j)) continue; // 凤凰重生（如藤原妹红）：回手 +N 战力
      if (surviveDestroy(c)) continue; // 防摧毁（如灵乌路空）：替代为降战力、卡不离场
      const inP = zoneP.indexOf(c) >= 0;
      if (inP) zoneP.splice(zoneP.indexOf(c), 1);
      else zoneA.splice(zoneA.indexOf(c), 1);
      dequeueField(c); // 被摧毁：移出放置队列（后续时机不再结算它）
      removed.push(`${inP ? '你方' : '敌方'}「${c.def.n}」(${cardPowerIn(j, c)})`);
    }
    if (removed.length) log('danger', `⚡ ${def.n}：摧毁本区全场战力最低的牌（威力 ${min}${doomed.length > 1 ? '，并列共 ' + doomed.length + ' 张' : ''}）→ ${removed.join('、')}`);
  }
}

function finishMatch() {
  const st = state;
  st.phase = 'over';
  const lines = [];
  let pw = 0, aw = 0, tie = 0, pTotal = 0, aTotal = 0;
  for (let j = 0; j < 3; j++) {
    const def = st.locs[j].def;
    const rawP = zoneTotals('p', j) * def.dbl;
    const rawA = zoneTotals('a', j) * def.dbl;
    // 反转区域（辉针城）：展示仍用真实点数，但胜负比较取负（低者胜）
    const pt = def.inv ? -rawP : rawP;
    const at = def.inv ? -rawA : rawA;
    pTotal += pt;
    aTotal += at;
    if (pt > at) pw += def.wt;
    else if (at > pt) aw += def.wt;
    else tie += def.wt;
    const who = pt > at ? '你胜' : at > pt ? '对手胜' : '平手';
    const tag = (def.dbl > 1 ? '（威力×2）' : '') + (def.inv ? '（低者胜）' : '');
    lines.push(`${def.n}${tag}：你 ${rawP} : ${rawA} 对手 → ${who}`);
  }
  const hasInv = st.locs.some((l) => l.def.inv);
  let delta = 0, title, sub, emblem;
  if (tie > 0) {
    // 存在平局区域：按三个区域的总点数决胜
    sub = `存在平局区域 → 三区总点数决胜：你 ${pTotal} : ${aTotal} 对手${hasInv ? '（反转区域按负值计入总点数）' : ''}`;
    if (pTotal > aTotal) { delta = st.stakes; title = '你赢了！'; emblem = '🏆'; }
    else if (aTotal > pTotal) { delta = -st.stakes; title = '你输了…'; emblem = '💀'; }
    else { title = '平局'; emblem = '🤝'; sub += ' · 总点数相同'; }
  } else {
    // 无平局区域：看谁赢下的区域更多
    sub = `无平局区域 → 按赢下区域数决胜：你 ${pw} : ${aw} 对手`;
    if (pw > aw) { delta = st.stakes; title = '你赢了！'; emblem = '🏆'; }
    else { delta = -st.stakes; title = '你输了…'; emblem = '💀'; }
  }
  const cls = title === '你赢了！' ? 'win' : title === '你输了…' ? 'danger' : 'sys';
  log(cls, `—— 终局：${title}（赌注 ${st.stakes}）——`);
  renderAll();
  showModal(emblem, title, `${sub}<br>${lines.join('<br>')}`, delta);
}

/* ---------------- 渲染 ---------------- */
const $ = (id) => document.getElementById(id);

function clearLog() {
  $('log').innerHTML = '';
  state.logCount = 0;
}
function log(cls, text) {
  state.logCount++;
  const div = document.createElement('div');
  div.className = 'entry ' + cls;
  div.innerHTML = `<span class="t">[${state.logCount}]</span>${text}`;
  const box = $('log');
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function setStatus(text, busy) {
  const el = $('statusText');
  el.textContent = text;
  $('statusCard').classList.toggle('busy', !!busy);
  // 手机端顶栏下方的同步状态条（桌面端隐藏，更新无副作用）
  const mEl = $('mobStatus');
  if (mEl) mEl.textContent = text;
  const mCard = $('mobStatusCard');
  if (mCard) mCard.classList.toggle('busy', !!busy);
}

function renderAll() {
  renderControls();
  renderHud();
  renderZones();
  renderHand();
  renderSide();
}

function renderControls() {
  const inPlay = state.phase === 'play';
  $('btnSnap').disabled = !inPlay || state.stakes >= 8;
  $('btnRetreat').disabled = !inPlay;
  $('btnPass').disabled = !inPlay;
  // 已经出过牌 → 按钮变成「结束回合」
  $('btnPass').textContent = state.playerMoves.length > 0 ? '结束回合' : '跳过回合';
}

function renderHud() {
  $('turnVal').textContent = state.turn;
  $('energyVal').textContent = state.energyLeft;
  $('energyUnit').textContent = `/ ${state.energyTotal}`;
  $('cubeVal').textContent = state.stakes;
  const pips = $('cubePips');
  pips.innerHTML = '';
  for (let i = 1; i <= 3; i++) {
    const d = document.createElement('span');
    if (state.stakes >= 2 ** i) d.className = 'on';
    pips.appendChild(d);
  }
  // 能量槽：亮起 = 本回合剩余可用能量
  const ep = $('energyPips');
  ep.innerHTML = '';
  for (let i = 0; i < 6; i++) {
    const d = document.createElement('div');
    d.className = 'pip' + (i < state.energyLeft ? ' on' : '');
    ep.appendChild(d);
  }
}

function buildBoard() {
  const board = $('board');
  board.innerHTML = '';
  const els = { cols: [], mineZone: [], oppZone: [], totA: [], totP: [] };
  state.locs.forEach((loc, idx) => {
    const col = document.createElement('div');
    col.className = 'location ' + loc.def.id;

    // 顶部：区域名（效果文字已移到中间带）
    const head = document.createElement('div');
    head.className = 'loc-head';
    head.innerHTML = `<div class="loc-name"><span><span class="icon">${loc.def.icon}</span> ${loc.def.n}</span></div>`;
    col.appendChild(head);

    // 对手区域（卡牌）
    const opp = document.createElement('div');
    opp.className = 'zone opp';
    opp.innerHTML = `<div class="slot-row quad"></div>`;
    col.appendChild(opp);

    // 中间带：对手总点数 → 区域效果 → 己方总点数
    const mid = document.createElement('div');
    mid.className = 'loc-mid';
    mid.innerHTML = `
      <div class="loc-total opp-total"><span class="lt-label">对手</span><span class="lt-num" data-side="a">0</span><span class="lt-unit">点</span></div>
      <div class="loc-effect"><span class="le-icon">${loc.def.icon}</span>${loc.def.eff}</div>
      <div class="loc-total my-total"><span class="lt-label">你</span><span class="lt-num" data-side="p">0</span><span class="lt-unit">点</span></div>`;
    col.appendChild(mid);

    // 己方区域（卡牌）
    const mine = document.createElement('div');
    mine.className = 'zone mine player-zone';
    mine.innerHTML = `<div class="slot-row quad"></div><div class="slot-count"></div>`;
    col.appendChild(mine);

    // 整列点击 = 出到该区域
    col.addEventListener('click', () => {
      // 若正处于“移动卡”模式则先处理移动；否则正常出牌
      if (!tryMoveFlyTo(idx)) tryPlayAt(idx);
    });
    col.addEventListener('mouseenter', () => {
      if (state.phase === 'play' && state.selected >= 0 && canPlaceP(idx)) col.classList.add('active-hover');
    });
    col.addEventListener('mouseleave', () => col.classList.remove('active-hover'));

    board.appendChild(col);
    els.cols.push(col);
    els.oppZone.push(opp.querySelector('.slot-row'));
    els.mineZone.push(mine.querySelector('.slot-row'));
    els.totA.push(mid.querySelector('[data-side="a"]'));
    els.totP.push(mid.querySelector('[data-side="p"]'));
  });
  Game._els = els;
}

// 区域被“变形”（如鬼人正邪 → 辉针城）后刷新该列的标题/图标/效果文字/配色 class
function refreshLocHeader(locIdx) {
  const col = Game._els.cols[locIdx];
  if (!col) return;
  const def = locDef(locIdx);
  col.className = 'location ' + def.id;
  const nameEl = col.querySelector('.loc-name');
  if (nameEl) nameEl.innerHTML = `<span><span class="icon">${def.icon}</span> ${def.n}</span>`;
  const effEl = col.querySelector('.loc-effect');
  if (effEl) effEl.innerHTML = `<span class="le-icon">${def.icon}</span>${def.eff}`;
}

function canPlaceP(idx) {
  const st = state;
  const card = st.players.p.hand[st.selected];
  if (!card || card.def.c > st.energyLeft) return false;
  if (!locOpen(idx)) return false;
  if (occOf(card) > 1 && !occZoneOk(card, idx)) return false; // 大体积卡需上限恰为占格数
  return sideRoom('p', idx) >= occOf(card);
}

function miniCardEl(card, locIdx, side) {
  const el = document.createElement('div');
  el.className = 'mini-card' + (card.justRevealed ? ' played-now' : '');
  if (card.justRevealed) card.justRevealed = false;
  const grad = card.revealed ? gradOf(card.def) : BACK_GRAD;
  el.style.setProperty('--cgrad', grad);
  if (!card.revealed) {
    // 暗牌
    el.innerHTML = `<span class="mc-q">?</span><span class="mc-tag">暗牌</span>`;
  } else {
    // 已翻开：左上角白色费用，右上角当前战力（含区域阵营加成，升降相对基础威力着色）
    const live = cardPowerIn(locIdx, card);
    const net = card.buff + locRoleBonus(locIdx, card) + locCostBonus(locIdx, card) + locAllBonus(locIdx, card);
    const cls = live > card.def.p ? ' up' : live < card.def.p ? ' down' : '';
    if (card.def.img) {
      // 有图片素材：整格铺图，emoji 垫底作缺图兜底
      el.classList.add('has-art');
      el.innerHTML = `<span class="mc-cost">${card.def.c}</span><span class="p${cls}">${live}</span>
        <span class="mc-icon">${card.def.i}</span>
        <img class="mini-img" src="cards-image/${encodeURIComponent(card.def.img)}" alt="${card.def.n}" loading="lazy" draggable="false"/>
        <span class="mc-shade"></span>
        <span class="mc-name">${card.def.n}</span>
        ${net !== 0 ? `<span class="mc-mod">${net > 0 ? '+' : ''}${net}</span>` : ''}`;
    } else {
      el.innerHTML = `<span class="mc-cost">${card.def.c}</span><span class="p${cls}">${live}</span>
        <span class="mc-icon">${card.def.i}</span>
        <span class="mc-name">${card.def.n}</span>
        ${net !== 0 ? `<span class="mc-mod">${net > 0 ? '+' : ''}${net}</span>` : ''}`;
    }
    // 己方“每回合可移动一次”的已翻开卡（如射命丸文）：出牌阶段点击进入移动
    const canFly = side === 'p' && state.phase === 'play' && card.def.fly && card.revealed && !state.flyMoved.has(card.id);
    if (canFly) {
      el.classList.add('can-fly');
      if (state.moveCardId === card.id) el.classList.add('fly-moving');
      const badge = document.createElement('span');
      badge.className = 'mc-fly';
      badge.textContent = '⇄ 移动';
      el.appendChild(badge);
    }
    // 已翻开的敌我卡牌：点击后像图鉴一样放大查看（带场上实时数据）
    el.classList.add('can-inspect');
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (canFly) { uiMoveFly(card.id); return; }
      showFieldCard(card, locIdx);
    });
  }
  return el;
}

function renderZones() {
  if (!Game._els) return;
  const st = state;
  for (let j = 0; j < 3; j++) {
    Game._els.oppZone[j].innerHTML = '';
    Game._els.mineZone[j].innerHTML = '';
    for (const child of buildZoneChildren('a', j)) Game._els.oppZone[j].appendChild(child);
    for (const child of buildZoneChildren('p', j)) Game._els.mineZone[j].appendChild(child);
    // 中间带两侧的醒目总点数：当前受效果影响后的最终战力（横幅显示真实点数）
    const dbl = locDef(j).dbl;
    const ta = zoneTotals('a', j) * dbl;
    const tp = zoneTotals('p', j) * dbl;
    Game._els.totA[j].textContent = ta;
    Game._els.totP[j].textContent = tp;
    // 该区谁领先谁亮黄（反转区域按有效口径：真实战力更低的一方亮黄）；平点则双方蓝色
    const eA = locDef(j).inv ? -ta : ta;
    const eP = locDef(j).inv ? -tp : tp;
    const pillA = Game._els.totA[j].closest('.loc-total');
    const pillP = Game._els.totP[j].closest('.loc-total');
    pillA.classList.toggle('lead', eA > eP);
    pillP.classList.toggle('lead', eP > eA);
    const mineZoneEl = Game._els.mineZone[j].parentElement;
    const count = sideUsed('p', j) + '/' + locDef(j).max;
    const mt = locDef(j).minTurn;
    mineZoneEl.querySelector('.slot-count').textContent =
      `已放 ${count}${mt && !locOpen(j) ? ` · 🔒 第 ${mt} 回合开放` : ''}`;
    mineZoneEl.parentElement.classList.toggle('hoverable', canPlaceP(j));
    // 未开放区域加灰色遮罩（如七夕坂第 5 回合前）
    Game._els.cols[j].classList.toggle('locked', !!locDef(j).minTurn && !locOpen(j));
  }
}

/* 把区域的一侧 2×2 格位按规则填充：
   - 允许格（i < def.max）：按放置顺序放卡；空位补透明占位；
     max=4 的空位用浅灰虚线格标示 2×2 网格线；
   - 不允许格（i >= def.max）：固定用「隙间」灰色卡占位，开局即生成、无法操作。 */
function buildZoneChildren(side, locIdx) {
  const def = locDef(locIdx);
  const cards = state.players[side].zones[locIdx];
  const out = [];
  // 大体积卡（如伊吹萃香 occ:4）独占整侧 2×2：只渲染一张放大卡，区域视为放满
  const big = cards.length === 1 && occOf(cards[0]) > 1 ? cards[0] : null;
  if (big) {
    const el = miniCardEl(big, locIdx, side);
    el.classList.add('big-occ');
    el.title = `${big.def.n} · 占满 ${occOf(big)} 格`;
    out.push(el);
    return out;
  }
  for (let i = 0; i < 4; i++) {
    if (i >= def.max) {
      out.push(gapCellEl());
      continue;
    }
    const card = cards[i];
    if (card) out.push(miniCardEl(card, locIdx, side));
    else if (def.max === 4) out.push(guideCellEl());
    else out.push(spacerCellEl());
  }
  return out;
}

function guideCellEl() {
  const el = document.createElement('div');
  el.className = 'cell-guide';
  return el;
}

function spacerCellEl() {
  const el = document.createElement('div');
  el.className = 'cell-spacer';
  return el;
}

function gapCellEl() {
  const el = document.createElement('div');
  el.className = 'slot-gap';
  el.innerHTML = '<span class="gap-glyph">≋</span><span class="gap-name">隙间</span>';
  // 隙间卡不可被操作：点击不触发任何区域/卡牌逻辑
  el.addEventListener('click', (e) => e.stopPropagation());
  return el;
}

function renderHand() {
  const st = state;
  const hand = $('hand');
  // 保留横向滚动位置：renderHand 每次全量重建，否则手机端每点一次牌手牌都会跳回开头
  const prevScroll = hand.scrollLeft;
  hand.innerHTML = '';
  const cards = st.players.p.hand;
  if (cards.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hand-empty';
    empty.textContent = '手牌已空';
    hand.appendChild(empty);
    return;
  }
  cards.forEach((card, index) => {
    const el = document.createElement('div');
    el.className = 'hand-card';
    const afford = card.def.c <= st.energyLeft;
    if (!afford) el.classList.add('unaffordable');
    if (st.selected === index) el.classList.add('selected');
    // 终局复盘（over）时手牌保持原色且可点击查看，其余非出牌阶段置灰
    if (st.phase !== 'play' && st.phase !== 'over') el.classList.add('unaffordable');
    el.style.setProperty('--cgrad', gradOf(card.def));
    // 手牌卡面显示“当前战力”（基础 + 永久 buff）：如凤凰重生回手的妹红 +2 后直接可见，
    // 不再固定显示基础战力 1。
    const handPow = cardPower(card);
    const handSign = handPow > card.def.p ? 'up' : handPow < card.def.p ? 'down' : '';
    el.innerHTML = cardFaceHTML(card.def, { power: handPow, sign: handSign });
    el.addEventListener('click', () => {
      if (st.phase === 'over') showHandCard(card); // 终局复盘：点击放大查看卡面（含当前战力）
      else selectHand(index);
    });
    // 右键手牌：弹出完整卡牌详情（含被省略号截断的完整效果文案；显示当前战力）
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showHandCard(card);
    });
    hand.appendChild(el);
  });
  // 赋值后浏览器会自动钳制到合法范围（例如出牌后手牌变少）
  hand.scrollLeft = prevScroll;
}

/* ---------------- 图鉴 / 放大卡牌 ---------------- */
function cardFaceHTML(def, opts) {
  opts = opts || {};
  const power = opts.power !== undefined ? opts.power : def.p;
  const sign = opts.sign ? ' ' + opts.sign : '';
  // 有图片素材则用 cards-image/ 下的图（失败/缺图时下方 emoji 透出兜底），否则直接用 emoji
  const art = def.img
    ? `<div class="hc-art">
        <span class="hc-icon hc-art-emoji">${def.i}</span>
        <img class="hc-img" src="cards-image/${encodeURIComponent(def.img)}" alt="${def.n}" loading="lazy" draggable="false"/>
      </div>`
    : `<div class="hc-icon">${def.i}</div>`;
  return `<div class="hc-top"><span class="cost-orb">${def.c}</span><span class="p${sign}">${power}</span></div>
    ${art}
    <div class="hc-name">${def.n}</div>
    <div class="hc-text">${def.t || '—'}</div>`;
}

function uiOnCodex() {
  const mask = $('codexMask');
  if (mask.classList.contains('hidden')) {
    buildCodexGrid();
    mask.classList.remove('hidden');
  } else {
    closeCodex();
  }
}

function buildCodexGrid() {
  const grid = $('codexGrid');
  grid.innerHTML = '';
  let total = 0;
  for (let c = 0; c <= 6; c++) {
    if (!POOL[c]) continue;
    for (const def of POOL[c]) {
      total++;
      const el = document.createElement('div');
      el.className = 'codex-card hand-card';
      el.style.setProperty('--cgrad', gradOf(def));
      el.innerHTML = cardFaceHTML(def);
      el.title = def.n;
      el.addEventListener('click', () => showZoom(def));
      grid.appendChild(el);
    }
  }
  $('codexCount').textContent = `共 ${total} 种`;
}

function closeCodex() {
  $('zoomMask').classList.add('hidden');
  $('codexMask').classList.add('hidden');
  hidePowerPanel();
}

/* ---------------- 开发者：指定卡牌（调试用） ---------------- */
function uiOnPick() {
  const mask = $('pickMask');
  if (!mask.classList.contains('hidden')) { uiOnPickClose(); return; }
  pickDef = null;
  buildPickGrid();
  mask.classList.remove('hidden');
}

function buildPickGrid() {
  const grid = $('pickGrid');
  grid.innerHTML = '';
  for (let c = 0; c <= 6; c++) {
    if (!POOL[c]) continue;
    for (const def of POOL[c]) {
      const el = document.createElement('div');
      el.className = 'codex-card hand-card';
      el.style.setProperty('--cgrad', gradOf(def));
      el.innerHTML = cardFaceHTML(def);
      el.title = def.n;
      el.addEventListener('click', () => {
        pickDef = def;
        grid.querySelectorAll('.pick-picked').forEach((x) => x.classList.remove('pick-picked'));
        el.classList.add('pick-picked');
        $('pickTip').textContent = `已选：「${def.n}」（${def.c} 费 / 威力 ${def.p}）`;
      });
      grid.appendChild(el);
    }
  }
  $('pickTip').textContent = `当前手牌 ${state.players.p.hand.length}/7 — 点选 1 张后确认`;
}

function uiOnPickClose() {
  $('pickMask').classList.add('hidden');
  pickDef = null;
}

// 开发者调试：把本回合能量设为 7（仅当前出牌阶段生效；下回合 playRound 会按回合数重置）
function uiOnEnergyDev() {
  const st = state;
  if (st.phase !== 'play') { setStatus('只有在你的出牌阶段才能修改能量。'); return; }
  st.energyTotal = 7;
  st.energyLeft = 7;
  log('sys', '⚡ 开发者指令：本回合能量已设为 7（下回合恢复为按回合数计）。');
  setStatus('本回合能量已改为 7，可继续出牌（仅本回合有效，下回合恢复）。');
  renderAll();
}

function uiOnPickConfirm() {
  if (!pickDef) { setStatus('请先在弹窗里点选一张卡牌。'); return; }
  const pl = state.players.p;
  if (pl.hand.length >= 7) {
    setStatus(`手牌已满（${pl.hand.length}/7），无法加入「${pickDef.n}」。`);
    return;
  }
  const name = pickDef.n;
  const card = newCard(pickDef);
  card.side = 'p';
  pl.hand.push(card);
  log('sys', `🎯 开发者指令：指定「${name}」加入你的手牌（现 ${pl.hand.length}/7）。`);
  setStatus(`已将「${name}」加入手牌（${pl.hand.length}/7）。`);
  pickDef = null;
  $('pickMask').classList.add('hidden');
  renderHand();
}

function zoomStageBtn(label) {
  const btn = document.querySelector('.zoom-stage .btn');
  if (btn) btn.textContent = label;
}

// 找出与某张卡“相关联”的衍生特殊卡（SPLIT：give/spawn 生成的、og 持续效果作用的）
function tokenLinksForDef(def) {
  const list = [];
  const add = (key) => {
    if (!key) return;
    const d = TOKENS[key];
    if (d && !list.includes(d)) list.push(d);
  };
  if (def.give) add(def.give.card);
  if (def.spawn) add(def.spawn.card);
  if (def.spawnO) add(def.spawnO.card); // 如键山雏 → 厄运
  if (def.clone) add(def.clone.card);   // 如赫卡提亚 → 分身
  if (def.og && def.og.tk) {
    for (const k in TOKENS) {
      const d = TOKENS[k];
      if (d && d.tk === def.og.tk) add(k);
    }
  }
  return list;
}

// 在卡牌详情弹窗右侧渲染“衍生卡牌”区（与主弹窗同框，关闭时一起关闭）
function renderDeriv(def) {
  const box = $('zoomDeriv');
  const list = tokenLinksForDef(def);
  if (!list.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="deriv-head">衍生卡牌</div>';
  for (const d of list) {
    const item = document.createElement('div');
    item.className = 'deriv-item';
    const card = document.createElement('div');
    card.className = 'zoom-card hand-card deriv-card';
    card.style.setProperty('--cgrad', gradOf(d));
    card.innerHTML = cardFaceHTML(d);
    item.appendChild(card);
    box.appendChild(item);
  }
}

// 卡牌放大查看（图鉴/手牌右键等）：展示静态卡面；standalone=true 时按钮显示“关闭”
function showZoom(def, standalone) {
  hidePowerPanel(); // 战力影响历史仅场上已翻开卡查看时展示
  const slot = $('zoomCardSlot');
  slot.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'zoom-card hand-card';
  el.style.setProperty('--cgrad', gradOf(def));
  el.innerHTML = cardFaceHTML(def);
  slot.appendChild(el);

  $('zoomInfo').innerHTML = `
    <div class="zoom-meta"><span class="zm-cost">费用 ${def.c}</span><span class="zm-pow">威力 ${def.p}</span></div>
    <div class="zm-kind">${KIND_LABEL[def.k] || ''}</div>
    <div class="zm-desc">${def.t || '平平无奇的白板卡，纯靠身材作战。'}</div>`;
  renderDeriv(def);
  zoomStageBtn(standalone ? '关闭 ✕' : '← 返回图鉴');
  $('zoomMask').classList.remove('hidden');
}

// 手牌卡放大查看：显示该实例的“当前战力”（基础 + 永久 buff，如凤凰重生后的妹红），
// 而非固定基础战力；仅展示卡面/说明，无战力影响历史面板。
function showHandCard(card) {
  hidePowerPanel();
  const def = card.def;
  const live = cardPower(card);
  const diff = live - def.p;
  const sign = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
  const slot = $('zoomCardSlot');
  slot.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'zoom-card hand-card';
  el.style.setProperty('--cgrad', gradOf(def));
  el.innerHTML = cardFaceHTML(def, { power: live, sign });
  slot.appendChild(el);

  $('zoomInfo').innerHTML = `
    <div class="zoom-meta"><span class="zm-cost">费用 ${def.c}</span><span class="zm-pow">当前威力 ${live}</span></div>
    ${diff !== 0 ? `<div class="zm-kind">基础威力 ${def.p} · 永久增益 ${diff > 0 ? '+' : ''}${diff}</div>` : `<div class="zm-kind">基础威力 ${def.p}</div>`}
    <div class="zm-kind">${KIND_LABEL[def.k] || ''}</div>
    <div class="zm-desc">${def.t || '平平无奇的白板卡，纯靠身材作战。'}</div>`;
  renderDeriv(def);
  zoomStageBtn('关闭 ✕');
  $('zoomMask').classList.remove('hidden');
}

/* ==================== 战力影响历史（v56） ====================
   收集某卡“当前所有战力影响来源”的行，各行之和 = 实时战力 cardPowerIn：
     基础战力 → 永久 buff 台账（按施加先后）→ 持续效果（实时、分来源）→ 区域加成（实时）
   模块化：未来新来源（新效果键/新区域字段/新持续效果）只需在 powerHistoryRows 追加收集段，
   并在改动 buff 的结算点调用 addBuffLog 即可，UI 与着色自动覆盖。 */
function powerHistoryRows(card, locIdx) {
  const def = card.def;
  const loc = locDef(locIdx);
  const rows = [];
  // 1) 基础战力
  rows.push({ d: def.p, label: '基础战力', kind: 'base' });
  // 2) 永久 buff 台账（按施加先后；来源=自身 → 显示“卡牌效果”）
  for (const e of card.powerLog || []) {
    const self = e.src && e.src.id === card.id;
    rows.push({
      d: e.d,
      kind: self ? 'self' : 'card',
      label: self ? '卡牌效果' : (e.tag || (e.src ? e.src.n : '效果')),
      sub: e.tag || (e.src && e.src.t ? e.src.t : ''),
    });
  }
  // 3) 持续效果（实时、分来源，如天子→己方石块 +2；源卡被摧毁/离场即不再列出）
  if (def.tk) {
    for (let j = 0; j < 3; j++) {
      for (const c of state.players[card.side].zones[j]) {
        if (c === card || !c.revealed || c.def.un) continue;
        const og = c.def.og;
        if (og && og.tk === def.tk) rows.push({ d: og.add, kind: 'aura', label: c.def.n, sub: '持续效果' });
      }
    }
  }
  // 4) 区域加成（实时）：阵营 aff / 费用 cb / 全区 all
  if (loc.aff && def.g === loc.aff.group && loc.aff.add) rows.push({ d: loc.aff.add, kind: 'loc', label: loc.n, sub: `区域加成（${GROUPS[loc.aff.group] || loc.aff.group}）` });
  if (loc.cb && def.c === loc.cb.c && loc.cb.add) rows.push({ d: loc.cb.add, kind: 'loc', label: loc.n, sub: `区域加成（费用 ${loc.cb.c}）` });
  if (loc.all) rows.push({ d: loc.all, kind: 'loc', label: loc.n, sub: '区域效果' });
  return rows;
}

// 渲染独立“战力影响历史”面板（位于卡牌详情弹窗外部、同遮罩并排）
function renderPowerHistory(card, locIdx) {
  const rows = powerHistoryRows(card, locIdx);
  const sum = rows.reduce((s, r) => s + r.d, 0);
  $('ppName').textContent = `${card.def.n}（${card.side === 'p' ? '你方' : '敌方'}）· 当前战力 ${cardPowerIn(locIdx, card)}`;
  const box = $('ppRows');
  box.innerHTML = '';
  for (const r of rows) {
    const el = document.createElement('div');
    el.className = 'pp-row ' + (r.kind === 'base' ? 'base' : r.d > 0 ? 'up' : r.d < 0 ? 'down' : '');
    const num = document.createElement('span');
    num.className = 'pp-num';
    num.textContent = (r.kind === 'base' ? '' : r.d > 0 ? '+' : '') + r.d;
    const lab = document.createElement('span');
    lab.className = 'pp-lab';
    lab.textContent = r.label;
    el.appendChild(num);
    el.appendChild(lab);
    if (r.sub) el.title = r.sub;
    box.appendChild(el);
  }
  const total = document.createElement('div');
  total.className = 'pp-row pp-total';
  total.innerHTML = `<span class="pp-num">${sum > 0 ? '+' : ''}${sum}</span><span class="pp-lab">合计战力（= 场上显示）</span>`;
  box.appendChild(total);
  $('powerPanel').classList.remove('hidden');
}

function hidePowerPanel() {
  const p = $('powerPanel');
  if (p) p.classList.add('hidden');
}

// 场上已翻开卡牌的放大查看：卡面威力为受修正后的当前战力；修正明细移入
// 独立的“战力影响历史”面板（避免挤在卡牌详情内），详情区只留基础信息。
function showFieldCard(card, locIdx) {
  const def = card.def;
  const live = cardPowerIn(locIdx, card);
  const diff = live - def.p;
  const sign = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
  const slot = $('zoomCardSlot');
  slot.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'zoom-card hand-card';
  el.style.setProperty('--cgrad', gradOf(def));
  el.innerHTML = cardFaceHTML(def, { power: live, sign });
  slot.appendChild(el);

  $('zoomInfo').innerHTML = `
    <div class="zoom-meta"><span class="zm-cost">费用 ${def.c}</span><span class="zm-pow">场上威力 ${live}</span></div>
    <div class="zm-kind">基础威力 ${def.p}</div>
    <div class="zm-kind">${KIND_LABEL[def.k] || ''}</div>
    <div class="zm-desc">${def.t || '平平无奇的白板卡，纯靠身材作战。'}</div>`;
  renderDeriv(def);
  renderPowerHistory(card, locIdx); // 独立“战力影响历史”面板（同遮罩并排、弹窗外部）
  zoomStageBtn('关闭 ✕');
  $('zoomMask').classList.remove('hidden');
}

function closeZoom() {
  $('zoomMask').classList.add('hidden');
  hidePowerPanel(); // 独立“战力影响历史”面板随详情弹窗一起关闭
}

function renderSide() {
  const st = state;
  // 侧栏对手信息：显示对方“当前手牌剩余张数”（而非已打出张数）
  $('aiCount').textContent = st.players.a.hand.length;
  $('aiDeck').textContent = st.players.a.deck.length;
  $('aiSnapTag').classList.toggle('hidden', !st.aSnapped);
}

/* ---------------- 弹窗 ---------------- */
function hideModal() { $('modalMask').classList.add('hidden'); }

// 结算/认输弹窗的「确认」：只关弹窗，不清空终局盘面，供玩家点击复盘。
// 场上已翻开的牌本就可点击放大；此时手牌也可点击查看（阶段 over）。
function closeResult() {
  hideModal();
  setStatus('终局已确认 —— 可点击场上与手牌卡牌复盘，或点顶部「重新开始」再来一局。');
}
function showModal(emblem, title, sub, delta) {
  $('modalEmblem').textContent = emblem;
  $('modalTitle').textContent = title;
  $('modalSub').innerHTML = sub;
  const cube = $('modalCubes');
  if (delta > 0) { cube.textContent = `+${delta} 立方`; cube.className = 'modal-cubes win'; }
  else if (delta < 0) { cube.textContent = `${delta} 立方`; cube.className = 'modal-cubes lose'; }
  else { cube.textContent = '无立方变动'; cube.className = 'modal-cubes draw'; }
  $('modalMask').classList.remove('hidden');
}

/* ---------------- 导出到 window ---------------- */
window.Game = {
  _els: null,
  restart,
  ui: {
    onSnap: uiSnap,
    onPass: uiEndTurn,
    onRetreat: uiRetreat,
    onCodex: uiOnCodex,
    closeZoom,
    closeResult,
    onPick: uiOnPick,
    onPickClose: uiOnPickClose,
    onPickConfirm: uiOnPickConfirm,
    onEnergyDev: uiOnEnergyDev,
    onEnergyReset: uiEnergyReset,
    confirmEnergyReset,
    cancelEnergyReset,
  },
  _dbg: () => ({
    gen: state.gen, phase: state.phase, turn: state.turn,
    energyTotal: state.energyTotal, energyLeft: state.energyLeft,
    hasWaiter: !!pendingResolve,
    handP: state.players.p.hand.map((c) => c.def.c),
    handA: state.players.a.hand.map((c) => c.def.c),
    pMoves: (state.playerMoves || []).length, aiMoves: (state.aiMoves || []).length,
    pZones: state.players.p.zones.map((z) => z.length),
    aZones: state.players.a.zones.map((z) => z.length),
  }),
};

// 遮罩层点击空白处关闭 / Esc 逐层关闭
(function initOverlays() {
  const codexMask = $('codexMask');
  const zoomMask = $('zoomMask');
  const undoMask = $('undoMask');
  const pickMask = $('pickMask');
  codexMask.addEventListener('click', (e) => { if (e.target === codexMask) closeCodex(); });
  zoomMask.addEventListener('click', (e) => { if (e.target === zoomMask) closeZoom(); });
  undoMask.addEventListener('click', (e) => { if (e.target === undoMask) cancelEnergyReset(); });
  pickMask.addEventListener('click', (e) => { if (e.target === pickMask) uiOnPickClose(); });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!zoomMask.classList.contains('hidden')) closeZoom();
    else if (!codexMask.classList.contains('hidden')) closeCodex();
    else if (!pickMask.classList.contains('hidden')) uiOnPickClose();
    else if (!undoMask.classList.contains('hidden')) cancelEnergyReset();
  });
})();

// 启动
restart();
