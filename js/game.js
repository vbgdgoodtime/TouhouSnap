/* 东方逆转 · Marvel Snap 玩法 · 东方 Project 换皮：3 区域 / 6 回合 / 能量预算多张出牌 /
   暗牌翻面 / 揭示效果 / 区域特效 / 双倍下注(snap) / 认输 / 重置暗牌。
   阶段管线：游戏开始 → 每回合(回合开始效果/能量抽牌/放置移动/翻牌揭示结算/
   全场回合结束/区域回合末/手牌回合末) → 游戏结束效果 → 结算胜负 */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 基础数据 ----------------
   卡牌与区域数据已拆到 data/cards.js、data/locations.js，index.html 中必须先于 game.js 加载。 */
const GRADS = {
  1: 'linear-gradient(150deg,#2e5f96,#7cc0ff)',
  2: 'linear-gradient(150deg,#2a7350,#5fdd9f)',
  3: 'linear-gradient(150deg,#8a6220,#f2c14e)',
  4: 'linear-gradient(150deg,#5b3a94,#c79bff)',
  5: 'linear-gradient(150deg,#8e2f5e,#ff9ac7)',
  6: 'linear-gradient(150deg,#a02f22,#ff9066)',
  // ⚠️ 新增费用档必须在这里补一条底色：卡面底色走 gradOf(def) → `--cgrad`，取不到色值时手牌/场上/
  // 图鉴/卡组页/放大视图的卡面会整体透明；7 费（「哆来咪」）＝梦之世界的深紫罗兰 → 淡紫（与 4 费档的紫区分）。
  7: 'linear-gradient(150deg,#3a2565,#c9a6ff)',
  // 8 费（「纯狐」）：口径同上，也必须在这里补底色；＝月夜的深靛蓝 → 冷银白（与 1 费档的蓝区分：更深、更冷）。
  8: 'linear-gradient(150deg,#1b2140,#d7e0ff)',
};
const BACK_GRAD = 'linear-gradient(160deg,#2b314a,#151929)';

const POOL = (window.DS_CARDS && window.DS_CARDS.POOL) || {};
const KIND_LABEL = (window.DS_CARDS && window.DS_CARDS.KIND_LABEL) || {};
const TOKENS = (window.DS_CARDS && window.DS_CARDS.SPECIAL) || {};
const GROUPS = (window.DS_CARDS && window.DS_CARDS.GROUPS) || {};
// POOL 的费用档键按数值升序取出：所有“遍历整个卡池”的地方（findCardDefByKey / gatherMembers /
// 图鉴与卡组页的卡池）都读它；写死区间会漏掉新费用档（漏档的卡会在图鉴/索引里整张消失）。
const POOL_COST_KEYS = Object.keys(POOL).map(Number).filter((c) => Number.isFinite(c)).sort((a, b) => a - b);
const LOCATION_POOL = (window.DS_LOCATIONS && window.DS_LOCATIONS.POOL) || [];
// 非随机地形表（EXTRA，见 locations.js）：存在但**不进开局随机抽选**，只作为“可按 id 引用的地形”
// 供机制调用（如 unreveal＝开局三列初始占位）。⚠️ 其 id 不能用 'hidden'，与全局 .hidden 隐藏类冲突。
const LOCATION_EXTRA = (window.DS_LOCATIONS && window.DS_LOCATIONS.EXTRA) || {};
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
// 「已破碎」地形兜底定义（正式数据在 locations.js EXTRA.shattered）——天界 `shatter` 摧毁后的占位态：max 0 ⇒ 该侧一格不剩，wt 0 ⇒ 不计入区域数。
const SHATTERED_LOC_DEF = { id: 'shattered', n: '已破碎', icon: '💥', wt: 0, dbl: 1, max: 0, eff: '此区域已被摧毁：不能放牌、不计分' };

// 卡面渐变：有自定义 cg 则优先，否则按费用档取色，未知档位兜底 BACK_GRAD（取不到色值卡面会透明）
const gradOf = (def) => (def && def.cg) || GRADS[def && def.c] || BACK_GRAD;

