/* =========================================================
   东方逆转 · ai.js（v117 拆分 / **v173 重做**）
   对手 AI 的思考逻辑：影子盘面估值 mdEvaluate + 回合级计划 aiPlanMoves（束搜索）+ aiThink。

   依赖（运行时，来自 game.js 的全局函数/变量）：
     state / locDef / locOpen / sideRoom / sideUsed / occOf / cardPower / cardPowerIn /
     cardCost / isSpell / movesForSide / gatherMembers / findLocDef / enqueueField /
     log / POOL / TOKENS / miniCardElById / flyCardTo
   （v169 起手牌费用一律走 cardCost()；本文件只**读取**这些口径，不重复实现引擎规则。）

   ── v173 重做的两条主线 ───────────────────────────────
   ① 层 1「效果估值」：不再把一张牌当成「印刷战力」，而是在一份**影子盘面模型**
      （mdBuild → mdSimulatePlay → mdEvaluate，纯函数、不碰 DOM、不调用 applyEffect）
      上推演「这一手打出去、本回合翻牌结算完之后」的盘面，再用**与引擎一致的胜负口径**
      （对标 finishMatch：先比赢下的区域数，存在平局区则比三区有效点数）打分。
      覆盖 de/bf/ba/bl/oc/dw/dwh/dwb/spawn/spawnO/spawnS/clone/gather/switch/gift/mv/
      shift/roam/xform/morph/costUp/energyNext/give 以及卡级 surv/phx/prot/occ/og/leave；
      并把地形（inv/purge/grow/decay/rally/fill/collapse/dbl/minTurn）投影进本回合末的盘面。
   ② 层 2「回合级计划」：不再单张贪心，而是对这一回合做**束搜索**——候选 =（手牌 × 合法区域）
      ∪「不出牌」，逐张扩展、按估值保留前 N 个计划，能在「两张小牌翻两块区=赢局」与
      「在已赢区继续垫分」之间做出正确取舍；**不出牌本身是一个合法选项**（0 力牌、有害法术、
      会被自己效果反噬的牌不再硬出）。

   ── 难度档（v173 引入三档 → **v175 调整为四档**，默认「简单」）────────
     简单 easy（默认）：**最初版的贪心 AI**（v117~v172 的原样逻辑，`aiThinkLegacy` + `hypotheticScore`）
                        —— 只把每张牌当印刷战力、逐张挑最优落点，不算揭示效果、不做回合计划、
                        不接受「不出牌」、反转区一律弃守、不使用移动；三区优势之和 + ±3 分随机。
     普通 normal      ：v173 新引擎的单张贪心版（效果估值 · 只按已翻开估值 · 不移动 · 不搜索）
     困难 hard        ：v173 新引擎 + 回合级束搜索 · 只按已翻开估值（不看你的暗牌）· 每回合可移动一次
     月狂 lunatic     ：v173 新引擎 + 束搜索 · 全量可见（能读到暗牌战力）· 可移动 · 随机带更窄
   切换：主页面「⚙️ 设置」弹窗（v174），或控制台 `AI.setLevel('easy'|'normal'|'hard'|'lunatic')`，
        或网址加 `?ai=lunatic` / `#ai=lunatic`（网址优先于本地存储；旧档名 `nightmare` 会当成 `lunatic`）。
        当前难度会写进对局日志开头。**四档的 `desc`/`tip` 是设置界面文案的唯一数据源。**

   ── v173 其它口径（四档一致）────────────────────────
     · **AI 不再加倍**：不主动双倍下注，也不跟进玩家的双倍（赌注只由玩家推动）。
       ——简单档也照此：恢复的是当年的**下牌**逻辑，当年 aiThink 里的主动加倍段没有恢复。
     · 决策日志：每张暗出都写一条「估值 + 理由」，回合末再写一条计划小结，便于人工核对。
     · 只做**自己一侧**的推演（AI 永远只替 'a' 方决策）；随机效果取**确定性近似**
       （如 dwb 并列最低时按“被摧毁的是自己那张”的悲观口径；gather 取成员平均战力），
       因此估值允许与真实结算存在少量偏差——它只用于选点，不产生任何真实效果。
   ========================================================= */
'use strict';

/* =========================================================
   1) 难度档（v175：四档）
   ========================================================= */
const AI_LEVEL_TABLE = {
  // engine='legacy' → 走最初版的贪心 AI（aiThinkLegacy + hypotheticScore）；
  // engine='score'  → 走 v173 的影子盘面估值引擎（aiPlanMoves）。
  // beam=0 表示不做束搜索（走单张贪心）；band=估值随机带（分）；expand=每层每个计划保留的扩展数。
  // ⚠️ desc / tip 是设置界面**玩家可见文案的唯一数据源**（v174 起）：
  //    index.html 与 js/home.js 只读这里，不要在别处再写一份中文描述。
  //    v176：这两项**只写玩家能看到的难度感受**（压力大小、适合谁），**不透露算法与深浅**
  //    （不提搜索/束搜索、不提能不能看到暗牌、不提它不算什么效果）；技术口径写在 `tech`，
  //    只供控制台（`AI.levelInfo().tech` / `AI.policyText()`）与 docs 使用，不进设置界面、不进对局日志。
  easy: {
    key: 'easy', name: '简单', engine: 'legacy',
    hidden: true, fly: false, beam: 0, band: 3.0, maxSteps: 0, expand: 0,
    desc: '压力最小 · 适合先熟悉玩法与卡组',
    tip: '出牌比较随性，想轻松打一局、试新卡组时用它刚刚好。',
    tech: '最初版的贪心 AI（aiThinkLegacy + 旧公式 hypotheticScore）：只按印刷战力选点，不算揭示效果、不做回合级计划、不接受「不出牌」、反转区一律不落子、不使用移动',
  },
  normal: {
    key: 'normal', name: '普通', engine: 'score',
    hidden: false, fly: false, beam: 0, band: 3.0, maxSteps: 4, expand: 3,
    desc: '标准强度 · 正常发挥',
    tip: '会稳稳地把手牌打出来，适合日常对局。',
    tech: '单张贪心 + 效果估值（aiGreedyPlan）：只按已翻开估值（不看暗牌）、不移动',
  },
  hard: {
    key: 'hard', name: '困难', engine: 'score',
    hidden: false, fly: true, beam: 8, band: 2.0, maxSteps: 5, expand: 6,
    desc: '较强 · 出牌更有针对性',
    tip: '会盯着你的弱点下手，稍不留神就会被翻盘。',
    tech: '回合级束搜索（aiBeamPlan）+ 效果估值 + 只按已翻开估值（不看暗牌）+ 每回合可用一次移动',
  },
  lunatic: {
    key: 'lunatic', name: '月狂', engine: 'score',
    hidden: true, fly: true, beam: 12, band: 1.0, maxSteps: 6, expand: 8,
    desc: '最强 · 几乎不留余地',
    tip: '为想认真检验卡组与打法的玩家准备。',
    tech: '束搜索 + 效果估值 + 全量可见（includeHidden，能读到暗牌战力）+ 可移动 + 估值随机带更窄',
  },
};
const AI_LEVEL_KEY = 'touhou2.ai.level';
const AI_DEFAULT_LEVEL = 'easy';   // v175：默认「简单」（用户口径：设置里默认选简单模式）
// v175：v173 的旧档名 → 新档名（本地存储与网址参数都做兼容映射）
const AI_LEVEL_ALIAS = { nightmare: 'lunatic' };
let aiLevel = AI_DEFAULT_LEVEL;

