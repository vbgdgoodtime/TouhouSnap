/* =========================================================
   东方逆转 · 极简演示 —— Marvel Snap 玩法 · 东方 Project 换皮
   3 区域 / 6 回合 / 能量预算多张出牌 / 暗牌翻面 /
   现身效果 / 区域特效 / 双倍下注(snap) / 认输 / 重置暗牌
   ========================================================= */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 基础数据 ----------------
   卡牌与区域数据已拆到独立文件（cards.js / locations.js），
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
const LOCATION_POOL = (window.DS_LOCATIONS && window.DS_LOCATIONS.POOL) || [];

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
// 区域总点数：默认只统计“已翻开”的牌（暗牌不计入，翻面后才计入）。
// includeHidden=true 用于 AI 决策估值（AI 能看到完整盘面）。
function zoneTotals(side, locIdx, includeHidden) {
  return state.players[side].zones[locIdx].reduce(
    (s, c) => (includeHidden || c.revealed ? s + cardPower(c) : s),
    0
  );
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
  playHandOrder: [],   // 本回合开始时玩家手牌 id 顺序（供重置暗牌时恢复）
  logCount: 0,
};

let pendingResolve = null;

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
  state.playHandOrder = [];
  state.players.p.zones = [[], [], []]; state.players.p.hand = [];
  state.players.a.zones = [[], [], []]; state.players.a.hand = [];

  // 造牌库：费用曲线随机 + 起手友好保证（同费用内不重复）
  state.players.p.deck = buildDeckCards();
  state.players.a.deck = buildDeckCards();

  // 初始手牌各 3 张
  for (let i = 0; i < 3; i++) drawOne('p');
  for (let i = 0; i < 3; i++) drawOne('a');

  // 选 3 块区域（从当前区域池随机，允许重复以增加变化）
  const picks = [];
  while (picks.length < 3) {
    const def = LOCATION_POOL[Math.floor(Math.random() * LOCATION_POOL.length)];
    if (picks.length === 2 && picks[0] === def && picks[1] === def) continue; // 避免三块完全相同
    picks.push(def);
  }
  state.locs = picks.map((def) => ({ def }));

  // DOM 骨架
  buildBoard();
  hideModal();
  $('undoMask').classList.add('hidden');
  clearLog();
  log('sys', '新对局开始！区域已揭晓，先手暗牌后统一翻面。');
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
  return { id: uid(), def, buff: 0, revealed: false, justRevealed: false };
}

function drawOne(side) {
  const pl = state.players[side];
  if (pl.deck.length === 0 || pl.hand.length >= 7) return null;
  const card = pl.deck.pop();
  pl.hand.push(card);
  return card;
}

async function playRound(gen) {
  if (gen !== state.gen) return;
  const st = state;
  if (st.turn > 1) { drawOne('p'); drawOne('a'); }
  st.energyTotal = Math.min(st.turn, 6);
  st.energyLeft = st.energyTotal;
  st.phase = 'play';
  st.selected = -1;
  st.playerMoves = [];
  st.aiMoves = [];
  // 记录本回合开始时的玩家手牌顺序（重置暗牌时按此顺序放回）
  st.playHandOrder = st.players.p.hand.map((c) => c.id);
  renderAll();
  if (st.turn > 1) log('sys', `—— 第 ${st.turn} 回合 · 双方各抓 1 张 ——`);
  setStatus(`第 ${st.turn} 回合 · 能量 ${st.energyTotal}：可一次暗出多张牌（总费用不超过能量），出完点「结束回合」；点能量框可重置本回合暗牌。`);

  // 等待玩家行动（出牌 / 跳过 / 认输 / 双倍 均在此阶段触发）
  const act = await waitPlayer();
  if (gen !== state.gen) return;
  if (act.type === 'retreat') { doRetreat(); return; }

  // 对手回合
  state.phase = 'busy';
  renderControls();
  setStatus('对手思考中…');
  await sleep(600);
  if (gen !== state.gen) return;
  aiThink();
  renderAll();
  await sleep(600);
  if (gen !== state.gen) return;

  // 翻牌结算
  await revealRound();
  if (gen !== state.gen) return;
  renderAll();

  if (st.turn >= 6) { finishMatch(); return; }
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
  const card = st.players.p.hand[index];
  if (!card) return;
  if (card.def.c > st.energyLeft) { setStatus('剩余能量不足，换一张更便宜的吧。'); return; }
  st.selected = (st.selected === index) ? -1 : index;
  renderAll();
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
  if (zone.length >= locDef(locIdx).max) {
    setStatus('这个区域已经放满，选别的区域吧。');
    return false;
  }
  zone.push(card);
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
  if (st.playerMoves.length === 0) { setStatus('本回合还没有暗出的牌，无需重置。'); return; }
  $('undoMask').classList.remove('hidden');
}