const DECK_CURVE = [1, 1, 1, 2, 2, 2, 3, 3, 4, 5, 6, 6];
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
// ---- 法术（spell，卡级机制）：只带**能量消耗（def.c）**与**「揭示」效果**、战力恒为 0 的卡（POOL 与 SPECIAL 两端都适用），判定统一走 isSpellDef / isSpell ----
//   ① cardPower / cardPowerIn 恒为 0，卡框不显示战力、任何位置都不吃战力增减；暗牌放置占 1 格，**揭示瞬间同样占 1 格**（影响放满加成与该侧“是否已满”），揭示效果结算完才腾出格位；
//   ② 消散 ≠ “摧毁”：不触发 surv / phx / prot 与任何摧毁类文本，不进战力影响历史，不返手不返库（一局就这一份），只记一条日志 + 消散演出；
//   ③ bf/de/ba 等增减跳过它；dw/dwh/mv/gift 这类“按威力选目标”的效果不选它（避免白费一次指向）；但它的“已放置”照常让 oc 触发、格位照常占用。
function isSpellDef(def) { return !!(def && def.spell); }
function isSpell(card) { return !!(card && card.def && card.def.spell); }
function cardPower(card) { return isSpell(card) ? 0 : card.def.p + card.buff; }
// ---- 费用修正（实例级，仅本场战斗有效）：加费 costUp 记在 card.costMod 上，只对「这一份」卡实例有效（牌库同名卡与图鉴不受影响）----
// `def.c` 始终是**印刷费用**、不被改写 —— 区域「雾之湖」的 cb 加成、卡组排序、图鉴与开发者「指定卡牌」一律按印刷费用判定。
// `costDown: N`（现仅 8 费「纯狐」）＝**双方每有一张牌真正被摧毁**，此牌费用 −N（下限 0）：只算**真正离场的那次摧毁**（dw / dwh / dwb / 地形 purge），
// 摧毁失败（phx / surv / ind / 地形 prot·蕾蒂）与其它离场方式（弃牌、法术消散、终局 leave、撤回手牌、移动、换边）都不算；读的是**摧毁池合计的实时值**，
// 故纯狐还没抽到手之前被摧毁的牌也计入；减费**不写进** costMod、也不改 def.c，只在 cardCost 里算 ⇒ 手牌角标变绿、放大视图写「本场战斗费用修正 −N」。
// cardCost = max(0, def.c + costMod − costDown × 摧毁数)；非摧毁/非增减/非放置：不触发 surv/phx/prot/ind、不动区域字段与格位、不进 powerLog/fieldQueue。
function cardCost(card) {
  if (!card) return 0;
  const base = card.def.c + (card.costMod || 0);
  const down = (card.def.costDown || 0) * destroyCount();
  return down > 0 ? Math.max(0, base - down) : base;
}
function addCostLog(card, d, srcCard, tag) {
  if (!card) return;
  if (!Array.isArray(card.costLog)) card.costLog = [];
  card.costLog.push({ inst: card, d, src: srcCard ? { id: srcCard.id, n: srcCard.def.n } : null, tag: tag || null });
}
// 费用修正的唯一收口（对应战力的 applyPermBuff）：改 costMod + 记账 + 排队“费用 ±N”演出；返回 false = 卡本身不可被改（un 占位卡如隙间）。
function applyCostMod(card, d, srcCard, tag) {
  if (!card || !d || (card.def && card.def.un)) return false;
  card.costMod = (card.costMod || 0) + d;
  addCostLog(card, d, srcCard, tag);
  costFlashQueue.push({ card, d, srcCard: srcCard || null });
  return true;
}
// 费用修正演出：中央弹出**被改费那张牌的完整卡面**（配图 / 卡名 / 费用 N → N+1 的横幅，spawnCostReveal）；
// 卡位可见时再提亮闪动，取不到卡位元素时退化为侧栏小气泡（spawnCostPop）；同一张卡在一批里只播一次（费用变化合并计入 d）。
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
    // 「旧值」由 新值 − d 反推（costMod 此时已是结果值），被多次改费时也正确
    spawnCostReveal(q.card, q.d, q.srcCard);
    if (!el || !el.isConnected) spawnCostPop(null, q.d, q.card);
  }
}
// 中央“费用被改”的卡面揭示：把该牌以完整卡面弹出（卡图 / 卡名 / 「费用 5 → 6」），约 2.4s 弹入 → 抖动 → 停留 → 上浮淡出；
// 内容全取自 def/实例数据（目标在对方手牌里也能如实展示），DOM 放 body 悬浮层不受重渲染影响。
function spawnCostReveal(card, d, srcCard) {
  if (!card || !card.def || !d) return;
  const def = card.def;
  const cur = cardCost(card);
  const before = cur - d;
  const inner = document.createElement('div');
  inner.className = 'cost-reveal-inner';
  const tag = document.createElement('div');
  tag.className = 'cost-reveal-tag';
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
  // 费用横幅：旧值划掉 → 新值（红=涨 / 绿=降）
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
// 费用变化小气泡：有卡位元素则以卡位为锚点（场上/我方手牌可见时），否则退到侧栏对手信息区
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

/* ==================== 额外能量（斯塔萨菲雅）的两段演出 ====================
   ① 登记段 playEnergyBookFx：揭示当刻在卡位上播星光迸发 + 「能量 +N · 下一回合生效」；② 到账段 playEnergyGainFx：下回合能量结算时
   在顶栏能量框（对手侧退到侧栏）播金光 + 星光迸发 + 「+N 能量」。两段都放 body 悬浮层、pointer-events:none 不挡操作、播完自动清理；尺寸为 0 时直接跳过。 */
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
  const ai = document.querySelector('#sidePanel .opponent .mini-stats');
  if (!ai) return;
  const r2 = ai.getBoundingClientRect();
  if (r2.width > 2) playEnergyFxAt(r2, n, `🔋 能量 +${n}`, subTxt, { flash: 'energy-box-flash', ring: 'energy-ring', pop: 'energy-pop' });
}
function playEnergyFxAt(rect, n, popText, subText, cls) {
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const box = document.createElement('div');
  box.className = cls.flash + ' ' + cls.ring;
  box.style.cssText =
    `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
    `width:${rect.width}px;height:${rect.height}px;border-radius:12px;` +
    `z-index:9400;pointer-events:none;`;
  document.body.appendChild(box);
  setTimeout(() => { if (box.parentNode) box.parentNode.removeChild(box); }, 1500);
  // 星光迸发：起点在锚点中心，位移由 CSS 变量 --edx/--edy 给出
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
/* ==================== 洗入卡组（`shuffleIn` 效果键） ====================
   把一张牌（或 n 张同名**新实例**）**洗入某一方的牌库**（`state.players[side].deck`），随后该方**整副牌库重新洗一次**；
   `drawOne` 从**队尾** pop，故重洗之后“下一张会抽到什么”立刻改变 —— 这才是本机制的实际作用。
   数据：`shuffleIn: { card: SPECIAL 键名(如 'stone') 或 POOL 卡名(如 '琪露诺'), n: 张数(缺省 1), to: 'own'(缺省) | 'opp' }`；
   分工：`give` 进手牌、`spawn*` / `clone` 落场上、`shuffleIn` 进牌库；`to:'opp'`（也接受 'a'）洗入对方牌库（归属按牌的 side）。
   要点：① **不结算被洗入卡的任何效果**（它在隐藏区：不翻开、不占格位、不进 fieldQueue，也不触发揭示 / og / fx / surv），日后被抽出翻开时才按常规流程结算；
     ② 牌库不是手牌、**张数无上限**（「手牌满则失败」不适用）；③ 洗入的是**全新实例**，costMod 自然为 0、不继承任何费用修正；
     ④ **公开**：日志点名“多少张什么牌洗入谁的牌库 + 洗后张数”并播轻量演出；⑤ 非摧毁/非放置/非增减：与 surv/phx/prot/ind、区域字段、格位判定全无交互。 */
// 按“键名”取卡 def：① 衍生池（SPECIAL）键名，② 人物池（POOL）卡名（POOL 按费用分档、无键名）
function findCardDefByKey(key) {
  if (!key) return null;
  if (TOKENS[key]) return TOKENS[key];
  for (const c of POOL_COST_KEYS) {
    for (const d of (POOL[c] || [])) if (d && d.n === key) return d;
  }
  return null;
}
/** 把 n 张指定卡的新实例洗入某方牌库，并把该方**整副牌库重新洗一次**。返回实际加入张数。 */
function shuffleCardsIntoDeck(side, def, n) {
  if (!def) return 0;
  const pl = state.players[side];
  if (!pl) return 0;
  const cnt = Math.max(0, Math.floor(n || 1));
  let added = 0;
  for (let i = 0; i < cnt; i++) {
    const c = newCard(def);
    c.side = side; // 归属（与 drawOne 一致；牌库里的实例也要带 side）
    pl.deck.push(c);
    added++;
  }
  if (added > 0) shuffle(pl.deck); // 整副牌库重新随机洗一次（把新牌混进去）
  return added;
}
/** 洗入卡组的轻量演出：牌库计数闪光 + 星光迸发 + 「洗入卡组」气泡。锚点＝对手侧 = 侧栏「牌库 N 张」/
    玩家侧 = 手牌区「牌库 N」；取不到锚点或尺寸为 0（页面隐藏 / 主页面态）时静默跳过、只留日志。 */
function playShuffleInFx(side, n, cardName, srcName) {
  const anchor = side === 'p' ? $('deckCountVal') : document.querySelector('#sidePanel .opponent .mini-stats');
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  // 牌库计数闪光（外扩光环并入同一条动画，避免两个 animation 互相覆盖）
  const box = document.createElement('div');
  box.className = 'deck-shuffle-flash';
  box.style.cssText =
    `position:fixed;left:${rect.left - 5}px;top:${rect.top - 4}px;` +
    `width:${rect.width + 10}px;height:${rect.height + 8}px;border-radius:999px;` +
    `z-index:9400;pointer-events:none;`;
  document.body.appendChild(box);
  setTimeout(() => { if (box.parentNode) box.parentNode.removeChild(box); }, 1500);
  // 星光迸发（复用 .energy-star 的飞行关键帧，辉光换青蓝；掺入 🃏/🎴 呼应“洗牌”）
  const stars = ['🃏', '✨', '🎴', '💫'];
  const count = Math.max(6, Math.min(12, 5 + n * 2));
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    p.className = 'energy-star deck-star';
    p.textContent = stars[i % stars.length];
    const ang = (Math.PI * 2 * i) / count + Math.random() * 0.5;
    const dist = 30 + Math.random() * 48;
    p.style.left = cx + 'px';
    p.style.top = cy + 'px';
    p.style.fontSize = (13 + Math.random() * 10).toFixed(1) + 'px';
    p.style.setProperty('--edx', `${(Math.cos(ang) * dist).toFixed(1)}px`);
    p.style.setProperty('--edy', `${(Math.sin(ang) * dist - 14).toFixed(1)}px`);
    p.style.animationDelay = (Math.random() * 0.12).toFixed(2) + 's';
    document.body.appendChild(p);
    setTimeout(() => { if (p.parentNode) p.parentNode.removeChild(p); }, 1400);
  }
  const pop = document.createElement('div');
  pop.className = 'energy-pop deck-pop';
  pop.style.left = cx + 'px';
  pop.style.top = cy + 'px';
  const main = document.createElement('span');
  main.className = 'ep-main';
  main.textContent = `🃏 洗入卡组 ×${n}`;
  pop.appendChild(main);
  const sub = document.createElement('span');
  sub.className = 'ep-sub';
  sub.textContent = `${srcName ? srcName + ' · ' : ''}${cardName} → ${side === 'p' ? '你的牌库' : '对手的牌库'}`;
  pop.appendChild(sub);
  document.body.appendChild(pop);
  setTimeout(() => { if (pop.parentNode) pop.parentNode.removeChild(pop); }, 1700);
}

/* ==================== 特殊牌池（摧毁池 / 弃牌池 / 放逐池）====================
   每局、每一方各自持有三个**独立队列**（`state.players[side]`），都是**先进先出**；入池的是**牌本体**（同一实例，不复制、不改 def）+ 一份入池元数据。
   入池条件：· 摧毁池 `destroyPile`＝**真正离场的那次摧毁**（dw / dwh / dwb / 地形 purge），按 card.side（换边后按新归属）入池；
   ⚠️ **摧毁失败不入池**（phx 凤凰重生 / surv 防摧毁 / ind 自身不可摧毁 / 地形 prot·蕾蒂），法术永远不会成为摧毁目标；
   其它离场方式也都不算（leave 终局、法术消散、撤回手牌、移动 mv/fly/shift/roam/gust、换边 switch/gift）。
   · 弃牌池 `discardPile`＝被弃掉的手牌（弃牌＝从**手牌**移出，与摧毁区域不同、互不重叠）；· 放逐池 `exilePile`＝用过的法术（揭示结算完后自行消散 vanishSpell）。
   元数据（三池共用）：pileKind / pileTurn / pileBy / pileLoc（弃牌记 null）/ pilePower（入池时实时战力）；入池**不**触发 surv/phx/prot/ind、不动区域字段、不改战力台账。 */
const PILE_KINDS = [
  { key: 'destroy', label: '摧毁池', tip: '被摧毁的牌（真正离场的那次摧毁）按入池先后存放' },
  { key: 'discard', label: '弃牌池', tip: '被弃掉的牌（弃牌效果把牌从手牌移出）按入池先后存放，v189 起有实际入池来源' },
  { key: 'exile',   label: '放逐池', tip: '用过的法术（揭示结算完后自行消散）按入池先后存放' },
];
const PILE_FIELDS = { destroy: 'destroyPile', discard: 'discardPile', exile: 'exilePile' };
function pileKindDef(kind) {
  for (const k of PILE_KINDS) if (k.key === kind) return k;
  return PILE_KINDS[0];
}
function pileOf(side, kind) {
  const pl = state.players[side];
  if (!pl) return [];
  const field = PILE_FIELDS[kind] || PILE_FIELDS.destroy;
  if (!Array.isArray(pl[field])) pl[field] = [];
  return pl[field];
}
function pileTotalOf(side) {
  let n = 0;
  for (const k of PILE_KINDS) n += pileOf(side, k.key).length;
  return n;
}
/** **本场战斗中双方被摧毁的牌数** ＝ 双方摧毁池张数之和（实时读取，随入池单调增长）。
    唯一使用者＝`cardCost` 的「费用随摧毁递减」（costDown，现仅 8 费「纯狐」）：摧毁失败与其它离场方式都不在池里，故摧毁池合计就是这份口径的唯一数据源。 */
function destroyCount() {
  return pileOf('p', 'destroy').length + pileOf('a', 'destroy').length;
}
/** 把**牌本体**放进某方某个池的队尾；meta = { turn, by, loc, power }（缺省取当前回合）。返回 { pile, n, kind }，不进 zone / fieldQueue、不改任何战力。 */
function pushToPile(side, kind, card, meta) {
  if (!card || !card.def) return null;
  const m = meta || {};
  const pile = pileOf(side, kind);
  card.pileKind = kind;
  card.pileTurn = (m.turn != null) ? m.turn : state.turn;
  card.pileBy = m.by || null;
  card.pileLoc = (m.loc != null) ? m.loc : null;
  card.pilePower = (m.power != null) ? m.power : null;
  pile.push(card);
  return { pile, n: pile.length, kind };
}
/** 摧毁入池收口 —— ⚠️ **必须在把该牌移出区域之前调用**（此刻才读得到它“被摧毁时”的区域与实时战力）；写元数据 + 入池 + 记日志，srcName = 来源（卡名 / 地形名）。 */
function recordDestroy(card, locIdx, srcName) {
  if (!card || !card.def) return null;
  const locName = (locIdx >= 0 && state.locs[locIdx]) ? state.locs[locIdx].def.n : null;
  const power = (locIdx >= 0) ? cardPowerIn(locIdx, card) : cardPower(card);
  const r = pushToPile(card.side, 'destroy', card, {
    turn: state.turn,
    by: srcName || null,
    loc: locName,
    power,
  });
  if (!r) return null;
  log('danger', `⚰️ 「${card.def.n}」被摧毁 → 进入${card.side === 'p' ? '你' : '对手'}的摧毁池（第 ${state.turn} 回合 · 来源：${srcName || '效果'} · ${locName || '未知区域'} · 当时战力 ${power}；现 ${r.n} 张）。`);
  renderPiles(); // 侧栏计数即时刷新（牌池弹窗若开着，列表也一并重渲染）
  return r;
}
/** 法术放逐入池（由 vanishSpell 在消散成功后调用；法术无战力，`pilePower` 记 0）。 */
function recordSpellExile(card, locName) {
  if (!card || !card.def) return null;
  const r = pushToPile(card.side, 'exile', card, {
    turn: state.turn,
    by: '法术消散',
    loc: locName || null,
    power: 0,
  });
  if (!r) return null;
  log('sys', `🗝️ 「${card.def.n}」用完消散 → 进入${card.side === 'p' ? '你' : '对手'}的放逐池（第 ${state.turn} 回合 · ${locName || '未知区域'}；现 ${r.n} 张）。`);
  renderPiles();
  return r;
}

/* ==================== 弃牌（`discard` 效果键）与弃牌演出 ====================
   一句话口径：**弃牌 = 把牌从「手牌」移出**，放进该牌**归属方**的**弃牌池**（先进先出、入池的是牌本体 + 元数据）。
   与「摧毁」的分工是**区域不同、互不重叠**：摧毁（dw/dwh/dwb/地形 purge）只作用于**场上** → 进摧毁池；弃牌只作用于**手牌**（隐藏区）→ 进弃牌池。
   因此弃牌**不是**摧毁：不触发 surv / phx / prot / ind，不进 powerLog、不改战力，也不动区域字段与格位（sideUsed/sideRoom）、放满加成与 fieldQueue。
   被弃的牌**带着自己的一切**进池：def 不被改写，powerLog、本场战斗的费用修正 costMod 都随该实例保留（弃牌池弹窗可查看、放大）。
   数据写法（见 data/cards.js）：discard: { n: 1 | 'all', to: 'own'(缺省) | 'opp' | 'a' | 'enemy', pick: 'random'(缺省) | 'right' | 'left' | 'maxCost',
     card: 卡名(可数组，或 SPECIAL 键名), cost: 印刷费用（数字＝恰好该费用，或 { min, max } 含端点）, give: { card, n, powerFromCost } }
   口径：① 目标方由 `to` 决定，归属对双方一视同仁（AI 抽到带本键的卡也会弃玩家的手牌）；② `card` / `cost` / `pick:'maxCost'` 一律按**印刷费用 def.c**
     （不是 cardCost；同区域 cb、og.cost、图鉴与卡组页分档口径）；③ 候选**保持手牌顺序**（左 → 右＝数组顺序）⇒ pick 的 right/left 就是玩家看到的手牌左右位置，
     maxCost ＝取印刷费用最高者、并列最高之间随机（口径同 dw/dwh/dwb）；④ 候选不足＝部分弃（日志写明）；一张都没有＝无事发生、只记一条日志；`n:'all'` 时 pick 不起作用；
     ⑤ **公开**：日志点名 + 中央弹出被弃那张牌的**完整卡面**并播**斜切两半**演出（playDiscardFx，约 1.6s），此后可在该方弃牌池里看到；
     ⑥ 手牌上限 7 只约束“加入/抽牌”，弃牌是**减少**手牌、与本机制无关（被弃的牌也不返场、不返牌库）；⑦ 与「重置暗牌」无冲突：playHandOrder 里已弃的 id 取不到、undoPlacedCards 自然跳过。 */
const DISCARD_ANIM_MS = 1600; // 弃牌演出总时长；与 style.css 的 discard* 关键帧时长对齐，改时长要两边一起改

/** `discard.card` 的筛选归一化：卡名（字符串/数组）或 SPECIAL 键名 → **卡名数组**（键名先经 TOKENS 解析成该 token 的卡名，如 'stone' → '石块'）。⚠️ 同名卡（如法术「祖母绿巨石」与占位 token「祖母绿巨石」）会一起命中。返回 null = 不筛选。 */
function discardNameFilter(spec) {
  if (!spec || spec.card == null) return null;
  const arr = Array.isArray(spec.card) ? spec.card : [spec.card];
  const names = [];
  for (const k of arr) {
    if (k == null) continue;
    const tk = TOKENS[k];
    names.push(tk && tk.n ? tk.n : String(k));
  }
  return names.length ? names : null;
}

/** `discard.cost` 区间口径：数字＝恰好该印刷费用；`{ min, max }` ＝含端点的区间（缺省端点为无界）。返回 null = 不筛选。 */
function discardCostRange(spec) {
  if (!spec || spec.cost == null) return null;
  const c = spec.cost;
  if (typeof c === 'number') return { min: c, max: c };
  const min = (typeof c.min === 'number') ? c.min : -Infinity;
  const max = (typeof c.max === 'number') ? c.max : Infinity;
  return { min, max };
}

function discardSpecText(spec) {
  const bits = [];
  const names = discardNameFilter(spec);
  if (names) bits.push(`卡名 ${names.join(' / ')}`);
  const range = discardCostRange(spec);
  if (range) {
    if (range.min === range.max) bits.push(`印刷费用 ${range.min}`);
    else if (range.max === Infinity) bits.push(`印刷费用 ≥${range.min}`);
    else if (range.min === -Infinity) bits.push(`印刷费用 ≤${range.max}`);
    else bits.push(`印刷费用 ${range.min}~${range.max}`);
  }
  const n = spec && spec.n;
  bits.push(n === 'all' ? '数量 全部' : `数量 ${Math.max(1, Math.floor((spec && spec.n) || 1))}`);
  // 'random' 是缺省口径、不写进文案（避免日志噪音）；'maxCost' ＝取印刷费用最高的那些
  if (spec && (spec.pick === 'right' || spec.pick === 'left' || spec.pick === 'maxCost')) {
    bits.push(spec.pick === 'right' ? '取牌 最右侧'
      : spec.pick === 'left' ? '取牌 最左侧'
      : '取牌 印刷费用最高');
  }
  return bits.join(' · ');
}

/** 某方手牌里符合 `discard` 筛选条件的候选（按手牌原顺序）。
    ⚠️ 费用筛选走**印刷费用 def.c**（同区域 cb、og.cost、图鉴与卡组页分档口径），不是 cardCost；`un` 占位卡（隙间）绝不在手牌，仍作防御性排除。 */
function discardCandidates(side, spec) {
  const pl = state.players[side];
  if (!pl) return [];
  const names = discardNameFilter(spec);
  const range = discardCostRange(spec);
  return pl.hand.filter((c) => {
    if (!c || !c.def || c.def.un) return false;
    if (names && names.indexOf(c.def.n) < 0) return false;
    if (range && (c.def.c < range.min || c.def.c > range.max)) return false;
    return true;
  });
}

/** **弃牌核心** —— 把 `side` 方手牌里符合 `spec` 的牌移出，并放进该方（＝牌的归属方，换边后的新归属）的**弃牌池**，同时播双方可见的弃牌演出。
    返回 { ok, side, cards, cands, want, by, why }（ok=false 时 cards 为空、why 说明原因）；⚠️ 调用方负责记日志（本函数只做数据 + 演出 + 入池，入池沿用 pushToPile 收口）。
    第 5 个参数 `onlyCard` ＝只允许弃**这一张卡实例**（候选先按 spec 过滤、再收窄到该实例），供 `fx.handEnd` 的自我丢弃用：
    这样即便手里有两张同名卡也只弃触发的那一张（不误伤另一张），入池元数据 / 演出 / 日志口径与既有弃牌完全一致。 */
function discardFromHand(side, spec, srcCard, tag, onlyCard) {
  const sp = spec || {};
  const pl = state.players[side];
  if (!pl) return { ok: false, side, cards: [], cands: 0, want: 0, by: null, why: 'no-side' };
  const all = discardCandidates(side, sp);
  const cands = onlyCard ? all.filter((c) => c === onlyCard) : all;
  const want = sp.n === 'all' ? cands.length : Math.max(1, Math.floor(sp.n || 1));
  if (!cands.length) return { ok: false, side, cards: [], cands: 0, want, by: null, why: 'no-candidate' };
  // 取牌：缺省 'random'＝在候选里**随机**取（沿用全局 Math.random，可被冒烟测试替换成种子化 PRNG）；'right' / 'left' ＝按**手牌左右位置**取
  // （候选数组已保持手牌顺序：最右＝队尾、最左＝队首）；'maxCost' ＝取印刷费用最高者、并列最高时随机；`n: 'all'` 时位置与费用排序都无意义（全都要）。
  const pick = (sp.pick === 'right' || sp.pick === 'left' || sp.pick === 'maxCost') ? sp.pick : 'random';
  let picked;
  if (pick === 'right') picked = cands.slice(Math.max(0, cands.length - want));
  else if (pick === 'left') picked = cands.slice(0, Math.min(want, cands.length));
  else if (pick === 'maxCost') {
    // 先 shuffle 再按**印刷费用**降序稳定排序 —— sort 稳定 + 先洗牌 ⇒ 同费用的相对顺序随机，
    // 因此「并列最高」天然是“在其中随机挑”；只比较 def.c（不走 cardCost，与 discard.cost 筛选、区域 cb、图鉴分档同口径）。
    picked = shuffle(cands.slice())
      .sort((a, b) => b.def.c - a.def.c)
      .slice(0, Math.min(want, cands.length));
  }
  else picked = shuffle(cands.slice()).slice(0, Math.min(want, cands.length));
  const by = (srcCard && srcCard.def && srcCard.def.n) || tag || '弃牌';
  const cards = [];
  for (const c of picked) {
    const i = pl.hand.indexOf(c);
    if (i < 0) continue;
    pl.hand.splice(i, 1);
    // 入池元数据（三池共用字段名）：手牌不在场上 → pileLoc 记 null；pilePower 记**被弃那一刻的战力**（基础 + 永久 buff；法术恒为 0）
    pushToPile(side, 'discard', c, { turn: state.turn, by, loc: null, power: cardPower(c) });
    cards.push(c);
  }
  if (!cards.length) return { ok: false, side, cards: [], cands: cands.length, want, by, why: 'no-candidate' };
  // 玩家自己的手牌被弃 → 立刻重渲染手牌（并复位选中项，避免 selected 指到别的牌上）
  if (side === 'p') {
    state.selected = -1;
    renderHand();
  }
  playDiscardFx(cards, side, by);
  return { ok: true, side, cards, cands: cands.length, want, by, why: null };
}

/* ==================== `discard.give`（弃牌后按被弃牌的印刷费用加手牌衍生物）====================
   `discard` 键的**可选子句**：弃牌**真的发生之后**，**每弃掉 1 张**就给**施放方自己**加入 give.n（缺省 1）张 give.card
   （SPECIAL 键名，如 'stone' ＝石块）的**新卡实例**到**手牌**（首个使用者：2 费 / 2 战力「姬虫百百世」）。
   ① **触发前提＝弃牌成功**：discardFromHand 返回 ok:false（手牌为空 / 没有符合筛选的候选）时**本条完全不结算**；
   ② **战力口径**：powerFromCost:true ⇒ 衍生物战力 ＝**那一张被弃牌的印刷费用 def.c**（**不是** cardCost），**逐张对应**（弃 n 张产生 n 组，give.n 与 discard.n 相互独立）；
      缺省 false ＝用衍生物自身的印刷战力（石块＝0）；③ 差额走 applyPermBuff(t, pw − tk.p, srcCard, '弃牌转化') 记永久增益（卡面绿字 +N、台账来源记本卡）；
   ④ **进的是手牌、不是场上**：newCard 新实例 + justHandAdded（flushHandAdd 播“滑入”演出），仍需**手动暗出**、不继承任何费用修正；
   ⑤ **手牌上限 7 张照常约束**（满则加不进、日志写明；本卡是先弃 1 张再加 1 张，位置一定够，防御分支仅兜底）；⑥ **加入目标恒为「施放方自己」**，与 `discard.to` 无关；
   ⑦ **非摧毁 / 非放置 / 非增减类**：与 surv/phx/prot/ind、区域字段与格位（sideUsed/sideRoom/fill）、fieldQueue 全无交互；⑧ **只做数据 + 渲染**，日志由调用方（applyEffect 的 case 'discard'）负责。
   返回 { added, want, name, powers, full, missing }；spec.give 缺失时返回 null（＝本子句不参与）。 */
function discardGiveTokens(side, spec, res, srcCard) {
  const gv = spec && spec.give;
  if (!gv) return null;
  const per = Math.max(1, Math.floor(gv.n || 1));
  const tkDef = TOKENS[gv.card]; // 同 `give` 口径：只认衍生池（SPECIAL）键名
  if (!tkDef) return { added: 0, want: 0, name: null, powers: [], full: false, missing: true };
  const hand = state.players[side].hand;
  const base = tkDef.p || 0;
  const powers = [];
  let added = 0;
  let full = false;
  const list = (res && res.cards) || [];
  for (const c of list) {
    // ②/③ 战力 = 这一张被弃牌的**印刷费用**（powerFromCost 时），差额走永久增益收口
    const pw = gv.powerFromCost ? ((c.def && c.def.c) || 0) : base;
    for (let i = 0; i < per; i++) {
      if (hand.length >= 7) { full = true; break; } // ⑤ 手牌满则加不进（同 give 口径）
      const t = newCard(tkDef);
      t.side = side;              // 归属＝施放方自己（与 discard.to 无关）
      t.justHandAdded = true;     // 加入手牌演出（渲染后播 .hand-new 滑入）
      const diff = pw - base;
      if (diff !== 0) applyPermBuff(t, diff, srcCard, '弃牌转化');
      hand.push(t);
      added++;
      powers.push(pw);
    }
    if (full) break;
  }
  if (added > 0) flushHandAdd(side); // 立刻渲染手牌 → 本次的“滑入”演出才看得到（同 give 口径）
  return { added, want: per * list.length, name: tkDef.n, powers, full, missing: false };
}

/* 弃牌演出：**任何一种归属组合**（自己弃自己 / 自己弃对方 / 对方弃对方 / 对方弃自己）都**双方可见** —— 场地中央弹出**被弃那张牌的完整卡面**
   （复用 cardFaceHTML 与 .zoom-card 大卡尺寸），随后**从右上到左下**斜切一刀，两半沿对角线垂直方向分离（带轻微旋转）并淡出，全程约 **1.6s**。
   实现要点：① 元素全放 body 悬浮层（.discard-reveal，pointer-events:none），不挡操作、不受盘面重渲染影响；播前先清掉残留的上一次演出（连续弃牌不叠层）；
     ② 斜切用 **clip-path 三角**：两半各放一份**同一张卡面的拷贝**（像素级重合），故切开后仍是同一张卡；另有一张“基准整卡”在切开那一瞬由 CSS 隐去；
     斩击线角度按卡面实测长宽比算出（atan2(h, w)），因此在竖长卡面上也严格贴着对角线；
     ③ 多张同时被弃时并排展示、逐张错开 80ms（最多 320ms），整层时长随之延长；④ 收尾用 setTimeout（**不依赖** Web Animations 的 finished），保证一定清理掉。 */
function playDiscardFx(cards, side, by) {
  const list = (cards || []).filter((c) => c && c.def);
  if (!list.length) return;
  if (typeof document === 'undefined' || !document.body) return;
  const stale = document.querySelector('.discard-reveal');
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale);

  const wrap = document.createElement('div');
  wrap.className = 'discard-reveal';
  // 多张并排时逐张错开 80ms；整层时长按“最大错开量”延长（CSS 的 --discard-tail），否则末张的“切开 + 消散”会被整层淡出提前掐掉
  wrap.style.setProperty('--discard-tail', Math.min(list.length - 1, 4) * 80 + 'ms');

  const tag = document.createElement('div');
  tag.className = 'discard-reveal-tag';
  tag.textContent = `🗑️ 弃牌 · ${side === 'p' ? '你的手牌' : '对手的手牌'}${by ? ` · ${by}` : ''}`;
  wrap.appendChild(tag);

  const inner = document.createElement('div');
  inner.className = 'discard-reveal-inner';
  const slashes = [];
  list.forEach((card, i) => {
    const def = card.def;
    const live = cardPower(card);
    const sign = live > def.p ? 'up' : live < def.p ? 'down' : '';
    const liveCost = cardCost(card);
    const costSign = liveCost > def.c ? 'up' : liveCost < def.c ? 'down' : '';
    const faceHTML = cardFaceHTML(def, { power: live, sign, cost: liveCost, costSign, sealed: cardSealed(card) });
    const grad = gradOf(def);
    const box = document.createElement('div');
    box.className = 'discard-card-wrap';
    box.style.setProperty('--discard-stagger', Math.min(i, 4) * 80 + 'ms');
    const mkFace = () => {
      const f = document.createElement('div');
      f.className = 'discard-face zoom-card hand-card';
      f.style.setProperty('--cgrad', grad);
      f.innerHTML = faceHTML;
      return f;
    };
    box.appendChild(mkFace()); // ① 基准整卡（切开那一瞬隐去）
    for (const half of ['a', 'b']) { // ② 斜切的两半（各含一份同样的卡面拷贝）
      const h = document.createElement('div');
      h.className = 'discard-half discard-half-' + half;
      h.appendChild(mkFace());
      box.appendChild(h);
    }
    const layer = document.createElement('div');
    layer.className = 'discard-slash-layer';
    const slash = document.createElement('span');
    slash.className = 'discard-slash';
    layer.appendChild(slash);
    box.appendChild(layer);
    slashes.push({ box, slash });
    inner.appendChild(box);
  });
  wrap.appendChild(inner);

  const note = document.createElement('div');
  note.className = 'discard-reveal-note';
  const names = list.map((c) => `「${c.def.n}」`).join('');
  note.textContent = `${names} → 移入${side === 'p' ? '你' : '对手'}的弃牌池（现 ${pileOf(side, 'discard').length} 张）`;
  wrap.appendChild(note);

  document.body.appendChild(wrap);
  // 卡面尺寸要等入 DOM 后才量得到（弹入动画是 transform，不影响 offsetWidth/Height）
  for (const it of slashes) {
    const w = it.box.offsetWidth, h = it.box.offsetHeight;
    if (w > 1 && h > 1) {
      it.slash.style.setProperty('--discard-slash-angle', (Math.atan2(h, w) * 180 / Math.PI).toFixed(2) + 'deg');
    }
  }
  // 末尾 +260ms 余量：给最后一两半的渐隐留时间（无动画能力时同样会清理干净）
  setTimeout(() => { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); }, DISCARD_ANIM_MS + 260 + Math.min(list.length, 5) * 80);
}

/** 弃牌的**控制台 / 开发调试探针**，与卡牌结算走**同一个** `discardFromHand` 收口，故流程 / 日志 / 入池 / 演出完全一致。
    例：`Game._discard('a', { n: 1 })` / `Game._discard('p', { card: '琪露诺' })` / `Game._discard('a', { cost: { min: 5 }, n: 'all' })`。 */
function devDiscard(sideKey, spec) {
  const side = sideKey === 'a' ? 'a' : 'p';
  const who = side === 'p' ? '你' : '对手';
  const r = discardFromHand(side, spec || {}, null, '开发者指令');
  const cond = spec ? `（${discardSpecText(spec)}）` : '';
  if (!r.ok) {
    log('sys', `🗑️ 开发者指令：想弃掉${who}手牌里的牌${cond}，但没有符合条件的牌（现手牌 ${state.players[side].hand.length} 张）。`);
  } else {
    log('sys', `🗑️ 开发者指令：弃掉${who}手牌里的 ${r.cards.length} 张${r.cards.map((c) => `「${c.def.n}」`).join('')} → 移入${who}的弃牌池（现 ${state.players[side].discardPile.length} 张）。`);
  }
  renderAll();
  return r;
}

// 区域-阵营加成：区域 aff 给“所属该阵营（card.def.g）”的卡牌加固定威力；属常驻实时加成（卡面/总数/摧毁/落后判定/图鉴放大都计入）。
function locRoleBonus(locIdx, card) {
  const aff = locDef(locIdx).aff;
  if (!aff || !card || card.def.un || card.def.spell) return 0; // 法术无战力，不吃阵营加成
  const v = card.def.g === aff.group ? aff.add : 0;
  return (v < 0 && locNoDown(locIdx)) ? 0 : v; // 免减攻区抹平负加成
}
// 区域-费用加成：区域 cb={c,add} 给位于本区域、费用恰为该值的卡牌加威力（如雾之湖对 1 费卡牌 +2；双方卡与特殊卡都算）。
function locCostBonus(locIdx, card) {
  const cb = locDef(locIdx).cb;
  if (!cb || !card || card.def.un || card.def.spell) return 0; // 法术不吃费用加成（仍按印刷费用）
  const v = card.def.c === cb.c ? cb.add : 0;
  return (v < 0 && locNoDown(locIdx)) ? 0 : v; // 免减攻区抹平负加成
}
// 区域-全体修正：区域 all=N（可为负，如冥界 -2）给本区域所有卡牌（双方、特殊卡）加 N 威力
function locAllBonus(locIdx, card) {
  if (!card || card.def.un || card.def.spell) return 0; // 法术不吃全区修正
  const v = locDef(locIdx).all || 0;
  return (v < 0 && locNoDown(locIdx)) ? 0 : v; // 免减攻区抹平负修正（如冥界 -2）
}
// 持续效果（og，原「在场光环」）：源卡**已翻开且仍在己方某区**期间，己方场上符合匹配条件的卡牌常驻 +N；动态读取（**实时派生**，不进 powerLog 台账），源卡离场即消失。
// 两种匹配口径：og.tk（如比那名居天子 → 己方带 tk:'rock' 的卡）/ og.cost（如克劳恩皮丝 → 己方场上**印刷费用**为该值的卡，含 1 费 token）。
function cardAuraBonus(card, locIdx) {
  if (!card || !card.side || card.def.spell || card.def.un) return 0; // 法术无战力，不吃持续加成
  const tk = card.def.tk;
  const cost = card.def.c;
  let b = 0;
  for (let j = 0; j < 3; j++) {
    for (const c of state.players[card.side].zones[j]) {
      const og = c.def.og;
      if (!og || !c.revealed || c.def.un) continue; // 源卡须已翻开且仍在场上
      if (cardMuted(c)) continue; // 失去卡牌文字（封印 ∪ 静海）：源卡被抹除 ⇒ 它的持续光环整条失效
      if (tk && og.tk === tk) b += og.add;
      else if (og.cost != null && og.cost === cost) b += og.add;
    }
  }
  // 免减攻区域：负的持续加成同样按 0 计（与 locRoleBonus/locCostBonus/locAllBonus 同口径）
  if (b < 0 && typeof locIdx === 'number' && locNoDown(locIdx)) return 0;
  return b;
}
// 卡牌在指定区域的实时战力 = 基础威力 + 永久增益 + 区域加成（阵营/费用/全区）+ 持续效果；法术恒为 0。
// 所在区域带 noDown（蓬莱药局）时，上述实时加成里的**负值一律按 0 计**（免减攻）。
function cardPowerIn(locIdx, card) {
  if (isSpell(card)) return 0;
  return cardPower(card) + locRoleBonus(locIdx, card) + locCostBonus(locIdx, card) + locAllBonus(locIdx, card) + cardAuraBonus(card, locIdx);
}
// ---- 占格（occ）口径：普通卡占 1 格、大体积卡（如伊吹萃香 occ:4）占满多格；出牌/生成/移动/放满等所有“还能放几张”的判定统一走这里，避免只用 zone.length 误判；法术恒按 1 格（暗牌占 1 个空位，揭示瞬间同样占 1 格）----
function occOf(card) {
  if (isSpell(card)) return 1;
  return (card && card.def && card.def.occ) || 1;
}
function sideUsed(side, locIdx) { return state.players[side].zones[locIdx].reduce((s, c) => s + occOf(c), 0); }

/* ---- 区域「隙间封格」（地形字段 `gap: N`，现仅「八云紫的家」）----
   每回合结束时，若某侧在本区**还有空位**，就把该侧**最靠后**的格位封成「隙间」（灰卡）。实现上**不往 zones 里塞卡**，而是把「已封格数」记在本列
   （`state.locs[j].gaps`，**双方各一份**）⇒ 该侧**可用格数** = 地形 max − 已封数（下限 0）；渲染层照旧只把隙间铺在“空置的不可用格”，于是表现为**最后一格先变灰、逐回合往前推**。
   口径：① **双方分别判定**（该侧还有空位才回合末 +1；放满了本次不加，之后腾出空位再继续）；② **下限 0**：可封到该侧一格不剩（此后不能放牌/生成 token，已有卡保留、照常计分）；
     ③ **地形被换掉即清空**（resetLocGaps：xform / collapse / 开发者「指定地形」/ 秘封俱乐部的定时变形）；④ 隙间**不占 zones**、不进 zoneTotals/powerLog/fieldQueue，不触发 surv/phx/prot/ind，也不参与任何目标选择；
     ⑤ 所有“还能放几张”的判定统一读 `locSideMax`（sideRoom / occZoneOk / zoneFillBonus / 渲染层格位），故放牌、落场生成（含 token）、移动、大体积卡上限、fill 放满全部自动按封格后的格数算。 */
/* ---- 区域「已破碎」（天界 `shatter` 摧毁后的状态）----
   天界在同一列「出现」时，会把另外两列的地形**连同其上的所有卡牌**一并摧毁（无视一切防护）；被摧毁的列地形换成 EXTRA.shattered（max 0 / wt 0 / 无效果）
   + `state.locs[j].shattered` 标记（渲染层据此把**整列**换成损坏面板）；判据＝“标记 ∨ 占位地形 id”双保险，故某一侧漏设标记也照样算已破碎。
   影响面（全部只读本判定，无一处写状态）：locSideMax → 0 使 sideRoom / occZoneOk / zoneFillBonus / 渲染格位全部作废；locOpen → false 挡住放牌 / 移动 / 落场生成 / 复活；
   渲染层 renderZones 整列跳过；终局 finishMatch 跳过（不计分、不参与胜负）、playEndHighlights 跳过；四条“换地形”路径（xform / xformTurn / collapse / 开发者「指定地形」）一律跳过。 */
function locShattered(locIdx) {
  const L = state.locs && state.locs[locIdx];
  if (!L) return false;
  if (L.shattered) return true;
  return !!(L.def && L.def.id === 'shattered');
}
function locGaps(side, locIdx) {
  const L = state.locs[locIdx];
  if (!L) return 0;
  if (!L.gaps) L.gaps = { p: 0, a: 0 };
  return L.gaps[side] || 0;
}
// 该列该侧的**可用格数**（地形 max − 已封隙间数，下限 0；max 缺省按 4）；已破碎的区域恒为 0（不能放牌、`fill` 不生效）
function locSideMax(side, locIdx) {
  if (locShattered(locIdx)) return 0;
  const d = locDef(locIdx);
  const base = (typeof d.max === 'number') ? d.max : 4;
  return Math.max(0, base - locGaps(side, locIdx));
}
// 该列两侧中**较大**的可用格数：仅供不带 side 的 occ 判定兜底（实际能否落下仍由 sideRoom ≥ occ 把关）
function locAnyMax(locIdx) { return Math.max(locSideMax('p', locIdx), locSideMax('a', locIdx)); }
// 地形被换掉时清空两侧隙间（隙间属于「八云紫的家」这块地形）
function resetLocGaps(locIdx) {
  const L = state.locs[locIdx];
  if (L) L.gaps = { p: 0, a: 0 };
}
function sideRoom(side, locIdx) { return locSideMax(side, locIdx) - sideUsed(side, locIdx); }
// 大体积卡只允许放入“该侧可用格数恰为其占格数”的区域（如 occ4 只能进可用 4 格的区域）；不带 side 时按两侧中较大的可用格数兜底（调用方随后仍会用 sideRoom 复核）
function occZoneOk(card, locIdx, side) {
  if (occOf(card) <= 1) return true;
  const m = side ? locSideMax(side, locIdx) : locAnyMax(locIdx);
  return m === occOf(card);
}
// 放满加成：区域 fill=N 时，某一方在本区实际占满**该侧可用格数**（含大体积卡，如 4/4）则该方总战力额外 +N；
// 因摧毁/撤回等原因不足时立即不生效（4→3 不加）；可用格数为 0（被隙间封死）时恒不生效。
function zoneFillBonus(side, locIdx) {
  const def = locDef(locIdx);
  if (!def.fill) return 0;
  const m = locSideMax(side, locIdx);
  return (m > 0 && sideUsed(side, locIdx) >= m) ? def.fill : 0;
}
// 区域总点数：默认只统计“已翻开的牌”（暗牌不计入，翻面后才计入）；includeHidden=true 供 AI 估值。
function zoneTotals(side, locIdx, includeHidden) {
  return state.players[side].zones[locIdx].reduce(
    (s, c) => (includeHidden || c.revealed ? s + cardPowerIn(locIdx, c) : s),
    0
  ) + zoneFillBonus(side, locIdx);
}
// 区域“有效战力”（比较口径）：总点数 × dbl 后，若是反转区域（inv，如辉针城）则取负值 —— 实际战力更低的一方在比较中反而更大（= 低者胜）。
function zoneEff(side, locIdx, includeHidden) {
  const t = zoneTotals(side, locIdx, includeHidden) * locDef(locIdx).dbl;
  return locDef(locIdx).inv ? -t : t;
}
// 区域对放牌是否“开放”：带 minTurn 的区域（如七夕坂第 5 回合起）在到达前双方都不能放牌；已破碎的区域恒不开放。
function locOpen(locIdx) {
  if (locShattered(locIdx)) return false;
  const mt = locDef(locIdx).minTurn;
  return !mt || state.turn >= mt;
}
function locDef(locIdx) { return state.locs[locIdx].def; }

/* ---- 本局总回合数（由地形字段 `extraRound` 驱动，现仅「虚假之月」）----
   ① **实时读取当前三列**：任一列带 extraRound 则为 7 回合、否则 6（未揭示列是 unreveal 占位、不带该字段），地形揭晓/变形/崩塌/开发者指定替换带上或失去该字段时立刻跟着变；
   ② **进入第 7 回合后锁定**：state.turn 已到 7 就恒为 7 —— 第 7 回合中途把虚假之月变掉也不会提前终局，这条也顺带保证**永远不会到第 8 回合**；③ **不叠加**（两块也只延长 1 回合）；
   ④ 消费点共四处，一律读本函数以保证一致：终局判定（playRound）/ 能量基数（roundStartStage）/ 斯塔萨菲雅的终局边界（energyNext）/ 顶栏「回合 N / 总数」（renderHud）。
   注意 `js/ai.js` 的地形投影与法术调度估值也读它。 */
function fakeMoonOnField() {
  return state.locs.some((l) => l && l.def && l.def.extraRound);
}
function roundsTotal() {
  if (state.turn >= 7) return 7; // ②：已在第 7 回合 → 锁定（同时封住第 8 回合）
  return fakeMoonOnField() ? 7 : 6;
}
/** 本局总回合数**发生变化的那一刻**的提示收口 —— 与 `state.roundTotal` 记录值不同才写一条日志（值本身是实时读的，本函数只负责留痕）。
    调用点＝地形揭晓 / 定时变形 / 卡牌 xform / 地形 collapse / 开发者「指定地形」/ 每回合开始（防御性再补一次：任何路径漏调都能在回合边界补上）。 */
function syncRoundTotal(tag) {
  if (!state.locs) return;
  const now = roundsTotal();
  if (now === state.roundTotal) return;
  const prev = state.roundTotal || 6;
  state.roundTotal = now;
  const why = tag || '地形变化';
  const names = state.locs
    .filter((l) => l && l.def && l.def.extraRound)
    .map((l) => `「${l.def.n}」`)
    .join('、');
  if (now > prev) {
    log('sys', `🌕 本局总回合数：${prev} → ${now} —— ${names || '虚假之月'}在场，本局将进行第 ${now} 回合（第 ${now} 回合能量 ${now} 点；${why}）。`);
  } else {
    log('sys', `🌕 本局总回合数：${prev} → ${now} —— 场上已没有「虚假之月」，本局回到 ${now} 回合（${why}）。`);
  }
  // 顶栏「回合 N / 总数」当场刷新（不等到回合末的 renderAll）——翻牌阶段里被 xform 变出/变走的虚假之月也能即时反映到 /7 与 /6。
  renderHud();
}

/* ---------------- 状态 ---------------- */
const state = {
  gen: 0,
  cardSeq: 0,
  turn: 1,
  roundTotal: 6,       // 本局总回合数（实时读 roundsTotal()；此字段只用于“变化的那一刻”留痕）
  phase: 'idle',       // idle | play | busy | over
  stakes: 1,
  pSnapped: false,
  aSnapped: false,   // AI 不再加倍（既不主动也不跟进），该标记恒为 false（侧栏「已加倍」标签不再出现）
  locs: [],
  locPlan: [],        // 本局三块“真实地形”按揭晓顺序预存（列 0/1/2 分别在第 1/2/3 回合开始揭晓）
  players: {
    // 能量分边：energyTotal / energyLeft 各自独立（回合开始写入相同基数，之后可单独改）；energyGain ＝本回合由「额外能量」多出来的点数（HUD 显示「N+1」，回合结束归零）。
    // 特殊牌池：每一方各自独立的三条队列、均按“先进先出”入池 —— destroyPile 摧毁池（真正离场的那次摧毁）/ discardPile 弃牌池（弃牌＝把牌从**手牌**移出，
    // 与摧毁的分工是区域不同）/ exilePile 放逐池（用过的法术消散后入池）。口径见 PILE_KINDS / pushToPile 段注释。
    p: { key: 'p', name: '你', zones: [[], [], []], deck: [], hand: [], energyTotal: 1, energyLeft: 1, energyGain: 0, destroyPile: [], discardPile: [], exilePile: [] },
    a: { key: 'a', name: '对手', zones: [[], [], []], deck: [], hand: [], energyTotal: 1, energyLeft: 1, energyGain: 0, destroyPile: [], discardPile: [], exilePile: [] },
  },
  selected: -1,
  // 能量机制挂钩（斯塔萨菲雅 k='energyNext'）：pendingEnergyGain ＝各方「下回合开始额外获得」的能量（一次性，回合开始结算后清空）；pendingEnergySrc ＝其来源卡实例（供到账演出定位，结算后清空）；players[side].energyGain ＝本回合实际生效的额外能量。
  pendingEnergyGain: { p: 0, a: 0 },
  pendingEnergySrc: { p: [], a: [] },
  // 游戏开始时效果（卡级字段 `gs`，现仅 7 费「哆来咪」）登记的**每回合最大能量加成**：由阶段 ⓪ runGameStartEffects 写入，在每次回合开始的能量结算（grantTurnEnergy）里并入基数；与 pendingEnergyGain 不同，它**本局永久**，只在 restart 时重置。
  energyAddPerTurn: { p: 0, a: 0 },
  playerMoves: [],     // 本回合玩家已暗出的牌 [{cardId, loc, side?}]；side 缺省为 'p'（切换立场时记为 'a'）
  aiMoves: [],
  playAsSide: 'p',     // 开发调试「切换立场」：'a' 时玩家落牌进敌方区且归属对手
  fieldQueue: [],      // 场上放置顺序队列：双方卡牌按“放入场上”先后记录，供回合开始/结束/终局按序结算
  playHandOrder: [],   // 本回合开始时玩家手牌 id 顺序（供重置暗牌时恢复）
  moveCardId: null,    // “每回合可移动一次”的牌：当前正在选目标区域的卡 id
  flyMoved: new Set(), // 本回合已自移过的卡 id（如射命丸文）
  flyMovedFrom: {},    // 本回合自移过的卡：卡 id → 回合初所在区域下标（供重置）
  logCount: 0,
};

let pendingResolve = null;
let pendingSwitchFly = null; // 换边演出待播 {card, srcRect}（由 switch/gift 记录、revealRound 渲染后触发）
// 自身移动待播的飞行演出队列 {card, srcRect}（roam 等）——由调用方（roundStartStage / revealRound）在渲染后 flush，观感同 fly/shift 的“滑行+缩放”。
let pendingDriftFly = [];
// pickDef（开发者“指定卡牌”选中）已随页面实现拆到 card-browser.js

/* ---------------- 流程主循环 ---------------- */
async function restart(opts) {
  opts = opts || {};
  state.gen++;
  const gen = state.gen;

  state.cardSeq = 0;
  state.turn = 1;
  state.roundTotal = 6; // 新一局的总回合数记录回到 6（本局真实值由 roundsTotal() 实时判定）
  state.phase = 'idle';
  state.stakes = 1;
  state.pSnapped = false;
  state.aSnapped = false;
  state.selected = -1;
  state.playerMoves = [];
  state.aiMoves = [];
  state.playAsSide = 'p'; // 新一局默认己方立场
  state.fieldQueue = []; // 场上放置顺序队列（时机效果按放置先后结算）
  buffFlashQueue = [];
  pendingDriftFly = [];
  pendingSwitchFly = null;
  state.playHandOrder = [];
  state.players.p.zones = [[], [], []]; state.players.p.hand = [];
  state.players.a.zones = [[], [], []]; state.players.a.hand = [];
  // 清空上一局的特殊牌池（摧毁池 / 弃牌池 / 放逐池）
  state.players.p.destroyPile = []; state.players.p.discardPile = []; state.players.p.exilePile = [];
  state.players.a.destroyPile = []; state.players.a.discardPile = []; state.players.a.exilePile = [];
  pileSide = 'p';
  pileKind = 'destroy';
  closePiles();
  // 清掉上一局的能量挂钩（额外能量登记、本回合提示、登记来源）
  state.pendingEnergyGain = { p: 0, a: 0 };
  state.pendingEnergySrc = { p: [], a: [] };
  // 清掉上一局的「每回合最大能量加成」——由本局阶段 ⓪ 的 gs 开局效果重新登记
  state.energyAddPerTurn = { p: 0, a: 0 };
  state.players.p.energyGain = 0;
  state.players.a.energyGain = 0;

  // 玩家卡组来源：opts.playerDeckDefs（自建满编 12 张）→ 上一局自建 → 随机曲线；opts.emptyPlayerDeck 为开发调试空牌库（「重新开始」会沿用）
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
  // 对手每局按 AI 费用结构从卡池随机组一套 12 张（同费用不重复）
  state.players.a.deck = buildDeckCards(AI_DECK_CURVE);

  // 对手初始 3 张先在数据层发放（无动画）；玩家 3 张由 playOpening 逐张滑入；第 1 回合开始双方再各抓 1 张（起手共 4 张）
  for (let i = 0; i < 3; i++) drawOne('a');

  // 选 3 块区域：按抽选权重（pick，默认 1）不放回抽 3 块保证互不相同；不足 3 种时退回兜底（允许重复）；开发调试固定三块「无名之丘」
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
  // 地形揭晓系统：开局按权重抽定三块真实地形存 locPlan（三列先以「未揭示」占位），由 locationRevealStage 在第 1/2/3 回合开始依次揭晓到第 0/1/2 列
  state.locPlan = picks;
  const hiddenDef = findLocDef('unreveal') || HIDDEN_LOC_DEF;
  // gaps = 本列两侧各自的「已封隙间格数」（见 locGaps / locSideMax；换地形时重置）；shattered = 本列是否已被「天界」摧毁（新一局全部 false）
  state.locs = picks.map(() => ({ def: hiddenDef, gaps: { p: 0, a: 0 }, shattered: false }));
  shatterChain = null; // 丢掉上一局遗留的「天界降临」链条（gen 守卫之外的额外保险）
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
  // 地形「出现时」效果不在开局结算——真实地形在揭晓那一刻才「出现」，由 locationRevealStage 结算
  const gsHits = runGameStartEffects(); // ⓪ 游戏开始效果挂点（现注册者：7 费哆来咪的 `gs`）
  renderAll();
  // 开局触发了 `gs`（卡组里带哆来咪）时先播「登场」演出，演完再抽卡；没触发则本函数立即 resolve
  await playGameStartReveal(gen, gsHits);
  if (gen !== state.gen) return;
  await playOpening(gen); // 玩家初始 3 张逐张滑入 → 间隔 500ms
  if (gen !== state.gen) return;
  playRound(gen);
}

// 开局演出：玩家初始 3 张逐张从右侧滑入（每张约 0.7s），三张到位后停 500ms 再进入第 1 回合（该回合还会再抽 1 张）
async function playOpening(gen) {
  for (let i = 0; i < 3; i++) {
    const card = drawOne('p');
    if (!card) break; // 开发调试空牌库时跳过开场发牌等待
    card.justDrawn = true;
    renderHand();
    await sleep(720);
    if (gen !== state.gen) return;
  }
  await sleep(500);
}

function buildDeckCards(curve) {
  // curve：费用序列（默认玩家兜底曲线）；每种费用从 POOL 随机抽、同费用不重复，抽牌顺序纯随机
  curve = curve || DECK_CURVE;
  const buckets = {};
  // 按曲线里实际用到的费用档建桶（不写死 1~6）——日后把 7 费编进曲线也不会因 buckets[7] 不存在而报错
  for (const c of new Set(curve)) buckets[c] = shuffle((POOL[c] || []).slice());
  const draw = shuffle(curve.slice());
  // 按抽牌顺序生成卡牌；drawOne() 从队尾取牌，因此反转存储
  const inDrawOrder = draw.map((c) => {
    const def = buckets[c].pop();
    return newCard(def || (POOL[c] && POOL[c][0]) || POOL[1][0]);
  });
  inDrawOrder.reverse();
  return inDrawOrder;
}

/* 用玩家自建卡组（12 张 def）造牌库——纯随机洗牌；drawOne 从队尾取，故反转存储 */
let lastPlayerDeckDefs = null;
/* 开发调试空牌库模式（无参 restart / 再来一局沿用） */
let lastEmptyPlayerDeck = false;
function isDevMode() { return !!lastEmptyPlayerDeck; }
/** 当前出牌落位归属（开发调试切换立场为敌方时返回 'a'） */
function playSide() {
  return (isDevMode() && state.playAsSide === 'a') ? 'a' : 'p';
}
/** 读某方能量对象（total / left） */
function energyOf(side) {
  return state.players[side];
}
/** 回合开始给双方写入本回合能量基数（各侧变量独立）：并入一次性 `pendingEnergyGain`（加完即清空、写进 `energyGain` 供 HUD 提示）与本局永久的 `state.energyAddPerTurn`（`gs.energyAdd`）⇒ 第 t 回合 = min(t, 6) + N。 */
function grantTurnEnergy(total) {
  for (const side of ['p', 'a']) {
    const pl = state.players[side];
    const gain = state.pendingEnergyGain[side] || 0;
    // 开局登记的「每回合最大能量 +N」（本局永久）与一次性 pendingEnergyGain 叠加，但结算后不清零
    const gsAdd = state.energyAddPerTurn[side] || 0;
    pl.energyTotal = total + gsAdd + gain;
    pl.energyLeft = total + gsAdd + gain;
    pl.energyGain = gain;
    state.pendingEnergyGain[side] = 0;
    if (gain > 0) {
      const who = side === 'p' ? '你' : '对手';
      log('sys', `🔋 ${who}本回合获得额外能量 +${gain}（能量上限 ${pl.energyTotal}；一次性，仅本回合有效）。`);
      // 到账演出（玩家侧锚点为顶栏能量框，对手侧落到侧栏对手信息区），随后清空登记来源
      playEnergyGainFx(side, gain, state.pendingEnergySrc[side] || []);
      state.pendingEnergySrc[side] = [];
    }
  }
}
/** 为某方登记「下回合开始额外能量」（energyNext）：下个回合开始（grantTurnEnergy）时一次性生效、多来源可叠加；返回 { n, src }（src 供到账演出定位）。 */
function addPendingTurnEnergy(side, n, srcCard) {
  if (!n) return { n: 0, src: [] };
  const cur = state.pendingEnergyGain[side];
  const booked = (typeof cur === 'number' ? cur : 0) + n;
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
  // powerLog：战力影响历史台账——记录该卡受到的「永久 buff」来源明细（由效果结算写入）；区域加成 / 持续效果是实时派生，不进台账。
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

// 把特殊卡落到某方某区：落地即翻开、占用格位、记录属方；放满则放不下。out 收集本次生成的卡实例（供 spawn.reveal）
function placeToken(side, locIdx, tkDef, cnt, out) {
  let placed = 0;
  const zone = state.players[side].zones[locIdx];
  for (let i = 0; i < cnt; i++) {
    if (sideRoom(side, locIdx) < 1) break;
    const card = newCard(tkDef);
    card.side = side;
    card.revealed = true;
    card.justSpawned = true; // 落场生成演出（凝聚显形）
    zone.push(card);
    enqueueField(card); // 落场 token：按落场先后进入放置队列
    if (out) out.push(card);
    placed++;
    // 衍生物池里的「法术」落场生成 = 等同手打一张法术：先结算自身「揭示」，随即消散
    if (card.def.spell) settleFieldSpell(card, locIdx);
  }
  return placed;
}

/* ========================================================
   流程阶段管线（主循环按显式阶段执行）：
   restart：建牌库 → 发初始手牌 → 抽选 3 块真实地形存 locPlan（三列先以「未揭示」占位）→ runGameStartEffects（⓪）
   每回合 playRound：① roundStart（①-0 揭晓第 t 列 +「出现时」→ ①-0b 定时变形 → ①-1 回合开始效果 → 能量结算 + 抽牌）
     → ② 玩家放置与移动 → ③ 对手放置 → ④ revealRound（翻开暗牌：区域「翻开时」→ 卡「揭示」→ 区域「揭示后吹飞」）
     → ⑤-0 地形类回合结束 → ⑤ 场上卡 fx.turnEnd → ⑥ 手牌 fx.handEnd → ⑦ runGameEndEffects → finishMatch 结算胜负
   注：①⑤⑦ 结算的带 `fx` 时机的场上卡按场上放置顺序队列结算；⑤-0 恒在 ⑤ 之前。
   ======================================================== */

// fx 时机键：卡牌 def 用 fx = { turnStart?, turnEnd?, gameEnd? } 声明时机效果；每个条目与揭示 def 同构（k/a/spawn/xf/give/t）。

// ---- 场上放置顺序队列：记「放入场上」的先后（含效果生成的特殊卡），时机类效果按「谁先放谁先结算」遍历；入队＝手牌打出 /
// placeToken 落场，出队＝被摧毁 / 重置暗牌撤回手牌（移动只换区域）；入队同时记 fieldTurn，供「回合开始效果」跳过刚登场的卡。
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
// 按放置队列先后结算指定时机的 fx 效果；**回合开始**只结算「本回合开始前已在场上」的卡（①-0 刚生成的卡跳过当回合），回合结束 / 游戏结束不受此限。
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
    // 失去卡牌文字（封印 ∪ 静海）：被抹除的牌其时机效果不结算（错过的时机不补结算）
    if (cardMuted(card)) { muteSkipLog(card, FX_TIMING_TXT[timing] || '时机效果'); continue; }
    applyEffect(card.side, locIdx, card, fx);
  }
}

/* ==================== 游戏开始时效果（卡级字段 `gs`，现仅 7 费「哆来咪」）====================
   阶段挂点 ⓪：建库/选区/区域生成后、**第 1 回合开始前**执行（此刻玩家牌库仍是完整 12 张，初始 3 张由 playOpening 在 ⓪ **之后**发放
   ⇒ 洗入的牌第一回合就可能被抽到）；开局时该卡在**自己一方的牌库/起手中**才触发，**整局永久生效**。
   `gs.shuffleN` 从普通卡池 POOL（1 费及以上，含池内法术）不放回抽 N 张洗入牌库并重洗、不碰 SPECIAL；`gs.energyAdd` 登记每回合最大能量 +N。
   ⚠️ **非**摧毁/放置/增减类：不进 `powerLog`、不触发 surv/phx/prot/ind、不动区域字段、不进 `fieldQueue`；`gs` 也不是揭示键，故
   `applyEffect` 与 `revealEffectWillChange` 都不需要分支。 */

/** 从「普通卡牌池」POOL 里**不放回**随机抽 n 张互不相同的牌 def（供 `gs.shuffleN`）：只取 1 费及以上、含 POOL 里的法术卡、完全不取 SPECIAL；排除 `un` 占位卡与带 `gs` 的卡自己（不会洗出第二张哆来咪）。 */
function randomPoolCards(n) {
  const want = Math.max(0, Math.floor(n || 0));
  if (!want) return [];
  const cands = [];
  for (const c of POOL_COST_KEYS) {
    if (c < 1) continue; // 只排除 0 费档（该档当前无卡）
    for (const d of (POOL[c] || [])) {
      if (!d || d.un || d.gs) continue; // 带 gs 的卡（哆来咪）不参与抽取 → 不会自我复制
      cands.push(d);
    }
  }
  return shuffle(cands.slice()).slice(0, Math.min(want, cands.length));
}

/** 结算一张卡的「游戏开始时」效果（`gs`）：洗入随机牌（shuffleN）+ 登记每回合能量加成（energyAdd）。 */
function applyGameStartEffect(side, card, gs) {
  const who = side === 'p' ? '你' : '对手';
  const pl = state.players[side];
  const n = Math.floor(gs.shuffleN || 0);
  if (n > 0) {
    const picks = randomPoolCards(n);
    const before = pl.deck.length;
    let added = 0;
    for (const d of picks) added += shuffleCardsIntoDeck(side, d, 1); // 每张一份新实例；函数内部会重洗牌库
    if (added > 0) {
      const names = picks.slice(0, added).map((d) => `「${d.n}」`).join('');
      log('sys', `💤 「${card.def.n}」（游戏开始时）：从卡牌池随机抽到 ${added} 张牌洗入${who}的卡组 —— ${names}（牌库 ${before} → ${pl.deck.length} 张，并重新洗了一次牌；这些牌第一回合起就可能被抽到）。`);
    } else {
      log('sys', `💤 「${card.def.n}」（游戏开始时）：想洗入 ${n} 张随机牌，但卡牌池里没有可抽的候选（数据缺失），本次无事发生。`);
    }
  }
  const add = Math.floor(gs.energyAdd || 0);
  if (add) {
    state.energyAddPerTurn[side] = (state.energyAddPerTurn[side] || 0) + add;
    log('sys', `🔋 「${card.def.n}」（游戏开始时）：${who}本局每回合最大能量 +${add}（本局永久，回合开始并入基数：第 1 回合 ${1 + add} 点 … 第 6 回合 ${6 + add} 点）。`);
  }
}

/** 阶段挂点 ⓪：游戏开始效果 —— 建库/发牌/选区后、第 1 回合前执行（现注册者：7 费「哆来咪」）；返回本次真正触发的卡 [{ side, card, gs }…]，供 restart 播「登场」演出，空数组则跳过。 */
function runGameStartEffects() {
  const hits = [];
  for (const side of ['p', 'a']) {
    const pl = state.players[side];
    // 开局“拥有”的判定：牌库 ∪ 起手（对手的 3 张起手在 ⓪ 之前已发）∪ 场上（防御：现无落场来源）
    const owned = pl.deck.concat(pl.hand);
    for (let j = 0; j < 3; j++) for (const c of pl.zones[j]) owned.push(c);
    for (const card of owned) {
      const gs = card.def && card.def.gs;
      if (!gs) continue;
      applyGameStartEffect(side, card, gs);
      hits.push({ side, card, gs });
    }
  }
  return hits;
}

/* ==================== 开局「登场」演出（`gs` 卡，现仅 7 费「哆来咪」）====================
   触发：⓪ 真的结算了带 `gs` 的卡时，在**洗牌 + 登记能量之后、玩家起手 3 张发放之前**播放一次「凸现」演出（约 1.8s），演完才抽牌。
   要点：元素全放 body 悬浮层（`.gs-reveal`，pointer-events:none），不挡操作也不受盘面重渲染影响，播放前先清残留；卡面复用 `cardFaceHTML(def)`；
   收尾用 `setTimeout`（**不依赖** `animation.finished`，被中断也一定 resolve、绝不卡住开局）；无 Web Animations 时（jsdom 冒烟测试）整段跳过。 */
function playGameStartReveal(gen, items) {
  const list = (items || []).filter((it) => it && it.card && it.card.def);
  if (!list.length) return Promise.resolve();
  return new Promise((resolve) => {
    const DUR = 1800; // 演出总时长；CSS 三处动画时长需与它同步（现 1.8s）
    // 防御：清掉可能残留的上一段演出（例如上一次开局被「重新开始」打断）
    const stale = document.querySelector('.gs-reveal');
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);

    const wrap = document.createElement('div');
    wrap.className = 'gs-reveal';
    const veil = document.createElement('div');
    veil.className = 'gs-reveal-veil';
    wrap.appendChild(veil);
    const inner = document.createElement('div');
    inner.className = 'gs-reveal-inner';
    for (const it of list) {
      const def = it.card.def;
      const box = document.createElement('div');
      box.className = 'gs-reveal-item';
      const tag = document.createElement('div');
      tag.className = 'gs-reveal-tag';
      tag.textContent = `${def.i || '💤'} 游戏开始时 · ${it.side === 'p' ? '你的卡组' : '对手的卡组'}`;
      box.appendChild(tag);
      const holder = document.createElement('div');
      holder.className = 'gs-reveal-cardwrap';
      const face = document.createElement('div');
      face.className = 'zoom-card hand-card gs-reveal-card';
      face.style.setProperty('--cgrad', gradOf(def));
      face.innerHTML = cardFaceHTML(def);
      holder.appendChild(face);
      box.appendChild(holder);
      const note = document.createElement('div');
      note.className = 'gs-reveal-note';
      const bits = [];
      if (it.gs.shuffleN) bits.push(`🃏 洗入 ${it.gs.shuffleN} 张随机牌`);
      if (it.gs.energyAdd) bits.push(`🔋 每回合最大能量 +${it.gs.energyAdd}`);
      note.textContent = bits.join(' · ');
      box.appendChild(note);
      const ring = document.createElement('div');
      ring.className = 'gs-reveal-ring';
      box.insertBefore(ring, box.firstChild);
      inner.appendChild(box);
    }
    wrap.appendChild(inner);
    document.body.appendChild(wrap);

    if (typeof wrap.animate !== 'function') { // 无 Web Animations（jsdom / 老浏览器）：跳过演出
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
      resolve();
    };
    // 星光迸发取卡面「弹入落定」那一瞬（约 240ms）的中心点：等比缩放不影响中心点，故此刻量 rect 即可
    const faceEl = wrap.querySelector('.gs-reveal-card');
    if (faceEl) {
      const r = faceEl.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        setTimeout(() => spawnGameStartSparks(cx, cy), 240);
      }
    }
    // 收尾按 DUR 定时清理并 resolve（不依赖 animation.finished）：被重新开局打断也不卡流程，旧流程会因 gen 变化 return
    setTimeout(finish, DUR);
  });
}

/** 「登场」演出的星光粒子：以锚点为中心向外迸发（复用 .energy-star 的飞行关键帧，追加 .gs-star 换紫金辉光）。 */
function spawnGameStartSparks(cx, cy) {
  const glyphs = ['💤', '✨', '🌙', '💫'];
  const count = 14;
  for (let i = 0; i < count; i++) {
    const s = document.createElement('span');
    s.className = 'energy-star gs-star';
    s.textContent = glyphs[i % glyphs.length];
    const ang = (Math.PI * 2 * i) / count + Math.random() * 0.4;
    const dist = 92 + Math.random() * 132;
    s.style.left = cx + 'px';
    s.style.top = cy + 'px';
    s.style.fontSize = (16 + Math.random() * 14).toFixed(1) + 'px';
    s.style.setProperty('--edx', `${(Math.cos(ang) * dist).toFixed(1)}px`);
    s.style.setProperty('--edy', `${(Math.sin(ang) * dist - 22).toFixed(1)}px`);
    s.style.animationDelay = (Math.random() * 0.18).toFixed(2) + 's';
    document.body.appendChild(s);
    setTimeout(() => { if (s.parentNode) s.parentNode.removeChild(s); }, 1600);
  }
}

// 阶段 ①-1：全场「回合开始」效果 —— 每回合最先执行（先于能量结算与抽牌），按放置队列序结算 def.fx.turnStart；只结算「本回合开始前
// 已在场上」的卡——地形「出现时」当回合生成的卡跳过本次（见 resolveTimedEffects）。现注册者：幽灵 roam、帕秋莉 drawSpell。
function runTurnStartEffects() {
  resolveTimedEffects('turnStart');
}

// 阶段 ⑤-0：区域（地形）回合结束效果 —— 每回合翻牌结算后**最先**执行（含第 6 回合、终局结算前）：① grow/decay（寺子屋/间歇泉）本区双方
// 已翻开卡永久 ±N → ② dice（骰子赌桌）指定回合末本区所有卡各自随机永久 ±N → ③ rally（演唱会）指定回合末本区双方已翻开卡永久 +N →
// ④ purge（聚变反应炉）摧毁本区战力最低的牌 → ⑤ collapse（幽明结界）本区双方总卡牌数达标即换地形 → ⑥ gap（八云紫的家）双方各从后
// 往前加 1 张「隙间」。⚠️ collapse 放在地形类效果**最后**：崩塌后的新地形从**下一回合**起参与，同回合不再触发其回合结束类效果；且
// collapse 换完地形后其后的 gap **一定不生效**（换地形本身已把隙间清空）。本函数为 async：崩出「天界」要等整条摧毁演出播完才继续。
async function runLocTurnEndEffects() {
  locTurnEndPowerEffects();
  locDiceEffects();
  locRallyEffects();
  reactorPurge();
  await locCollapseEffects();
  locGapEffects();
}

// 阶段 ⑤：全场「回合结束」卡牌效果 —— 在 ⑤-0 之后执行，按放置队列序结算 def.fx.turnEnd（现注册者：蕾米莉亚·斯卡蕾特，区域落后则永久 +3，可累积）。
function runTurnEndEffects() {
  resolveTimedEffects('turnEnd');
}

/* ==================== 手牌回合结束效果（时机键 `fx.handEnd`）====================
   阶段 ⑥ `runHandEndEffects()`：在 ⑤-0 → ⑤（`fx.turnEnd` 只结算**场上**队列里的牌）之后结算，逐个检查**双方手牌里仍在手上的牌**的
   `def.fx.handEnd` ⇒ 与 `fx.turnEnd` **区域不同、互不串场**（两种时机都写则各自结算）。现使用者＝稗田阿求（回合结束仍在手牌则自动丢弃）。
   ⚠️ 两个子句都要成立（打到场上 / 已被弃 / 被换走都不再触发）、双方一视同仁、含第 6 回合末；逐张按手牌顺序入「弃牌池」并播完整弃牌演出
   （走 `discardFromHand` 的 `onlyCard` 参数收窄到触发的那一张实例，同名双卡不误伤）；非摧毁类：不触发 surv/phx/prot/ind、不改战力与格位。 */
function runHandEndEffects() {
  for (const side of ['p', 'a']) {
    const pl = state.players[side];
    if (!pl) continue;
    const who = side === 'p' ? '你' : '对手';
    for (const card of pl.hand.slice()) { // 快照：结算途中会从手牌移除
      const he = card.def && card.def.fx && card.def.fx.handEnd;
      if (!he || !he.k) continue;
      if (pl.hand.indexOf(card) < 0) continue; // 防御：前面某张的效果已把它移出手牌
      if (he.k === 'discard') {
        const r = discardFromHand(side, he.discard || {}, card, null, card); // 只弃触发的那一张实例
        if (!r.ok) {
          log('sys', `📖 「${card.def.n}」：回合结束时已不在${who}的手牌中，本次无事发生。`);
          continue;
        }
        log('sys', `🗑️ 「${card.def.n}」：回合结束时依然在${who}的手牌中 → 自动丢弃（移入${who}的弃牌池，现 ${pileOf(side, 'discard').length} 张）。`);
        continue;
      }
      log('sys', `📖 「${card.def.n}」：手牌回合结束效果「${he.k}」尚未实装，本次无事发生。`);
    }
  }
}

// 阶段 ⑦：全场「游戏结束」效果 —— 结算胜负前按放置队列序结算各卡 def.fx.gameEnd；随后带 `leave` 的卡终局离场（**现无使用者**，预留机制）：从场上消失、增益随卡消失、不计入终局结算。
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

/* 地形揭晓换场演出：把当前「未揭示」外观的整列克隆到悬浮层并淡出（500ms），下方随即换成真实地形。⚠️ 克隆必须在地形 def 切换**前**抓取；pointer-events:none 不挡交互，淡完自动清理。 */
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
    { duration: 500, easing: 'ease-in' }
  );
  anim.finished.catch(() => {}).then(() => {
    if (clone.parentNode) clone.parentNode.removeChild(clone);
  });
}

/* ①-0 地形揭晓：真实地形在 restart 已按抽选顺序预存进 state.locPlan，第 t 回合开始时揭晓第 t 列（t=1/2/3 → 左/中/右）；换上真实地形后
   其上限/加成/反转/purge/grow/decay/gamble/dice/rally/gust/collapse/prot 等字段与列头配色即刻生效，揭晓时刻 = 该地形的「出现时」。
   ⚠️ 已放卡不移动、不增删：真实地形若为限张（max<4）且某侧已超上限（只有最晚揭晓的第三列可能），卡保留原格位，隙间只补在空置的不可用
   格位（数量 = 4 − max(已放数, 上限)），此后该侧按「已满」不再可放。 */
// 区域「出现时」：① spawn.card = SPECIAL 键名 → 双方各生成 n 张该特殊卡；② spawn.cost = 费用 → 从 POOL[cost] 随机抽人物卡（每张独立抽取，
// 排除 occ>1 与 un 占位卡）→ ③ spawn.reveal = true 则生成后**立即结算这些卡自身的「揭示」**。都走 placeToken；结算时机：地形揭晓 /
// 区域被 xform 变成该地形 / 开发者「🗻 指定地形」。返回实际落场张数。
function runLocAppearEffect(idx, def) {
  const placed = runLocAppearSpawn(idx, def);
// 天界 `shatter`：同属「出现时」时机，但它是**异步多阶段演出链**，这里只负责**启动**；正常对局四条路径会 `await awaitShatterChain()` 把节奏等完（开发者工具例外：启动后立刻关窗、后台播）。
  if (def && def.shatter) startShatterChain(idx, def);
  return placed;
}

/** 「出现时生成」逻辑（`spawn`）：从 runLocAppearEffect 拆出的纯生成部分（拆分只为给 `shatter` 让出收口）。 */
function runLocAppearSpawn(idx, def) {
  const sp = def && def.spawn;
  if (!sp) return 0;
  const cnt = sp.n || 1;
  const total = cnt * 2;
  if (sp.card) {
    const tk = TOKENS[sp.card];
    if (!tk) return 0;
    const made = [];
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
    const made = [];
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

/* ==================== 天界「出现时摧毁另外两块地形」（地形字段 `shatter: true`，现仅「天界」）====================
   口径：天界在本区「出现」的那一刻，把**另外两块地形**连同其上的**所有卡牌**一并摧毁，本局此后只剩本区域可用；被摧毁的两列变成「已破碎」
   （看不出原地形、无双方总点数、不能放牌）。节奏：逐块处理、**左→右**（跳过本列与已破碎列），每块两阶段——① 依次摧毁该区所有卡
   （顺序 = fieldQueue，每张间隔 0.3s）→ ② 等 0.3s 摧毁地形本身；两块之间再等 0.3s。保护：**一切防护一律无视**（区域 `prot` 与卡级
   surv/phx/ind 全不生效、不播替代演出）；被摧毁的卡照常走 `recordDestroy`（进归属方摧毁池、计入纯狐 `costDown` 摧毁计数），含暗牌与 token。
   ⚠️ `SHATTER_CARD_MS` 短于 `playShatter` 碎裂动画（约 1s，全局共用、不能为一处机制改短）⇒ 相邻碎裂动画**重叠播放**（刻意取舍）。
   链条是**单例 Promise**（`shatterChain`），正常对局四条路径 `awaitShatterChain()`；已破碎列永久锁定，不再被任何路径换地形。 */

const SHATTER_CARD_MS = 300;
const SHATTER_TERRAIN_MS = 300;    // 该区最后一张卡 → 摧毁该地形本身
const SHATTER_NEXT_LOC_MS = 300;

// 正在播放的「天界降临」链条（Promise | null）。单例：同一时刻只播一条。
let shatterChain = null;

/** 整列换成「已破碎」的损坏面板：看不出原地形、无双方总点数、无格位。做法是**换掉整个列元素**（连带丢弃原点击/悬停监听，破碎列不再触发任何出牌逻辑），并把 `Game._els` 里该列的四个引用换成游离占位节点（其它按索引取值的渲染代码不会报错）。 */
function renderShatteredColumn(locIdx) {
  const els = Game._els;
  if (!els || !els.cols) return;
  const old = els.cols[locIdx];
  const col = document.createElement('div');
  col.className = 'location shattered-loc';
  col.dataset.shattered = String(locIdx);
  const block = document.createElement('div');
  block.className = 'shatter-block';
  block.innerHTML =
    '<span class="shatter-glyph">💥</span>' +
    '<span class="shatter-name">已破碎</span>' +
    '<span class="shatter-sub">此区域已被摧毁</span>';
  block.addEventListener('click', (e) => {
    e.stopPropagation();
    setStatus('此区域已被「天界」摧毁：不能放牌、没有点数、也不参与胜负。');
  });
  col.appendChild(block);
  if (old && old.parentNode) old.parentNode.replaceChild(col, old);
  else if ($('board')) $('board').appendChild(col);
  els.cols[locIdx] = col;
  els.oppZone[locIdx] = document.createElement('div');
  els.mineZone[locIdx] = document.createElement('div');
  els.totA[locIdx] = document.createElement('span');
  els.totP[locIdx] = document.createElement('span');
}

/** 依次摧毁某区域内**双方的所有卡**（天界专用；**无视 surv/phx/ind/prot**）。顺序 = `fieldQueue`（谁先放谁先碎），
    不在队列里的按「先己方后敌方、格位顺序」补在后面。每张：`recordDestroy`（先记账，须在移出区域之前，此刻才读得到
    实时战力）→ `playShatter` → 移出区域 → 移出放置队列 → 渲染 → 等 `SHATTER_CARD_MS`。返回实际摧毁张数。 */
async function shatterZoneCards(locIdx, gen, srcName) {
  const def = locDef(locIdx);
  const where = def ? def.n : `区域 ${locIdx + 1}`;
  const targets = state.fieldQueue.filter((c) => c && fieldLocOf(c) === locIdx);
  for (const side of ['p', 'a']) {
    for (const c of state.players[side].zones[locIdx]) {
      if (targets.indexOf(c) < 0) targets.push(c); // 兜底：不在放置队列里的也一并摧毁
    }
  }
  if (!targets.length) {
    log('danger', `☁️ ${srcName}：「${where}」区域上空无一卡，直接进入地形摧毁。`);
    return 0;
  }
  log('danger', `☁️ ${srcName}：「${where}」区域开始崩塌 —— 依次摧毁其上的 ${targets.length} 张卡牌（本机制无视一切防摧毁 / 免摧毁保护）。`);
  let n = 0;
  for (const c of targets) {
    if (gen !== state.gen) return n;           // 防御：链条播放期间重开了一局
    if (fieldLocOf(c) !== locIdx) continue;    // 防御：已被前一张的效果挪走或摧毁
    recordDestroy(c, locIdx, srcName);         // ① 记入摧毁池（须在移出区域之前，此刻才读得到实时战力）
    playShatter(c);
    const zone = state.players[c.side].zones[locIdx];
    const i = zone.indexOf(c);
    if (i >= 0) zone.splice(i, 1);             // ③ 移出区域
    dequeueField(c);                           // ④ 移出放置队列（后续时机不再结算它）
    n++;
    renderZones();
    await sleep(SHATTER_CARD_MS);
  }
  log('danger', `☁️ ${srcName}：「${where}」区域上的 ${n} 张卡牌已全部摧毁（含暗牌与落场 token）。`);
  return n;
}

/** 摧毁某区域的**地形本身**：换成「已破碎」占位地形 + 整列换成损坏面板（返回原地形 def 供调用方用）。 */
function shatterZoneTerrain(locIdx, srcName) {
  const L = state.locs[locIdx];
  if (!L) return null;
  const prev = L.def;
  L.shattered = true;
  L.def = findLocDef('shattered') || SHATTERED_LOC_DEF;
  resetLocGaps(locIdx);            // 隙间属于被摧毁的那块地形，一并清空
  renderShatteredColumn(locIdx);
  // 若被摧毁的正是「虚假之月」→ 本局总回合数当场退回 6（并留一条日志 + 刷新顶栏）
  syncRoundTotal('天界摧毁地形');
  log('danger', `☁️ ${srcName}：「${prev ? prev.icon + prev.n : '该区域'}」的地形被彻底摧毁 → 该列变成「已破碎」（双方区域一并消失，不能放牌、不计分、不参与胜负）。`);
  return prev;
}

/** 「天界降临」链条：左→右依次摧毁另外两列（卡 →0.3s→ 地形 →0.3s→ 卡 →0.3s→ 地形）。 */
async function runShatterChain(heavenIdx, gen, srcName) {
  const targets = [];
  for (let j = 0; j < 3; j++) {
    if (j === heavenIdx) continue;
    if (locShattered(j)) continue; // 不重复摧毁：已经破碎的列直接跳过
    targets.push(j);
  }
  const heavenName = locDef(heavenIdx) ? locDef(heavenIdx).n : '本区域';
  if (!targets.length) {
    log('sys', `☁️ ${srcName}：另外两块区域早已破碎（不会重复摧毁），本次「降临」无事发生。`);
    return;
  }
  log('danger', `☁️ ${srcName}降临！即将摧毁另外 ${targets.length} 块区域（${targets.map((j) => `「${locDef(j) ? locDef(j).n : '区域 ' + (j + 1)}」`).join('、')}）—— 本局此后只剩「${heavenName}」一个可用区域。`);
  for (let k = 0; k < targets.length; k++) {
    const j = targets[k];
    if (gen !== state.gen) return;
    if (locShattered(j)) continue;              // 防御：链条期间该列已被别的路径摧毁
    await shatterZoneCards(j, gen, srcName);    // ① / ③ 依次摧毁该区的所有卡
    if (gen !== state.gen) return;
    await sleep(SHATTER_TERRAIN_MS);
    if (gen !== state.gen) return;
    shatterZoneTerrain(j, srcName);             // ② / ④ 摧毁地形本身
    if (k < targets.length - 1) {
      await sleep(SHATTER_NEXT_LOC_MS);         // 0.3s（只在下游还有一块要拆时才等）
      if (gen !== state.gen) return;
    }
  }
  renderZones();
  log('danger', `☁️ ${srcName}：另外两块区域已全部破碎 —— 本局仅剩「${heavenName}」可放牌，终局也只按这一个区域判定。`);
}

/** 启动「天界降临」链条（同步返回，演出在后台播）。单例：已有链条在播时复用、不重复启动。⚠️ 收尾按「还是同一条 Promise」判定（`shatterChain === p`）——上一局链条若在 restart 之后才收尾，也不会误清新一局的链条。 */
function startShatterChain(heavenIdx, def) {
  if (shatterChain) return shatterChain;
  const gen = state.gen;
  const srcName = (def && def.n) || '天界';
  let p = null;
  const done = () => { if (shatterChain === p) shatterChain = null; };
  p = (async () => {
    try {
      await runShatterChain(heavenIdx, gen, srcName);
    } catch (e) {
      console.error('[天界] 区域摧毁演出出错：', e);
    } finally {
      done();
      // ⚠️ 收尾渲染自带 try/catch：本链条可能是未被 await 的「后台播」，finally 里抛异常会让整条 Promise 变成未处理的 rejection
      try { if (gen === state.gen) renderZones(); } catch (e) { console.error('[天界] 收尾渲染出错：', e); }
    }
  })();
  shatterChain = p;
  return p;
}

/** 等待正在播放的「天界降临」链条结束（无链条时立即 resolve）。正常对局四条路径（揭晓 / 定时变形 / 崩塌 / 卡牌 `xform`，后者由 `revealRound` 逐张补等）都会 await 它；⚠️ 开发者「🗻 指定地形」**故意不 await**（后台播）。 */
async function awaitShatterChain() {
  while (shatterChain) {
    const p = shatterChain;
    await p.catch(() => {});
    if (shatterChain === p) break; // 防御：链条没被清空时避免死循环
  }
}

// spawn.reveal：让「出现时」生成的卡**也结算一次自身的「揭示」**。顺序 = 落场顺序（先你方后敌方）；只对带 `k` 的卡调用 `applyEffect`，
// 按该卡**当前所在区域**结算（防御：若已被前一张挪走，用挪走后的区域）；属同步结算（同 morph/fx 口径）：不做 400ms 停顿与翻牌演出。
function resolveSpawnedReveals(cards) {
  for (const c of cards) {
    if (!c || !c.def.k) continue;
    const j = fieldLocOf(c);
    if (j < 0) continue; // 防御：已不在场上
    applyEffect(c.side, j, c);
  }
}

// 集结（`gather`，现仅法术「三妖精集结」）的成员候选池：POOL 里 `g === group` 的卡（去重），排除 `un` 占位卡、法术与大体积卡（occ>1）；成员多于 3 张时随机取 3 张。
function gatherMembers(group) {
  if (!group) return [];
  const out = [];
  for (const c of POOL_COST_KEYS) { // 遍历实际存在的费用档（含 7 费组，其 gs 卡不会进集结池）
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

// 集结的**单区生成**：在区域 j 的 side 一侧生成 1 张成员卡（落地即翻开、占格位、入队），返回 { ok, name } 或 { ok:false, why }；同步版与分步演出版共用，保证两条路径口径一致。
function gatherSpawnAt(side, j, member, out) {
  if (!member) return { ok: false, why: '没有可分配的成员' };
  if (!locOpen(j)) return { ok: false, why: '未开放' };
  if (sideRoom(side, j) < 1) return { ok: false, why: '该侧已放满' };
  placeToken(side, j, member, 1, out);
  return { ok: true, name: member.n };
}
// 集结第 ② 步（「在这之后」）：自己一侧场上**已翻开**的该阵营卡牌永久 +add 战力（含刚生成的；暗牌不参与，口径同 bf/de/ba）。
function applyGatherBuff(side, card, group, add) {
  if (!add || !group) return 0;
  let n = 0;
  for (let j = 0; j < 3; j++) {
    for (const c of state.players[side].zones[j].slice()) {
      if (!c.revealed || c.def.un || c.def.spell) continue;
      if (c.def.g !== group) continue;
      applyPermBuff(c, add, card);
      n++;
    }
  }
  return n;
}

async function locationRevealStage() {
  const st = state;
  const idx = st.turn - 1;
  if (idx < 0 || idx >= st.locs.length) return;
  const loc = st.locs[idx];
  // 该列已揭晓（防御）；已被「天界」摧毁的列也走这里 —— 已破碎列永不揭晓
  if (!loc || !loc.def || loc.def.id !== 'unreveal') return;
  const target = st.locPlan && st.locPlan[idx];
  if (!target) return;
  revealLocFade(idx); // 旧「未揭示」外观淡出（快照须在换 def 前抓取）
  loc.def = target;
  resetLocGaps(idx);
  refreshLocHeader(idx);
  log('sys', `🃏 第 ${st.turn} 回合开始：地形「${target.n}」揭晓！`);
  // 揭晓时刻 = 该地形的「出现时」：结算生成效果；若揭晓的是「天界」，这里同时启动「摧毁另外两块地形」的演出链
  runLocAppearEffect(idx, target);
  // 揭晓出的地形若带 `extraRound`（虚假之月）→ 本局总回合数当场变 7（顶栏「/ 7」+ 一条日志）
  syncRoundTotal('地形揭晓');
  // 把「天界降临」整条摧毁演出等完再回上层 —— 否则回合开始效果 / 抽牌会插进节奏里
  await awaitShatterChain();
}

/* ---- 区域「定时变形」效果（字段 `xformTurn: { turn }`，现仅「秘封俱乐部」）----
   在**第 turn 回合的回合开始时**（①-0b，紧接 ①-0 揭晓之后、①-1 之前）结算：把本区域地形**整体换成地形池里随机另一个地形**，
   并立刻结算目标地形的「出现时」效果；候选 = LOCATION_POOL 里除自身以外的全部地形（允许与另外两列重复；EXTRA 非随机地形不入候选）；
   换掉后本区不再带 `xformTurn`，故只会变形一次；新地形从那一刻起完全生效，含**同一回合末**的 grow/decay/dice/rally/purge。
   ⚠️ **不做上限防御**（口径同「地形揭晓」的超限处理）；若该地形在第 turn 回合开始**之后**才落到本区，该时机已过、不补结算。 */
async function locXformTurnEffects() {
  const st = state;
  let changed = false;
  for (let j = 0; j < 3; j++) {
    if (locShattered(j)) continue; // 已破碎的列永久锁定 —— 不再变形（该列也不带任何字段）
    const def = locDef(j);
    const xt = def.xformTurn;
    if (!xt || st.turn !== xt.turn) continue;
    const cands = randomLocCandidates(j); // 候选收口（与卡牌键 `xformR` 共用）；口径＝只排除自身
    if (!cands.length) {
      log('danger', `${def.icon} ${def.n}：地形池里没有可变成的其它地形，本次不变形。`);
      continue;
    }
    const target = cands[Math.floor(Math.random() * cands.length)];
    st.locs[j].def = target;
    resetLocGaps(j);
    refreshLocHeader(j);
    log('sys', `${def.icon} ${def.n}：第 ${st.turn} 回合开始 —— 本区域变成了「${target.icon} ${target.n}」！`);
    // 变形 = 该地形在本区「出现」→ 立刻结算其「出现时」效果（如变成虹龙洞 → 双方各生成 1 张石块）；随机候选含「天界」时同样会摧毁另外两块地形（演出在此等完）
    runLocAppearEffect(j, target);
    // 随机变形可能变成「虚假之月」→ 本局总回合数当场变 7（反之变走则退回 6）
    syncRoundTotal('地形定时变形');
    await awaitShatterChain(); // 等「天界降临」的摧毁演出播完再继续（场上「回合开始」效果在它之后）
    changed = true;
  }
  if (changed) renderZones();
  return changed;
}

/* ---- 区域「随机变形」的**候选收口**（卡牌键 `xformR` 与地形字段 `xformTurn` 共用）：候选 = `LOCATION_POOL` 里除本列当前地形以外的全部
   地形（允许与另外两列重复）；`EXTRA` 的非随机地形（「未揭示」/「已破碎」）不入候选；池里只剩一块时返回空数组，调用方按「不变形」处理。 */
function randomLocCandidates(locIdx) {
  const cur = locDef(locIdx);
  return LOCATION_POOL.filter((d) => d && (!cur || d.id !== cur.id));
}

/* ==================== 区域「随机变形」（卡牌键 `xformR`，现仅 1 费「梅莉」）====================
   口径：**揭示：把本区域地形整体换成地形池里随机另一个地形**（＝把「秘封俱乐部」的 `xformTurn` 搬到卡牌揭示上），写法 `k: 'xformR'`
   （**无需附加字段**）；立刻结算目标地形「出现时」+ `resetLocGaps` + `refreshLocHeader`，新地形从那一刻起全量生效（含**同一回合末**的
   grow/decay/dice/rally/purge/collapse/gap）；特殊地形照旧（虚假之月 → 变 7、天界 → 启动 `shatter` 链）；非摧毁/增减/放置类，失去文字守卫照常拦下。
   ⚠️ 与卡牌键 `xform` **刻意相反**：候选 = 除本列当前地形以外的全部地形（允许与另外两列重复）且**不做上限防御** —— 抽中「上限放不下本区
   已放卡」的地形照常变形（已放卡不动、不增删、不摧毁）；已破碎的列一律跳过。登记点三处：`applyEffect` 的 `case 'xformR'`、
   `revealEffectWillChange` 的 `xformR` 分支、`KIND_LABEL.xformR`。
   ⚠️ 打**尚未揭晓**的列并翻开（候选只看「除当前地形以外」，「未揭示」是 EXTRA 占位地形、不在 POOL 里）⇒ 当场变成随机真实地形，且
   `locationRevealStage` 以 `loc.def.id === 'unreveal'` 判断「还没揭晓」⇒ 该列原定的揭晓被**整段跳过**（也不播淡出演出）。
   ⚠️ **为什么不复用 `xform` + `xf:'random'`**：`def.xf` 是**地形 id 字段**，`js/ai.js` 的 `case 'xform'` 会把它当地形 id 查表投影，塞 `'random'`
   会让那条投影拿到不存在的地形 id。⚠️ 在「守矢神社」里翻开（或 `retrigger` 再触发）会被**执行两次** ⇒ 一次揭示连换两次地形。 */

// 阶段 ①：回合开始 —— 地形揭晓 → 地形定时变形 → 回合开始效果 → 能量结算 + 抽牌 → 回合状态重置；本阶段为 async（「天界」摧毁链要等播完）
async function roundStartStage(gen) {
  const st = state;
  await locationRevealStage(); // ①-0 地形揭晓：第 t 回合揭晓第 t 列（t=1..3）
  if (gen !== state.gen) return;
  await locXformTurnEffects(); // ①-0b 地形定时变形（秘封俱乐部第 5 回合开始时变随机地形 + 结算其「出现时」）
  if (gen !== state.gen) return;
  // 防御性再同步一次本局总回合数：地形变化的各条路径已各自调用 syncRoundTotal，这里保证漏调的路径也能在回合边界补上那一条日志
  syncRoundTotal('回合开始');
  runTurnStartEffects(); // ①-1 全场「回合开始」效果（按放置队列序）
  // ①-1 里的卡牌若用 `xform`/`fx` 把本区变成「天界」，等摧毁演出播完再抽牌/结算能量
  await awaitShatterChain();
  if (gen !== state.gen) return;
  // ①-2 抽牌：第 1 回合起每回合双方各抓 1 张（开局 3 张已逐张发放，第 1 回合抽第 4 张）
  const drawnP = drawOne('p');
  if (drawnP) drawnP.justDrawn = true;
  drawOne('a');
  // ①-2 能量结算：普通局 = min(回合, roundsTotal())（虚假之月在场 → 第 7 回合各 7 点，turn>=7 后锁定为 7）；开发调试固定 10；额外能量在 grantTurnEnergy 内一次性并入。
  grantTurnEnergy(isDevMode() ? 10 : Math.min(st.turn, roundsTotal()));
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
  flushPendingDriftFly(); // 回合开始自动移动（幽灵 roam 等）的「滑行+缩放」演出
  log('sys', `—— 第 ${st.turn} 回合 · 双方各抓 1 张 ——`);
  const stanceTip = (isDevMode() && st.playAsSide === 'a') ? '【敌方立场】' : '';
  setStatus(`第 ${st.turn} 回合 · 能量 ${st.players.p.energyTotal}${stanceTip}：可一次暗出多张牌（总费用不超过能量），出完点「结束回合」；点能量框可重置本回合暗牌。`);
}

async function playRound(gen) {
  if (gen !== state.gen) return;
  const st = state;
  // 阶段 ① 为 await —— ①-0 若揭到「天界」，会在这里等整条摧毁演出播完
  await roundStartStage(gen); // 阶段 ①：回合开始（回合开始效果 / 能量结算 / 抽牌）
  if (gen !== state.gen) return;

  // 阶段 ②：玩家放置与移动（出牌 / 跳过 / 认输 / 双倍 / 移动 / 重置均在此阶段触发）
  const act = await waitPlayer();
  if (gen !== state.gen) return;
  if (act.type === 'retreat') { doRetreat(); return; }

  // 阶段 ③：对手放置（开发调试跳过，AI 不出牌）
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
  await revealRound(gen);
  if (gen !== state.gen) return;

  // 阶段 ⑤-0 区域（地形）回合结束 → 阶段 ⑤ 全场卡牌 → 阶段 ⑥ 手牌回合结束效果；⑤-0 必须 await：其中的 collapse 崩塌若崩出「天界」，要等整条摧毁演出播完
  await runLocTurnEndEffects();
  if (gen !== state.gen) return;
  runTurnEndEffects();
  runHandEndEffects();
  // ⑤/⑥ 的卡牌若把本区 xform 成「天界」，把摧毁演出等完再进终局判定
  await awaitShatterChain();
  if (gen !== state.gen) return;
  renderAll();

  // 终局判定读本局总回合数：有「虚假之月」时第 6 回合末续打第 7 回合；已到第 7 回合则 roundsTotal() 锁定为 7，第 7 回合末必定终局（不会出现第 8 回合）
  if (st.turn >= roundsTotal()) {
    // 阶段 ⑦：游戏结束效果（按放置队列序）→ 终局演出 → 结算胜负（最后一回合其 ⑤-0 / ⑤ / ⑥ 同样先于终局）
    runGameEndEffects();
    await awaitShatterChain(); // ⑦ 里的卡牌若把本区 xform 成「天界」，等摧毁演出播完再结算胜负
    if (gen !== state.gen) return;
    await playEndHighlights(gen); // 等加减动画清空后，依左→右放大胜方总点数
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
  st.moveCardId = null;
  const card = st.players.p.hand[index];
  if (!card) return;
  if (cardCost(card) > st.players.p.energyLeft) { setStatus('剩余能量不足，换一张更便宜的吧。'); return; }
  st.selected = (st.selected === index) ? -1 : index;
  renderAll();
}

function findPlayerCard(cardId) {
  const zones = state.players.p.zones;
  for (let j = 0; j < 3; j++) {
    const i = zones[j].findIndex((c) => c.id === cardId);
    if (i >= 0) return { zone: zones[j], j, card: zones[j][i] };
  }
  return null;
}

function uiMoveFly(cardId) {
  const st = state;
  if (st.phase !== 'play') return;
  const found = findPlayerCard(cardId);
  if (!found || !found.card.def.fly || !found.card.revealed) return;
  // 失去卡牌文字（封印 ∪ 静海）：被抹除的牌失去「每回合移动一次」（fly）的能力，不能进入移动模式
  if (cardMuted(found.card)) {
    muteSkipLog(found.card, '「每回合移动一次」（fly）的能力');
    setStatus(`「${found.card.def.n}」在「${locDef(found.j).n}」里失去了卡牌文字，不能用“每回合移动一次”。`);
    return;
  }
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

function tryMoveFlyTo(locIdx) {
  const st = state;
  if (st.moveCardId == null) return false;
  const found = findPlayerCard(st.moveCardId);
  if (!found) { st.moveCardId = null; renderZones(); return true; }
  const card = found.card;
  // 失去文字守卫：已进入移动模式后该区才变成静海（开发者「指定地形」）也不放行
  if (cardMuted(card)) {
    muteSkipLog(card, '「每回合移动一次」（fly）的能力');
    setStatus(`「${card.def.n}」在「${locDef(found.j).n}」里失去了卡牌文字，不能用“每回合移动一次”。`);
    st.moveCardId = null;
    renderZones();
    return true;
  }
  if (st.flyMoved.has(card.id)) { setStatus('这张卡本回合已经移动过一次。'); st.moveCardId = null; renderZones(); return true; }
  if (locIdx === found.j) { setStatus('这张卡本来就在这个区域，选别的区域吧。'); return true; }
  if (!locOpen(locIdx)) { setStatus(`「${locDef(locIdx).n}」还没开放，不能移过去。`); return true; }
  const dz = st.players.p.zones[locIdx];
  if (sideRoom('p', locIdx) < 1) { setStatus('目标区域已放满，不能移过去。'); return true; }
  // 与八云紫（shift）同款的“滑行 + 缩放”飞行演出——先记录源卡当前位置
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

/* ==================== 卡级放置条件（`playReq: { tk, n }`，现仅 6 费「大鲶鱼」）====================
   只在**手牌 → 场上**这一刻查一次，不满足就打不出来（不落牌 / 不扣能量 / AI 不出）；计数＝打出方自己三个区域里
   **已翻开**、带 `def.tk` 的卡（暗牌、对方场上的、`un` 与法术都不计）。⚠️ 打出后不再追踪，其它“上场”路径一律不检查。 */
function playReqCheck(side, card) {
  const req = card && card.def && card.def.playReq;
  if (!req || !req.tk) return { ok: true, need: 0, have: 0, label: '' };
  const need = Math.max(1, req.n || 1);
  let have = 0;
  for (let j = 0; j < 3; j++) {
    for (const c of state.players[side].zones[j]) {
      if (!c.revealed || c.def.un || c.def.spell) continue;
      if (c.def.tk !== req.tk) continue;
      have++;
    }
  }
  return { ok: have >= need, need, have, label: tokenNameLabel(req.tk) };
}
// 由 token 标记（`def.tk`，如 'rock'）反推可读标签（'rock' → 石块）；tkBuff 段与 playReq 共用（tk 标记没有中文名表）。
function tokenNameLabel(tk) {
  const names = Object.keys(TOKENS)
    .filter((k) => TOKENS[k] && TOKENS[k].tk === tk)
    .map((k) => TOKENS[k].n);
  return names.length ? names.filter((n2, i2) => names.indexOf(n2) === i2).join('/') : tk;
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
  const side = playSide(); // 开发调试可切到敌方立场落牌
  // 卡级放置条件（`playReq`）：只在“从手牌打出”这一刻检查，不满足就**不落牌、不扣能量**并说明当前数量。
  const reqR = playReqCheck(side, card);
  if (!reqR.ok) {
    const who = side === 'a' ? '对手' : '你';
    setStatus(`「${card.def.n}」不能打出：需要${who}的场上已有至少 ${reqR.need} 张已翻开的「${reqR.label}」（现 ${reqR.have} 张）。`);
    log('sys', `⚠️ 「${card.def.n}」放置条件不满足：需要${who}场上已翻开的「${reqR.label}」≥ ${reqR.need} 张（现 ${reqR.have} 张），本次未打出。`);
    return false;
  }
  const zone = st.players[side].zones[locIdx];
  if (!locOpen(locIdx)) {
    setStatus(`「${locDef(locIdx).n}」还没开放，要到第 ${locDef(locIdx).minTurn} 回合才能放牌。`);
    return false;
  }
  if (occOf(card) > 1 && !occZoneOk(card, locIdx, side)) {
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
  enqueueField(card); // 暗出：进入场上放置顺序队列
  st.players.p.hand.splice(st.selected, 1);
  st.selected = -1;
  const paid = cardCost(card); // 按修正后的费用扣能量（可能被桑尼米尔克加过费）
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

function uiEndTurn() {
  const st = state;
  if (st.phase !== 'play') return;
  st.selected = -1;
  st.moveCardId = null;
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
  undoPlacedCards();
  undoFlyMoves();
  renderAll();
}

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
      dequeueField(card);
    }
  }
  if (removed.length === 0) { st.playerMoves = []; st.selected = -1; renderAll(); return; }
  const pool = new Map();
  for (const c of pl.hand) pool.set(c.id, c);
  for (const c of removed) pool.set(c.id, c);
  const restored = [];
  for (const id of st.playHandOrder) {
    const c = pool.get(id);
    if (c) { restored.push(c); pool.delete(id); }
  }
  for (const c of pool.values()) restored.push(c);
  pl.hand = restored;
  // 3) 能量返还（只返还玩家侧；敌方立场落牌仍耗玩家能量）
  const en = pl;
  en.energyLeft = Math.min(en.energyTotal, en.energyLeft + removed.reduce((s, c) => s + cardCost(c), 0));
  st.selected = -1;
  st.playerMoves = [];
  log('p', `↺ 你重置了本回合暗出的 ${removed.length} 张牌，已放回手牌，能量返还。`);
  renderAll();
}

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
    if (back.length >= locSideMax('p', from)) continue; // 理论不会发生：先重置暗牌已腾位（按该侧可用格数判）
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
// 人机思考逻辑在独立文件 ai.js（aiThink；三档难度 AI.setLevel('easy'|'hard'|'nightmare')），此处经全局函数名被 playRound 阶段 ③ 调用。

/* ---------------- 翻牌与效果 ---------------- */
// 当前领先方（结算口径、只看已翻开的牌）：先比赢下的区域数，打平再比三区有效总点数，均等返回 null。
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

async function revealRound(gen) {
  const st = state;
  if (gen === undefined) gen = st.gen;
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
    // 玩家以敌方立场暗出的牌记在 playerMoves.side='a'，按归属并入该方翻牌序
    for (const mv of movesForSide(side)) order.push({ side, cardId: mv.cardId, loc: mv.loc });
  }
  for (const mv of order) {
    const pl = st.players[mv.side];
    const card = pl.zones[mv.loc].find((c) => c.id === mv.cardId);
    if (!card) continue;
    card.revealed = true;
    card.justRevealed = true;
    // 区域「翻开时」效果（如驹草赌场）在翻面瞬间、该卡自身揭示**之前**结算，故卡面战力 / 翻牌日志 / 后续 bl 判定都按博彩后的威力算
    runLocRevealEffects(mv.side, mv.loc, card); // 法术不吃博彩（见 runLocRevealEffects）
    // 地形「守矢神社」（repeatReveal）资格按“翻开那一刻”快照认定：翻牌途中本列被 xform 换成别的地形也照常重复一次，故先记快照再等该卡自身揭示结算完
    const repeatRevealHere = !!locDef(mv.loc).repeatReveal;
    renderZones(); // 翻面：新元素带 .played-now → CSS flipIn（0.5s 从小到大缩放）入场
    log(mv.side, isSpell(card)
      ? `「${card.def.n}」翻牌 — 法术（无战力；揭示效果结算后消散）`
      : `「${card.def.n}」翻牌 — 威力 ${cardPowerIn(mv.loc, card)}`);
    let willChange = false;
    if (card.def.k) {
      // 失去卡牌文字（封印 ∪ 静海）：被抹除的牌文本视为不存在 ⇒ 揭示不发动；四个走分步演出的键也在这里拦下（那里会绕过 applyEffect 守卫）
      if (cardMuted(card)) {
        muteSkipLog(card, '揭示效果');
      } else {
        // 只有效果“真的会造成变化”时才停顿展示（缩放动画同时播放，避免同帧重建吞掉入场）
        willChange = revealEffectWillChange(mv.side, mv.loc, card);
        if (willChange) await sleep(400);
        // 揭示分派统一收口 resolveRevealInZone()：先按 resolveCardReveal 结算该键（四个分步演出键走各自的异步分步版），
        // 再按本列 repeatReveal 决定**是否再来一次**；早苗 retrigger 再触发的揭示也走同一条收口，故同样会被本区加倍。
        await resolveRevealInZone(mv.side, mv.loc, card, repeatRevealHere);
        if (willChange) renderZones(); // 效果确有变化才重建（白板/未触发时保留入场元素直到动画播完）
      }
    }
    // 「守矢神社」（repeatReveal）的“第 1 次 + 重复一次”已由上面那句 resolveRevealInZone(...) 一并做完，故这里不再单独
    // 调用：它排在法术消散与 gust 之前，资格用翻面瞬间的快照。法术**且仅在**自身揭示结算完之后消散，故此刻它仍占 1 个格位。
    if (isSpell(card)) {
      if (vanishSpell(card)) renderZones(); // 让格位可见地空出来（消散演出在悬浮层播）
    }
    flushPendingSwitchFly(); // 换边（switch/gift）后播放“滑行+缩放”演出（真身已渲染，克隆飞行）
    // 区域「揭示后吹飞」（gust，如魔力风暴）与 roam 类揭示键的漂移都在自身揭示结算完之后才移动，这里统一 flush 飞行演出。
    runLocAfterRevealEffects(mv.side, mv.loc, card);
    flushPendingDriftFly();  // roam / gust 的“滑行+缩放”飞行演出
    // 若这张牌的揭示用 xform 把本区变成「天界」，其摧毁链是**同步启动、异步播放**的（case 'xform' 改不成 async）——在这里把整条演出等完，避免后续阶段插进摧毁节奏
    await awaitShatterChain();
    if (gen !== state.gen) return;
    await sleep(500);
  }
  st.playerMoves = [];
  st.aiMoves = [];
}

// 预判该牌的“揭示”效果是否真会造成数值/盘面变化（用于跳过“结算前 400ms 停顿”——如对没有已翻开卡的区域打增减、条件不满足等空转情况）。
function revealEffectWillChange(side, locIdx, card) {
  const st = state;
  const other = side === 'p' ? 'a' : 'p';
  const mine = st.players[side].zones[locIdx];
  const theirs = st.players[other].zones[locIdx];
  const def = card.def;
  // 法术不算“可被指向的目标”——dw/dwh 的最弱、mv 的最弱、gift 的己方最低都跳过它
  const vis = theirs.filter((c) => c.revealed && !c.def.un && !c.def.spell);
  // 法术没有战力——「落后自增」（bl）与「对方同区落牌自增」（oc）对它没有意义，不产生变化
  if (def.spell && (def.k === 'bl' || def.k === 'oc')) return false;
  // 失去卡牌文字（封印 ∪ 静海）——被抹除的牌不会产生任何变化（也不空等结算前的 400ms 停顿）
  if (cardMuted(card)) return false;
  // 区域「封锁揭示」（法界）——揭示被封锁的牌照常不产生任何变化（同样不空等 400ms）
  if (revealBlocked(card)) return false;
  switch (def.k) {
    case 'bf': return mine.some((c) => c !== card && !c.def.un && c.revealed);
    case 'de': return vis.length > 0 && !locNoDown(locIdx); // 本区「免减攻」→ 不产生变化，跳过结算前停顿
    case 'ba': return true;
    case 'bl': return zoneEff(side, locIdx) < zoneEff(other, locIdx);
    case 'dw':
    case 'dwh': {
      // ind 卡照常参与判定，只是判定落在它身上时摧毁失败、判定结束——故这里要复刻“谁会被判定选中”：dw 取最弱（并列取先遇到的，与实际结算同序），dwh 取最强（并列随机）
      if (vis.length === 0 || locNoDestroy(locIdx)) return false;
      if (def.k === 'dw') {
        let minP = Infinity, tgt = null;
        for (const c of vis) {
          const p = cardPowerIn(locIdx, c);
          if (p < minP) { minP = p; tgt = c; }
        }
        return isDestroyable(tgt); // 判定落在 ind 卡上 → 不会产生变化（跳过结算前的停顿）
      }
      let maxP = -Infinity;
      for (const c of vis) maxP = Math.max(maxP, cardPowerIn(locIdx, c));
      return vis.filter((c) => cardPowerIn(locIdx, c) === maxP).some(isDestroyable);
    }
    case 'dwb': {
      // 摧毁本区**双方**最弱随机一张：本区存在可摧毁的已翻开卡、且本区没有免摧毁时才真会变化；ind 卡照常参与“最低”判定与并列抽取，故并列池里还有非 ind 卡时才可预测
      const both = mine.concat(theirs).filter((c) => c.revealed && !c.def.un && !c.def.spell);
      if (both.length === 0 || locNoDestroy(locIdx)) return false;
      let minBoth = Infinity;
      for (const c of both) minBoth = Math.min(minBoth, cardPowerIn(locIdx, c));
      return both.filter((c) => cardPowerIn(locIdx, c) === minBoth).some(isDestroyable);
    }
    case 'dwc': {
      // 摧毁**双方三个区域**所有印刷费用为 `dwc.cost`（缺省 1）的已翻开卡——任一（不在免摧毁区、够格被选中、真能变化）的该费用牌即为 true（isDestroyable 排除 ind、保留 phx/surv）
      const wantC = (def.dwc && def.dwc.cost != null) ? def.dwc.cost : 1;
      for (let j = 0; j < 3; j++) {
        if (locNoDestroy(j)) continue;
        const z = st.players[side].zones[j].concat(st.players[other].zones[j]);
        if (z.some((c) => c.def.c === wantC && isDestroyable(c))) return true;
      }
      return false;
    }
    case 'deAll': {
      // 敌方**三个区域**所有已翻开卡各 −N——对方任一区域存在可被削弱的已翻开卡（排除 un 与法术）就真会变化；带 noDown（蓬莱药局）的区域吃不到 −N，故逐区排除
      return st.players[other].zones.some(
        (z, j) => !locNoDown(j) && z.some((c) => c.revealed && !c.def.un && !c.def.spell)
      );
    }
    case 'mute': {
      // 封印：本区存在“可被封印”的已翻开卡（暗牌、`un` 占位卡与法术都不算；`has:'ongoing'` 时还须带「持续」标记）就一定会有变化
      // ⇒ 照常走 400ms 停顿与结算后重渲染。
      // ⚠️ 目标**已被封印**时也照常（口径＝照常再抹一次、不改打下一张），故这里**不**看它是否已被封印。
      const sp = def.mute || {};
      const sides = (sp.side === 'both') ? [side, other] : [sp.side === 'own' ? side : other];
      const onlyOngoing = sp.has === 'ongoing';
      for (const s of sides) {
        if (st.players[s].zones[locIdx].some((c) => c.revealed && !c.def.un && !c.def.spell && (!onlyOngoing || cardHasOngoing(c)))) return true;
      }
      return false;
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
      return Math.min(cnt, sideRoom(other, locIdx)) > 0;
    }
    case 'spawnS': {
      // 只投放到“自己一侧”：该侧有空位才算会变化。`fill: true` 时按“填满”算，且那张法术**先消散、再铺满**（把自身那 1 格也让出），故该侧还有空格就会变化
      const sp = def.spawnS;
      const tk = sp && TOKENS[sp.card];
      if (!tk) return false;
      if (sp.fill) return sideRoom(side, locIdx) + (def.spell ? 1 : 0) > 0;
      const cnt = sp.n || 1;
      return Math.min(cnt, sideRoom(side, locIdx)) > 0;
    }
    case 'spawnMine': {
      // 给**己方每个区域**（含本区）自己一侧各生成 n 张「龙玉」——任一区域已开放且自己一侧放得下（occ 口径）就会变化；三区都放不下/未开放则本次揭示落空
      const sp = def.spawnMine;
      const tk = sp && TOKENS[sp.card];
      if (!tk) return false;
      const cnt = sp.n || 1;
      for (let j = 0; j < 3; j++) {
        if (locOpen(j) && Math.min(cnt, sideRoom(side, j)) > 0) return true;
      }
      return false;
    }
    case 'tkBuff': {
      // 两个子句任一成立才算会变化：① 可选落场生成（spawnS 口径，fill 写法再算上自身那格）；② 标记卡增幅：己方（own）/场上双方存在**已翻开**的该 tk 标记卡
      const spB = def.spawnS;
      const tkB = spB && TOKENS[spB.card];
      if (tkB) {
        const okB = spB.fill
          ? sideRoom(side, locIdx) + (def.spell ? 1 : 0) > 0
          : Math.min(spB.n || 1, sideRoom(side, locIdx)) > 0;
        if (okB) return true;
      }
      const tb = def.tkBuff;
      if (!tb || !tb.tk) return false;
      const sides = tb.own ? [side] : ['p', 'a'];
      return sides.some((s2) => state.players[s2].zones.some(
        (z) => z.some((c) => c.revealed && !c.def.un && !c.def.spell && c.def.tk === tb.tk)
      ));
    }
    case 'clone': {
      const sp = def.clone;
      const tk = sp && TOKENS[sp.card];
      if (!tk) return false;
      const cnt = sp.n || 1;
      for (let j = 0; j < 3; j++) {
        if (j === locIdx || !locOpen(j)) continue;
        const room = Math.min(cnt, sideRoom(side, j));
        if (room > 0) return true;
      }
      return false;
    }
    case 'gather': {
      // 集结：任一区域“自己一侧还放得下且已开放”就会真的生成卡；否则退一步看自己一侧场上是否已有已翻开的该阵营卡牌（那一步强化仍会造成变化）
      const gw = def.gather;
      if (!gw || !gw.group) return false;
      for (let j = 0; j < 3; j++) {
        if (locOpen(j) && sideRoom(side, j) >= 1) return true;
      }
      return st.players[side].zones.some((z) => z.some((c) => c.revealed && !c.def.un && !c.def.spell && c.def.g === gw.group));
    }
    case 'switch':
      return sideRoom(other, locIdx) >= 1;
    case 'morph':
      // 变身：对方手牌里存在可作目标的卡（随机选）才会变化；法术不作目标（变身后会立刻消散，语义混乱）。
      return st.players[other].hand.some((c) => c && c.def && !c.def.spell);
    case 'gift': {
      if (sideRoom(other, locIdx) < 1) return false;
      return st.players[side].zones[locIdx].some((c) => c !== card && c.revealed && !c.def.un && !c.def.spell);
    }
    case 'give': return st.players[side].hand.length < 7;
    case 'shuffleIn': {
      // 条目合法且张数 > 0 时**一定**会产生变化（牌库张数与抽牌顺序都会变）→ 照常走停顿与演出；键名写错时不空等。
      const si = def.shuffleIn;
      return !!si && !!findCardDefByKey(si.card) && (si.n || 1) > 0;
    }
    case 'reviveDiscard': {
      // 只要**弃牌池里存在至少一张能落地的角色卡牌**就真会产生变化（能落地＝有已开放且自己该侧放得下的区域）；池空 / 只有法术 / 三区都满或未开放 → 本次揭示落空
      const rp = pileOf(side, 'discard');
      return rp.some((c) => {
        if (!c || !c.def || c.def.spell) return false; // 只复活角色卡牌（法术不参与）
        for (let j = 0; j < 3; j++) {
          if (locOpen(j) && sideRoom(side, j) >= occOf(c)) return true;
        }
        return false;
      });
    }
    case 'discard': {
      // 只有目标方手牌里**真的存在**符合 `card`/`cost` 筛选的候选时才会产生变化；可选子句 `give` 只在弃牌成功时才结算（候选为 0 时两者一起落空）
      const dc = def.discard;
      if (!dc) return false;
      const toOpp = dc.to === 'opp' || dc.to === 'a' || dc.to === 'enemy';
      return discardCandidates(toOpp ? other : side, dc).length > 0;
    }
    case 'xform': {
      const t = findLocDef(def.xf);
      if (!t) return false;
      return !(['p', 'a'].some((s) => sideUsed(s, locIdx) > t.max));
    }
    case 'xformR': {
      // 区域随机变形——只要本列**未破碎**、且地形池里还有“除本列当前地形以外”的候选，这次揭示就一定会改盘面（换地形 + 结算「出现时」效果），故照常走 400ms 停顿与翻牌演出
      if (locShattered(locIdx)) return false;
      return randomLocCandidates(locIdx).length > 0;
    }
    case 'oc': {
      const present = movesForSide(other).some((m) => m.loc === locIdx);
      return present;
    }
    case 'costUp': {
      // 对方手牌里存在“还能再涨费”的卡（现 `cardCost < 6`）才算会真的变化；手上全是 6 费或手牌为空 → 跳过停顿。
      const up = def.a || 1;
      return st.players[other].hand.some((c) => c && c.def && !c.def.un && cardCost(c) + up <= 6);
    }
    case 'energyNext':
      // 总是真的会造成变化（下回合能量 +N；末回合时仍按“会触发”处理并记日志）
      return true;
    case 'shift': {
      const roomR = sideRoom(side, 2);
      if (roomR < 1) return false;
      return st.players[side].zones[0].some((c) => c.revealed && !c.def.un && roomR >= occOf(c));
    }
    case 'roam': {
      // 自身能否移到另一个区域——任一其它区域已开放且该侧放得下（occ 口径）
      const owner = card.side || side;
      for (let j = 0; j < 3; j++) {
        if (j === locIdx || !locOpen(j)) continue;
        if (sideRoom(owner, j) >= occOf(card)) return true;
      }
      return false;
    }
    case 'drawSpell': {
      // 抽法术入手牌——池非空且手牌未满才会变化。本键只作 fx 时机效果（回合开始）用，不经过翻牌流程，故只按卡级 spellPool 兜底（fx 条目里的 pool 不在此处读取）
      const keys = Array.isArray(def.spellPool) ? def.spellPool : [];
      return keys.length > 0 && st.players[side].hand.length < 7;
    }
    case 'retrigger': {
      // 本区存在**可再触发的己方已翻开卡牌**（带 k、排除自己 / 法术 / un / 同为 retrigger 的卡）才真的会产生变化。
      return retriggerTargets(side, locIdx, card).length > 0;
    }
    default: return false;
  }
}

// ---- 战力影响历史 ----（记录点在 applyEffect 的增减结算处）
// addBuffLog：登记一条“永久 buff”来源（d=增减，srcCard=来源卡；来源=目标自身时视为“卡牌效果”，如 bl/oc）；tag 可选（如「防摧毁」）。
function addBuffLog(card, d, srcCard, tag) {
  if (!card) return;
  if (!Array.isArray(card.powerLog)) card.powerLog = [];
  card.powerLog.push({ d, src: srcCard ? { id: srcCard.id, n: srcCard.def.n, t: srcCard.def.t } : null, tag: tag || null });
}

/* ---- 卡牌“永久 ±N 战力”的演出：applyPermBuff 是统一收口（改 buff + 记账 + 排队：正→绿 +N，负→红 -N）；
   演出由 renderZones 末尾的 flushBuffFlash 触发（1000ms，含末段约 300ms 渐隐），光环与气泡放 body 悬浮层，不随卡面重建中断。 */
let buffFlashQueue = [];
// 费用修正（如桑尼米尔克把对方手牌 +1 费）的演出队列——渲染后由 flushCostFlash 播“费用 ±N”气泡；目标在对方手牌（不可见）时落到侧栏对手信息区。
let costFlashQueue = [];
function applyPermBuff(card, d, srcCard, tag) {
  if (!card) return;
  // 法术没有战力——任何位置（手牌/场上揭示瞬间/回手）都不吃战力增减，因而不进 powerLog、不排 ±N 演出（地形 gamble/dice/grow/decay/rally 也走这里收口）
  if (isSpell(card)) return;
  // 区域「免减攻」（noDown，现仅「蓬莱药局」）：**负增量在生效前被拦下**——战力原封不动、不写 powerLog、不排 −N 演出；返回 false 供调用方调整汇总日志。
  if (d < 0 && cardNoDown(card)) {
    const j = fieldLocOf(card);
    log('sys', `💊 ${locDef(j).n}：「${card.def.n}」免于减攻 —— 本次 ${d} 战力被拦下（现 ${cardPowerIn(j, card)}）。`);
    return false;
  }
  card.buff += d;
  addBuffLog(card, d, srcCard, tag);
  if (d !== 0) {
    const hit = buffFlashQueue.find((q) => q.card === card);
    if (hit) hit.d += d;
    else buffFlashQueue.push({ card, d });
  }
  return true;
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
  pop.textContent = gain ? '+' + d : String(d);
  box.appendChild(pop);
  document.body.appendChild(box);
  setTimeout(() => {
    if (box.parentNode) box.parentNode.removeChild(box);
    el.classList.remove('buff-gain', 'buff-loss');
  }, 1080);
}

/* ==================== 法术（spell）的消散 —— 法术只带「能量消耗 + 揭示效果」，在**且仅在**揭示效果结算完之后自行消失
   （移出区域与放置顺序队列、腾出它占的那 1 个格位）。⚠️ 这不是“摧毁”：不走 phoenixRevive / surviveDestroy、不查 locNoDestroy、
   不播分崩离析、不进战力影响历史，也不返手/返牌库。入口两处：① revealRound 翻牌流程；② 落场衍生物法术（settleFieldSpell，同步、无停顿）。 */

// 落场生成的衍生物法术：先结算自身「揭示」（白板跳过），随后立即消散。两次 renderZones：① 先显形（否则刚落场就被移除、玩家什么都看不到）；② 消散后再渲染让格位空出来。
function settleFieldSpell(card, locIdx) {
  if (!isSpell(card)) return false;
  renderZones();
  if (card.def.k) applyEffect(card.side, locIdx, card);
  vanishSpell(card);
  renderZones();
  return true;
}

// 法术消散：移出区域与放置队列、腾出格位、播消散演出并记日志；返回 true 表示确实消散了（调用方随后应重渲染让格位空出来）。
function vanishSpell(card) {
  if (!isSpell(card)) return false;
  const locIdx = fieldLocOf(card);
  if (locIdx < 0) return false;
  const locName = locDef(locIdx).n;
  const zone = state.players[card.side].zones[locIdx];
  const i = zone.indexOf(card);
  if (i >= 0) zone.splice(i, 1);
  dequeueField(card); // 离开场上：后续时机效果（fx）不再结算它
  recordSpellExile(card, locName); // 用过的法术 → 牌本体进归属方的「放逐池」（不是被摧毁，不进摧毁池）
  playSpellVanish(card); // 消散演出（克隆卡面上浮淡出，放 body 悬浮层不受重渲染影响）
  log('sys', `🪄 ${card.side === 'p' ? '你' : '对手'}的法术「${card.def.n}」揭示结算完毕，自行消散：让出「${locName}」的 1 个格位（不属于被摧毁）。`);
  return true;
}

// 消散演出：卡面克隆轻微上浮 + 放大 + 提亮淡出，并迸发几颗星光；约 0.52s。复用「额外能量」的 .energy-star 粒子（追加 .spell-star 换成淡紫辉光）。
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

// 被摧毁时的“分崩离析”演出：把场上缩略卡切成 3×2 六块碎片，各自向外迸散、旋转并渐隐（1s）；悬浮层放 body 不随重建中断，真正的移除发生在调用之后。
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
      const dy = ((pcy - cy) / nLen) * dist + (Math.random() - 0.5) * 40 - 16;
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

// 换边演出：switch/gift 记下的待播在本次渲染后播（复用 flyCardTo 克隆飞行，真身已在对方侧渲染）；不阻塞，revealRound 随后的停顿/渲染自然接续。
function flushPendingSwitchFly() {
  if (!pendingSwitchFly) return;
  const f = pendingSwitchFly;
  pendingSwitchFly = null;
  if (f && f.srcRect) flyCardTo(f.card, f.srcRect);
}

// flush 自身移动（roam，如幽灵回合开始飘走）的飞行演出队列——调用点：roundStartStage 的 renderAll() 之后、revealRound 每张翻牌结算之后。
function flushPendingDriftFly() {
  if (!pendingDriftFly.length) return;
  const items = pendingDriftFly;
  pendingDriftFly = [];
  for (const f of items) {
    if (f && f.srcRect) flyCardTo(f.card, f.srcRect);
  }
}

// 区域免摧毁（地形字段 def.prot，如「睡鼠神祠」；卡级持续 def.prot，如「蕾蒂」）：本区域一旦免摧毁，该区域**双方**所有在场卡牌都无法
// 被摧毁（dw / dwh / 回合末 purge 等一律失效），被保护卡不离场、故 surv / phx 也不触发。卡级防护按源卡“当前所在区域”实时判定。
function locNoDestroy(locIdx) {
  if (locDef(locIdx).prot) return true; // 地形级免摧毁（如睡鼠神祠）——地形效果，不受失去文字影响
  for (const s of ['p', 'a']) {
    for (const c of state.players[s].zones[locIdx]) {
      if (!c.revealed || !c.def.prot) continue;
      // 失去卡牌文字（封印 ∪ 静海）——卡级 prot（蕾蒂）的文字也被抹除 ⇒ 不再提供区域免摧毁
      if (cardMuted(c)) { muteSkipLog(c, '「区域免摧毁」（prot）'); continue; }
      return true;
    }
  }
  return false;
}

/* ==================== 区域「免减攻」（地形字段 `noDown`，现仅「蓬莱药局」）====================
   本区域**所有卡牌**（双方、含暗牌与落场 token）无法被减少战力：负增量在生效前被拦下——战力原封不动、不写 `powerLog`、
   不播 −N 演出，只记一条 sys 日志。唯一收口 `applyPermBuff`（`d < 0` 且该卡此刻在带 `noDown` 的区域时返回 `false`）。
   ⚠️ 不追溯：只拦“结算那一刻人在本区域”的卡；卡自身的印刷负战力不算“被减攻”；实时负加成按 **0** 计；与 `surv` 叠加 ⇒ 不离场也不降攻。 */
function locNoDown(locIdx) {
  const L = state.locs[locIdx];
  return !!(L && L.def && L.def.noDown);
}
function cardNoDown(card) {
  if (!card) return false;
  const j = fieldLocOf(card);
  return j >= 0 && locNoDown(j);
}

/* ==================== 「失去卡牌文字」（地形字段 `mute`「静海」/ 卡牌效果键 `mute`「封印」）====================
   被抹除的卡**失去卡牌文字**：卡面写的效果一律视为不存在、**任何时机都不发动**。两个来源：
   ① 区域抹除（地形字段 `mute: true`，现仅「静海」）——**实时、零状态**：卡此刻在带 `mute` 的区域里就失去文字，
      静海被换掉或卡被移出本区（`mv`/`fly`/`shift`/`roam`/`gust`）即自动恢复，无需收尾代码；
   ② 卡级抹除（卡牌效果键 `mute`，游戏内叫**「封印」**）——**永久**：标记落在**卡实例**上（`card.muteP`，同 `card.buff` 的永久口径），
      整局有效——被摧毁后再复活、`phx` 回手再打出、换边、`morph` 变身、`shuffleIn` 洗回牌库全都保持，离开静海也**不**恢复。
   被抹除：`k`（含四个分步演出键）、`og`（只看源卡）、`fx`（错过的时机不补）、`surv`/`phx`/`prot`/`ind`、`fly`；法术揭示不发动但**照常消散**。
   不受影响：手牌 / 牌库 / 三池里的**同名**卡（封印除外，它认实例）、`costDown`/`gs`/`playReq`、印刷费用与威力、`occ` 占格与 `tk` 标记、
   区域类效果（`aff`/`cb`/`all`/`fill`/`inv`/`purge`/`gust`/`noDown`/`prot` 等）、摧毁候选与筛选口径（它只是“哑巴”，不是 `un`）。
   ⚠️ 不追溯：已结算的 `buff` / `powerLog` 不回滚，错过的时机效果不补结算；每张牌**首次**被拦截记一条日志（`card.muteNoted`）。
   守卫点（读下面两个判定、无一处写状态）：`applyEffect` 入口（覆盖揭示 / 时机 / morph / 集结 / 复活 / retrigger 等连锁路径）、
   `revealRound`、`resolveTimedEffects`、`revealEffectWillChange`、`cardAuraBonus` + `powerHistoryRows`、`locNoDestroy`、`isDestroyable` /
   `indestructibleBlock` / `surviveDestroy` / `phoenixRevive`、`uiMoveFly` / `tryMoveFlyTo`、`renderZones` 的 canFly、`showFieldCard`。
   判定分两个函数：**守卫**一律用 `cardMuted()`（区域 ∪ 卡级），**渲染与文案**的感叹号只认 `cardSealed()`（卡级永久）。 */
function locMuted(locIdx) {
  const L = state.locs[locIdx];
  return !!(L && L.def && L.def.mute);
}
/* 此刻是否失去卡牌文字 = 卡级永久标记（封印）∪ 在带 `mute` 的区域里（按 `fieldLocOf` 实时查）。守卫点统一走本函数。 */
function cardMuted(card) {
  if (!card || !card.def) return false;
  if (card.muteP) return true;
  const j = fieldLocOf(card);
  return j >= 0 && locMuted(j);
}
/* **「封印」**（卡级永久抹除）——只认实例标记、**不看**区域：手牌 / 牌库 / 三池里的卡不在场上、`cardMuted` 在那里恒为 false，
   而封印随卡整局有效、这些地方也要显示 ❗ 与置灰，故渲染与文案一律走本函数。 */
function cardSealed(card) {
  return !!(card && card.muteP);
}
/* **「含持续效果」**＝卡面标着「持续」的卡（与 `kindTags` 的三条「持续」标记同口径）：`og`（持续效果）/ 卡级 `prot`（持续 · 区域免摧毁）/
   卡级 `ind`（持续 · 自身不可摧毁）。⚠️ `fly`（每回合移动一次）/`surv`（防摧毁）/`phx`（凤凰重生）/`fx`（时机效果）/`costDown` 都**不算**。 */
function cardHasOngoing(card) {
  const d = card && card.def;
  return !!(d && (d.og || d.prot || d.ind));
}
// 时机名 → 日志里的可读说法（供 resolveTimedEffects / applyEffect 的拦截日志复用）
const FX_TIMING_TXT = { turnStart: '「回合开始」效果', turnEnd: '「回合结束」效果', gameEnd: '「游戏结束」效果' };
/* 失去文字导致的拦截日志：每张牌**首次**记一条（kindTxt 如「揭示效果」），返回 true = 本次确实记了日志。
   ⚠️ 一张牌同时满足两种来源时**只提示一次**，且优先报「封印」（不可逆的那个更该让玩家知道）。 */
function muteSkipLog(card, kindTxt) {
  if (!card || !card.def || card.muteNoted) return false;
  card.muteNoted = true;
  if (card.muteP) {
    log('sys', `☯️ 「${card.def.n}」已被「封印」——永久失去卡牌文字 → ${kindTxt}不发动（本局首次提示；回手、复活、换边、变身、离开静海都不会恢复）。`);
    return true;
  }
  const j = fieldLocOf(card);
  const where = j >= 0 ? `「${locDef(j).n}」` : '场上';
  log('sys', `🌊 「${card.def.n}」在${where}失去了卡牌文字 → ${kindTxt}不发动（本局首次提示；该牌离开静海后文本会恢复）。`);
  return true;
}
/* 放大视图的「失去文字」提示条（区分两个来源；返回 '' = 没失去文字）。`locIdx` 传该牌当前所在区域，手牌 / 牌池传 -1。 */
function muteNoteHTML(card, locIdx) {
  if (cardSealed(card)) {
    return '<div class="zm-kind mute-note seal-note">☯️ 此牌已被「封印」：永久失去卡牌文字 —— 揭示 / 持续 / 时机 / 防护效果一律不发动（战力照常计入；回手、复活、换边、变身都不会恢复）</div>';
  }
  if (locIdx >= 0 && locMuted(locIdx)) {
    return `<div class="zm-kind mute-note">🌊 文本已被「${locDef(locIdx).n}」抹除：此牌的揭示 / 持续 / 时机 / 防护效果一律不发动（战力照常计入；离开静海后文本恢复）</div>`;
  }
  return '';
}

/* ==================== 区域「封锁揭示」（地形字段 `noReveal`，现仅「法界」）====================
   本区域双方所有卡牌的**揭示不发动**（翻开那一刻在本区的牌：揭示视为没写、不产生任何变化）。
   实时、零状态（同静海 `mute` 的读法）：卡此刻在带 `noReveal` 的区域里就被封锁，法界被换掉
   （`xform`/`collapse`/`xformTurn`/开发者「🗻 指定地形」）或卡被移出本区（`mv`/`fly`/`shift`/`roam`/`gust`）即不再被拦，无需收尾代码。
   **只拦揭示**：持续 `og`、时机 `fx`、防护（`surv`/`phx`/`prot`/`ind`）、`fly`、`costDown`/`gs`/`playReq`、
   印刷费用与威力、`occ` 占格与 `tk` 标记、全部地形类效果（`gamble`/`gust`/`purge`/`grow`/`decay` 等）、
   摧毁候选与筛选口径都照常；法术揭示不发动但**照常消散**（消散不是卡面文字）。
   ⚠️ 不追溯、不补结算（同 `dice`/`rally` 的“错过的时机不补”）：被拦下的**那一次**揭示不会在卡离开法界后补发动，
   “恢复”只指**此后**的揭示——被 `retrigger`（东风谷早苗）再触发、`morph` 变身、复活/回手再打出、守矢神社重复揭示时照常发动；
   每张牌**首次**被拦截记一条日志（`card.nrNoted` 防刷屏）。
   守卫点（读下面两个判定、无一处写状态）：① `applyEffect` 入口的**揭示分支**（`spec` 缺省；覆盖 `morph` 重触发 / 落场法术
   `settleFieldSpell` / `spawn.reveal` / 复活 / 同步版 `retrigger`；`fx` 时机效果走 `spec`、**不**受影响）；
   ② `resolveRevealInZone`（翻牌主路径 + 守矢神社重复的第 2 次 + `retriggerOneStaged` 的每一条揭示，四个分步演出键也走这里；
   它内部的重复分支另有一道**实时**判定：卡被自己的揭示挪进法界后，那第 2 次重复同样不发动）；
   ③ `revealEffectWillChange`（被封锁 → 返回 false，不空等结算前的 400ms 停顿）；④ 显示层（放大视图提示条，见 `revealBlockNoteHTML`）。 */
function locNoReveal(locIdx) {
  const L = state.locs[locIdx];
  return !!(L && L.def && L.def.noReveal);
}
/* 此刻的「揭示」是否被区域封锁（按 `fieldLocOf` 实时查；手牌 / 牌库 / 三池里的卡不在场上 ⇒ 恒为 false）。守卫点统一走本函数。 */
function revealBlocked(card) {
  if (!card || !card.def) return false;
  const j = fieldLocOf(card);
  return j >= 0 && locNoReveal(j);
}
/* 封锁揭示导致的拦截日志：每张牌**首次**记一条，返回 true = 本次确实记了日志。 */
function revealSkipLog(card) {
  if (!card || !card.def || card.nrNoted) return false;
  card.nrNoted = true;
  const j = fieldLocOf(card);
  const where = j >= 0 ? `「${locDef(j).n}」` : '场上';
  log('sys', `🌑 「${card.def.n}」在${where}无法触发揭示 → 本次揭示效果不发动（本局首次提示；被拦下的这一次不补结算，离开法界后此后的揭示照常发动）。`);
  return true;
}
/* 放大视图的「揭示被封锁」提示条（返回 '' = 没被封锁）。`locIdx` 传该牌当前所在区域，手牌 / 牌池传 -1。 */
function revealBlockNoteHTML(card, locIdx) {
  if (!card || locIdx < 0 || !locNoReveal(locIdx)) return '';
  if (cardSealed(card) || locMuted(locIdx)) return ''; // 整张文本已被抹除（封印 / 静海）⇒ 已有覆盖面更广的提示条
  return `<div class="zm-kind noreveal-note">🌑 揭示已被「${locDef(locIdx).n}」封锁：此牌的揭示效果不发动（战力照常计入；持续 / 时机 / 防护效果照常；离开法界后此后的揭示照常发动）</div>`;
}
/* 纯揭示牌（只有揭示、没有持续 / 时机 / 防护 / 移动等其它卡面效果）：法界里它的整条卡面文字都不生效，可整体置灰划线。 */
function revealOnlyCard(def) {
  return !!(def && def.k && !def.og && !def.fx && !def.surv && !def.phx && !def.prot && !def.ind && !def.fly);
}

/* ---- 自身不可摧毁（def.ind，现仅「佛体金刚石」）----
   判定式免疫，不是“跳过”：带 ind 的卡照常参与摧毁判定（dw 最弱 / dwh 最强 / dwb 双方最弱随机 / purge 最低），一旦判定落在它身上 →
   ①摧毁失败（不离场、战力不变，也不触发 surv/phx）；②**本次判定就此结束，不会改打其他牌**。⚠️ 与“剔出候选池、改杀下一张”是两种口径，
   后者等于白送一次摧毁指向，本卡不采用。与 `prot`（保护本区双方、判定前整条拦掉）的区别：ind 只保护自己；唯一收口 `indestructibleBlock`。 */
function isDestroyable(card) {
  if (!card || !card.revealed || card.def.un || card.def.spell) return false;
  // 失去卡牌文字（封印 ∪ 静海）——被抹除的 `ind` 不再免疫摧毁；本函数只作预判、不记日志
  return !(card.def.ind && !cardMuted(card));
}

/* 摧毁判定落在 ind 卡上时的统一处理：记一条日志并返回 true，调用方据此**结束本次摧毁判定**（不离场、不改打其他卡、不触发 surv/phx）；返回 false 按原逻辑继续。 */
function indestructibleBlock(card, srcName) {
  if (!card || !card.def || !card.def.ind) return false;
  // 失去文字 ⇒ `ind` 已被抹除：不拦、照常摧毁（“判定结束、不改打别的”不再适用）
  if (cardMuted(card)) { muteSkipLog(card, '「自身不可摧毁」（ind）'); return false; }
  log('sys', `✦ ${srcName} 的摧毁判定落在「${card.def.n}」上，但它自身不可摧毁（无法被摧毁）→ 本次摧毁失败、判定结束（不改打其他牌）。`);
  return true;
}

// 防摧毁（def.surv=N，现仅灵乌路空）：被任何“摧毁”指向时不会离场，取而代之**永久降低 N 点战力**（每次触发再降 N、可多次）。返回 true = 已替代；false = 按原样移除摧毁。
function surviveDestroy(card) {
  const surv = card && card.def && card.def.surv;
  if (!surv) return false;
  // 失去文字 ⇒「防摧毁」一并失效：该卡照常被摧毁（不降战力、不离场替代）
  if (cardMuted(card)) { muteSkipLog(card, '「防摧毁」（surv）'); return false; }
  // 区域「免减攻」（蓬莱药局）——替代降攻被拦下 ⇒ **不离场、也不降攻**（两个防护叠加）
  const j0 = fieldLocOf(card);
  if (j0 >= 0 && locNoDown(j0)) {
    log('danger', `💥 「${card.def.n}」被摧毁时触发了防摧毁：没有被摧毁；且本区域「${locDef(j0).n}」免减攻，替代的 −${surv} 战力也被一并拦下（战力不变，现 ${cardPowerIn(j0, card)}）。`);
    return true;
  }
  applyPermBuff(card, -surv, null, '防摧毁'); // 永久 -N（红色 -N 演出）
  const locIdx = fieldLocOf(card);
  log('danger', `💥 「${card.def.n}」被摧毁时触发了防摧毁：没有被摧毁，取而代之永久降低 ${surv} 点战力（现 ${locIdx >= 0 ? cardPowerIn(locIdx, card) : cardPower(card)}）。`);
  return true;
}

// 凤凰重生（def.phx=N，现仅藤原妹红）：被任何“摧毁”指向时**不消失**，而是从场上移除后**返回自己手牌**并**永久 +N 战力**（可重复打出并再次触发）；
// 手牌已满 7 张则重生失败、按原样被摧毁。返回 true = 本函数已处理完（调用方不得再移除该卡）。
function phoenixRevive(card, locIdx) {
  const phx = card && card.def && card.def.phx;
  if (!phx) return false;
  // 失去文字 ⇒「凤凰重生」一并失效：该卡照常被摧毁（不回手、不 +N）
  if (cardMuted(card)) { muteSkipLog(card, '「凤凰重生」（phx）'); return false; }
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

/* ---- shift（整体右移）的分步实现：peekShiftCard / shiftMoveCard / shiftMoveOne（peek + move，同步路径）；applyShiftReveal 为揭示演出版——
   逐张搬，每张先“滑行 + 缩放”飞过去（约 0.26s），卡片间隔保持约 0.3s；无动画能力时退化为纯停顿。 */
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
    if (gen !== state.gen) return;
    const card = peekShiftCard(side);
    if (!card) break;
    const srcEl = miniCardElById(card.id);
    const srcRect = srcEl ? srcEl.getBoundingClientRect() : null;
    shiftMoveCard(side, card);
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

/* 集结的**分步揭示演出**（只在正常翻牌流程 revealRound 里使用）：按区域顺序逐区推进（第1区 → 第2区 → 第3区，
   每区之间停 0.5s）；三区全部揭示完之后才做“己方场上已翻开的三妖精各 +add”，随后才由 revealRound
   播这张法术的消散演出。口径同同步版（applyEffect 的 case 'gather'），只多出节奏与逐步渲染。 */
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
    if (gen !== state.gen) return;
    const who = state.locs[j].def.n;
    const made = [];
    const r = gatherSpawnAt(side, j, picked[j], made);
    if (!r.ok) {
      log(side, `✦ ${card.def.n}：第 ${j + 1} 区「${who}」跳过生成（${r.why}）。`);
    } else {
      renderZones(); // 先让这张妖精显形（凝聚显形演出）
      log(side, `✦ ${card.def.n}：第 ${j + 1} 区「${who}」生成「${r.name}」，并结算其揭示。`);
      resolveSpawnedReveals(made);
      renderZones();
    }
    await sleep(500); // 三区之间间隔 0.5s（第 3 区之后这一停也留给它的揭示演出）
    if (gen !== state.gen) return;
  }
  const add = (gw && gw.add) || 0;
  if (add) {
    const n = applyGatherBuff(side, card, group, add);
    log(side, n
      ? `✦ ${card.def.n}：${side === 'p' ? '你' : '对手'}方场上已翻开的「${GROUPS[group] || group}」各 ${add > 0 ? '+' : '−'}${Math.abs(add)} 战力（影响 ${n} 张）。`
      : `✦ ${card.def.n}：己方场上没有已翻开的三妖精，这一步无人可强化。`);
    renderZones();
    await sleep(500); // 留给 +N 演出；随后 revealRound 才播这张法术的消散演出
    if (gen !== state.gen) return;
  }
}

/* ==================== 复活弃牌池（`reviveDiscard` 效果键，现仅 6 费「四季映姬」）====================
   分步演出 `applyReviveDiscardReveal` 逐张「捞出 → 渲染 → 结算它自己的揭示 → 停 500ms」（避免一次性复活
   一大把造成连锁揭示叠加、演出互相盖住）；非翻牌路径走同步版 case 'reviveDiscard'，两条路径共用下面三个收口。 */

/** 该牌**能落到哪些区**＝已开放（`locOpen`，避开七夕坂等 minTurn 锁定）且该侧放得下（`sideRoom ≥ occOf`，含大体积占格）→ 下标数组（可能为空）。 */
function reviveTargetZones(side, card) {
  const out = [];
  for (let j = 0; j < 3; j++) {
    if (!locOpen(j)) continue;
    if (sideRoom(side, j) < occOf(card)) continue;
    out.push(j);
  }
  return out;
}

/** 把牌从弃牌池**捞回场上**（共用核心，只做数据层）：候选区等概率随机取一处（空 → -1）、离池清入池元数据、
    落地即 `revealed` + `justSpawned`（凝聚显形）、占格入队（`fieldTurn`＝本回合 ⇒ 当回合不结算其 `fx.turnStart`）。
    ⚠️ **不负责**结算揭示与渲染/节奏——由调用方（同步版 / 分步版）各自处理。 */
function reviveCardFromPile(side, card, pile) {
  const targets = reviveTargetZones(side, card);
  if (!targets.length) return -1;
  const i = pile.indexOf(card);
  if (i < 0) return -1; // 防御：已被连锁复活走
  const dst = targets.length === 1 ? targets[0] : targets[Math.floor(Math.random() * targets.length)];
  pile.splice(i, 1); // 离池（牌本体带走自己的一切：powerLog / costMod）
  delete card.pileKind; delete card.pileTurn; delete card.pileBy; delete card.pileLoc; delete card.pilePower;
  card.side = side;
  card.revealed = true;
  card.justSpawned = true;
  state.players[side].zones[dst].push(card);
  enqueueField(card);
  return dst;
}

/** `reviveDiscard` 的收尾日志（法术不参与 / 留在池里的牌 / 本次汇总），同步版与分步版共用以免措辞不一致。 */
function reviveStuckLog(side, card, revived, stuck, spellN, poolLeft) {
  const who = side === 'p' ? '你' : '对手';
  log(side, revived.length
    ? `✦ ${card.def.n}：本次共复活 ${revived.length} 张角色卡牌（${who}的弃牌池现 ${poolLeft} 张）。`
    : `✦ ${card.def.n}：本次没有任何卡牌成功复活（三个区域都放不下或未开放）。`);
  if (spellN) log('sys', `✦ ${card.def.n}：${spellN} 张法术不参与复活，仍留在${who}的弃牌池里。`);
  if (stuck.length) log('sys', `✦ ${card.def.n}：「${stuck.join('」「')}」因三个区域都放不下或未开放，本次未能复活（留在${who}的弃牌池）。`);
}

/* 复活弃牌池的**分步揭示演出**（只在翻牌流程 revealRound 里用）：逐张「复活（渲染 → 凝聚显形）→ 按它**当前
   所在区域**结算其揭示 → 停 0.5s」，全部复活完再收尾；`state.gen` 变化即中断。
   ⚠️ 池里还有**另一张四季映姬**时，她复活会在结算链内部**同步**再触发一次本效果（那批一次性复活）；
   已被连锁复活走的条目由 `pile.indexOf(c) < 0` 跳过。 */
const REVIVE_STEP_MS = 500; // 相邻两张之间的间隔（纯 JS 计时、无 CSS 关键帧——改节奏只改这一个数）
async function applyReviveDiscardReveal(side, card) {
  const gen = state.gen;
  const st = state;
  const who = side === 'p' ? '你' : '对手';
  const pile = pileOf(side, 'discard');
  const all = pile.slice();
  if (!all.length) {
    log(side, `✦ ${card.def.n}：${who}的弃牌池是空的，没有可复活的角色卡牌。`);
    return;
  }
  const cands = all.filter((c) => c && c.def && !c.def.spell);
  const spellN = all.length - cands.length;
  if (!cands.length) {
    log(side, `✦ ${card.def.n}：${who}的弃牌池里只有 ${spellN} 张法术（法术不参与复活），本次无事发生。`);
    return;
  }
  const order = shuffle(cands.slice());
  const revived = [];
  const stuck = [];
  for (const c of order) {
    if (gen !== state.gen) return;
    if (pile.indexOf(c) < 0) continue;
    const dst = reviveCardFromPile(side, c, pile);
    if (dst < 0) { stuck.push(c.def.n); continue; }
    revived.push({ card: c, loc: dst });
    renderZones(); // 先显形（.spawned-now → 凝聚显形）
    log(side, `✦ ${card.def.n}：「${c.def.n}」从${who}的弃牌池复活到「${st.locs[dst].def.n}」（落地即翻开，第 ${revived.length} 张；随后结算其揭示）。`);
    const nowLoc = fieldLocOf(c);
    if (c.def.k && nowLoc >= 0) applyEffect(side, nowLoc, c);
    renderZones(); // 让本次揭示的 ±N / 生成 / 摧毁等演出显示出来
    await sleep(REVIVE_STEP_MS); // 停 0.5s 再复活下一张
    if (gen !== state.gen) return;
  }
  reviveStuckLog(side, card, revived, stuck, spellN, pile.length);
  renderZones();
}

/* ==================== 揭示再触发（`retrigger` 效果键，现仅 5 费「东风谷早苗」）====================
   把**此牌所在区域里、自己一侧「已翻开」**的卡的「揭示」各再结算一次（收口 `retriggerTargets`）：排除自己 /
   法术 / `un` 占位卡 / **同为 `retrigger` 的卡**（末项防死循环，口径同 `morph`，链条必然收敛）。
   只重跑**揭示键**：**不触发** `fx` 时机效果 / 持续 `og` / `surv`·`phx`·`prot`·`ind`·`fly` 等非揭示机制，
   地形写的 `gamble` / `gust` 也不重跑（那不是卡面文字）；只作用于**结算那一刻已翻开**的卡（同 bf/de/ba 口径，
   暗牌错过且不补）。顺序＝本区 zone 数组顺序，每张结算**前**用 `fieldLocOf` 重读当前区域（被前一张挪走也照常
   触发一次、按新区域结算；已离场则跳过并记日志）。失去文字由 `applyEffect` 入口守卫拦下；
   登记点三处：`applyEffect` 的 case 'retrigger'、`revealEffectWillChange` 的 retrigger 分支、
   `revealRound` 的分步演出分支（与 shift/gather/reviveDiscard 并列）。 */

/** 本区**可被再触发揭示**的己方卡牌（候选收口，同步版与分步版共用）：本区自己一侧 + 已翻开 + 带 `k`，
    排除自己 / 法术 / `un` 占位卡 / 同为 `retrigger` 的卡；返回**快照数组**（结算中盘面会变）。 */
function retriggerTargets(side, locIdx, card) {
  const zone = state.players[side].zones[locIdx];
  if (!zone) return [];
  return zone.filter((c) => c && c !== card && c.revealed && c.def
    && !c.def.un && !c.def.spell && !!c.def.k && c.def.k !== 'retrigger');
}

/** 重触发**单张**卡的揭示（**同步版**，只供 `applyEffect` 的 case 'retrigger' 这条**无法 await** 的非翻牌路径）：
    按它**当前所在区域**（`fieldLocOf` 实时读）结算；已不在场上（被摧毁 / 回手 / 换边离场）则记一条日志并返回 false。
    ⚠️ 失去文字由 `applyEffect` 入口守卫处理，本函数不重复判定（避免多记日志）。 */
function retriggerOne(card) {
  const j = fieldLocOf(card);
  if (j < 0) {
    log('sys', `✦ 「${card.def.n}」此刻已不在场上（被摧毁或回到了手牌），本次不再触发它的揭示。`);
    return false;
  }
  applyEffect(card.side, j, card);
  return true;
}

/** 重触发**单张**卡的揭示（**分步版**，供 `applyRetriggerReveal` 用）：与 `retriggerOne` 只差改走 `resolveRevealInZone`
    ⇒ ① 被再触发的牌若是 shift/gather/reviveDiscard/retrigger，会保留它自己的分步间隔；② 这次再触发也发生在早苗
    所在区域，该区带 `repeatReveal`（守矢神社）则**也执行两次**；资格实时读该牌当前所在区域。 */
async function retriggerOneStaged(card) {
  const j = fieldLocOf(card);
  if (j < 0) {
    log('sys', `✦ 「${card.def.n}」此刻已不在场上（被摧毁或回到了手牌），本次不再触发它的揭示。`);
    return false;
  }
  await resolveRevealInZone(card.side, j, card); // forceRepeat 省略 ⇒ 实时读该区 repeatReveal
  return true;
}

/* ==================== 东风谷早苗「揭示再触发」的可见演出（每次其揭示开始结算各来一遍）====================
   ① 本体两圈光环 `playRetriggerAura`（≈760ms）；② 每张被再触发的目标卡各闪一下 `playRetriggerHit`（420ms，
   短于相邻两张的 500ms ⇒ 不糊在一起）。光环/闪光都挂 **body 悬浮层**：卡面本体 `overflow: hidden`、翻面
   `.played-now`（flipIn）同样动 `transform`/`box-shadow`，挂卡面上会被裁掉/打架（口径同 v80 `.gain-ring`）。
   **排队-播出**：`case 'retrigger'` 先 `queueRetriggerFx` 入队（结算**之前**），真正播放在 `renderZones()` 末尾的
   `flushRetriggerFx()` ⇒ **不依赖 DOM 是否已渲染**；纯观感，不改盘面、不进日志。
   ⚠️ 取元素用 id **全局**匹配（同一实例可能因 `morph`/`shift` 出现在别处）。 */
// 节奏常量（时长以 JS 为准；style.css 的 .retrigger-ring / .retrigger-hit-ring 关键帧按同值写死——改快慢要两处一起改）
const RETRIGGER_AURA_MS = 760;
const RETRIGGER_HIT_MS = 420;  // 目标卡闪光时长（短于相邻两张的 500ms ⇒ 不会糊在一起）
let retriggerFxQueue = [];

/** 早苗**本体光环**：卡面本体做一次只动 `filter` 的提亮脉冲（避开 `transform`/`box-shadow` 关键帧冲突），
    两圈光环放 **body 悬浮层**（`position:fixed` 按 rect 定位）⇒ 不被 `overflow: hidden` 裁掉、不被 flipIn 盖掉。 */
function playRetriggerAura(card) {
  const els = miniCardElsById(card && card.id);
  if (!els.length) return false;
  const el = els[0];
  if (typeof el.animate === 'function') {
    try {
      el.animate([
        { filter: 'brightness(1) saturate(1)' },
        { filter: 'brightness(1.55) saturate(1.4)', offset: .2 },
        { filter: 'brightness(1)', offset: 1 },
      ], { duration: RETRIGGER_AURA_MS, easing: 'ease-out' });
    } catch (e) {  }
  }
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return true;
  for (const layer of [{ grow: 14, alpha: .95 }, { grow: 26, alpha: .5 }]) {
    const ring = document.createElement('div');
    ring.className = 'retrigger-ring';
    ring.style.cssText =
      `position:fixed;left:${r.left}px;top:${r.top}px;` +
      `width:${r.width}px;height:${r.height}px;border-radius:10px;` +
      `z-index:9450;pointer-events:none;` +
      `--rr-grow:${layer.grow}px;--rr-alpha:${layer.alpha};`;
    document.body.appendChild(ring);
    setTimeout(() => { if (ring.parentNode) ring.parentNode.removeChild(ring); }, RETRIGGER_AURA_MS + 60);
  }
  return true;
}

/** **被再触发的每一张目标卡**各闪一下（金白闪光，`RETRIGGER_HIT_MS` = 420ms）：金环放 body 悬浮层
    （不设 `.gain-ring`，避免与 v80 绿环样式冲突），卡面本体再叠一次极短提亮；取不到元素即跳过。 */
function playRetriggerHit(card) {
  const els = miniCardElsById(card && card.id);
  if (!els.length) return false;
  const el = els[0];
  if (typeof el.animate === 'function') {
    try {
      el.animate([
        { filter: 'brightness(1) saturate(1)' },
        { filter: 'brightness(1.75) saturate(1.45)', offset: .3 },
        { filter: 'brightness(1) saturate(1)' },
      ], { duration: RETRIGGER_HIT_MS, easing: 'ease-out' });
    } catch (e) {  }
  }
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return true;
  const ring = document.createElement('div');
  ring.className = 'retrigger-hit-ring';
  ring.style.cssText =
    `position:fixed;left:${r.left}px;top:${r.top}px;` +
    `width:${r.width}px;height:${r.height}px;border-radius:10px;` +
    `z-index:9440;pointer-events:none;`;
  document.body.appendChild(ring);
  setTimeout(() => { if (ring.parentNode) ring.parentNode.removeChild(ring); }, RETRIGGER_HIT_MS + 60);
  return true;
}

/** 把“本体光环 + 候选名单里每张卡各闪一下”排进渲染队列：由 `case 'retrigger'` 在**结算之前**调用，真正的播放
    在下一次 `renderZones()` 末尾。⚠️ **候选卡是“同一刻一起闪一下”**（不是在各自被再触发的 0.5s 时点各闪一次）
    ⇒ 每次揭示只有一组“光环 + 一轮闪光”，守矢神社里就是两组、更好数；只有**本区自己一侧**的候选会亮。 */
function queueRetriggerFx(side, locIdx, card) {
  const targets = retriggerTargets(side, locIdx, card);
  retriggerFxQueue.push({ kind: 'aura', card });
  for (const c of targets) retriggerFxQueue.push({ kind: 'hit', card: c });
}

/** 按卡牌 id 找**所有**当前渲染出的场上缩略卡元素（同一实例只会在场上出现一次；返回数组以容忍多张同 id 与 DOM 未渲染，取不到即空数组）。 */
function miniCardElsById(id) {
  if (id == null) return [];
  return Array.prototype.slice.call(
    document.querySelectorAll('.zone [data-cardid="' + id + '"]')
  );
}

/** `renderZones` 末尾统一播出（口径同 v80 `flushBuffFlash`）——纯演出，取不到元素（同刻被摧毁 / 被挪走 / 在对方
    手牌）即静默跳过，绝不因此改动盘面。⚠️ 已知问题：该演出在 `file://` 直接打开的环境里看不到效果，原因未定位。 */
function flushRetriggerFx() {
  if (!retriggerFxQueue.length) return;
  const items = retriggerFxQueue;
  retriggerFxQueue = [];
  for (const q of items) {
    if (q.kind === 'aura') playRetriggerAura(q.card);
    else playRetriggerHit(q.card);
  }
}

/* 揭示再触发的**分步揭示演出**（只在翻牌流程 revealRound 里用）：逐张「再触发 → 渲染 → 停 RETRIGGER_STEP_MS」，
   口径同同步版（共用 `retriggerTargets`）；纯 JS 计时、无 CSS 关键帧，`state.gen` 变化即中断。
   ⚠️ 每张走 `retriggerOneStaged` ⇒ 被再触发的牌若是 shift/gather/reviveDiscard 也保留它自己的分步间隔。 */
const RETRIGGER_STEP_MS = 500;
/** 早苗的「揭示再触发」**分步演出**（翻牌流程）：逐张结算、每张之后渲染并停 `RETRIGGER_STEP_MS`；开始前光环与闪光已由 `case 'retrigger'` 入队；守矢神社重复时本函数被调两次 ⇒ 光环与闪光各来一轮。 */
async function applyRetriggerReveal(side, card) {
  const gen = state.gen;
  const locIdx = fieldLocOf(card);
  if (locIdx < 0) return;
  const targets = retriggerTargets(side, locIdx, card);
  if (!targets.length) {
    log(side, `✦ ${card.def.n}：本区没有可再触发揭示的其他己方已翻开卡牌（不含自己、法术与同为该效果的卡），本次无事发生。`);
    return;
  }
  log(side, `✦ ${card.def.n}：${side === 'p' ? '你' : '对手'}在本区「${locDef(locIdx).n}」的 ${targets.length} 张己方卡牌，其「揭示」将各再触发一次（逐张结算，每张间隔 0.5s）—— ${targets.map((c) => `「${c.def.n}」`).join('')}`);
  for (const c of targets) {
    if (gen !== state.gen) return;
    await retriggerOneStaged(c); // 分步版：被再触发的牌若是 shift/gather/reviveDiscard 也保留其间隔
    renderZones(); // 让本次重触发的演出显示出来
    await sleep(RETRIGGER_STEP_MS);
    if (gen !== state.gen) return;
  }
}

/* ==================== 翻牌流程内的「揭示分派」收口（`resolveCardReveal`）====================
   **为什么需要它**：`shift` / `gather` / `reviveDiscard` / `retrigger` 在**翻牌流程**里走异步分步演出（各带自己的
   间隔），而 `applyEffect` 里的同名分支是**同步版**（供 morph / fx 时机效果 / 落场生成等**无法 await** 的路径复用）；
   任何“在翻牌流程里再次执行某张牌揭示”的新机制都必须走本函数，否则会静默退化成同步版、把间隔全部吞掉。
   调用方（全在可 await 的翻牌流程内）：`revealRound`（暗牌翻面后的首次揭示）、`resolveRevealInZone`（本区一次
   揭示结算，含守矢神社的“执行两次”）、`retriggerOneStaged`（早苗再触发）。
   ⚠️ 失去文字守卫由**调用方**负责（`applyEffect` 入口仍有兜底）；⚠️ 非翻牌路径**不要**调用本函数（无法 await）。 */
async function resolveCardReveal(side, locIdx, card) {
  const k = card.def.k;
  if (k === 'shift') { await applyShiftReveal(side, card.def.t); return; } // 八云紫：逐张 0.3s
  if (k === 'gather') { await applyGatherReveal(side, card); return; } // 三妖精集结：逐区 0.5s
  if (k === 'reviveDiscard') { await applyReviveDiscardReveal(side, card); return; } // 四季映姬：逐张 500ms
  if (k === 'retrigger') { await applyRetriggerReveal(side, card); return; } // 东风谷早苗：逐张 0.5s
  applyEffect(side, locIdx, card);
}

/* `spawnS`（本区**自己一侧**生成特殊卡）的共用实现——`spawnS` 键与 `tkBuff` 的可选落场生成子句共用同一口径。
   缺省生成 `spawnS.n` 张；`fill: true` **不写死张数**，按结算那刻该侧空余格数（sideRoom，occ 口径）铺满，且**施法
   的那张法术先消散**（让出它占的 1 格）——提前消散后 revealRound / settleFieldSpell 里那句 `vanishSpell(card)`
   会因“卡已不在场上”跳过，不会二次记日志/动画。返回 { cnt, placed, name, fill }；条目缺失/键名写错时返回 null。 */
function spawnSOwnSide(side, locIdx, card, fx) {
  const spcS = fx && fx.spawnS;
  const tkS = spcS && TOKENS[spcS.card];
  if (!spcS || !tkS) return null;
  let cntS = spcS.n || 1;
  if (spcS.fill) {
    if (isSpell(card) && fieldLocOf(card) === locIdx) vanishSpell(card);
    cntS = Math.max(0, sideRoom(side, locIdx));
  }
  const placedS = cntS > 0 ? placeToken(side, locIdx, tkS, cntS) : 0;
  return { cnt: cntS, placed: placedS, name: tkS.n, fill: !!spcS.fill };
}

function applyEffect(side, locIdx, card, spec) {
  const st = state;
  const other = side === 'p' ? 'a' : 'p';
  const mine = st.players[side].zones[locIdx];
  const theirs = st.players[other].zones[locIdx];
  const def = card.def;
  // 效果规格：spec 缺省＝整张卡的 def（揭示）；时机效果＝def.fx[timing] 条目（字段与 def 同构，结算逻辑复用）
  const fx = spec || def;
  const txt = fx.t || (fx === def ? def.t : def.n);
  // 失去卡牌文字（封印 ∪ 静海）：被抹除的卡其效果一律不发动。守卫放在**结算入口**，因此覆盖所有路径
  // （翻牌揭示含 morph 重触发、fx 时机效果、落场法术、集结/复活等连锁）；⚠️ 法术的“消散”不受影响。
  if (cardMuted(card)) {
    muteSkipLog(card, spec ? '时机效果' : '揭示效果');
    return;
  }
  // 区域「封锁揭示」（法界）：被封锁的卡其**揭示**不发动。`spec` 缺省＝揭示（含 morph 重触发 / 落场法术 / spawn.reveal / 复活 / 同步 retrigger）；
  // 时机效果（`spec` 有值）不是揭示 ⇒ 法界不管，照常结算。
  if (!spec && card.def.k && revealBlocked(card)) {
    revealSkipLog(card);
    return;
  }

  switch (fx.k) {
    case 'bf': {
      // 只作用于“结算时已翻开”的其他友军（暗牌不预领、后翻开的错过）；法术无战力且马上消散，不吃增减也不计入 N
      let n = 0;
      for (const c of mine) if (c !== card && !c.def.un && !c.def.spell && c.revealed) { applyPermBuff(c, fx.a, card); n++; }
      log(side, `✦ ${txt}${n ? `（影响 ${n} 张）` : '（但该区没有已翻开的其他友军）'}`);
      break;
    }
    case 'de': {
      // 只削弱“结算时已翻开”的对方卡牌；目标在「免减攻」区域（蓬莱药局）时该次 −N 被拦下、不计入 N
      let n = 0, blocked = 0;
      for (const c of theirs) {
        if (c.def.un || c.def.spell || !c.revealed) continue;
        if (applyPermBuff(c, -fx.a, card) === false) { blocked++; continue; }
        n++;
      }
      const partsDe = [];
      if (n) partsDe.push(`影响 ${n} 张`);
      if (blocked) partsDe.push(`${blocked} 张因本区「免减攻」被拦下（战力不变）`);
      log(side, `✦ ${txt}${partsDe.length ? `（${partsDe.join('；')}）` : '（但没有已翻开的对方卡牌可影响）'}`);
      break;
    }
    case 'deAll': {
      // 敌方全场削弱：**敌方三个区域**（左→中→右）里所有**已翻开**的卡各**永久 −N**。口径同 de，只有范围不同：
      // 排除 `un`/法术、含落场 token、**逐张 −N**（非随机分配）；走 applyPermBuff 收口 ⇒ 非“摧毁”，ind 只挡摧毁不挡增减。
      let nAll = 0;
      let blockedAll = 0;
      const hitAll = [];
      for (let j = 0; j < 3; j++) {
        for (const c of st.players[other].zones[j].slice()) {
          if (c.def.un || c.def.spell || !c.revealed) continue;
          if (applyPermBuff(c, -fx.a, card) === false) { blockedAll++; continue; }
          nAll++;
          hitAll.push(`第 ${j + 1} 区「${c.def.n}」`);
        }
      }
      const partsAll = [];
      if (nAll) partsAll.push(`影响 ${nAll} 张：${hitAll.join('、')}`);
      if (blockedAll) partsAll.push(`${blockedAll} 张因所在区域「免减攻」被拦下（战力不变）`);
      log(side, `✦ ${txt}${partsAll.length ? `（${partsAll.join('；')}）` : '（但对方场上没有已翻开的卡牌可影响）'}`);
      break;
    }
    case 'ba': {
      for (const c of mine) if (!c.def.un && !c.def.spell && c.revealed) applyPermBuff(c, fx.a, card);
      for (const c of theirs) if (!c.def.un && !c.def.spell && c.revealed) applyPermBuff(c, fx.a, card);
      log(side, `✦ ${txt}`);
      break;
    }
    case 'bl': {
      if (isSpell(card)) { log(side, `✦ 「${card.def.n}」是法术（没有战力），「落后自增」不生效。`); break; } // 法术无战力 ⇒ 不生效
      const myT = zoneEff(side, locIdx);
      const opT = zoneEff(other, locIdx);
      if (myT < opT) { applyPermBuff(card, fx.a, card); log(side, `✦ 落后触发：${def.n} 威力 +${fx.a}（现 ${cardPowerIn(locIdx, card)}）`); }
      else log(side, `✦ ${def.n} 未落后，效果不触发。`);
      break;
    }
    case 'dw': {
      if (theirs.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但该区空无一人。`); break; }
      if (locNoDestroy(locIdx)) { log(side, `✦ ${def.n} 想摧毁卡牌，但本区域存在免摧毁效果（地形「睡鼠神祠」或「蕾蒂」等），所有卡牌都无法被摧毁。`); break; }
      // 只能以“已翻开”的对方卡牌为目标：暗牌不可被提前摧毁；un 占位卡与法术也不可选（法术马上自行消散）。
      // ⚠️ ind 卡（佛体金刚石）**照常参与判定**——判定落在它身上＝摧毁失败、判定结束，不会改打下一张最弱的。
      const vis = theirs.filter((c) => c.revealed && !c.def.un && !c.def.spell);
      if (vis.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但对方在此区没有可摧毁的已翻开卡牌（暗牌与法术不算）。`); break; }
      let minP = Infinity, target = null;
      for (const c of vis) {
        const p = cardPowerIn(locIdx, c);
        if (p < minP) { minP = p; target = c; }
      }
      if (indestructibleBlock(target, def.n)) break; // ind → 摧毁失败、判定结束（不改打其他牌）
      if (phoenixRevive(target, locIdx)) break; // 凤凰重生（如藤原妹红）：回手 +N 战力
      if (surviveDestroy(target)) break; // 防摧毁（如灵乌路空）：替代为降战力、卡不离场
      recordDestroy(target, locIdx, def.n); // 真正离场 → 进归属方的摧毁池（⚠️ 须在移出区域之前记）
      playShatter(target);
      theirs.splice(theirs.indexOf(target), 1);
      dequeueField(target);
      log('danger', `✦ ${def.n} 摧毁了对方「${target.def.n}」（威力 ${minP}）`);
      break;
    }
    case 'dwb': {
      // 摧毁**本区双方**（敌我混比）已翻开卡牌里战力最低的**随机一张**（并列最低在其中随机挑；与地形「聚变反应炉」
      // purge 的“并列全删”不同）。候选同 dw/dwh（已翻开、排除 un/法术）；本区免摧毁时整条失效；目标带 phx/surv 按各自机制处理。
      // ⚠️ 双方混比 ⇒ **可能摧毁己方自己的卡**；ind 卡照常参与抽取，抽中它＝摧毁失败、判定结束（不再打并列的第二张）。
      const both = mine.concat(theirs).filter((c) => c.revealed && !c.def.un && !c.def.spell);
      if (both.length === 0) { log(side, `✦ ${def.n} 想摧毁卡牌，但本区域没有可摧毁的已翻开卡牌（暗牌与法术不算）。`); break; }
      if (locNoDestroy(locIdx)) { log(side, `✦ ${def.n} 想摧毁卡牌，但本区域存在免摧毁效果（地形「睡鼠神祠」或「蕾蒂」等），所有卡牌都无法被摧毁。`); break; }
      let minBoth = Infinity;
      for (const c of both) minBoth = Math.min(minBoth, cardPowerIn(locIdx, c));
      const lowPool = both.filter((c) => cardPowerIn(locIdx, c) === minBoth);
      const lowTarget = lowPool[Math.floor(Math.random() * lowPool.length)]; // 并列最低：随机挑一张
      const lowSide = lowTarget.side;
      const lowZone = st.players[lowSide].zones[locIdx];
      if (indestructibleBlock(lowTarget, def.n)) break;
      if (phoenixRevive(lowTarget, locIdx)) break;
      if (surviveDestroy(lowTarget)) break;
      recordDestroy(lowTarget, locIdx, def.n);
      playShatter(lowTarget);
      lowZone.splice(lowZone.indexOf(lowTarget), 1);
      dequeueField(lowTarget);
      log('danger', `✦ ${def.n} 摧毁了${lowSide === side ? '己方' : '对方'}「${lowTarget.def.n}」（威力 ${minBoth}${lowPool.length > 1 ? `；并列最低共 ${lowPool.length} 张，随机选中这一张` : ''}）`);
      break;
    }
    case 'dwc': {
      // 妖精大战争·法术：摧毁**双方场上**（三区、敌我两侧）所有**印刷费用 `def.c` 恰为 `dwc.cost`**（缺省 1）的**已翻开**卡牌。
      // ① 候选＝已翻开 + 非 `un` + **非法术**（暗牌不可提前摧毁）+ 含落场 token，按**印刷费用**筛选（不是 `cardCost`）。
      // ② **逐区（左→中→右）**：某区 `locNoDestroy` ⇒ **整区跳过**（不选目标、不触 surv/phx）；③ 每张依次 ind → phx → surv →
      // recordDestroy → 出区 → 出放置队列；⚠️ `ind` 与 purge 同款**逐张 continue**（不像 dw 那样“判定结束”）；④ 命中全部摧毁。
      const wantCost = (fx.dwc && fx.dwc.cost != null) ? fx.dwc.cost : 1;
      let goneAll = 0;
      const zoneSkipped = [];
      for (let j = 0; j < 3; j++) {
        const zP = st.players.p.zones[j];
        const zA = st.players.a.zones[j];
        const hitZ = zP.concat(zA).filter((c) => c.revealed && !c.def.un && !c.def.spell && c.def.c === wantCost);
        if (!hitZ.length) continue;
        if (locNoDestroy(j)) { zoneSkipped.push(locDef(j).n); continue; }
        const goneZ = [];
        for (const c of hitZ) {
          if (indestructibleBlock(c, def.n)) continue; // ind：这一张打不死，同区其它牌照常摧毁
          if (phoenixRevive(c, j)) continue;
          if (surviveDestroy(c)) continue;
          const owner = c.side; // 归属方（换边后按新归属）——进池与日志都用它
          recordDestroy(c, j, def.n);
          playShatter(c);
          const inP = zP.indexOf(c) >= 0;
          if (inP) zP.splice(zP.indexOf(c), 1);
          else zA.splice(zA.indexOf(c), 1);
          dequeueField(c);
          goneAll++;
          goneZ.push(`${owner === side ? '己方' : '对方'}「${c.def.n}」(${cardPowerIn(j, c)})`);
        }
        if (goneZ.length) {
          log('danger', `✦ ${def.n}：摧毁「${locDef(j).n}」双方场上所有 ${wantCost} 费卡牌 → ${goneZ.join('、')}`);
        }
      }
      if (!goneAll) {
        const why = zoneSkipped.length
          ? `（「${zoneSkipped.join('」「')}」存在免摧毁效果、整区跳过；其余区域没有符合条件的已翻开卡牌，或都被防护/替代机制拦下）`
          : '（双方场上没有符合条件的已翻开卡牌，或都被防护/替代机制拦下）';
        log(side, `✦ ${def.n} 想摧毁双方场上所有 ${wantCost} 费卡牌，但没有任何一张真正离场${why}。`);
      } else if (zoneSkipped.length) {
        log('sys', `✦ ${def.n}：本次共摧毁 ${goneAll} 张 ${wantCost} 费卡牌；「${zoneSkipped.join('」「')}」存在免摧毁效果（地形「睡鼠神祠」或「蕾蒂」等），该区整区跳过。`);
      }
      break;
    }
    case 'spawn': {
      // 揭示：本区域双方各生成特殊卡（如天子给双方各 1 张石块）
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
      // 在本区**自己一侧**生成特殊卡（对方一侧不动），与 spawn（双方各 n）/spawnO（只投对方）配对；落场走 placeToken（落地即
      // 翻开、占格、入队、播凝聚显形）；该侧放满则失败、不补别处。`fill: true`（填满该侧、法术先消散）统一收口在 spawnSOwnSide()。
      const r = spawnSOwnSide(side, locIdx, card, fx);
      if (r) {
        log(side, r.placed
          ? `✦ ${def.n}：在本区域自己一侧添加 ${r.placed} 张「${r.name}」${r.fill ? '，把这一侧的格位填满' : ''}`
          : `✦ ${def.n} 想把「${r.name}」放到自己一侧，但该侧已放满，未能落下。`);
      }
      break;
    }
    case 'spawnMine': {
      // 给**己方每个区域**（含此牌所在区域）自己一侧各生成 `spawnMine.n` 张特殊卡（现「龙玉」）。配位：`spawn` 本区
      // 双方各 n / `spawnO` 只投本区对方 / `spawnS` 只投本区自己 / `clone` 只投另两区 → 本键**三区都投**。
      // ① **逐区独立判定**：该侧已放满（`sideRoom < 1`；⚠️ 法术在揭示瞬间仍占本区 1 格 ⇒ 本区可能因此被跳过）或区域
      // 未开放 → **跳过该区、不补到别区**；② 落场走 placeToken，**不结算生成卡自身的揭示**（同 clone/spawnS）；
      // ③ 只产出自己一侧；④ 非摧毁类，与 surv/phx/prot/ind、区域字段无交互。
      const spM = fx.spawnMine;
      const tkM = spM && TOKENS[spM.card];
      if (spM && tkM) {
        const cntM = spM.n || 1;
        const doneM = [];
        const skipM = [];
        let placedM = 0;
        for (let j = 0; j < 3; j++) {
          const who = st.locs[j].def.n;
          if (!locOpen(j)) { skipM.push(`第 ${j + 1} 区「${who}」（未开放）`); continue; }
          const canPut = Math.min(cntM, sideRoom(side, j));
          if (canPut < 1) { skipM.push(`第 ${j + 1} 区「${who}」（该侧已放满）`); continue; }
          const got = placeToken(side, j, tkM, canPut);
          placedM += got;
          if (got > 0) doneM.push(`第 ${j + 1} 区「${who}」×${got}`);
          else skipM.push(`第 ${j + 1} 区「${who}」（该侧已放满）`);
        }
        log(side, placedM
          ? `✦ ${def.n}：${side === 'p' ? '你' : '对手'}方在 ${doneM.length} 个区域各添加「${tkM.n}」—— ${doneM.join('、')}${skipM.length ? `（跳过：${skipM.join('、')}）` : ''}`
          : `✦ ${def.n} 想为己方每个区域添加「${tkM.n}」，但三个区域都放不下或未开放，未能落下。`);
      }
      break;
    }
    case 'tkBuff': {
      // **标记卡增幅**：己方（`own: true`）或**全场双方**带 `tk` 标记的**已翻开**卡牌**永久 +N**（走 applyPermBuff 收口）；并
      // **可选**先按 `spawnS` 口径在本区自己一侧生成（生成在前 ⇒ **刚生成的这张也吃到本次 +1**）。只作用于结算那刻已翻开、
      // 排除 `un`/法术；⚠️ **一次性永久**，不是持续光环——与天子 `og: { tk:'rock', add:2 }`（在场期间实时 +2、离场失效）不同。
      const gen = spawnSOwnSide(side, locIdx, card, fx);
      if (gen) {
        log(side, gen.placed
          ? `✦ ${def.n}：在本区域自己一侧添加 ${gen.placed} 张「${gen.name}」`
          : `✦ ${def.n} 想把「${gen.name}」放到自己一侧，但该侧已放满，未能落下。`);
      }
      const tb = fx.tkBuff;
      if (!tb || !tb.tk) break;
      const add = tb.a || 0;
      // tk 标记没有中文名表：由 TOKENS 里带该标记的卡名反推可读标签（现 'rock' → 石块）；该反推收口在 tokenNameLabel()
      const tkLabel = tokenNameLabel(tb.tk);
      const sides = tb.own ? [side] : ['p', 'a'];
      const hit = [];
      for (const s2 of sides) {
        for (let j = 0; j < 3; j++) {
          for (const c of st.players[s2].zones[j].slice()) {
            if (!c.revealed || c.def.un || c.def.spell) continue;
            if (c.def.tk !== tb.tk) continue;
            applyPermBuff(c, add, card);
            hit.push(`${s2 === 'p' ? '你方' : '敌方'}「${c.def.n}」(${cardPowerIn(j, c)})`);
          }
        }
      }
      log(side, hit.length
        ? `✦ ${def.n}：${tb.own ? '己方' : '场上'}「${tkLabel}」共 ${hit.length} 张各 ${add > 0 ? '+' : '−'}${Math.abs(add)} 战力 → ${hit.join('、')}`
        : `✦ ${def.n}：${tb.own ? '己方' : '场上'}没有已翻开的「${tkLabel}」，这一步无事发生。`);
      break;
    }
    case 'clone': {
      // 揭示：向**另外两个区域**自己一侧各生成 n 张分身特殊卡（如赫卡提亚 → 分身）；目标区放满或未开放（locOpen）
      // 则跳过。分身按本卡**揭示时 cardPower**（基础 + 永久 buff）快照对齐战力：差值记在分身 buff 上，之后可被独立增减。
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
            c2.justSpawned = true;
            c2.buff += snap - c2.def.p;
            addBuffLog(c2, snap - c2.def.p, null, '分身快照');
            zone.push(c2);
            enqueueField(c2);
            added++;
      // 若生成的衍生物是「法术」，等同手打一张：先结算其揭示，随即消散
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
      // 集结（现仅法术「三妖精集结」）——**同步版**：一次性生成 + 结算揭示 + 强化。⚠️ 正常翻牌流程走分步演出版
      // `applyGatherReveal`（逐区揭示、每区 0.5s）；本同步版供 morph / fx 时机效果 / 落场生成等非翻牌路径复用。
      // ① 该阵营成员卡去重后**随机排列**，按左→中→右每区自己一侧各生成 1 张（三张互不相同），放满/未开放则跳过
      // 该区、不补别区，生成即翻开、占格、入队并**立即结算其揭示**；② 全部生成完后给己方已翻开的该阵营 +add。
      const gw = fx.gather;
      const group = gw && gw.group;
      const members = gatherMembers(group);
      if (!members.length) {
        log(side, `✦ ${txt}：卡池里没有可生成的成员（阵营「${GROUPS[group] || group || '?'}」），无事发生。`);
        break;
      }
      const picked = shuffle(members.slice()).slice(0, 3);
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
      resolveSpawnedReveals(made); // 生成的卡也结算自身「揭示」（按落场顺序）
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
      // 揭示：换边——翻开后从自己一侧转移到“对方该区域一侧”（依神紫苑）；对方该区已放满则失败、留在自己一侧。
      // 换边后归属对方（card.side 同步），此后作为对方已翻开卡参与结算；场上放置顺序不变。
      const dst = st.players[other].zones[locIdx];
      if (sideRoom(other, locIdx) < occOf(card)) {
        log('danger', `✦ ${def.n} 想换边到对方一侧，但对方该区已放满，换边失败（仍留在自己一侧）。`);
        break;
      }
      const src = st.players[side].zones[locIdx];
      const idx = src.indexOf(card);
      if (idx < 0) break;
      const swEl = miniCardElById(card.id);
      const swRect = swEl && swEl.isConnected ? swEl.getBoundingClientRect() : null;
      src.splice(idx, 1);
      dst.push(card);
      card.side = other;
      pendingSwitchFly = { card, srcRect: swRect }; // 记录换边前源格位，供效果渲染后播“滑行+缩放”演出
      log('danger', `✦ ${def.n} 换边：转移到了对方一侧（${def.p < 0 ? `以 ${-def.p} 负战力计入对方该区` : '该卡现在位于对方一侧'}）。`);
      break;
    }
    case 'morph': {
      // 揭示：变身（二岩猯藏）——从对方手牌随机取一张，把自身完全变成该卡的**复制体**（原卡留在对方手牌）。
      // 变身后立即按新 def 的效果文本再结算一次：新 def 带 k 则触发其揭示；og / fly / fx / surv 由新 def 实时驱动。
      const hand = st.players[other].hand;
      // 法术不作为变身目标（变身后会立刻消散），候选池里排除
      const cands = hand.filter((c) => c && c.def && !c.def.spell);
      if (!cands.length) { log(side, `✦ ${def.n} 想变身，但对方手牌里没有可作目标的卡（手牌为空或只有法术）。`); break; }
      const oldN = def.n;
      const pick = cands[Math.floor(Math.random() * cands.length)];
      // 大体积目标限制：随机目标是占多格的大体积卡（如萃香 occ:4）时，需本区域 max 恰为该占格数、且己方该区
      // （明牌+暗牌）**有且仅有变身者这一张卡**才能变身，否则失败保持原样（避免占格超限）。
      if (occOf(pick) > 1) {
        const ownZone = st.players[side].zones[locIdx];
        const legal = locSideMax(side, locIdx) === occOf(pick)
          && ownZone.length === 1 && ownZone[0] === card;
        if (!legal) {
          log('danger', `✦ ${def.n} 想变身成「${pick.def.n}」（占 ${occOf(pick)} 格），但本区域不满足条件（需该侧可用格数 = ${occOf(pick)} 且己方该区只有 ${def.n} 这一张卡），变身失败、保持原样。`);
          break;
        }
      }
      card.def = { ...pick.def };
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
      // 揭示：把本区己方“战力最低的已翻开卡”换边到对方（因幡帝；不含自己）；并列最低随机选一张，对方该区
      // 已放满则失败。换边后卡归属对方，其持续效果（og，如天子）按新归属方生效。
      const dst = st.players[other].zones[locIdx];
      if (sideRoom(other, locIdx) < 1) { // 移走的目标为普通占格卡，需对方至少 1 格空位
        log('danger', `✦ ${def.n} 想把己方卡换边，但对方该区已放满，换边失败。`);
        break;
      }
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
      const target = poolT[Math.floor(Math.random() * poolT.length)];
      const gEl = miniCardElById(target.id);
      const gRect = gEl && gEl.isConnected ? gEl.getBoundingClientRect() : null;
      st.players[side].zones[locIdx].splice(st.players[side].zones[locIdx].indexOf(target), 1);
      dst.push(target);
      target.side = other;
      pendingSwitchFly = { card: target, srcRect: gRect }; // 记录换边前源格位，供效果渲染后播“滑行+缩放”演出
      log('danger', `✦ ${def.n}：把己方「${target.def.n}」（威力 ${minP}）换边到了对方一侧。`);
      break;
    }
    case 'xform': {
      // 揭示：把本区域变成目标地形（fx.xf = 地形 id，出自 POOL 或 EXTRA）
      const target = findLocDef(fx.xf);
      if (!target) break;
      if (locShattered(locIdx)) {
        log('danger', `✦ ${def.n} 想把本区变成「${target.n}」，但本区域已被摧毁（已破碎）、不能再改变地形，变形失败。`);
        break;
      }
      const over = ['p', 'a'].some((s2) => sideUsed(s2, locIdx) > target.max);
      if (over) { log('danger', `✦ ${def.n} 想把本区变成「${target.n}」，但双方牌数超出其上限，变形失败。`); break; }
      const prevLoc = state.locs[locIdx].def;
      state.locs[locIdx].def = target;
      resetLocGaps(locIdx);
      refreshLocHeader(locIdx); // 更新列名/图标/效果文字/配色（隙间随 max=4 自动消失）
      log('danger', `✦ ${def.n} 将本区域变成了「${target.n}」！`);
      // 区域变形＝“该地形在本区出现”：立刻结算其「出现时」效果（与地形揭晓同一收口）；本区原本已是目标地形则不重复
      if (prevLoc !== target) runLocAppearEffect(locIdx, target);
      // 变成/变离「虚假之月」→ 本局总回合数在 7/6 间切换（进入第 7 回合后由 roundsTotal() 锁定，中途变掉不影响本局）
      syncRoundTotal('卡牌区域变形');
      break;
    }
    case 'xformR': {
      // 区域「随机变形」（1 费「梅莉」）：把本区地形换成地形池里**随机另一个**并立刻结算其「出现时」效果。候选＝`randomLocCandidates`
      // （POOL 除自身、允许与另两列重复、EXTRA 不入）；**不做上限防御**（与 case 'xform' 的“超限则失败”刻意相反）；已破碎的列跳过；
      // 抽到「天界」启动摧毁链、抽到「虚假之月」→ 总回合数当场变 7。
      if (locShattered(locIdx)) {
        log('danger', `✦ ${def.n} 想把本区变成随机另一个地形，但本区域已被摧毁（已破碎）、不能再改变地形，变形失败。`);
        break;
      }
      const candsR = randomLocCandidates(locIdx);
      if (!candsR.length) {
        log('danger', `✦ ${def.n}：地形池里没有可变成的其它地形，本次不变形。`);
        break;
      }
      const targetR = candsR[Math.floor(Math.random() * candsR.length)];
      const prevR = state.locs[locIdx].def;
      state.locs[locIdx].def = targetR;
      resetLocGaps(locIdx);     // 换地形 → 清空本列已封的隙间
      refreshLocHeader(locIdx); // 列名/图标/效果文案/配色即时更新
      log('danger', `✦ ${def.n} 掷出了随机地形 —— 「${prevR ? prevR.n : '原地形'}」变成了「${targetR.icon} ${targetR.n}」！`);
      runLocAppearEffect(locIdx, targetR);
      syncRoundTotal('卡牌区域随机变形'); // 可能变出「虚假之月」→ 总回合数当场变 7
      break;
    }
    case 'roam': {
      // 揭示 / 时机效果：把**自身**移到“另外两个区域”中**随机一处**（现役用法：幽灵 def.fx.turnStart）。目标区须①已开放（`locOpen`）
      // ②该侧空余 ≥ 自身占格数；两区都不可达则失败留原地。移动不改归属/揭示状态/放置顺序队列（同 mv/fly/shift）；核心与 gust 共用。
      const dst = moveCardToRandomZone(card);
      if (dst < 0) {
        log(side, `✦ ${txt} 想移动到别的区域，但另外两个区域都放不下或未开放，留在原地。`);
        break;
      }
      log(side, `✦ ${txt} 飘到了「${st.locs[dst].def.n}」（现 ${cardPowerIn(dst, card)}）。`);
      break;
    }
    case 'mv': {
      // 揭示：把本区“对方战力最低”的已翻开卡移到另外两区随机一处；候选区须该侧未满且已开放，全不可达则失败
      const vis = theirs.filter((c) => c.revealed && !c.def.un && !c.def.spell);
      if (vis.length === 0) { log(side, `✦ ${def.n} 想移走对方卡牌，但对方本区没有可移动的已翻开卡牌（暗牌与法术不算）。`); break; }
      let minP = Infinity, target = null;
      for (const c of vis) {
        const p = cardPowerIn(locIdx, c);
        if (p < minP) { minP = p; target = c; }
      }
      const cands = [];
      for (let j = 0; j < 3; j++) {
        if (j === locIdx) continue;
        if (locOpen(j) && sideRoom(other, j) >= occOf(target)) cands.push(j);
      }
      if (cands.length === 0) { log('danger', `✦ ${def.n} 想把对方「${target.def.n}」移走，但另外两个区域都放不下，移动失败。`); break; }
      const dst = cands.length === 1 ? cands[0] : cands[Math.floor(Math.random() * cands.length)];
      theirs.splice(theirs.indexOf(target), 1);
      st.players[other].zones[dst].push(target);
      log('danger', `✦ ${def.n} 把对方「${target.def.n}」（威力 ${minP}）移到了「${st.locs[dst].def.n}」。`);
      break;
    }
    case 'mute': {
      // 揭示：**封印**——目标**永久**失去卡牌文字（标记落在卡实例 `card.muteP` 上，整局有效，见「失去卡牌文字」段）。
      // 子句 `mute: { side, pick, n, has }`（缺省 side:'opp' / pick:'lowest' / n:1 / 不筛 `has`）：
      //   · `side`＝'opp'（缺省，敌方）/ 'own'（己方）/ 'both'（双方都算，可能封到己方自己）；
      //   · `pick`＝'lowest'（缺省，实时战力最低）/ 'highest'；只对“取 n 张”有意义；
      //   · `n: 'all'` ＝把候选**全部**封掉（此时 `pick` 不参与，一次性结算、不逐张停顿，同 `dwc`/`deAll`）；
      //   · `has: 'ongoing'` ＝只筛**卡面带「持续」标记**的卡（`cardHasOngoing`：`og` / 卡级 `prot` / 卡级 `ind`）。
      // 候选：该侧**已翻开**、排除 `un` 占位卡与法术（暗牌不算，法术马上自行消散），再按 `has` 收窄。
      // ⚠️ 非摧毁 / 非增减 / 非放置：不改战力、不进 `powerLog`/`fieldQueue`、不触发 `surv`/`phx`/`prot`/`ind`、不 `recordDestroy`、不播碎裂。
      // ⚠️ 目标**已**被封印时照常再抹一次（不改打下一张、不算落空）；不设任何免疫，目标此刻在静海内也照常结算。
      const sp = fx.mute || {};
      const both = sp.side === 'both';
      const sides = both ? [side, other] : [sp.side === 'own' ? side : other];
      const whoTxt = both ? '双方' : (sp.side === 'own' ? '己方' : '对方');
      const onlyOngoing = sp.has === 'ongoing';
      const all = sp.n === 'all';
      const pickHigh = sp.pick === 'highest';
      const cands = [];
      for (const s of sides) for (const c of st.players[s].zones[locIdx]) {
        if (!c.revealed || c.def.un || c.def.spell) continue;
        if (onlyOngoing && !cardHasOngoing(c)) continue;
        cands.push(c);
      }
      const whatTxt = onlyOngoing ? '包含持续效果的' : '';
      if (!cands.length) { log(side, `✦ ${def.n} 想封印${whoTxt}${whatTxt}卡牌，但本区没有符合条件的已翻开卡牌（暗牌与法术不算）。`); break; }
      // 取牌：`n:'all'` ＝全部；否则取 n 张，并列随机（先 shuffle 再按实时战力稳定排序取前 n，同 discard 的 maxCost）
      let targets;
      if (all) {
        targets = cands.slice();
      } else {
        const n = Math.max(1, Math.floor(sp.n || 1));
        const sorted = shuffle(cands.slice()).sort((a, b) => {
          const d = cardPowerIn(locIdx, b) - cardPowerIn(locIdx, a);
          return pickHigh ? d : -d;
        });
        targets = sorted.slice(0, Math.min(n, sorted.length));
      }
      const pickTxt = all ? '' : (pickHigh ? '最高' : '最低');
      for (const t of targets) {
        const already = cardSealed(t);
        t.muteP = true; // 永久：写在卡实例上——回手 / 复活 / 换边 / 变身 / 洗回牌库都保持，没有任何收尾代码会清它
        log('danger', `☯️ ${def.n} 封印了${t.side === side ? '己方' : '对方'}「${t.def.n}」（${pickTxt}威力 ${cardPowerIn(locIdx, t)}）→ 它永久失去卡牌文字：揭示 / 持续 / 时机 / 防护效果一律不发动。${already ? '⚠️ 它本就已被封印，本次再抹一次、无额外变化。' : ''}`);
      }
      if (targets.length > 1) log(side, `✦ ${def.n}：本区一次性封印 ${targets.length} 张${whoTxt}${whatTxt}已翻开卡牌（同一时机全封，无逐张停顿）。`);
      break;
    }
    case 'give': {
      // 揭示：把 `give` 指定的特殊卡加入**自己手牌**（现「雾雨魔理沙」→ 法术「极限火花」）。每次生成**新卡实例**并打
      // `justHandAdded`（渲染后播“滑入”演出 `.hand-new`）；**手牌满 7 张则失败**（同 phoenixRevive / drawSpell 口径）；衍生物仍需
      // **手动暗出**（法术走正常暗出→揭示→消散）。加入后调 `flushHandAdd(side)` **立刻渲染手牌**，否则本次“滑入”看不到。
      const gv = fx.give;
      const hand = st.players[side].hand;
      // `pool` 写法（不放回随机抽 n 张，互不相同）——现由「蓬莱山辉夜」使用，从 5 张神宝里随机抽 2 张加入自己手牌。
      // 除“来源是池、彼此不重复”外口径与单卡写法一致；池内条目缺失会被静默忽略，池空则只记一条日志。
      if (gv && Array.isArray(gv.pool)) {
        const want = gv.n || 1;
        const cands = gv.pool.map((k) => TOKENS[k]).filter((d) => !!d);
        if (!cands.length) {
          log('sys', `✦ ${def.n}：神宝池里没有可加入的卡（数据缺失），本次无事发生。`);
          break;
        }
        const picked = shuffle(cands.slice()).slice(0, Math.min(want, cands.length));
        const names = [];
        let added = 0;
        for (const pd of picked) {
          if (hand.length >= 7) break;
          const c2 = newCard(pd);
          c2.side = side;
          c2.justHandAdded = true;
          hand.push(c2);
          added++;
          names.push(pd.n);
        }
        if (added === picked.length) {
          log(side, `✦ ${def.n}：从神宝池随机抽到「${names.join('」「')}」，加入${side === 'p' ? '你' : '对手'}的手牌（现 ${hand.length}/7）。`);
        } else if (added > 0) {
          log(side, `✦ ${def.n}：手牌已满，只加入了 ${added}/${picked.length} 张神宝（「${names.join('」「')}」；现 ${hand.length}/7）。`);
        } else {
          log(side, `✦ ${def.n} 想把随机两张神宝加入手牌，但手牌已满（7/7），本次未能加入。`);
        }
        if (added > 0) flushHandAdd(side);
        break;
      }
      const tk = gv && TOKENS[gv.card];
      if (gv && tk) {
        const cnt = gv.n || 1;
        let added = 0;
        for (let i = 0; i < cnt; i++) {
          if (hand.length >= 7) break;
          const c2 = newCard(tk);
          c2.side = side;
          c2.justHandAdded = true;
          hand.push(c2);
          added++;
        }
        if (added === cnt) log(side, `✦ ${txt}`);
        else if (added > 0) log(side, `✦ ${txt}（手牌已满，仅加入了 ${added}/${cnt} 张）`);
        else log(side, `✦ ${def.n} 想把「${tk.n}」加入手牌，但手牌已满（7/7），本次未能加入。`);
        if (added > 0) flushHandAdd(side);
      }
      break;
    }
    case 'shuffleIn': {
      // 洗入卡组（`shuffleIn`）：把指定牌 n 张**洗入某一方牌库**并**重洗整副牌库**（实现见 shuffleCardsIntoDeck 段）。
      // 进的是**牌库**（隐藏区）——不翻开、不占格、不进放置队列、**不结算被洗入卡自身的效果**；张数**无上限**；目标方由 `to`
      // 决定（`'opp'`/`'a'` = 对方，缺省 = 自己）；日志点名 + 轻量演出；与 surv/phx/prot/ind、区域字段、格位、战力台账均无交互。
      const si = fx.shuffleIn;
      const inDef = si && findCardDefByKey(si.card);
      if (!si || !inDef) {
        log('sys', `✦ ${def.n}：洗入卡组的条目缺失或键名写错（${(si && si.card) || '?'}），本次无事发生。`);
        break;
      }
      const toOpp = si.to === 'opp' || si.to === 'a' || si.to === 'enemy';
      const tgtSide = toOpp ? other : side;
      const want = si.n || 1;
      const got = shuffleCardsIntoDeck(tgtSide, inDef, want);
      const tgtWho = tgtSide === 'p' ? '你' : '对手';
      if (!got) {
        log('sys', `✦ ${def.n} 想把「${inDef.n}」洗入${tgtWho}的牌库，但本次没有牌被加入。`);
        break;
      }
      // 先刷新牌库计数再播演出 ⇒ 玩家看到“洗入后”的张数
      if (tgtSide === 'p') updateDeckCount(); else renderSide();
      log(toOpp ? 'danger' : side,
        `🃏 ${def.n}：把 ${got} 张「${inDef.n}」洗入了${tgtWho}的牌库，并重新洗了一次牌（现牌库 ${state.players[tgtSide].deck.length} 张）。`);
      playShuffleInFx(tgtSide, got, inDef.n, def.n);
      break;
    }
    case 'discard': {
      // 弃牌：把牌从**手牌**移出 → 放进**该牌归属方**的「弃牌池」，并播双方可见的「弹出卡面 + 斜切两半」演出。⚠️ 与「摧毁」的分工是
      // **区域不同、互不重叠**（摧毁只作用于场上、弃牌只作用于手牌）⇒ 弃牌**不是**摧毁，不触发 surv/phx/prot/ind，不动区域字段/
      // 格位/放满加成/fieldQueue/战力台账。写法 `discard: { n, to, pick, card, cost }`：`to` 缺省 `'own'`＝弃自己手牌、`'opp'`
      // （`'a'`/`'enemy'`）＝弃对方；`card` 按卡名、`cost` 按**印刷费用**（恰好值或 `{min,max}`）筛选，都不写＝整副手牌候选；`pick`
      // 缺省 `'random'`、`'right'`/`'left'`＝从最右/最左起取；`n` 缺省 1、`'all'`＝命中即全弃；`give` 子句＝按被弃牌印刷费用给施放方加衍生物。
      const dc = fx.discard;
      if (!dc) {
        log('sys', `✦ ${def.n}：弃牌的条目缺失（def.discard 未写），本次无事发生。`);
        break;
      }
      const toOpp = dc.to === 'opp' || dc.to === 'a' || dc.to === 'enemy';
      const tgtSide = toOpp ? other : side;
      const dWho = tgtSide === 'p' ? '你' : '对手';
      const r = discardFromHand(tgtSide, dc, card);
      if (!r.ok) {
        const cond = discardSpecText(dc);
        log('sys', `✦ ${def.n} 想弃掉${dWho}手牌里的牌（${cond}），但${dWho}手里没有符合条件的牌（现手牌 ${st.players[tgtSide].hand.length} 张），本次无事发生。`);
        break;
      }
      const dNames = r.cards.map((c) => `「${c.def.n}」`).join('');
      // 弃对手的牌走红色（danger，与加费/摧毁/洗入对手牌库同款：公开且带对抗性）
      log(toOpp ? 'danger' : 'sys',
        `🗑️ ${def.n}：把${dWho}手牌里的 ${r.cards.length} 张${dNames}丢弃 → 移入${dWho}的弃牌池（现 ${pileOf(tgtSide, 'discard').length} 张${r.cards.length < r.want ? `；符合条件的牌不足，本来要弃 ${r.want} 张` : ''}）。`);
      // 可选子句 `discard.give`：弃牌**真的发生之后**，按被弃那张牌的印刷费用给施放方自己加入手牌衍生物
      //（收口 `discardGiveTokens`；弃牌落空时上面已 return、加入目标恒为自己、手牌上限 7 张照常约束）。
      const gvR = discardGiveTokens(side, dc, r, card);
      if (gvR) {
        if (gvR.missing) {
          log('sys', `✦ ${def.n}：弃牌衍生物的条目缺失（discard.give.card 键名写错），本次只弃了牌、未加入任何卡。`);
        } else if (!gvR.added) {
          log(side, `✦ ${def.n}：想把「${gvR.name}」加入手牌，但手牌已满（7/7），本次未能加入。`);
        } else {
          const sideWho = side === 'p' ? '你' : '对手';
          log(side, `🪨 ${def.n}：按被弃的牌加入 ${gvR.added} 张「${gvR.name}」（战力 ${gvR.powers.join('、')}）到${sideWho}的手牌（现 ${st.players[side].hand.length}/7）。${gvR.added < gvR.want ? '（手牌已满，部分未能加入）' : ''}`);
        }
      }
      break;
    }
    case 'reviveDiscard': {
      // 复活弃牌池（四季映姬）：把自己一方弃牌池里的**所有角色卡牌（非法术）**以随机顺序复活到场上。
      // ① 只复活角色卡牌（`def.spell === true` 的法术留在池里，日志点名）；② 随机顺序＝对候选快照 shuffle；
      // ③ 每张只在「已开放（`locOpen`，避开七夕坂等 minTurn 锁定）且己方该侧放得下（`sideRoom` ≥ `occOf`）」
      //    的区域里等概率随机选一个 —— 于是**不会出现“掷到满区就复活失败”**；三区都放不下/未开放 → 留在池里；
      // ④ 落地即翻开，并播「凝聚显形」演出（`justSpawned`）；
      // ⑤ 落地后立刻按其**当前所在区域**结算它自己的「揭示」（白板跳过）——口径同 `spawn.reveal` /「集结」，
      //    故复活辉夜会再抽 2 张神宝；
      // ⑥ 牌本体出池，永久增益 `powerLog` / 费用修正 `costMod` 随实例保留，
      //    同时清掉入池元数据 `pileKind`/`pileTurn`/`pileBy`/`pileLoc`/`pilePower`；
      // ⑦ 不是“打出/暗出”：不耗能量、不写 `playerMoves`/`aiMoves`/`flyMoved`，也不被「重置暗牌」收回；
      // ⑧ 不是“摧毁”也非增减：与 `surv`/`phx`/`prot`/`ind`、摧毁池、区域 `gamble`/`gust` 均无交互；
      // ⑨ 归属按牌的所属方：玩家复活自己的弃牌池、AI 复活 AI 自己的。
      // ⚠️ 正常翻牌流程走**异步分步版 `applyReviveDiscardReveal`**（逐张 500ms）；本同步版无节奏，供 morph 变身 /
      //    fx 时机效果 / 落场生成等非翻牌路径复用；两条路径共用 `reviveTargetZones` / `reviveCardFromPile` /
      //    `reviveStuckLog` 三个收口。连锁复活靠循环里的 `pile.indexOf(c) < 0` 保证收敛。
      const pile = pileOf(side, 'discard');
      const who = side === 'p' ? '你' : '对手';
      const all = pile.slice();
      if (!all.length) {
        log(side, `✦ ${def.n}：${who}的弃牌池是空的，没有可复活的角色卡牌。`);
        break;
      }
      const cands = all.filter((c) => c && c.def && !c.def.spell); // ① 只复活角色卡牌（非法术）
      const spellN = all.length - cands.length;
      if (!cands.length) {
        log(side, `✦ ${def.n}：${who}的弃牌池里只有 ${spellN} 张法术（法术不参与复活），本次无事发生。`);
        break;
      }
      const order = shuffle(cands.slice()); // ② 随机顺序
      const revived = [];
      const stuck = [];
      for (const c of order) {
        if (pile.indexOf(c) < 0) continue; // ⚠️ 防御：已被本次连锁复活（另一张四季映姬）先复活走的条目
        const dst = reviveCardFromPile(side, c, pile); // ③ 候选区里随机 + 离池 + 落地即翻开（共用核心）
        if (dst < 0) { stuck.push(c.def.n); continue; }
        revived.push({ card: c, loc: dst });
        log(side, `✦ ${def.n}：「${c.def.n}」从${who}的弃牌池复活到「${st.locs[dst].def.n}」（落地即翻开，并重新结算其揭示）。`);
        const nowLoc = fieldLocOf(c);
        if (c.def.k && nowLoc >= 0) applyEffect(side, nowLoc, c); // ⑤ 逐张重新结算其自身「揭示」
      }
      renderZones(); // 让复活的卡在场上显形（「凝聚显形」演出；末尾会顺带刷新侧栏牌池计数）
      reviveStuckLog(side, card, revived, stuck, spellN, pile.length);
      break;
    }
    case 'dwh': {
      // 揭示：摧毁本区对方一张“已翻开且战力最高”的卡（与 dw 只差选最弱 / 选最强）。判全是混比，并列最高
      // 随机挑一张；法术与暗牌不入选，ind 卡照常参与“最强”判定 —— 抽中它＝摧毁失败、判定结束（不改打其他牌）。
      if (theirs.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但该区空无一人。`); break; }
      if (locNoDestroy(locIdx)) { log(side, `✦ ${def.n} 想摧毁卡牌，但本区域存在免摧毁效果（地形「睡鼠神祠」或「蕾蒂」等），所有卡牌都无法被摧毁。`); break; }
      const vis = theirs.filter((c) => c.revealed && !c.def.un && !c.def.spell); // 法术不选为目标
      // ind 卡照常参与“最强”判定与并列随机抽取——抽中它＝摧毁失败、判定结束
      if (vis.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但对方在此区没有可摧毁的已翻开卡牌（暗牌与法术不算）。`); break; }
      let maxP = -Infinity;
      for (const c of vis) maxP = Math.max(maxP, cardPowerIn(locIdx, c));
      const maxPool = vis.filter((c) => cardPowerIn(locIdx, c) === maxP);
      const target = maxPool[Math.floor(Math.random() * maxPool.length)]; // 并列：随机挑一张
      if (indestructibleBlock(target, def.n)) break;
      if (phoenixRevive(target, locIdx)) break; // 凤凰重生：回手 +N 战力
      if (surviveDestroy(target)) break; // 防摧毁：替代为降战力、卡不离场
      recordDestroy(target, locIdx, def.n);
      playShatter(target);
      theirs.splice(theirs.indexOf(target), 1);
      dequeueField(target);
      log('danger', `✦ ${def.n} 摧毁了对方「${target.def.n}」（威力 ${maxP}${maxPool.length > 1 ? `；并列最高共 ${maxPool.length} 张，随机选中这一张` : ''}）`);
      break;
    }
    case 'oc': {
      if (isSpell(card)) { log(side, `✦ 「${card.def.n}」是法术（没有战力），「落牌自增」不生效。`); break; }

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
      // 揭示：把己方最左侧（下标 0）**已翻开**的卡按放置顺序搬到最右侧（下标 2）己方一侧，直到放满
      //（右侧空余 ≥ 该卡 `occ` 才能搬）；暗牌 / un 卡不搬，归属与揭示状态、放置队列都不变。
      // 正常翻牌流程走逐张 0.3s 的 `applyShiftReveal`，本同步版供 morph/fx 等非翻牌路径复用。
      const moved = [];
      let c;
      while ((c = shiftMoveOne(side))) moved.push(c.def.n);
      log(side, moved.length
        ? `✦ ${txt}：把最左侧区域的 ${moved.length} 张已翻开卡（${moved.join('、')}）搬到了最右侧区域。`
        : `✦ ${txt}：最左侧区域没有可搬的已翻开卡，或最右侧区域已放满。`);
      break;
    }
    case 'costUp': {
      // 揭示（桑尼米尔克）：让对方**当前手牌**里随机一张卡的能量消耗 +N（N 取自 fx.a），修正经 `applyCostMod` 记在
      // 卡实例上、**仅本场战斗有效**（牌离场 / 本局结束即消失）。⚠️ 每张卡最多涨到 6 费（可选目标 `cardCost < 6`），
      // 无目标则本轮揭示落空；加费**不改**费用档位判定，卡组曲线 / 地形加成 / 图鉴仍按印刷费用 `def.c` 算，
      // 只有实际打出时的能量消耗按修正后的算（修正跟着这张牌走，撤回手牌照旧涨价）。
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

      const pick = cands[Math.floor(Math.random() * cands.length)];
      const before = cardCost(pick);
      applyCostMod(pick, up, card);
      const after = cardCost(pick);
      log('danger', `✦ ${txt}：对方手牌里的「${pick.def.n}」能量消耗 ${before} → ${after}（公开：这张牌现在需要 ${after} 点能量，仅本场战斗有效）。`);
      break;
    }
    case 'energyNext': {
      // 揭示（斯塔萨菲雅，一次性）：揭示在阶段 ④（本回合能量已结算完），故实际在下一个回合开始的 `grantTurnEnergy`
      // 到账；同回合多个来源会叠加（登记式 `addPendingTurnEnergy`）。⚠️ 本局最后一回合翻开时已无“下一回合” ⇒
      // 这份能量不生效（判断读 `roundsTotal()`；有「虚假之月」的局第 6 回合翻开的会在第 7 回合正常到账）。
      // 演出分两段：揭示当刻 `playEnergyBookFx` 登记，到账时 `grantTurnEnergy` → `playEnergyGainFx`。
      const gain = fx.a || 1;
      const booked = addPendingTurnEnergy(side, gain, card);
      const total = booked.n;
      const who = side === 'p' ? '你' : '对手';
      log('sys', `🔋 ${txt}：${who}将在下一回合额外获得 ${gain} 点能量${total > gain ? `（已累计 ${total} 点）` : ''}。`);
      if (st.turn >= roundsTotal()) {
        log('sys', `⚠️ 这是最后一回合（第 ${roundsTotal()} 回合），下一回合不存在，这份额外能量本局不会生效。`);
        break;
      }

      playEnergyBookFx(side, gain, card);
      break;
    }
    case 'drawSpell': {
      // 时机效果（帕秋莉·诺蕾姬，def.fx.turnStart）：每回合开始从法术池随机抽 N 张法术加入自己手牌。池优先取
      // `fx.pool`、缺省回退卡级 `spellPool`，池内必须是法术（非法术条目会被忽略，防御数据写错）；每回合独立随机、
      // 可重复抽到同一张；归属按牌的所属方（被换边后按新归属抽）；手牌满 7 张则加入失败、只记日志。
      // ⚠️ turnStart 每回合最先结算（这份法术本回合就能用），但刚登场的卡跳过当回合的回合开始效果 ⇒
      // 帕秋莉要从她翻开的**下一回合**起才开始抽。
      if (!card.revealed) break;
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
        if (dHand.length >= 7) break;
        const pickSpell = spellPool[Math.floor(Math.random() * spellPool.length)];
        const spellCard = newCard(pickSpell);
        spellCard.side = side;
        spellCard.justHandAdded = true;
        dHand.push(spellCard);
        got.push(pickSpell.n);
      }
      const dWho = side === 'p' ? '你' : '对手';
      log('sys', got.length
        ? `📖 ${def.n}（回合开始）：从帕秋莉法术池抽到「${got.join('、')}」，加入${dWho}的手牌（现 ${dHand.length}/7）。`
        : `📖 ${def.n}（回合开始）：想从法术池抽法术，但手牌已满（7/7），本次未能加入。`);
      break;
    }
    case 'retrigger': {
      // 再触发本区己方卡牌的揭示（东风谷早苗）—— 同步版（正常翻牌流程走分步演出版 `applyRetriggerReveal`，供 morph
      // 变身 / fx 时机效果 / 落场生成等非翻牌路径复用）。候选排除自己 / 法术 / un 占位卡 / 同为 retrigger 的卡
      //（防死循环）；只重跑「揭示」，不跑 fx 与 og/surv/phx/prot/ind，也不重跑地形类 gamble / gust。演出在结算**之前**
      // 入渲染队列；⚠️ 目前**未生效**（见 flushRetriggerFx 上方说明）。
      queueRetriggerFx(side, locIdx, card);
      const targets = retriggerTargets(side, locIdx, card);
      if (!targets.length) {
        log(side, `✦ ${txt}：本区没有可再触发揭示的其他己方已翻开卡牌（不含自己、法术与同为该效果的卡），本次无事发生。`);
        break;
      }
      log(side, `✦ ${txt}：${side === 'p' ? '你' : '对手'}在本区「${locDef(locIdx).n}」的 ${targets.length} 张己方卡牌，其「揭示」各再触发一次 —— ${targets.map((c) => `「${c.def.n}」`).join('')}`);
      for (const c of targets) retriggerOne(c);
      break;
    }
    default: break;
  }
}