function aiNormalizeLevel(k) {
  if (!k) return AI_DEFAULT_LEVEL;
  const key = AI_LEVEL_ALIAS[k] || k;
  return AI_LEVEL_TABLE[key] ? key : AI_DEFAULT_LEVEL;
}
function aiGetLevel() { return aiLevel; }
function aiMeta() { return AI_LEVEL_TABLE[aiLevel] || AI_LEVEL_TABLE[AI_DEFAULT_LEVEL]; }
/** 该档的**技术口径**一句话（v176：= 表里的 `tech`，只给控制台与文档用；
    玩家可见的中性说明在 `desc`/`tip`，设置界面只读那两项） */
function aiPolicyText(key) {
  const m = AI_LEVEL_TABLE[aiNormalizeLevel(key)];
  return m ? (m.tech || m.desc || '') : '';
}
/** 切换 AI 难度（控制台 / 调试用）：'easy'（简单）|'normal'（普通）|'hard'（困难）|'lunatic'（月狂），
    会记到 localStorage: touhou2.ai.level；v173 旧档名 'nightmare' 等价于 'lunatic'。 */
function aiSetLevel(k, opts) {
  const key = aiNormalizeLevel(k);
  const changed = key !== aiLevel;
  aiLevel = key;
  try { localStorage.setItem(AI_LEVEL_KEY, key); } catch (e) { /* 隐私模式等：忽略 */ }
  if ((!opts || opts.silent !== true) && changed) {
    // v176：日志用**中性**说明（desc），技术口径（tech）只在控制台可见
    const m = AI_LEVEL_TABLE[key];
    log('sys', `🤖 AI 难度已切换为「${m.name}」（${m.desc || ''}）。`);
  }
  return key;
}
(function aiInitLevel() {
  let key = null;
  try { key = localStorage.getItem(AI_LEVEL_KEY); } catch (e) { /* 忽略 */ }
  try {
    const q = (location.search || '').match(/[?&]ai=([a-z]+)/);
    const h = (location.hash || '').match(/ai=([a-z]+)/);
    const m = q || h;
    // 网址参数优先；只接受已知档名（含 v173 旧名 nightmare）
    if (m && (AI_LEVEL_TABLE[m[1]] || AI_LEVEL_ALIAS[m[1]])) key = m[1];
  } catch (e) { /* 忽略 */ }
  aiLevel = aiNormalizeLevel(key);
})();

/* =========================================================
   2) 影子盘面模型（层 1：估值用；纯函数、无副作用）
   ---------------------------------------------------------
   条目（entry）= 一张牌在模型里的样子：base 是「基础威力 + 永久 buff」（= cardPower），
   区域加成（aff/cb/all）与持续效果（og）在 mdPower 里**按当前所在地上限实时算**，
   因此 xform 换地形、换边、移动到别的区域都能正确重算。
   ========================================================= */
let aiVirtualSeq = 0;
// 模型内的“入场次序”计数器（v173）：用来判断某张牌在**另一张牌结算揭示的那一刻**是否已翻开
// ——同一回合内我方多张牌的翻开顺序 = 放置顺序，因此「后放的牌」吃不到先结算的 buff（bf/ba 口径）。
let aiSeq = 0;
// 衍生物法术的递归保护（法术 token 落场即结算揭示；理论上若数据写出“自生成”也不会死循环）
let aiSpellDepth = 0;

/** 模型内的“此刻已翻开”判定：真实已翻开，或本回合放置且先于 e 入场（放置顺序＝翻牌顺序） */
function mdRevealedAt(x, e) {
  return !!x.revealed || (x.willReveal && x.seq < e.seq);
}
/** 同上，但把 e 自己视为“刚翻开”（如 shift 会把施放者一起搬走） */
function mdRevealedNow(x, e) {
  return x.uid === e.uid || mdRevealedAt(x, e);
}

