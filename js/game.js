/* =========================================================
   东方逆转 · 极简演示 —— Marvel Snap 玩法 · 东方 Project 换皮
   3 区域 / 6 回合 / 能量预算多张出牌 / 暗牌翻面 /
   揭示效果 / 区域特效 / 双倍下注(snap) / 认输 / 重置暗牌
   流程阶段管线：游戏开始 → 每回合(回合开始效果/能量抽牌/放置移动/
   翻牌揭示结算/全场回合结束/区域回合末/手牌回合末) → 游戏结束效果 → 结算胜负
   （v54 拆分显式阶段 / v55 加入场上放置顺序队列 + fx 时机效果 /
   v74 开局三列「未揭示」逐回合揭晓系统；详见 playRound 上方注释）
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
// 非随机地形表（EXTRA，见 locations.js）：存在但**不进开局随机抽选**，
// 只作为“可按 id 引用的地形”供机制按键名调用（现「未揭示」unreveal = 开局三列初始占位，
// 由 locationRevealStage 逐回合揭晓；⚠️ 其 id 不能用 'hidden'，与全局 .hidden 隐藏类冲突）
const LOCATION_EXTRA = (window.DS_LOCATIONS && window.DS_LOCATIONS.EXTRA) || {};
// 按 id 查找地形定义：随机池 POOL 优先，其次 EXTRA（供 xform 等机制引用非随机地形）
function findLocDef(id) {
  const inPool = LOCATION_POOL.find((l) => l.id === id);
  if (inPool) return inPool;
  for (const k in LOCATION_EXTRA) {
    const d = LOCATION_EXTRA[k];
    if (d && d.id === id) return d;
  }
  return null;
}
// 「未揭示」地形兜底定义（正式数据在 locations.js EXTRA.unreveal）：开局三列的未揭晓占位态
const HIDDEN_LOC_DEF = { id: 'unreveal', n: '未揭示', icon: '❓', wt: 1, dbl: 1, max: 4, eff: '未揭示地形' };

// 卡面渐变：有自定义 cg（如特殊卡牌「石块」的土黄色）则优先，否则按费用档位取色
const gradOf = (def) => (def && def.cg) || GRADS[def.c];

const DECK_CURVE = [1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6, 6]; // 玩家兜底随机牌库（无自建卡组时）
// v138：AI 开局随机卡组费用结构 1×2 / 2×3 / 3×3 / 4×1 / 5×1 / 6×2
const AI_DECK_CURVE = [1, 1, 2, 2, 2, 3, 3, 3, 4, 5, 6, 6];

/* ---------------- 工具 ---------------- */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function uid() { return (state.cardSeq++); }
// ---- v170：法术（spell，卡级机制）----
// 定义：只带 **能量消耗（def.c）** 与 **「揭示」效果** 的卡——数字侧在 `data/cards.js` 里写
// `spell: true`（战力记 0，卡上不再声明其它卡级机制）。角色池（POOL：可入卡组、可被随机
// 曲线与 AI 抽到）与衍生物池（SPECIAL：由 give 塞入手牌、或落场生成）两处都适用，
// 判定统一走 isSpellDef / isSpell。
// 口径：
//   ① 无战力：cardPower / cardPowerIn 对法术恒为 0，卡框不显示战力；任何位置都不吃战力增减；
//   ② 占位：作为暗牌放置需要一个空位（占 1 格，occ 恒按 1 计）；**揭示瞬间同样占 1 格**
//      （影响放满加成与该侧“是否已满”的判定），到「揭示效果结算完之后」才腾出格位；
//   ③ 消散：不是“摧毁”——不触发 surv / phx / prot 与任何摧毁类文本，不进战力影响历史，
//      不返手、不返库（一局就这一份），单独记一条日志 + 消散演出；
//   ④ 全面免疫：bf/de/ba 等增减跳过它；dw/dwh/mv/gift 这类“按威力选目标”的效果不选它
//      （避免白费一次指向）；但它的“已放置”照常让 oc 触发、格位照常占用。
function isSpellDef(def) { return !!(def && def.spell); }
function isSpell(card) { return !!(card && card.def && card.def.spell); }
function cardPower(card) { return isSpell(card) ? 0 : card.def.p + card.buff; }
// ---- v169：费用修正（本场战斗内改变某一份卡牌实例的费用）----
// 口径：修正是**实例级**的（记在 card.costMod / card.costLog 上，只对「这一份」卡有效，
// 牌库里的同名卡与图鉴不受影响），随该实例走完本局，**仅本场战斗有效**：被摧毁/离场/终局
// 都随之结束，重新开局卡实例重建故自然失效。`def.c` 始终是**印刷费用/基础费用**，不被改写
// （区域「雾之湖」的 cb 费用加成、卡组排序、图鉴与开发者「指定卡牌」都按印刷费用判定）。
// 现仅桑尼米尔克 `k:'costUp'` 使用（对方手牌随机一张 +1 费；上限 6 费的卡不可再涨）。
function cardCost(card) {
  if (!card) return 0;
  return card.def.c + (card.costMod || 0);
}
/** 费用修正的记录（inst=实例，srcCard=来源卡；tag 可选=自定义来源名），与战力影响历史同一思路 */
function addCostLog(card, d, srcCard, tag) {
  if (!card) return;
  if (!Array.isArray(card.costLog)) card.costLog = [];
  card.costLog.push({ inst: card, d, src: srcCard ? { id: srcCard.id, n: srcCard.def.n } : null, tag: tag || null });
}
// 费用修正的唯一收口（对应战力的 applyPermBuff）：改 costMod + 记账 + 排队“费用 ±N”演出。
// 返回 false = 卡本身不可被改（un 占位卡如隙间）。
function applyCostMod(card, d, srcCard, tag) {
  if (!card || !d || (card.def && card.def.un)) return false;
  card.costMod = (card.costMod || 0) + d;
  addCostLog(card, d, srcCard, tag);
  costFlashQueue.push({ card, d, srcCard: srcCard || null });
  return true;
}
// 费用修正演出（v169 修订）：① 中央弹出一张**被改费那张牌的完整卡面**（配图 / 卡名 / 战力
// + 费用 N → N+1 的三段式横幅），让玩家一眼看清“是谁被加费、涨到多少”（spawnCostReveal）；
// ② 若被改的卡恰好就在场上/我方手牌可见（如未来出减费卡），卡面再做一次提亮闪动；
// ③ 卡位取不到元素时退化为原本的侧栏小气泡（spawnCostPop）。
// 同一批里同一张卡只播一次演出（费用变化合并计入 d）。
function flushCostFlash() {
  if (!costFlashQueue.length) return;
  const items = costFlashQueue;
  costFlashQueue = [];
  const merged = new Map(); // card → 本次累计费用变化（含来源卡，用于揭示演出的标题）
  for (const q of items) {
    const hit = merged.get(q.card);
    if (hit) hit.d += q.d;
    else merged.set(q.card, { card: q.card, d: q.d, srcCard: q.srcCard || null });
  }
  for (const q of merged.values()) {
    const el = miniCardElById(q.card.id);
    if (el && el.isConnected && typeof el.animate === 'function') {
      el.classList.add('cost-changed');
      try {
        el.animate(
          [{ boxShadow: '0 0 0 0 rgba(255,196,92,0)' }, { boxShadow: '0 0 16px 4px rgba(255,196,92,.9)' }, { boxShadow: '0 0 0 0 rgba(255,196,92,0)' }],
          { duration: 1000, easing: 'ease-out' }
        );
      } catch (e) { /* 动画不可用时忽略，仅保留 class */ }
      setTimeout(() => el.classList.remove('cost-changed'), 1080);
    }
    // 中央卡面揭示演出：带“加费后”的费用（q.card.costMod 此时已是结果值，
    // 故「旧值」用 新值 − d 反推，被多次改费时也正确）
    spawnCostReveal(q.card, q.d, q.srcCard);
    // 卡位不可见（目标在对方手牌里）时补一个小气泡落在侧栏对手信息区做点缀
    if (!el || !el.isConnected) spawnCostPop(null, q.d, q.card);
  }
}
// 中央“费用被改”的卡面揭示：把被改的那张牌以完整卡面弹出，明确展示 卡图 / 卡名 / 战力
// 与「费用 5 → 6」。约 2.4s：弹入 → 抖动 → 停留 → 上浮淡出（见 style.css .cost-reveal）。
// 内容全部取自 def/实例数据（目标在对方手牌里也能如实展示），DOM 放 body 悬浮层不受重渲染影响。
function spawnCostReveal(card, d, srcCard) {
  if (!card || !card.def || !d) return;
  const def = card.def;
  const cur = cardCost(card);
  const before = cur - d;
  const inner = document.createElement('div');
  inner.className = 'cost-reveal-inner';
  const tag = document.createElement('div');
  tag.className = 'cost-reveal-tag';
  // 标题写明“谁在改费 + 改的是对手手牌”（来源卡实时取，未来出别的费用操控卡自动跟随）
  tag.textContent = `${(srcCard && srcCard.def && srcCard.def.i) || '✦'} ${(srcCard && srcCard.def && srcCard.def.n) || '费用操控'} · 对方手牌 费用 ${d > 0 ? '+' : '−'}${Math.abs(d)}`;
  const face = document.createElement('div');
  face.className = 'cost-reveal-card' + (def.img ? ' has-img' : ' no-img');
  face.style.setProperty('--cgrad', gradOf(def));
  const art = document.createElement('div');
  art.className = 'rc-art';
  const emoji = document.createElement('span');
  emoji.className = 'rc-emoji';
  emoji.textContent = def.i || '🃏';
  art.appendChild(emoji);
  if (def.img) {
    const img = document.createElement('img');
    img.src = 'assets/cards/' + encodeURIComponent(def.img);
    img.alt = def.n;
    img.draggable = false;
    art.appendChild(img);
  }
  const name = document.createElement('div');
  name.className = 'rc-name';
  name.textContent = def.n;
  // 费用横幅：旧值划掉 → 新值（红=涨 / 绿=降），再并列战力（手牌口径：基础 + 永久 buff）
  const costBox = document.createElement('div');
  costBox.className = 'cost-reveal-cost';
  const lab = document.createElement('span');
  lab.className = 'rc-label';
  lab.textContent = '费用';
  const oldEl = document.createElement('span');
  oldEl.className = 'rc-old';
  const oldS = document.createElement('s');
  oldS.textContent = String(before);
  oldEl.appendChild(oldS);
  const arrow = document.createElement('span');
  arrow.className = 'rc-arrow';
  arrow.textContent = '→';
  const newEl = document.createElement('span');
  newEl.className = 'rc-new' + (d < 0 ? ' down' : '');
  newEl.textContent = String(cur);
  // 横幅只展示费用的变化（旧值 → 新值），不再并列战力
  costBox.appendChild(lab); costBox.appendChild(oldEl); costBox.appendChild(arrow);
  costBox.appendChild(newEl);
  face.appendChild(art); face.appendChild(name); face.appendChild(costBox);
  const note = document.createElement('div');
  note.className = 'cost-reveal-note';
  note.textContent = d > 0 ? `能量消耗 +${d}，仅本场战斗有效` : `能量消耗 ${d}，仅本场战斗有效`;
  inner.appendChild(tag); inner.appendChild(face); inner.appendChild(note);
  const box = document.createElement('div');
  box.className = 'cost-reveal';
  box.appendChild(inner);
  const ring = document.createElement('div');
  ring.className = 'cost-reveal-ring';
  box.appendChild(ring);
  document.body.appendChild(box);
  // 费用数字再单独做一次放大强调（与横幅动画叠加，观感更明确）
  const kf = [
    { transform: 'scale(.6)', opacity: .2 },
    { transform: 'scale(1.5)', opacity: 1, offset: .18 },
    { transform: 'scale(1)', opacity: 1, offset: .35 },
    { transform: 'scale(1)', opacity: 1, offset: .85 },
    { transform: 'scale(1)', opacity: 0 },
  ];
  if (typeof newEl.animate === 'function') {
    try { newEl.animate(kf, { duration: 1500, easing: 'ease-out' }); } catch (e) { /* 忽略 */ }
  }
  setTimeout(() => { if (box.parentNode) box.parentNode.removeChild(box); }, 2500);
}
// 费用变化小气泡（兜底/点缀）：有卡位元素则以卡位为锚点（场上/我方手牌可见时），
// 否则退到侧栏对手信息区（加费目标在对方手牌里不可见时用侧栏「手上还有 N 张」作落点）。
function spawnCostPop(el, d, card) {
  let anchor = (el && el.isConnected) ? el : null;
  if (!anchor) anchor = document.querySelector('#sidePanel .opponent .mini-stats');
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const box = document.createElement('div');
  box.className = 'gain-ring cost-ring';
  box.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
    `width:${rect.width}px;height:${rect.height}px;border-radius:10px;z-index:9400;`;
  const pop = document.createElement('span');
  pop.className = (d > 0 ? 'buff-gain-pop loss' : 'buff-gain-pop') + ' cost-pop';
  pop.textContent = `${card && card.def ? card.def.n + ' ' : ''}费用 ${d > 0 ? '+' : '−'}${Math.abs(d)}`;
  box.appendChild(pop);
  document.body.appendChild(box);
  setTimeout(() => { if (box.parentNode) box.parentNode.removeChild(box); }, 1080);
}

/* ==================== v169：额外能量（斯塔萨菲雅）的两段演出 ====================
   ① 登记段 playEnergyBookFx：**揭示当刻**在卡位上放一组星光迸发 + 「能量 +N」气泡
      + 「下一回合生效」小字 —— 让玩家看到“这份能量已经预约好了”；
   ② 到账段 playEnergyGainFx：**下一个回合开始**能量结算时，在顶栏能量框（玩家侧）
      或侧栏对手信息区（对手侧）播放金光闪光 + 星光迸发 + 「+N 能量」气泡，配合绿色「+N」角标。
   两段都放在 body 悬浮层（z-index 9400），pointer-events:none 不挡操作，播完自动清理；
   元素尺寸为 0（隐藏/未渲染）时直接跳过，避免在不可见处白播。 */
function playEnergyBookFx(side, n, card) {
  const el = miniCardElById(card.id);
  if (!el || !el.isConnected) return;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  playEnergyFxAt(rect, n, `🔋 能量 +${n}`, '下一回合生效', {
    flash: 'energy-card-flash',
    ring: 'energy-ring',
    pop: 'energy-pop',
  });
}
function playEnergyGainFx(side, n, srcCards) {
  const isPlayer = side === 'p';
  const box = isPlayer ? $('energyBox') : document.querySelector('#sidePanel .opponent .mini-stats');
  // 小字说明：优先列出**来源卡名**（多张时连写，如「斯塔萨菲雅 ×2」），没有来源时退回能量口径说明
  const names = (srcCards || []).map((c) => c && c.def && c.def.n).filter(Boolean);
  const sub = isPlayer ? `本回合能量上限 +${n}` : `对手本回合能量 +${n}`;
  let subTxt = sub;
  if (names.length) {
    subTxt = names.length > 1
      ? `${names[0]} ×${names.length} · ${sub}`
      : `${names[0]} · ${sub}`;
  }
  if (box) {
    const rect = box.getBoundingClientRect();
    if (rect.width > 2 && rect.height > 2) {
      playEnergyFxAt(rect, n, `🔋 能量 +${n}`, subTxt, {
        flash: 'energy-box-flash',
        ring: 'energy-ring',
        pop: 'energy-pop',
      });
      return;
    }
  }
  // 兜底：拿不到顶栏元素时，只在侧栏对手区播一次
  const ai = document.querySelector('#sidePanel .opponent .mini-stats');
  if (!ai) return;
  const r2 = ai.getBoundingClientRect();
  if (r2.width > 2) playEnergyFxAt(r2, n, `🔋 能量 +${n}`, subTxt, { flash: 'energy-box-flash', ring: 'energy-ring', pop: 'energy-pop' });
}
// 公共演出：在给定矩形上闪一下 + 扩散光环 + 星光迸发 + 「+N 能量」气泡
function playEnergyFxAt(rect, n, popText, subText, cls) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  // 1) 主体闪光 + 光环
  const box = document.createElement('div');
  box.className = cls.flash + ' ' + cls.ring;
  box.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
    `width:${rect.width}px;height:${rect.height}px;border-radius:12px;` +
    `z-index:9400;pointer-events:none;`;
  document.body.appendChild(box);
  setTimeout(() => { if (box.parentNode) box.parentNode.removeChild(box); }, 1500);
  // 2) 星光迸发（起点在锚点中心，终止点由 CSS 变量给出）
  const stars = ['⭐', '✨', '🌟', '💫'];
  const count = Math.max(6, Math.min(10, 5 + n * 2));
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'energy-star';
    p.textContent = stars[i % stars.length];
    const ang = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const dist = 34 + Math.random() * 54;
    p.style.left = cx + 'px';
    p.style.top = cy + 'px';
    p.style.fontSize = (13 + Math.random() * 11).toFixed(1) + 'px';
    p.style.setProperty('--edx', `${(Math.cos(ang) * dist).toFixed(1)}px`);
    p.style.setProperty('--edy', `${(Math.sin(ang) * dist - 16).toFixed(1)}px`);
    p.style.animationDelay = (Math.random() * 0.12).toFixed(2) + 's';
    document.body.appendChild(p);
    setTimeout(() => { if (p.parentNode) p.parentNode.removeChild(p); }, 1400);
  }
  // 3) 「能量 +N」气泡 + 小字说明
  const pop = document.createElement('div');
  pop.className = cls.pop;
  pop.style.left = cx + 'px';
  pop.style.top = cy + 'px';
  const main = document.createElement('span');
  main.className = 'ep-main';
  main.textContent = popText;
  pop.appendChild(main);
  if (subText) {
    const sub = document.createElement('span');
    sub.className = 'ep-sub';
    sub.textContent = subText;
    pop.appendChild(sub);
  }
  document.body.appendChild(pop);
  setTimeout(() => { if (pop.parentNode) pop.parentNode.removeChild(pop); }, 1700);
}
// 区域-阵营加成：区域 aff 给“所属该阵营（card.def.g）”的卡牌加固定威力。
// 属于常驻实时加成：该卡在此区域的任何实时读取（卡面/总数/摧毁/落后判定/图鉴放大）都计入。
function locRoleBonus(locIdx, card) {
  const aff = locDef(locIdx).aff;
  if (!aff || !card || card.def.un || card.def.spell) return 0; // v170：法术无战力，不吃阵营加成
  return card.def.g === aff.group ? aff.add : 0;
}
// 区域-费用加成：区域 cb={c,add} 给位于本区域、费用恰为该值的卡牌加威力
// （如雾之湖对 1 费卡牌 +2；双方卡与特殊卡都算）。
function locCostBonus(locIdx, card) {
  const cb = locDef(locIdx).cb;
  if (!cb || !card || card.def.un || card.def.spell) return 0; // v170：法术不吃费用加成（仍按印刷费用）
  return card.def.c === cb.c ? cb.add : 0;
}
// 区域-全体修正：区域 all=N（可为负，如冥界 -2）给本区域所有卡牌（双方、特殊卡）加 N 威力
function locAllBonus(locIdx, card) {
  if (!card || card.def.un || card.def.spell) return 0; // v170：法术不吃全区修正
  return locDef(locIdx).all || 0;
}
// 持续效果（og，原「在场光环」，如比那名居天子）：该卡已翻开且仍在己方某区时，
// 己方所有带匹配 tk 标记的卡牌（如己方石块）常驻 +N。动态读取：源卡被摧毁即消失。
function cardAuraBonus(card) {
  if (!card || !card.def.tk || !card.side || card.def.spell) return 0;
  let b = 0;
  for (let j = 0; j < 3; j++) {
    for (const c of state.players[card.side].zones[j]) {
      if (c.revealed && !c.def.un && c.def.og && c.def.og.tk === card.def.tk) b += c.def.og.add;
    }
  }
  return b;
}
// 卡牌在指定区域的实时战力 = 基础威力 + 永久增益 + 区域加成（阵营/费用/全区）+ 持续效果
// v170：法术恒为 0——它没有战力，不吃任何加成（阵营/费用/全区/持续都不适用）
function cardPowerIn(locIdx, card) {
  if (isSpell(card)) return 0;
  return cardPower(card) + locRoleBonus(locIdx, card) + locCostBonus(locIdx, card) + locAllBonus(locIdx, card) + cardAuraBonus(card);
}
// ---- 占格（occ）口径：普通卡占 1 格；大体积卡（如伊吹萃香 occ:4）占满多格 ----
// 出牌/生成/移动/放满等所有“还能放几张”的判定统一走这里，避免只用 zone.length 误判。
// v170：法术恒按 1 格计（暗牌需要 1 个空位；揭示瞬间同样占 1 格，消散后才腾出）
function occOf(card) {
  if (isSpell(card)) return 1;
  return (card && card.def && card.def.occ) || 1;
}
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
  phase: 'idle',       // idle | play | busy | over
  stakes: 1,
  pSnapped: false,
  aSnapped: false,   // v173：AI 不再加倍（既不主动也不跟进），该标记恒为 false（侧栏「已加倍」标签不再出现）
  locs: [],
  locPlan: [],        // 本局三块“真实地形”按揭晓顺序预存（v74：列 0/1/2 在第 1/2/3 回合开始揭晓）
  players: {
    // v145：能量分边（energyTotal / energyLeft 各自独立；回合开始写入相同基数，之后可单独改）
    // v169：energyGain = 本回合由「额外能量」机制多出来的点数（HUD 显示「N+1」，回合结束归零）
    p: { key: 'p', name: '你', zones: [[], [], []], deck: [], hand: [], energyTotal: 1, energyLeft: 1, energyGain: 0 },
    a: { key: 'a', name: '对手', zones: [[], [], []], deck: [], hand: [], energyTotal: 1, energyLeft: 1, energyGain: 0 },
  },
  selected: -1,        // 手牌下标
  // v169：能量机制挂钩（斯塔萨菲雅 k='energyNext'）——
  //   pendingEnergyGain：各方「下回合开始额外获得」的能量（一次性，回合开始结算后清空）
  //   pendingEnergySrc：登记这些额外能量的来源卡实例（供下回合的到账演出定位，结算后清空）
  //   players[side].energyGain：本回合实际生效的额外能量（HUD 显示「+N」用，回合结束随下次结算归零）
  pendingEnergyGain: { p: 0, a: 0 },
  pendingEnergySrc: { p: [], a: [] },
  playerMoves: [],     // 本回合玩家已暗出的牌 [{cardId, loc, side?}]；side 缺省为 'p'（v144 切换立场可记为 'a'）
  aiMoves: [],         // 本回合对手已暗出的牌
  playAsSide: 'p',     // v144：开发调试「切换立场」——'a' 时玩家落牌进敌方区且归属对手
  fieldQueue: [],      // 场上放置顺序队列：双方卡牌按“放入场上”先后记录（v55），供回合开始/结束/终局按序结算
  playHandOrder: [],   // 本回合开始时玩家手牌 id 顺序（供重置暗牌时恢复）
  moveCardId: null,    // “每回合可移动一次”的牌：当前正在选目标区域的卡 id
  flyMoved: new Set(), // 本回合已自移过的卡 id（如射命丸文）
  flyMovedFrom: {},    // 本回合自移过的卡：卡 id → 回合初所在区域下标（供重置）
  logCount: 0,
};