/* ---------------- 终局结算 ---------------- */

// 终局演出：先等场上遗留的 ±N 动画（.gain-ring）播完，再依“左→右”把各区域的【胜方总点数横幅】
// 做 700ms 放大高亮（区域之间间隔 150ms）；全部结束后调用方才弹结算弹窗（finishMatch）。
function zoneWinnerSide(j) {
  const eP = zoneEff('p', j);
  const eA = zoneEff('a', j);
  if (eP > eA) return 'p';
  if (eA > eP) return 'a';
  return null;
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
  await waitBuffFxDone();
  if (gen !== state.gen) return;
  for (let j = 0; j < 3; j++) {
    if (state.locs[j].shattered) continue;
    const win = zoneWinnerSide(j);
    if (!win) continue;
    const pill = (win === 'p' ? Game._els.totP[j] : Game._els.totA[j]).closest('.loc-total');
    if (!pill) continue;
    pill.classList.remove('settle-win');
    void pill.offsetWidth;
    pill.classList.add('settle-win');
    if (gen !== state.gen) return;
    await sleep(700);
    if (gen !== state.gen) return;
    pill.classList.remove('settle-win');
    if (j < 2) await sleep(150);
  }
}

// 把一张卡移到“另外两个区域”中**随机一处**的核心（roam 与地形「魔力风暴」的 gust 共用）：目标区须已开放
// 且该侧空余 ≥ 该卡占格数，无任何可达区域返回 -1（不移动、由调用方记日志）。移动不改变归属、揭示状态与
// 场上放置顺序队列；渲染后由 flushPendingDriftFly 播“滑行 + 缩放”演出。
function moveCardToRandomZone(card) {
  const st = state;
  const owner = card.side;
  const from = fieldLocOf(card);
  if (from < 0) return -1;
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

// 区域「回合结束崩塌」（字段 collapse: { cards, to }，现仅幽明结界）：每回合翻牌结算后（阶段 ⑤-0 **最后一步**）本区
// **双方总卡牌数** ≥ collapse.cards（按张数计，暗牌与落场 token 都算）就把地形整体换成 collapse.to（现为「冥界」）。
// ⚠️ 任一方占格数超过目标地形上限则不崩塌（防御）；async：目标带 `shatter`（天界）时要等整条摧毁演出播完，已破碎
// 的列永久锁定、直接跳过。
async function locCollapseEffects() {
  const st = state;
  for (let j = 0; j < 3; j++) {
    if (locShattered(j)) continue;
    const def = locDef(j);
    const col = def.collapse;
    if (!col) continue;
    const target = findLocDef(col.to);
    if (!target) continue;
    const cnt = st.players.p.zones[j].length + st.players.a.zones[j].length;
    if (cnt < col.cards) continue;
    // 防御：任一方占格数超过目标地形上限则本次不崩塌
    if (['p', 'a'].some((s) => sideUsed(s, j) > target.max)) {
      log('danger', `${def.icon} ${def.n}：本区双方共 ${cnt} 张卡牌，但有一方占格数超过「${target.n}」的上限（${target.max}），结界未能崩塌。`);
      continue;
    }
    st.locs[j].def = target;
    resetLocGaps(j);
    refreshLocHeader(j);
    log('danger', `${def.icon} ${def.n}：本区双方共 ${cnt} 张卡牌（≥ ${col.cards}），结界崩塌 —— 本区域变成了「${target.n}」！`);
    // 变形 = 该地形在本区“出现” → 立刻结算其「出现时」效果（冥界无 spawn，此处是空操作）
    runLocAppearEffect(j, target);
    // 崩塌出「虚假之月」→ 本局总回合数变 7（第 6 回合末崩塌同样续出第 7 回合）
    syncRoundTotal('地形崩塌');
    await awaitShatterChain();
  }
}
/* ---- 区域「回合结束封格」（地形字段 `gap: N`，现仅「八云紫的家」）----
   每回合翻牌结算后（阶段 ⑤-0 地形类回合结束效果的**最后一步**，排在 collapse 之后）逐列对**双方分别**判定：
   某侧还有空位（`sideUsed` < `locSideMax`）就把该侧已封隙间数 +`gap`（缺省 1，至多封到刚好放满），已放满 /
   已封到底则不加；渲染层在最靠后的空置不可用格铺「隙间」灰卡，表现就是“从后往前、逐回合各封一格”。口径见 locGaps。 */
function locGapEffects() {
  const st = state;
  for (let j = 0; j < 3; j++) {
    const def = locDef(j);
    const per = def.gap;
    if (!per) continue;
    const n = Math.max(1, Math.floor(per));
    const hit = [];
    for (const side of ['p', 'a']) {
      const used = sideUsed(side, j);
      const before = locSideMax(side, j);
      if (used >= before) continue;
      const L = st.locs[j];
      if (!L.gaps) L.gaps = { p: 0, a: 0 };
      L.gaps[side] = (L.gaps[side] || 0) + Math.min(n, before - used);
      const after = locSideMax(side, j);
      hit.push(`${side === 'p' ? '你方' : '敌方'}隙间 ${locGaps(side, j)} 张（可用 ${after} 格，已放 ${used} 张）`);
    }
    if (hit.length) {
      log('sys', `${def.icon} ${def.n}：回合结束 —— 双方各从后往前添加隙间 → ${hit.join('、')}`);
    }
  }
}

/* ==================== 区域「揭示重复触发」（地形字段 `repeatReveal`，现仅「守矢神社」）====================
   凡是在带本字段的区域里结算的「揭示」都执行两次（第 1 次 → 停 400ms → 第 2 次「重复」）；持续 `og`、时机 `fx`
   等**非揭示机制一次都不跑**。它是**区域规则**（按“揭示在哪个区域结算”判定）而不是“这张牌翻面时多结算一次”
   ⇒ 早苗 `retrigger` 再触发出来的揭示**也会被加倍**，与卡牌键 `retrigger` 是**乘积关系**：同区已翻开的 A 共被
   结算 6 次（A 自身翻面 2 次 + 早苗两次揭示各再触发 A 2 次），早苗自己的揭示是 2 次。
   ② 资格：在本区翻面的暗牌按「翻开那一刻」的**快照**（`revealRound` 传 `repeatRevealHere` 进来，本函数不重读
      地形）；早苗再触发的每一条揭示按该牌**当前所在区域**实时读（此刻没有“翻开那一刻”）。
   ③ 候选＝“在本区域被翻开”的牌（口径同 gamble/gust）：落场 token、已翻开后被移入本区的卡都不算，地形出现前就
      在本区的旧卡不追溯；白板（键 k 为空串）无揭示可重复。
   ④ 重复＝对同一张牌再走一次 `resolveCardReveal`（不是直接 `applyEffect`）：所有揭示键照常重跑、四个「分步演出」
      键保留各自间隔，但**不触发** `og`/`surv`/`phx`/`prot`/`ind`/`fly` 与 `fx`；按该牌**当前所在区域**结算，已不在
      场上则只记日志并跳过；重复点在 `gust` **之前**；含法术 —— 调用点排在 `vanishSpell` 之前、仍占那 1 个格位。
   ⑤ 节奏：重复前停 400ms，重复结算完 `renderZones()`；停顿后校验 `state.gen`（重新开局即放弃本次重复）。
   ⑥ 本字段自身不改战力、不动区域字段与格位、不进 `powerLog`/`fieldQueue`，也不是揭示键；被重复的牌若在带 `mute`
      的区域里，由 `applyEffect` 入口守卫拦下并记日志。 */

/** `repeatReveal` 的**唯一语义收口**：区域带本字段就执行两次（第 1 次 → 停 400ms → 第 2 次「重复」），否则一次。
    `revealRound`（暗牌翻面）传**翻开那一刻的快照** `forceRepeat`；`retriggerOneStaged`（早苗再触发的每一条）不传
    ⇒ **实时读**该牌当前所在区域。两次都走共用分派 `resolveCardReveal`，故分步演出键保留各自间隔。
    ⚠️ 重复那一次**不再递归加倍**，保证有限、不会无限递归。 */
async function resolveRevealInZone(side, locIdx, card, forceRepeat) {
  const gen = state.gen;
  const locName = locDef(locIdx).n;
  const doRepeat = (forceRepeat === undefined) ? !!locDef(locIdx).repeatReveal : !!forceRepeat;
  // 区域「封锁揭示」（法界）：本次揭示（连它的重复）都不发动。守卫放在这个**收口**上 ⇒ 翻牌主路径、守矢神社的第 2 次、
  // 早苗 `retriggerOneStaged` 再触发的每一条揭示、四个分步演出键（`resolveCardReveal` 之前）全部覆盖；实时判定，离开法界即放行。
  if (revealBlocked(card)) { revealSkipLog(card); return; }
  await resolveCardReveal(side, locIdx, card);
  if (!doRepeat) return;
  renderZones();
  await sleep(400); // 用户口径：重复前停 400ms，让玩家看清“又触发了一次”
  if (gen !== state.gen) return; // 重新开局等中断
  if (cardMuted(card)) {
    // 此刻已失去文字（被封印，或它自己的揭示把它挪进了静海）→ 重复不发动
    muteSkipLog(card, '揭示效果（地形「揭示重复触发」）');
    return;
  }
  if (revealBlocked(card)) {
    // 此刻揭示已被封锁（它自己的揭示把它挪进了法界）→ 重复不发动（第 2 次是**新**的一次揭示，故按此刻实时判定）
    revealSkipLog(card);
    return;
  }
  const nowLoc = fieldLocOf(card);
  if (nowLoc < 0) {
    log('sys', `🔁 ${locName}：想重复结算「${card.def.n}」的揭示，但它已不在场上（被摧毁或回到了手牌），本次不重复。`);
    return;
  }
  log(side, `🔁 ${locName}：重复结算「${card.def.n}」的揭示效果 —— 第 2 次（仅重复揭示；持续与回合开始/结束等非揭示效果不重复）。`);
  // ② 第 2 次：走共用分派；**这里不再递归加倍**（本字段每处只多一次）
  await resolveCardReveal(card.side, nowLoc, card);
  renderZones();
}
// 区域「揭示后吹飞」（字段 gust: true，现仅魔力风暴）：阶段 ④ 翻牌流程里，每张在该区域翻开、且**自身揭示效果
// 已经结算完**的卡「若可能」就移到另一个随机区域（候选/判定同 roam）。与 gamble 的差别：gamble 在**翻面瞬间、
// 自身揭示之前**结算（影响 bl/oc 判定），gust 在**自身揭示之后**（不改变本次揭示结果）。
// 只作用于“本回合在该区被翻开”的卡（走 revealRound 的那些）：旧卡、落地即翻开的落场 token、被移入本区的卡都
// 不受影响；该卡自身的揭示已把它挪出本区则不再吹；换边类换的仍是同一区域，故照常被吹（按新归属方判空位）。
function runLocAfterRevealEffects(side, locIdx, card) {
  const st = state;
  const def = locDef(locIdx);
  if (!def.gust || !card) return -1;
  if (fieldLocOf(card) !== locIdx) return -1;
  const dst = moveCardToRandomZone(card);
  if (dst < 0) {
    log(side, `${def.icon} ${def.n}：${side === 'p' ? '你方' : '敌方'}「${card.def.n}」想被吹走，但另外两个区域都放不下或未开放，留在原地。`);
    return -1;
  }
  log(side, `${def.icon} ${def.n}：${side === 'p' ? '你方' : '敌方'}「${card.def.n}」被吹到了「${st.locs[dst].def.n}」（现 ${cardPowerIn(dst, card)}）。`);
  return dst;
}
// 区域「翻开时」效果（阶段 ④ 逐张触发）：由 revealRound 在每张暗牌翻面后、该卡自身「揭示」结算**之前**调用
//（morph / fx 等非翻牌路径与落地即翻开的落场 token 都不经过）。现仅 gamble（驹草赌场）：本区翻开的卡牌
// 永久随机 ±N 战力（各 50%）。
// ① 只作用于“在本区被翻开的卡”——落地即翻开的落场 token、已翻开后被移入本区的卡都不参与，旧卡不追溯；
// ② ±N 先于该卡自身的揭示结算，故 `bl`/`oc` 等按博彩后的威力判定；③ 走 applyPermBuff 收口（气泡 + 按来源
// 记地形名），同一张卡被摧毁回手后再打出会**重新博彩**；④ 不是“摧毁”也非揭示增益，`surv`/`phx`/`prot` 照常参与。
function runLocRevealEffects(side, locIdx, card) {
  const def = locDef(locIdx);
  if (!def.gamble || !card) return 0;
  // 法术无战力且揭示后即消散，不参与博彩
  if (isSpell(card)) return 0;
  const d = Math.random() < 0.5 ? def.gamble : -def.gamble;
  // tag = 地形名 → 战力影响历史按来源显示「驹草赌场」
  if (applyPermBuff(card, d, null, def.n) === false) {
    log('sys', `${def.icon} ${def.n}：${side === 'p' ? '你方' : '敌方'}「${card.def.n}」赌了一把 → 掷出 ${d}，但被本区「免减攻」拦下（战力不变，现 ${cardPowerIn(locIdx, card)}）`);
    return d;
  }
  log(d > 0 ? 'sys' : 'danger',
    `${def.icon} ${def.n}：${side === 'p' ? '你方' : '敌方'}「${card.def.n}」赌了一把 → ${d > 0 ? '+' : '−'}${Math.abs(d)} 战力（现 ${cardPowerIn(locIdx, card)}）`);
  return d;
}
// 区域「定时掷骰」（字段 dice: { turn, n }，现仅骰子赌桌）：**第 dice.turn 回合的回合结束时**（阶段 ⑤-0 地形回合
// 结束效果内，先于场上「回合结束」卡牌效果）结算一次，把本区**双方所有卡牌各自**随机永久 ±n 战力。
// 与 gamble 的差别：dice 只在指定那一个回合末结算、作用于**当时在本区的所有卡**（含旧卡与落场 token）。
// ⚠️ 每张卡独立掷骰（不是全桌共用一次点数）；地形在 dice.turn 之后才出现则该时机已过、不再补结算；一局最多
// 结算一次（同一块地形）；非“摧毁”，带 `surv`/`phx`/`prot` 的卡照常参与；`un` 占位卡不受影响。
function locDiceEffects() {
  const st = state;
  for (let j = 0; j < 3; j++) {
    const def = locDef(j);
    const dice = def.dice;
    if (!dice || st.turn !== dice.turn) continue;
    const n = dice.n || 1;
    const hit = [];
    for (const side of ['p', 'a']) {

      for (const c of st.players[side].zones[j].slice()) {
        if (c.def.un || c.def.spell) continue;
        const d = Math.random() < 0.5 ? n : -n; // 每张卡各自掷一次：+n / −n 各半

        if (applyPermBuff(c, d, null, def.n) === false) {
          hit.push(`${side === 'p' ? '你方' : '敌方'}「${c.def.n}」掷出 ${d} 但被「免减攻」拦下(${cardPowerIn(j, c)})`);
          continue;
        }
        hit.push(`${side === 'p' ? '你方' : '敌方'}「${c.def.n}」${d > 0 ? '+' : '−'}${Math.abs(d)}(${cardPowerIn(j, c)})`);
      }
    }

    if (hit.length) log('snap', `${def.icon} ${def.n}：第 ${dice.turn} 回合结束，本区所有卡牌各自掷骰 → ${hit.join('、')}`);
  }
}
// 区域「定时加成」（字段 rally: { turn, add }，现仅演唱会）：**第 rally.turn 回合的回合结束时**（阶段 ⑤-0 地形回合
// 内效果之一，先于场上「回合结束」卡牌效果）结算一次，把本区**双方所有已翻开卡牌**永久 +add 战力（add 可为负）。
// 与 dice 同属“定时一次性”但取固定值；与 grow 的差别是只在指定那一个回合末触发一次。
// ⚠️ 只作用于结算那一刻**已翻开**的卡（含落场 token）—— 暗牌翻面后该时机已过、实际吃不到；地形在 rally.turn
// 之后才出现则不再补结算；永久生效、可叠加；一局最多结算一次（同一块地形）；非“摧毁”，`surv`/`phx`/`prot` 照常被加。
function locRallyEffects() {
  const st = state;
  for (let j = 0; j < 3; j++) {
    const def = locDef(j);
    const rally = def.rally;
    if (!rally || st.turn !== rally.turn) continue;
    const add = rally.add || 0;
    if (!add) continue;
    const hit = [];
    for (const side of ['p', 'a']) {

      for (const c of st.players[side].zones[j].slice()) {
        if (!c.revealed || c.def.un || c.def.spell) continue;

        if (applyPermBuff(c, add, null, def.n) === false) continue;
        hit.push(`${side === 'p' ? '你方' : '敌方'}「${c.def.n}」(${cardPowerIn(j, c)})`);
      }
    }

    if (hit.length) {
      log('snap', `${def.icon} ${def.n}：第 ${rally.turn} 回合结束，本区双方已翻开卡牌各 ${add > 0 ? '+' : '−'}${Math.abs(add)} 战力 → ${hit.join('、')}`);
    }
  }
}
// 回合结束战力成长 / 衰减（grow：如寺子屋 +N；decay：如间歇泉 −N）：每回合翻牌结算后把本区**双方所有已翻开**的
// 卡牌永久 ±N（走 applyPermBuff 收口：记入战力影响历史 + 播 ±N 演出）；两字段方向相反、同一块地形一般只带一个。
// ⚠️ 只作用于结算那一刻**已翻开**的卡（暗牌不吃，翻面后从**下一个**回合末起才被影响）；永久生效、可叠加；
// `un` 占位卡不受影响；不是“摧毁”也非揭示增益，带 `surv`/`phx`/`prot` 的卡照常被 ±N。
// 结算时机：runLocTurnEndEffects（阶段 ⑤-0）调用，恒在场上 fx.turnEnd **之前** ⇒ 后者看到的是已改动后的威力。
function locTurnEndPowerEffects() {
  const st = state;
  for (let j = 0; j < 3; j++) {
    const def = locDef(j);
    // grow/decay 都带时相互抵消，都不带则跳过该区
    const delta = (def.grow || 0) - (def.decay || 0);
    if (!delta) continue;
    const hit = [];
    let blocked = 0;
    for (const side of ['p', 'a']) {

      for (const c of st.players[side].zones[j].slice()) {
        if (!c.revealed || c.def.un || c.def.spell) continue;

        if (applyPermBuff(c, delta, null, def.n) === false) { blocked++; continue; }
        hit.push(`${side === 'p' ? '你方' : '敌方'}「${c.def.n}」(${cardPowerIn(j, c)})`);
      }
    }

    if (hit.length) {
      const sign = delta > 0 ? '+' : '−';
      log(delta > 0 ? 'sys' : 'danger',
        `${def.icon} ${def.n}：本区双方已翻开卡牌各 ${sign}${Math.abs(delta)} 战力 → ${hit.join('、')}${blocked ? `（另有 ${blocked} 张因本区「免减攻」被拦下）` : ''}`);
    } else if (blocked) {
      log('sys', `${def.icon} ${def.n}：本区双方已翻开卡牌本应各 −${Math.abs(delta)} 战力，但 ${blocked} 张全部因本区「免减攻」被拦下（战力不变）。`);
    }
  }
}
// 回合结束摧毁（purge：如聚变反应炉）：每回合翻牌结算后摧毁本区域“全场”战力最低的卡（敌我混比、并列最低一并
// 摧毁）；带 `surv` 的卡不离场、改为永久降 N 战力。runLocTurnEndEffects（阶段 ⑤-0）调用，先于 fx.turnEnd。
function reactorPurge() {
  const st = state;
  for (let j = 0; j < 3; j++) {
    const def = locDef(j);
    if (!def.purge) continue;
    const zoneP = st.players.p.zones[j];
    const zoneA = st.players.a.zones[j];
    // ⚠️ un 占位卡与法术都不作为摧毁目标；ind 卡（佛体金刚石）**照常参与“最低战力”比较** —— 它成为最低时
    // 摧毁失败、本回合不再波及别的牌（如金刚石 6 + 辉夜 8：最低＝金刚石 → 失败 → 辉夜存活）
    const all = zoneP.concat(zoneA).filter((c) => !c.def.un && !c.def.spell);
    if (all.length === 0) continue;
    if (locNoDestroy(j)) { log('danger', `⚡ ${def.n}：本区域存在免摧毁效果（地形「睡鼠神祠」或「蕾蒂」等），所有卡牌均无法被摧毁，本次跳过。`); continue; }
    let min = Infinity;
    for (const c of all) min = Math.min(min, cardPowerIn(j, c));
    const doomed = all.filter((c) => cardPowerIn(j, c) === min);
    const removed = [];
    for (const c of doomed) {
      if (indestructibleBlock(c, def.n)) continue;
      if (phoenixRevive(c, j)) continue; // 凤凰重生：回手 +N 战力
      if (surviveDestroy(c)) continue; // 防摧毁：替代为降战力、卡不离场
      recordDestroy(c, j, def.n);
      playShatter(c);
      const inP = zoneP.indexOf(c) >= 0;
      if (inP) zoneP.splice(zoneP.indexOf(c), 1);
      else zoneA.splice(zoneA.indexOf(c), 1);
      dequeueField(c);
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
  let shatteredN = 0;
  for (let j = 0; j < 3; j++) {
    const def = st.locs[j].def;
    // ⚠️ 已破碎的区域**不计分、不参与胜负、也不显示点数比大小**，且刻意不写原地形名（与棋盘上“看不出原来是
    // 什么地形”一致；原地形名在它被摧毁那一刻的日志里已记过）。
    if (st.locs[j].shattered) {
      shatteredN++;
      lines.push(`⚡ 区域 ${j + 1}：<b>已破碎</b>（已被「天界」摧毁 —— 不计分、不参与胜负）`);
      continue;
    }
    const rawP = zoneTotals('p', j) * def.dbl;
    const rawA = zoneTotals('a', j) * def.dbl;

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
  const hasInv = st.locs.some((l) => !l.shattered && l.def.inv);
  const aliveN = 3 - shatteredN;
  let delta = 0, title, sub, emblem;
  if (tie > 0) {

    sub = shatteredN
      ? `已被摧毁 ${shatteredN} 个区域 → 仅剩 ${aliveN} 个可用区域，且为平局 → 按剩余区域总点数决胜：你 ${pTotal} : ${aTotal} 对手`
      : `存在平局区域 → 三区总点数决胜：你 ${pTotal} : ${aTotal} 对手${hasInv ? '（反转区域按负值计入总点数）' : ''}`;
    if (pTotal > aTotal) { delta = st.stakes; title = '你赢了！'; emblem = '🏆'; }
    else if (aTotal > pTotal) { delta = -st.stakes; title = '你输了…'; emblem = '💀'; }
    else { title = '平局'; emblem = '🤝'; sub += ' · 总点数相同'; }
  } else {

    sub = shatteredN
      ? `已被摧毁 ${shatteredN} 个区域 → 仅剩 ${aliveN} 个可用区域，按赢下区域数决胜：你 ${pw} : ${aw} 对手`
      : `无平局区域 → 按赢下区域数决胜：你 ${pw} : ${aw} 对手`;
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

  $('btnPass').textContent = state.playerMoves.length > 0 ? '结束回合' : '跳过回合';
  // 开发调试显示「指定地形 / 指定卡牌 / 切换立场 / 查看对手」并隐藏图鉴；正常对局反之
  const dev = isDevMode();
  const energyBtn = $('btnEnergyDev');
  const pickLocBtn = $('btnPickLoc');
  const pickBtn = $('btnPick');
  const codexBtn = $('btnCodex');
  const switchBtn = $('btnSwitchSide');
  const spyBtn = $('btnAiSpy');
  if (energyBtn) energyBtn.classList.add('hidden');
  if (pickLocBtn) pickLocBtn.classList.toggle('hidden', !dev);
  const addStoneBtn = $('btnAddStone');
  if (addStoneBtn) addStoneBtn.classList.toggle('hidden', !dev);
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
  // 顶栏「回合 N / 总数」的总数读本局总回合数：「虚假之月」在场 → /7（被换掉则回 /6，第 7 回合锁定为 7）
  const turnMaxEl = $('turnMax');
  if (turnMaxEl) turnMaxEl.textContent = '/ ' + roundsTotal();
  $('energyVal').textContent = en.energyLeft;
  $('energyUnit').textContent = `/ ${en.energyTotal}`;
  // 本回合能量里由「额外能量」多出来的部分（如斯塔萨菲雅 → 下回合 +1）
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
  // 能量槽只画「本回合当前可用能量」的条数（不补灰色占位）：出牌花掉后条数随之减少，用完一条不画；
  // 上限口径跟随 `energyLeft`，故开发调试的 10 点、哆来咪的 7 点等都能如实显示。
  const ep = $('energyPips');
  ep.innerHTML = '';
  const pipN = Math.max(0, en.energyLeft | 0);
  for (let i = 0; i < pipN; i++) {
    const d = document.createElement('div');
    d.className = 'pip on';
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

    const head = document.createElement('div');
    head.className = 'loc-head';
    head.innerHTML = `<div class="loc-name"><span><span class="icon">${loc.def.icon}</span> ${loc.def.n}</span></div>`;
    col.appendChild(head);

    const opp = document.createElement('div');
    opp.className = 'zone opp';
    opp.innerHTML = `<div class="slot-row quad"></div>`;
    col.appendChild(opp);

    const mid = document.createElement('div');
    mid.className = 'loc-mid';
    mid.innerHTML = `
      <div class="loc-total opp-total"><span class="lt-label">对手</span><span class="lt-num" data-side="a">0</span><span class="lt-unit">点</span></div>
      <div class="loc-effect"><span class="le-icon">${loc.def.icon}</span>${loc.def.eff}</div>
      <div class="loc-total my-total"><span class="lt-label">你</span><span class="lt-num" data-side="p">0</span><span class="lt-unit">点</span></div>`;
    col.appendChild(mid);

    const mine = document.createElement('div');
    mine.className = 'zone mine player-zone';
    mine.innerHTML = `<div class="slot-row quad"></div><div class="slot-count"></div>`;
    col.appendChild(mine);

    col.addEventListener('click', () => {
      if (!tryMoveFlyTo(idx)) tryPlayAt(idx);
    });
    col.addEventListener('mouseenter', () => {
      if (state.phase === 'play' && state.selected >= 0 && canPlaceP(idx)) col.classList.add('active-hover');
    });
    col.addEventListener('mouseleave', () => col.classList.remove('active-hover'));

    board.appendChild(col);
    if (loc.def.id === 'unreveal') addUnrevealDecor(col); // 未揭示列：散落地形小图标
    els.cols.push(col);
    els.oppZone.push(opp.querySelector('.slot-row'));
    els.mineZone.push(mine.querySelector('.slot-row'));
    els.totA.push(mid.querySelector('[data-side="a"]'));
    els.totP.push(mid.querySelector('[data-side="p"]'));
  });
  Game._els = els;
  // 已「破碎」的列整列换成损坏面板（防御；正常 restart 会先把 locs 全重置为未揭示）—— 与
  // shatterZoneTerrain 走同一个渲染出口。
  state.locs.forEach((loc, idx) => { if (locShattered(idx)) renderShatteredColumn(idx); });
}

// 区域被“变形”（如鬼人正邪 → 辉针城）后刷新该列的标题 / 图标 / 效果文字 / 配色 class；
// 该列已「破碎」则整列换成损坏面板（无列名 / 效果文字 / 点数 / 格位）。
function refreshLocHeader(locIdx) {
  if (locShattered(locIdx)) { renderShatteredColumn(locIdx); return; }
  const col = Game._els.cols[locIdx];
  if (!col) return;
  const def = locDef(locIdx);
  col.className = 'location ' + def.id;
  const nameEl = col.querySelector('.loc-name');
  if (nameEl) nameEl.innerHTML = `<span><span class="icon">${def.icon}</span> ${def.n}</span>`;
  const effEl = col.querySelector('.loc-effect');
  if (effEl) effEl.innerHTML = `<span class="le-icon">${def.icon}</span>${def.eff}`;
  syncUnrevealDecor(col, def);
}

/* ---- 未揭示列装饰：在列上随机散布地形池所有地形的小图标（含 ❓），低透明度 + 轻微漂浮，
   从视觉上表达“这一块可能是随机池里任意一种地形”；每次开局随机布局。 */
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
  if (!playReqCheck(playSide(), card).ok) return false;
  if (occOf(card) > 1 && !occZoneOk(card, idx, playSide())) return false; // 大体积卡需该侧可用格数恰为占格数
  return sideRoom(playSide(), idx) >= occOf(card);
}

function miniCardEl(card, locIdx, side) {
  const el = document.createElement('div');
  el.className = 'mini-card' + (card.justRevealed ? ' played-now' : '');
  el.dataset.cardid = String(card.id);
  if (card.justRevealed) card.justRevealed = false;
  if (card.justSpawned) { el.classList.add('spawned-now'); card.justSpawned = false; } // 生成演出
  const grad = card.revealed ? gradOf(card.def) : BACK_GRAD;
  el.style.setProperty('--cgrad', grad);
  // 「封印」（卡级永久抹除）：卡面叠 ❗ 并置灰 —— 暗牌也标（封印是对局公开信息，标记不属于暗牌内容）
  const sealed = cardSealed(card);
  const sealHtml = sealed ? '<span class="mc-seal">❗</span>' : '';
  if (sealed) el.classList.add('sealed');
  if (!card.revealed) {
    el.innerHTML = `<span class="mc-q">?</span><span class="mc-tag">暗牌</span>${sealHtml}`;
  } else {
    // 已翻开：左上角费用、右上角当前战力（含区域加成，升降相对基础威力着色）
    const live = cardPowerIn(locIdx, card);
    const net = card.buff + locRoleBonus(locIdx, card) + locCostBonus(locIdx, card) + locAllBonus(locIdx, card);
    const cls = live > card.def.p ? ' up' : live < card.def.p ? ' down' : '';
    // 费用修正着色：高于印刷费用红色、低于则绿色
    const liveCost = cardCost(card);
    const costCls = liveCost > card.def.c ? ' up' : liveCost < card.def.c ? ' down' : '';
    // 法术（实际战力恒为 0）不显示战力，右上角改显「✦」星标（只画一个、不写「法术」二字）
    const spell = isSpell(card);
    if (spell) el.classList.add('spell');
    const topRight = spell ? '<span class="mc-spell" title="法术 · 无战力（揭示后消散）">✦</span>' : `<span class="p${cls}">${live}</span>`;
    const modHtml = (!spell && net !== 0) ? `<span class="mc-mod">${net > 0 ? '+' : ''}${net}</span>` : '';
    if (card.def.img) {
      el.classList.add('has-art');
      el.innerHTML = `<span class="mc-cost${costCls}">${liveCost}</span>${topRight}
        <span class="mc-icon">${card.def.i}</span>
        <img class="mini-img" src="assets/cards/${encodeURIComponent(card.def.img)}" alt="${card.def.n}" loading="lazy" draggable="false"/>
        <span class="mc-shade"></span>
        <span class="mc-name">${card.def.n}</span>
        ${modHtml}${sealHtml}`;
    } else {
      el.innerHTML = `<span class="mc-cost${costCls}">${liveCost}</span>${topRight}
        <span class="mc-icon">${card.def.i}</span>
        <span class="mc-name">${card.def.n}</span>
        ${modHtml}${sealHtml}`;
    }
    // 己方“每回合可移动一次”的已翻开卡（如射命丸文）：出牌阶段点击进入移动；
    // ⚠️ 失去卡牌文字（封印 ∪ 静海）的牌失去该能力，不再提示 / 不进入移动模式
    const canFly = side === 'p' && state.phase === 'play' && card.def.fly && card.revealed && !state.flyMoved.has(card.id) && !cardMuted(card);
    if (canFly) {
      el.classList.add('can-fly');
      if (state.moveCardId === card.id) el.classList.add('fly-moving');
      const badge = document.createElement('span');
      badge.className = 'mc-fly';
      badge.textContent = '⇄ 移动';
      el.appendChild(badge);
    }
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
    // 已破碎的列整列交给 renderShatteredColumn（损坏面板）：这里跳过，既不改它的 DOM，
    // 也不参与领先着色与格位渲染。
    if (locShattered(j)) continue;
    Game._els.oppZone[j].innerHTML = '';
    Game._els.mineZone[j].innerHTML = '';
    for (const child of buildZoneChildren('a', j)) Game._els.oppZone[j].appendChild(child);
    for (const child of buildZoneChildren('p', j)) Game._els.mineZone[j].appendChild(child);
    // 中间带总点数：当前受效果影响后的最终战力（横幅显示真实点数）
    const dbl = locDef(j).dbl;
    const ta = zoneTotals('a', j) * dbl;
    const tp = zoneTotals('p', j) * dbl;
    Game._els.totA[j].textContent = ta;
    Game._els.totP[j].textContent = tp;
    // 谁领先谁亮黄（反转区域按有效口径：真实战力更低的一方亮黄）；平点则双方蓝色
    const eA = locDef(j).inv ? -ta : ta;
    const eP = locDef(j).inv ? -tp : tp;
    const pillA = Game._els.totA[j].closest('.loc-total');
    const pillP = Game._els.totP[j].closest('.loc-total');
    pillA.classList.toggle('lead', eA > eP);
    pillP.classList.toggle('lead', eP > eA);
    const mineZoneEl = Game._els.mineZone[j].parentElement;
    const ldef = locDef(j);
    // 分母用**该侧可用格数**（＝地形 max − 该侧已封隙间数），被隙间封掉的格不算可用
    const count = sideUsed('p', j) + '/' + locSideMax('p', j);
    let locTag = '';
    if (ldef.id === 'unreveal') locTag = ` · 🃏 第 ${j + 1} 回合揭晓`;
    else if (ldef.minTurn && !locOpen(j)) locTag = ` · 🔒 第 ${ldef.minTurn} 回合开放`;
    if (locGaps('p', j)) locTag += ` · ≋ 隙间 ${locGaps('p', j)}`; // 本侧被隙间封掉几格
    mineZoneEl.querySelector('.slot-count').textContent = `已放 ${count}${locTag}`;
    mineZoneEl.parentElement.classList.toggle('hoverable', canPlaceP(j));
    Game._els.cols[j].classList.toggle('locked', !!locDef(j).minTurn && !locOpen(j));
  }
  flushBuffFlash();
  flushCostFlash();
  flushRetriggerFx();
  renderPiles();
}

/* 把区域一侧的 2×2 格位按规则填充：已放卡永远占其格位（含揭晓后超过上限的卡：不删除、不移动）；空位且属于
   允许格（i < 该侧可用格数）则 max=4 用浅灰虚线格、max<4 用透明占位；不允许格固定铺「隙间」灰色卡（只铺在
   “空置”的不可用格）。
   ⚠️「可用格数」= 地形 max − **该侧**已封隙间数（locSideMax，双方各记一份）：换地形时清空，「八云紫的家」
   每回合末从后往前各封一格，封出来的正是这里渲染的隙间。 */
function buildZoneChildren(side, locIdx) {
  const def = locDef(locIdx);
  const sideMax = locSideMax(side, locIdx); // 该侧可用格数（含隙间封格）
  const cards = state.players[side].zones[locIdx];
  const out = [];
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
    if (card) { out.push(miniCardEl(card, locIdx, side)); continue; }
    if (i >= sideMax) {
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
  el.addEventListener('click', (e) => e.stopPropagation());
  return el;
}

/* ---- 把「加入手牌」的卡**立刻**渲染出来，让「滑入」演出（`.hand-new`）真的能被看到 ----
   `.hand-new` 由 renderHand 在下一次渲染时加上、**加完即清标记**，而 give 的结算点在阶段 ④（那时只 `renderZones()`），
   手牌要等回合末；偏偏紧接着**同一个同步任务内** `st.turn++ → playRound → roundStartStage()` 又会 `renderAll()`
   整块重建手牌 ⇒ 带 `.hand-new` 的元素**一次都没被浏览器绘制就被替换掉**，动画时长实际为 0。
   口径：只对**玩家侧**调用（对手手牌只有侧栏计数，回合末 renderAll 会刷新）。 */
function flushHandAdd(side) {
  if (side !== 'p') return;
  renderHand();
}

function renderHand() {
  const st = state;
  const hand = $('hand');
  const prevScroll = hand.scrollLeft;
  hand.innerHTML = '';
  const cards = st.players.p.hand;
  updateHandCount();
  let drewEntry = false;
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
    if (cardSealed(card)) el.classList.add('sealed'); // 封印：效果文字置灰划线 + 艺术区叠 ❗
    const afford = cardCost(card) <= st.players.p.energyLeft;
    if (!afford) el.classList.add('unaffordable');
    // 卡级放置条件（`playReq`，现仅 6 费「大鲶鱼」）不满足时同样置灰并给数量提示：
    // “费用够但条件不够”，点击后 tryPlayAt 会说明现 N 张、不会白扣能量。
    const reqR = playReqCheck('p', card);
    if (!reqR.ok) {
      el.classList.add('unaffordable');
      el.title = `放置条件未满足：需要你的场上已有至少 ${reqR.need} 张已翻开的「${reqR.label}」（现 ${reqR.have} 张）`;
    }
    if (st.selected === index) el.classList.add('selected');
    if (card.justHandAdded) { el.classList.add('hand-new'); card.justHandAdded = false; }
    if (card.justDrawn) { el.classList.add('hand-drawn'); card.justDrawn = false; drewEntry = true; }
    if (st.phase !== 'play' && st.phase !== 'over') el.classList.add('unaffordable');
    el.style.setProperty('--cgrad', gradOf(card.def));
    const handPow = cardPower(card);
    const handSign = handPow > card.def.p ? 'up' : handPow < card.def.p ? 'down' : '';
    const handCost = cardCost(card);
    const handCostSign = handCost > card.def.c ? 'up' : handCost < card.def.c ? 'down' : '';
    const faceOpts = { power: handPow, sign: handSign, cost: handCost, costSign: handCostSign, sealed: cardSealed(card) };
    el.innerHTML = cardFaceHTML(card.def, faceOpts);
    el.addEventListener('click', () => {
      if (st.phase === 'over') showHandCard(card);
      else selectHand(index);
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showHandCard(card);
    });
    hand.appendChild(el);
  });
  hand.scrollLeft = prevScroll;
  if (drewEntry) lockDrawAnimScroll(hand);
}

function updateHandCount() {
  const el = $('handCountVal');
  if (el) el.textContent = state.players.p.hand.length + '/7';
}

function updateDeckCount() {
  const el = $('deckCountVal');
  if (el) el.textContent = '牌库 ' + state.players.p.deck.length;
}

let drawAnimTimer = null;
function lockDrawAnimScroll(hand) {
  hand.classList.add('draw-anim');
  if (drawAnimTimer) clearTimeout(drawAnimTimer);
  drawAnimTimer = setTimeout(() => {
    hand.classList.remove('draw-anim');
    drawAnimTimer = null;
  }, 750);
}

function cardFaceHTML(def, opts) {
  opts = opts || {};
  const power = opts.power !== undefined ? opts.power : def.p;
  const sign = opts.sign ? ' ' + opts.sign : '';
  // 费用角标支持「本场战斗修正」：opts.cost / opts.costSign 缺省＝印刷费用且不着色
  const cost = opts.cost !== undefined ? opts.cost : def.c;
  const costSign = opts.costSign ? ' ' + opts.costSign : '';
  // 「封印」：❗ 叠在艺术区（图片 / emoji 兜底块）正中 —— 手牌、三池面板与放大卡面共用本函数
  const seal = opts.sealed ? '<span class="hc-seal">❗</span>' : '';
  const art = def.img
    ? `<div class="hc-art">
        <span class="hc-icon hc-art-emoji">${def.i}</span>
        <img class="hc-img" src="assets/cards/${encodeURIComponent(def.img)}" alt="${def.n}" loading="lazy" draggable="false"/>
        ${seal}
      </div>`
    : `<div class="hc-icon">${def.i}${seal}</div>`;
  return `<div class="hc-top"><span class="cost-orb${costSign}">${cost}</span>${isSpellDef(def) ? '<span class="hc-spell" title="法术 · 无战力（揭示后消散）">✦</span>' : `<span class="p${sign}">${power}</span>`}</div>
    ${art}
    <div class="hc-name">${def.n}</div>
    <div class="hc-text">${def.t || '—'}</div>`;
}

function uiOnCodex() { if (window.CardBrowser) window.CardBrowser.toggleCodex(); }
function closeCodex() { if (window.CardBrowser) window.CardBrowser.closeCodex(); }
function uiOnPick() { if (window.CardBrowser) window.CardBrowser.togglePick(); }
function uiOnPickClose() { if (window.CardBrowser) window.CardBrowser.closePick(); }

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

// 开发调试「切换立场」——落牌进敌方区 / 恢复我方（跨回合保持，直到再点或重开）
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

/* ---------- 开发者「指定地形」（区域 2/3 选不中已修）----------
   ⚠️ 区域按钮必须**直接绑定**（事件委托仅兜底）；选择条放标题下方 —— 放弹窗底部会被 .codex-modal 的 max-height 裁掉且遮罩不可滚动，点不到。 */
const PICK_LOC_ZONE_TXT = ['区域 1（左）', '区域 2（中）', '区域 3（右）'];
let pickLocDefId = null;
let pickLocZoneIdx = 0;

function uiOnPickLoc() {
  if (!isDevMode()) return;
  const mask = $('pickLocMask');
  if (!mask) return;
  if (mask.classList.contains('hidden')) openPickLoc();
  else closePickLoc();
}
function locTextAt(idx) {
  if (locShattered(idx)) return '💥 已破碎（不可更换）';
  const def = state.locs[idx] && state.locs[idx].def;
  return def ? (def.icon + ' ' + def.n) : '未揭示';
}
function pickLocZoneText(idx) {
  return PICK_LOC_ZONE_TXT[idx] || ('区域 ' + (idx + 1));
}
function selectPickLocZone(idx) {
  const i = Number(idx);
  if (!Number.isFinite(i) || i < 0 || i > 2) return;
  pickLocZoneIdx = i;
  syncPickLocZones();
  updatePickLocTip();
}
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
      '<span class="lpc-meta">上限 ' + def.max + (def.inv ? ' · 反转' : '') + (def.purge ? ' · 回合末摧毁' : '') + (def.grow ? ' · 回合末成长' : '') + (def.decay ? ' · 回合末衰减' : '') + (def.gamble ? ' · 翻开随机±' : '') + (def.dice ? ' · 第' + def.dice.turn + '回合掷骰' : '') + (def.rally ? ' · 第' + def.rally.turn + '回合+' + def.rally.add : '') + (def.gust ? ' · 揭示后吹飞' : '') + (def.collapse ? ' · ' + def.collapse.cards + '张牌后崩塌' : '') + (def.prot ? ' · 区域免摧毁' : '') + (def.xformTurn ? ' · 第' + def.xformTurn.turn + '回合变形' : '') + (def.gap ? ' · 回合末各封 ' + def.gap + ' 格隙间' : '') + (def.noDown ? ' · 区域免减攻' : '') + (def.mute ? ' · 抹除卡牌文字' : '') + (def.extraRound ? ' · 本局+' + def.extraRound + ' 回合' : '') + (def.shatter ? ' · 出现时摧毁另外两块地形' : '') + (def.repeatReveal ? ' · 揭示重复触发' : '') + (def.spawn ? (def.spawn.cost != null ? ' · 出现生成随机' + def.spawn.cost + '费卡' : ' · 出现生成特殊卡') : '') + '</span>';
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
// ⚠️ 本函数**保持同步** —— 换上「天界」时只启动摧毁链、不在这里等它（弹窗必须立刻关）。
function uiOnPickLocConfirm() {
  if (!isDevMode()) return;
  const def = pickLocDefId ? findLocDef(pickLocDefId) : null;
  if (!def) { updatePickLocTip('还没选地形：请在下方点选一种地形，再点「替换」。'); return; }
  const locIdx = pickLocZoneIdx;
  if (locIdx < 0 || locIdx > 2 || !state.locs[locIdx]) {
    updatePickLocTip('请先在上方选中要替换的区域（1 / 2 / 3）。');
    return;
  }
  // ⚠️ 已破碎的区域**永久锁定** —— 任何路径（含开发者工具）都不能再给它换地形
  if (locShattered(locIdx)) {
    updatePickLocTip('区域 ' + (locIdx + 1) + ' 已被「天界」摧毁（已破碎）：永久锁定，不能再指定地形。需要重试请先「重新开始」。');
    return;
  }
  const prev = state.locs[locIdx].def;
  const spawnChk = $('pickLocSpawn');
  const wantSpawn = !spawnChk || spawnChk.checked; // 默认结算「出现时」效果（可勾掉）
  // 同步 locPlan，否则后续揭晓会把旧计划盖回来
  state.locs[locIdx].def = def;
  resetLocGaps(locIdx); // 换地形 → 清空本列已封的隙间
  if (state.locPlan && state.locPlan.length > locIdx) state.locPlan[locIdx] = def;
  refreshLocHeader(locIdx);
  const spawnNote = !wantSpawn
    ? '（按设置不结算「出现时」效果）'
    : (def.spawn ? '（结算「出现时」效果）' : '（该地形没有「出现时」效果）');
  log('sys', '🗻 开发者指令：将区域 ' + (locIdx + 1) + '「' + (prev ? prev.n : '?') + '」替换为「' + def.n + '」' + spawnNote + '。');
  // 与地形揭晓走同一结算路径（虹龙洞等「出现时」效果）；换上「天界」时同时启动摧毁另外两块地形的演出链
  const spawnCount = wantSpawn ? runLocAppearEffect(locIdx, def) : 0;
  // 换上/换掉「虚假之月」→ 本局总回合数当场变（顶栏即时刷新）
  syncRoundTotal('开发者指定地形');
  // ⚠️ 这里**刻意不等** `awaitShatterChain()` —— 开发者工具必须**立刻关窗**：演出在后台自己逐张 renderZones 并收尾重绘，
  //    若在此 await，弹窗会一直挂到两块都拆完。注：正常对局的四条路径（揭晓 / xformTurn / collapse / 卡牌 xform）**仍然会等**。
  renderZones();
  setStatus('区域 ' + (locIdx + 1) + ' 已替换为「' + def.n + '」'
    + (spawnCount > 0 ? '，并结算了「出现时」生成（共 ' + spawnCount + ' 张）。' : '。')
    + ((def.shatter && shatterChain) ? '「天界降临」演出进行中：另外两块区域正在被逐个摧毁…' : ''));
  closePickLoc(); // 立刻收起弹窗（演出在后台继续）
}

/* ---------- 开发者「🪨 添加石块」：某区域**双方各 N 张**（入口 #btnAddStone，仅开发调试显示）----------
   口径与「虹龙洞 / 黄瓜田 / 幽灵洋馆」的「区域出现时：双方各生成 N 张」完全同款，统一走 placeToken
   （落地即翻开、占格位、进 fieldQueue、播「凝聚显形」演出），因此照常尊重限张地形 / 隙间封格 /
   大体积卡占满整侧 / 已破碎区域（恒 0 格 ⇒ 一张也放不下，会明确提示）。
   ⚠️ 它不是“出现时”效果、不走 runLocAppearEffect、不触发任何 spawn（不会连锁别的机制）；N 夹在 1..4。 */
const ADD_STONE_MAX = 4;
let addStoneZoneIdx = 0;

function uiOnAddStone() {
  if (!isDevMode()) return;
  const mask = $('addStoneMask');
  if (!mask) return;
  if (mask.classList.contains('hidden')) openAddStone();
  else closeAddStone();
}
function openAddStone() {
  addStoneZoneIdx = 0;
  const input = $('addStoneCount');
  if (input) input.value = '1';
  bindAddStoneZoneButtons();
  bindAddStoneSteppers();
  syncAddStoneZones();
  updateAddStoneTip();
  const mask = $('addStoneMask');
  if (mask) mask.classList.remove('hidden');
}
function closeAddStone() {
  const mask = $('addStoneMask');
  if (mask) mask.classList.add('hidden');
}
function uiOnAddStoneClose() { closeAddStone(); }

// 读输入框的数量：夹在 1..ADD_STONE_MAX（非法/空输入回落到 1）。
// ⚠️ 刻意**不在这里回写** `input.value` —— 否则用户清空输入框准备重打时会被立刻填回 "1"、光标也会跳；回写只在「步进 / 失焦 / 确认」三处。
function readAddStoneCount() {
  const input = $('addStoneCount');
  let n = input ? parseInt(input.value, 10) : 1;
  if (!Number.isFinite(n)) n = 1;
  return Math.max(1, Math.min(ADD_STONE_MAX, n));
}
function stepAddStone(d) {
  const input = $('addStoneCount');
  if (!input) return;
  input.value = String(Math.max(1, Math.min(ADD_STONE_MAX, readAddStoneCount() + d)));
  updateAddStoneTip();
}
function bindAddStoneSteppers() {
  const minus = $('addStoneMinus');
  const plus = $('addStonePlus');
  if (minus && minus.dataset.bound !== '1') { minus.dataset.bound = '1'; minus.addEventListener('click', () => stepAddStone(-1)); }
  if (plus && plus.dataset.bound !== '1') { plus.dataset.bound = '1'; plus.addEventListener('click', () => stepAddStone(1)); }
}
function selectAddStoneZone(idx) {
  const i = Number(idx);
  if (!Number.isFinite(i) || i < 0 || i > 2) return;
  addStoneZoneIdx = i;
  syncAddStoneZones();
  updateAddStoneTip();
}
function bindAddStoneZoneButtons() {
  const row = $('addStoneZones');
  if (!row) return;
  row.querySelectorAll('.plz-btn').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => selectAddStoneZone(btn.getAttribute('data-loc')));
  });
}
function syncAddStoneZones() {
  const row = $('addStoneZones');
  if (!row) return;
  row.querySelectorAll('.plz-btn').forEach((btn) => {
    const idx = Number(btn.getAttribute('data-loc'));
    const on = idx === addStoneZoneIdx;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.textContent = pickLocZoneText(idx);
    btn.title = '把石块加到 ' + pickLocZoneText(idx) + '（当前 ' + locTextAt(idx) + '；双方各一份）';
  });
  syncAddStoneSteppers();
}
/** 步进按钮在边界置灰（1 / 4）：syncAddStoneZones 与 updateAddStoneTip 都会调用，任何改值途径都能立刻跟着置灰/解禁。 */
function syncAddStoneSteppers() {
  const n = readAddStoneCount();
  const minus = $('addStoneMinus');
  const plus = $('addStonePlus');
  if (minus) minus.disabled = n <= 1;
  if (plus) plus.disabled = n >= ADD_STONE_MAX;
}
function updateAddStoneTip(warn) {
  const tip = $('addStoneTip');
  const note = $('addStoneNote');
  const idx = addStoneZoneIdx;
  const n = readAddStoneCount();
  const zoneTxt = pickLocZoneText(idx);
  const okBtn = $('btnAddStoneConfirm');
  const shattered = locShattered(idx);
  syncAddStoneSteppers(); // ⚠️ 必须放最前面：后面有几条 return，直接改值时两个箭头也要立刻刷新
  if (okBtn) okBtn.textContent = shattered ? '该区域已破碎（不可添加）' : ('给 ' + zoneTxt + ' 双方各加 ' + n + ' 张');
  if (tip) {
    if (warn) { tip.textContent = warn; tip.classList.add('warn'); }
    else {
      tip.textContent = '目标：' + zoneTxt + '（现在 ' + locTextAt(idx) + '） · 双方各 ' + n + ' 张';
      tip.classList.remove('warn');
    }
  }
  if (!note) return;
  if (shattered) {
    note.textContent = '⚠️ 该区域已被「天界」摧毁（已破碎）：一格不剩，石块放不下。';
    return;
  }
  const rp = sideRoom('p', idx);
  const ra = sideRoom('a', idx);
  let text = '该区域空位：你方还能放 ' + rp + ' 张 · 敌方还能放 ' + ra + ' 张';
  if (rp < n || ra < n) text += '。⚠️ 空位不足的部分会按实际可放张数少放（日志里会写明）。';
  note.textContent = text;
}
function uiOnAddStoneConfirm() {
  if (!isDevMode()) return;
  const idx = addStoneZoneIdx;
  if (idx < 0 || idx > 2 || !state.locs[idx]) { updateAddStoneTip('请先在上方选中目标区域（1 / 2 / 3）。'); return; }
  if (locShattered(idx)) { updateAddStoneTip('区域 ' + (idx + 1) + ' 已被「天界」摧毁（已破碎）：一格不剩，石块放不下。'); return; }
  const tk = TOKENS.stone;
  if (!tk) { updateAddStoneTip('找不到 `SPECIAL.stone` 的卡牌定义，无法生成石块。'); return; }
  const input = $('addStoneCount');
  if (input) input.value = String(readAddStoneCount());
  const n = readAddStoneCount();
  const made = [];
  const placedP = placeToken('p', idx, tk, n, made);
  const placedA = placeToken('a', idx, tk, n, made);
  const short = (placedP < n || placedA < n);
  renderAll();
  log('sys', `🪨 开发者指令：给「${locDef(idx).n}」区域**双方各生成 ${n} 张「${tk.n}」** → 你方实际 ${placedP} 张、敌方实际 ${placedA} 张（落地即翻开、占格位、进放置队列；该侧放满则少放）。`);
  setStatus(`区域 ${idx + 1}：双方各生成 ${n} 张石块 —— 你方 ${placedP} 张、敌方 ${placedA} 张`
    + (short ? '（空位不足，已按实际可放张数生成）' : '') + '。');
  closeAddStone();
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
  if (def.give) {
    add(def.give.card);
    // give 的 `pool` 写法（如辉夜从 5 张神宝里随机抽 2 张）—— 池内卡片一并列出
    if (Array.isArray(def.give.pool)) for (const k of def.give.pool) add(k);
  }
  if (def.spawn) add(def.spawn.card);
  if (def.spawnO) add(def.spawnO.card); // 如键山雏 → 厄运
  if (def.spawnS) add(def.spawnS.card); // 如祖母绿巨石（法术）→ 同名的 1 费 / 3 战力占位卡
  if (def.spawnMine) add(def.spawnMine.card);
  if (def.shuffleIn) add(def.shuffleIn.card); // 洗入卡组 → 被洗入的牌也列进「衍生/相关卡牌」
  if (def.clone) add(def.clone.card);
  // 集结（gather）：把该阵营的成员卡也列进来，方便看出这张法术会生成谁
  if (def.gather && def.gather.group) {
    for (const m of gatherMembers(def.gather.group)) {
      if (m && list.indexOf(m) < 0) list.push(m);
    }
  }
  // 帕秋莉法术池：池写在 fx.turnStart.pool，卡级 spellPool 兜底
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

// 效果分类标签：揭示键中文名 + 卡级持续机制（prot / og / surv / phx / leave / occ / fly 等非 k 字段）—— 避免把带持续／防护机制的卡误标成「白板」
function kindTags(def) {
  const parts = [];
  if (def.spell) parts.push('法术 · 无战力（揭示后消散）');
  if (def.prot) parts.push('持续 · 区域免摧毁');
  // 自身不可摧毁（ind，如佛体金刚石）只保护它自己 —— ≠ 区域免摧毁、也 ≠ 防摧毁
  if (def.ind) parts.push('持续 · 自身不可摧毁');
  // og 的两种匹配口径：tk（强化指定 token）/ cost（强化己方指定费用的卡牌）
  if (def.og) parts.push((def.og.tk == null && def.og.cost != null) ? '持续 · 强化己方指定费用的卡牌' : '持续 · 强化指定 token');
  if (def.surv) parts.push('防摧毁');
  if (def.phx) parts.push('凤凰重生');
  if (def.leave) parts.push('终局离场');
  if (def.occ) parts.push('大体积占格');
  if (def.fly) parts.push('每回合移动一次');
  if (def.fx) {
    if (def.fx.turnStart) parts.push('回合开始 · 时机效果');
    if (def.fx.turnEnd) parts.push('回合结束 · 时机效果');
    if (def.fx.gameEnd) parts.push('游戏结束 · 时机效果');
  }
  if (def.gs) {
    const bits = [];
    if (def.gs.shuffleN) bits.push(`洗入 ${def.gs.shuffleN} 张随机牌`);
    if (def.gs.energyAdd) bits.push(`每回合最大能量 +${def.gs.energyAdd}`);
    parts.push('游戏开始时 · 在卡组中即触发' + (bits.length ? `（${bits.join('、')}）` : ''));
  }
  if (def.costDown) parts.push(`持续 · 双方每有一张牌被摧毁，此牌能量消耗 −${def.costDown}（最低 0 费）`);
  if (def.playReq) parts.push(`放置条件 · 仅当你场上已有 ≥ ${def.playReq.n || 1} 张已翻开的「${tokenNameLabel(def.playReq.tk)}」时可从手牌打出`);
  // 手牌回合结束（fx.handEnd）：只在**手牌里**生效，打到场上后不再触发 —— 故与 fx.turnEnd 分开标注
  if (def.fx && def.fx.handEnd) parts.push('手牌回合结束 · 仅当此牌仍在手牌中时触发（打到场上后不再生效）');
  const base = (def.k || !parts.length) ? (KIND_LABEL[def.k] || '') : '';
  if (base && parts.length) return base + '；' + parts.join('、');
  return base || parts.join('、');
}

/* 费用随摧毁递减（`costDown`，现仅 8 费「纯狐」）在放大视图里的补充说明行：写出「双方摧毁池合计」与
   「因此减了多少费」；没有该字段则返回空串。显示点两处：showHandCard 与 showFieldCard。 */
function costDownNote(def) {
  if (!def || !def.costDown) return '';
  const n = destroyCount();
  const cut = def.costDown * n;
  const atZero = cut >= def.c;
  return `<div class="zm-kind cost-mod-note">费用随摧毁递减（每张 −${def.costDown}）：本场战斗中双方已有 ${n} 张牌被摧毁 → 能量消耗 −${cut}${atZero ? '（已减到最低 0 费）' : ''}</div>`;
}

// 手牌放大查看：显示该实例的「当前战力」（基础 + 永久 buff，如凤凰重生后的妹红）；无战力影响历史面板
function showHandCard(card) {
  hidePowerPanel();
  const def = card.def;
  const live = cardPower(card);
  const diff = live - def.p;
  const sign = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
  const liveCost = cardCost(card);
  const costDiff = liveCost - def.c;
  const costSign = costDiff > 0 ? 'up' : costDiff < 0 ? 'down' : '';
  const slot = $('zoomCardSlot');
  slot.innerHTML = '';
  // 封印的牌在放大视图里同样置灰划线（复用 .text-muted 的既有观感）+ 艺术区叠 ❗
  const sealed = cardSealed(card);
  const el = document.createElement('div');
  el.className = 'zoom-card hand-card' + (sealed ? ' sealed text-muted' : '');
  el.style.setProperty('--cgrad', gradOf(def));
  el.innerHTML = cardFaceHTML(def, { power: live, sign, cost: liveCost, costSign, sealed });
  slot.appendChild(el);

  $('zoomInfo').innerHTML = `
    <div class="zoom-meta"><span class="zm-cost">费用 ${liveCost}</span>${isSpellDef(def) ? '<span class="zm-pow">法术 · 无战力</span>' : `<span class="zm-pow">当前威力 ${live}</span>`}</div>
    ${muteNoteHTML(card, -1)}
    ${costDiff !== 0 ? `<div class="zm-kind cost-mod-note">印刷费用 ${def.c} · 本场战斗费用修正 ${costDiff > 0 ? '+' : ''}${costDiff}（仅此一份卡有效）</div>` : ''}
    ${costDownNote(def)}
    ${isSpellDef(def)
      ? '<div class="zm-kind">法术：只有能量花费与「揭示」效果 —— 无战力，任何增减都不影响它；揭示结算完后自行消散</div>'
      : (diff !== 0 ? `<div class="zm-kind">基础威力 ${def.p} · 永久增益 ${diff > 0 ? '+' : ''}${diff}</div>` : `<div class="zm-kind">基础威力 ${def.p}</div>`)}
    <div class="zm-kind">${kindTags(def)}</div>
    <div class="zm-desc${sealed ? ' text-muted' : ''}">${def.t || (isSpellDef(def) ? '法术：只有能量花费与揭示效果，揭示结算完后自行消散。' : '平平无奇的白板卡，纯靠身材作战。')}</div>`;
  renderDeriv(def);
  zoomStageBtn('关闭 ✕');
  $('zoomMask').classList.remove('hidden');
}

/* ==================== 战力影响历史 ====================
   各行之和 = 实时战力 cardPowerIn。未来新增来源只需在 powerHistoryRows 追加收集段、并在改动 buff 的结算点调用 addBuffLog，UI 与着色自动覆盖。 */
function powerHistoryRows(card, locIdx) {
  const def = card.def;
  const loc = locDef(locIdx);
  const rows = [];
  if (isSpell(card)) return [{ d: 0, label: '法术（无战力）', kind: 'base' }];
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
  // 3) 持续效果（实时、分来源；源卡被摧毁/离场即不再列出）。判定口径必须与 cardAuraBonus 完全一致
  //    （tk 标记 / 印刷费用），否则本面板「合计战力 = 场上当前威力」不成立。
  for (let j = 0; j < 3; j++) {
    for (const c of state.players[card.side].zones[j]) {
      const og = c.def.og;
      if (!og || !c.revealed || c.def.un) continue;
      if (cardMuted(c)) continue; // 失去卡牌文字（封印 ∪ 静海）：与 cardAuraBonus 同口径（源卡被抹除则不计）
      const hit = (def.tk && og.tk === def.tk) || (og.cost != null && og.cost === def.c);
      if (hit) {
        const dv = (locNoDown(locIdx) && og.add < 0) ? 0 : og.add;
        if (dv) rows.push({ d: dv, kind: 'aura', label: c.def.n, sub: '持续效果' });
      }
    }
  }
  //    本区带 noDown（蓬莱药局）时**负的实时加成按 0 计** —— 与 cardPowerIn / cardAuraBonus 同口径，否则「面板合计 ≠ 场上当前威力」（第 3 段的持续效果同样处理）
  const noDown = locNoDown(locIdx);
  const fix = (v) => ((noDown && v < 0) ? 0 : v);
  if (loc.aff && def.g === loc.aff.group && fix(loc.aff.add)) rows.push({ d: fix(loc.aff.add), kind: 'loc', label: loc.n, sub: `区域加成（${GROUPS[loc.aff.group] || loc.aff.group}）` });
  if (loc.cb && def.c === loc.cb.c && fix(loc.cb.add)) rows.push({ d: fix(loc.cb.add), kind: 'loc', label: loc.n, sub: `区域加成（费用 ${loc.cb.c}）` });
  if (loc.all && fix(loc.all)) rows.push({ d: fix(loc.all), kind: 'loc', label: loc.n, sub: '区域效果' });
  return rows;
}

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

function showFieldCard(card, locIdx) {
  const def = card.def;
  const live = cardPowerIn(locIdx, card);
  const diff = live - def.p;
  const sign = diff > 0 ? 'up' : diff < 0 ? 'down' : '';
  // 失去卡牌文字：封印（永久）∪ 静海（实时）；感叹号只标封印（静海靠地形配色 + 本行提示）
  const sealed = cardSealed(card);
  const muted = cardMuted(card);
  // 区域「封锁揭示」（法界）：只封揭示 ⇒ 纯揭示牌的整条卡面文字都不生效，可整体置灰划线（混着持续 / 时机 / 防护的牌只多一行提示条）
  const strike = muted || (locNoReveal(locIdx) && revealOnlyCard(def));
  const liveCost = cardCost(card);
  const costDiff = liveCost - def.c;
  const costSign = costDiff > 0 ? 'up' : costDiff < 0 ? 'down' : '';
  const slot = $('zoomCardSlot');
  slot.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'zoom-card hand-card' + (strike ? ' text-muted' : '') + (sealed ? ' sealed' : '');
  el.style.setProperty('--cgrad', gradOf(def));
  el.innerHTML = cardFaceHTML(def, { power: live, sign, cost: liveCost, costSign, sealed });
  slot.appendChild(el);

  $('zoomInfo').innerHTML = `
    <div class="zoom-meta"><span class="zm-cost">费用 ${liveCost}</span>${isSpellDef(def) ? '<span class="zm-pow">法术 · 无战力</span>' : `<span class="zm-pow">场上威力 ${live}</span>`}</div>
    ${muteNoteHTML(card, locIdx)}
    ${revealBlockNoteHTML(card, locIdx)}
    ${costDiff !== 0 ? `<div class="zm-kind cost-mod-note">印刷费用 ${def.c} · 本场战斗费用修正 ${costDiff > 0 ? '+' : ''}${costDiff}（仅此一份卡有效）</div>` : ''}
    ${costDownNote(def)}
    <div class="zm-kind">${isSpellDef(def) ? '法术 · 无战力（揭示结算完后即自行消散）' : `基础威力 ${def.p}`}</div>
    <div class="zm-kind">${kindTags(def)}</div>
    <div class="zm-desc${strike ? ' text-muted' : ''}">${def.t || (isSpellDef(def) ? '法术：只有能量花费与揭示效果，揭示结算完后自行消散。' : '平平无奇的白板卡，纯靠身材作战。')}</div>`;
  renderDeriv(def);
  renderPowerHistory(card, locIdx);
  zoomStageBtn('关闭 ✕');
  $('zoomMask').classList.remove('hidden');
}

function closeZoom() {
  $('zoomMask').classList.add('hidden');
  hidePowerPanel();
}

function renderSide() {
  const st = state;
  $('aiCount').textContent = st.players.a.hand.length;
  $('aiDeck').textContent = st.players.a.deck.length;
  updateDeckCount();
  $('aiSnapTag').classList.toggle('hidden', !st.aSnapped);
  const enRow = $('aiEnergyRow');
  const enA = st.players.a;
  if (enRow) {
    enRow.classList.toggle('hidden', !isDevMode());
    if (isDevMode()) {
      const v = $('aiEnergyVal');
      const u = $('aiEnergyUnit');
      const gA = enA.energyGain || 0; // 额外能量提示（如斯塔萨菲雅给对手的下回合 +1）
      if (v) v.textContent = enA.energyLeft;
      if (u) u.textContent = '/ ' + enA.energyTotal + (gA ? ` (+${gA})` : '');
    }
  }
  // 若情报弹窗开着，牌数变化时同步刷新内容
  const spy = $('aiSpyMask');
  if (spy && !spy.classList.contains('hidden')) renderAiSpy();
}

/* ---------- 查看对手手牌 / 牌库 ---------- */
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

/* ==================== 特殊牌池（侧栏入口 + 弹窗） ====================
   数据侧见 PILE_KINDS / pushToPile / recordDestroy / recordSpellExile，这里只做界面：入口 #pileCard（地形区域
   下方、对手信息上方）两个按钮分别打开**己方 / 对手**的特殊牌池，各带一个合计张数徽标；弹窗 #pileMask
   顶部三个页签（摧毁池 / 弃牌池 / 放逐池）带各自张数，下方按**入池顺序（旧 → 新）**列卡面，点击复用 showHandCard。
   刷新：renderPiles() 更新徽标、弹窗开着时顺带重渲染当前页签；调用点＝renderZones() 末尾 + 入池收口。 */
let pileSide = 'p';
let pileKind = 'destroy';
function pileSideLabel(side) { return side === 'a' ? '对手' : '己方'; }
function isPilesOpen() {
  const m = $('pileMask');
  return !!m && !m.classList.contains('hidden');
}
function renderPiles() {
  for (const side of ['p', 'a']) {
    const el = $(side === 'p' ? 'pileCountP' : 'pileCountA');
    if (!el) continue;
    el.textContent = String(pileTotalOf(side));
    const btn = el.closest('.pile-btn');
    if (btn) {
      btn.title = `${pileSideLabel(side)}特殊牌池：`
        + PILE_KINDS.map((k) => `${k.label} ${pileOf(side, k.key).length}`).join(' · ')
        + '（点击查看，按入池顺序排列）';
    }
  }
  if (isPilesOpen()) renderPilePanel();
}
function pileDbg(side) {
  const out = { total: pileTotalOf(side) };
  for (const k of PILE_KINDS) {
    const list = pileOf(side, k.key).map((c) => ({
      n: c.def.n, turn: c.pileTurn, by: c.pileBy, loc: c.pileLoc, power: c.pilePower,
    }));
    out[k.key] = list;
    out[k.key + 'Count'] = list.length;
  }
  return out;
}
function buildPileTabs() {
  const holder = $('pileTabs');
  if (!holder) return;
  holder.innerHTML = '';
  for (const k of PILE_KINDS) {
    const on = pileKind === k.key;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (on ? ' active' : '');
    b.textContent = `${k.label} ${pileOf(pileSide, k.key).length}`;
    b.title = k.tip;
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.addEventListener('click', () => {
      if (pileKind === k.key) return;
      pileKind = k.key;
      renderPilePanel();
    });
    holder.appendChild(b);
  }
}
function renderPilePanel() {
  const mask = $('pileMask');
  if (!mask) return;
  const pile = pileOf(pileSide, pileKind);
  const kd = pileKindDef(pileKind);
  const title = $('pileTitle');
  if (title) title.textContent = `${pileSideLabel(pileSide)}特殊牌池 · ${kd.label}`;
  const cnt = $('pileCount');
  if (cnt) cnt.textContent = `${pile.length} 张`;
  const tip = $('pileTip');
  if (tip) tip.textContent = '按入池顺序（旧 → 新）显示 · ' + kd.tip;
  buildPileTabs();
  const grid = $('pileGrid');
  if (!grid) return;
  grid.innerHTML = '';
  if (!pile.length) {
    const none = document.createElement('div');
    none.className = 'codex-empty';
    none.textContent = pileEmptyText(pileSide, pileKind);
    grid.appendChild(none);
    return;
  }
  pile.forEach((card, i) => grid.appendChild(pileCardEl(card, i + 1)));
}
function pileEmptyText(side, kind) {
  const who = pileSideLabel(side);
  if (kind === 'discard') return `${who}的弃牌池还是空的 —— 本局还没有牌被弃掉（弃牌只把手牌里的牌移出，与场上的摧毁是两回事）。`;
  if (kind === 'exile') return `${who}的放逐池还是空的 —— 本局还没有法术被使用（法术揭示结算完后消散时入池）。`;
  return `${who}的摧毁池还是空的 —— 本局还没有牌被摧毁（只有真正离场的摧毁才会入池）。`;
}
// 牌池卡片：战力取「入池时」的记录值；入池序号/回合做成卡片下方独立小字（不叠在卡面上，手机端同样可见）
function pileCardEl(card, ord) {
  const def = card.def;
  const power = (card.pilePower != null) ? card.pilePower : cardPower(card);
  const sign = power > def.p ? 'up' : power < def.p ? 'down' : '';
  const liveCost = cardCost(card);
  const costSign = liveCost > def.c ? 'up' : liveCost < def.c ? 'down' : '';
  const meta = [
    `第 ${ord} 个入池`,
    `第 ${card.pileTurn} 回合入池`,
    `来源：${card.pileBy || '效果'}`,
    card.pileLoc ? `区域：${card.pileLoc}` : null,
    card.pileKind === 'exile' ? '法术 · 无战力' : `入池时战力 ${power}`,
  ].filter(Boolean).join(' · ');
  const cell = document.createElement('div');
  cell.className = 'pile-cell';
  cell.title = `${def.n}（${meta}）· 点击放大查看`;
  const face = document.createElement('div');
  face.className = 'codex-card hand-card pile-item' + (def.img ? '' : ' no-img') + (cardSealed(card) ? ' sealed' : '');
  face.style.setProperty('--cgrad', gradOf(def));
  face.innerHTML = cardFaceHTML(def, { power, sign, cost: liveCost, costSign, sealed: cardSealed(card) });
  face.addEventListener('click', () => showHandCard(card)); // 复用放大查看（关掉放大层仍回到牌池弹窗）
  const cap = document.createElement('div');
  cap.className = 'pile-cap';
  const ordEl = document.createElement('span');
  ordEl.className = 'pile-ord';
  ordEl.textContent = '#' + ord;
  const turnEl = document.createElement('span');
  turnEl.className = 'pile-turn';
  turnEl.textContent = `第 ${card.pileTurn} 回合`;
  cap.appendChild(ordEl);
  cap.appendChild(turnEl);
  cell.appendChild(face);
  cell.appendChild(cap);
  return cell;
}
function openPiles(side) {
  pileSide = (side === 'a') ? 'a' : 'p';
  pileKind = 'destroy';
  renderPilePanel();
  const mask = $('pileMask');
  if (mask) mask.classList.remove('hidden');
}
function closePiles() {
  const mask = $('pileMask');
  if (mask) mask.classList.add('hidden');
}
function uiOnPiles(side) {
  if (isPilesOpen()) { closePiles(); return; }
  openPiles(side);
}

/* ---------------- 弹窗 ---------------- */
function hideModal() { $('modalMask').classList.add('hidden'); }

// 结算/认输弹窗的「确认」：只关弹窗、不清空终局盘面 —— 场上已翻开的牌本就可点击放大，此时手牌（phase over）也可点击复盘。
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
    onAddStone: uiOnAddStone,
    onAddStoneClose: uiOnAddStoneClose,
    onAddStoneConfirm: uiOnAddStoneConfirm,
    onEnergyDev: uiOnEnergyDev,
    onSwitchSide: uiOnSwitchSide,
    onAiSpy: uiOnAiSpy,
    closeAiSpy,
    // 特殊牌池（摧毁池 / 弃牌池 / 放逐池）：'p' 己方 / 'a' 对手
    onPiles: uiOnPiles,
    closePiles,
    onEnergyReset: uiEnergyReset,
    confirmEnergyReset,
    cancelEnergyReset,
  },
  _dbg: () => ({
    gen: state.gen, phase: state.phase, turn: state.turn,
    roundTotal: roundsTotal(), // 本局总回合数（虚假之月在场 → 7；已到第 7 回合则锁定为 7）
    energyTotal: state.players.p.energyTotal, energyLeft: state.players.p.energyLeft,
    energyTotalA: state.players.a.energyTotal, energyLeftA: state.players.a.energyLeft,
    energyGainP: state.players.p.energyGain || 0, energyGainA: state.players.a.energyGain || 0,
    energyAddP: state.energyAddPerTurn.p || 0, energyAddA: state.energyAddPerTurn.a || 0,
    deckP: state.players.p.deck.length,
    pendingEnergyP: state.pendingEnergyGain.p || 0, pendingEnergyA: state.pendingEnergyGain.a || 0,
    hasWaiter: !!pendingResolve,
    handP: state.players.p.hand.map((c) => cardCost(c)),
    handA: state.players.a.hand.map((c) => cardCost(c)),
    pMoves: (state.playerMoves || []).length, aiMoves: (state.aiMoves || []).length,
    pZones: state.players.p.zones.map((z) => z.length),
    aZones: state.players.a.zones.map((z) => z.length),
    pileP: pileDbg('p'),
    pileA: pileDbg('a'),
  }),
  /* 弃牌的**控制台探针**：与卡牌结算同一个 `discardFromHand` 收口（流程 / 日志 / 入池 / 演出一致）。
     用法 Game._discard(side, opt) —— opt = { n | n:'all', pick:'right'|'maxCost', card:卡名, cost:{min} }：
       ('a',{n:1}) / ('p',{pick:'right'}) / ('p',{pick:'maxCost'}) / ('p',{card:'琪露诺'}) / ('a',{cost:{min:5},n:'all'})
     返回 { ok, side, cards, cands, want, by, why }（cards = 实际被弃的卡实例）。 */
  _discard: devDiscard,
};