function mdEntry(card) {
  const d = card.def;
  const e = {
    uid: card.id,                    // 模型内唯一标识（真实卡用卡实例 id，虚拟卡用 'v<n>'）
    id: card.id,
    seq: ++aiSeq,                    // 模型内入场次序（供“结算时刻是否已翻开”判定）
    ref: card,
    def: d,
    base: cardPower(card),           // 基础威力 + 永久 buff（法术为 0）
    g: d.g || null,
    c: d.c,
    tk: d.tk || null,
    un: !!d.un,
    spell: isSpell(card),
    occ: isSpell(card) ? 1 : (d.occ || 1),
    revealed: !!card.revealed,
    willReveal: false,               // 本回合新放置（回合末会翻开）
    bonus: 0,                        // 估值修正：非战力类价值（能量加速/加费/持续防护等）
    leave: !!d.leave,
    prot: !!d.prot,
    surv: d.surv || 0,
    phx: d.phx || 0,
    fly: !!d.fly,
  };
  // ---- 非战力类价值的粗略折算（只影响 AI 的排序，不改变引擎数值）----
  if (d.prot) e.bonus += 0.6;                                  // 卡级免摧毁（蕾蒂）：保护本区
  if (e.surv) e.bonus += 0.3 * e.surv;                         // 防摧毁：抗一次摧毁
  if (e.phx) e.bonus += 0.4 * e.phx;                           // 凤凰重生：后续还能回收
  if (d.fx && d.fx.turnStart && d.fx.turnStart.k === 'drawSpell') {
    e.bonus += 0.8 * Math.max(0, 6 - state.turn);              // 法术调度：后续每回合多一张牌
  }
  return e;
}
/** 虚拟卡（生成的 token / 平均代表）条目 */
function mdTokenEntry(tkDef, snapPower) {
  const d = tkDef || {};
  return {
    uid: 'v' + (aiVirtualSeq++),
    id: null,
    seq: ++aiSeq,
    ref: null,
    def: d,
    base: (typeof snapPower === 'number') ? snapPower : (d.p || 0),
    g: d.g || null,
    c: d.c,
    tk: d.tk || null,
    un: !!d.un,
    spell: !!d.spell,
    occ: d.spell ? 1 : (d.occ || 1),
    revealed: true,
    willReveal: false,
    bonus: 0,
    leave: !!d.leave,
    prot: !!d.prot,
    surv: d.surv || 0,
    phx: d.phx || 0,
    fly: !!d.fly,
  };
}
function mdClone(m) {
  const out = { turn: m.turn, zones: [] };
  for (const z of m.zones) {
    out.zones.push({ def: z.def, p: z.p.map((e) => Object.assign({}, e)), a: z.a.map((e) => Object.assign({}, e)) });
  }
  return out;
}
/** 从真实 state 建一份只读影子盘面 */
function mdBuild() {
  const m = { turn: state.turn, zones: [] };
  for (let j = 0; j < 3; j++) {
    const z = { def: locDef(j), p: [], a: [] };
    for (const s of ['p', 'a']) {
      for (const c of state.players[s].zones[j]) z[s].push(mdEntry(c));
    }
    m.zones.push(z);
  }
  return m;
}
function mdOther(side) { return side === 'p' ? 'a' : 'p'; }
/** 该区域当前是否开放（限回合地形：七夕坂等） */
function mdOpen(m, j) {
  const mt = m.zones[j].def.minTurn;
  return !mt || state.turn >= mt;
}
/** 占格数：post=true 时法术不再占格（揭示后即消散） */
function mdUsed(zone, side, post) {
  let u = 0;
  for (const e of zone[side]) {
    if (post && e.spell) continue;
    u += e.occ || 1;
  }
  return u;
}
function mdRoom(m, j, side, post) { return (m.zones[j].def.max || 4) - mdUsed(m.zones[j], side, post); }
/** 该条目在当前估值口径下是否计入（普通/困难档不看对手暗牌；月狂档全量可见；
    简单档不走本模型，它在 aiThinkLegacy 里直接用 includeHidden 的旧口径） */
function mdCounted(side, e, meta) {
  if (e.un || e.spell) return false;
  if (side === 'a') return true;                     // AI 自己的牌（含自己刚放的暗牌）它都知道
  return !!(e.revealed || e.willReveal || meta.hidden);
}
function mdZoneBonus(def, e) {
  let b = 0;
  if (def.aff && e.g && e.g === def.aff.group) b += def.aff.add;
  if (def.cb && e.c === def.cb.c) b += def.cb.add;
  if (def.all) b += def.all;
  return b;
}
/** 条目在 (m,j,side) 的实时估值战力 = 基础+永久 + 区域加成 + 持续效果 + 估值修正 */
function mdPower(m, j, side, e) {
  if (e.un || e.spell) return 0;
  let p = e.base + mdZoneBonus(m.zones[j].def, e) + (e.bonus || 0);
  if (e.tk) {
    for (let k = 0; k < 3; k++) {
      for (const o of m.zones[k][side]) {
        if (o.uid === e.uid || o.spell || o.un || !o.def.og) continue;
        if (!(o.revealed || o.willReveal)) continue;
        if (o.def.og.tk === e.tk) p += o.def.og.add;
      }
    }
  }
  return p;
}
/** 该侧在本区的总点数（含放满加成，口径对齐引擎 zoneTotals） */
function mdZoneRaw(m, j, side, meta) {
  const z = m.zones[j];
  let t = 0;
  for (const e of z[side]) {
    if (!mdCounted(side, e, meta)) continue;
    t += mdPower(m, j, side, e);
  }
  const def = z.def;
  if (def.fill && mdUsed(z, side, true) >= (def.max || 4)) t += def.fill;
  return t;
}
/** 该侧在本区的有效点数（×dbl；反转区取负——与引擎 zoneEff 同口径） */
function mdEff(m, j, side, meta) {
  const t = mdZoneRaw(m, j, side, meta) * (m.zones[j].def.dbl || 1);
  return m.zones[j].def.inv ? -t : t;
}
function mdNoDestroy(m, j, meta) {
  const z = m.zones[j];
  if (z.def.prot) return true;                     // 地形级免摧毁（睡鼠神祠）
  for (const s of ['p', 'a']) {
    for (const e of z[s]) {
      if (!e.prot) continue;
      if (s === 'a' || e.revealed || meta.hidden) return true; // 蕾蒂（自己的一定知道）
    }
  }
  return false;
}
function mdVisible(m, j, side, meta) {
  return m.zones[j][side].filter((x) => mdCounted(side, x, meta) && !x.un && !x.spell);
}

/* ---------- 地形投影：把「本回合末」的盘面算进估值 ----------
   严格按引擎阶段 ⑤-0 的顺序：grow/decay → rally（指定回合）→ purge → collapse。
   dice/gamble 为对称随机（期望 0）不投影；gust 的位移随机不投影。 */
function mdProject(m, meta) {
  const out = mdClone(m);
  for (let j = 0; j < 3; j++) {
    const z = out.zones[j];
    const def = z.def;
    // ① grow 成长 / decay 衰减（本区所有计入的卡 ±N）
    const delta = (def.grow || 0) - (def.decay || 0);
    if (delta) {
      for (const s of ['p', 'a']) for (const e of z[s]) if (mdCounted(s, e, meta)) e.base += delta;
    }
    // ② rally 定时加成（指定回合末，双方所有已翻开卡 +add）
    if (def.rally && def.rally.turn === out.turn && def.rally.add) {
      for (const s of ['p', 'a']) for (const e of z[s]) if (mdCounted(s, e, meta)) e.base += def.rally.add;
    }
    // ③ leave 终局离场（稗田阿求）：最后一回合其战力不计入终局
    if (out.turn >= 6) {
      for (const s of ['p', 'a']) z[s] = z[s].filter((e) => !(e.leave && mdCounted(s, e, meta)));
    }
  }
  // ④ purge 回合末摧毁（本区最低战力并列全删；被免摧毁保护则跳过）
  for (let j = 0; j < 3; j++) {
    const z = out.zones[j];
    if (!z.def.purge || mdNoDestroy(out, j, meta)) continue;
    const both = [];
    for (const s of ['p', 'a']) for (const e of mdVisible(out, j, s, meta)) both.push({ s, e });
    if (!both.length) continue;
    let min = Infinity;
    for (const it of both) min = Math.min(min, mdPower(out, j, it.s, it.e));
    for (const it of both) {
      if (mdPower(out, j, it.s, it.e) !== min) continue;
      z[it.s] = z[it.s].filter((x) => x.uid !== it.e.uid);
    }
  }
  // ⑤ collapse 回合结束崩塌（双方总张数达标 → 换成目标地形；上限不够则不塌）
  for (let j = 0; j < 3; j++) {
    const z = out.zones[j];
    const col = z.def.collapse;
    if (!col) continue;
    const target = findLocDef(col.to);
    if (!target) continue;
    const cnt = z.p.filter((e) => !e.spell).length + z.a.filter((e) => !e.spell).length; // 法术在 ⑤-0 前已消散
    if (cnt < col.cards) continue;
    if (['p', 'a'].some((s) => mdUsed(z, s, true) > target.max)) continue;
    z.def = target;
  }
  return out;
}