let pendingResolve = null;
let pendingSwitchFly = null; // v96：换边演出待播 {card, srcRect}（由 switch/gift 记录、revealRound 渲染后触发）
// v158：自身移动待播的飞行演出队列 {card, srcRect}（roam：幽灵的回合开始游走等）——
// 由调用方（roundStartStage / revealRound）在渲染后 flush，观感同 fly/shift 的“滑行+缩放”。
let pendingDriftFly = [];
// pickDef（开发者“指定卡牌”选中）已随页面实现一并拆分到 card-browser.js（v92）

/* ---------------- 流程主循环 ---------------- */
async function restart(opts) {
  opts = opts || {};
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
  state.playAsSide = 'p'; // v144：新一局默认己方立场
  state.fieldQueue = []; // 场上放置顺序队列（v55）
  buffFlashQueue = [];   // v80：清掉上一局遗留的“+N 演出”队列（新一局卡 id 会重新从 0 计）
  pendingDriftFly = [];  // v158：清掉上一局遗留的“自身移动”飞行演出队列
  pendingSwitchFly = null; // v96：换边演出待播
  state.playHandOrder = [];
  state.players.p.zones = [[], [], []]; state.players.p.hand = [];
  state.players.a.zones = [[], [], []]; state.players.a.hand = [];
  // v169：清掉上一局的能量挂钩（额外能量登记、本回合额外能量提示、登记来源）
  state.pendingEnergyGain = { p: 0, a: 0 };
  state.pendingEnergySrc = { p: [], a: [] };
  state.players.p.energyGain = 0;
  state.players.a.energyGain = 0;

  // v137：玩家可用自建满编卡组（opts.playerDeckDefs）；否则沿用上一局自建卡组；都没有则随机曲线
  // v142：开发调试 opts.emptyPlayerDeck → 玩家牌库为空（「重新开始」会沿用）；AI 仍随机
  if (opts.emptyPlayerDeck === true) {
    lastEmptyPlayerDeck = true;
    lastPlayerDeckDefs = null;
    state.players.p.deck = [];
  } else if (opts.playerDeckDefs) {
    lastEmptyPlayerDeck = false;
    const custom = (opts.playerDeckDefs.length === 12) ? opts.playerDeckDefs : null;
    if (custom) {
      lastPlayerDeckDefs = custom.slice();
      state.players.p.deck = buildDeckFromDefs(custom);
    } else {
      lastPlayerDeckDefs = null;
      state.players.p.deck = buildDeckCards(DECK_CURVE);
    }
  } else if (lastEmptyPlayerDeck) {
    state.players.p.deck = [];
  } else {
    const custom = (lastPlayerDeckDefs && lastPlayerDeckDefs.length === 12) ? lastPlayerDeckDefs : null;
    if (custom) {
      state.players.p.deck = buildDeckFromDefs(custom);
    } else {
      state.players.p.deck = buildDeckCards(DECK_CURVE);
    }
  }
  // v138：对手每局按 AI 费用结构从卡池随机组一套 12 张（同费用不重复）
  state.players.a.deck = buildDeckCards(AI_DECK_CURVE);

  // v94：对手初始 3 张先在数据层发放（无展示动画）；玩家初始 3 张由 playOpening
  // 逐张播放“从右滑入”入场演出，第 1 回合开始双方再各抓 1 张（起手共 4 张）。
  for (let i = 0; i < 3; i++) drawOne('a');

  // 选 3 块区域：按抽选权重（pick，默认 1）不放回抽 3 块，保证互不相同；
  // 辉针城 pick 0.28 → 每局出现率约 10%（约 10 局 1 次）。
  // 区域池不足 3 种时退回旧逻辑（允许重复、仅避免三块完全相同）作兜底。
  // v143：开发调试固定三块「无名之丘」（仍走未揭示→揭晓流程）
  let picks;
  if (isDevMode()) {
    const plain = findLocDef('plain') || LOCATION_POOL[0];
    picks = [plain, plain, plain];
  } else if (LOCATION_POOL.length >= 3) {
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
  // 地形揭晓系统（v74）：开局即按权重抽定三块真实地形（互不相同），预存到 locPlan；
  // 场上三列先全部以「未揭示」占位地形展示（max 4、无效果），
  // 由 locationRevealStage 在第 1/2/3 回合开始时依次揭晓到第 0/1/2 列（左→中→右）。
  state.locPlan = picks;
  const hiddenDef = findLocDef('unreveal') || HIDDEN_LOC_DEF;
  state.locs = picks.map(() => ({ def: hiddenDef }));
  state.moveCardId = null;
  state.flyMoved = new Set();
  state.flyMovedFrom = {};

  // DOM 骨架
  buildBoard();
  hideModal();
  $('undoMask').classList.add('hidden');
  clearLog();
  if (isDevMode()) {
    log('sys', '开发调试对局：玩家空牌库 · 每回合能量 10 · 三块地形固定为「无名之丘」· AI 不出牌。未揭示地形将在第 1/2/3 回合依次揭晓。');
  } else {
    log('sys', '新对局开始！三块地形皆为「未揭示」，将在第 1/2/3 回合开始依次揭晓（左→中→右）；未揭示地形可正常放牌。先手暗牌后统一翻面。');
  }
  // 注：地形“出现时”效果（如虹龙洞给双方石块）不再开局结算——
  // 三块真实地形在揭晓那一刻才“出现”，由 locationRevealStage 结算（v74）。
  runGameStartEffects(); // ⓪ 游戏开始效果挂点（现无注册效果）：第 1 回合开始前执行
  renderAll();
  await playOpening(gen); // v94→v119：玩家初始 3 张逐张滑入 → 间隔 500ms
  if (gen !== state.gen) return;
  playRound(gen);
}

// v94 开局演出：玩家初始 3 张逐张“从屏幕右侧滑入”（每张约 0.7s 动画节奏），
// 三张全部到位后停顿 500ms，再进入第 1 回合（第 1 回合开始会再抽 1 张）。
async function playOpening(gen) {
  for (let i = 0; i < 3; i++) {
    const card = drawOne('p');
    if (!card) break; // v142：开发调试空牌库时跳过开场发牌等待
    card.justDrawn = true; // 复用“抽牌从右滑入”演出（v91/v93）
    renderHand();
    await sleep(720); // 等滑入动画（0.65s）播完并留一点间隔
    if (gen !== state.gen) return;
  }
  await sleep(500); // 三张抽完 → 间隔 500ms（v119）
}

function buildDeckCards(curve) {
  // curve：费用序列（默认玩家兜底曲线）；每种费用从 POOL 随机抽、同费用不重复
  // v139：抽牌顺序纯随机，不再做起手友好拒绝采样 / 兜底序列
  curve = curve || DECK_CURVE;
  const buckets = {};
  for (const c of [1, 2, 3, 4, 5, 6]) buckets[c] = shuffle((POOL[c] || []).slice());
  const draw = shuffle(curve.slice());
  // 按抽牌顺序生成卡牌；drawOne() 从队尾取牌，因此反转存储
  const inDrawOrder = draw.map((c) => {
    const def = buckets[c].pop();
    return newCard(def || (POOL[c] && POOL[c][0]) || POOL[1][0]);
  });
  inDrawOrder.reverse();
  return inDrawOrder;
}

/* v137→v139：用玩家自建卡组（12 张 def）造牌库——纯随机洗牌；drawOne 从队尾取，故反转存储 */
let lastPlayerDeckDefs = null;
/* v142：开发调试空牌库模式（无参 restart / 再来一局沿用） */
let lastEmptyPlayerDeck = false;
function isDevMode() { return !!lastEmptyPlayerDeck; }
/** v144：当前出牌落位归属（开发调试切换立场为敌方时返回 'a'） */
function playSide() {
  return (isDevMode() && state.playAsSide === 'a') ? 'a' : 'p';
}
/** v145：读某方能量对象（total / left） */
function energyOf(side) {
  return state.players[side];
}
/** v169：回合开始给双方写入本回合能量基数（变量独立，数值可相同）
    v169：额外能量（`energyNext`，斯塔萨菲雅）——回合开始结算时把上一回合攒下的
    `pendingEnergyGain` 一并加上（**一次性、加完即清空**），并把本次真正生效的额外值
    记进 `energyGain`（HUD 用「+N」角标提示本回合多出来的那点能量，回合结束即消失），
    同时播放「能量到账」演出（顶栏能量框星光 + 「+N 能量」气泡）。 */
function grantTurnEnergy(total) {
  for (const side of ['p', 'a']) {
    const pl = state.players[side];
    const gain = state.pendingEnergyGain[side] || 0;
    pl.energyTotal = total + gain;
    pl.energyLeft = total + gain;
    pl.energyGain = gain;
    state.pendingEnergyGain[side] = 0; // 一次性：结算后消耗掉
    if (gain > 0) {
      const who = side === 'p' ? '你' : '对手';
      log('sys', `🔋 ${who}本回合获得额外能量 +${gain}（能量上限 ${pl.energyTotal}；一次性，仅本回合有效）。`);
      // v169：到账演出（玩家侧用顶栏能量框作锚点；对手侧落到侧栏对手信息区），随后清空登记来源
      playEnergyGainFx(side, gain, state.pendingEnergySrc[side] || []);
      state.pendingEnergySrc[side] = [];
    }
  }
}
/** v169：为某方登记“下回合开始额外能量”（energyNext / 斯塔萨菲雅）——
    在本局的下一个回合开始（grantTurnEnergy）时一次性生效，多个来源可叠加（+2 即两点）。
    返回 { n: 累计点数, src: 来源卡实例数组 }（src 供下回合的到账演出定位）。 */
function addPendingTurnEnergy(side, n, srcCard) {
  if (!n) return { n: 0, src: [] };
  const cur = state.pendingEnergyGain[side];
  const booked = (typeof cur === 'number' ? cur : 0) + n; // 兼容早期的数字写法
  state.pendingEnergyGain[side] = booked;
  if (srcCard) {
    if (!Array.isArray(state.pendingEnergySrc[side])) state.pendingEnergySrc[side] = [];
    state.pendingEnergySrc[side].push(srcCard);
  }
  return { n: booked, src: state.pendingEnergySrc[side] || [] };
}
/** 本回合归属为 side 的落牌记录（含玩家以敌方立场暗出的牌） */
function movesForSide(side) {
  const out = [];
  for (const m of state.playerMoves) {
    if ((m.side || 'p') === side) out.push(m);
  }
  if (side === 'a') {
    for (const m of state.aiMoves) out.push(m);
  }
  return out;
}
function buildDeckFromDefs(defs) {
  const base = (defs || []).slice(0, 12);
  if (base.length !== 12) return buildDeckCards(DECK_CURVE);
  const cards = shuffle(base.slice()).map((d) => newCard(d));
  cards.reverse();
  return cards;
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

// 把特殊卡落到某方某区：落地即翻开、占用格位、记录属方；放满则放不下。
// out（可选，v166）：把本次实际生成的卡实例依次收集进去，供 spawn.reveal 结算其揭示效果。
function placeToken(side, locIdx, tkDef, cnt, out) {
  let placed = 0;
  const zone = state.players[side].zones[locIdx];
  for (let i = 0; i < cnt; i++) {
    if (sideRoom(side, locIdx) < 1) break; // 按占格口径（大体积卡占满时无法再落）
    const card = newCard(tkDef);
    card.side = side;
    card.revealed = true;
    card.justSpawned = true; // v90：落场生成演出（凝聚显形）
    zone.push(card);
    enqueueField(card); // 落场 token：按落场先后进入放置队列（v55）
    if (out) out.push(card);
    placed++;
    // v170：衍生物池里的“法术”落场生成 —— 等同手打了一张法术：先结算它自身的「揭示」，随即消散
    if (card.def.spell) settleFieldSpell(card, locIdx);
  }
  return placed;
}

/* ========================================================
   流程阶段管线（v54→v55：主循环按显式阶段执行；v55 加入
   “场上放置顺序队列”，供时机类效果按双方放置先后结算；
   v74：加入地形揭晓系统——开局三列均为「未揭示」，逐回合揭晓）：
   游戏开始 restart：建牌库 → 发初始手牌 → 按权重抽选 3 块真实地形存 locPlan
     （三列先以「未揭示」占位展示）→ runGameStartEffects（⓪ 开局效果挂点，现空）
     → 第 1 回合（①-0 地形揭晓在 roundStartStage 内最先执行）
   每回合 playRound 依次：
     ① roundStart：locationRevealStage（①-0 地形揭晓：第 t 回合揭晓第 t 列，
                   含该地形“出现时”生成效果）
                  → runTurnStartEffects（全场“回合开始”效果，按放置队列序结算）
                  → 能量结算 + 抽牌（回合 2+，第 1 回合的 3 张已在开局发放）
                  → 清空回合临时状态
     ② 玩家放置与移动（waitPlayer：出牌 / 移动 / 重置 / 双倍 / 认输均在此阶段）
     ③ 对手放置（aiThink）
     ④ revealRound：翻开暗牌，逐张按放置顺序结算 —— 先区域「翻开时」效果
                    （gamble，如驹草赌场随机 ±1，v156）→ 再该卡自身「揭示」效果
                    → 最后区域「揭示后吹飞」（gust，如魔力风暴吹到另一区，v162）
     ⑤-0 runLocTurnEndEffects：**区域（地形）回合结束效果**——每回合翻牌结算后最先执行：
                    先结算地形（grow 成长 / decay 衰减 → dice 定时掷骰（指定回合）→
                    rally 定时加成（指定回合）→ purge 回合末摧毁 → collapse 崩塌（幽明结界）），
                    再进入卡牌时机效果
                    （v153 口径：每回合结束时**先结算地形，再结算场上「回合结束」卡牌**）
     ⑤ runTurnEndEffects：全场“回合结束”卡牌效果（按放置队列序结算）
     ⑥ runHandEndEffects：手牌回合结束效果（挂点，现空）
   第 6 回合 ⑤-0 / ⑤ / ⑥ 之后：
     ⑦ runGameEndEffects：全场“游戏结束”效果（按放置队列序）→ finishMatch 结算胜负
   注：①⑤⑦ 结算的都是“带时机效果 fx 的场上卡牌”，先后顺序 = 场上放置顺序队列
       （双方卡牌放入场上的先后，谁先放谁先结算）；⑤-0 是地形类回合结束效果，
       恒在 ⑤（全场卡牌回合结束效果）之前结算。
   ======================================================== */

// fx 时机键：卡牌 def 可用 fx = { turnStart?, turnEnd?, gameEnd? } 声明“回合开始 /
// 回合结束 / 游戏结束”时触发的效果；每个条目与揭示 def 同构（k/a/spawn/xf/give/t）。

// ---- 场上放置顺序队列（v55）----
// 记录双方卡牌“放入场上”的先后（含开局/效果生成的落场特殊卡，如石块），供时机类
// 效果（回合开始/回合结束/游戏结束）按“谁先放谁先结算”遍历。
// 入队：手牌打出（玩家/AI）、placeToken 落场；出队：被摧毁、重置暗牌撤回手牌。
// 移动（mv / fly / roam）只是换区域，不改变放置顺序。
// v160：入队同时记录 fieldTurn（入场回合），供「回合开始效果」跳过刚登场的卡
// （如幽灵洋馆在①-0“出现时”生成的幽灵：当回合 ①-1 不结算 fx.turnStart，下回合起才结算）。
function enqueueField(card) {
  card.fieldTurn = state.turn;
  state.fieldQueue.push(card);
}
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
// v160：**回合开始**（turnStart）只结算“本回合开始前就已经在场上”的卡——地形「出现时」
// 在 ①-0 当回合生成的卡（如幽灵洋馆的幽灵）会跳过当回合的 ①-1，从下一回合开始才结算；
// 回合结束 / 游戏结束不受此限制（那些时机里它确实在场上）。
function resolveTimedEffects(timing) {
  for (const card of state.fieldQueue.slice()) { // 快照：结算中可能增删卡（spawn/摧毁）
    const fx = card.def.fx && card.def.fx[timing];
    if (!fx || !fx.k) continue;
    if (timing === 'turnStart' && card.fieldTurn === state.turn) {
      log('sys', `⏳ 「${card.def.n}」本回合刚登场，跳过本次「回合开始」效果（下回合起生效）。`);
      continue;
    }
    const locIdx = fieldLocOf(card);
    if (locIdx < 0) continue; // 防御：已不在场上
    applyEffect(card.side, locIdx, card, fx);
  }
}

// 阶段挂点 ⓪：游戏开始效果 —— restart 完成建库/发牌/选区/区域生成后、第 1 回合前执行（现无注册效果）
function runGameStartEffects() {}

// 阶段 ①-a：全场“回合开始”效果 —— 每回合最先执行（先于能量结算与抽牌），
// 按场上放置顺序队列先后结算各卡 def.fx.turnStart
// （现有两个注册者：①「幽灵」k='roam' 每回合开始若可能就随机飘到另一区域，v158；
//   ②「帕秋莉·诺蕾姬」k='drawSpell' 每回合开始从帕秋莉法术池随机抽 1 张法术加入手牌，v172）。
// v160：只结算“本回合开始前已在场上”的卡——地形「出现时」当回合生成的卡跳过本次
// （见 resolveTimedEffects）。
function runTurnStartEffects() {
  resolveTimedEffects('turnStart');
}

// 阶段 ⑤-0：区域（地形）回合结束效果 —— 每回合翻牌结算后**最先**执行（含第 6 回合、
// 终局结算前），口径为 **先结算地形、再结算场上的「回合结束」卡牌效果**（v153）：
//   ① grow 成长 / decay 衰减（寺子屋 / 间歇泉）：本区双方所有已翻开卡牌永久 ±N 战力
//      （见 locTurnEndPowerEffects）；
//   ② dice 定时掷骰（骰子赌桌，v157）：在指定回合的回合末，本区**所有卡牌**各自随机
//      永久 ±N 战力（见 locDiceEffects）；
//   ③ rally 定时加成（演唱会，v161）：在指定回合的回合末，本区**双方所有已翻开卡牌**
//      永久 +N 战力（见 locRallyEffects）；
//   ④ purge（聚变反应炉）：摧毁本区全场战力最低的牌（见 reactorPurge）；
//   ⑤ collapse 回合结束崩塌（幽明结界，v163）：本区双方总卡牌数达标即换地形（见 locCollapseEffects）。
// 同一块地形一般只带其中一类字段；后续新地形机制在此追加。
// ⚠️ collapse 放在**本阶段最后**：本回合先按原地形结算其 grow/decay/dice/rally/purge，
//    崩塌后的新地形从**下一回合**起按其规则参与（同一回合不再触发新地形的回合结束类效果）。
function runLocTurnEndEffects() {
  locTurnEndPowerEffects();
  locDiceEffects();
  locRallyEffects();
  reactorPurge();
  locCollapseEffects();
}

// 阶段 ⑤：全场“回合结束”卡牌效果 —— 在区域（地形）回合结束效果（⑤-0）**之后**执行，
// 按场上放置顺序队列先后结算各卡 def.fx.turnEnd（现无卡注册该时机效果）
function runTurnEndEffects() {
  resolveTimedEffects('turnEnd');
}

// 阶段 ⑥：手牌回合结束效果 —— 全场“回合结束”卡牌效果之后执行（现无注册效果）
function runHandEndEffects() {}

// 阶段 ⑦：全场“游戏结束”效果 —— 第 6 回合所有阶段结束后、结算胜负前执行：
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

/* 地形揭晓换场演出（v98→v99）：把当前“未揭示”外观的整列克隆到悬浮层并从不透明淡出（500ms），
   下方随即换成真实地形——观感为“未揭示逐渐消失、真实地形逐渐显示”。
   克隆必须在地形 def 切换前抓取；pointer-events:none 不挡交互，淡完自动清理。 */
function revealLocFade(locIdx) {
  const col = Game._els && Game._els.cols && Game._els.cols[locIdx];
  if (!col) return;
  const rect = col.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const clone = col.cloneNode(true);
  clone.setAttribute('aria-hidden', 'true');
  clone.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
    `width:${rect.width}px;height:${rect.height}px;margin:0;z-index:9300;` +
    `pointer-events:none;`;
  document.body.appendChild(clone);
  const anim = clone.animate(
    [
      { opacity: 1, offset: 0 },
      { opacity: .6, offset: .35 },
      { opacity: 0, offset: 1 },
    ],
    { duration: 500, easing: 'ease-in' } // v99：700ms → 500ms
  );
  anim.finished.catch(() => {}).then(() => {
    if (clone.parentNode) clone.parentNode.removeChild(clone);
  });
}

/* ①-0 地形揭晓（v74）：开局三列均为「未揭示」占位（EXTRA.unreveal，max 4 / 无效果），
   真实地形在 restart 已按抽选顺序预存进 state.locPlan；第 t 回合开始时揭晓第 t 列
   （t=1/2/3，对应左/中/右列）：
   - 换上真实地形：上限/加成/反转/purge/grow/decay/gamble/dice/rally/gust/collapse/prot 等全部字段与列头配色即刻生效；
   - 揭晓时刻 = 该地形的“出现时”：一次性生成类效果在此结算（如虹龙洞 → 双方各 1 张石块）；
   - 已放卡不移动、不增删；若真实地形为限张（max<4，如迷途竹林）且某侧已有卡超过上限
     （只有最晚揭晓的第三列可能在未揭示期放到 3 张），卡保留原格位，隙间只补在空置的
     不可用格位（渲染层自动处理：数量 = 4 − max(已放数, 上限)，即至多 2 个；
     放满 4 张或整侧被大体积卡占满时 0 个），此后该侧按“已满”不再可放。 */
// 区域「出现时」效果（v150 抽出；v165 扩展为两类生成源；v166 加入 spawn.reveal）：
//   ① spawn.card = SPECIAL 键名 → 双方各生成 n 张该特殊卡（虹龙洞 → 石块 / 幽灵洋馆 → 幽灵…）
//   ② spawn.cost = 费用（v165，妖精神社）→ 从 POOL[cost] **随机抽人物卡**，双方各生成 n 张
//      （**每张独立随机抽取**，故双方可能拿到不同的卡；大体积卡 occ>1 与 un 占位卡排除）
//   ③ spawn.reveal = true（v166，妖精神社）→ 生成后**立即结算这些卡自身的「揭示」效果**
//      （如抽到「大妖精」当场给同区双方已翻开卡 +1）；缺省 false = 只落地翻开、不触发揭示。
// 两者都走 placeToken：落地即翻开、占格位、进入场上放置顺序队列，并播“凝聚显形”演出。
// 结算时机：① 地形揭晓（locationRevealStage）；② 区域被 xform 变成该地形（v151）；
// ③ 开发者「🗻 指定地形」替换该列时（v150，可勾选关闭）。
// 返回实际落场张数；未落满（该侧已放满）时在日志里说明。
function runLocAppearEffect(idx, def) {
  const sp = def && def.spawn;
  if (!sp) return 0;
  const cnt = sp.n || 1;
  const total = cnt * 2;
  if (sp.card) {
    const tk = TOKENS[sp.card];
    if (!tk) return 0;
    const made = []; // v166：收集本次生成的卡实例（供 spawn.reveal）
    const placed = placeToken('p', idx, tk, cnt, made) + placeToken('a', idx, tk, cnt, made);
    log('sys', `${def.icon}「${def.n}」出现：双方各生成 ${cnt} 张「${tk.n}」，已落场翻开。${placed < total ? '（部分区域已放满，未能全部落下）' : ''}`);
    if (sp.reveal) resolveSpawnedReveals(made);
    return placed;
  }
  if (typeof sp.cost === 'number') {
    // 候选池：该费用的人物卡（排除 un 占位卡与大体积卡，避免占格口径错乱）
    const cands = (POOL[sp.cost] || []).filter((d) => d && !d.un && (d.occ || 1) <= 1);
    if (!cands.length) return 0;
    let placed = 0;
    const made = []; // v166：收集本次生成的卡实例（供 spawn.reveal）
    const names = { p: [], a: [] };
    for (const side of ['p', 'a']) {
      for (let i = 0; i < cnt; i++) {
        if (sideRoom(side, idx) < 1) break;
        const pick = cands[Math.floor(Math.random() * cands.length)];
        if (!placeToken(side, idx, pick, 1, made)) break;
        names[side].push(pick.n);
        placed++;
      }
    }
    log('sys', `${def.icon}「${def.n}」出现：双方各生成 ${cnt} 张随机 ${sp.cost} 费人物卡 —— 你方「${names.p.join('、') || '无'}」、敌方「${names.a.join('、') || '无'}」，已落场翻开。${placed < total ? '（部分区域已放满，未能全部落下）' : ''}`);
    if (sp.reveal) resolveSpawnedReveals(made);
    return placed;
  }
  return 0;
}

// v166（spawn.reveal = true）：让「出现时」生成的卡**也结算一次自身的「揭示」效果**。
// 结算顺序 = 落场顺序（生成时先你方后敌方，同 n>1 按生成先后）；只对带 `k` 的卡调用
// `applyEffect`（白板跳过），按该卡**当前所在区域**结算（防御：若已被前一张的效果挪走，
// 用挪走后的区域）。属同步结算（与 morph/fx 等非翻牌路径同口径）：不做 400ms 停顿与
// 逐张翻牌演出，但 ±N 气泡、战力影响历史、日志照常（由随后的渲染统一触发）。
function resolveSpawnedReveals(cards) {
  for (const c of cards) {
    if (!c || !c.def.k) continue;
    const j = fieldLocOf(c);
    if (j < 0) continue; // 防御：已不在场上
    applyEffect(c.side, j, c);
  }
}

// v171：集结（`gather` 效果键，现仅法术「三妖精集结」）的成员候选池 ——
// POOL 里 `g === group` 的卡（去重）；排除 `un` 占位卡、法术（`spell`）与大体积卡（`occ > 1`，
// 避免生成后与其他卡共存导致占格超限）。成员多于 3 张时随机取 3 张，少于 3 张则只放得下这么多区。
function gatherMembers(group) {
  if (!group) return [];
  const out = [];
  for (let c = 0; c <= 6; c++) {
    for (const d of (POOL[c] || [])) {
      if (!d || d.un || d.spell) continue;
      if ((d.occ || 1) > 1) continue;
      if (d.g !== group) continue;
      if (out.indexOf(d) >= 0) continue;
      out.push(d);
    }
  }
  return out;
}

// v171：集结的**单区生成** —— 在区域 j 的 side 一侧生成 1 张成员卡（落地即翻开、占格位、入队）。
// 返回 { ok: true, name } 或 { ok: false, why }（“若可能”不成立的原因：未开放 / 该侧已放满 / 无成员）。
// 同步版（applyEffect 的 case 'gather'）与分步演出版（applyGatherReveal）共用，保证两条路径口径一致。
function gatherSpawnAt(side, j, member, out) {
  if (!member) return { ok: false, why: '没有可分配的成员' };
  if (!locOpen(j)) return { ok: false, why: '未开放' };
  if (sideRoom(side, j) < 1) return { ok: false, why: '该侧已放满' };
  placeToken(side, j, member, 1, out);
  return { ok: true, name: member.n };
}
// v171：集结的第 ② 步（“在这之后”）—— 自己一侧场上**已翻开**的该阵营卡牌永久 +add 战力
// （含刚生成的那些；暗牌不参与，口径同 bf/de/ba）。返回受影响张数。
function applyGatherBuff(side, card, group, add) {
  if (!add || !group) return 0;
  let n = 0;
  for (let j = 0; j < 3; j++) {
    for (const c of state.players[side].zones[j].slice()) {
      if (!c.revealed || c.def.un || c.def.spell) continue;
      if (c.def.g !== group) continue; // 只强化该阵营（现「光之三妖精」）
      applyPermBuff(c, add, card); // 来源记这张法术 → 战力影响历史显示「三妖精集结」
      n++;
    }
  }
  return n;
}

function locationRevealStage() {
  const st = state;
  const idx = st.turn - 1;
  if (idx < 0 || idx >= st.locs.length) return;
  const loc = st.locs[idx];
  if (!loc || !loc.def || loc.def.id !== 'unreveal') return; // 该列已揭晓（防御）
  const target = st.locPlan && st.locPlan[idx];
  if (!target) return;
  revealLocFade(idx); // v98：旧“未揭示”外观淡出 700ms（快照需在换 def 前抓取）
  loc.def = target; // 换上真实地形
  refreshLocHeader(idx); // 列名/图标/效果文案/配色即时更新
  log('sys', `🃏 第 ${st.turn} 回合开始：地形「${target.n}」揭晓！`);
  // 揭晓时刻结算该地形的“出现时”生成效果（如虹龙洞给双方各 1 张石块）
  runLocAppearEffect(idx, target);
}

// 阶段 ①：回合开始 —— 地形揭晓 → 回合开始效果 → 能量结算 + 抽牌 → 回合状态重置
function roundStartStage() {
  const st = state;
  locationRevealStage(); // ①-0 地形揭晓：第 t 回合揭晓第 t 列（t=1..3）
  runTurnStartEffects(); // ①-1 全场“回合开始”效果（按放置队列序）
  // ①-2 抽牌（v94：第 1 回合起每回合双方都各抓 1 张——开局 3 张已逐张发放，第 1 回合再抽第 4 张）
  const drawnP = drawOne('p');
  if (drawnP) drawnP.justDrawn = true; // v91：玩家抽牌入场演出（屏幕右端滑入）
  drawOne('a');
  // ①-2 能量结算：普通局 = min(回合, 6)；开发调试 = 固定 10（v143）
  // v145：双方各自一份 energyTotal/energyLeft（基数相同，之后可单独修改）
  // v169：额外能量（energyNext）在 grantTurnEnergy 内一次性并入（并写下 energyGain 供 HUD 提示）
  grantTurnEnergy(isDevMode() ? 10 : Math.min(st.turn, 6));
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
  flushPendingDriftFly(); // v158：回合开始自动移动（幽灵 roam 等）的“滑行+缩放”演出
  log('sys', `—— 第 ${st.turn} 回合 · 双方各抓 1 张 ——`); // v94：含第 1 回合
  const stanceTip = (isDevMode() && st.playAsSide === 'a') ? '【敌方立场】' : '';
  setStatus(`第 ${st.turn} 回合 · 能量 ${st.players.p.energyTotal}${stanceTip}：可一次暗出多张牌（总费用不超过能量），出完点「结束回合」；点能量框可重置本回合暗牌。`);
}

async function playRound(gen) {
  if (gen !== state.gen) return;
  const st = state;
  roundStartStage(); // 阶段 ①：回合开始（回合开始效果 / 能量结算 / 抽牌）

  // 阶段 ②：玩家放置与移动（出牌 / 跳过 / 认输 / 双倍 / 移动 / 重置均在此阶段触发）
  const act = await waitPlayer();
  if (gen !== state.gen) return;
  if (act.type === 'retreat') { doRetreat(); return; }

  // 阶段 ③：对手放置（v143：开发调试跳过，AI 不出牌）
  state.phase = 'busy';
  renderControls();
  if (isDevMode()) {
    setStatus('开发调试：对手本回合不出牌。');
    state.aiMoves = [];
    await sleep(200);
  } else {
    setStatus('对手思考中…');
    await sleep(600);
    if (gen !== state.gen) return;
    aiThink();
    renderAll();
    await sleep(600);
  }
  if (gen !== state.gen) return;

  // 阶段 ④：翻牌结算（翻开暗牌，逐张按放置顺序结算「揭示」效果）
  await revealRound();
  if (gen !== state.gen) return;

  // 阶段 ⑤-0 区域（地形）回合结束效果（先结算地形）→ 阶段 ⑤ 全场“回合结束”卡牌效果
  // → 阶段 ⑥ 手牌回合结束效果（v153：地形恒在场上回合结束卡牌之前结算）
  runLocTurnEndEffects();
  runTurnEndEffects();
  runHandEndEffects();
  renderAll();

  if (st.turn >= 6) {
    // 阶段 ⑦：游戏结束效果（按放置队列序）→ 终局演出 → 结算胜负
    //（第 6 回合的 ⑤-0 / ⑤ / ⑥ 同样先于终局执行）
    runGameEndEffects();
    await playEndHighlights(gen); // v85：等加减动画清空后，依左→右放大胜方总点数
    if (gen !== state.gen) return;
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
  if (cardCost(card) > st.players.p.energyLeft) { setStatus('剩余能量不足，换一张更便宜的吧。'); return; }
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
  // v89：与八云紫（shift）同款的“滑行 + 缩放”飞行演出——先记录源卡当前位置
  const srcEl = miniCardElById(card.id);
  const srcRect = srcEl ? srcEl.getBoundingClientRect() : null;
  st.flyMovedFrom[card.id] = found.j; // 记录回合初所在区域，供“能量重置”退回
  found.zone.splice(found.zone.indexOf(card), 1);
  dz.push(card);
  st.flyMoved.add(card.id);
  st.moveCardId = null;
  log('p', `⇄ 「${card.def.n}」移动到了「${st.locs[locIdx].def.n}」（本回合不可再移）。`);
  setStatus(`已把「${card.def.n}」移到「${st.locs[locIdx].def.n}」。`);
  renderAll();
  if (srcRect) flyCardTo(card, srcRect); // 真身已在新格位，克隆飞行演出（不阻塞操作）
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
  if (!card || cardCost(card) > st.players.p.energyLeft) return false;
  const side = playSide(); // v144：开发调试可切到敌方立场落牌
  const zone = st.players[side].zones[locIdx];
  if (!locOpen(locIdx)) {
    setStatus(`「${locDef(locIdx).n}」还没开放，要到第 ${locDef(locIdx).minTurn} 回合才能放牌。`);
    return false;
  }
  if (occOf(card) > 1 && !occZoneOk(card, locIdx)) {
    setStatus(`「${card.def.n}」需要占满 ${occOf(card)} 格，只能放在最大可放数为 ${occOf(card)} 的区域（且己方该区为空）。`);
    return false;
  }
  if (sideRoom(side, locIdx) < occOf(card)) {
    setStatus(side === 'a'
      ? '对手这一侧已经放满，选别的区域吧。'
      : '这个区域已经放满，选别的区域吧。');
    return false;
  }
  card.side = side; // 归属：敌方立场时按对手卡结算揭示/持续等
  zone.push(card);
  enqueueField(card); // 暗出：进入场上放置顺序队列（v55）
  st.players.p.hand.splice(st.selected, 1);
  st.selected = -1;
  const paid = cardCost(card); // v169：按修正后的费用扣能量（可能被桑尼米尔克加过费）
  st.players.p.energyLeft -= paid;
  st.playerMoves.push({ cardId: card.id, loc: locIdx, side });
  if (side === 'a') {
    log('a', `你（敌方立场）暗出「${card.def.n}」(${paid}费) → ${st.locs[locIdx].def.n}`);
  } else {
    log('p', `你暗出「${card.def.n}」(${paid}费) → ${st.locs[locIdx].def.n}`);
  }
  renderAll();
  if (st.players.p.energyLeft <= 0) {
    setStatus('能量已用完，点「结束回合」交给对手。');
  } else {
    setStatus(`剩余能量 ${st.players.p.energyLeft}：还可以继续出牌，或点「结束回合」。`);
  }
  return true;
}

// v173：AI **不再加倍**——原先这里有「对手随机跟进双倍下注（50%）」的分支，现按用户口径去掉：
// 赌注只由玩家推动（玩家可连续加倍至上限 8），对手既不主动加倍也不跟进。
function uiSnap() {
  const st = state;
  if (st.phase !== 'play' && st.phase !== 'busy') return;
  if (st.stakes >= 8) { setStatus('赌注已达上限 8。'); return; }
  st.stakes = Math.min(8, st.stakes * 2);
  st.pSnapped = true;
  log('snap', `⚡ 你双倍下注！赌注升至 ${st.stakes}`);
  setStatus(`你双倍下注！当前赌注 ${st.stakes}`);
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
  // 1) 从区域里取回暗牌（含开发调试敌方立场落到对手区的牌）
  const removed = [];
  for (const mv of st.playerMoves) {
    const side = mv.side || 'p';
    const zone = st.players[side].zones[mv.loc];
    const ci = zone.findIndex((c) => c.id === mv.cardId);
    if (ci >= 0) {
      const [card] = zone.splice(ci, 1);
      card.side = 'p'; // 回手后归属恢复为我方
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
  // 3) 能量返还（只返还玩家侧；敌方立场落牌仍耗玩家能量）
  const en = pl;
  en.energyLeft = Math.min(en.energyTotal, en.energyLeft + removed.reduce((s, c) => s + cardCost(c), 0));
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
// v117：人机思考逻辑已拆到独立文件 ai.js（aiThink），此处经全局函数名被 playRound 阶段 ③ 调用。
// v173：ai.js 已重做——影子盘面效果估值（mdEvaluate）+ 回合级束搜索（aiPlanMoves）+ 三档难度
//      （AI.setLevel('easy'|'hard'|'nightmare')，默认困难；AI 不再加倍、不再跟进双倍）。

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
    // v144：玩家以敌方立场暗出的牌记在 playerMoves.side='a'，按归属并入该方翻牌序
    for (const mv of movesForSide(side)) order.push({ side, cardId: mv.cardId, loc: mv.loc });
  }
  for (const mv of order) {
    const pl = st.players[mv.side];
    const card = pl.zones[mv.loc].find((c) => c.id === mv.cardId);
    if (!card) continue;
    card.revealed = true;
    card.justRevealed = true;
    // v156：区域「翻开时」效果（如驹草赌场：在本区翻开的卡牌永久随机 ±1）——
    // 在翻面瞬间、该卡自身揭示效果结算**之前**结算，因此卡面战力/翻牌日志/后续
    // bl 落后判定等都按博彩后的威力计算。
    runLocRevealEffects(mv.side, mv.loc, card); // v170：法术不吃博彩（见该函数）
    renderZones(); // 翻面：新元素带 .played-now → CSS flipIn（0.5s 从小到大缩放）入场
    log(mv.side, isSpell(card)
      ? `「${card.def.n}」翻牌 — 法术（无战力；揭示效果结算后消散）`
      : `「${card.def.n}」翻牌 — 威力 ${cardPowerIn(mv.loc, card)}`);
    let willChange = false;
    if (card.def.k) {
      // 只有效果“真的会造成变化”时才停顿展示（缩放动画同时播放，避免同帧重建吞掉入场）
      willChange = revealEffectWillChange(mv.side, mv.loc, card);
      if (willChange) await sleep(400);
      if (card.def.k === 'shift') {
        // 八云紫整体右移：分步演出，每移动一张间隔 0.3s（v78）
        await applyShiftReveal(mv.side, card.def.t);
      } else if (card.def.k === 'gather') {
        // v171：三妖精集结——按区域顺序逐区生成并揭示（第 1→2→3 区），每区之间 0.5s；
        // 三区都揭示完并做完“己方三妖精 +N 战力”之后才返回，随后才轮到本法术消散。
        await applyGatherReveal(mv.side, card);
      } else {
        applyEffect(mv.side, mv.loc, card);
      }
      if (willChange) renderZones(); // 效果确有变化才重建（白板/未触发时保留入场元素直到动画播完）
    }
    // v170：法术——**在且仅在**自身揭示效果结算完之后消散（此刻它仍占着 1 个格位，
    // 因此它自己的生成/换边类效果判定都把它算作占位）；消散后再结算区域「揭示后吹飞」
    // （gust 会因该卡已不在本区而自然跳过）。
    if (isSpell(card)) {
      if (vanishSpell(card)) renderZones(); // 让格位可见地空出来（消散演出在悬浮层播）
    }
    flushPendingSwitchFly(); // v96：换边（switch/gift）后播放“滑行+缩放”演出（真身已渲染，克隆飞行）
    // v162：区域「揭示后吹飞」（gust，如魔力风暴）——**自身揭示效果结算完之后**才移动；
    // roam 类揭示键（k='roam'）的漂移也在这里统一 flush 飞行演出。
    runLocAfterRevealEffects(mv.side, mv.loc, card);
    flushPendingDriftFly();  // v158/v162：roam / gust 的“滑行+缩放”飞行演出
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
  // v170：法术不算“可被指向的目标”——dw/dwh 的最弱、mv 的最弱、gift 的己方最低都跳过它
  const vis = theirs.filter((c) => c.revealed && !c.def.un && !c.def.spell);
  // v170：法术没有战力——「落后自增」（bl）与「对方同区落牌自增」（oc）对它没有意义，不产生变化
  if (def.spell && (def.k === 'bl' || def.k === 'oc')) return false;
  switch (def.k) {
    case 'bf': return mine.some((c) => c !== card && !c.def.un && c.revealed);
    case 'de': return vis.length > 0;
    case 'ba': return true; // 至少自己已翻开会吃到 +N
    case 'bl': return zoneEff(side, locIdx) < zoneEff(other, locIdx);
    case 'dw':
    case 'dwh': return vis.length > 0 && !locNoDestroy(locIdx);
    case 'dwb': {
      // v172（火神之光）：摧毁本区**双方**最弱随机一张——本区（敌我合计）存在可摧毁的
      // 已翻开卡、且本区没有免摧毁时，才真的会造成盘面变化（否则跳过结算前的停顿）
      const both = mine.concat(theirs).filter((c) => c.revealed && !c.def.un && !c.def.spell);
      return both.length > 0 && !locNoDestroy(locIdx);
    }
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
    case 'spawnS': {
      // v172（祖母绿巨石）：只投放到“自己一侧”——自己这侧有空位才算会真的变化
      const sp = def.spawnS;
      const tk = sp && TOKENS[sp.card];
      if (!tk) return false;
      const cnt = sp.n || 1;
      return Math.min(cnt, sideRoom(side, locIdx)) > 0;
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
    case 'gather': {
      // v171：集结——三个区域里只要有任一区域“自己一侧还放得下且已开放”就会真的生成卡；
      // 否则退一步看“自己一侧场上是否已有已翻开的该阵营卡牌”（那一步强化仍会造成变化）
      const gw = def.gather;
      if (!gw || !gw.group) return false;
      for (let j = 0; j < 3; j++) {
        if (locOpen(j) && sideRoom(side, j) >= 1) return true;
      }
      return st.players[side].zones.some((z) => z.some((c) => c.revealed && !c.def.un && !c.def.spell && c.def.g === gw.group));
    }
    case 'switch':
      // 换边只有在“对方该区没放满”时才真的会变化
      return sideRoom(other, locIdx) >= 1;
    case 'morph':
      // 变身只有在“对方手牌里有可作目标的卡”时才会变化（目标是随机的）
      // v170：法术不作为变身目标（变身后会立刻消散，语义混乱），候选池排除法术
      return st.players[other].hand.some((c) => c && c.def && !c.def.spell);
    case 'gift': {
      // 换边己方最低已翻开卡：需要“本区有其他已翻开的己方卡”且“对方该区有空位”才真会变化
      if (sideRoom(other, locIdx) < 1) return false;
      return st.players[side].zones[locIdx].some((c) => c !== card && c.revealed && !c.def.un && !c.def.spell);
    }
    case 'give': return st.players[side].hand.length < 7;
    case 'xform': {
      const t = findLocDef(def.xf);
      if (!t) return false;
      return !(['p', 'a'].some((s) => sideUsed(s, locIdx) > t.max));
    }
    case 'oc': {
      const present = movesForSide(other).some((m) => m.loc === locIdx);
      return present;
    }
    case 'costUp': {
      // v169：对方手牌里存在“还能再涨费”的卡（现 `cardCost < 6`）才算会真的变化；
      // 手上全是 6 费或手牌为空 → 本次揭示落空，跳过结算前的停顿。
      const up = def.a || 1;
      return st.players[other].hand.some((c) => c && c.def && !c.def.un && cardCost(c) + up <= 6);
    }
    case 'energyNext':
      // v169（斯塔萨菲雅）：总是真的会造成变化（下回合能量 +N；末回合时仍按“会触发”处理并记日志）
      return true;
    case 'shift': {
      // 需要“最右侧（第 3 列）己方侧”有空位，且“最左侧（第 1 列）己方侧”有已翻开可搬卡
      const roomR = sideRoom(side, 2);
      if (roomR < 1) return false;
      return st.players[side].zones[0].some((c) => c.revealed && !c.def.un && roomR >= occOf(c));
    }
    case 'roam': {
      // v158：自身能否移到另一个区域——任一其它区域已开放且该侧放得下（occ 口径）
      const owner = card.side || side;
      for (let j = 0; j < 3; j++) {
        if (j === locIdx || !locOpen(j)) continue;
        if (sideRoom(owner, j) >= occOf(card)) return true;
      }
      return false;
    }
    case 'drawSpell': {
      // v172（帕秋莉）：抽法术入手牌——池非空且手牌未满才会真的变化。
      // 注：本键按设计只作 fx 时机效果（回合开始）用，不经过翻牌流程，因此这里只按卡级
      // spellPool 兜底判断（fx 条目里的 pool 不在此处读取）。
      const keys = Array.isArray(def.spellPool) ? def.spellPool : [];
      return keys.length > 0 && st.players[side].hand.length < 7;
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

/* ---- v80→v84：卡牌“永久 ±N 战力”的演出 ----
   applyPermBuff 是“永久增减战力”的统一收口：改 buff + 记账 + 排队（正→绿 +N，负→红 -N）。
   演出由 renderZones 末尾 flushBuffFlash 统一触发：对被改力且在场上已翻开的卡，
   播放 1000ms 动画——正向绿色（+N 气泡），负向红色（-N 气泡），末段约 300ms 渐隐；
   光环与气泡放在 body 悬浮层，不随卡面重建而中断（v83+）。 */
let buffFlashQueue = [];
// v169：费用修正（如桑尼米尔克把对方手牌 +1 费）的演出队列——被改费的卡若是场上/手牌可见卡，
// 渲染后由 flushCostFlash 播“费用 ±N”气泡；目标在对方手牌（不可见）时落到侧栏对手信息区。
let costFlashQueue = [];
function applyPermBuff(card, d, srcCard, tag) {
  if (!card) return;
  // v170：法术没有战力——任何位置（手牌/场上揭示瞬间/回手）都不吃战力增减，
  // 因而不进战力影响历史、不排队 ±N 演出（地形 gamble/dice/grow/decay/rally 也走这里收口）
  if (isSpell(card)) return;
  card.buff += d;
  addBuffLog(card, d, srcCard, tag);
  if (d !== 0) {
    const hit = buffFlashQueue.find((q) => q.card === card);
    if (hit) hit.d += d;
    else buffFlashQueue.push({ card, d });
  }
}
function flushBuffFlash() {
  if (!buffFlashQueue.length) return;
  const items = buffFlashQueue;
  buffFlashQueue = [];
  for (const q of items) {
    const el = miniCardElById(q.card.id);
    if (!el || !el.isConnected) continue; // 已不在场上（如凤凰重生回手）则不演
    spawnPowerPop(el, q.d);
  }
}
function spawnPowerPop(el, d) {
  const gain = d > 0;
  // 卡面本体只做短暂提亮/压暗（会被后续 renderZones 重建打断也无妨）
  el.classList.remove('buff-gain', 'buff-loss');
  void el.offsetWidth; // 强制 reflow，保证连续两次都能重启动画
  el.classList.add(gain ? 'buff-gain' : 'buff-loss');

  // 光环 + “±N”气泡放到 body 悬浮层：不受缩略卡重建影响，能完整播完 1s 并渐隐
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return; // 不可见（如已回手）则只做卡面闪
  const box = document.createElement('div');
  box.className = gain ? 'gain-ring' : 'gain-ring loss';
  box.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
    `width:${rect.width}px;height:${rect.height}px;border-radius:10px;` +
    `z-index:9400;`;
  const pop = document.createElement('span');
  pop.className = gain ? 'buff-gain-pop' : 'buff-gain-pop loss';
  pop.textContent = gain ? '+' + d : String(d); // 正向 “+N”，负向 “-N”
  box.appendChild(pop);
  document.body.appendChild(box);
  setTimeout(() => {
    if (box.parentNode) box.parentNode.removeChild(box);
    el.classList.remove('buff-gain', 'buff-loss');
  }, 1080); // 1000ms 动画完整播完（含末段 300ms 渐隐）后清理
}

/* ==================== v170：法术（spell）的消散 ====================
   法术只带「能量消耗 + 揭示效果」，在**且仅在**揭示效果结算完之后自行消失：
   从所在区域移除、移出放置顺序队列、腾出它占的那 1 个格位。
   ⚠️ 这不是“摧毁”：不走 phoenixRevive / surviveDestroy、不查 locNoDestroy、不播分崩离析，
   也不进战力影响历史；不返手、不返牌库（一局就这一份）。
   入口两处：
     ① 正常翻牌流程（revealRound）：该卡自身揭示结算完之后调用（vanishSpell）；
     ② 落场生成的衍生物法术（placeToken / clone）：等同手打一张——先结算揭示，随即消散
        （settleFieldSpell，同步结算、无 400ms 停顿与翻牌演出）。 */

// 落场生成的衍生物法术：先结算它自身的「揭示」效果（白板则跳过），随后立即消散。
// 由 placeToken（地形 spawn / 卡的 spawn、spawnO）与 clone（另两区生成分身）调用。
// 两次 renderZones：① 先让这张法术在场上显形（否则刚落场就被移除、玩家什么都看不到）；
// ② 消散后再渲染一次，让格位可见地空出来。
function settleFieldSpell(card, locIdx) {
  if (!isSpell(card)) return false;
  renderZones();
  if (card.def.k) applyEffect(card.side, locIdx, card);
  vanishSpell(card);
  renderZones();
  return true;
}

// 法术消散：移出区域与放置队列、腾出格位、播消散演出并记日志。
// 返回 true 表示确实消散了（调用方随后应重渲染，让格位可见地空出来）。
function vanishSpell(card) {
  if (!isSpell(card)) return false;
  const locIdx = fieldLocOf(card);
  if (locIdx < 0) return false; // 防御：已不在场上
  const locName = locDef(locIdx).n;
  const zone = state.players[card.side].zones[locIdx];
  const i = zone.indexOf(card);
  if (i >= 0) zone.splice(i, 1);
  dequeueField(card); // 离开场上：后续时机效果（fx）不再结算它
  playSpellVanish(card); // 消散演出（克隆卡面上浮淡出，放 body 悬浮层不受重渲染影响）
  log('sys', `🪄 ${card.side === 'p' ? '你' : '对手'}的法术「${card.def.n}」揭示结算完毕，自行消散：让出「${locName}」的 1 个格位（不属于被摧毁）。`);
  return true;
}

// 消散演出：卡面克隆轻微上浮 + 放大 + 提亮淡出，并迸发几颗星光；约 0.52s。
// 复用「额外能量」的 .energy-star 粒子（追加 .spell-star 换成淡紫辉光）。
function playSpellVanish(card) {
  const el = miniCardElById(card.id);
  if (!el || !el.isConnected) return;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const clone = el.cloneNode(true);
  clone.removeAttribute('data-cardid'); // 克隆体不带定位属性，避免干扰按卡查找
  clone.classList.remove('played-now', 'spawned-now');
  clone.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
    `width:${rect.width}px;height:${rect.height}px;margin:0;` +
    `z-index:9300;pointer-events:none;border-radius:10px;overflow:hidden;` +
    `box-shadow:0 0 18px rgba(150,120,255,.55);`;
  document.body.appendChild(clone);
  const cleanup = () => { if (clone.parentNode) clone.parentNode.removeChild(clone); };
  const kf = [
    { transform: 'translateY(0) scale(1)', opacity: 1, filter: 'brightness(1)' },
    { transform: 'translateY(-9px) scale(1.06)', opacity: 1, filter: 'brightness(1.5)', offset: .35 },
    { transform: 'translateY(-30px) scale(1.16)', opacity: 0, filter: 'brightness(1.9)' },
  ];
  if (typeof clone.animate === 'function') {
    clone.animate(kf, { duration: 520, easing: 'cubic-bezier(.2,.7,.3,1)' })
      .finished.catch(() => {}).then(cleanup);
  } else {
    setTimeout(cleanup, 520);
  }
  spawnSpellSparks(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

// 消散星光：以锚点为中心向外迸发若干淡紫星点（复用 .energy-star 的飞行关键帧）
function spawnSpellSparks(cx, cy) {
  const glyphs = ['✨', '🌟', '💫', '✦'];
  const count = 8;
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    s.className = 'energy-star spell-star';
    s.textContent = glyphs[i % glyphs.length];
    const ang = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const dist = 28 + Math.random() * 46;
    s.style.left = cx + 'px';
    s.style.top = cy + 'px';
    s.style.fontSize = (13 + Math.random() * 10).toFixed(1) + 'px';
    s.style.setProperty('--edx', `${(Math.cos(ang) * dist).toFixed(1)}px`);
    s.style.setProperty('--edy', `${(Math.sin(ang) * dist - 14).toFixed(1)}px`);
    s.style.animationDelay = (Math.random() * 0.12).toFixed(2) + 's';
    document.body.appendChild(s);
    setTimeout(() => { if (s.parentNode) s.parentNode.removeChild(s); }, 1400);
  }
}

// 被摧毁时的“分崩离析”演出（v88）：把场上缩略卡切成 3×2 六块碎片，
// 各自向外迸散、旋转并渐隐（1s，节奏参考 ±N 气泡：迅速爆发 → 缓飞 → 末段渐隐）。
// 悬浮层放 body，不随 renderZones 重建而中断；真正的移除发生在调用之后。
function playShatter(card) {
  const el = miniCardElById(card.id);
  if (!el || !el.isConnected) return;
  const rect = el.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const COLS = 3, ROWS = 2;
  const tw = rect.width / COLS;
  const th = rect.height / ROWS;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const base = el.cloneNode(true);
  base.removeAttribute('data-cardid'); // 克隆体不带定位属性，避免干扰按卡查找
  base.style.width = rect.width + 'px';
  base.style.height = rect.height + 'px';
  base.style.margin = '0';
  const pieces = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const tile = document.createElement('div');
      tile.style.cssText =
        `position:fixed;left:${rect.left + c * tw}px;top:${rect.top + r * th}px;` +
        `width:${tw}px;height:${th}px;overflow:hidden;pointer-events:none;` +
        `z-index:9400;border-radius:2px;`;
      const shard = base.cloneNode(true);
      shard.style.position = 'absolute';
      shard.style.left = (-c * tw) + 'px';
      shard.style.top = (-r * th) + 'px';
      tile.appendChild(shard);
      document.body.appendChild(tile);
      // 每块沿“卡片中心指向该块中心”的方向迸散
      const pcx = rect.left + c * tw + tw / 2;
      const pcy = rect.top + r * th + th / 2;
      const nLen = Math.max(1, Math.hypot(pcx - cx, pcy - cy));
      const dist = 30 + Math.random() * 78;
      const dx = ((pcx - cx) / nLen) * dist + (Math.random() - 0.5) * 36;
      const dy = ((pcy - cy) / nLen) * dist + (Math.random() - 0.5) * 40 - 16; // 轻微上抛
      const rot = (Math.random() - 0.5) * 70;
      const kf = [
        { transform: 'translate(0px,0px) rotate(0deg) scale(1)', opacity: 1, offset: 0 },
        { transform: `translate(${dx * .1}px, ${dy * .1}px) rotate(${rot * .1}deg) scale(1.03)`, opacity: 1, offset: .12 },
        { transform: `translate(${dx * .5}px, ${dy * .5}px) rotate(${rot * .45}deg) scale(.95)`, opacity: 1, offset: .42 },
        { transform: `translate(${dx * .82}px, ${dy * .82}px) rotate(${rot * .9}deg) scale(.85)`, opacity: 1, offset: .68 },
        { transform: `translate(${dx * 1.18}px, ${dy * 1.18}px) rotate(${rot * 1.25}deg) scale(.55)`, opacity: 0, offset: 1 },
      ];
      const anim = tile.animate(kf, { duration: 1000, easing: 'cubic-bezier(.22,.7,.3,1)' });
      anim.finished.catch(() => {}).then(() => {
        if (tile.parentNode) tile.parentNode.removeChild(tile);
      });
      pieces.push(tile);
    }
  }
  return pieces;
}

// 在卡片上“登出”换边演出：若 switch/gift 刚记了待播，就在本次渲染后播放。
// 复用 flyCardTo 的“滑行 + 缩放”克隆飞行（真身已在对方侧渲染，飞完露出）；
// 不阻塞：revealRound 随后的停顿/渲染会自然接续。
function flushPendingSwitchFly() {
  if (!pendingSwitchFly) return;
  const f = pendingSwitchFly;
  pendingSwitchFly = null;
  if (f && f.srcRect) flyCardTo(f.card, f.srcRect);
}

// v158：flush 自身移动（roam，如幽灵回合开始飘走）的飞行演出队列——
// 调用点：① roundStartStage 的 renderAll() 之后；② revealRound 每张翻牌结算之后。
function flushPendingDriftFly() {
  if (!pendingDriftFly.length) return;
  const items = pendingDriftFly;
  pendingDriftFly = [];
  for (const f of items) {
    if (f && f.srcRect) flyCardTo(f.card, f.srcRect);
  }
}

// 区域免摧毁（现两个来源：**地形字段** def.prot，如「睡鼠神祠」v164；**卡级持续** def.prot，
// 如「蕾蒂」）：本区域一旦处于免摧毁状态，该区域（**双方**）所有在场卡牌均无法被摧毁——
// 针对本区域的任何“摧毁”指向（dw / dwh / 回合末摧毁 purge 等）一律失效；被保护卡不会离场，
// 因此防摧毁 surv / 凤凰重生 phx 也不会触发。
// 判定（locNoDestroy）：①本区域地形带 prot → 恒为真（v164，睡鼠神祠；与地形共存亡，
//   地形被 xform / collapse 换掉后立即失效）；②否则遍历双方该列，存在“已翻开且仍在场”
//   的 prot 卡（蕾蒂）→ 为真：防护按“源卡当前所在区域”实时判定，蕾蒂被移去其它区域 →
//   原区域立即失效、新区域立即生效；同区换边（switch/gift 类把她在本区内换到对方一侧）
//   仍属同一区域，因保护的是敌我双方，故效果不变；蕾蒂真正离场才全场失效。
function locNoDestroy(locIdx) {
  if (locDef(locIdx).prot) return true; // v164：地形级免摧毁（如睡鼠神祠）
  for (const s of ['p', 'a']) {
    for (const c of state.players[s].zones[locIdx]) {
      if (c.revealed && c.def.prot) return true;
    }
  }
  return false;
}

// 防摧毁（def.surv=N，现仅灵乌路空 surv:2）：该卡被任何“摧毁”指向时不会离场，
// 取而代之**永久降低 N 点战力**（每次触发再降 N、可多次；若被反应炉类反复点名会反复降低）。
// 返回 true = 已替代（卡仍在场、由本函数自行记账）；false = 按原样移除摧毁。
function surviveDestroy(card) {
  const surv = card && card.def && card.def.surv;
  if (!surv) return false;
  applyPermBuff(card, -surv, null, '防摧毁'); // 永久 -N（红色 -N 演出）
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
    applyPermBuff(card, phx, null, '凤凰重生');
    card.revealed = false; // 回手后再次打出需重新暗出/翻面
    st.players[side].hand.push(card);
    log('danger', `🔥 「${card.def.n}」被摧毁时触发凤凰重生：返回手牌并永久 +${phx} 战力（下次打出威力 ${cardPower(card)}）。`);
  } else {
    log('danger', `🔥 「${card.def.n}」被摧毁时想凤凰重生，但手牌已满（7 张），重生失败、被摧毁。`);
  }
  return true;
}

/* ---- shift（整体右移）的分步实现（v78→v79）----
   peekShiftCard：找“最左侧区域（下标 0）”下一个可搬的已翻开卡（占格判定，不搬）。
   shiftMoveCard：把指定卡从最左侧搬到最右侧己方一侧（数据层）。
   shiftMoveOne：peek + move 一步到位（供同步路径用）。
   applyShiftReveal：揭示演出版——逐张搬，每张先“滑行 + 缩放”飞过去（约 0.26s），
   卡片间隔保持约 0.3s；无动画能力时退化为纯停顿。 */
function peekShiftCard(side) {
  const st = state;
  const src = st.players[side].zones[0];
  if (sideRoom(side, 2) < 1) return null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (!c.revealed || c.def.un) continue; // 暗牌/un 不搬
    if (sideRoom(side, 2) < occOf(c)) continue; // 右侧放不下这张（如大体积）
    return c;
  }
  return null;
}
function shiftMoveCard(side, card) {
  const st = state;
  const src = st.players[side].zones[0];
  const dst = st.players[side].zones[2];
  const i = src.indexOf(card);
  if (i < 0) return;
  src.splice(i, 1);
  dst.push(card);
}
function shiftMoveOne(side) {
  const card = peekShiftCard(side);
  if (!card) return null;
  shiftMoveCard(side, card);
  return card;
}
// 按卡牌 id 找当前渲染出的场上缩略卡元素
function miniCardElById(id) {
  return document.querySelector('.zone [data-cardid="' + id + '"]');
}
// 飞行演出：克隆一张卡从源格位“滑行+缩放”落到目标格位，落定后露出真身
function flyCardTo(card, srcRect) {
  const dstEl = miniCardElById(card.id);
  if (!dstEl) return Promise.resolve();
  const dstRect = dstEl.getBoundingClientRect();
  const usable = srcRect && srcRect.width > 1 && srcRect.height > 1
    && dstRect.width > 1 && dstRect.height > 1;
  const cleanup = () => {
    const fly = document.querySelector('.fly-card');
    if (fly && fly.parentNode) fly.parentNode.removeChild(fly);
    dstEl.style.visibility = '';
  };
  if (!usable || typeof dstEl.animate !== 'function') { cleanup(); return Promise.resolve(); }
  const flyer = document.createElement('div');
  flyer.className = (dstEl.className || 'mini-card') + ' fly-card';
  flyer.innerHTML = dstEl.innerHTML;
  const sx = dstRect.width / srcRect.width;
  const sy = dstRect.height / srcRect.height;
  const dx = dstRect.left - srcRect.left;
  const dy = dstRect.top - srcRect.top;
  flyer.style.cssText =
    `position:fixed;left:${srcRect.left}px;top:${srcRect.top}px;` +
    `width:${srcRect.width}px;height:${srcRect.height}px;margin:0;` +
    `z-index:9000;pointer-events:none;border-radius:10px;overflow:hidden;` +
    `box-shadow:0 12px 26px rgba(0,0,0,.42);will-change:transform;`;
  dstEl.style.visibility = 'hidden'; // 真身先隐藏，防原地叠影
  document.body.appendChild(flyer);
  const kf = [
    { transform: 'translate(0px,0px) scale(.92,.92)' },
    { transform: `translate(${dx * .55}px, ${dy * .55 - 22}px) scale(${sx * .98}, ${sy * .98})`, offset: .5 },
    { transform: `translate(${dx}px, ${dy}px) scale(${sx * 1.07}, ${sy * 1.07})`, offset: .84 },
    { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
  ];
  const anim = flyer.animate(kf, { duration: 260, easing: 'cubic-bezier(.25,.72,.28,1)' });
  return anim.finished
    .catch(() => {}) // 被中断（如重新开局）也照常收尾
    .then(cleanup);
}

async function applyShiftReveal(side, txt) {
  const gen = state.gen;
  const moved = [];
  while (true) {
    if (gen !== state.gen) return; // 重新开局等中断
    const card = peekShiftCard(side);
    if (!card) break;
    // 先记录源卡当前屏幕位置（搬之前）
    const srcEl = miniCardElById(card.id);
    const srcRect = srcEl ? srcEl.getBoundingClientRect() : null;
    shiftMoveCard(side, card); // 数据层搬家
    moved.push(card.def.n);
    log(side, `✦ 把「${card.def.n}」搬到了最右侧区域。`);
    renderZones(); // 真身已在新格位
    if (srcRect) {
      await flyCardTo(card, srcRect); // 滑行+缩放（约 0.26s）
      if (gen !== state.gen) return;
      await sleep(40); // 与上一张的间隔合计约 0.3s
    } else {
      await sleep(300); // 拿不到坐标时退化为纯停顿
    }
  }
  if (!moved.length) {
    log(side, `✦ ${txt}：最左侧区域没有可搬的已翻开卡，或最右侧区域已放满。`);
  }
}

/* ---- v171：集结（gather）的**分步揭示演出**（只在正常翻牌流程 revealRound 里使用）----
   按区域顺序逐区推进：**第 1 区的揭示 → 第 2 区的揭示 → 第 3 区的揭示**，
   每区之间停顿约 **0.5s**；三区全部揭示完之后才做“己方场上已翻开的三妖精各 +add 战力”
   这一步（“在这之后”），再留约 0.5s，随后才由 revealRound 播放这张法术的**消散演出**
   （revealRound 里紧跟着就是 `if (isSpell(card)) vanishSpell(...)`）。
   与同步版（applyEffect 的 case 'gather'）口径完全一致，只多出节奏与逐步渲染。 */
async function applyGatherReveal(side, card) {
  const gen = state.gen;
  const gw = card.def.gather;
  const group = gw && gw.group;
  const members = gatherMembers(group);
  if (!members.length) {
    log(side, `✦ ${card.def.n}：卡池里没有可生成的成员（阵营「${GROUPS[group] || group || '?'}」），无事发生。`);
    return;
  }
  const picked = shuffle(members.slice()).slice(0, 3); // 随机排列：每区一张、三张互不相同
  for (let j = 0; j < 3; j++) {
    if (gen !== state.gen) return; // 重新开局等中断（同 applyShiftReveal 口径）
    const who = state.locs[j].def.n;
    const made = [];
    const r = gatherSpawnAt(side, j, picked[j], made);
    if (!r.ok) {
      log(side, `✦ ${card.def.n}：第 ${j + 1} 区「${who}」跳过生成（${r.why}）。`);
    } else {
      renderZones(); // 先让这张妖精在场上显形（凝聚显形演出）
      log(side, `✦ ${card.def.n}：第 ${j + 1} 区「${who}」生成「${r.name}」，并结算其揭示。`);
      resolveSpawnedReveals(made); // 结算**这一区**妖精自身的「揭示」（±N/削弱/加费等演出随之弹出）
      renderZones();
    }
    await sleep(500); // v171：三区之间间隔 0.5s（第 3 区之后这一停也留给它的揭示演出）
    if (gen !== state.gen) return;
  }
  // ② 三区都揭示完之后（“在这之后”）：己方场上已翻开的三妖精各 +add 战力
  const add = (gw && gw.add) || 0;
  if (add) {
    const n = applyGatherBuff(side, card, group, add);
    log(side, n
      ? `✦ ${card.def.n}：${side === 'p' ? '你' : '对手'}方场上已翻开的「${GROUPS[group] || group}」各 ${add > 0 ? '+' : '−'}${Math.abs(add)} 战力（影响 ${n} 张）。`
      : `✦ ${card.def.n}：己方场上没有已翻开的三妖精，这一步无人可强化。`);
    renderZones();
    await sleep(500); // 留给 +N 演出一点时间；随后 revealRound 才播放这张法术的消散演出
    if (gen !== state.gen) return;
  }
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
      // v170：法术没有战力、且马上消散，不吃任何增减（也不计入“影响 N 张”）
      let n = 0;
      for (const c of mine) if (c !== card && !c.def.un && !c.def.spell && c.revealed) { applyPermBuff(c, fx.a, card); n++; }
      log(side, `✦ ${txt}${n ? `（影响 ${n} 张）` : '（但该区没有已翻开的其他友军）'}`);
      break;
    }
    case 'de': {
      // 只削弱“结算时已翻开”的对方卡牌：对方暗牌不会提前被降
      let n = 0;
      for (const c of theirs) { if (c.def.un || c.def.spell || !c.revealed) continue; applyPermBuff(c, -fx.a, card); n++; }
      log(side, `✦ ${txt}${n ? `（影响 ${n} 张）` : '（但没有已翻开的对方卡牌可影响）'}`);
      break;
    }
    case 'ba': {
      // 双方同增同样只作用于结算时已翻开的卡牌
      for (const c of mine) if (!c.def.un && !c.def.spell && c.revealed) applyPermBuff(c, fx.a, card);
      for (const c of theirs) if (!c.def.un && !c.def.spell && c.revealed) applyPermBuff(c, fx.a, card);
      log(side, `✦ ${txt}`);
      break;
    }
    case 'bl': {
      if (isSpell(card)) { log(side, `✦ 「${card.def.n}」是法术（没有战力），「落后自增」不生效。`); break; } // v170
      const myT = zoneEff(side, locIdx);
      const opT = zoneEff(other, locIdx);
      if (myT < opT) { applyPermBuff(card, fx.a, card); log(side, `✦ 落后触发：${def.n} 威力 +${fx.a}（现 ${cardPowerIn(locIdx, card)}）`); }
      else log(side, `✦ ${def.n} 未落后，效果不触发。`);
      break;
    }
    case 'dw': {
      if (theirs.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但该区空无一人。`); break; }
      if (locNoDestroy(locIdx)) { log(side, `✦ ${def.n} 想摧毁卡牌，但本区域存在免摧毁效果（地形「睡鼠神祠」或「蕾蒂」等），所有卡牌都无法被摧毁。`); break; }
      // 只能以“已翻开”的对方卡牌为目标：暗牌不可被提前摧毁；un 占位卡不可被摧毁
      // v170：法术也不可选为目标（它马上自行消散，选它等于白费一次指向）
      const vis = theirs.filter((c) => c.revealed && !c.def.un && !c.def.spell);
      if (vis.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但对方在此区没有可摧毁的已翻开卡牌（暗牌与法术不算）。`); break; }
      let minP = Infinity, target = null;
      for (const c of vis) {
        const p = cardPowerIn(locIdx, c);
        if (p < minP) { minP = p; target = c; }
      }
      if (phoenixRevive(target, locIdx)) break; // 凤凰重生（如藤原妹红）：回手 +N 战力
      if (surviveDestroy(target)) break; // 防摧毁（如灵乌路空）：替代为降战力、卡不离场
      playShatter(target); // 分崩离析演出（v88）
      theirs.splice(theirs.indexOf(target), 1);
      dequeueField(target); // 被摧毁：移出放置队列（后续时机不再结算它）
      log('danger', `✦ ${def.n} 摧毁了对方「${target.def.n}」（威力 ${minP}）`);
      break;
    }
    case 'dwb': {
      // v172（火神之光·法术）：揭示——摧毁**本区双方**（敌我混比）已翻开卡牌里战力最低的
      // **随机一张**（并列最低时在其中随机挑一张；与地形「聚变反应炉」的 purge「并列全删」不同）。
      // 口径与 dw/dwh 完全一致：只选“已翻开”的卡（暗牌不可被提前摧毁）、排除 un 占位卡与法术
      // （法术马上自行消散，选它等于白费一次指向）；本区存在免摧毁（地形 prot「睡鼠神祠」/
      // 卡级 prot「蕾蒂」，locNoDestroy）时整条失效、不选目标；目标带 phx/surv 时按各自机制
      // 处理（凤凰重生回手 +N / 防摧毁改为永久降 N、卡不离场）。
      // ⚠️ 因为是双方混比，**可能摧毁己方自己的卡**（卡面写的就是“双方”）。
      const both = mine.concat(theirs).filter((c) => c.revealed && !c.def.un && !c.def.spell);
      if (both.length === 0) { log(side, `✦ ${def.n} 想摧毁卡牌，但本区域没有可摧毁的已翻开卡牌（暗牌与法术不算）。`); break; }
      if (locNoDestroy(locIdx)) { log(side, `✦ ${def.n} 想摧毁卡牌，但本区域存在免摧毁效果（地形「睡鼠神祠」或「蕾蒂」等），所有卡牌都无法被摧毁。`); break; }
      let minBoth = Infinity;
      for (const c of both) minBoth = Math.min(minBoth, cardPowerIn(locIdx, c));
      const lowPool = both.filter((c) => cardPowerIn(locIdx, c) === minBoth);
      const lowTarget = lowPool[Math.floor(Math.random() * lowPool.length)]; // 并列最低：随机挑一张
      const lowSide = lowTarget.side;
      const lowZone = st.players[lowSide].zones[locIdx];
      if (phoenixRevive(lowTarget, locIdx)) break; // 凤凰重生（如藤原妹红）：回手 +N 战力
      if (surviveDestroy(lowTarget)) break; // 防摧毁（如灵乌路空）：替代为降战力、卡不离场
      playShatter(lowTarget); // 分崩离析演出（v88）
      lowZone.splice(lowZone.indexOf(lowTarget), 1);
      dequeueField(lowTarget); // 被摧毁：移出放置队列（后续时机不再结算它）
      log('danger', `✦ ${def.n} 摧毁了${lowSide === side ? '己方' : '对方'}「${lowTarget.def.n}」（威力 ${minBoth}${lowPool.length > 1 ? `；并列最低共 ${lowPool.length} 张，随机选中这一张` : ''}）`);
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
    case 'spawnS': {
      // v172（祖母绿巨石·法术）：揭示——在**本区自己一侧**生成特殊卡（对方一侧完全不动）。
      // 与 spawn（本区双方各 n 张）、spawnO（只投对方一侧）配对；落场统一走 placeToken：
      // 落地即翻开、占格位、进入场上放置顺序队列，并播“凝聚显形”演出（justSpawned）。
      // 自己这侧放满（sideRoom < 1，含被大体积卡占满）则失败、不补到别处，仅记日志。
      const spcS = fx.spawnS;
      const tkS = spcS && TOKENS[spcS.card];
      if (spcS && tkS) {
        const cntS = spcS.n || 1;
        const placedS = placeToken(side, locIdx, tkS, cntS);
        log(side, placedS
          ? `✦ ${def.n}：在本区域自己一侧添加 ${placedS} 张「${tkS.n}」`
          : `✦ ${def.n} 想把「${tkS.n}」放到自己一侧，但该侧已放满，未能落下。`);
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
            c2.justSpawned = true; // v90：分身生成演出
            c2.buff += snap - c2.def.p; // 快照对齐本体揭示时战力
            addBuffLog(c2, snap - c2.def.p, null, '分身快照'); // 记入战力影响历史
            zone.push(c2);
            enqueueField(c2); // 分身也按落场先后进入放置队列（v55）
            added++;
            // v170：若生成的衍生物是「法术」，等同手打一张：先结算其揭示，随即消散
            if (tk.spell) settleFieldSpell(c2, j);
          }
        }
        log(side, added
          ? `✦ ${def.n}：向另外两个区域自己一侧各添加 ${cnt} 张「${tk.n}」（分身快照战力=${snap}${added < cnt * zones ? '，部分区域放不下' : ''}）`
          : `✦ ${def.n} 想生成「${tk.n}」，但另外两个区域自己一侧都放不下或未开放。`);
      }
      break;
    }
    case 'gather': {
      // v171：集结（现仅法术「三妖精集结」）——**同步版**：一次性生成 + 结算揭示 + 强化。
      // ⚠️ 正常翻牌流程（revealRound）走的是**分步演出**版 `applyGatherReveal`（按区域顺序
      // 逐区揭示、每区之间间隔 0.5s，三区都揭示完并强化之后才轮到法术消散）；
      // 本同步版供 morph / fx 时机效果 / 落场生成（settleFieldSpell）等非翻牌路径复用。
      // 口径：① 把该阵营（`fx.gather.group`，现 `'light'`）在 POOL 里的成员卡去重后**随机排列**，
      // 按区域顺序（左→中→右）每区**自己一侧各生成 1 张**（三张互不相同）；某区该侧放满或
      // 区域未开放则跳过该区、不补到别区；生成的卡落地即翻开、占格、入队，并**立即结算其揭示**。
      // ② 全部生成完后，给自己一侧场上已翻开的该阵营卡牌永久 +add 战力。
      const gw = fx.gather;
      const group = gw && gw.group;
      const members = gatherMembers(group);
      if (!members.length) {
        log(side, `✦ ${txt}：卡池里没有可生成的成员（阵营「${GROUPS[group] || group || '?'}」），无事发生。`);
        break;
      }
      const picked = shuffle(members.slice()).slice(0, 3); // 随机排列，每区一张、互不相同
      const made = [];
      const placed = [];
      const skipped = [];
      for (let j = 0; j < 3; j++) {
        const who = state.locs[j].def.n;
        const r = gatherSpawnAt(side, j, picked[j], made);
        if (r.ok) placed.push(`${who}「${r.name}」`);
        else skipped.push(`${who}（${r.why}）`);
      }
      log(side, placed.length
        ? `✦ ${def.n}：${side === 'p' ? '你' : '对手'}方在 ${placed.length} 个区域各生成了 1 张三妖精 —— ${placed.join('、')}${skipped.length ? `（跳过：${skipped.join('、')}）` : ''}`
        : `✦ ${def.n}：三个区域都放不下或未开放，未能生成任何三妖精。`);
      resolveSpawnedReveals(made); // 生成的卡也结算自身「揭示」（v166/v171 口径，按落场顺序）
      // ② 在这之后：自己一侧场上已翻开的三妖精各 +add 战力
      const add = (gw && gw.add) || 0;
      if (add) {
        const n = applyGatherBuff(side, card, group, add);
        log(side, n
          ? `✦ ${def.n}：${side === 'p' ? '你' : '对手'}方场上已翻开的「${GROUPS[group] || group}」各 ${add > 0 ? '+' : '−'}${Math.abs(add)} 战力（影响 ${n} 张）。`
          : `✦ ${def.n}：己方场上没有已翻开的三妖精，这一步无人可强化。`);
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
      // v96：记录换边前源格位，供效果渲染后播放“滑行+缩放”演出
      const swEl = miniCardElById(card.id);
      const swRect = swEl && swEl.isConnected ? swEl.getBoundingClientRect() : null;
      src.splice(idx, 1);
      dst.push(card);
      card.side = other; // 归属换边
      pendingSwitchFly = { card, srcRect: swRect }; // v96
      log('danger', `✦ ${def.n} 换边：转移到了对方一侧（${def.p < 0 ? `以 ${-def.p} 负战力计入对方该区` : '该卡现在位于对方一侧'}）。`);
      break;
    }
    case 'morph': {
      // 揭示：变身（二岩猯藏）——从对方手牌随机取一张，把自身完全变成该卡的**复制体**
      // （原卡留在对方手牌）。变身后立即按新 def 的效果文本再结算一次：新卡若带 k（揭示）
      // 则立刻触发该揭示；持续 og / 每回合移动 fly / 时机效果 fx / 防摧毁 surv 等
      // 由新 def 实时驱动，自动生效。
      const hand = st.players[other].hand;
      // v170：法术不作为变身目标（变身后会立刻消散），候选池里排除法术
      const cands = hand.filter((c) => c && c.def && !c.def.spell);
      if (!cands.length) { log(side, `✦ ${def.n} 想变身，但对方手牌里没有可作目标的卡（手牌为空或只有法术）。`); break; }
      const oldN = def.n;
      const pick = cands[Math.floor(Math.random() * cands.length)];
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
      // v170：法术没有战力且马上消散，不作为“己方最低卡”的候选（避免被换边后立刻消失、白费一次）
      const own = st.players[side].zones[locIdx].filter((c) => c !== card && c.revealed && !c.def.un && !c.def.spell);
      if (own.length === 0) {
        log(side, `✦ ${def.n} 想换边己方最低的卡，但本区没有其他已翻开的己方卡（法术不算）。`);
        break;
      }
      let minP = Infinity, poolT = [];
      for (const c of own) {
        const p = cardPowerIn(locIdx, c);
        if (p < minP) { minP = p; poolT = [c]; }
        else if (p === minP) poolT.push(c);
      }
      const target = poolT[Math.floor(Math.random() * poolT.length)]; // 并列最低随机
      // v96：记录换边前源格位，供效果渲染后播放“滑行+缩放”演出
      const gEl = miniCardElById(target.id);
      const gRect = gEl && gEl.isConnected ? gEl.getBoundingClientRect() : null;
      st.players[side].zones[locIdx].splice(st.players[side].zones[locIdx].indexOf(target), 1);
      dst.push(target);
      target.side = other; // 归属换边
      pendingSwitchFly = { card: target, srcRect: gRect }; // v96
      log('danger', `✦ ${def.n}：把己方「${target.def.n}」（威力 ${minP}）换边到了对方一侧。`);
      break;
    }
    case 'xform': {
      // 揭示：把本区域变成目标地形（fx.xf = 地形 id，出自 POOL 或 EXTRA，如辉针城 needle）
      const target = findLocDef(fx.xf);
      if (!target) break;
      const over = ['p', 'a'].some((s2) => sideUsed(s2, locIdx) > target.max);
      if (over) { log('danger', `✦ ${def.n} 想把本区变成「${target.n}」，但双方牌数超出其上限，变形失败。`); break; }
      const prevLoc = state.locs[locIdx].def;
      state.locs[locIdx].def = target;
      refreshLocHeader(locIdx); // 更新列名/图标/效果文字/配色（隙间随 max=4 自动消失）
      log('danger', `✦ ${def.n} 将本区域变成了「${target.n}」！`);
      // v151：区域变形等同于“该地形在本区出现”——立刻结算目标地形的「出现时」效果
      // （如变形成虹龙洞 → 双方各生成 1 张「石块」，与地形揭晓同一函数）。
      // 本区原本就已经是目标地形时不重复结算（同一地形不会二次“出现”）。
      if (prevLoc !== target) runLocAppearEffect(locIdx, target);
      break;
    }
    case 'roam': {
      // 揭示 / 时机效果（v158）：把**自身**移到“另外两个区域”中**随机一处**。
      // 现役用法：幽灵 def.fx.turnStart → k='roam'（每回合开始若可能就飘走）；
      // 也支持作为揭示键（k='roam' 的卡翻面时立刻漂移）。
      // 目标区必须①已开放（locOpen，避开锁定的七夕坂等）②该侧空余 ≥ 自身占格数（occ 口径）；
      // 两个区域都不可达则失败、留在原地。移动不改变归属、揭示状态与场上放置顺序队列
      // （与 mv/fly/shift 同口径），移动后各区域总点数/放满加成按现盘面实时重算。
      // 移动核心与地形「魔力风暴」（gust，v162）共用 moveCardToRandomZone。
      const dst = moveCardToRandomZone(card);
      if (dst < 0) {
        log(side, `✦ ${txt} 想移动到别的区域，但另外两个区域都放不下或未开放，留在原地。`);
        break;
      }
      log(side, `✦ ${txt} 飘到了「${st.locs[dst].def.n}」（现 ${cardPowerIn(dst, card)}）。`);
      break;
    }
    case 'mv': {
      // 揭示：把本区“对方战力最低”的已翻开卡移到另外两区随机一处；
      // 候选区必须该侧未满且已开放（避开锁定的七夕坂等）；全满/全不可达则移动失败。
      const vis = theirs.filter((c) => c.revealed && !c.def.un && !c.def.spell); // v170：法术不选为目标
      if (vis.length === 0) { log(side, `✦ ${def.n} 想移走对方卡牌，但对方本区没有可移动的已翻开卡牌（暗牌与法术不算）。`); break; }
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
          c2.justHandAdded = true; // v90：加入手牌演出
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
      if (locNoDestroy(locIdx)) { log(side, `✦ ${def.n} 想摧毁卡牌，但本区域存在免摧毁效果（地形「睡鼠神祠」或「蕾蒂」等），所有卡牌都无法被摧毁。`); break; }
      const vis = theirs.filter((c) => c.revealed && !c.def.un && !c.def.spell); // v170：法术不选为目标
      if (vis.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但对方在此区没有可摧毁的已翻开卡牌（暗牌与法术不算）。`); break; }
      let maxP = -Infinity, target = null;
      for (const c of vis) {
        const p = cardPowerIn(locIdx, c);
        if (p > maxP) { maxP = p; target = c; }
      }
      if (phoenixRevive(target, locIdx)) break; // 凤凰重生（如藤原妹红）：回手 +N 战力
      if (surviveDestroy(target)) break; // 防摧毁（如灵乌路空）：替代为降战力、卡不离场
      playShatter(target); // 分崩离析演出（v88）
      theirs.splice(theirs.indexOf(target), 1);
      dequeueField(target); // 被摧毁：移出放置队列（后续时机不再结算它）
      log('danger', `✦ ${def.n} 摧毁了对方「${target.def.n}」（威力 ${maxP}）`);
      break;
    }
    case 'oc': {
      if (isSpell(card)) { log(side, `✦ 「${card.def.n}」是法术（没有战力），「落牌自增」不生效。`); break; } // v170
      // 揭示：翻开当回合，对方是否在本区域放置过至少一张牌（本回合落牌记录）
      const present = movesForSide(other).some((m) => m.loc === locIdx);
      if (present) {
        applyPermBuff(card, fx.a, card);
        log(side, `✦ 对方本回合在本区放过牌：${def.n} 威力 +${fx.a}（现 ${cardPowerIn(locIdx, card)}）`);
      } else {
        log(side, `✦ 对方本回合没有在本区放牌，${def.n} 效果未触发。`);
      }
      break;
    }
    case 'shift': {
      // 揭示：把己方“最左侧区域”（第 1 列，下标 0）**已翻开**的卡牌按放置顺序
      // 依次搬到“最右侧区域”（第 3 列，下标 2）己方一侧，直到右侧己方侧放满
      // （按占格 occ 判定：右侧空余 ≥ 该卡占格数才能搬，放满即止）。
      // 暗牌 / un 卡不搬；不改变归属、揭示状态与场上放置顺序队列；
      // 施放者本牌若在最左侧也会被一起搬。
      // （正常翻牌流程里的揭示演出是“逐张搬、每张间隔 0.3s”，见 applyShiftReveal；
      //   此同步版供 morph/fx 等非翻牌结算路径复用。）
      const moved = [];
      let c;
      while ((c = shiftMoveOne(side))) moved.push(c.def.n);
      log(side, moved.length
        ? `✦ ${txt}：把最左侧区域的 ${moved.length} 张已翻开卡（${moved.join('、')}）搬到了最右侧区域。`
        : `✦ ${txt}：最左侧区域没有可搬的已翻开卡，或最右侧区域已放满。`);
      break;
    }
    case 'costUp': {
      // v169（桑尼米尔克）：揭示——让对方**当前手牌**里**随机一张卡**的**能量消耗 +N**
      // （现 N=1，取自 fx.a；卡面文案「费用」＝引擎里的能量消耗，两者是同一个数）。
      // 口径：
      //   ① 作用于「这一份」卡实例（走 applyCostMod → card.costMod），**仅本场战斗有效**；
      //      对手那张牌之后被摧毁 / 离场 / 本局结束，修正随实例一起消失（重开一局自然重置）。
      //   ② **每张卡最多只能被涨到 6 费**：可选目标＝手牌中 `cardCost < 6` 的卡（0 费卡也可被选中），
      //      若对方手上全是 6 费（或手牌为空）则本次揭示**丢失目标、什么也不发生**。
      //   ③ 被选中的目标**公开给玩家看**（日志点名 + 费用变化气泡），且该卡的费用数字此后显示为红色
      //      ——它就在**对方手牌**里，平时看不到，因此气泡落到侧栏「对手（AI）」信息区。
      //   ④ 加费**不改**卡牌的费用档位判定：卡组曲线、区域「雾之湖」的 1 费加成、图鉴与
      //      「指定卡牌」都按印刷费用 `def.c` 算，只有**实际打出时的能量消耗**按修正后的费用算。
      //   ⑤ 打出去后费用修正仍跟着这张卡（撤回手牌照旧涨价）；不改变归属与其他对手手牌。
      const up = fx.a || 1;
      const hand = st.players[other].hand;
      if (!hand.length) {
        log(side, `✦ ${txt}：对方手牌为空，没有可加费的目标。`);
        break;
      }
      const cands = hand.filter((c) => c && c.def && !c.def.un && cardCost(c) + up <= 6);
      if (!cands.length) {
        log('sys', `✦ ${txt}：对方手牌里的卡都已到 6 费上限，没有可加费的目标（本次揭示落空）。`);
        break;
      }
      // 随机一张：沿用全局 Math.random（冒烟测试会把它换成种子化 PRNG，保证可复现）
      const pick = cands[Math.floor(Math.random() * cands.length)];
      const before = cardCost(pick);
      applyCostMod(pick, up, card);
      const after = cardCost(pick);
      log('danger', `✦ ${txt}：对方手牌里的「${pick.def.n}」能量消耗 ${before} → ${after}（公开：这张牌现在需要 ${after} 点能量，仅本场战斗有效）。`);
      break;
    }
    case 'energyNext': {
      // v169（斯塔萨菲雅）：揭示——让**自己一方在下个回合**额外获得 N 点能量（现 N=1，取自 a）。
      // 口径：
      //   ① 精确的“下一回合”：揭示发生在阶段 ④（本回合能量早已结算完），因此本效果在
      //      **本局的下一个回合开始**（①-2 `grantTurnEnergy`）时一次性加入能量上限与剩余能量；
      //   ② **一次性**：结算完即清空（不像持续效果每回合都给）；同一回合打出多张 / 多个来源
      //      会叠加（登记式 `addPendingTurnEnergy`，+2 就是两点）；
      //   ③ 归属按**牌的所属方**：玩家打出给自己、AI 抽到打出则 AI 自己加（对双方一视同仁）；
      //   ④ 终局边界：第 6 回合（最后一回合）翻开时已没有“下一回合”，该额外能量**不会被用到**
      //      （登记后随本局结束，日志里会说明）；开发调试切换立场把牌落到敌方一侧时，
      //      该牌归属对手，故加的是**对手**的能量；
      //   ⑤ 非“摧毁”/非放置类效果：与区域字段、格位、`surv`/`phx`/`prot` 等互不影响。
      //   ⑥ **演出（v169）**：揭示当刻在卡位上放一组星光迸发 + 「能量 +N」气泡「登记」这份额外能量；
      //      真正到账的下个回合开始时，再由 `grantTurnEnergy` → `playEnergyGainFx` 播放到账演出
      //      （顶栏能量框星光 + 「+N 能量」气泡 + 绿色角标弹入）。
      const gain = fx.a || 1;
      const booked = addPendingTurnEnergy(side, gain, card);
      const total = booked.n;
      const who = side === 'p' ? '你' : '对手';
      log('sys', `🔋 ${txt}：${who}将在下一回合额外获得 ${gain} 点能量${total > gain ? `（已累计 ${total} 点）` : ''}。`);
      if (st.turn >= 6) {
        log('sys', `⚠️ 这是最后一回合（第 6 回合），下一回合不存在，这份额外能量本局不会生效。`);
        break;
      }
      // 揭示演出（登记：卡位星光迸发 + 「能量 +N 下回合生效」气泡）
      playEnergyBookFx(side, gain, card);
      break;
    }
    case 'drawSpell': {
      // v172（帕秋莉·诺蕾姬）：**时机效果**——每回合开始时从「帕秋莉法术池」随机抽 N 张法术
      // 加入自己手牌（由 def.fx.turnStart 触发，在阶段 ①-1「全场回合开始效果」里按放置队列序结算）。
      // 口径：
      //   ① **池**：优先取本条目（fx）的 `pool`（SPECIAL 键名数组），缺省回退到卡级 `spellPool`；
      //      池内必须是法术（`spell: true`），非法术条目会被忽略（防御：数据写错时不至于塞错卡）。
      //   ② **随机、可重复**：每回合独立随机，同一张法术可能连续几回合都抽到。
      //   ③ **归属按牌的所属方**（side）：玩家打出给自己、AI 打出给 AI；被 gift/switch 换边到
      //      对方一侧后，按换边后的新归属方抽给那边（与 v169 energyNext 同口径）。
      //   ④ **手牌满 7 张则本次加入失败、无事发生**（同 give / phoenixRevive 回手的既有口径），
      //      只记一条日志说明。
      //   ⑤ 抽到的法术走正常「暗出 → 翻牌揭示 → 自行消散」流程（v170 法术口径，1 费能量）；
      //      加入手牌时打 justHandAdded 标记，渲染后播“滑入”演出（.hand-new）。
      //   ⑥ **时机**：fx.turnStart 在每回合开始最先结算（先于能量结算与抽牌），因此这份法术
      //      在本回合出牌阶段就能用；帕秋莉本回合是在阶段 ④ 才翻开的，故**从她翻开的下一回合起**
      //      才开始抽（v160 口径：刚登场的卡跳过当回合的回合开始效果）。
      if (!card.revealed) break; // 防御：只有已翻开、仍在场上的帕秋莉才会调度法术
      const poolKeys = (Array.isArray(fx.pool) && fx.pool) || (Array.isArray(def.spellPool) && def.spellPool) || [];
      const spellPool = poolKeys.map((k) => TOKENS[k]).filter((d) => d && d.spell);
      if (!spellPool.length) {
        log('sys', `✦ ${def.n}：法术池里没有可抽的法术（数据缺失），本回合无事发生。`);
        break;
      }
      const dHand = st.players[side].hand;
      const dCnt = fx.n || 1;
      const got = [];
      for (let i = 0; i < dCnt; i++) {
        if (dHand.length >= 7) break; // 手牌满：加入失败（同 give 口径）
        const pickSpell = spellPool[Math.floor(Math.random() * spellPool.length)];
        const spellCard = newCard(pickSpell);
        spellCard.side = side;
        spellCard.justHandAdded = true; // v90：加入手牌演出（滑入）
        dHand.push(spellCard);
        got.push(pickSpell.n);
      }
      const dWho = side === 'p' ? '你' : '对手';
      log('sys', got.length
        ? `📖 ${def.n}（回合开始）：从帕秋莉法术池抽到「${got.join('、')}」，加入${dWho}的手牌（现 ${dHand.length}/7）。`
        : `📖 ${def.n}（回合开始）：想从法术池抽法术，但手牌已满（7/7），本次未能加入。`);
      break;
    }
    default: break;
  }
}

/* ---------------- 终局结算 ---------------- */

// v85→v87 终局演出：先等场上遗留的 ±N 加减动画（.gain-ring 悬浮层）全部播完，
// 再依“左→右”顺序依次把每个区域的【胜方总点数横幅】做 700ms 放大高亮，
// 区域之间间隔 150ms；全部结束后才允许弹结算弹窗（由调用方 finishMatch 触发）。
function zoneWinnerSide(j) {
  const eP = zoneEff('p', j); // 与横幅/结算同口径（反转区按低者胜）
  const eA = zoneEff('a', j);
  if (eP > eA) return 'p';
  if (eA > eP) return 'a';
  return null; // 平点无胜方
}
async function waitBuffFxDone(timeoutMs) {
  const limit = timeoutMs || 1600;
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    if (!document.querySelector('.gain-ring') && buffFlashQueue.length === 0) return;
    await sleep(40);
  }
}
async function playEndHighlights(gen) {
  await waitBuffFxDone(); // “所有的动画结束”后再开始
  if (gen !== state.gen) return;
  for (let j = 0; j < 3; j++) {
    const win = zoneWinnerSide(j);
    if (!win) continue; // 平局区域：无胜方点数可放大
    const pill = (win === 'p' ? Game._els.totP[j] : Game._els.totA[j]).closest('.loc-total');
    if (!pill) continue;
    pill.classList.remove('settle-win');
    void pill.offsetWidth; // 重启动画
    pill.classList.add('settle-win');
    if (gen !== state.gen) return;
    await sleep(700); // 放大动画 700ms
    if (gen !== state.gen) return;
    pill.classList.remove('settle-win');
    if (j < 2) await sleep(150); // 区域之间间隔 150ms（v87）
  }
}

// v162：把一张卡移到“另外两个区域”中**随机一处**的移动核心——
// roam 效果键（幽灵的回合开始游走等）与地形「魔力风暴」的 gust（揭示后吹飞）共用。
// 目标区必须①已开放（locOpen，避开锁定的七夕坂等）②该侧空余 ≥ 该卡占格数（occ 口径）；
// 无任何可达区域时返回 -1（不移动、由调用方决定怎么记日志）。
// 移动不改变归属、揭示状态与场上放置顺序队列（与 mv/fly/shift 同口径）；移动前抓取源格位
// 位置，渲染后由 flushPendingDriftFly 播放“滑行 + 缩放”飞行演出。
function moveCardToRandomZone(card) {
  const st = state;
  const owner = card.side;
  const from = fieldLocOf(card);
  if (from < 0) return -1; // 防御：已不在场上
  const cands = [];
  for (let j = 0; j < 3; j++) {
    if (j === from) continue;
    if (!locOpen(j)) continue;
    if (sideRoom(owner, j) < occOf(card)) continue;
    cands.push(j);
  }
  if (cands.length === 0) return -1;
  const dst = cands.length === 1 ? cands[0] : cands[Math.floor(Math.random() * cands.length)];
  const el = miniCardElById(card.id);
  const srcRect = el && el.isConnected ? el.getBoundingClientRect() : null;
  const srcZone = st.players[owner].zones[from];
  srcZone.splice(srcZone.indexOf(card), 1);
  st.players[owner].zones[dst].push(card);
  pendingDriftFly.push({ card, srcRect });
  return dst;
}

// 区域「回合结束崩塌」效果（v163，字段 collapse: { cards, to }，现仅幽明结界）：
// 每回合翻牌结算后（阶段 ⑤-0 的**最后一步**）检查：若本区域**双方总卡牌数** ≥ collapse.cards
// （按“张数”计——大体积卡（occ）也算 1 张，暗牌与落场 token 都算），
// 则把本区域地形**整体换成 collapse.to** 指定的地形（现在为「冥界」underworld）。
function locCollapseEffects() {
  const st = state;
  for (let j = 0; j < 3; j++) {
    const def = locDef(j);
    const col = def.collapse;
    if (!col) continue;
    const target = findLocDef(col.to);
    if (!target) continue; // 防御：目标地形 id 写错时静默跳过
    const cnt = st.players.p.zones[j].length + st.players.a.zones[j].length;
    if (cnt < col.cards) continue; // 未达阈值：不发生任何变化（也不记日志，避免每回合噪音）
    // 防御（与 xform 同口径）：任一方占格数超过目标地形上限则本次不崩塌
    if (['p', 'a'].some((s) => sideUsed(s, j) > target.max)) {
      log('danger', `${def.icon} ${def.n}：本区双方共 ${cnt} 张卡牌，但有一方占格数超过「${target.n}」的上限（${target.max}），结界未能崩塌。`);
      continue;
    }
    st.locs[j].def = target; // 换上目标地形（上限/加成/反转等字段即刻生效）
    refreshLocHeader(j);     // 列名/图标/效果文案/配色即时更新
    log('danger', `${def.icon} ${def.n}：本区双方共 ${cnt} 张卡牌（≥ ${col.cards}），结界崩塌 —— 本区域变成了「${target.n}」！`);
    // v151 口径：变形 = 该地形在本区“出现”——立刻结算其「出现时」效果
    // （冥界无 spawn，此处为空操作；若日后换成带 spawn 的目标地形则照常生成）
    runLocAppearEffect(j, target);
  }
}

// 区域「揭示后吹飞」效果（v162，字段 gust: true，现仅魔力风暴）：
// 在翻牌流程（阶段 ④ revealRound）里，每张在该区域翻开、且**自身揭示效果已经结算完**的卡，
// 「若可能」就移动到另外一个随机区域（候选/判定同 roam：目标区已开放且该侧放得下）。
// 与 gamble（v156，驹草赌场）的区别：gamble 在**翻面瞬间、自身揭示效果之前**结算（影响
// 自身 bl/oc 等判定），gust 在**自身揭示效果之后**结算（不改变本次揭示的结算结果）。
// 口径：①只作用于“本回合在该区被翻开”的卡（走 revealRound 的那些牌）——已经翻开的旧卡、
// 落地即翻开的落场 token、以及被移入本区的卡都不受影响（地形出现前的旧卡不追溯）；
// ②若该卡自身的揭示效果已经把它挪出本区（如八云紫 shift 把卡搬到最右区），则不再吹；
// ③换边类（switch/gift）换的仍是同一区域，故照常被吹到另一区（归属已变，按新归属方该侧
// 空位判定）；④移动后被吹的卡按新区域重新计算总点数/放满加成，非“摧毁”，surv/phx/prot 不触发。
function runLocAfterRevealEffects(side, locIdx, card) {
  const st = state;
  const def = locDef(locIdx);
  if (!def.gust || !card) return -1;
  if (fieldLocOf(card) !== locIdx) return -1; // 自身效果已把它挪走（如 shift 搬卡）→ 不再吹
  const dst = moveCardToRandomZone(card);
  if (dst < 0) {
    log(side, `${def.icon} ${def.n}：${side === 'p' ? '你方' : '敌方'}「${card.def.n}」想被吹走，但另外两个区域都放不下或未开放，留在原地。`);
    return -1;
  }
  log(side, `${def.icon} ${def.n}：${side === 'p' ? '你方' : '敌方'}「${card.def.n}」被吹到了「${st.locs[dst].def.n}」（现 ${cardPowerIn(dst, card)}）。`);
  return dst;
}

// 区域「翻开时」效果（v156，在阶段 ④ 翻牌结算里**逐张**触发）：
// 由 revealRound 在每张暗牌翻面后、该卡自身「揭示」结算**之前**调用
// （morph / fx 等非翻牌结算路径不经过这里，落地即翻开的落场 token 也不经过）。
// 现仅 gamble（驹草赌场）：在本区域翻开的卡牌**永久随机 ±N 战力**（各 50%）。
// 口径：
//   ① 只作用于“在本区被翻开的卡”（暗牌翻面那一刻）——落地即翻开的落场 token
//      （石块/厄运/分身/河童等）与「已翻开后被移入本区」的卡（mv/fly/shift/换边）不参与；
//      地形出现（揭晓/变形）之前就已在本区翻开的旧卡**不追溯**；
//   ② 双方一视同仁；
//   ③ **永久**生效：走 applyPermBuff 收口（±N 气泡演出 + 战力影响历史按来源记录地形名），
//      同一张卡被摧毁回手后再打出会**重新博彩**（如藤原妹红 phx）；
//   ④ 顺序：±N 先于该卡自身的揭示效果结算，故 `bl`（落后自增）/`oc` 等按博彩后的威力判定，
//      也先于同回合后面翻开的卡；
//   ⑤ 这不是“摧毁”也不是揭示增益：带 `surv`/`phx`/`prot` 的卡照常参与博彩。
function runLocRevealEffects(side, locIdx, card) {
  const def = locDef(locIdx);
  if (!def.gamble || !card) return 0;
  // v170：法术没有战力、且揭示后即消散，不参与博彩（不掷点、不记日志）
  if (isSpell(card)) return 0;
  const d = Math.random() < 0.5 ? def.gamble : -def.gamble; // 各 50%：+N / −N
  applyPermBuff(card, d, null, def.n); // tag = 地形名 → 战力影响历史按来源显示「驹草赌场」
  log(d > 0 ? 'sys' : 'danger', // 赌涨走绿色、赌跌走红色（与成长/衰减同口径）
    `${def.icon} ${def.n}：${side === 'p' ? '你方' : '敌方'}「${card.def.n}」赌了一把 → ${d > 0 ? '+' : '−'}${Math.abs(d)} 战力（现 ${cardPowerIn(locIdx, card)}）`);
  return d;
}

// 区域「定时掷骰」效果（v157，字段 dice: { turn, n }，现仅骰子赌桌）：
// 在**第 dice.turn 回合的回合结束时**（阶段 ⑤-0 地形回合结束效果内，先于场上
// 「回合结束」卡牌效果）结算一次：把本区域**所有卡牌**（双方）**各自**随机永久 ±n 战力
// （每张卡独立掷一次，各 50%），走 applyPermBuff 收口（±N 气泡演出 + 战力影响历史
// 按来源记地形名）。
// 与 gamble（翻开时博彩）的区别：gamble 在“卡牌于本区被翻开”的那一刻逐张触发、每张
// 新翻开的卡都会轮到；dice 只在指定的那一个回合末结算一次，作用于**当时在本区的所有卡**
// ——含此前就已翻开的旧卡，也含落地即翻开的落场 token（石块/厄运/分身/河童）。
// 口径：①每张卡独立掷骰（不是全桌共用一次点数）；②`un` 占位卡（隙间，本不在 zone 数组）
// 不受影响；③若该地形在第 dice.turn 回合结束之前才出现（揭晓 / 区域变形 / 开发者
// 「指定地形」），当回合末照常结算；若在**第 dice.turn 回合之后**才出现，该时机已过、
// 不再补结算；④非“摧毁”，带 `surv`/`phx`/`prot` 的卡照常参与；⑤除该回合外每回合末都不触发，
// 一局最多结算一次（同一块地形）。
function locDiceEffects() {
  const st = state;
  for (let j = 0; j < 3; j++) {
    const def = locDef(j);
    const dice = def.dice;
    if (!dice || st.turn !== dice.turn) continue; // 只在指定回合的回合末结算
    const n = dice.n || 1;
    const hit = [];
    for (const side of ['p', 'a']) {
      // 快照遍历：applyPermBuff 只改 buff 不增删卡，slice 仅作防御
      for (const c of st.players[side].zones[j].slice()) {
        if (c.def.un || c.def.spell) continue; // v170：法术无战力，不掷骰
        const d = Math.random() < 0.5 ? n : -n; // 每张卡各自掷一次：+n / −n 各半
        applyPermBuff(c, d, null, def.n); // tag = 地形名 → 战力影响历史按来源显示「骰子赌桌」
        hit.push(`${side === 'p' ? '你方' : '敌方'}「${c.def.n}」${d > 0 ? '+' : '−'}${Math.abs(d)}(${cardPowerIn(j, c)})`);
      }
    }
    // 本区没有卡牌时不刷日志（与 reactorPurge 一致，避免空转噪音）
    if (hit.length) log('snap', `${def.icon} ${def.n}：第 ${dice.turn} 回合结束，本区所有卡牌各自掷骰 → ${hit.join('、')}`);
  }
}

// 区域「定时加成」效果（v161，字段 rally: { turn, add }，现仅演唱会）：
// 在**第 rally.turn 回合的回合结束时**（阶段 ⑤-0 地形回合内效果之一，先于场上
// 「回合结束」卡牌效果）结算一次：把本区域**双方所有已翻开卡牌**永久 +add 战力
// （add 可为负），走 applyPermBuff 收口（±N 气泡演出 + 战力影响历史按来源记地形名）。
// 与 dice（定时掷骰）同类“定时一次性”机制，区别：rally 是**固定值**（全桌同一个 +add），
// dice 是**每张卡各自随机 ±n**；与 grow（每回合成长）的区别：grow 每个回合末都触发，
// rally 只在指定的那一个回合末触发一次。
// 口径：①只作用于结算那一刻**已翻开**的卡牌（含落场 token）——暗牌不吃、翻面后从下一
// 个回合末起才可能被加成，但 rally 的时机已过（第 turn 回合之后不再触发）故实际上吃不到；
// ②**永久**生效、可叠加（同一张卡被摧毁回手后再打出并再次赶上该时机才会再吃一次）；
// ③`un` 占位卡（隙间，本不在 zone 数组）不受影响；④若该地形在**第 rally.turn 回合结束
// 之前**才出现（揭晓 / 区域变形 / 开发者「指定地形」），当回合末照常结算；若在**第
// rally.turn 回合之后**才出现，该时机已过、不再补结算；⑤非“摧毁”，带 `surv`/`phx`/`prot`
// 的卡照常被加；⑥一局最多结算一次（同一块地形）。
function locRallyEffects() {
  const st = state;
  for (let j = 0; j < 3; j++) {
    const def = locDef(j);
    const rally = def.rally;
    if (!rally || st.turn !== rally.turn) continue; // 只在指定回合的回合末结算
    const add = rally.add || 0;
    if (!add) continue;
    const hit = [];
    for (const side of ['p', 'a']) {
      // 快照遍历：applyPermBuff 只改 buff 不增删卡，slice 仅作防御
      for (const c of st.players[side].zones[j].slice()) {
        if (!c.revealed || c.def.un || c.def.spell) continue; // v170：法术无战力，不吃定时加成
        applyPermBuff(c, add, null, def.n); // tag = 地形名 → 战力影响历史按来源显示「演唱会」
        hit.push(`${side === 'p' ? '你方' : '敌方'}「${c.def.n}」(${cardPowerIn(j, c)})`);
      }
    }
    // 本区没有已翻开的卡时不刷日志（与 reactorPurge 一致，避免空转噪音）
    if (hit.length) {
      log('snap', `${def.icon} ${def.n}：第 ${rally.turn} 回合结束，本区双方已翻开卡牌各 ${add > 0 ? '+' : '−'}${Math.abs(add)} 战力 → ${hit.join('、')}`);
    }
  }
}

// 回合结束战力成长 / 衰减（grow：如寺子屋 +N；decay：如间歇泉 −N）：
// 每回合翻牌结算后，把本区域**双方所有已翻开**的卡牌永久 ±N 战力
// （走 applyPermBuff 统一收口：记入战力影响历史 + 播放 +N 绿色 / −N 红色演出）。
// 两个字段共用同一套口径（方向相反），同一块地形一般只带其中一个：
//   ① 只作用于结算那一刻**已翻开**的卡牌——暗牌不吃（与揭示增减同口径），
//      翻面后从**下一个**回合末起才被影响；
//   ② **永久**生效、可叠加：连续多个回合每回合再 ±N（如第 4/5/6 回合末在间歇泉各 −1 = −3）；
//   ③ 敌方/己方一视同仁，含落场 token（石块/厄运/分身等）；
//   ④ `un` 占位卡（隙间，本不在 zone 数组）与其他效果口径一致：不受影响；
//   ⑤ 这不是“摧毁”，也不是揭示增益——带 `surv`（防摧毁）/`phx`（凤凰重生）/`prot`
//      （区域免摧毁）的卡照常被 ±N，相关防护不触发；卡被摧毁/离场后自然不再受影响。
// 结算时机：由 runLocTurnEndEffects（阶段 ⑤-0）调用，恒在场上「回合结束」卡牌效果
// （def.fx.turnEnd，阶段 ⑤）**之前**：本区先 ±N，随后 fx.turnEnd 卡看到的是已改动后的威力。
function locTurnEndPowerEffects() {
  const st = state;
  for (let j = 0; j < 3; j++) {
    const def = locDef(j);
    // grow = 成长（+N）；decay = 衰减（−N）；两者都带时相互抵消、都不带则跳过该区
    const delta = (def.grow || 0) - (def.decay || 0);
    if (!delta) continue;
    const hit = [];
    for (const side of ['p', 'a']) {
      // 快照遍历：applyPermBuff 只改 buff 不增删卡，slice 仅作防御
      for (const c of st.players[side].zones[j].slice()) {
        if (!c.revealed || c.def.un || c.def.spell) continue; // v170：法术无战力，不吃成长/衰减
        applyPermBuff(c, delta, null, def.n); // tag = 地形名 → 战力影响历史按来源显示「寺子屋」/「间歇泉」
        hit.push(`${side === 'p' ? '你方' : '敌方'}「${c.def.n}」(${cardPowerIn(j, c)})`);
      }
    }
    // 本区没有已翻开的卡时不刷日志（与 reactorPurge 一致，避免空转噪音）
    if (hit.length) {
      const sign = delta > 0 ? '+' : '−';
      log(delta > 0 ? 'sys' : 'danger', // 成长走绿色 sys、衰减走红色 danger
        `${def.icon} ${def.n}：本区双方已翻开卡牌各 ${sign}${Math.abs(delta)} 战力 → ${hit.join('、')}`);
    }
  }
}

// 回合结束摧毁（purge：如聚变反应炉）：每回合翻牌结算后，把本区域“全场”战力最低的
// 卡牌摧毁（敌我双方所有已翻开卡混比；并列最低的一并摧毁）。
// 带防摧毁（def.surv，如灵乌路空）的卡不会离场，改为永久降 N 战力（见 surviveDestroy）。
// 结算时机：由 runLocTurnEndEffects（阶段 ⑤-0）调用，恒在场上「回合结束」卡牌效果之前。
function reactorPurge() {
  const st = state;
  for (let j = 0; j < 3; j++) {
    const def = locDef(j);
    if (!def.purge) continue;
    const zoneP = st.players.p.zones[j];
    const zoneA = st.players.a.zones[j];
    // un 占位卡（如隙间）不可被任何效果摧毁；v170：法术也已自行消散，一律不作为摧毁目标
    const all = zoneP.concat(zoneA).filter((c) => !c.def.un && !c.def.spell);
    if (all.length === 0) continue;
    if (locNoDestroy(j)) { log('danger', `⚡ ${def.n}：本区域存在免摧毁效果（地形「睡鼠神祠」或「蕾蒂」等），所有卡牌均无法被摧毁，本次跳过。`); continue; }
    let min = Infinity;
    for (const c of all) min = Math.min(min, cardPowerIn(j, c));
    const doomed = all.filter((c) => cardPowerIn(j, c) === min);
    const removed = [];
    for (const c of doomed) {
      if (phoenixRevive(c, j)) continue; // 凤凰重生（如藤原妹红）：回手 +N 战力
      if (surviveDestroy(c)) continue; // 防摧毁（如灵乌路空）：替代为降战力、卡不离场
      playShatter(c); // 分崩离析演出（v88）
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
  // v144→v148：开发调试显示「指定地形 / 指定卡牌 / 切换立场 / 查看对手」；隐藏图鉴
  // 正常对局隐藏「修改能量 / 指定地形 / 指定卡牌 / 查看对手」
  const dev = isDevMode();
  const energyBtn = $('btnEnergyDev');
  const pickLocBtn = $('btnPickLoc');
  const pickBtn = $('btnPick');
  const codexBtn = $('btnCodex');
  const switchBtn = $('btnSwitchSide');
  const spyBtn = $('btnAiSpy');
  if (energyBtn) energyBtn.classList.add('hidden'); // 正常与开发均不再显示顶栏改能量
  if (pickLocBtn) pickLocBtn.classList.toggle('hidden', !dev);
  if (pickBtn) pickBtn.classList.toggle('hidden', !dev);
  if (codexBtn) codexBtn.classList.toggle('hidden', dev);
  if (spyBtn) spyBtn.classList.toggle('hidden', !dev);
  if (switchBtn) {
    switchBtn.classList.toggle('hidden', !dev);
    const asEnemy = state.playAsSide === 'a';
    switchBtn.textContent = asEnemy ? '⇄ 立场：敌方' : '⇄ 切换立场';
    switchBtn.classList.toggle('side-enemy', asEnemy);
    switchBtn.title = asEnemy
      ? '当前：落牌进敌方区域（再点恢复我方）'
      : '点击后：当前与后续回合落牌进敌方区域，归属对手';
    switchBtn.disabled = !inPlay;
  }
}

function renderHud() {
  const en = state.players.p;
  $('turnVal').textContent = state.turn;
  $('energyVal').textContent = en.energyLeft;
  $('energyUnit').textContent = `/ ${en.energyTotal}`;
  // v169：额外能量提示——本回合能量里由「额外能量」多出来的部分（如斯塔萨菲雅 → 下回合 +1）
  const gainEl = $('energyBonus');
  if (gainEl) {
    const g = en.energyGain || 0;
    gainEl.classList.toggle('hidden', !g);
    if (g) {
      gainEl.textContent = `+${g}`;
      gainEl.title = `本回合额外能量 +${g}（由「额外能量」机制提供，一次性）`;
    }
  }
  $('cubeVal').textContent = state.stakes;
  const pips = $('cubePips');
  pips.innerHTML = '';
  for (let i = 1; i <= 3; i++) {
    const d = document.createElement('span');
    if (state.stakes >= 2 ** i) d.className = 'on';
    pips.appendChild(d);
  }
  // 能量槽：亮起 = 本回合剩余可用能量（显示玩家侧）
  const ep = $('energyPips');
  ep.innerHTML = '';
  const pipN = Math.max(6, en.energyTotal | 0);
  for (let i = 0; i < pipN; i++) {
    const d = document.createElement('div');
    d.className = 'pip' + (i < en.energyLeft ? ' on' : '');
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
    if (loc.def.id === 'unreveal') addUnrevealDecor(col); // 未揭示列：散落地形小图标（v75）
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
  syncUnrevealDecor(col, def); // 揭晓成真实地形 → 移除“随机散布”装饰；变回未揭示 → 补回
}

/* ---- 未揭示列装饰（v75）----
   在列上随机散布地形池里所有地形的小图标（含 ❓），低透明度 + 轻微漂浮动画，
   从视觉上表达“这一块可能是随机池里任意一种地形”。每次开局随机布局。 */
function addUnrevealDecor(col) {
  if (col.querySelector('.unreveal-decor')) return;
  const decor = document.createElement('div');
  decor.className = 'unreveal-decor';
  const icons = LOCATION_POOL.map((d) => d.icon);
  icons.push('❓', '❔');
  const n = 12;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    s.textContent = icons[Math.floor(Math.random() * icons.length)];
    s.style.left = (4 + Math.random() * 88).toFixed(1) + '%';
    s.style.top = (2 + Math.random() * 90).toFixed(1) + '%';
    s.style.fontSize = (15 + Math.random() * 24).toFixed(1) + 'px';
    s.style.setProperty('--rot', Math.round(Math.random() * 60 - 30) + 'deg');
    s.style.animationDuration = (2.8 + Math.random() * 3.5).toFixed(2) + 's';
    s.style.animationDelay = (-Math.random() * 3).toFixed(2) + 's';
    decor.appendChild(s);
  }
  col.insertBefore(decor, col.firstChild);
}
function syncUnrevealDecor(col, def) {
  if (!col) return;
  const dec = col.querySelector('.unreveal-decor');
  if (def.id === 'unreveal') {
    if (!dec) addUnrevealDecor(col);
  } else if (dec) {
    dec.remove();
  }
}

function canPlaceP(idx) {
  const st = state;
  const card = st.players.p.hand[st.selected];
  if (!card || cardCost(card) > st.players.p.energyLeft) return false;
  if (!locOpen(idx)) return false;
  if (occOf(card) > 1 && !occZoneOk(card, idx)) return false; // 大体积卡需上限恰为占格数
  return sideRoom(playSide(), idx) >= occOf(card);
}

function miniCardEl(card, locIdx, side) {
  const el = document.createElement('div');
  el.className = 'mini-card' + (card.justRevealed ? ' played-now' : '');
  el.dataset.cardid = String(card.id); // 供“飞行演出”（flyCardTo）按卡定位格位
  if (card.justRevealed) card.justRevealed = false;
  if (card.justSpawned) { el.classList.add('spawned-now'); card.justSpawned = false; } // v90 生成演出
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
    // v169：费用修正的着色——高于印刷费用显示红色、低于则绿色（与战力数字同款语义）
    const liveCost = cardCost(card);
    const costCls = liveCost > card.def.c ? ' up' : liveCost < card.def.c ? ' down' : '';
    // v170：法术卡框不显示战力（实际战力恒为 0），右上角战力位改显「✦ 法术」小标
    const spell = isSpell(card);
    if (spell) el.classList.add('spell');
    const topRight = spell ? '<span class="mc-spell">✦ 法术</span>' : `<span class="p${cls}">${live}</span>`;
    const modHtml = (!spell && net !== 0) ? `<span class="mc-mod">${net > 0 ? '+' : ''}${net}</span>` : '';
    if (card.def.img) {
      // 有图片素材：整格铺图，emoji 垫底作缺图兜底
      el.classList.add('has-art');
      el.innerHTML = `<span class="mc-cost${costCls}">${liveCost}</span>${topRight}
        <span class="mc-icon">${card.def.i}</span>
        <img class="mini-img" src="assets/cards/${encodeURIComponent(card.def.img)}" alt="${card.def.n}" loading="lazy" draggable="false"/>
        <span class="mc-shade"></span>
        <span class="mc-name">${card.def.n}</span>
        ${modHtml}`;
    } else {
      el.innerHTML = `<span class="mc-cost${costCls}">${liveCost}</span>${topRight}
        <span class="mc-icon">${card.def.i}</span>
        <span class="mc-name">${card.def.n}</span>
        ${modHtml}`;
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
    const ldef = locDef(j);
    const count = sideUsed('p', j) + '/' + ldef.max;
    let locTag = '';
    if (ldef.id === 'unreveal') locTag = ` · 🃏 第 ${j + 1} 回合揭晓`;
    else if (ldef.minTurn && !locOpen(j)) locTag = ` · 🔒 第 ${ldef.minTurn} 回合开放`;
    mineZoneEl.querySelector('.slot-count').textContent = `已放 ${count}${locTag}`;
    mineZoneEl.parentElement.classList.toggle('hoverable', canPlaceP(j));
    // 未开放区域加灰色遮罩（如七夕坂第 5 回合前）
    Game._els.cols[j].classList.toggle('locked', !!locDef(j).minTurn && !locOpen(j));
  }
  flushBuffFlash(); // v80：本次渲染后触发“永久 +N”绿色动画（bf/ba/bl/oc/phx 等收口排队）
  flushCostFlash(); // v169：本次渲染后触发“费用 ±N”动画（costUp 等收口排队）
}

/* 把区域的一侧 2×2 格位按规则填充：
   - 已放卡永远占其格位（含揭晓后超过上限的卡：不删除、不移动，见 locationRevealStage）；
   - 空位且属于允许格（i < def.max）：max=4 用浅灰虚线格，max<4 用透明占位；
   - 空位且是不允许格（i >= def.max）：固定用「隙间」灰色卡占位——只铺在“空置”的不可用格，
     所以隙间数 = 4 − max(已放卡数, 上限)：未超限时 = 4−上限（如迷途竹林 2 个）；
     揭晓超限时随卡占格递减（已放 3 张 → 1 个；放满 4 张或大体积卡占满整侧 → 0 个），
     与“不删卡”口径一致。 */
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
    const card = cards[i];
    if (card) { out.push(miniCardEl(card, locIdx, side)); continue; } // 已有卡优先占格
    if (i >= def.max) {
      out.push(gapCellEl());
      continue;
    }
    if (def.max === 4) out.push(guideCellEl());
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
  updateHandCount(); // v118：中央“当前手牌 N/7”提示
  let drewEntry = false; // v95：本次渲染中是否存在“抽牌入场”的卡
  if (cards.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'hand-empty';
    empty.textContent = '手牌已空';
    hand.appendChild(empty);
    return;
  }
  cards.forEach((card, index) => {
    const el = document.createElement('div');
    el.className = 'hand-card' + (card.def.img ? '' : ' no-img');
    const afford = cardCost(card) <= st.players.p.energyLeft; // v169：按修正后的费用判断能否打出
    if (!afford) el.classList.add('unaffordable');
    if (st.selected === index) el.classList.add('selected');
    if (card.justHandAdded) { el.classList.add('hand-new'); card.justHandAdded = false; } // v90 加入手牌演出
    // v95：抽牌入场回退为浏览器原生 CSS transform 动画（.hand-drawn，从右侧滑入），
    // 同时给 #hand 加 .draw-anim（临时 overflow-x:hidden）抑制桌面端横向滚动条
    if (card.justDrawn) { el.classList.add('hand-drawn'); card.justDrawn = false; drewEntry = true; }
    // 终局复盘（over）时手牌保持原色且可点击查看，其余非出牌阶段置灰
    if (st.phase !== 'play' && st.phase !== 'over') el.classList.add('unaffordable');
    el.style.setProperty('--cgrad', gradOf(card.def));
    // 手牌卡面显示“当前战力”（基础 + 永久 buff）：如凤凰重生回手的妹红 +2 后直接可见，
    // 不再固定显示基础战力 1。
    const handPow = cardPower(card);
    const handSign = handPow > card.def.p ? 'up' : handPow < card.def.p ? 'down' : '';
    // v169：手牌费用角标按修正后的费用显示并着色（被桑尼米尔克加费的牌：数字变红）
    const handCost = cardCost(card);
    const handCostSign = handCost > card.def.c ? 'up' : handCost < card.def.c ? 'down' : '';
    const faceOpts = { power: handPow, sign: handSign, cost: handCost, costSign: handCostSign };
    el.innerHTML = cardFaceHTML(card.def, faceOpts);
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
  if (drewEntry) lockDrawAnimScroll(hand); // v95：入场期间抑制横向滚动条
}

// v118：更新认输/结束回合按钮之间的“当前手牌 N/7”提示
function updateHandCount() {
  const el = $('handCountVal');
  if (el) el.textContent = state.players.p.hand.length + '/7';
}

// 抽牌入场期间给手牌容器加 .draw-anim（overflow-x:hidden），动画播完移除；
// 连续抽牌（如开局 3 张）会重置计时器，保持全程抑制。
let drawAnimTimer = null;
function lockDrawAnimScroll(hand) {
  hand.classList.add('draw-anim');
  if (drawAnimTimer) clearTimeout(drawAnimTimer);
  drawAnimTimer = setTimeout(() => {
    hand.classList.remove('draw-anim');
    drawAnimTimer = null;
  }, 750); // 0.65s 动画 + 余量
}

/* ---------------- 图鉴 / 放大卡牌 ---------------- */
function cardFaceHTML(def, opts) {
  opts = opts || {};
  const power = opts.power !== undefined ? opts.power : def.p;
  const sign = opts.sign ? ' ' + opts.sign : '';
  // v169：费用角标支持「本场战斗修正」——opts.cost 传修正后的费用、opts.costSign 传 up/down 着色类
  // （缺省按印刷费用 def.c 显示、不着色；手牌与放大视图会传入实时的费用）
  const cost = opts.cost !== undefined ? opts.cost : def.c;
  const costSign = opts.costSign ? ' ' + opts.costSign : '';
  // 有图片素材则用 assets/cards/ 下的图（失败/缺图时下方 emoji 透出兜底），否则直接用 emoji
  const art = def.img
    ? `<div class="hc-art">
        <span class="hc-icon hc-art-emoji">${def.i}</span>
        <img class="hc-img" src="assets/cards/${encodeURIComponent(def.img)}" alt="${def.n}" loading="lazy" draggable="false"/>
      </div>`
    : `<div class="hc-icon">${def.i}</div>`;
  return `<div class="hc-top"><span class="cost-orb${costSign}">${cost}</span>${isSpellDef(def) ? '<span class="hc-spell">✦ 法术</span>' : `<span class="p${sign}">${power}</span>`}</div>
    ${art}
    <div class="hc-name">${def.n}</div>
    <div class="hc-text">${def.t || '—'}</div>`;
}

/* ===== 图鉴 / 开发者“指定卡牌”页面入口（v92 起实现拆分到 card-browser.js）=====
   网格渲染、费用筛选（全部/0-1/2/3/4/5/6 费）、选中与加入手牌的逻辑
   都在 window.CardBrowser（见 card-browser.js）；这里保留按钮/快捷键入口转发。 */
function uiOnCodex() { if (window.CardBrowser) window.CardBrowser.toggleCodex(); }
function closeCodex() { if (window.CardBrowser) window.CardBrowser.closeCodex(); }
function uiOnPick() { if (window.CardBrowser) window.CardBrowser.togglePick(); }
function uiOnPickClose() { if (window.CardBrowser) window.CardBrowser.closePick(); }

// 开发者调试：把本回合能量设为 7（仅当前出牌阶段生效；下回合 playRound 会按回合数重置）
function uiOnEnergyDev() {
  const st = state;
  if (st.phase !== 'play') { setStatus('只有在你的出牌阶段才能修改能量。'); return; }
  const en = st.players.p;
  en.energyTotal = 7;
  en.energyLeft = 7;
  log('sys', '⚡ 开发者指令：本回合你的能量已设为 7（对手能量不变；下回合双方按回合数重置）。');
  setStatus('本回合你的能量已改为 7，可继续出牌（仅本回合有效，下回合恢复）。');
  renderAll();
}

// v144：开发调试「切换立场」——落牌进敌方区 / 恢复我方（跨回合保持，直到再点或重开）
function uiOnSwitchSide() {
  if (!isDevMode()) return;
  const st = state;
  if (st.phase !== 'play') { setStatus('只有在出牌阶段才能切换立场。'); return; }
  st.playAsSide = st.playAsSide === 'a' ? 'p' : 'a';
  st.selected = -1;
  st.moveCardId = null;
  if (st.playAsSide === 'a') {
    log('sys', '⇄ 已切换到敌方立场：本回合及之后暗出的牌将落在对手区域，归属对手。');
    setStatus('立场：敌方 — 选牌点区域会放到对手一侧（再点「切换立场」恢复我方）。');
  } else {
    log('sys', '⇄ 已恢复我方立场：暗出的牌回到自己区域。');
    setStatus('立场：我方 — 暗出的牌落在自己一侧。');
  }
  renderAll();
}

function uiOnPickConfirm() { if (window.CardBrowser) window.CardBrowser.confirmPick(); }

/* ---------- v148：开发者「指定地形」（v149 修复：区域 2/3 选不中）----------
   v149 变更：
     1. 区域按钮改为**直接绑定**（不再只依赖 initOverlays 里的事件委托）：点哪一列就选中哪一列；
     2. 区域选择条从弹窗底部移到标题下方、三等分显示 —— 底部那一条在矮屏/手机端会被
        `.codex-modal { max-height:88vh; overflow:hidden }` 裁掉（遮罩又不可滚动）而点不到；
     3. 未选地形/未选区域就点「替换」时，提示直接显示在弹窗内（原先只写侧栏状态，被遮罩挡住看不见）。 */
const PICK_LOC_ZONE_TXT = ['区域 1（左）', '区域 2（中）', '区域 3（右）'];
let pickLocDefId = null;   // 选中的地形 id
let pickLocZoneIdx = 0;    // 选中的区域下标 0/1/2

function uiOnPickLoc() {
  if (!isDevMode()) return;
  const mask = $('pickLocMask');
  if (!mask) return;
  if (mask.classList.contains('hidden')) openPickLoc();
  else closePickLoc();
}
// 某列当前地形文案（用于按钮 title / 提示行）
function locTextAt(idx) {
  const def = state.locs[idx] && state.locs[idx].def;
  return def ? (def.icon + ' ' + def.n) : '未揭示';
}
function pickLocZoneText(idx) {
  return PICK_LOC_ZONE_TXT[idx] || ('区域 ' + (idx + 1));
}
// 选中要替换的区域（按钮点击 / 事件委托 都走这里）
function selectPickLocZone(idx) {
  const i = Number(idx);
  if (!Number.isFinite(i) || i < 0 || i > 2) return;
  pickLocZoneIdx = i;
  syncPickLocZones();
  updatePickLocTip();
}
// 区域按钮直接绑定（幂等：data-bound 标记，重复打开不会重复挂监听）
function bindPickLocZoneButtons() {
  const row = $('pickLocZones');
  if (!row) return;
  row.querySelectorAll('.plz-btn').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => selectPickLocZone(btn.getAttribute('data-loc')));
  });
}
function openPickLoc() {
  pickLocDefId = null;
  pickLocZoneIdx = 0;
  renderPickLocGrid();
  bindPickLocZoneButtons();
  syncPickLocZones();
  updatePickLocTip();
  $('pickLocMask').classList.remove('hidden');
}
function closePickLoc() {
  const mask = $('pickLocMask');
  if (mask) mask.classList.add('hidden');
  pickLocDefId = null;
}
// warn 非空时在弹窗内显示红字警告（校验失败用），否则显示当前选择摘要
function updatePickLocTip(warn) {
  const tip = $('pickLocTip');
  const zoneTxt = pickLocZoneText(pickLocZoneIdx);
  const def = pickLocDefId ? findLocDef(pickLocDefId) : null;
  if (tip) {
    if (warn) {
      tip.textContent = warn;
      tip.classList.add('warn');
    } else {
      tip.textContent = '目标：' + zoneTxt + '（现在 ' + locTextAt(pickLocZoneIdx) + '） · 已选地形：'
        + (def ? (def.icon + ' ' + def.n) : '（还没选，请在下方点一张）');
      tip.classList.remove('warn');
    }
  }
  const okBtn = $('btnPickLocConfirm');
  if (okBtn) okBtn.textContent = def ? ('替换 ' + zoneTxt + ' 的地形') : '替换地形';
}
function syncPickLocZones() {
  const row = $('pickLocZones');
  if (!row) return;
  row.querySelectorAll('.plz-btn').forEach((btn) => {
    const idx = Number(btn.getAttribute('data-loc'));
    const on = idx === pickLocZoneIdx;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.textContent = pickLocZoneText(idx);
    btn.title = '把 ' + pickLocZoneText(idx) + ' 的地形替换掉（当前 ' + locTextAt(idx) + '）';
  });
}
function renderPickLocGrid() {
  const grid = $('pickLocGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const pool = LOCATION_POOL.slice();
  for (const def of pool) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'loc-pick-card' + (pickLocDefId === def.id ? ' pick-picked' : '');
    btn.title = def.n + '：' + (def.eff || '');
    btn.innerHTML =
      '<span class="lpc-icon">' + def.icon + '</span>' +
      '<span class="lpc-name"></span>' +
      '<span class="lpc-eff"></span>' +
      '<span class="lpc-meta">上限 ' + def.max + (def.inv ? ' · 反转' : '') + (def.purge ? ' · 回合末摧毁' : '') + (def.grow ? ' · 回合末成长' : '') + (def.decay ? ' · 回合末衰减' : '') + (def.gamble ? ' · 翻开随机±' : '') + (def.dice ? ' · 第' + def.dice.turn + '回合掷骰' : '') + (def.rally ? ' · 第' + def.rally.turn + '回合+' + def.rally.add : '') + (def.gust ? ' · 揭示后吹飞' : '') + (def.collapse ? ' · ' + def.collapse.cards + '张牌后崩塌' : '') + (def.prot ? ' · 区域免摧毁' : '') + (def.spawn ? (def.spawn.cost != null ? ' · 出现生成随机' + def.spawn.cost + '费卡' : ' · 出现生成特殊卡') : '') + '</span>';
    btn.querySelector('.lpc-name').textContent = def.n;
    btn.querySelector('.lpc-eff').textContent = def.eff || '无特殊效果';
    btn.addEventListener('click', () => {
      pickLocDefId = def.id;
      renderPickLocGrid();
      updatePickLocTip();
    });
    grid.appendChild(btn);
  }
}
function uiOnPickLocClose() { closePickLoc(); }
function uiOnPickLocConfirm() {
  if (!isDevMode()) return;
  const def = pickLocDefId ? findLocDef(pickLocDefId) : null;
  if (!def) { updatePickLocTip('还没选地形：请在下方点选一种地形，再点「替换」。'); return; }
  const locIdx = pickLocZoneIdx;
  if (locIdx < 0 || locIdx > 2 || !state.locs[locIdx]) {
    updatePickLocTip('请先在上方选中要替换的区域（1 / 2 / 3）。');
    return;
  }
  const prev = state.locs[locIdx].def;
  const spawnChk = $('pickLocSpawn');
  const wantSpawn = !spawnChk || spawnChk.checked; // v150：默认结算「出现时」效果（可勾掉）
  // 直接替换当前列显示地形；同步 locPlan，避免后续揭晓又盖回旧计划
  state.locs[locIdx].def = def;
  if (state.locPlan && state.locPlan.length > locIdx) state.locPlan[locIdx] = def;
  refreshLocHeader(locIdx); // 列名/图标/效果文案/配色即时更新
  const spawnNote = !wantSpawn
    ? '（按设置不结算「出现时」效果）'
    : (def.spawn ? '（结算「出现时」效果）' : '（该地形没有「出现时」效果）');
  log('sys', '🗻 开发者指令：将区域 ' + (locIdx + 1) + '「' + (prev ? prev.n : '?') + '」替换为「' + def.n + '」' + spawnNote + '。');
  // v150：与地形揭晓走同一结算路径 —— 如虹龙洞 → 双方各生成 1 张「石块」
  const spawnCount = wantSpawn ? runLocAppearEffect(locIdx, def) : 0;
  renderZones(); // 隙间 / 锁定遮罩 / 点数横幅 / 新生成的 token 一并刷新
  setStatus('区域 ' + (locIdx + 1) + ' 已替换为「' + def.n + '」'
    + (spawnCount > 0 ? '，并结算了「出现时」生成（共 ' + spawnCount + ' 张）。' : '。'));
  closePickLoc();
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
  if (def.spawnS) add(def.spawnS.card); // v172：祖母绿巨石（法术）→ 同名的 1 费/3 战力占位卡
  if (def.clone) add(def.clone.card);   // 如赫卡提亚 → 分身
  // v171：集结（gather）——把该阵营的成员卡也列进“衍生/相关卡牌”，方便看出这张法术会生成谁
  if (def.gather && def.gather.group) {
    for (const m of gatherMembers(def.gather.group)) {
      if (m && list.indexOf(m) < 0) list.push(m);
    }
  }
  // v172：帕秋莉法术池（drawSpell）——把池内 5 张法术也列进“衍生/相关卡牌”，
  // 方便一眼看出这张帕秋莉会抽到哪些法术（池写在 fx.turnStart.pool，卡级 spellPool 兜底）
  const spellPoolKeys = (def.fx && def.fx.turnStart && def.fx.turnStart.pool) || def.spellPool;
  if (Array.isArray(spellPoolKeys)) {
    for (const k of spellPoolKeys) add(k);
  }
  if (def.og && def.og.tk) {
    for (const k in TOKENS) {
      const d = TOKENS[k];
      if (d && d.tk === def.og.tk) add(k);
    }
  }
  return list;
}

// 在卡牌详情弹窗右侧渲染“衍生卡牌”区（与主弹窗同框，关闭时一起关闭）
// v102：没有衍生卡的卡牌弹窗整体收窄（.zoom-stage.no-deriv）
function renderDeriv(def) {
  const box = $('zoomDeriv');
  const list = tokenLinksForDef(def);
  const stage = document.querySelector('.zoom-stage');
  if (stage) stage.classList.toggle('no-deriv', !list.length);
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
    <div class="zoom-meta"><span class="zm-cost">费用 ${def.c}</span>${isSpellDef(def) ? '<span class="zm-pow">法术 · 无战力</span>' : `<span class="zm-pow">威力 ${def.p}</span>`}</div>
    <div class="zm-kind">${kindTags(def)}</div>
    <div class="zm-desc">${def.t || (isSpellDef(def) ? '法术：只有能量花费与揭示效果，揭示结算完后自行消散。' : '平平无奇的白板卡，纯靠身材作战。')}</div>`;
  renderDeriv(def);
  zoomStageBtn(standalone ? '关闭 ✕' : '← 返回图鉴');
  $('zoomMask').classList.remove('hidden');
}

// 图鉴/放大视图的“效果分类”标签：揭示键的中文名 + 卡级持续机制（prot/og/surv/phx/
// leave/occ/fly 等非 k 字段）标签，避免把带持续/防护机制的卡误标成“白板”。
function kindTags(def) {
  const parts = [];
  // v170：法术——只带能量花费与揭示效果，无战力；标签置顶，并避免被当成普通白板
  if (def.spell) parts.push('法术 · 无战力（揭示后消散）');
  if (def.prot) parts.push('持续 · 区域免摧毁');
  if (def.og) parts.push('持续 · 强化指定 token');
  if (def.surv) parts.push('防摧毁');
  if (def.phx) parts.push('凤凰重生');
  if (def.leave) parts.push('终局离场');
  if (def.occ) parts.push('大体积占格');
  if (def.fly) parts.push('每回合移动一次');
  // v158：时机效果（fx）标签——避免把「幽灵」这类 k='' 但带 fx 的卡误标成纯白板
  if (def.fx) {
    if (def.fx.turnStart) parts.push('回合开始 · 时机效果');
    if (def.fx.turnEnd) parts.push('回合结束 · 时机效果');
    if (def.fx.gameEnd) parts.push('游戏结束 · 时机效果');
  }
  // 有其它机制标签时不再前置「无特殊效果（白板）」；纯白板卡仍显示白板标签
  const base = (def.k || !parts.length) ? (KIND_LABEL[def.k] || '') : '';
  if (base && parts.length) return base + '；' + parts.join('、');
  return base || parts.join('、');
}

// 手牌卡放大查看：显示该实例的“当前战力”（基础 + 永久 buff，如凤凰重生后的妹红），
// 而非固定基础战力；仅展示卡面/说明，无战力影响历史面板。
function showHandCard(card) {
  hidePowerPanel();
  const def = card.def;
  const live = cardPower(card);
  const diff = live - def.p;
  const sign = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
  // v169：费用修正（如桑尼米尔克加费）——按修正后的费用显示并着色，并补充一行「印刷费用 → 现在」
  const liveCost = cardCost(card);
  const costDiff = liveCost - def.c;
  const costSign = costDiff > 0 ? 'up' : costDiff < 0 ? 'down' : '';
  const slot = $('zoomCardSlot');
  slot.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'zoom-card hand-card';
  el.style.setProperty('--cgrad', gradOf(def));
  el.innerHTML = cardFaceHTML(def, { power: live, sign, cost: liveCost, costSign });
  slot.appendChild(el);

  $('zoomInfo').innerHTML = `
    <div class="zoom-meta"><span class="zm-cost">费用 ${liveCost}</span>${isSpellDef(def) ? '<span class="zm-pow">法术 · 无战力</span>' : `<span class="zm-pow">当前威力 ${live}</span>`}</div>
    ${costDiff !== 0 ? `<div class="zm-kind cost-mod-note">印刷费用 ${def.c} · 本场战斗费用修正 ${costDiff > 0 ? '+' : ''}${costDiff}（仅此一份卡有效）</div>` : ''}
    ${isSpellDef(def)
      ? '<div class="zm-kind">法术：只有能量花费与「揭示」效果 —— 无战力，任何增减都不影响它；揭示结算完后自行消散</div>'
      : (diff !== 0 ? `<div class="zm-kind">基础威力 ${def.p} · 永久增益 ${diff > 0 ? '+' : ''}${diff}</div>` : `<div class="zm-kind">基础威力 ${def.p}</div>`)}
    <div class="zm-kind">${kindTags(def)}</div>
    <div class="zm-desc">${def.t || (isSpellDef(def) ? '法术：只有能量花费与揭示效果，揭示结算完后自行消散。' : '平平无奇的白板卡，纯靠身材作战。')}</div>`;
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
  // 0) v170：法术没有战力——台账只有一行“法术（无战力）”（正常情况下法术在揭示后就已消散）
  if (isSpell(card)) return [{ d: 0, label: '法术（无战力）', kind: 'base' }];
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
  // v169：费用修正跟着这一份卡走（被加费后打出的卡，场上/放大视图同样显示修正后的费用）
  const liveCost = cardCost(card);
  const costDiff = liveCost - def.c;
  const costSign = costDiff > 0 ? 'up' : costDiff < 0 ? 'down' : '';
  const slot = $('zoomCardSlot');
  slot.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'zoom-card hand-card';
  el.style.setProperty('--cgrad', gradOf(def));
  el.innerHTML = cardFaceHTML(def, { power: live, sign, cost: liveCost, costSign });
  slot.appendChild(el);

  $('zoomInfo').innerHTML = `
    <div class="zoom-meta"><span class="zm-cost">费用 ${liveCost}</span>${isSpellDef(def) ? '<span class="zm-pow">法术 · 无战力</span>' : `<span class="zm-pow">场上威力 ${live}</span>`}</div>
    ${costDiff !== 0 ? `<div class="zm-kind cost-mod-note">印刷费用 ${def.c} · 本场战斗费用修正 ${costDiff > 0 ? '+' : ''}${costDiff}（仅此一份卡有效）</div>` : ''}
    <div class="zm-kind">${isSpellDef(def) ? '法术 · 无战力（揭示结算完后即自行消散）' : `基础威力 ${def.p}`}</div>
    <div class="zm-kind">${kindTags(def)}</div>
    <div class="zm-desc">${def.t || (isSpellDef(def) ? '法术：只有能量花费与揭示效果，揭示结算完后自行消散。' : '平平无奇的白板卡，纯靠身材作战。')}</div>`;
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
  // v147：开发调试显示对手当前能量（剩余 / 本回合上限）
  const enRow = $('aiEnergyRow');
  const enA = st.players.a;
  if (enRow) {
    enRow.classList.toggle('hidden', !isDevMode());
    if (isDevMode()) {
      const v = $('aiEnergyVal');
      const u = $('aiEnergyUnit');
      const gA = enA.energyGain || 0; // v169：额外能量提示（如斯塔萨菲雅给对手的下回合 +1）
      if (v) v.textContent = enA.energyLeft;
      if (u) u.textContent = '/ ' + enA.energyTotal + (gA ? ` (+${gA})` : '');
    }
  }
  // 若情报弹窗开着，牌数变化时同步刷新内容
  const spy = $('aiSpyMask');
  if (spy && !spy.classList.contains('hidden')) renderAiSpy();
}

/* ---------- v141：查看对手手牌 / 牌库 ---------- */
function aiSpyCardEl(card) {
  const def = card.def;
  const live = cardPower(card);
  const sign = live > def.p ? 'up' : live < def.p ? 'down' : '';
  const el = document.createElement('div');
  el.className = 'hand-card ai-spy-card' + (def.img ? '' : ' no-img');
  el.style.setProperty('--cgrad', gradOf(def));
  el.innerHTML = cardFaceHTML(def, { power: live, sign });
  el.title = def.n + (isSpellDef(def)
    ? '（' + cardCost(card) + ' 费 / 法术 · 无战力）· 点击放大'
    : '（' + cardCost(card) + ' 费 / 威力 ' + live + '）· 点击放大');
  el.addEventListener('click', () => showHandCard(card));
  return el;
}
function fillAiSpyGrid(holder, cards, emptyText) {
  if (!holder) return;
  holder.innerHTML = '';
  if (!cards.length) {
    const none = document.createElement('div');
    none.className = 'ai-spy-empty';
    none.textContent = emptyText;
    holder.appendChild(none);
    return;
  }
  for (const c of cards) holder.appendChild(aiSpyCardEl(c));
}
function renderAiSpy() {
  const hand = state.players.a.hand.slice();
  // deck 队尾先抽 → 反转后左侧为下一张将抽到
  const deck = state.players.a.deck.slice().reverse();
  const hc = $('aiSpyHandCount');
  const dc = $('aiSpyDeckCount');
  if (hc) hc.textContent = hand.length;
  if (dc) dc.textContent = deck.length;
  fillAiSpyGrid($('aiSpyHand'), hand, '手上没有牌。');
  fillAiSpyGrid($('aiSpyDeck'), deck, '牌库已空。');
}
function openAiSpy() {
  renderAiSpy();
  $('aiSpyMask').classList.remove('hidden');
}
function closeAiSpy() {
  $('zoomMask').classList.add('hidden');
  hidePowerPanel();
  $('aiSpyMask').classList.add('hidden');
}
function uiOnAiSpy() {
  const mask = $('aiSpyMask');
  if (!mask) return;
  if (mask.classList.contains('hidden')) openAiSpy();
  else closeAiSpy();
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
    onPickLoc: uiOnPickLoc,
    onPickLocClose: uiOnPickLocClose,
    onPickLocConfirm: uiOnPickLocConfirm,
    onEnergyDev: uiOnEnergyDev,
    onSwitchSide: uiOnSwitchSide,
    onAiSpy: uiOnAiSpy,
    closeAiSpy,
    onEnergyReset: uiEnergyReset,
    confirmEnergyReset,
    cancelEnergyReset,
  },
  _dbg: () => ({
    gen: state.gen, phase: state.phase, turn: state.turn,
    energyTotal: state.players.p.energyTotal, energyLeft: state.players.p.energyLeft,
    energyTotalA: state.players.a.energyTotal, energyLeftA: state.players.a.energyLeft,
    energyGainP: state.players.p.energyGain || 0, energyGainA: state.players.a.energyGain || 0,
    pendingEnergyP: state.pendingEnergyGain.p || 0, pendingEnergyA: state.pendingEnergyGain.a || 0,
    hasWaiter: !!pendingResolve,
    handP: state.players.p.hand.map((c) => cardCost(c)),
    handA: state.players.a.hand.map((c) => cardCost(c)),
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
  const pickLocMask = $('pickLocMask');
  const aiSpyMask = $('aiSpyMask');
  codexMask.addEventListener('click', (e) => { if (e.target === codexMask) closeCodex(); });
  zoomMask.addEventListener('click', (e) => { if (e.target === zoomMask) closeZoom(); });
  undoMask.addEventListener('click', (e) => { if (e.target === undoMask) cancelEnergyReset(); });
  pickMask.addEventListener('click', (e) => { if (e.target === pickMask) uiOnPickClose(); });
  if (pickLocMask) {
    pickLocMask.addEventListener('click', (e) => { if (e.target === pickLocMask) closePickLoc(); });
    bindPickLocZoneButtons(); // v149：区域按钮直接绑定（委托仅作兜底）
    const zoneRow = $('pickLocZones');
    if (zoneRow) {
      zoneRow.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('.plz-btn');
        if (!btn) return;
        selectPickLocZone(btn.getAttribute('data-loc'));
      });
    }
  }
  if (aiSpyMask) aiSpyMask.addEventListener('click', (e) => { if (e.target === aiSpyMask) closeAiSpy(); });
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!zoomMask.classList.contains('hidden')) closeZoom();
    else if (!codexMask.classList.contains('hidden')) closeCodex();
    else if (pickLocMask && !pickLocMask.classList.contains('hidden')) closePickLoc();
    else if (!pickMask.classList.contains('hidden')) uiOnPickClose();
    else if (aiSpyMask && !aiSpyMask.classList.contains('hidden')) closeAiSpy();
    else if (!undoMask.classList.contains('hidden')) cancelEnergyReset();
  });
})();

// 启动
restart();