function cancelEnergyReset() {
  $('undoMask').classList.add('hidden');
}

function confirmEnergyReset() {
  $('undoMask').classList.add('hidden');
  const st = state;
  if (st.phase !== 'play' || st.playerMoves.length === 0) return;
  undoPlacedCards();
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
    if (j === locIdx) mine += cardPower(card);
    const adv = mine - opp;
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
    for (let j = 0; j < 3; j++) adv += state.locs[j].def.wt * (zoneTotals('a', j, true) - zoneTotals('p', j, true));
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
      for (let j = 0; j < 3; j++) {
        if (pl.zones[j].length >= locDef(j).max) continue;
        cands.push({ card, loc: j, score: hypotheticScore(card, j) });
      }
    }
    if (cands.length === 0) break;
    cands.sort((x, y) => y.score - x.score);
    const best = cands[0].score;
    const pool = cands.filter((c) => c.score >= best - 3);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    pl.zones[pick.loc].push(pick.card);
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
    const pt = zoneTotals('p', j) * d.dbl;
    const at = zoneTotals('a', j) * d.dbl;
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
    log(mv.side, `「${card.def.n}」翻牌 — 威力 ${cardPower(card)}`);
    if (card.def.k) applyEffect(mv.side, mv.loc, card);
    renderZones();
    await sleep(780);
  }
  st.playerMoves = [];
  st.aiMoves = [];
}