/* ---------- 估值函数：与引擎胜负口径一致（对标 finishMatch） ----------
   硬价值：赢局 +1000 / 输局 −1000（存在平局区时改看三区有效点数之和）
   软价值：三区有效点数差之和 + 领先区域数的小奖励（中盘引导与同分排序） */
const AI_WIN_VALUE = 1000;
function mdEvaluate(m, meta, project) {
  const mm = project ? mdProject(m, meta) : m;
  let myW = 0, opW = 0, ties = 0, margin = 0;
  for (let j = 0; j < 3; j++) {
    const w = mm.zones[j].def.wt || 1;
    const me = mdEff(mm, j, 'a', meta);
    const op = mdEff(mm, j, 'p', meta);
    if (me > op) myW += w; else if (op > me) opW += w; else ties += w;
    margin += me - op;
  }
  const h = ties > 0
    ? (margin > 0 ? 1 : margin < 0 ? -1 : 0)
    : (myW > opW ? 1 : opW > myW ? -1 : 0);
  return h * AI_WIN_VALUE + margin + (myW - opW) * 1.5;
}

/* =========================================================
   3) 效果模拟（把一张牌的「揭示」按引擎口径作用到影子盘面上）
   ========================================================= */
/** 向 (j, side) 一侧添加 n 张 token；返回实际放入张数 */
function mdAddToken(m, meta, side, j, tkDef, n, snapPower) {
  let added = 0;
  for (let i = 0; i < n; i++) {
    if (mdRoom(m, j, side, false) < 1) break;
    const te = mdTokenEntry(tkDef, snapPower);
    m.zones[j][side].push(te);
    added++;
    if (te.spell) {
      // 落场生成的衍生物法术：等同手打一张——先结算揭示，随即消散（不留在场上）
      m.zones[j][side] = m.zones[j][side].filter((x) => x.uid !== te.uid);
      if (aiSpellDepth < 3) {
        aiSpellDepth++;
        mdApplyKey(m, meta, side, j, te.def, te);
        aiSpellDepth--;
      }
    }
  }
  return added;
}
/** 地形「出现时」生成（xform 转成带 spawn 的地形 / collapse 之后） */
function mdApplyAppear(m, meta, j, ldef) {
  const sp = ldef && ldef.spawn;
  if (!sp) return;
  const n = sp.n || 1;
  if (sp.card) {
    const tk = TOKENS[sp.card];
    if (!tk) return;
    mdAddToken(m, meta, 'p', j, tk, n);
    mdAddToken(m, meta, 'a', j, tk, n);
    return;
  }
  if (typeof sp.cost === 'number') {
    const cands = (POOL[sp.cost] || []).filter((d) => d && !d.un && (d.occ || 1) <= 1);
    if (!cands.length) return;
    let sum = 0;
    for (const d of cands) sum += d.p || 0;
    const avgDef = { n: `平均${sp.cost}费卡`, p: sum / cands.length, c: sp.cost, k: '', i: '✦' };
    mdAddToken(m, meta, 'p', j, avgDef, n);
    mdAddToken(m, meta, 'a', j, avgDef, n);
  }
}
/** 摧毁一个模型条目的统一处理：surv → 改为永久 −N 留在场；phx → 离场（回手，近似为离场）；否则移除 */
function mdDestroyEntry(m, j, side, e) {
  const z = m.zones[j][side];
  if (e.surv) { e.base -= e.surv; return; }        // 防摧毁：不离场，取代为永久降战力
  m.zones[j][side] = z.filter((x) => x.uid !== e.uid);
}
/**
 * 结算一个效果键（揭示/时机效果条目同构）：把结果写进影子盘面。
 * side = 施放者所属方；j = 所在区域；def = 效果规格（fx 条目或整张卡的 def）；e = 施放者条目。
 * 未实现的键（unknown/''）不产生变化——卡本身的战力已在 base 里。
 */
