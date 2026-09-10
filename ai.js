/* =========================================================
   东方逆转 · ai.js（v117 拆分）
   人机（对手 AI）思考逻辑：落子估值 hypotheticScore 与 aiThink。
   依赖（运行时，来自 game.js）：顶层 state / locDef / locOpen / sideRoom /
   occOf / zoneTotals / zoneEff / cardPowerIn / enqueueField / log。
   入口：playRound 阶段 ③ 调用 aiThink()（game.js 内函数名引用本文件的全局函数）。
   策略要点：
   - 贪心按本方 energyLeft 把剩余能量花完（v145：与玩家能量变量独立）；
   - 反转区（辉针城 inv，胜者=点数低）不主动放牌（v116）；
   - 「鬼人正邪」（xform → needle）仅在己方落后该区 ≥10 点时打出；
   - 聚变反应炉（purge）落子权重 ×0.25，尽量避开；
   - 视局势随机双倍下注。
   ========================================================= */
'use strict';

// 单张卡的假设落子估值：把 card 放到 locIdx 后，按各区“有效口径”算综合收益。
// 反转区（inv）数值更低反而领先，故对其差值取负（低者胜口径），
// 与 zoneEff / 胜负结算保持一致。
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

// 对手回合的放置决策：可能双倍 → 贪心按估值落子直到能量花完
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
  // 贪心循环：把本方剩余能量花完为止（v145：读 players.a 独立能量）
  const en = pl;
  while (true) {
    const rem = en.energyLeft;
    const affordable = pl.hand.filter((c) => c.def.c <= rem);
    if (affordable.length === 0) break;
    const cands = [];
    for (const card of affordable) {
      // AI 策略：区域变形到辉针城的卡（鬼人正邪）只在自己落后该区 ≥10 点时考虑
      const isNeedle = card.def.k === 'xform' && card.def.xf === 'needle';
      for (let j = 0; j < 3; j++) {
        if (sideRoom('a', j) < occOf(card)) continue; // 占格口径：大体积卡需要整区空位（occ4 只进 max4 空区）
        if (!locOpen(j)) continue;
        // v116：反转区（辉针城 inv）胜者 = 点数更低的一方，AI 不主动往该区放牌，
        // 避免高战力大牌误拍导致“点数更高反而输”
        if (locDef(j).inv) continue;
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
    pick.card.side = 'a';
    en.energyLeft -= pick.card.def.c;
    st.aiMoves.push({ cardId: pick.card.id, loc: pick.loc });
    log('a', `对手在「${st.locs[pick.loc].def.n}」暗出一张牌(${pick.card.def.c}费)。`);
  }
  if (st.aiMoves.length === 0) {
    log('a', '对手没有可打出的牌，选择跳过。');
  }
}