// 遮罩层点击空白处关闭 / Esc 逐层关闭
(function initOverlays() {
  const codexMask = $('codexMask');
  const zoomMask = $('zoomMask');
  const undoMask = $('undoMask');
  const pickMask = $('pickMask');
  const pickLocMask = $('pickLocMask');
  const aiSpyMask = $('aiSpyMask');
  const pileMask = $('pileMask');
  codexMask.addEventListener('click', (e) => { if (e.target === codexMask) closeCodex(); });
  zoomMask.addEventListener('click', (e) => { if (e.target === zoomMask) closeZoom(); });
  undoMask.addEventListener('click', (e) => { if (e.target === undoMask) cancelEnergyReset(); });
  pickMask.addEventListener('click', (e) => { if (e.target === pickMask) uiOnPickClose(); });
  if (pickLocMask) {
    pickLocMask.addEventListener('click', (e) => { if (e.target === pickLocMask) closePickLoc(); });
    bindPickLocZoneButtons(); // 区域按钮直接绑定（下面的事件委托仅作兜底）
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
  if (pileMask) pileMask.addEventListener('click', (e) => { if (e.target === pileMask) closePiles(); });
  // 开发者「🪨 添加石块」弹窗：遮罩点击关闭 + 按钮直接绑定 + 输入框实时刷新提示
  const addStoneMask = $('addStoneMask');
  if (addStoneMask) {
    addStoneMask.addEventListener('click', (e) => { if (e.target === addStoneMask) closeAddStone(); });
    bindAddStoneZoneButtons();
    bindAddStoneSteppers();
    const row = $('addStoneZones');
    if (row) {
      row.addEventListener('click', (e) => {
        const btn = e.target.closest && e.target.closest('.plz-btn');
        if (!btn) return;
        selectAddStoneZone(btn.getAttribute('data-loc'));
      });
    }
    const input = $('addStoneCount');
    if (input) {
      // 输入/上下方向键（number 输入框原生步进也会触发 input）→ 实时刷新提示与步进按钮置灰
      input.addEventListener('input', () => updateAddStoneTip());
      input.addEventListener('blur', () => { input.value = String(readAddStoneCount()); updateAddStoneTip(); });
    }
  }
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!zoomMask.classList.contains('hidden')) closeZoom();
    else if (!codexMask.classList.contains('hidden')) closeCodex();
    else if (pickLocMask && !pickLocMask.classList.contains('hidden')) closePickLoc();
    else if (addStoneMask && !addStoneMask.classList.contains('hidden')) closeAddStone();
    else if (!pickMask.classList.contains('hidden')) uiOnPickClose();
    else if (aiSpyMask && !aiSpyMask.classList.contains('hidden')) closeAiSpy();
    else if (pileMask && !pileMask.classList.contains('hidden')) closePiles();
    else if (!undoMask.classList.contains('hidden')) cancelEnergyReset();
  });
})();

restart();