function mdApplyKey(m, meta, side, j, def, e) {
  const other = mdOther(side);
  const a = def.a || 0;
  switch (def.k) {
    case 'bf': {
      for (const x of m.zones[j][side]) {
        if (x.uid === e.uid || x.un || x.spell) continue;
        if (!mdRevealedAt(x, e)) continue;      // 口径同引擎：只作用于结算那一刻已翻开的牌
        x.base += a;
      }
      break;
    }
    case 'de': {
      for (const x of mdVisible(m, j, other, meta)) x.base -= a;
      break;
    }
    case 'ba': {
      for (const s of ['p', 'a']) {
        for (const x of m.zones[j][s]) {
          if (x.un || x.spell) continue;
          if (s === side) { if (x.uid !== e.uid && !mdRevealedAt(x, e)) continue; } // 含施放者自身（引擎口径）
          else if (!mdCounted(s, x, meta)) continue;
          x.base += a;
        }
      }
      break;
    }
    case 'bl': {
      if (e.spell) break;
      if (mdEff(m, j, side, meta) < mdEff(m, j, other, meta)) e.base += a;
      break;
    }
    case 'oc': {
      if (e.spell) break;
      if (movesForSide(other).some((mv) => mv.loc === j)) e.base += a;
      break;
    }
    case 'dw':
    case 'dwh': {
      const cand = mdVisible(m, j, other, meta);
      if (!cand.length || mdNoDestroy(m, j, meta)) break;
      let best = null;
      let bestP = def.k === 'dw' ? Infinity : -Infinity;
      for (const x of cand) {
        const p = mdPower(m, j, other, x);
        if (def.k === 'dw' ? p < bestP : p > bestP) { bestP = p; best = x; }
      }
      if (best) mdDestroyEntry(m, j, other, best);
      break;
    }
    case 'dwb': {
      const both = [];
      for (const s of ['p', 'a']) for (const x of mdVisible(m, j, s, meta)) both.push({ s, e: x });
      if (!both.length || mdNoDestroy(m, j, meta)) break;
      let min = Infinity;
      for (const it of both) min = Math.min(min, mdPower(m, j, it.s, it.e));
      const lows = both.filter((it) => mdPower(m, j, it.s, it.e) === min);
      // 引擎在并列最低里**随机**挑一张；AI 取悲观近似：并列时认为被毁的是自己那张
      const hit = lows.find((it) => it.s === side) || lows[0];
      mdDestroyEntry(m, j, hit.s, hit.e);
      break;
    }
    case 'spawn': {
      const sp = def.spawn;
      const tk = sp && TOKENS[sp.card];
      if (tk) {
        const n = sp.n || 1;
        mdAddToken(m, meta, side, j, tk, n);
        mdAddToken(m, meta, other, j, tk, n);
      }
      break;
    }
    case 'spawnO': {
      const sp = def.spawnO;
      const tk = sp && TOKENS[sp.card];
      if (tk) mdAddToken(m, meta, other, j, tk, sp.n || 1);
      break;
    }
    case 'spawnS': {
      const sp = def.spawnS;
      const tk = sp && TOKENS[sp.card];
      if (tk) mdAddToken(m, meta, side, j, tk, sp.n || 1);
      break;
    }
    case 'clone': {
      const sp = def.clone;
      const tk = sp && TOKENS[sp.card];
      if (!tk) break;
      // 引擎按本卡**揭示时 cardPower**（基础+永久）快照对齐分身战力
      for (let k = 0; k < 3; k++) {
        if (k === j || !mdOpen(m, k)) continue;
        mdAddToken(m, meta, side, k, tk, sp.n || 1, e.base);
      }
      break;
    }
    case 'gather': {
      const gw = def.gather;
      const group = gw && gw.group;
      const members = gatherMembers(group);
      if (!members.length) break;
      // 引擎随机抽 3 张互不相同的成员；估值为期望近似：用成员平均战力代表每一区生成的那张
      let sum = 0;
      for (const d of members) sum += d.p || 0;
      const avgDef = { n: `平均成员（${members.length} 选 3）`, p: sum / members.length, c: 1, k: '', i: '✦', g: group };
      for (let k = 0; k < 3; k++) {
        if (!mdOpen(m, k)) continue;
        mdAddToken(m, meta, side, k, avgDef, 1);
      }
      const add = (gw && gw.add) || 0;
      if (add) {
        for (let k = 0; k < 3; k++) {
          for (const x of m.zones[k][side]) {
            if (x.spell || x.un || x.g !== group) continue;
            if (!mdRevealedAt(x, e)) continue;   // 后放的牌在法术结算那一刻还没翻开
            x.base += add;
          }
        }
      }
      break;
    }
    case 'switch': {
      if (mdRoom(m, j, other, false) < (e.occ || 1)) break;   // 对方该区放满 → 换边失败
      m.zones[j][side] = m.zones[j][side].filter((x) => x.uid !== e.uid);
      e.revealed = true;
      e.willReveal = false;
      m.zones[j][other].push(e);
      break;
    }
    case 'gift': {
      if (mdRoom(m, j, other, false) < 1) break;
      const own = m.zones[j][side].filter((x) => x.uid !== e.uid && !x.un && !x.spell && mdRevealedAt(x, e));
      if (!own.length) break;
      let low = own[0];
      let lowP = mdPower(m, j, side, low);
      for (const x of own) {
        const p = mdPower(m, j, side, x);
        if (p < lowP) { lowP = p; low = x; }
      }
      m.zones[j][side] = m.zones[j][side].filter((x) => x.uid !== low.uid);
      low.revealed = true;
      low.willReveal = false;
      m.zones[j][other].push(low);
      break;
    }
    case 'mv': {
      const cand = mdVisible(m, j, other, meta);
      if (!cand.length) break;
      let low = cand[0];
      let lowP = mdPower(m, j, other, low);
      for (const x of cand) {
        const p = mdPower(m, j, other, x);
        if (p < lowP) { lowP = p; low = x; }
      }
      for (let k = 0; k < 3; k++) {
        if (k === j || !mdOpen(m, k)) continue;
        if (mdRoom(m, k, other, false) < (low.occ || 1)) continue;
        m.zones[j][other] = m.zones[j][other].filter((x) => x.uid !== low.uid);
        m.zones[k][other].push(low);
        break;
      }
      break;
    }
    case 'shift': {
      const movers = m.zones[0][side].filter((x) => !x.un && !x.spell && mdRevealedNow(x, e));
      for (const x of movers) {
        if (mdRoom(m, 2, side, false) < (x.occ || 1)) break;
        m.zones[0][side] = m.zones[0][side].filter((y) => y.uid !== x.uid);
        m.zones[2][side].push(x);
      }
      break;
    }
    case 'roam': {
      for (let k = 0; k < 3; k++) {
        if (k === j || !mdOpen(m, k)) continue;
        if (mdRoom(m, k, side, false) < (e.occ || 1)) continue;
        m.zones[j][side] = m.zones[j][side].filter((x) => x.uid !== e.uid);
        m.zones[k][side].push(e);
        break;
      }
      break;
    }
    case 'xform': {
      const target = findLocDef(def.xf);
      if (!target) break;
      // 引擎用 sideUsed 判定（含当场仍占格的法术），故这里按“未消散”的占格口径
      if (['p', 'a'].some((s) => mdUsed(m.zones[j], s, false) > target.max)) break;
      const prev = m.zones[j].def;
      m.zones[j].def = target;
      if (prev !== target) mdApplyAppear(m, meta, j, target); // v151：变形＝该地形在本区“出现”
      break;
    }
    case 'morph': {
      // 引擎：变成对方手牌随机一张的复制体。随机结果不可预知——月狂档（全量可见）取对方
      // 手牌的平均战力，其余档取经验先验 3 点（新卡的揭示不再二次推演）。
      const hand = state.players[other].hand;
      let est = 3;
      if (meta.hidden && hand.length) {
        let s = 0;
        for (const c of hand) s += cardPower(c);
        est = s / hand.length;
      }
      e.base = est;
      break;
    }
    case 'costUp': e.bonus += 0.8 * (a || 1); break;       // 加费：拖慢对方下回合节奏
    case 'energyNext': e.bonus += 1.0 * (a || 1); break;   // 下回合额外能量：节奏值
    case 'give': e.bonus += 0.5 * ((def.give && def.give.n) || 1); break;
    default: break;
  }
}