function applyEffect(side, locIdx, card) {
  const st = state;
  const other = side === 'p' ? 'a' : 'p';
  const mine = st.players[side].zones[locIdx];
  const theirs = st.players[other].zones[locIdx];
  const def = card.def;

  switch (def.k) {
    case 'bf': {
      let n = 0;
      for (const c of mine) if (c !== card) { c.buff += def.a; n++; }
      log(side, `✦ ${def.t}${n ? `（影响 ${n} 张）` : '（但该区没有其他友军）'}`);
      break;
    }
    case 'de': {
      for (const c of theirs) c.buff -= def.a;
      log(side, `✦ ${def.t}（影响 ${theirs.length} 张）`);
      break;
    }
    case 'ba': {
      for (const c of mine) c.buff += def.a;
      for (const c of theirs) c.buff += def.a;
      log(side, `✦ ${def.t}`);
      break;
    }
    case 'bl': {
      const myT = zoneTotals(side, locIdx);
      const opT = zoneTotals(other, locIdx);
      if (myT < opT) { card.buff += def.a; log(side, `✦ 落后触发：${def.n} 威力 +${def.a}（现 ${cardPower(card)}）`); }
      else log(side, `✦ ${def.n} 未落后，效果不触发。`);
      break;
    }
    case 'dw': {
      if (theirs.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但该区空无一人。`); break; }
      let minP = Infinity, target = null;
      for (const c of theirs) {
        const p = cardPower(c);
        if (p < minP) { minP = p; target = c; }
      }
      theirs.splice(theirs.indexOf(target), 1);
      log('danger', `✦ ${def.n} 摧毁了对方「${target.def.n}」（威力 ${minP}）`);
      break;
    }
    default: break;
  }
}

/* ---------------- 终局结算 ---------------- */
function finishMatch() {
  const st = state;
  st.phase = 'over';
  const lines = [];
  let pw = 0, aw = 0, tie = 0, pTotal = 0, aTotal = 0;
  for (let j = 0; j < 3; j++) {
    const def = st.locs[j].def;
    const pt = zoneTotals('p', j) * def.dbl;
    const at = zoneTotals('a', j) * def.dbl;
    pTotal += pt;
    aTotal += at;
    if (pt > at) pw += def.wt;
    else if (at > pt) aw += def.wt;
    else tie += def.wt;
    const who = pt > at ? '你胜' : at > pt ? '对手胜' : '平手';
    const tag = def.dbl > 1 ? '（威力×2）' : '';
    lines.push(`${def.n}${tag}：你 ${pt} : ${at} 对手 → ${who}`);
  }
  let delta = 0, title, sub, emblem;
  if (tie > 0) {
    // 存在平局区域：按三个区域的总点数决胜
    sub = `存在平局区域 → 三区总点数决胜：你 ${pTotal} : ${aTotal} 对手`;
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
    col.addEventListener('click', () => tryPlayAt(idx));
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

function canPlaceP(idx) {
  const st = state;
  const card = st.players.p.hand[st.selected];
  if (!card || card.def.c > st.energyLeft) return false;
  return st.players.p.zones[idx].length < locDef(idx).max;
}

function miniCardEl(card) {
  const el = document.createElement('div');
  el.className = 'mini-card' + (card.justRevealed ? ' played-now' : '');
  if (card.justRevealed) card.justRevealed = false;
  const grad = card.revealed ? GRADS[card.def.c] : BACK_GRAD;
  el.style.setProperty('--cgrad', grad);
  if (!card.revealed) {
    // 暗牌
    el.innerHTML = `<span class="mc-q">?</span><span class="mc-tag">暗牌</span>`;
  } else {
    // 已翻开：左上角白色费用，右上角当前战力（升降相对基础威力着色）
    const live = cardPower(card);
    const cls = live > card.def.p ? ' up' : live < card.def.p ? ' down' : '';
    if (card.def.img) {
      // 有图片素材：整格铺图，emoji 垫底作缺图兜底
      el.classList.add('has-art');
      el.innerHTML = `<span class="mc-cost">${card.def.c}</span><span class="p${cls}">${live}</span>
        <span class="mc-icon">${card.def.i}</span>
        <img class="mini-img" src="cards-image/${encodeURIComponent(card.def.img)}" alt="${card.def.n}" loading="lazy" draggable="false"/>
        <span class="mc-shade"></span>
        <span class="mc-name">${card.def.n}</span>
        ${card.buff !== 0 ? `<span class="mc-mod">${card.buff > 0 ? '+' : ''}${card.buff}</span>` : ''}`;
    } else {
      el.innerHTML = `<span class="mc-cost">${card.def.c}</span><span class="p${cls}">${live}</span>
        <span class="mc-icon">${card.def.i}</span>
        <span class="mc-name">${card.def.n}</span>
        ${card.buff !== 0 ? `<span class="mc-mod">${card.buff > 0 ? '+' : ''}${card.buff}</span>` : ''}`;
    }
    // 已翻开的敌我卡牌：点击后像图鉴一样放大查看（带场上实时数据）
    el.classList.add('can-inspect');
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      showFieldCard(card);
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
    // 中间带两侧的醒目总点数：当前受效果影响后的最终战力（含区域倍率）
    const dbl = locDef(j).dbl;
    const ta = zoneTotals('a', j) * dbl;
    const tp = zoneTotals('p', j) * dbl;
    Game._els.totA[j].textContent = ta;
    Game._els.totP[j].textContent = tp;
    // 该区谁领先谁亮黄；平点则双方都保持蓝色
    const pillA = Game._els.totA[j].closest('.loc-total');
    const pillP = Game._els.totP[j].closest('.loc-total');
    pillA.classList.toggle('lead', ta > tp);
    pillP.classList.toggle('lead', tp > ta);
    const mineZoneEl = Game._els.mineZone[j].parentElement;
    const count = st.players.p.zones[j].length + '/' + locDef(j).max;
    mineZoneEl.querySelector('.slot-count').textContent = `已放 ${count}`;
    mineZoneEl.parentElement.classList.toggle('hoverable', canPlaceP(j));
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
  for (let i = 0; i < 4; i++) {
    if (i >= def.max) {
      out.push(gapCellEl());
      continue;
    }
    const card = cards[i];
    if (card) out.push(miniCardEl(card));
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
    if (st.phase !== 'play') el.classList.add('unaffordable');
    el.style.setProperty('--cgrad', GRADS[card.def.c]);
    el.innerHTML = cardFaceHTML(card.def);
    el.addEventListener('click', () => selectHand(index));
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
  for (let c = 1; c <= 6; c++) {
    for (const def of POOL[c]) {
      total++;
      const el = document.createElement('div');
      el.className = 'codex-card hand-card';
      el.style.setProperty('--cgrad', GRADS[def.c]);
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
}

function zoomStageBtn(label) {
  const btn = document.querySelector('.zoom-stage .btn');
  if (btn) btn.textContent = label;
}

// 图鉴入口的放大查看（展示静态卡面）
function showZoom(def) {
  const slot = $('zoomCardSlot');
  slot.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'zoom-card hand-card';
  el.style.setProperty('--cgrad', GRADS[def.c]);
  el.innerHTML = cardFaceHTML(def);
  slot.appendChild(el);

  $('zoomInfo').innerHTML = `
    <div class="zoom-meta"><span class="zm-cost">费用 ${def.c}</span><span class="zm-pow">威力 ${def.p}</span></div>
    <div class="zm-kind">${KIND_LABEL[def.k] || ''}</div>
    <div class="zm-desc">${def.t || '平平无奇的白板卡，纯靠身材作战。'}</div>`;
  zoomStageBtn('← 返回图鉴');
  $('zoomMask').classList.remove('hidden');
}

// 场上已翻开卡牌的放大查看：威力为受修正后的当前战力
function showFieldCard(card) {
  const def = card.def;
  const live = cardPower(card);
  const diff = live - def.p;
  const sign = card.buff > 0 ? 'up' : card.buff < 0 ? 'down' : '';
  const slot = $('zoomCardSlot');
  slot.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'zoom-card hand-card';
  el.style.setProperty('--cgrad', GRADS[def.c]);
  el.innerHTML = cardFaceHTML(def, { power: live, sign });
  slot.appendChild(el);

  $('zoomInfo').innerHTML = `
    <div class="zoom-meta"><span class="zm-cost">费用 ${def.c}</span><span class="zm-pow">场上威力 ${live}</span></div>
    <div class="zm-kind">${diff !== 0
      ? `场上修正 ${diff > 0 ? '+' : ''}${diff}（基础威力 ${def.p}）`
      : `基础威力 ${def.p} · 场上无修正`}</div>
    <div class="zm-kind">${KIND_LABEL[def.k] || ''}</div>
    <div class="zm-desc">${def.t || '平平无奇的白板卡，纯靠身材作战。'}</div>`;
  zoomStageBtn('关闭 ✕');
  $('zoomMask').classList.remove('hidden');
}

function closeZoom() {
  $('zoomMask').classList.add('hidden');
}

function renderSide() {
  const st = state;
  let pCount = 0, aCount = 0;
  for (let j = 0; j < 3; j++) { pCount += st.players.p.zones[j].length; aCount += st.players.a.zones[j].length; }
  $('aiCount').textContent = aCount;
  $('aiDeck').textContent = st.players.a.deck.length;
  $('aiSnapTag').classList.toggle('hidden', !st.aSnapped);
}

/* ---------------- 弹窗 ---------------- */
function hideModal() { $('modalMask').classList.add('hidden'); }
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
  codexMask.addEventListener('click', (e) => { if (e.target === codexMask) closeCodex(); });
  zoomMask.addEventListener('click', (e) => { if (e.target === zoomMask) closeZoom(); });
  undoMask.addEventListener('click', (e) => { if (e.target === undoMask) cancelEnergyReset(); });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!zoomMask.classList.contains('hidden')) closeZoom();
    else if (!codexMask.classList.contains('hidden')) closeCodex();
    else if (!undoMask.classList.contains('hidden')) cancelEnergyReset();
  });
})();

// 启动
restart();