/** 推演「把 card 暗出到 locIdx」（不含其它手牌）后的影子盘面 */
function mdSimulatePlay(m0, meta, card, locIdx) {
  const m = mdClone(m0);
  const e = mdEntry(card);
  e.revealed = false;
  e.willReveal = true;                 // 回合末翻面 → 计入估值
  m.zones[locIdx].a.push(e);
  mdApplyKey(m, meta, 'a', locIdx, card.def, e);
  return m;
}
/** 模型内搬家（供 AI 的 fly 移动估值） */
function mdRelocate(m, cardId, from, to, side) {
  const src = m.zones[from][side];
  const i = src.findIndex((e) => e.id === cardId);
  if (i < 0) return false;
  const [e] = src.splice(i, 1);
  m.zones[to][side].push(e);
  return true;
}

/* =========================================================
   4) 回合级计划（层 2）：候选 =（手牌 × 合法区域）∪「不出牌」
   ========================================================= */
/** 手牌能否落到该区（口径对齐 tryPlayAt：开放 / 大体积占格 / 该侧空位） */
function mdLegalZones(m, meta, card) {
  const out = [];
  const occ = occOf(card);
  for (let j = 0; j < 3; j++) {
    if (!mdOpen(m, j)) continue;
    const def = m.zones[j].def;
    if (occ > 1 && def.max !== occ) continue;          // 大体积卡只进上限恰为占格数的区域
    if (mdRoom(m, j, 'a', false) < occ) continue;
    out.push(j);
  }
  return out;
}
/** 单张贪心（普通档）：逐张挑当前增量最大的一手；增量不足则停手 */
function aiGreedyPlan(meta, m0, affordable) {
  let m = m0;
  let energy = state.players.a.energyLeft;
  let score = mdEvaluate(m0, meta, true);
  const baseScore = score;
  const plays = [];
  const used = {};
  for (let step = 0; step < meta.maxSteps; step++) {
    let best = null;
    for (const o of affordable) {
      if (used[o.card.id] || o.cost > energy) continue;
      for (const j of mdLegalZones(m, meta, o.card)) {
        const m2 = mdSimulatePlay(m, meta, o.card, j);
        const sc = mdEvaluate(m2, meta, true);
        if (!best || sc > best.score) best = { m: m2, score: sc, card: o.card, loc: j, cost: o.cost };
      }
    }
    if (!best) break;
    if (best.score < score - meta.band) break;          // 只会让局面变差 → 宁可不出牌
    plays.push({ card: best.card, loc: best.loc, cost: best.cost, gain: best.score - score });
    used[best.card.id] = 1;
    m = best.m;
    energy -= best.cost;
    score = best.score;
    if (energy <= 0) break;
  }
  return { plays, score, model: m, baseScore };
}
/** 束搜索（困难 / 月狂）：保留前 N 个计划，能规划「多张小牌分头翻转多区」这类组合 */
function aiBeamPlan(meta, m0, affordable) {
  const baseScore = mdEvaluate(m0, meta, true);
  const steps = Math.min(meta.maxSteps, affordable.length);
  let beam = [{ m: m0, energy: state.players.a.energyLeft, plays: [], used: {}, score: baseScore }];
  for (let step = 0; step < steps; step++) {
    const next = [];
    for (const st of beam) {
      next.push(st);                                    // 「不再出牌」永远是一个合法选项
      const ex = [];
      for (const o of affordable) {
        if (st.used[o.card.id] || o.cost > st.energy) continue;
        for (const j of mdLegalZones(st.m, meta, o.card)) {
          const m2 = mdSimulatePlay(st.m, meta, o.card, j);
          const sc = mdEvaluate(m2, meta, true);
          const used2 = Object.assign({}, st.used);
          used2[o.card.id] = 1;
          ex.push({
            m: m2, energy: st.energy - o.cost, used: used2, score: sc,
            plays: st.plays.concat([{ card: o.card, loc: j, cost: o.cost, gain: sc - st.score }]),
          });
        }
      }
      if (!ex.length) continue;
      ex.sort((x, y) => y.score - x.score);
      // 剪枝：取前 expand 个，并保证每张手牌至少有一个代表（避免漏掉组合拳里的关键一张）
      const keep = [];
      const seenCard = {};
      for (const it of ex) {
        const cid = it.plays[it.plays.length - 1].card.id;
        if (keep.length >= meta.expand) {
          if (seenCard[cid]) continue;
          if (keep.length >= meta.expand + 3) break;
        }
        keep.push(it);
        seenCard[cid] = 1;
      }
      for (const k of keep) next.push(k);
    }
    // 同一组落子（顺序不同）只留一个 → 按 卡id@区域 排序去重，再取前 beam 宽
    const seen = {};
    const pruned = [];
    for (const it of next) {
      const key = it.plays.map((p) => p.card.id + '@' + p.loc).sort().join('|');
      if (seen[key]) continue;
      seen[key] = 1;
      pruned.push(it);
    }
    pruned.sort((x, y) => y.score - x.score);
    beam = pruned.slice(0, meta.beam);
  }
  beam.sort((x, y) => y.score - x.score);
  const best = beam[0].score;
  const band = beam.filter((it) => it.score >= best - meta.band); // 估值随机带：保留一点变化
  const pick = band[Math.floor(Math.random() * band.length)];
  return { plays: pick.plays, score: pick.score, model: pick.m, baseScore };
}
function aiPlanMoves(meta) {
  const pl = state.players.a;
  const m0 = mdBuild();
  const affordable = pl.hand
    .map((c) => ({ card: c, cost: cardCost(c) }))
    // v196：卡级放置条件（`playReq`，现仅 6 费「大鲶鱼」）——与玩家路径同一个校验收口
    //   （`js/game.js` 的 playReqCheck）：AI 自己场上已翻开的石块 < 4 张时，这张牌不进候选，
    //   免得计划把能量预算花在打不出来的牌上（执行前还会再复核一次，见 aiThinkScoreEngine）。
    .filter((o) => o.cost <= pl.energyLeft && playReqCheck('a', o.card).ok);
  const baseScore = mdEvaluate(m0, meta, true);
  if (!affordable.length) return { plays: [], score: baseScore, model: m0, baseScore };
  return meta.beam ? aiBeamPlan(meta, m0, affordable) : aiGreedyPlan(meta, m0, affordable);
}

/* =========================================================
   5) 决策理由文案（只用于对局日志，便于人工核对 AI 在想什么）
   ========================================================= */
const AI_KEY_TIP = {
  '': '纯战力（无效果）',
  bf: '同区友军增益',
  de: '削弱同区对方',
  ba: '同区双方同增',
  bl: '落后自增（条件牌）',
  dw: '摧毁同区对方最弱卡',
  dwh: '摧毁同区对方最强卡',
  dwb: '摧毁本区双方最弱一张（有反噬风险）',
  spawn: '本区双方各生成 token',
  spawnO: '给对面塞负面 token',
  spawnS: '本区自己一侧生成 token',
  clone: '另两区生成分身',
  switch: '换边（负战力送给对方）',
  gift: '送己方最低卡给对方（劣势效果）',
  morph: '变身成对方手牌随机一张',
  mv: '把对方最弱卡移走',
  give: '加入手牌衍生物',
  xform: '区域变形',
  oc: '对方同区落过牌则自增（条件牌）',
  shift: '己方左端已翻开卡整体右移',
  roam: '自身漂移到随机区域',
  costUp: '让对方手牌涨价（节奏）',
  energyNext: '下回合额外能量（节奏）',
  gather: '集结三区生成并强化',
  drawSpell: '回合开始抽法术',
};
function aiReasonText(card, locIdx) {
  const def = card.def;
  const def0 = state.locs[locIdx] && state.locs[locIdx].def;
  const parts = [];
  if (isSpell(card)) parts.push('法术（揭示后消散）');
  parts.push(AI_KEY_TIP[def.k] || '有特殊效果');
  if (def.occ > 1) parts.push(`大体积占 ${def.occ} 格`);
  // v196：卡级放置条件（`playReq`，现仅「大鲶鱼」）——避免把这张牌说成“纯战力（无效果）”
  if (def.playReq) parts.push(`放置条件：需己方场上 ≥${def.playReq.n || 1} 张已翻开的「${tokenNameLabel(def.playReq.tk)}」`);
  if (def0 && def0.inv) parts.push('反转区：压低点数');
  if (def0 && def0.purge) parts.push('反应炉：小心回合末摧毁最低牌');
  if (def0 && def0.fill) parts.push('该区放满有额外加成');
  return parts.join(' · ');
}
function aiFmtGain(g) {
  const s = (g >= 0 ? '+' : '') + (Math.round(g * 10) / 10);
  return Math.abs(g) >= 100 ? '★ ' + s : s;
}

/* =========================================================
   6) 简单档：最初版（v117~v172）的贪心 AI —— **原样恢复**
   ---------------------------------------------------------
   `hypotheticScore` + `aiThinkLegacy` 就是当年那一套，一字未改地搬回来：
     · hypotheticScore：只把每张牌当「印刷战力 + 永久 buff + 区域加成」，
       逐区算 (我方点数 − 对方点数) 的有效差（反转区取负），领先 +5 / 落后 −3，
       按地形 wt 加权求和；只看这一手放下去后的**点数变化**。
     · aiThinkLegacy：贪心循环——只要负担得起就继续出，每轮枚举（手牌 × 3 区），
       取分最高、并在 ±3 分内随机挑一个；三条硬编码策略照旧：
       ① 反转区（辉针城 inv）**一律不落子**；② 鬼人正邪（xform→needle）仅在己方
       落后该区 ≥10 点时打；③ 聚变反应炉落子估值 **×0.25**。
   「笨」在哪（与 v173 新引擎的差别，也就是它作为最简单一档的理由）：
     · 不算揭示效果：de/dw/dwh/spawn/spawnO/clone/switch/gift/mv/gather… 全按 0 或印刷战力计；
     · 不按真实胜负口径排序：只最大化「三区优势之和」，不知道「赢 2 区＝赢局」；
     · 不做回合级计划、也**不接受「不出牌」**：只要负担得起就一定会出（0 力牌、有害
       法术、会被自己效果反噬的牌照出）；
     · 反转区直接弃守；不使用「每回合移动一次」；
     · 法术按 0 战力估值 → 在它手里多数会闲置。
   ⚠️ 与当年唯一的不同：**不主动加倍**（且不跟进玩家的双倍）——v173 起四档一致，
      当时 aiThink 里的「视角势随机双倍下注」段没有恢复；需要恢复的话告诉我。
   ⚠️ 它沿用当年的信息口径：`zoneTotals(..., true)` 即 **includeHidden 全量可见**
      （能读到你的暗牌点数），这也是当年就有的行为。
   ========================================================= */
// 单张卡的假设落子估值（**最初版口径**）：把 card 放到 locIdx 后，按各区“有效口径”算综合收益。
// 反转区（inv）数值更低反而领先，故对其差值取负（低者胜口径），与 zoneEff / 胜负结算保持一致。
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

/** 简单档的落子循环（最初版逻辑；不含主动加倍段——见上方说明） */
function aiThinkLegacy(meta) {
  const st = state;
  const pl = st.players.a;
  let spent = 0;
  // 贪心循环：把本方剩余能量花完为止（v145：读 players.a 独立能量）
  while (true) {
    const rem = pl.energyLeft;
    const affordable = pl.hand.filter((c) => cardCost(c) <= rem && playReqCheck('a', c).ok); // v196：放置条件
    if (affordable.length === 0) break;
    const cands = [];
    for (const card of affordable) {
      // 区域变形到辉针城的卡（鬼人正邪）只在自己落后该区 ≥10 点时考虑
      const isNeedle = card.def.k === 'xform' && card.def.xf === 'needle';
      for (let j = 0; j < 3; j++) {
        if (sideRoom('a', j) < occOf(card)) continue; // 占格口径：大体积卡需要整区空位（occ4 只进 max4 空区）
        if (!locOpen(j)) continue;
        // 反转区（辉针城 inv）胜者 = 点数更低的一方，本档不主动往该区放牌，
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
    const paid = cardCost(pick.card);
    pick.card.side = 'a';
    pl.zones[pick.loc].push(pick.card);
    enqueueField(pick.card); // 对手暗出：进入场上放置顺序队列（v55）
    pl.hand.splice(pl.hand.indexOf(pick.card), 1);
    pl.energyLeft -= paid;
    st.aiMoves.push({ cardId: pick.card.id, loc: pick.loc });
    spent += paid;
    log('a', `🤖 对手在「${st.locs[pick.loc].def.n}」暗出「${pick.card.def.n}」(${paid}费) — 旧版估值 ${aiFmtGain(pick.score)}：只按印刷战力选点（简单档不计算卡牌效果）`);
  }
  if (st.aiMoves.length === 0) {
    log('a', `🤖 AI（${meta.name}）没有可打出的牌，选择跳过。`);
  } else {
    log('a', `🤖 AI（${meta.name}）本回合暗出 ${st.aiMoves.length} 张 · 花费 ${spent} 能量（剩余 ${pl.energyLeft}）`);
  }
}

/* =========================================================
   7) 执行：把计划落到真实盘面（镜像 tryPlayAt 的口径）
   ========================================================= */
let aiLoggedGen = -1;
function aiLogLevelOnce(meta) {
  if (aiLoggedGen === state.gen) return;
  aiLoggedGen = state.gen;
  // v176：日志只写**中性**的难度说明（= desc），不暴露算法与深浅；
  // 技术口径可用控制台 AI.levelInfo().tech / AI.policyText() 查看。
  log('sys', `🤖 对手 AI 难度：${meta.name}（${meta.desc || ''}）。想调整：主页面「⚙️ 设置」。`);
}

/** v173：每回合可移动一次（射命丸文 fly）——只在困难 / 月狂档启用 */
function aiFlyMove(meta) {
  const st = state;
  const pl = st.players.a;
  const movers = [];
  for (let j = 0; j < 3; j++) {
    for (const c of pl.zones[j]) {
      if (!c.revealed || !c.def.fly || st.flyMoved.has(c.id)) continue;
      movers.push({ card: c, from: j });
    }
  }
  if (!movers.length) return false;
  const m0 = mdBuild();
  const base = mdEvaluate(m0, meta, true);
  let best = null;
  for (const mv of movers) {
    for (let to = 0; to < 3; to++) {
      if (to === mv.from || !mdOpen(m0, to)) continue;
      if (mdRoom(m0, to, 'a', false) < occOf(mv.card)) continue;
      const m2 = mdClone(m0);
      if (!mdRelocate(m2, mv.card.id, mv.from, to, 'a')) continue;
      const sc = mdEvaluate(m2, meta, true);
      if (!best || sc > best.score) best = { card: mv.card, from: mv.from, to, score: sc };
    }
  }
  if (!best || best.score - base <= 1) return false;      // 移动无收益则不动
  const srcEl = miniCardElById(best.card.id);
  const srcRect = (srcEl && srcEl.isConnected) ? srcEl.getBoundingClientRect() : null;
  const src = pl.zones[best.from];
  const i = src.indexOf(best.card);
  if (i < 0) return false;
  src.splice(i, 1);
  pl.zones[best.to].push(best.card);
  st.flyMoved.add(best.card.id);
  st.flyMovedFrom[best.card.id] = best.from;
  log('a', `🤖 对手把「${best.card.def.n}」移动到了「${st.locs[best.to].def.n}」（估值 ${aiFmtGain(best.score - base)}：每回合一次的移动能力）。`);
  if (srcRect && typeof flyCardTo === 'function') {
    // 等 playRound 的 renderAll() 跑完再放“滑行+缩放”演出（flyCardTo 内部按卡 id 找新格位）
    setTimeout(() => { try { flyCardTo(best.card, srcRect); } catch (e) { /* 演出失败不影响对局 */ } }, 0);
  }
  return true;
}

/** v173 新引擎的单张落子估值增量（供调试探针 AI._delta 用；
    注意与简单档的 hypotheticScore 是两套口径：这个会推演揭示效果与地形） */
function aiModelDelta(card, locIdx) {
  const meta = aiMeta();
  const m0 = mdBuild();
  const m2 = mdSimulatePlay(m0, meta, card, locIdx);
  return mdEvaluate(m2, meta, true) - mdEvaluate(m0, meta, true);
}

/** 对手回合的决策入口（playRound 阶段 ③ 调用）：按当前难度档分派引擎 */
function aiThink() {
  const meta = aiMeta();
  aiLogLevelOnce(meta);
  // v173：AI **不再加倍**（不主动双倍下注，也不跟进玩家的双倍——赌注只由玩家推动；四档一致）
  if (meta.engine === 'legacy') { aiThinkLegacy(meta); return; } // 简单档：最初版贪心 AI
  aiThinkScoreEngine(meta);                                       // 普通 / 困难 / 月狂：v173 新引擎
}

/** 普通 / 困难 / 月狂档的决策执行：影子盘面估值 + 回合级计划 */
function aiThinkScoreEngine(meta) {
  const st = state;
  const pl = st.players.a;

  const plan = aiPlanMoves(meta);
  let spent = 0;
  for (const p of plan.plays) {
    const zone = pl.zones[p.loc];
    // 防御：执行前再校验一次合法性（模型与真实盘面理论上一致，异常时跳过而不是硬塞）
    // v196：加上卡级放置条件 `playReq`（现仅「大鲶鱼」）的复核——计划阶段已过滤，这里再兜一层
    if (!locOpen(p.loc) || sideRoom('a', p.loc) < occOf(p.card) || pl.hand.indexOf(p.card) < 0 || !playReqCheck('a', p.card).ok) continue;
    p.card.side = 'a';
    zone.push(p.card);
    enqueueField(p.card);                       // 暗出：进入场上放置顺序队列（v55）
    pl.hand.splice(pl.hand.indexOf(p.card), 1);
    const paid = cardCost(p.card);
    pl.energyLeft -= paid;
    st.aiMoves.push({ cardId: p.card.id, loc: p.loc });
    spent += paid;
    log('a', `🤖 对手在「${st.locs[p.loc].def.n}」暗出「${p.card.def.n}」(${paid}费) — 估值 ${aiFmtGain(p.gain)}：${aiReasonText(p.card, p.loc)}`);
  }
  // v173：计划落完之后再看「每回合移动一次」（射命丸文）值不值得走一步
  if (meta.fly) aiFlyMove(meta);

  if (st.aiMoves.length === 0) {
    log('a', `🤖 AI（${meta.name}）没有值得打出的牌，选择跳过。`);
  } else {
    log('a', `🤖 AI（${meta.name}）本回合暗出 ${st.aiMoves.length} 张 · 花费 ${spent} 能量（剩余 ${pl.energyLeft}）· 计划估值 ${aiFmtGain(plan.score - plan.baseScore)}`);
  }
}

/* ---------- 导出（调试用；不改变 game.js 的调用方式） ---------- */
window.AI = {
  LEVELS: AI_LEVEL_TABLE,
  ORDER: Object.keys(AI_LEVEL_TABLE),   // v174：主页面「⚙️ 设置」弹窗按此顺序列出四档
  DEFAULT_LEVEL: AI_DEFAULT_LEVEL,      // v175：默认档 = easy（简单）
  ALIAS: AI_LEVEL_ALIAS,                // v175：旧档名映射（nightmare → lunatic）
  getLevel: aiGetLevel,
  setLevel: aiSetLevel,
  levelInfo: () => aiMeta(),
  policyText: aiPolicyText,
  // 简单档（最初版）的单张落子估值：只算印刷战力 / 三区优势之和
  hypotheticScore,
  // 只读探针：便于在控制台核对「AI 现在是怎么估的」
  _eval: () => mdEvaluate(mdBuild(), aiMeta(), true),
  _plan: () => aiPlanMoves(aiMeta()),
  _model: mdBuild,
  _delta: aiModelDelta,                 // v173 新引擎口径的单张落子增量（与 hypotheticScore 不同）
};
