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
  // v185：**7 费档**（「哆来咪」）——新增费用档时必须在这里补一条底色：
  // 卡面底色统一走 gradOf(def) → `--cgrad`，费用档没有对应色值时 `--cgrad` 为空，
  // 手牌/场上/图鉴/卡组页/放大视图的卡面会整体透明（v185 修）。
  // 配色＝梦之世界的深紫罗兰 → 淡紫（与 4 费档的紫 #5b3a94→#c79bff 区分开）。
  7: 'linear-gradient(150deg,#3a2565,#c9a6ff)',
  // v194：**8 费档**（「纯狐」）——同样必须在这里补一条底色（口径同上面的 7 费档）。
  // 配色＝月夜的深靛蓝 → 冷银白（与 1 费档的蓝 #2e5f96→#7cc0ff 区分开：更深、更冷、偏银）。
  8: 'linear-gradient(150deg,#1b2140,#d7e0ff)',
};
const BACK_GRAD = 'linear-gradient(160deg,#2b314a,#151929)';

const POOL = (window.DS_CARDS && window.DS_CARDS.POOL) || {};
const KIND_LABEL = (window.DS_CARDS && window.DS_CARDS.KIND_LABEL) || {};
const TOKENS = (window.DS_CARDS && window.DS_CARDS.SPECIAL) || {};
const GROUPS = (window.DS_CARDS && window.DS_CARDS.GROUPS) || {};
// v185：POOL 的费用档键（0/1/…/6/7…）按数值升序取出——新增费用档（如 v185 的 7 费组）后，
// 所有“遍历整个卡池”的地方（findCardDefByKey / gatherMembers / 图鉴与卡组页的卡池）自动跟随，
// 不再像 v184 之前那样写死 `for (let c = 0; c <= 6; c++)`（漏了新档就整张卡在图鉴/索引里消失）。
const POOL_COST_KEYS = Object.keys(POOL).map(Number).filter((c) => Number.isFinite(c)).sort((a, b) => a - b);
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
// v205：「已破碎」地形兜底定义（正式数据在 locations.js EXTRA.shattered）——天界 `shatter` 摧毁后的占位态。
//   max 0 ⇒ 该侧一格不剩（放牌/移动/落场生成/复活全被挡）；wt 0 ⇒ 不计入区域数；无任何效果字段。
const SHATTERED_LOC_DEF = { id: 'shattered', n: '已破碎', icon: '💥', wt: 0, dbl: 1, max: 0, eff: '此区域已被摧毁：不能放牌、不计分' };

// 卡面渐变：有自定义 cg（如特殊卡牌「石块」的土黄色）则优先，否则按费用档位取色；
// v185：再加一层兜底（未知费用档 → 深蓝灰 BACK_GRAD），保证任何卡都不会因取不到色值而透明
const gradOf = (def) => (def && def.cg) || GRADS[def && def.c] || BACK_GRAD;

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
// ---- v194：费用**随摧毁递减**（卡级持续机制 `costDown`，现仅 8 费「纯狐」）----
// `costDown: N` = **本场战斗中双方每有一张牌被摧毁**，此牌的能量消耗 −N（下限 **0** 费，用户口径）。
//   ① 计数来源＝**摧毁池**（v187）：只算**真正离场的那次摧毁**（`dw`/`dwh`/`dwb`/地形 `purge`
//      把牌实际移出场上，各计 1 张）＝**双方摧毁池张数之和**（`destroyCount()` 实时读取）；
//      **摧毁失败不计**（`phx` 凤凰重生 / `surv` 防摧毁 / `ind` 自身不可摧毁 / 地形 `prot`·蕾蒂），
//      **其它离场方式也不计**（弃牌 `discard`、法术消散、终局离场 `leave`、撤回手牌、移动、换边）。
//   ② **实时动态**：读的是当前合计，因此纯狐**还没抽到手之前**双方被摧毁的牌也一并计入。
//   ③ 减费**不写进** `card.costMod`、也**不改** `def.c`（印刷费用恒为 8：图鉴 / 卡组页 / 费用档筛选
//      一律按 8 费），只在 `cardCost` 里算出来 ⇒ 手牌费用角标变绿（`.cost-orb.down`）、
//      放大视图写「本场战斗费用修正 −N」——与 v169 加费共用同一套显示逻辑。
//   ④ 与 `costUp` 叠加：`cardCost = max(0, def.c + costMod − costDown × 摧毁数)`。
//   ⑤ 非“摧毁”/非增减/非放置：不触发 surv/phx/prot/ind、不动区域字段与格位、不进 powerLog/fieldQueue。
function cardCost(card) {
  if (!card) return 0;
  const base = card.def.c + (card.costMod || 0);
  const down = (card.def.costDown || 0) * destroyCount(); // v194
  return down > 0 ? Math.max(0, base - down) : base;
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
/* ==================== v184：洗入卡组（`shuffleIn` 效果键） ====================
   口径：把一张牌（或 n 张同名**新实例**）**洗入某一方的牌库**，随后该方**整副牌库重新随机洗一次**。
   「牌库」= `state.players[side].deck`（隐藏区，与手牌分开）；`drawOne` 从**队尾** pop，
   因此重洗之后“下一张会抽到什么”立刻改变 —— 这才是本机制的实际作用（塞牌 / 稀释 / 强化曲线）。
   与既有键的分工：`give` 加入**手牌**、`spawn*` / `clone` 落**场上**、`shuffleIn` 进**牌库**。
   数据写法（见 data/cards.js）：`shuffleIn: { card: 键名, n: 张数, to: 'own' | 'opp' }`
     · `card`：先查衍生池 `SPECIAL` 的**键名**（如 'stone'），查不到再按**卡名**在人物池 `POOL`
       里找（如 '琪露诺'）—— 即两种池都能引用；
     · `n`：张数，缺省 1；每张都是**新卡实例**（各自独立，日后可分别被加费/记账）；
     · `to`：`'own'`（缺省）= 洗入**施放方自己**的牌库（归属按牌的所属方 `side`：玩家打出给自己、
       AI 打出给 AI、被 `switch`/`gift` 换边后按新归属方）；`'opp'`（也接受 `'a'`）= 洗入**对方**牌库。
   口径要点：
     ① **不结算被洗入卡的任何效果** —— 它进的是牌库（隐藏区）：既不翻开、不占格位、不进场上
        放置顺序队列（`fieldQueue`），也不触发揭示 / 持续 `og` / 时机 `fx` / `surv` 等任何机制；
        日后被 `drawOne` 抽到手牌、再被暗出翻开时，才按常规流程结算（与开局洗牌同口径）。
     ② **张数无上限**：牌库不是手牌，没有 7 张上限，「手牌满则失败」的口径**不适用**；
        开发调试的空牌库洗入后同样会变得可抽。
     ③ **洗牌范围 = 该方整副牌库**（含原本尚未抽到的所有牌），就地 Fisher-Yates 重洗（`shuffle`）；
        牌序本就纯随机（v139），重洗不引入新的公平性问题，只改变后续抽牌分布。
     ④ **公开**：日志点名「多少张什么牌被洗入谁的牌库 + 洗后牌库张数」（对手侧同样写进对局信息，
        与 v169 加费的公开口径一致），并播轻量演出（牌库计数闪光 + 「洗入卡组」气泡）。
     ⑤ 非“摧毁” / 非放置 / 非增减类：与 `surv`/`phx`/`prot`/`ind`、区域字段、格位判定全无交互；
        被洗入的实例不进战力影响历史（`powerLog`）—— 它还没上场。
     ⑥ 洗入的是**全新实例**，`costMod` 自然为 0，不继承任何既有费用修正。 */
// 按“键名”取卡 def：① 衍生池（SPECIAL）键名，② 人物池（POOL）卡名（POOL 按费用分档、无键名）
function findCardDefByKey(key) {
  if (!key) return null;
  if (TOKENS[key]) return TOKENS[key];
  for (const c of POOL_COST_KEYS) { // v185：改为遍历实际存在的费用档（含 7 费组）
    for (const d of (POOL[c] || [])) if (d && d.n === key) return d;
  }
  return null;
}
/** v184：把 n 张指定卡的新实例洗入某方牌库，并把该方**整副牌库重新洗一次**。返回实际加入张数。 */
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
/** v184：洗入卡组的轻量演出 —— 牌库计数闪光（含扩散光环）+ 星光迸发 + 「洗入卡组」气泡。
    锚点：对手侧 = 侧栏「牌库 N 张」（#aiDeck）；玩家侧 = 手牌区「牌库 N」（#deckCountVal）。
    取不到锚点或尺寸为 0（页面隐藏 / 主页面态）时静默跳过，只留日志；
    元素全部放 body 悬浮层（z-index 9400/9410）且 pointer-events:none，不挡操作。 */
function playShuffleInFx(side, n, cardName, srcName) {
  const anchor = side === 'p' ? $('deckCountVal') : document.querySelector('#sidePanel .opponent .mini-stats');
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  // 1) 牌库计数闪光（单条动画内含外扩光环，避免两个 animation 互相覆盖）
  const box = document.createElement('div');
  box.className = 'deck-shuffle-flash';
  box.style.cssText =
    `position:fixed;left:${rect.left - 5}px;top:${rect.top - 4}px;` +
    `width:${rect.width + 10}px;height:${rect.height + 8}px;border-radius:999px;` +
    `z-index:9400;pointer-events:none;`;
  document.body.appendChild(box);
  setTimeout(() => { if (box.parentNode) box.parentNode.removeChild(box); }, 1500);
  // 2) 星光迸发（复用 .energy-star 的飞行关键帧，辉光换成青蓝；掺入 🃏/🎴 呼应“洗牌”）
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
  // 3) 「洗入卡组」气泡（主行 + 副行小字：来源卡 · 什么牌 → 谁的牌库）
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

/* ==================== v187：特殊牌池（摧毁池 / 弃牌池 / 放逐池；v189 起弃牌池有实际入池来源）====================
   口径：**每局、每一方各自持有三个独立的牌池**（`state.players[side]` 上三条队列），
   都是**先进先出**的队列——牌按“入池先后”push 到队尾，界面按同一顺序（旧 → 新）展示。
   入池的是**牌本体**（同一个卡实例，不做复制、不改 def），并在实例上记一份入池元数据。

   三个池各自的入池条件：
     · **摧毁池** `destroyPile`：**真正离场的那次摧毁**——`dw`（最弱）/`dwh`（最强）/
       `dwb`（双方最弱随机一张）/ 地形 `purge`（回合末最低，并列全删）把牌**实际移出场上**时，
       把该牌本体放进**它归属方**（`card.side`，换边后按新归属）的摧毁池。
       ⚠️ **不算摧毁、因此不入池**的情形：`phx` 凤凰重生（改回手 +N）、`surv` 防摧毁
       （改永久 −N、卡不离场）、`ind` 自身不可摧毁（判定失败、什么都不发生）、
       地形 `prot`／「蕾蒂」的区域免摧毁（整条拦下）——这些都属于“摧毁失败”。
       法术（`spell`）永远不会成为摧毁目标（`dw/dwh/dwb/purge` 均排除它），故不会进摧毁池。
       其他离场方式也都不算：`leave` 终局离场、法术消散、撤回手牌、移动（`mv`/`fly`/`shift`/
       `roam`/`gust`）、换边（`switch`/`gift`）。
     · **弃牌池** `discardPile`：**被弃掉的牌**（v187 建占位队列，**v189 起弃牌机制实装**）——
       「弃牌」= 把牌从**手牌**移出（`discard` 效果键 / `discardFromHand` 收口），与摧毁的分工是
       **区域不同、互不重叠**：摧毁只作用于场上（→ 摧毁池），弃牌只作用于手牌（→ 弃牌池）；
       口径见下方 v189「弃牌」段。手牌不在场上，故入池元数据的 `pileLoc` 记 null、
       `pilePower` 记该卡被弃时的战力（基础 + 永久 buff；法术记 0）。
     · **放逐池** `exilePile`：**用过的法术**——法术在揭示效果结算完之后**自行消散**
       （`vanishSpell`，口径见 v170「法术」段；这不属于被摧毁）时，把该法术本体放进
       其归属方的放逐池。

   入池元数据（直接挂在卡实例上；三个池共用同一套字段名）：
     · `pileKind`  = 'destroy' | 'discard' | 'exile'
     · `pileTurn`  = 入池时的回合数
     · `pileBy`    = 来源名（卡名 / 地形名；法术放逐记 '法术消散'）
     · `pileLoc`   = 入池时所在区域的显示名（**弃牌**的牌本来就在手牌、不在场上 → 记 null）
     · `pilePower` = 入池时的**实时战力**（`cardPowerIn`；法术记 0；**弃牌**记手牌口径的
       `cardPower`＝基础 + 永久 buff，手牌没有区域/持续加成）
   非“摧毁”/非“增减”类机制：入池**不**触发 `surv`/`phx`/`prot`/`ind`、不动区域字段、
   不改战力台账；牌本体已不在场上（zone 里已移除、`fieldQueue` 已出队），因此不影响任何结算。 */
const PILE_KINDS = [
  { key: 'destroy', label: '摧毁池', tip: '被摧毁的牌（真正离场的那次摧毁）按入池先后存放' },
  { key: 'discard', label: '弃牌池', tip: '被弃掉的牌（弃牌效果把牌从手牌移出）按入池先后存放，v189 起有实际入池来源' },
  { key: 'exile',   label: '放逐池', tip: '用过的法术（揭示结算完后自行消散）按入池先后存放' },
];
/** 某个池键对应的 state 字段名（三个池一一对应） */
const PILE_FIELDS = { destroy: 'destroyPile', discard: 'discardPile', exile: 'exilePile' };
function pileKindDef(kind) {
  for (const k of PILE_KINDS) if (k.key === kind) return k;
  return PILE_KINDS[0];
}
/** 取某方某个池的队列数组（始终返回数组；字段缺失时就地补一个，防御旧状态对象） */
function pileOf(side, kind) {
  const pl = state.players[side];
  if (!pl) return [];
  const field = PILE_FIELDS[kind] || PILE_FIELDS.destroy;
  if (!Array.isArray(pl[field])) pl[field] = [];
  return pl[field];
}
/** 某方三个池的合计张数（侧栏按钮的计数徽标用） */
function pileTotalOf(side) {
  let n = 0;
  for (const k of PILE_KINDS) n += pileOf(side, k.key).length;
  return n;
}
/** v194：**本场战斗中双方被摧毁的牌数** ＝ 双方摧毁池张数之和（实时读取，随入池单调增长）。
    唯一使用者＝`cardCost` 的「费用随摧毁递减」（卡级机制 `costDown`，现仅 8 费「纯狐」）——
    只算真正离场的那次摧毁（`dw`/`dwh`/`dwb`/地形 `purge`），摧毁失败与其它离场方式都不在池里，
    因此“摧毁池合计”天然就是这份口径的唯一数据源。 */
function destroyCount() {
  return pileOf('p', 'destroy').length + pileOf('a', 'destroy').length;
}
/** 把**牌本体**放进某方某个池的队尾；meta = { turn, by, loc, power }（缺省取当前回合）。
    返回 { pile, n, kind }，供调用方记日志/演出（不进 zone、不进 fieldQueue、不改任何战力）。 */
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
/** v187：摧毁入池收口 —— **必须在把该牌移出区域之前调用**（此刻才读得到它“被摧毁时”的
    区域与实时战力）；写入元数据 + 入池 + 记一条日志。`srcName` = 来源（卡名 / 地形名）。 */
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
/** v187：法术放逐入池（由 vanishSpell 在消散成功之后调用；法术无战力，`pilePower` 记 0）。 */
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

/* ==================== v189：弃牌（`discard` 效果键）与弃牌演出 ====================
   （取牌方式 `pick`：v190 加 `'right'`/`'left'`，**v191 再加 `'maxCost'`＝取印刷费用最高、并列随机**）
   一句话口径：**弃牌 = 把牌从「手牌」移出**，放进该牌**归属方**的**弃牌池**（v187 的
   `discardPile`：先进先出、入池的是牌本体 + 入池元数据）。

   与「摧毁」的分工是**区域不同、互不重叠**（用户口径）：
     · **摧毁**（`dw`/`dwh`/`dwb`/地形 `purge`）只作用于**场上**的牌 → 进**摧毁池**；
     · **弃牌**只作用于**手牌**（隐藏区）→ 进**弃牌池**。
   因此弃牌**不是**“摧毁”：不触发 `surv`（防摧毁）/ `phx`（凤凰重生）/ `prot`（区域免摧毁）/
   `ind`（自身不可摧毁）等任何“被摧毁时”的替代与防护，也不进 `powerLog`、不改战力
   （牌只是从手牌消失，没有任何战力变化）；手牌本就不在场上，故也不动区域字段、格位
   （`sideUsed`/`sideRoom`）、放满加成与场上放置顺序队列 `fieldQueue`。
   被弃的牌**带着自己的一切**进池：`def` 不被改写，永久增益台账 `powerLog`、本场战斗的
   费用修正 `costMod`（如被桑尼米尔克加过费）都随这一个实例保留，可在「弃牌池」弹窗里查看、
   放大（口径与摧毁池/放逐池一致）。

   数据写法（`data/cards.js` 的 `discard=` 字段说明）：
     discard: {
       n: 1,            // 张数，缺省 1；写 'all' = 命中多少弃多少
       to: 'own',       // 'own'（缺省）＝弃**自己**手牌；'opp'（也接受 'a' / 'enemy'）＝弃**对方**手牌
       pick: 'random',  // v190：取牌位置/取牌方式——'random'（缺省）候选里随机 / 'right' 从**最右侧**起 /
                        // 'left' 从**最左侧**起 / **'maxCost'（v191）取印刷费用 def.c 最高的那些（并列随机）**
       card: '琪露诺',   // 可选：按**卡名**筛选（字符串或数组；也接受 SPECIAL 键名，如 'stone'）
       cost: 3,         // 可选：按**印刷费用 def.c** 筛选（数字＝恰好该费用；或 { min, max } 区间，含端点）
       give: { card: 'stone', n: 1, powerFromCost: true },
                        // **v198 可选子句**：弃牌**真的发生之后**，每弃掉 1 张就给**施放方自己**
                        // 加入 give.n（缺省 1）张 give.card（SPECIAL 键名）的**新卡实例**到**手牌**；
                        // powerFromCost: true ⇒ 战力 ＝ **那一张被弃牌的印刷费用 def.c**（不是 cardCost）。
                        // 见下方 v198「`discard.give`」段。
     }
   口径要点：
     ① **目标方**由 `to` 决定，归属对双方一视同仁（AI 抽到带本键的卡也会弃玩家的手牌）；
     ② **候选筛选**：`card` 命中卡名、`cost` 命中**印刷费用**（不是 `cardCost`——与区域 `cb`
        费用加成、`og.cost`、图鉴分档同口径：被加费只改实际能量消耗，不改变费用档位）；
        两个筛选都**不写**时＝该方整副手牌都是候选。候选**保持手牌顺序**（左 → 右＝数组顺序），
        故位置筛选（`pick`）读到的就是玩家看到的手牌左右位置；
     ③ **张数 + 取牌方式（`n` + v190 新增、**v191 扩展**的 `pick`）**：命中候选里取 n 张（`n: 'all'` 则命中即全弃）——
        `pick: 'random'`（缺省）＝候选里**随机**取；`pick: 'right'`＝从**最右侧**起取（即手牌最右那张）；
        `pick: 'left'`＝从**最左侧**起取；`pick: 'maxCost'`（**v191**）＝取**印刷费用 `def.c` 最高**的那些，
        并列最高的多张之间**随机**（口径同 dw/dwh/dwb 的“并列里随机挑一张”）；候选不足时弃掉手上有的那些
        （部分弃，日志写明）；一张都没有则**无事发生**、只记一条日志；`n: 'all'` 时 `pick` 不起作用（全都要）；
     ④ **公开**：弃牌是**双方可见**的——不是只写日志：日志点名被弃的牌 + 中央弹出**被弃那张牌的
        完整卡面**并播**斜切两半**演出（见 `playDiscardFx`，约 1.6s，任何一种归属组合都一样可见）；
        被弃的牌此后会出现在该方「弃牌池」里（侧栏徽标 + 弹窗页签），故对玩家而言是**明牌**；
     ⑤ **不进手牌上限的账**：手牌上限 7 张只约束“加入/抽牌”，弃牌是**减少**手牌，与本机制无关；
        被弃的牌也不会回到任何地方（不返场、不返牌库）；
     ⑥ **与「重置暗牌」无冲突**：`state.playHandOrder`（回合初手牌顺序）里若含已被弃的牌 id，
        `undoPlacedCards` 重建手牌时按 id 取不到该卡、自然跳过（安全，无需额外处理）；
     ⑦ **v198 可选子句 `give`**：弃牌**真的发生之后**，按被弃掉的那张牌的**印刷费用**给**施放方
        自己**加入手牌衍生物（现由「姬虫百百世」使用 → 1 张战力＝该卡费用的「石块」）。完整口径
        见下方 v198「`discard.give`」段；弃牌落空时本条**完全不结算**。 */
const DISCARD_ANIM_MS = 1600; // 弃牌演出总时长（v190：2.0s → 1.6s——切得更晚、消散更快）；与 style.css 的 discard* 关键帧时长对齐，改时长要两边一起改

/** v189：`discard.card` 的筛选归一化 —— 卡名（字符串/数组）或 SPECIAL 键名 → **卡名数组**。
    键名先经 `TOKENS` 解析成该 token 的卡名（如 'stone' → '石块'），解析不到就按字面比较；
    ⚠️ 同名卡（如法术「祖母绿巨石」与占位 token「祖母绿巨石」）会一起命中。返回 null = 不筛选。 */
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

/** v189：`discard.cost` 的区间口径 —— 数字＝恰好该印刷费用；`{ min, max }`＝含端点的区间
    （缺省端点为无界）。返回 null = 不筛选。 */
function discardCostRange(spec) {
  if (!spec || spec.cost == null) return null;
  const c = spec.cost;
  if (typeof c === 'number') return { min: c, max: c };
  const min = (typeof c.min === 'number') ? c.min : -Infinity;
  const max = (typeof c.max === 'number') ? c.max : Infinity;
  return { min, max };
}

/** v189：筛选条件的可读文案（日志/开发指令用），如「卡名 琪露诺 · 印刷费用 ≥5」；无筛选返回 ''。 */
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
  // v190：取牌位置（'random' 是缺省口径、不写进文案，避免日志噪音）；v191：'maxCost'＝印刷费用最高
  if (spec && (spec.pick === 'right' || spec.pick === 'left' || spec.pick === 'maxCost')) {
    bits.push(spec.pick === 'right' ? '取牌 最右侧'
      : spec.pick === 'left' ? '取牌 最左侧'
      : '取牌 印刷费用最高');
  }
  return bits.join(' · ');
}

/** v189：某方手牌里符合 `discard` 筛选条件的候选（按手牌原顺序）。
    ⚠️ 费用筛选走**印刷费用 `def.c`**（与区域 `cb` 加成、`og.cost`、图鉴与卡组页分档同口径），
    不是 `cardCost`；`un` 占位卡（隙间）绝不会在手牌，仍作防御性排除。 */
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

/** v189：**弃牌核心** —— 把 `side` 方手牌里符合 `spec` 的牌移出，并放进该方（＝牌的归属方，
    换边 `switch`/`gift` 后的新归属）的**弃牌池**，同时播双方可见的弃牌演出。
    返回 { ok, side, cards, cands, want, by, why }：`ok=false` 时 `cards` 为空、`why` 说明原因。
    ⚠️ 调用方负责记日志（本函数只做数据 + 演出 + 入池；入池沿用 `pushToPile` 的收口）。
    v197：新增第 5 个参数 **`onlyCard`** —— 只允许弃**这一张卡实例**（候选先按 `spec` 过滤、
    再收窄到该实例），供「手牌回合结束效果」`fx.handEnd` 的**自我丢弃**使用：
    这样即便手里有**两张同名卡**，也只弃掉触发的那一张（不误伤另一张），
    且入池元数据 / 演出 / 日志口径与既有弃牌**完全一致**（同一个收口）。 */
function discardFromHand(side, spec, srcCard, tag, onlyCard) {
  const sp = spec || {};
  const pl = state.players[side];
  if (!pl) return { ok: false, side, cards: [], cands: 0, want: 0, by: null, why: 'no-side' };
  const all = discardCandidates(side, sp);
  const cands = onlyCard ? all.filter((c) => c === onlyCard) : all;
  const want = sp.n === 'all' ? cands.length : Math.max(1, Math.floor(sp.n || 1));
  if (!cands.length) return { ok: false, side, cards: [], cands: 0, want, by: null, why: 'no-candidate' };
  // 取牌（v190 新增 `pick` 口径；**v191 补 `'maxCost'`**）：缺省 'random'＝在候选里**随机**取
  // （沿用全局 Math.random，可被冒烟测试替换成种子化 PRNG）；'right' / 'left'＝按**手牌左右位置**取
  // ——候选数组已保持手牌顺序（左 → 右），故最右＝队尾、最左＝队首；'maxCost'（**v191**）＝取
  // **印刷费用 `def.c` 最高**的那些，**并列最高时随机**（口径同 dw/dwh/dwb 的“并列里随机挑一张”）；
  // `n: 'all'` 时位置与费用排序都无意义（全都要）。
  const pick = (sp.pick === 'right' || sp.pick === 'left' || sp.pick === 'maxCost') ? sp.pick : 'random';
  let picked;
  if (pick === 'right') picked = cands.slice(Math.max(0, cands.length - want));
  else if (pick === 'left') picked = cands.slice(0, Math.min(want, cands.length));
  else if (pick === 'maxCost') {
    // v191：先 shuffle 再按**印刷费用**降序稳定排序 —— sort 稳定 + 先洗牌 ⇒ 同费用的相对顺序随机，
    // 因此「并列最高」天然是“在其中随机挑”，与 dw/dwh/dwb 的口径一致；只比较 def.c（不走 cardCost，
    // 与 discard.cost 筛选、区域 cb、图鉴分档同口径：加费只改实际能量消耗、不改贵贱排序）。
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
    // 入池元数据（三个池共用字段名）：手牌不在场上 → pileLoc 记 null；
    // pilePower 记**被弃那一刻的战力**（基础 + 永久 buff；法术恒为 0；手牌没有区域/持续加成）
    pushToPile(side, 'discard', c, { turn: state.turn, by, loc: null, power: cardPower(c) });
    cards.push(c);
  }
  if (!cards.length) return { ok: false, side, cards: [], cands: cands.length, want, by, why: 'no-candidate' };
  // 玩家自己的手牌被弃 → 立刻重渲染手牌（并顺带复位选中项，避免 selected 指到别的牌上）
  if (side === 'p') {
    state.selected = -1;
    renderHand();
  }
  playDiscardFx(cards, side, by); // 双方可见：弹出被弃牌的完整卡面 + 斜切两半（约 1.6s）
  return { ok: true, side, cards, cands: cands.length, want, by, why: null };
}

/* ==================== v198：`discard.give`（弃牌后按被弃牌的印刷费用加手牌衍生物）====================
   （首个使用者：**2 费 / 2 战力「姬虫百百世」** —— 揭示：随机丢弃自己手牌中的 1 张卡，
     并将 1 张战力等于该卡**能量消耗（印刷费用）**的「石块」加入**自己**的手牌。）
   一句话口径：`discard` 键的**可选子句** —— 弃牌**真的发生之后**，**每弃掉 1 张**就给**施放方自己**
   加入 `give.n`（缺省 1）张 `give.card`（SPECIAL 键名，如 `'stone'`＝石块）的**新卡实例**到**手牌**。

   口径（用户确认，v198）：
    ① **触发前提＝弃牌成功**：`discardFromHand` 返回 `ok:false`（手牌为空 / 没有符合筛选的候选）
       时**本条完全不结算**——既不弃牌也不加任何卡；调用方只记一条“想弃但没牌”的日志；
    ② **战力口径**：`powerFromCost: true` ⇒ 加入的衍生物战力 ＝ **那一张被弃牌的印刷费用 `def.c`**
       （**不是** `cardCost`）——与 `discard.cost` 筛选、`dwc` 按费用全场摧毁、`og.cost`、图鉴与卡组页
       分档**同口径**：被桑尼米尔克加过费的牌只改实际能量消耗、**不改变**造出的衍生物战力。
       **逐张对应**：弃掉 n 张就产生 n 组衍生物，每组按“被弃掉的那一张自己”的印刷费用算（`give.n`
       与 `discard.n` 相互独立）；`powerFromCost` 缺省 false ＝ 用衍生物自身的印刷战力（如石块＝0）；
    ③ **战力差额记永久增益**：走 `applyPermBuff(t, pw − tk.p, srcCard, '弃牌转化')` 收口 —— 因此
       卡面显示“基础战力 + 绿色 +N”（口径同「赫卡提亚的分身」的快照对齐）、台账 `powerLog` 里
       来源记**本卡**（放大视图可见）；衍生物本体仍是既有 token（如 `SPECIAL.stone`：同名、1 费、
       `tk: 'rock'`）⇒ 照常被大鲶鱼 `playReq` 计数、照吃天子 `og` /「地精的起床」`tkBuff` 的强化；
    ④ **进的是手牌、不是场上**：`newCard` 新实例 + `justHandAdded`（`flushHandAdd` 播“滑入”演出），
       仍需**手动暗出**；`def` / `costMod` 都是全新的（自然为 0）、不继承任何被弃牌的修正；
    ⑤ **手牌上限 7 张照常约束**（同 `give` 口径）：满则加不进、日志写明；本卡实际情形是“先弃 1 张、
       再加 1 张”，故位置一定够（防御分支仅为兜底）；
    ⑥ **加入目标恒为「施放方自己」**：与 `discard.to` 无关——即使弃的是对手的手牌，衍生物也进
       施放方自己的手牌（现无此用法，口径先固定）；
    ⑦ 非“摧毁”/非放置/非增减类机制：与 `surv`/`phx`/`prot`/`ind`、区域字段与格位
       （`sideUsed`/`sideRoom`/`fill`）、`fieldQueue` 全无交互（手牌本就不在场上）；
    ⑧ **只做数据 + 渲染**，日志由调用方（`applyEffect` 的 `case 'discard'`）负责。
   返回 { added, want, name, powers, full, missing }；`spec.give` 缺失时返回 null（＝本子句不参与）。 */
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
      t.side = side;              // ④ 归属＝施放方自己
      t.justHandAdded = true;     // v90：加入手牌演出（渲染后播 .hand-new 滑入）
      const diff = pw - base;
      if (diff !== 0) applyPermBuff(t, diff, srcCard, '弃牌转化'); // ③ 记进这一份实例的永久增益
      hand.push(t);
      added++;
      powers.push(pw);
    }
    if (full) break;
  }
  if (added > 0) flushHandAdd(side); // ④ 立刻渲染手牌 → 本次的“滑入”演出才看得到（同 give v180 口径）
  return { added, want: per * list.length, name: tkDef.n, powers, full, missing: false };
}

/* 弃牌演出（v189 新增；**v190 调整节奏**：切得更晚、消散更快）：**任何一种归属组合**
   （自己弃自己 / 自己弃对方 / 对方弃对方 / 对方弃自己）都**双方可见**——在场地中央弹出**被弃那张牌
   的完整卡面**（复用 `cardFaceHTML` 与 `.zoom-card` 大卡尺寸，故配图 / 费用 / 战力 / 卡名 /
   效果文案与手牌完全一致），随后**从右上到左下**斜切一刀，卡面裂成两半、两半沿对角线垂直方向
   分离（左上那一半往左上飞、右下那一半往右下飞，带轻微旋转）并淡出，全程约 **1.6s**：
     0 ~ 0.27s   卡面放大弹入落定
     0.27 ~ 0.68s **停留展示**（让玩家看清是哪张牌；用户口径：切得晚一点）
     ≈0.68s      斩击线沿对角线**从右上扫到左下**闪一刀，同时卡面在切线处裂成两半
     0.68 ~ 1.30s 两半**快速**分离、下沉、旋转、渐隐（约 0.62s；用户口径：消散快一点）
     1.30 ~ 1.60s 整层收尾淡出
   实现要点：
     ① 元素全部放 body 悬浮层（`.discard-reveal`，z-index 9510）且 `pointer-events:none`，
        不挡操作、不受盘面重渲染影响；播前先清掉可能残留的上一次演出（连续弃牌不会叠层）；
     ② 斜切用 **clip-path 三角**实现：切线＝右上角 → 左下角，两半分别是
        `polygon(0 0, 100% 0, 0 100%)`（上半三角）与 `polygon(100% 0, 100% 100%, 0 100%)`
        （下半三角），两半内部各放一份**同一张卡面的拷贝**（像素级重合），故切开后仍是同一张卡；
        另有一张“基准整卡”在切开那一瞬由 CSS 隐去（与两半完全重合，切换不可见）；
     ③ 斩击线的角度**按卡面实测长宽比**算出（`atan2(h, w)`，`--discard-slash-angle`），
        因此在竖长卡面上也严格贴着右上→左下那条对角线；
     ④ 多张同时被弃时并排展示、逐张错开 80ms（最多错开 320ms），总时长仍在 1.6s 出头；
     ⑤ 收尾用 `setTimeout`（**不依赖** Web Animations 的 finished），保证一定清理掉。 */
function playDiscardFx(cards, side, by) {
  const list = (cards || []).filter((c) => c && c.def);
  if (!list.length) return;
  if (typeof document === 'undefined' || !document.body) return;
  const stale = document.querySelector('.discard-reveal');
  if (stale && stale.parentNode) stale.parentNode.removeChild(stale);

  const wrap = document.createElement('div');
  wrap.className = 'discard-reveal';
  // 多张并排时逐张错开 80ms；整层的时长按“最大错开量”一起延长（CSS 的 --discard-tail），
  // 否则末张的“切开 + 消散”会被整层淡出提前掐掉
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
    const faceHTML = cardFaceHTML(def, { power: live, sign, cost: liveCost, costSign });
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
    // ③ 斩击线：沿“右上 → 左下”的对角线，角度按实测卡面长宽比设定
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

/** v189：弃牌的**控制台 / 开发调试探针** —— **v190 起已有卡引用本键**（「莉莉黑」：弃自己最右侧的 1 张），
    **v191 又添「小野塚小町」**（弃自己手牌里印刷费用最高的一张）；探针仍用于验证任意口径，
    与卡牌结算走**同一个** `discardFromHand` 收口，故流程 / 日志 / 入池 / 演出完全一致。
    例：`Game._discard('a', { n: 1 })` / `Game._discard('p', { card: '琪露诺' })` /
    `Game._discard('a', { cost: { min: 5 }, n: 'all' })` / `Game._discard('p', { pick: 'right' })`（弃自己最右那张）/
    `Game._discard('p', { pick: 'maxCost' })`（弃自己手里印刷费用最高的那张，v191）。 */
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

// 区域-阵营加成：区域 aff 给“所属该阵营（card.def.g）”的卡牌加固定威力。
// 属于常驻实时加成：该卡在此区域的任何实时读取（卡面/总数/摧毁/落后判定/图鉴放大）都计入。
function locRoleBonus(locIdx, card) {
  const aff = locDef(locIdx).aff;
  if (!aff || !card || card.def.un || card.def.spell) return 0; // v170：法术无战力，不吃阵营加成
  const v = card.def.g === aff.group ? aff.add : 0;
  return (v < 0 && locNoDown(locIdx)) ? 0 : v; // v201：免减攻区抹平负加成
}
// 区域-费用加成：区域 cb={c,add} 给位于本区域、费用恰为该值的卡牌加威力
// （如雾之湖对 1 费卡牌 +2；双方卡与特殊卡都算）。
function locCostBonus(locIdx, card) {
  const cb = locDef(locIdx).cb;
  if (!cb || !card || card.def.un || card.def.spell) return 0; // v170：法术不吃费用加成（仍按印刷费用）
  const v = card.def.c === cb.c ? cb.add : 0;
  return (v < 0 && locNoDown(locIdx)) ? 0 : v; // v201：免减攻区抹平负加成
}
// 区域-全体修正：区域 all=N（可为负，如冥界 -2）给本区域所有卡牌（双方、特殊卡）加 N 威力
function locAllBonus(locIdx, card) {
  if (!card || card.def.un || card.def.spell) return 0; // v170：法术不吃全区修正
  const v = locDef(locIdx).all || 0;
  return (v < 0 && locNoDown(locIdx)) ? 0 : v; // v201：免减攻区抹平负修正（如冥界 -2）
}
// 持续效果（og，原「在场光环」）：源卡**已翻开且仍在己方某区**期间，己方场上符合匹配条件的
// 卡牌常驻 +N。动态读取（**实时派生**，不进 powerLog 永久台账）：源卡被摧毁/回手/换边离场即消失。
// 两种匹配口径：
//   ① og.tk（v55 起，如比那名居天子 → 己方带 tk:'rock' 标记的石块）；
//   ② og.cost（v179 起，如克劳恩皮丝 → 己方场上**印刷费用**为该值的卡牌，**含 1 费 token**；
//      口径同「雾之湖」的 cb 费用加成：加费只改 cardCost，不改变印刷费用档位的判定）。
function cardAuraBonus(card, locIdx) {
  if (!card || !card.side || card.def.spell || card.def.un) return 0; // v170：法术无战力，不吃持续加成
  const tk = card.def.tk;
  const cost = card.def.c;
  let b = 0;
  for (let j = 0; j < 3; j++) {
    for (const c of state.players[card.side].zones[j]) {
      const og = c.def.og;
      if (!og || !c.revealed || c.def.un) continue; // 源卡须已翻开且仍在场上
      if (locMuted(j)) continue; // v202：静海「抹除文本」——源卡在静海 ⇒ 它的持续光环整条失效
      if (tk && og.tk === tk) b += og.add;
      else if (og.cost != null && og.cost === cost) b += og.add;
    }
  }
  // v201：免减攻区域 —— 负的持续加成同样按 0 计（与 locRoleBonus/locCostBonus/locAllBonus 同口径）
  if (b < 0 && typeof locIdx === 'number' && locNoDown(locIdx)) return 0;
  return b;
}
// 卡牌在指定区域的实时战力 = 基础威力 + 永久增益 + 区域加成（阵营/费用/全区）+ 持续效果
// v170：法术恒为 0——它没有战力，不吃任何加成（阵营/费用/全区/持续都不适用）
// v201：所在区域带 noDown（蓬莱药局）时，上述实时加成里的**负值一律按 0 计**（免减攻）
function cardPowerIn(locIdx, card) {
  if (isSpell(card)) return 0;
  return cardPower(card) + locRoleBonus(locIdx, card) + locCostBonus(locIdx, card) + locAllBonus(locIdx, card) + cardAuraBonus(card, locIdx);
}
// ---- 占格（occ）口径：普通卡占 1 格；大体积卡（如伊吹萃香 occ:4）占满多格 ----
// 出牌/生成/移动/放满等所有“还能放几张”的判定统一走这里，避免只用 zone.length 误判。
// v170：法术恒按 1 格计（暗牌需要 1 个空位；揭示瞬间同样占 1 格，消散后才腾出）
function occOf(card) {
  if (isSpell(card)) return 1;
  return (card && card.def && card.def.occ) || 1;
}
function sideUsed(side, locIdx) { return state.players[side].zones[locIdx].reduce((s, c) => s + occOf(c), 0); }

/* ---- v200：区域「隙间封格」（地形字段 `gap: N`，现仅「八云紫的家」）----
   每回合结束时，若某侧在本区**还有空位**，就把该侧**最靠后**的格位封成「隙间」（灰卡）。
   实现上**不往 zones 里塞卡**，而是把「已封格数」记在本列（`state.locs[j].gaps`，**双方各一份**），
   该侧**可用格数** = 地形 `max` − 已封数（下限 0）；渲染层照旧只把隙间铺在“空置的不可用格”，
   于是表现就是**最后一格先变灰、逐回合往前推**。
   口径（用户确认，v200）：
     ① **双方分别判定**：某侧在本区已占格 < 该侧可用格数（＝还有空位）时回合末 +N；
        该侧“剩下的空间已经被牌放满”则本次**不加**；之后只要有牌被摧毁/移走腾出空位，
        下一个回合末就继续加（所以某侧的封格数不会超过它“曾经空着”的程度）；
     ② **下限 0**：可以封到该侧一格不剩（此后该侧不能在本区放牌/生成 token；已有卡保留、
        照常计分），到 0 之后自然不会再加（已占格 ≥ 可用格数恒成立）；
     ③ **地形被换掉即清空**（`resetLocGaps`：xform / collapse / 开发者「指定地形」/
        秘封俱乐部的定时变形）——隙间属于「八云紫的家」这块地形，换地形不带过去；
     ④ 只改「能放几张」：隙间**不占 zones 数组**、不进 `zoneTotals` / `powerLog` / `fieldQueue`，
        不触发 `surv`/`phx`/`prot`/`ind`，也不参与任何摧毁/移动/换边的目标选择；
     ⑤ 所有“还能放几张”的判定统一读 `locSideMax`（`sideRoom` / `occZoneOk` / `zoneFillBonus` /
        渲染层格位），因此放牌、落场生成（含 token）、移动（mv/fly/shift/roam/gust）、
        大体积卡上限、`fill` 放满加成全部自动按封格后的格数算。 */
/* ---- v205：区域「已破碎」（天界 `shatter` 摧毁后的状态）----
   天界在同一列「出现」时，会把另外两列的地形**连同其上的所有卡牌**一并摧毁（无视一切防护），
   被摧毁的列就进入「已破碎」：地形换成 `EXTRA.shattered`（max 0 / wt 0 / 无效果），并在
   `state.locs[j].shattered` 上打一个显式标记（渲染层据此把**整列**换成一块损坏面板）。
   判据采用“标记 ∨ 占位地形 id”双保险，故即使某一侧漏设标记也照样算已破碎。
   影响面（全部只读本判定，无一处写状态）：
     · `locSideMax` → 0：`sideRoom` / `occZoneOk` / `zoneFillBonus` / 渲染格位全部自动作废；
     · `locOpen`    → false：放牌 / 移动 / 落场生成 / 复活等“落点合法性”一并挡住；
     · 渲染层 `renderZones` 整列跳过、`renderShatteredColumn` 负责画那块「已破碎」面板；
     · 终局 `finishMatch` 跳过（不计分、不参与胜负）、`playEndHighlights` 跳过放大高亮；
     · 四条件“换地形”的路径一律跳过（`xform` / `xformTurn` / `collapse` / 开发者「🗻 指定地形」）。 */
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
// 该列该侧的**可用格数**（地形 max − 已封隙间数，下限 0；max 缺省按 4）
// v205：已破碎的区域恒为 0（一格不剩 ⇒ 不能放牌、`fill` 不生效、大体积卡也进不来）
function locSideMax(side, locIdx) {
  if (locShattered(locIdx)) return 0;
  const d = locDef(locIdx);
  const base = (typeof d.max === 'number') ? d.max : 4;
  return Math.max(0, base - locGaps(side, locIdx));
}
// 该列两侧中**较大**的可用格数：仅供不带 side 的 occ 判定兜底
// （实际能否落下仍由 sideRoom ≥ occ 把关，故不会因此放错）
function locAnyMax(locIdx) { return Math.max(locSideMax('p', locIdx), locSideMax('a', locIdx)); }
// 地形被换掉时清空两侧隙间（v200：隙间属于「八云紫的家」这块地形）
function resetLocGaps(locIdx) {
  const L = state.locs[locIdx];
  if (L) L.gaps = { p: 0, a: 0 };
}
function sideRoom(side, locIdx) { return locSideMax(side, locIdx) - sideUsed(side, locIdx); }
// 大体积卡只允许放入“该侧可用格数恰为其占格数”的区域（如 occ4 只能进可用 4 格的区域）；
// 不带 side 时按两侧中较大的可用格数兜底（调用方随后仍会用 sideRoom 复核）
function occZoneOk(card, locIdx, side) {
  if (occOf(card) <= 1) return true;
  const m = side ? locSideMax(side, locIdx) : locAnyMax(locIdx);
  return m === occOf(card);
}
// 放满加成：区域 fill=N 时，某一方在本区实际占满**该侧可用格数**（含大体积卡，如 4/4）则该方
// 总战力额外 +N；因摧毁/撤回等原因不足时立即不生效（4→3 不加）。
// v200：可用格数＝地形 max − 已封隙间数；可用格数为 0（被隙间封死）时恒不生效。
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
// 区域“有效战力”（比较口径）：总点数 × dbl 后，若是反转区域（inv，如辉针城）
// 则取负值 —— 实际战力更低的一方在比较中反而更大（= 低者胜）。
function zoneEff(side, locIdx, includeHidden) {
  const t = zoneTotals(side, locIdx, includeHidden) * locDef(locIdx).dbl;
  return locDef(locIdx).inv ? -t : t;
}
// 区域对放牌是否“开放”：带 minTurn 的区域（如七夕坂第 5 回合起）在到达前双方都不能放牌
// v205：已破碎的区域恒不开放（整块区域都不存在了 —— 双方都不能再在此放牌/移动/生成）
function locOpen(locIdx) {
  if (locShattered(locIdx)) return false;
  const mt = locDef(locIdx).minTurn;
  return !mt || state.turn >= mt;
}
function locDef(locIdx) { return state.locs[locIdx].def; }

/* ---- v203：本局总回合数（由地形字段 `extraRound` 驱动，现仅「虚假之月」）----
   口径（用户确认，v203；见 data/locations.js 的 `extraRound=` 字段说明与 docs/现有地形.md）：
     ① **实时读取当前三列**：任一列地形带 `extraRound`（未揭示列是 `unreveal` 占位地形、不带该字段
        ⇒ 天然不算）则本局总回合数为 **7**，否则 6；地形被揭晓 / 变形 / 崩塌 / 开发者指定替换而
        带上或失去该字段时立刻跟着变；
     ② **进入第 7 回合后锁定**：只要 `state.turn` 已到 7 就恒为 7 —— 第 7 回合中途把虚假之月变掉
        也不会提前终局（第 7 回合照常打完、第 7 回合末才结算）；这条也顺带保证**永远不会到第 8 回合**；
     ③ **不叠加**：上限恒为 7（同时有两块带该字段的地形也只延长 1 回合）；
     ④ 全引擎的消费点共四处，一律读本函数以保证一致：终局判定（`playRound`）、能量基数
        （`roundStartStage` 的 `Math.min(回合数, …)`）、斯塔萨菲雅的终局边界（`energyNext`）、
        顶栏「回合 N / 总数」（`renderHud`）。注意 `js/ai.js` 的地形投影与法术调度估值也读它。 */
function fakeMoonOnField() {
  return state.locs.some((l) => l && l.def && l.def.extraRound);
}
function roundsTotal() {
  if (state.turn >= 7) return 7; // ②：已在第 7 回合 → 锁定（同时封住第 8 回合）
  return fakeMoonOnField() ? 7 : 6;
}
/** v203：本局总回合数**发生变化的那一刻**的提示收口 —— 与 `state.roundTotal` 记录值不同才写一条日志。
    值本身是实时读的（顶栏与终局判定不需要本函数），本函数只负责“变化的那一刻”留痕。
    调用点＝①-0 地形揭晓 / ①-0b 定时变形 / 卡牌 `xform` / 地形 `collapse` 崩塌 / 开发者「🗻 指定地形」
    / 每回合开始（防御性再补一次：任何路径漏调都能在回合边界补上）。 */
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
  // v203：顶栏「回合 N / 总数」当场刷新（不等到回合末的 renderAll）——
  // 因此翻牌阶段里被 `xform` 变出/变走的虚假之月也能即时反映到 /7 与 /6。
  renderHud();
}

/* ---------------- 状态 ---------------- */
const state = {
  gen: 0,
  cardSeq: 0,
  turn: 1,
  roundTotal: 6,       // v203：本局总回合数（实时读 roundsTotal()；此字段只用于“变化的那一刻”留痕）
  phase: 'idle',       // idle | play | busy | over
  stakes: 1,
  pSnapped: false,
  aSnapped: false,   // v173：AI 不再加倍（既不主动也不跟进），该标记恒为 false（侧栏「已加倍」标签不再出现）
  locs: [],
  locPlan: [],        // 本局三块“真实地形”按揭晓顺序预存（v74：列 0/1/2 在第 1/2/3 回合开始揭晓）
  players: {
    // v145：能量分边（energyTotal / energyLeft 各自独立；回合开始写入相同基数，之后可单独改）
    // v169：energyGain = 本回合由「额外能量」机制多出来的点数（HUD 显示「N+1」，回合结束归零）
    // v187：特殊牌池（三方各自独立的三条队列，均为“先进先出”的入池顺序）——
    //   destroyPile 摧毁池：真正离场的那次摧毁（dw/dwh/dwb/purge）把**牌本体**入池；
    //   discardPile 弃牌池：**被弃掉的牌**（v189 起实装：弃牌 = 把牌从**手牌**移出，
    //     与摧毁的分工是区域不同——摧毁只作用于场上、弃牌只作用于手牌）；
    //   exilePile   放逐池：用过的法术（揭示结算完后自行消散 vanishSpell）入池。
    // 口径见本文件 PILE_KINDS / pushToPile 段注释与 docs/现有机制.md §6「特殊牌池」条。
    p: { key: 'p', name: '你', zones: [[], [], []], deck: [], hand: [], energyTotal: 1, energyLeft: 1, energyGain: 0, destroyPile: [], discardPile: [], exilePile: [] },
    a: { key: 'a', name: '对手', zones: [[], [], []], deck: [], hand: [], energyTotal: 1, energyLeft: 1, energyGain: 0, destroyPile: [], discardPile: [], exilePile: [] },
  },
  selected: -1,        // 手牌下标
  // v169：能量机制挂钩（斯塔萨菲雅 k='energyNext'）——
  //   pendingEnergyGain：各方「下回合开始额外获得」的能量（一次性，回合开始结算后清空）
  //   pendingEnergySrc：登记这些额外能量的来源卡实例（供下回合的到账演出定位，结算后清空）
  //   players[side].energyGain：本回合实际生效的额外能量（HUD 显示「+N」用，回合结束随下次结算归零）
  pendingEnergyGain: { p: 0, a: 0 },
  pendingEnergySrc: { p: [], a: [] },
  // v185：游戏开始时效果（卡级字段 `gs`，现仅 7 费「哆来咪」）登记的**每回合最大能量加成**——
  // 由阶段 ⓪ runGameStartEffects 写入，在每次回合开始的能量结算（grantTurnEnergy）里并入基数；
  // 与 pendingEnergyGain（一次性、结算后清零）不同：它**本局永久**，只在 restart 时重置。
  energyAddPerTurn: { p: 0, a: 0 },
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
  state.roundTotal = 6; // v203：新一局的总回合数记录回到 6（本局真实值由 roundsTotal() 实时判定）
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
  // v187：清空上一局的特殊牌池（摧毁池 / 弃牌池 / 放逐池——每局重新开始，见 §6「特殊牌池」条）
  state.players.p.destroyPile = []; state.players.p.discardPile = []; state.players.p.exilePile = [];
  state.players.a.destroyPile = []; state.players.a.discardPile = []; state.players.a.exilePile = [];
  pileSide = 'p';   // v187：特殊牌池弹窗的默认查看对象（新一局回到己方）
  pileKind = 'destroy';
  closePiles();     // v187：新一局收起牌池弹窗，避免残留旧局的列表
  // v169：清掉上一局的能量挂钩（额外能量登记、本回合额外能量提示、登记来源）
  state.pendingEnergyGain = { p: 0, a: 0 };
  state.pendingEnergySrc = { p: [], a: [] };
  // v185：清掉上一局的「每回合最大能量加成」——它由本局阶段 ⓪ 的开局效果（gs，如哆来咪）重新登记
  state.energyAddPerTurn = { p: 0, a: 0 };
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
  // v200：gaps = 本列两侧各自的「已封隙间格数」（见 locGaps / locSideMax；换地形时重置）
  // v205：shattered = 本列是否已被「天界」摧毁（见 locShattered；新一局全部回到 false）
  state.locs = picks.map(() => ({ def: hiddenDef, gaps: { p: 0, a: 0 }, shattered: false }));
  shatterChain = null; // v205：丢掉上一局遗留的「天界降临」链条（gen 守卫之外的额外保险）
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
  const gsHits = runGameStartEffects(); // ⓪ 游戏开始效果挂点（v185 起有注册者：7 费哆来咪的 `gs`）
  renderAll();
  // v185：开局若触发了 `gs`（卡组里带了哆来咪），先播「登场」演出，**演完再开始抽卡**
  // （用户口径）；没触发时本函数直接 resolve，不额外等待。
  await playGameStartReveal(gen, gsHits);
  if (gen !== state.gen) return;
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
  // v185：按**曲线里实际用到的**费用档建桶（不再写死 1~6）——两条曲线目前都只到 6 费，
  // 日后若把 7 费（哆来咪）编进曲线，这里也能直接工作，不会因 buckets[7] 不存在而报错。
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
    同时播放「能量到账」演出（顶栏能量框星光 + 「+N 能量」气泡）。
    v185：再并入 `state.energyAddPerTurn`（开局效果 `gs.energyAdd` 登记，现仅哆来咪 +1）——
    它是**本局永久**的（不像 `pendingEnergyGain` 结算后清零），故第 t 回合 = min(t, 6) + N。 */
function grantTurnEnergy(total) {
  for (const side of ['p', 'a']) {
    const pl = state.players[side];
    const gain = state.pendingEnergyGain[side] || 0;
    // v185：开局登记的「每回合最大能量 +N」（`gs.energyAdd`，现仅哆来咪）**本局永久**并入基数；
    // 与一次性 pendingEnergyGain（energyNext）叠加，但不会像它那样结算后清零。
    const gsAdd = state.energyAddPerTurn[side] || 0;
    pl.energyTotal = total + gsAdd + gain;
    pl.energyLeft = total + gsAdd + gain;
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
                  → locXformTurnEffects（①-0b 地形定时变形，v199：第 turn 回合开始时把本区
                  换成随机另一个地形（现秘封俱乐部）+ 立刻结算目标地形的「出现时」效果）
                  → 能量结算 + 抽牌（回合 2+，第 1 回合的 3 张已在开局发放）
                  → 清空回合临时状态
     ② 玩家放置与移动（waitPlayer：出牌 / 移动 / 重置 / 双倍 / 认输均在此阶段）
     ③ 对手放置（aiThink）
     ④ revealRound：翻开暗牌，逐张按放置顺序结算 —— 先区域「翻开时」效果
                    （gamble，如驹草赌场随机 ±1，v156）→ 再该卡自身「揭示」效果
                    → 最后区域「揭示后吹飞」（gust，如魔力风暴吹到另一区，v162）
                    （v207：`retrigger`（东风谷早苗）在“该卡自身揭示”这一步把**本区己方已翻开卡**
                      的揭示逐张再触发一次、每张间隔 0.5s；与 shift/gather/reviveDiscard 同为
                      走分步演出的键，见 revealRound 内的分支；只重触发揭示，不跑 fx 时机效果
                      与 og/surv/phx/prot/ind 等非揭示机制，也不重跑地形类 gamble/gust）
                    （v208/v210：地形「守矢神社」（字段 `repeatReveal`）让**在该区发生的每一次揭示结算
                      都执行两次**（1 次 + 停 400ms 后重复 1 次；仅揭示，持续与回合开始/结束不算）——
                      暗牌翻面走快照资格；**早苗再触发出来的那些揭示也在守矢神社里结算 ⇒ 同样执行两次**）
     ⑤-0 runLocTurnEndEffects：**区域（地形）回合结束效果**——每回合翻牌结算后最先执行：
                    先结算地形（grow 成长 / decay 衰减 → dice 定时掷骰（指定回合）→
                    rally 定时加成（指定回合）→ purge 回合末摧毁 → collapse 崩塌（幽明结界）→
                    gap 回合结束封格（八云紫的家，v200：双方各从后往前添加 1 张隙间）），
                    再进入卡牌时机效果
                    （v153 口径：每回合结束时**先结算地形，再结算场上「回合结束」卡牌**）
     ⑤ runTurnEndEffects：全场“回合结束”卡牌效果（按放置队列序结算）
     ⑥ runHandEndEffects：手牌回合结束效果（**v197 起由稗田阿求使用**，时机键 `fx.handEnd`：
                    只结算“回合结束时**仍在手牌里**”的牌；与 ⑤ 的 `fx.turnEnd`（只结算场上的牌）
                    分工明确、互不串场）
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
    // v202：静海「抹除文本」——在该区的牌其时机效果不结算（错过的时机不补结算）
    if (cardMuted(card)) { muteSkipLog(card, FX_TIMING_TXT[timing] || '时机效果'); continue; }
    applyEffect(card.side, locIdx, card, fx);
  }
}

/* ==================== v185：游戏开始时效果（卡级字段 `gs`，现仅 7 费「哆来咪」）====================
   阶段挂点 ⓪：restart 完成建库/选区/区域生成后、**第 1 回合开始前**执行。时点性质很关键：
   此刻玩家牌库还是完整的 12 张（玩家初始 3 张由 playOpening 在 ⓪ **之后**逐张发放），
   因此 `gs.shuffleN` 洗进去的牌**第一回合就可能被抽到**（用户口径）；
   对手的 3 张起手已在 restart 里先发，故“开局是否拥有这张牌”按**牌库 ∪ 起手 ∪ 场上**判定。
   口径（详见 data/cards.js 的 `gs` 字段说明与 docs/现有机制.md §1「游戏开始时（gs）」段）：
     ① **触发条件**：开局时该卡在**自己一方的牌库/起手中**（＝它被放进了那 12 张卡组）→ 触发，
        且**整局永久生效**：之后它被抽到手、被打出、被摧毁都不回收已洗入的牌与已加的能量；
        开局时它不在牌库（开发调试的空牌库、或没把它放进卡组）则什么都不发生。
     ② `gs.shuffleN`：从**普通卡牌池 `POOL`**（**v194 起为 1 费及以上**，8 费「纯狐」也参与；**含池内法术**）不放回随机抽 N 张互不相同，
        洗入自己牌库并重洗（复用 v184 的 `shuffleCardsIntoDeck` 收口）；**完全不碰衍生池 `SPECIAL`**。
     ③ `gs.energyAdd`：登记本局**每回合最大能量 +N**（`state.energyAddPerTurn` → `grantTurnEnergy`）。
     ④ 每张带 `gs` 的卡各结算一次（正常只能带 1 张，多张则效果叠加）。
     ⑤ **非**“摧毁”/放置/增减类：不进 `powerLog`、不触发 `surv`/`phx`/`prot`/`ind`、不动区域字段、
        不占格位、不进 `fieldQueue`；`gs` 也不是揭示键，`applyEffect` 与
        `revealEffectWillChange` 都不需要分支。 */

/** v185：从「普通卡牌池」POOL 里**不放回**随机抽 n 张互不相同的牌 def（供 `gs.shuffleN` 用）。
    口径：① 只取 **1 费及以上**（v194 放宽，原为 1~6 费）——0 费档按“0 费组不进洗牌”
    的既有口径排除（**v197 起 0 费档已无卡牌**：稗田阿求搬到 1 费组，故它**现在也会被洗入**）；
    **7 费「哆来咪」自己因带 `gs` 被排除、8 费「纯狐」可被抽到**；② **完全不取
    衍生卡池 SPECIAL**（法术 token 与石块/厄运/无限生命泉等普通 token 都抽不到）；
    ③ 排除 `un` 占位卡与**带 `gs` 的卡自己**（避免自我复制——**v194 用户口径的硬性要求**：
    洗入池放宽后仍**不会洗出第二张哆来咪**）；④ **包含 POOL 里的法术卡**（三妖精集结 /
    镇守大地之石 / 地精的起床）；⑤ 池子不足 n 张时返回手上有的那些（可能为空数组）。
    返回 def 数组（不是卡实例）。 */
function randomPoolCards(n) {
  const want = Math.max(0, Math.floor(n || 0));
  if (!want) return [];
  const cands = [];
  for (const c of POOL_COST_KEYS) {
    if (c < 1) continue; // v194：只排除 0 费档（v197 起该档无卡；原写法为 `c < 1 || c > 6`）
    for (const d of (POOL[c] || [])) {
      if (!d || d.un || d.gs) continue; // 带 gs 的卡（哆来咪）不参与抽取 → 不会自我复制
      cands.push(d);
    }
  }
  return shuffle(cands.slice()).slice(0, Math.min(want, cands.length));
}

/** v185：结算一张卡的「游戏开始时」效果（`gs`）——洗入随机牌（shuffleN）+ 登记每回合能量加成（energyAdd）。 */
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

/** 阶段挂点 ⓪：游戏开始效果 —— restart 完成建库/发牌/选区/区域生成后、第 1 回合前执行。
    现注册者（v185）：**7 费「哆来咪」**（`gs: { shuffleN: 10, energyAdd: 1 }`）。
    返回**本次真正触发的卡** [{ side, card, gs }…]（供 restart 播放「登场」演出；
    没触发时是空数组，restart 会跳过演出直接抽卡）。 */
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

/* ==================== v185：开局「登场」演出（`gs` 卡，现仅 7 费「哆来咪」）====================
   触发：restart 的 ⓪ 阶段真的结算了带 `gs` 的卡时，在**洗入 10 张随机牌 + 登记每回合能量 +1
   之后、玩家起手 3 张发放之前**播放一次「凸现」演出（用户口径：动画结束后再开始抽卡）：
     深色遮幕淡入 → 卡面从远处放大弹入（紫金光环脉冲 + 梦之星光迸发 + 轻微抖动）→
     停留展示（看得清 7 费 / 8 战力 / 卡名 / 效果文案）→ 上浮淡出，全程约 1.8s；
   演完 restart 才 `await playOpening(gen)` 逐张抽牌，因此 ⓪ 洗入的牌从抽牌那一刻起才可能被抽到。
   实现要点：
     ① 元素全部放 body 悬浮层（`.gs-reveal`，z-index 9520）且 pointer-events:none，不挡操作、
        不受盘面重渲染影响；播放前先清掉可能残留的上一次演出（重新开局连点也不会叠层）；
     ② 卡面直接复用 `cardFaceHTML(def)`（与手牌/图鉴同款，自带 7 费底色与费用宝珠）
        外加 `.zoom-card` 大卡尺寸，故演出看到的卡面与真卡完全一致；
     ③ 收尾用 `setTimeout`（**不依赖** Web Animations 的 `finished`）——即便动画被中断/浏览器
        不支持 finished，也一定会 resolve，绝不卡住开局流程；
     ④ **不支持 Web Animations 时直接跳过整段演出**（如 jsdom 冒烟测试：`Element.animate`
        不存在）——既不冒险也不拖慢自动化测试；真浏览器里才会看到这段动画。 */
function playGameStartReveal(gen, items) {
  const list = (items || []).filter((it) => it && it.card && it.card.def);
  if (!list.length) return Promise.resolve();
  return new Promise((resolve) => {
    const DUR = 1800; // v186：2.2s → 1.8s（用户口径：演出更短一点；CSS 三处动画时长同步为 1.8s）
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
      face.style.setProperty('--cgrad', gradOf(def)); // 与手牌/图鉴同款底色（含 v185 的 7 费档）
      face.innerHTML = cardFaceHTML(def);             // 费用 7 / 战力 8 / 卡名 / 效果文案
      holder.appendChild(face);
      box.appendChild(holder);
      const note = document.createElement('div');
      note.className = 'gs-reveal-note';
      const bits = [];
      if (it.gs.shuffleN) bits.push(`🃏 洗入 ${it.gs.shuffleN} 张随机牌`);
      if (it.gs.energyAdd) bits.push(`🔋 每回合最大能量 +${it.gs.energyAdd}`);
      note.textContent = bits.join(' · ');
      box.appendChild(note);
      // v186：光环挂在**整个登场块**（`.gs-reveal-item` = 顶部标签 + 卡面 + 底部摘要）上，
      // 而不是只套卡面——这样脉冲在幅度最小时也能把上下两条文字说明一起圈在光环里。
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
    // 梦之星光迸发：等卡面「弹入落定」的那一瞬（约全程 13%，1.8s 下约 240ms）再从卡面中心向外炸开；
    // 等比缩放不影响中心点，故此刻取 `getBoundingClientRect` 的中心即可。
    const faceEl = wrap.querySelector('.gs-reveal-card');
    if (faceEl) {
      const r = faceEl.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) {
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        setTimeout(() => spawnGameStartSparks(cx, cy), 240);
      }
    }
    // 收尾：不依赖 animation.finished，按 DUR 定时清理并 resolve（被重新开局打断也不会卡住流程；
    // 若期间又开了一局，新的 playGameStartReveal 会先把本层残留清掉，旧流程也会因 gen 变化而 return）
    setTimeout(finish, DUR);
  });
}

/** v185：「登场」演出的星光粒子——以锚点为中心向外迸发 💤/✨/🌙/💫（复用 .energy-star 的飞行关键帧，
    追加 .gs-star 换成紫金辉光并提到遮幕之上）。 */
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
//   ⑤ collapse 回合结束崩塌（幽明结界，v163）：本区双方总卡牌数达标即换地形（见 locCollapseEffects）；
//   ⑥ gap 回合结束封格（八云紫的家，v200）：双方各从后往前添加 1 张「隙间」（见 locGapEffects）。
// 同一块地形一般只带其中一类字段；后续新地形机制在此追加。
// ⚠️ collapse 放在地形类效果的**最后**：本回合先按原地形结算其 grow/decay/dice/rally/purge，
//    崩塌后的新地形从**下一回合**起按其规则参与（同一回合不再触发新地形的回合结束类效果）。
//    ⚠️ v200：collapse 变完地形后其后的 gap **一定不生效**（换地形本身已把隙间清空，
//    且目标地形自带 gap 才会触发）——故 gap 排在其后不会与崩塌互相干扰。
// v205：本函数改为 async —— 其内的 collapse 崩塌若崩出「天界」，要等整条摧毁演出播完
//       才进入后面的 gap 封格与阶段 ⑤ 卡牌回合结束效果。
async function runLocTurnEndEffects() {
  locTurnEndPowerEffects();
  locDiceEffects();
  locRallyEffects();
  reactorPurge();
  await locCollapseEffects();
  locGapEffects();
}

// 阶段 ⑤：全场“回合结束”卡牌效果 —— 在区域（地形）回合结束效果（⑤-0）**之后**执行，
// 按场上放置顺序队列先后结算各卡 def.fx.turnEnd。
// 现注册该时机效果的卡：**「蕾米莉亚·斯卡蕾特」（v179）**——`{ k: 'bl', a: 3 }`：
// 每回合末若其所在区域落后（zoneEff 口径，反转区按负值）就永久 +3（可累积，第 6 回合末同样结算）。
function runTurnEndEffects() {
  resolveTimedEffects('turnEnd');
}

/* ==================== v197：手牌回合结束效果（时机键 `fx.handEnd`）====================
   实装自 v54 起预留的空挂点 **阶段 ⑥ `runHandEndEffects()`**：在**阶段 ⑤-0 地形类回合结束效果 →
   阶段 ⑤ 全场「回合结束」卡牌效果（`fx.turnEnd`，只结算**场上**放置队列里的牌）之后**结算，
   逐个检查**双方手牌里仍在手上的牌**自己的 `def.fx.handEnd` 条目。
   ⇒ 与 `fx.turnEnd` 的分工是**区域不同、互不串场**：`turnEnd` **只对场上的牌**触发，
     `handEnd` **只对还在手牌里的牌**触发；同一张牌若两种时机都写，则各自在自己的区域结算。
   首个（也是当前唯一）使用者＝**稗田阿求（v197 重做为 1 费 / 4 战力）**：
     `fx: { handEnd: { k: 'discard', discard: { self: true }, t: '…' } }`
     —— 卡面效果＝**回合结束：若此牌依然在手牌中，则自动丢弃**。
   口径（用户确认）：
    ① **两个子句都要成立**：“回合结束”**且**“此牌仍在手牌中”——打到场上之后（或已被别的效果弃掉、
       被交换、被洗走等任何“不在手牌”的情况）**不再触发**，只记一条无事发生的日志；
    ② **双方一视同仁**：玩家手牌与对手手牌都逐张检查（对手手里的阿求同样会在回合末被丢弃）；
    ③ **每个回合末都结算一次，含第 6 回合末**（阶段 ⑥ 在 ⑦ 终局结算之前；手牌本来不计入终局总点数，
       故它只影响该方「弃牌池」的记录与演出）；
    ④ 逐张**按手牌顺序**结算、逐张入池：同一方手里有 2 张就各弃 1 张（各是各的条目、各记一条日志）；
    ⑤ **走既有弃牌收口** `discardFromHand(side, spec, srcCard, tag, onlyCard)`（v197 新增的
       `onlyCard` 参数把候选收窄到**触发的那一张实例**，故同名双卡不会互相误伤）——
       因此**弃的是「弃牌池」**、**播完整的弃牌演出**（中央弹出完整卡面 + 右上→左下斜切两半，约 1.6s，
       双方可见）、入池元数据（`pileTurn`/`pileBy`/`pileLoc: null`/`pilePower`）与既有弃牌完全一致；
    ⑥ **不是“摧毁”**：不触发 `surv`/`phx`/`prot`/`ind`、不改战力、不动区域字段与格位
       （`sideUsed`/`sideRoom`/`fill`）、不进 `powerLog`、不进 `fieldQueue`（手牌本就不在场上）；
    ⑦ 其它键的 `handEnd`（未来扩展）暂未实装：只记一条 `sys` 日志，不会静默失败。 */
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

// 阶段 ⑦：全场“游戏结束”效果 —— 第 6 回合所有阶段结束后、结算胜负前执行：
// 1) 按场上放置顺序队列先后结算各卡 def.fx.gameEnd；
// 2) 带 leave 的卡（**v197 起本机制无使用者**：唯一使用者「稗田阿求」已重做为
//    `fx.handEnd` 的回合末自我弃牌，`leave` 作为预留机制保留、`runGameEndEffects` 照常处理）终局离场：
//    从场上消失（非摧毁，不触发摧毁类机制、增益随卡一并消失），不再计入终局结算。
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
  const placed = runLocAppearSpawn(idx, def);
  // v205：天界「出现时摧毁另外两块地形」——与本函数同一套「出现时」时机，但它是一条**异步多阶段
  // 演出链**（逐张摧毁 → 等 0.3s → 摧毁地形 → 等 0.3s → 第二块……），这里只负责**启动**；
  // 正常对局的四条路径（揭晓 / 定时变形 / 崩塌 / 卡牌 `xform`）会 `await awaitShatterChain()`
  // 把节奏等完再继续；**开发者工具例外** —— 它启动后立刻关窗，演出在后台播（见 uiOnPickLocConfirm）。
  if (def && def.shatter) startShatterChain(idx, def);
  return placed;
}

/** v150/v165/v166 原有的「出现时**生成**」逻辑（`spawn`）：从 runLocAppearEffect 拆出的纯生成部分
    （v205 拆分只为给 `shatter` 让出收口；生成口径与行为逐字未变）。 */
function runLocAppearSpawn(idx, def) {
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

/* ==================== v205：天界「出现时摧毁另外两块地形」（地形字段 `shatter: true`，现仅「天界」）====================
   一句话口径：天界在本区「出现」的那一刻，把**另外两块地形**连同其上的**所有卡牌**一并摧毁，
   本局此后**只剩本区域可用**；被摧毁的两列变成「已破碎」（看不出原地形、没有双方总点数、不能放牌）。

   节奏（用户确认，v205；**2026 用户复测后把三处等待统一压到 0.3s**）——逐块处理、**左→右**
   （跳过本列与已经破碎的列），每块两阶段：
       ① 依次摧毁该区的所有卡（顺序 = 场上放置顺序队列 fieldQueue；每张间隔 0.3s）
       ② 等 0.3s → 摧毁该地形本身（该列变「已破碎」）
     两块之间再等 0.3s。整条节奏 = 卡A →0.3s→ 地形A →0.3s→ 卡B →0.3s→ 地形B。
     ⚠️ 每张之间的 0.3s **短于** `playShatter` 的分崩离析动画（那个动画本身约 1s，且是**全局共用**
     的摧毁演出，`dw`/`dwh`/`purge` 等都用它，**不能为一处机制单独改短**）——因此现在相邻几张的
     碎裂动画会**重叠播放**（观感是“连续爆裂、一口气全碎”，而不是“一张播完再下一张”）。
     这是“加快节奏”的预期取舍；若日后想恢复“每张完整播完”，把 `SHATTER_CARD_MS` 调回 1000 即可。

   保护（用户确认）：**一切防护一律无视** —— 区域级 `prot`（睡鼠神祠 / 蕾蒂）与卡级 `surv`（灵乌路空）
   / `phx`（藤原妹红）/ `ind`（佛体金刚石）全部不生效、不播任何替代演出（整块区域都不存在了）。
   被摧毁的卡**照常走 `recordDestroy`**：进归属方的摧毁池、计入「纯狐」`costDown` 的摧毁计数。
   含**暗牌**与**落场 token**、以及场上的法术，一视同仁。

   实现要点：
     · 「已破碎」= `state.locs[j].shattered = true` + `def` 换成 `EXTRA.shattered`（`max 0` / `wt 0`），
       于是 `locSideMax`/`sideRoom` 恒 0、`locOpen` 恒 false —— 放牌 / 移动 / 落场生成 / 复活
       全部自动被挡住（含 AI 的落点枚举，它同样读 `sideRoom`/`locOpen`）。
     · 整列外观由 `renderShatteredColumn` 换成一块损坏面板（`.shattered-loc` + `.shatter-block`），
       **不保留地形名、也不保留双方总点数的数字与格位**；`renderZones` 对该列整列跳过。
     · 链条是**单例 Promise**（`shatterChain`）：同一时刻只可能有一条在播（防御重复触发），
       正常对局的四条路径用 `awaitShatterChain()` 等它播完再继续，因此不会与
       「回合开始 / 翻牌 / 回合结束」抢时序；**开发者工具不等**（启动后立刻关窗，演出后台播）。
     · 「不重复摧毁」：已破碎的列直接跳过；另外两列都已破碎则该次「降临」无事发生（只记一条日志）。
     · 「永久锁定」：已破碎的列不会被 `xform` / `xformTurn` / `collapse` / 开发者「🗻 指定地形」再换地形。 */

// 三处等待统一为 0.3s（用户复测后要求“所有的间隔都改成 0.3 秒”，原为 1000 / 500 / 800）。
// ⚠️ `SHATTER_CARD_MS` 现在短于 `playShatter` 的分崩离析动画（约 1s）——相邻几张的碎裂演出会重叠，
//    这是刻意的“加快节奏”取舍（分崩离析是全局共用的摧毁演出，不为一处机制单独改短）。
const SHATTER_CARD_MS = 300;       // 每张卡之间（原 1000）
const SHATTER_TERRAIN_MS = 300;    // 该区最后一张卡 → 摧毁该地形本身（原 500）
const SHATTER_NEXT_LOC_MS = 300;   // 摧毁地形 A → 开始摧毁地形 B 的卡（原 800）

// 正在播放的「天界降临」链条（Promise | null）。单例：同一时刻只播一条。
let shatterChain = null;

/** 整列换成「已破碎」的损坏面板（v205）：看不出原本是哪块地形、没有双方总点数、也没有格位。
    做法是**换掉整个列元素**（连带丢弃原来的点击/悬停监听，破碎列不再触发任何出牌逻辑），
    并把 `Game._els` 里该列的四个引用换成游离占位节点 —— 这样其它按索引取值的渲染代码不会报错。 */
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
    e.stopPropagation(); // 破碎列不参与任何出牌/移动逻辑，只给个说明
    setStatus('此区域已被「天界」摧毁：不能放牌、没有点数、也不参与胜负。');
  });
  col.appendChild(block);
  if (old && old.parentNode) old.parentNode.replaceChild(col, old);
  else if ($('board')) $('board').appendChild(col);
  els.cols[locIdx] = col;
  els.oppZone[locIdx] = document.createElement('div');   // 占位：破碎列没有格位
  els.mineZone[locIdx] = document.createElement('div');
  els.totA[locIdx] = document.createElement('span');      // 占位：破碎列没有点数
  els.totP[locIdx] = document.createElement('span');
}

/** 依次摧毁某区域内**双方的所有卡**（v205，天界专用；**无视 surv/phx/ind/prot**）。
    顺序 = 场上放置顺序队列 `fieldQueue`（与其它摧结束算同口径：谁先放谁先碎），
    不在队列里的（理论不会）按「先己方后敌方、格位顺序」补在后面。
    每张：`recordDestroy`（先记账，须在移出区域之前）→ `playShatter`（分崩离析，悬浮层不受重建影响）
    → 移出区域 → 移出放置队列 → 渲染 → 等 `SHATTER_CARD_MS`。返回实际摧毁张数。 */
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
    playShatter(c);                            // ② 分崩离析演出（悬浮层，约 1s）
    const zone = state.players[c.side].zones[locIdx];
    const i = zone.indexOf(c);
    if (i >= 0) zone.splice(i, 1);             // ③ 移出区域
    dequeueField(c);                           // ④ 移出放置队列（后续时机不再结算它）
    n++;
    renderZones();                             // 让“这张已经没了”立刻可见
    await sleep(SHATTER_CARD_MS);
  }
  log('danger', `☁️ ${srcName}：「${where}」区域上的 ${n} 张卡牌已全部摧毁（含暗牌与落场 token）。`);
  return n;
}

/** 摧毁某区域的**地形本身**（v205）：换成「已破碎」占位地形 + 整列换成损坏面板。
    返回被摧毁的地形 def（供日志/调用方使用）。 */
function shatterZoneTerrain(locIdx, srcName) {
  const L = state.locs[locIdx];
  if (!L) return null;
  const prev = L.def;
  L.shattered = true;
  L.def = findLocDef('shattered') || SHATTERED_LOC_DEF;
  resetLocGaps(locIdx);            // 隙间属于被摧毁的那块地形，一并清空
  renderShatteredColumn(locIdx);   // 整列换成损坏面板（列名 / 效果文字 / 配色 / 格位 全部消失）
  // v203：若被摧毁的正是「虚假之月」→ 本局总回合数当场退回 6（并留一条日志 + 刷新顶栏）
  syncRoundTotal('天界摧毁地形');
  log('danger', `☁️ ${srcName}：「${prev ? prev.icon + prev.n : '该区域'}」的地形被彻底摧毁 → 该列变成「已破碎」（双方区域一并消失，不能放牌、不计分、不参与胜负）。`);
  return prev;
}

/** 「天界降临」链条（v205）：左→右依次摧毁另外两列（卡 →0.3s→ 地形 →0.3s→ 卡 →0.3s→ 地形）。 */
async function runShatterChain(heavenIdx, gen, srcName) {
  const targets = [];
  for (let j = 0; j < 3; j++) {
    if (j === heavenIdx) continue;
    if (locShattered(j)) continue; // ⑥ 不重复摧毁：已经破碎的列直接跳过
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
    await sleep(SHATTER_TERRAIN_MS);            // 0.3s
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

/** 启动「天界降临」链条（同步返回，演出在后台播）。单例：已有链条在播时直接复用、不重复启动。
    ⚠️ 收尾清空时按「还是同一条 Promise」判定（`shatterChain === p`）——这样即使上一局的链条在
    `restart` 之后才收尾，也不会把新一局的链条误清掉（`gen` 守卫之外的额外保险）。 */
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
      // ⚠️ 收尾渲染自带 try/catch：本链条可能是**未被 await 的“后台播”**（如开发者工具里
      //    立刻关窗后就撒手），若 finally 里抛异常会让整条 Promise 变成未处理的 rejection。
      try { if (gen === state.gen) renderZones(); } catch (e) { console.error('[天界] 收尾渲染出错：', e); }
    }
  })();
  shatterChain = p;
  return p;
}

/** 等待正在播放的「天界降临」链条结束（没有链条时立即 resolve）。
    正常对局的四条路径（揭晓 / 定时变形 / 崩塌 / 卡牌 `xform`）都会在启动后 await 它，
    卡牌 `xform` 那条同步路径由 `revealRound` 在每张牌结算后补等 —— 保证节奏不被后续阶段打断。
    ⚠️ 开发者「🗻 指定地形」（`uiOnPickLocConfirm`）**故意不 await**：启动后立刻关窗，演出后台播。 */
async function awaitShatterChain() {
  while (shatterChain) {
    const p = shatterChain;
    await p.catch(() => {});
    if (shatterChain === p) break; // 防御：链条没被清空时避免死循环
  }
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
  for (const c of POOL_COST_KEYS) { // v185：遍历实际存在的费用档（含 7 费组，其 gs 卡不会进集结池）
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

async function locationRevealStage() {
  const st = state;
  const idx = st.turn - 1;
  if (idx < 0 || idx >= st.locs.length) return;
  const loc = st.locs[idx];
  // 该列已揭晓（防御）；v205：已被「天界」摧毁的列也走这里 —— 已破碎列永不揭晓
  if (!loc || !loc.def || loc.def.id !== 'unreveal') return;
  const target = st.locPlan && st.locPlan[idx];
  if (!target) return;
  revealLocFade(idx); // v98：旧“未揭示”外观淡出 700ms（快照需在换 def 前抓取）
  loc.def = target; // 换上真实地形
  resetLocGaps(idx); // v200：换地形 → 清空本列已封的隙间
  refreshLocHeader(idx); // 列名/图标/效果文案/配色即时更新
  log('sys', `🃏 第 ${st.turn} 回合开始：地形「${target.n}」揭晓！`);
  // 揭晓时刻结算该地形的“出现时”生成效果（如虹龙洞给双方各 1 张石块）
  // v205：若揭晓的是「天界」，这里同时启动「摧毁另外两块地形」的演出链
  runLocAppearEffect(idx, target);
  // v203：揭晓出来的地形若带 `extraRound`（虚假之月）→ 本局总回合数当场变 7（顶栏「/ 7」+ 一条日志）
  syncRoundTotal('地形揭晓');
  // v205：把「天界降临」整条摧毁演出等完再回上层 —— 否则回合开始效果 / 抽牌会插进节奏里
  await awaitShatterChain();
}

/* ---- v199：区域「定时变形」效果（字段 `xformTurn: { turn }`，现仅「秘封俱乐部」）----
   在**第 turn 回合的回合开始时**（roundStartStage 的 ①-0b，紧接 ①-0「地形揭晓」之后、
   场上「回合开始」卡牌效果 ①-1 之前）结算：把本区域地形**整体换成地形池里随机另一个地形**，
   并立刻结算目标地形的「出现时」效果（runLocAppearEffect，同 xform / collapse 的 v151 口径）。
   口径（用户确认，v199）：
     ① 候选 = LOCATION_POOL 里**除自身以外**的全部地形（**允许与另外两列当前地形重复**）；
        EXTRA 的非随机地形不入候选，故绝不会变成「未揭示」；
     ② 抽中「上限放不下本区已放卡」的地形（如迷途竹林 max 2 而某侧已放 3 张）**照常变形**——
        口径同「地形揭晓」的超限处理：已放卡不移动、不增删、不摧毁，隙间只铺在“空置”的
        不可用格（见 buildZoneChildren），该侧此后按已满处理；
     ③ 换掉后本区不再带 `xformTurn` 字段，故**只会变形一次**；
     ④ 新地形**从变形那一刻起完全生效**（列头配色随 refreshLocHeader 立即更新），含
        **同一回合末**的 grow/decay/dice/rally/purge 等回合结束类效果；
     ⑤ 若该地形是在第 turn 回合开始**之后**才落到本区的（`xform` 区域变形 / 开发者
        「🗻 指定地形」），该时机已过、**不补结算**（口径同 dice / rally）；
     ⑥ 非“摧毁”/非增减类：不改任何卡牌的战力与格位、不触发 surv/phx/prot/ind、不进
        powerLog（生成物走 placeToken 的既有口径）。
   与另外两个“变形”机制的分工：`xform`（鬼人正邪）＝卡牌揭示时**指定**目标地形且上限
   不足则失败；`collapse`（幽明结界）＝回合末**按本区卡牌数**触发、目标**指定**；本字段
   ＝回合开始时**随机**目标、且**不做上限防御**（按超限口径照常变形）。 */
async function locXformTurnEffects() {
  const st = state;
  let changed = false;
  for (let j = 0; j < 3; j++) {
    if (locShattered(j)) continue; // v205：已破碎的列永久锁定 —— 不再变形（该列也不带任何字段）
    const def = locDef(j);
    const xt = def.xformTurn;
    if (!xt || st.turn !== xt.turn) continue; // 只在指定回合的回合开始结算
    const cands = randomLocCandidates(j); // v213：候选收口（与卡牌键 `xformR` 共用）；口径＝v199 的“只排除自身”
    if (!cands.length) {
      log('danger', `${def.icon} ${def.n}：地形池里没有可变成的其它地形，本次不变形。`);
      continue;
    }
    const target = cands[Math.floor(Math.random() * cands.length)];
    st.locs[j].def = target; // 换上目标地形（上限/加成/反转/… 等字段即刻生效）
    resetLocGaps(j);         // v200：换地形 → 清空本列已封的隙间
    refreshLocHeader(j);     // 列名/图标/效果文案/配色即时更新
    log('sys', `${def.icon} ${def.n}：第 ${st.turn} 回合开始 —— 本区域变成了「${target.icon} ${target.n}」！`);
    // v151 口径：变形 = 该地形在本区“出现”——立刻结算其「出现时」效果
    // （如变成虹龙洞 → 双方各生成 1 张石块；目标无 spawn 时为空操作）
    // v205：随机候选里包含「天界」——变成天界同样会摧毁另外两块地形（整条演出在此等完）
    runLocAppearEffect(j, target);
    // v203：随机变形可能变成「虚假之月」→ 本局总回合数当场变 7（反之变走则退回 6）
    syncRoundTotal('地形定时变形');
    await awaitShatterChain(); // v205：等「天界降临」的摧毁演出播完再继续（场上「回合开始」效果在它之后）
    changed = true;
  }
  if (changed) renderZones(); // 隙间 / 锁定遮罩 / 点数横幅随新地形即时刷新
  return changed;
}

/* ---- v213：区域「随机变形」的**候选收口**（卡牌键 `xformR` 与地形字段 `xformTurn` 共用）----
   候选 = `LOCATION_POOL` 里**除本列当前地形以外**的全部地形：
     · **允许与另外两列当前地形重复**（口径同 v199：不为了“三区互不相同”而缩池）；
     · `EXTRA` 的非随机地形（「未揭示」/「已破碎」）**不入候选** ⇒ 随机变形绝不会变出它们；
     · 池里只剩一块地形（或找不到当前地形，防御）时返回空数组，调用方按“不变形”处理。 */
function randomLocCandidates(locIdx) {
  const cur = locDef(locIdx);
  return LOCATION_POOL.filter((d) => d && (!cur || d.id !== cur.id));
}

/* ==================== v213：区域「随机变形」（卡牌键 `xformR`，现仅 1 费「梅莉」）====================
   一句话口径：**揭示：把本区域地形整体换成地形池里随机另一个地形**，并**立刻结算目标地形的
   「出现时」效果** —— 即把 v199 地形「秘封俱乐部」的 `xformTurn`（第 5 回合随机变形）**搬到卡牌揭示上**
   （梅莉正是秘封俱乐部的成员，与「秘封俱乐部」地形同一机制血缘）。
   写法：`k: 'xformR'`（**无需附加字段**——候选口径写死在共用收口 `randomLocCandidates`）。
   口径（用户确认，v213；**全部沿用 v199 `xformTurn` 的随机变形口径**）：
     ① **候选** = `LOCATION_POOL` 里**除本列当前地形以外的全部地形**（**允许与另外两列当前地形重复**；
        `EXTRA` 的非随机地形不入候选）；
     ② **不做上限防御**：抽中「上限放不下本区已放卡」的地形（如迷途竹林 max 2 而某侧已放 3 张）
        **照常变形** —— 已放卡**不移动、不增删、不摧毁**，隙间只铺在“空置的不可用格”（口径同
        「地形揭晓」/`xformTurn`）；这与卡牌键 `xform` 的“超限则**变形失败**”**刻意相反**；
     ③ **立刻结算目标地形的「出现时」效果**（`runLocAppearEffect`，v151 口径；目标无 `spawn` 则空操作）
        + `resetLocGaps`（清空本列已封隙间）+ `refreshLocHeader`（列名/图标/效果文案/配色即时更新）；
     ④ **落地即全量生效**（口径同 v199 ④）：新地形**从变形那一刻起**按其字段参与，含**同一回合末**的
        `grow`/`decay`/`dice`/`rally`/`purge`/`collapse`/`gap`；
     ⑤ **可能变出特殊地形**：抽到「虚假之月」→ `syncRoundTotal('卡牌区域随机变形')` 让本局总回合数
        当场变 7（已进入第 7 回合则按 v203 锁定为 7）；抽到「天界」→ 照常启动 `shatter` 摧毁链
        （`revealRound` 在本张牌结算后会 `await awaitShatterChain()`，与卡牌 `xform` 同一条兜底 ⇒
        不会与后续翻牌 / 回合末效果抢时序）；
     ⑥ **已破碎的列一律跳过**（`locShattered`）—— 与 `xform`/`xformTurn`/`collapse`/开发者「指定地形」
        四路一致：绝不复活一块被「天界」摧毁的区域；
     ⑦ **非“摧毁”/非增减/非放置**：本键自身不改任何卡牌战力与格位、不触发 `surv`/`phx`/`prot`/`ind`、
        不进 `powerLog`/`fieldQueue`（目标地形若带 `spawn`，其生成物走 `placeToken` 的既有口径）；
     ⑧ **静海**：`applyEffect` 入口守卫照常拦下（文本被抹除 ⇒ 不变形，只记一条日志）。
     ⑨ ⚠️ **可以换掉“尚未揭晓”的列**（现按本键的字面语义放行，用户可另行拍板是否禁止）：候选只看
        “除**当前地形**以外”，而「未揭示」是 `EXTRA` 占位地形、**不在 `POOL` 里** ⇒ 候选仍是全部
        真实地形。因此把梅莉打到**尚未揭晓**的列（第 1/2/3 回合的揭晓尚未发生）并翻开时，她会**当场
        把那一列变成随机真实地形**；由于 `locationRevealStage` 以 `loc.def.id === 'unreveal'` 判断
        “还没揭晓”，该列**原定的揭晓此后会被整段跳过** —— 即 `locPlan` 里预存的那块地形**不会再出现**，
        也不播「未揭示淡出」演出（`state.locPlan` 里的值本身保留、只是不再被消费）。
        若日后要禁止，只需在 `case 'xformR'` 开头加一句“当前地形是 `unreveal` 就不变形”的守卫。
   登记点（三处）：`applyEffect` 的 `case 'xformR'`、`revealEffectWillChange` 的 `xformR` 分支
   （地形池里还有候选才为 true，否则跳过结算前那 400ms 停顿）、`data/cards.js` 的 `KIND_LABEL.xformR`
   （图鉴/详情里的效果标签）。
   ⚠️ **为什么不复用 `xform` + `xf: 'random'`**：`def.xf` 是**地形 id 字段**，`js/ai.js` 的 `case 'xform'`
   会把它当地形 id 查表投影（AI 侧未收录本键 ⇒ 退化成“认不出的效果”，与 v204/v207 新键的既有表现一致）；
   把 `'random'` 塞进 `xf` 会让那条投影拿到一个**不存在的地形 id**。**新键不碰 `xf` 的语义** ——
   `xf` 永远只放真实地形 id。
   与另外几个“变形”机制的分工：`xform`＝卡牌揭示时**指定**目标、**超限则失败**；本键＝卡牌揭示时
   **随机**目标、**超限照常变形**；`xformTurn`（秘封俱乐部）＝**回合开始时**随机，唯一差别是触发时机
   （地形规则 vs 卡牌揭示）；`collapse`＝回合末按**卡牌张数**达标触发、目标**指定**、超限不崩塌。
   ⚠️ **与 v208「守矢神社」的叠加**：本键在守矢神社里翻开会被**执行两次**（资格＝翻开那一刻的快照）
   ⇒ **一次揭示连换两次地形**（第 2 次在 400ms 后，按“换完后的当前地形”重新抽候选）；
   「东风谷早苗」`retrigger` 再触发本键时同理（再抽一次，资格实时读区域）。 */

// 阶段 ①：回合开始 —— 地形揭晓 → 地形定时变形（v199）→ 回合开始效果 → 能量结算 + 抽牌 → 回合状态重置
// v205：本阶段改为 async —— ①-0 / ①-0b 里若出现「天界」，要等它的摧毁演出链播完再继续。
async function roundStartStage(gen) {
  const st = state;
  await locationRevealStage(); // ①-0 地形揭晓：第 t 回合揭晓第 t 列（t=1..3）
  if (gen !== state.gen) return;
  await locXformTurnEffects(); // ①-0b 地形定时变形（v199：秘封俱乐部第 5 回合开始时变随机地形 + 结算其「出现时」）
  if (gen !== state.gen) return;
  // v203：防御性再同步一次本局总回合数 —— 地形变化的各条路径都已各自调用 syncRoundTotal，
  //       这里只是保证“任何漏调的路径”也能在回合边界补上那一条日志（值本身一直是实时读的）。
  syncRoundTotal('回合开始');
  runTurnStartEffects(); // ①-1 全场“回合开始”效果（按放置队列序）
  // v205：①-1 里的卡牌若用 `xform`/`fx` 把本区变成「天界」，等摧毁演出播完再抽牌/结算能量
  await awaitShatterChain();
  if (gen !== state.gen) return;
  // ①-2 抽牌（v94：第 1 回合起每回合双方都各抓 1 张——开局 3 张已逐张发放，第 1 回合再抽第 4 张）
  const drawnP = drawOne('p');
  if (drawnP) drawnP.justDrawn = true; // v91：玩家抽牌入场演出（屏幕右端滑入）
  drawOne('a');
  // ①-2 能量结算：普通局 = min(回合, 本局总回合数)；开发调试 = 固定 10（v143）
  // v145：双方各自一份 energyTotal/energyLeft（基数相同，之后可单独修改）
  // v169：额外能量（energyNext）在 grantTurnEnergy 内一次性并入（并写下 energyGain 供 HUD 提示）
  // v203：上限由写死的 6 改为 roundsTotal()（虚假之月在场 → 第 7 回合双方各 7 点；
  //       该函数在 turn>=7 时锁定为 7，故第 7 回合中途地形被换掉也仍是 7 点）
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
  flushPendingDriftFly(); // v158：回合开始自动移动（幽灵 roam 等）的“滑行+缩放”演出
  log('sys', `—— 第 ${st.turn} 回合 · 双方各抓 1 张 ——`); // v94：含第 1 回合
  const stanceTip = (isDevMode() && st.playAsSide === 'a') ? '【敌方立场】' : '';
  setStatus(`第 ${st.turn} 回合 · 能量 ${st.players.p.energyTotal}${stanceTip}：可一次暗出多张牌（总费用不超过能量），出完点「结束回合」；点能量框可重置本回合暗牌。`);
}

async function playRound(gen) {
  if (gen !== state.gen) return;
  const st = state;
  // v205：阶段 ① 改为 await —— ①-0「地形揭晓」若揭到「天界」，会在这里等整条摧毁演出播完
  await roundStartStage(gen); // 阶段 ①：回合开始（回合开始效果 / 能量结算 / 抽牌）
  if (gen !== state.gen) return;

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
  await revealRound(gen);
  if (gen !== state.gen) return;

  // 阶段 ⑤-0 区域（地形）回合结束效果（先结算地形）→ 阶段 ⑤ 全场“回合结束”卡牌效果
  // → 阶段 ⑥ 手牌回合结束效果（v153：地形恒在场上回合结束卡牌之前结算）
  // v205：⑤-0 改为 await —— 其内的 collapse 崩塌若崩出「天界」，要等整条摧毁演出播完
  await runLocTurnEndEffects();
  if (gen !== state.gen) return;
  runTurnEndEffects();
  runHandEndEffects();
  // v205：⑤/⑥ 里的卡牌若把本区变成「天界」（xform），在这里把摧毁演出等完再进终局判定
  await awaitShatterChain();
  if (gen !== state.gen) return;
  renderAll();

  // v203：终局判定改读本局总回合数 —— 场上有「虚假之月」时第 6 回合末续打第 7 回合；
  //       已到第 7 回合则 roundsTotal() 锁定为 7，故第 7 回合末必定终局（不会出现第 8 回合）。
  if (st.turn >= roundsTotal()) {
    // 阶段 ⑦：游戏结束效果（按放置队列序）→ 终局演出 → 结算胜负
    //（最后一回合 = 第 6 或第 7 回合；其 ⑤-0 / ⑤ / ⑥ 同样先于终局执行）
    runGameEndEffects();
    await awaitShatterChain(); // v205：⑦ 里的卡牌若把本区变成「天界」，等摧毁演出播完再结算胜负
    if (gen !== state.gen) return;
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
  // v202：静海「抹除文本」——静海里的牌失去「每回合移动一次」的能力，不能进入移动模式
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

// 移动模式下点击某区域：把目标卡移过去（未满且已开放；其它情况只提示）
function tryMoveFlyTo(locIdx) {
  const st = state;
  if (st.moveCardId == null) return false;
  const found = findPlayerCard(st.moveCardId);
  if (!found) { st.moveCardId = null; renderZones(); return true; }
  const card = found.card;
  // v202：静海「抹除文本」——防守：已进入移动模式后该区才变成静海（开发者「指定地形」）也不放行
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

/* ==================== v196：卡级放置条件（`playReq`，现仅 6 费「大鲶鱼」）====================
   一句话口径：`playReq: { tk, n }` ＝ **这张牌还在手牌里、即将被打出的那一刻**必须满足的条件；
   不满足就**打不出来**（点区域不落牌 / 区域不高亮 / AI 不出这张），满足才允许暗出。
   ① **时点＝“手牌 → 场上”这一条路径**，且**只查一次**：**打出后不再追踪**——条件依赖的 token
      之后被摧毁/移走/换边（数量掉到 n 以下），这张牌**照常留在场上**，不移除、不变动。
   ② **计数口径**：打出方**自己三个区域**里 **已翻开** 的卡，按 `def.tk` 匹配（现 `'rock'` → 石块）；
      **暗牌不计**、**对方场上的同类 token 不计**、不带该标记的 token 也不计（`un` 占位卡与法术
      本来就不带 tk）。判定方＝这张牌的**打出方**（`side`），与归属方一致。
   ③ **其它“上场”路径一律不检查**（用户口径）：复活弃牌池 `reviveDiscard`、变身 `morph` 的复制体、
      落场生成（`placeToken` / `clone` / `spawn*`）都不受限；`give` 塞进手牌后**再由手牌打出时**
      照常检查（检查的就是“手牌里这张牌”）。
   ④ **不是“摧毁”/非增减/非放置类**：不触发 `surv`/`phx`/`prot`/`ind`、不动区域字段与格位
      （`sideUsed`/`sideRoom`/`fill`）、不进 `powerLog`、不进 `fieldQueue`。
   返回 { ok, need, have, label }；不带 `playReq` 的卡恒为 ok。 */
function playReqCheck(side, card) {
  const req = card && card.def && card.def.playReq;
  if (!req || !req.tk) return { ok: true, need: 0, have: 0, label: '' };
  const need = Math.max(1, req.n || 1);
  let have = 0;
  for (let j = 0; j < 3; j++) {
    for (const c of state.players[side].zones[j]) {
      if (!c.revealed || c.def.un || c.def.spell) continue; // 只算已翻开的普通卡
      if (c.def.tk !== req.tk) continue;
      have++;
    }
  }
  return { ok: have >= need, need, have, label: tokenNameLabel(req.tk) };
}
// v196：由 token 种类标记（`def.tk`，如 'rock'）反推一个可读标签（现 'rock' → 石块）——
// `tkBuff` 段与新增的 `playReq` 共用（tk 标记没有中文名表，只能从带该标记的 token 卡名反推）。
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
  const side = playSide(); // v144：开发调试可切到敌方立场落牌
  // v196：卡级放置条件（`playReq`，现仅 6 费「大鲶鱼」）——只在“从手牌打出”这一刻检查，
  //   不满足就**不落牌、不扣能量**，并说明当前数量（打出后不再追踪，见 playReqCheck 注释）。
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
    if (back.length >= locSideMax('p', from)) continue; // 理论不会发生：先重置暗牌已腾位（v200：按该侧可用格数判）
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

async function revealRound(gen) {
  const st = state;
  if (gen === undefined) gen = st.gen; // 兼容旧调用（本函数此前无参）
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
    // v208：地形「守矢神社」（字段 repeatReveal）——**资格按“翻开那一刻”快照认定**（用户口径）：
    // 在翻牌途中本列被卡牌 xform 换成别的地形（如灵乌路空 → 聚变反应炉）也**照常**重复一次，
    // 故这里先把本列此刻是否带 repeatReveal 记下来，等该卡自身揭示结算完（法术则是消散之前）再用。
    const repeatRevealHere = !!locDef(mv.loc).repeatReveal;
    renderZones(); // 翻面：新元素带 .played-now → CSS flipIn（0.5s 从小到大缩放）入场
    log(mv.side, isSpell(card)
      ? `「${card.def.n}」翻牌 — 法术（无战力；揭示效果结算后消散）`
      : `「${card.def.n}」翻牌 — 威力 ${cardPowerIn(mv.loc, card)}`);
    let willChange = false;
    if (card.def.k) {
      // v202：静海「抹除文本」——在带 mute 的区域里翻开的牌，其文本视为不存在 ⇒ 揭示不发动。
      // 四个走分步演出的键（shift / gather / reviveDiscard / v207 的 retrigger）也一并在这里拦下，
      // 不必进各自的演出函数（否则它们会绕过 applyEffect 入口的守卫）。
      if (cardMuted(card)) {
        muteSkipLog(card, '揭示效果');
      } else {
        // 只有效果“真的会造成变化”时才停顿展示（缩放动画同时播放，避免同帧重建吞掉入场）
        willChange = revealEffectWillChange(mv.side, mv.loc, card);
        if (willChange) await sleep(400);
        // v209/v210：翻牌流程内的**揭示分派统一收口**到 resolveRevealInZone()——
        // 它先按 resolveCardReveal 走该键的结算（四个「分步演出」键走各自的异步分步版：
        // 八云紫每张 0.3s / 三妖精集结每区 0.5s / 四季映姬每张 500ms / 早苗每张 0.5s），
        // 再按本列是否带 `repeatReveal` 决定**是否再来一次**（守矢神社：本区发生的揭示执行两次；
        // 资格用上面翻面瞬间的快照 `repeatRevealHere`）。**早苗再触发的每一条揭示也走同一条收口**
        // （见 retriggerOneStaged），故“她再触发出来的揭示”同样会被本区加倍——用户口径的 6 次链。
        await resolveRevealInZone(mv.side, mv.loc, card, repeatRevealHere);
        if (willChange) renderZones(); // 效果确有变化才重建（白板/未触发时保留入场元素直到动画播完）
      }
    }
    // v208/v210：地形「守矢神社」（字段 repeatReveal）——**在本区域发生的揭示结算执行两次**。
    // 这里**不再单独调用**重复：上面那句 `resolveRevealInZone(...)` 已经把「第 1 次 + 重复一次」
    // 一起做完了（所以才排在法术消散 `vanishSpell` 之前：自身揭示 → 停 400ms → 重复 → 才消散），
    // 也排在「揭示后吹飞」gust 之前，而资格用的是翻面瞬间的快照 `repeatRevealHere`。
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
    // v205：若这张牌的揭示用 `xform` 把本区变成了「天界」，它的摧毁链是**同步启动、异步播放**的
    // （`case 'xform'` 在 applyEffect 里，改不成 async）——在这里把整条演出等完，
    // 再进入下一张翻牌与随后的 ⑤-0 / ⑤ / ⑥，避免后续阶段插进摧毁节奏里。
    await awaitShatterChain();
    if (gen !== state.gen) return;
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
  // v202：静海「抹除文本」——被抹除的牌不会产生任何变化（也不空等结算前的 400ms 停顿）
  if (cardMuted(card)) return false;
  switch (def.k) {
    case 'bf': return mine.some((c) => c !== card && !c.def.un && c.revealed);
    case 'de': return vis.length > 0 && !locNoDown(locIdx); // v201：本区「免减攻」→ 不产生变化，跳过结算前停顿
    case 'ba': return true; // 至少自己已翻开会吃到 +N
    case 'bl': return zoneEff(side, locIdx) < zoneEff(other, locIdx);
    case 'dw':
    case 'dwh': {
      // v180：ind 卡（佛体金刚石）**照常参与判定**，只是判定落在它身上时摧毁失败、判定结束——
      // 因此这里的预判要复刻“谁会被判定选中”：dw 取最弱（并列取先遇到的那张，与实际结算同序），
      // dwh 取最强（并列里随机挑一张 → 只要并列池里有一张不是 ind 就可能真的产生变化）。
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
      // v172（火神之光）：摧毁本区**双方**最弱随机一张——本区（敌我合计）存在可摧毁的
      // 已翻开卡、且本区没有免摧毁时，才真的会造成盘面变化（否则跳过结算前的停顿）
      // v180：ind 卡照常参与“最低”判定与并列随机抽取 → 只在并列池里还有非 ind 卡时可预测会变化
      const both = mine.concat(theirs).filter((c) => c.revealed && !c.def.un && !c.def.spell);
      if (both.length === 0 || locNoDestroy(locIdx)) return false;
      let minBoth = Infinity;
      for (const c of both) minBoth = Math.min(minBoth, cardPowerIn(locIdx, c));
      return both.filter((c) => cardPowerIn(locIdx, c) === minBoth).some(isDestroyable);
    }
    case 'dwc': {
      // v195（妖精大战争）：摧毁**双方三个区域**所有印刷费用为 `dwc.cost`（缺省 1）的已翻开卡牌——
      // 只要**任一区域**存在「不在免摧毁区 + 会被判定选中 + 真能产生变化」的该费用牌就为 true
      // （逐区判 `locNoDestroy`，与 dw/dwh/dwb 同口径；`isDestroyable` 排除 ind，但保留 phx/surv）
      const wantC = (def.dwc && def.dwc.cost != null) ? def.dwc.cost : 1;
      for (let j = 0; j < 3; j++) {
        if (locNoDestroy(j)) continue; // 该区免摧毁 → 整区跳过，不产生变化
        const z = st.players[side].zones[j].concat(st.players[other].zones[j]);
        if (z.some((c) => c.def.c === wantC && isDestroyable(c))) return true;
      }
      return false;
    }
    case 'deAll': {
      // v180（蓬莱的玉枝·法术）：敌方**三个区域**所有已翻开卡牌各 −N——只要对方场上
      // 任一区域存在可被削弱的已翻开卡（排除 un 与法术）就真的会产生变化
      // v201：该区域带 noDown（蓬莱药局）时那里的卡吃不到 −N，故逐区排除后再判断
      return st.players[other].zones.some(
        (z, j) => !locNoDown(j) && z.some((c) => c.revealed && !c.def.un && !c.def.spell)
      );
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
      // v179（镇守大地之石）：`fill: true` 时张数按“填满”算，且那张法术会**先消散、再铺满**
      //   （把自身占的那 1 格也让给石块），因此只要该侧还有空格（或自身正占着 1 格）就会发生变化
      const sp = def.spawnS;
      const tk = sp && TOKENS[sp.card];
      if (!tk) return false;
      if (sp.fill) return sideRoom(side, locIdx) + (def.spell ? 1 : 0) > 0;
      const cnt = sp.n || 1;
      return Math.min(cnt, sideRoom(side, locIdx)) > 0;
    }
    case 'spawnMine': {
      // v180（耀眼之龙玉·法术）：给**己方每个区域**（含本区）自己一侧各生成 n 张「龙玉」——
      // 只要有**任一区域**已开放且自己一侧还放得下（occ 口径；法术本区那 1 格仍算占用）
      // 就会真的产生变化；三个区域都放不下/未开放则本次揭示落空、跳过结算前的停顿。
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
      // v179（地精的起床）：两个子句任一成立才算会真的产生变化——
      // ① 可选落场生成子句（spawnS 口径）：该侧还放得下（fill 写法再算上自身那格）；
      // ② 标记卡增幅子句：己方（own）/场上双方存在**已翻开**的该 tk 标记卡。
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
    case 'shuffleIn': {
      // v184（洗入卡组）：条目合法且张数 > 0 时**一定**会产生变化（牌库张数与抽牌顺序都会变），
      // 不像 `give` 那样会因“手牌已满”而落空 → 照常走结算前的停顿与演出；键名写错时不空等。
      const si = def.shuffleIn;
      return !!si && !!findCardDefByKey(si.card) && (si.n || 1) > 0;
    }
    case 'reviveDiscard': {
      // v192（复活弃牌池）：只要**弃牌池里存在至少一张能落地的角色卡牌**就真的会产生变化——
      // 「能落地」＝存在一个已开放（locOpen）且自己该侧放得下（sideRoom ≥ 占格数）的区域；
      // 池空 / 只有法术 / 三个区域都满或未开放 → 本次揭示落空，跳过结算前的 400ms 停顿。
      const rp = pileOf(side, 'discard');
      return rp.some((c) => {
        if (!c || !c.def || c.def.spell) return false; // ① 只复活角色卡牌（法术不参与）
        for (let j = 0; j < 3; j++) {
          if (locOpen(j) && sideRoom(side, j) >= occOf(c)) return true; // ③ 有可落地的随机区域
        }
        return false;
      });
    }
    case 'discard': {
      // v189（弃牌）：只有目标方手牌里**真的存在**符合 `card`/`cost` 筛选的候选时才会产生变化
      // （手牌为空、或手里的牌都不满足条件 → 本次揭示落空，跳过结算前的 400ms 停顿）。
      // v198：可选子句 `give`（弃牌后加手牌衍生物）**只在弃牌成功时才结算**，故本判定无需改动
      // ——候选为 0 时弃牌与加衍生物一起落空，候选 ≥1 时两者都会发生。
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
      // v213（1 费「梅莉」）：区域随机变形 —— 只要本列**未破碎**、且地形池里还有“除本列当前地形
      // 以外”的候选，这次揭示就一定会改盘面（换地形 + 结算目标地形的「出现时」效果），
      // 因此照常走结算前那 400ms 的停顿与翻牌演出。
      if (locShattered(locIdx)) return false;
      return randomLocCandidates(locIdx).length > 0;
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
    case 'retrigger': {
      // v207（东风谷早苗）：本区存在**可再触发的己方已翻开卡牌**（带 k、排除自己 / 法术 / un /
      // 同为 retrigger 的卡）才真的会产生变化——否则跳过结算前的 400ms 停顿（口径同 gather/reviveDiscard）。
      return retriggerTargets(side, locIdx, card).length > 0;
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
  // v201：区域「免减攻」（地形字段 noDown，现仅「蓬莱药局」）——**负增量在生效前被拦下**：
  // 卡牌战力原封不动、不写 powerLog、不排 −N 演出；返回 false 供调用方调整汇总日志。
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
  recordSpellExile(card, locName); // v187：用过的法术 → 牌本体进归属方的「放逐池」（不是被摧毁，不进摧毁池）
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
  if (locDef(locIdx).prot) return true; // v164：地形级免摧毁（如睡鼠神祠）——地形效果，不受静海影响
  for (const s of ['p', 'a']) {
    for (const c of state.players[s].zones[locIdx]) {
      if (!c.revealed || !c.def.prot) continue;
      // v202：静海「抹除文本」——卡级 prot（蕾蒂）的文字也被抹除 ⇒ 不再提供区域免摧毁
      if (locMuted(locIdx)) { muteSkipLog(c, '「区域免摧毁」（prot）'); continue; }
      return true;
    }
  }
  return false;
}

/* ==================== v201：区域「免减攻」（地形字段 `noDown: true`，现仅「蓬莱药局」）====================
   一句话口径：本区域的**所有卡牌**（双方、含暗牌与落场 token）**无法被减少战力**——
   一切“负的战力增量”在生效前被拦下：卡牌战力原封不动、不写进战力影响历史（`powerLog`）、
   不播 −N 演出，只记一条 `sys` 日志说明“免于减攻”。
   结算入口：**唯一收口 `applyPermBuff(card, d, …)`** —— `d < 0` 且该卡此刻在带 `noDown` 的区域
   （`cardNoDown`，按 `fieldLocOf` 实时查）时直接返回 `false` 表示“被拦下”（调用方据此调整日志）。
   覆盖的负增量来源（用户口径：**所有会让本区卡牌战力下降的效果**）：
     ① 卡牌揭示类：`de`（本区敌方 −N）、`deAll`（敌方全场 −N）；
     ② 地形类：`decay` 衰减、`dice` 掷出负、`gamble` 掷出负、`rally` 的负 `add`；
     ③ 其它走同一收口的负差：`surv` 防摧毁的“替代降攻”、分身/衍生物与本体战力对齐时的负差；
     ④ **实时负加成一并抹平**：本区地形若带负的 `all` / `cb` / `aff`（或己方持续 `og` 为负），
        对本区卡牌按 **0** 计（`locRoleBonus` / `locCostBonus` / `locAllBonus` / `cardAuraBonus`
        内 clamp；战力影响历史面板同口径，避免“面板合计 ≠ 场上战力”）。
   口径边界（用户确认，v201）：
     · **不追溯、不恢复**：地形出现前已经吃到的减攻留在卡上（`buff` 里的负值照常计入战力），
       本机制只拦“结算那一刻人在本区域”的卡；卡被移出本区/离场后立即不再受保护；
     · **不是“摧毁”类**：与 `surv`/`phx`/`prot`/`ind` 无耦合；但 `surv` 的“替代降攻”被拦下时，
       该卡**不离场、也不降攻**（两个防护叠加，完全免费，见 `surviveDestroy`）；
     · **卡牌自身的印刷负战力不算“被减攻”**：厄运 −3 / 水银 −1 进本区照常是负战力；对方往本区
       塞这类负战力 token 也照常（那是“放入新卡”，不是“减少已有卡的战力”）；
     · **法术**恒为 0 且不吃任何增减（v170），与本机制无交互；
     · 不影响区域总点数口径（`dbl`/`inv`/`fill` 照常），也不阻止“卡牌被摧毁导致区域总点数下降”。 */
function locNoDown(locIdx) {
  const L = state.locs[locIdx];
  return !!(L && L.def && L.def.noDown);
}
// 某张卡此刻是否受「免减攻」保护：必须在场上，且其当前所在区域带 noDown
function cardNoDown(card) {
  if (!card) return false;
  const j = fieldLocOf(card);
  return j >= 0 && locNoDown(j);
}

/* ==================== v202：区域「抹除文本」（地形字段 `mute: true`，现仅「静海」）====================
   一句话口径：本区域的**所有卡牌**（双方，含暗牌、落场 token 与法术）**失去卡牌文字**——
   卡面上写的效果一律视为不存在、**任何时机都不发动**（用户口径）。
   判定方式＝**实时读法、零状态**（与 v200 `gap` / v201 `noDown` 同一思路，不改卡的任何数据）：
     ① `locMuted(locIdx)`：该列当前地形是否带 `mute`；
     ② `cardMuted(card)`：该卡**此刻是否在场上、且所在区域带 `mute`**（按 `fieldLocOf` 实时查）
        ——手牌 / 牌库 / 三个牌池里的同名卡**完全不受影响**（它们不在场上）。
   因此**静海被换掉（xform / collapse / xformTurn / 开发者「🗻 指定地形」）或卡被移出本区
   （mv / fly / shift / roam / gust）即自动恢复**文本，不需要任何收尾代码。
   被抹除的范围（用户确认，v202）：
     · **揭示 `k`**（含 shift / gather / reviveDiscard / retrigger 四个走分步演出的键）：翻开时不发动；
     · **持续 `og`**：**源卡**在静海 → 它的光环整条失效；被加成的卡在静海**不影响**
       （光环是被动接收的，只要源卡在静海外就照常给）；
     · **时机效果 `fx`**（turnStart / turnEnd / gameEnd）：在静海期间不结算，**错过的时机不补结算**；
     · **防护/替代**：`surv`（防摧毁）/ `phx`（凤凰重生）/ `prot`（蕾蒂的区域免摧毁）/
       `ind`（自身不可摧毁）——它们也是“卡面文字”，在静海内**一并失效**；
     · **`fly`**（每回合移动一次）：在静海内不能用该能力；
     · **法术**：揭示不发动，但**照常消散**（消散是 v170 的法术规则、不是卡面文字）→ 仍进放逐池。
   **不受影响**（用户口径：“只有在静海里的牌才会被影响”）：
     · `costDown`（纯狐：在手牌/牌库里就生效的减费）、`gs`（哆来咪：开局在卡组即触发）、
       `playReq`（大鲶鱼：只在“手牌→场上”那一刻校验，打出后不再追踪）；
     · 卡的数值与物理属性：印刷费用 `def.c`、基础威力 `def.p`、阵营 `g`、
       **`occ` 大体积占格**（视为物理属性：静海里的萃香仍占 4 格）；
     · **区域类效果**（地形写的，不是卡面文字）：`aff` / `cb` / `all` / `fill` / `inv` / `purge` /
       `grow` / `decay` / `dice` / `rally` / `gamble` / `gust` / `gap` / `noDown` / `prot` 照常；
     · 卡照常能被增益 / 削弱 / 摧毁 / 移动 / 换边（它只是“哑巴”，不是 `un` 占位卡）；
       `dw`/`dwh`/`dwb`/`dwc`/`purge` 的**候选与筛选口径完全不变**（按威力/按印刷费用照选它）。
   **不追溯**：静海出现前已经结算过的永久效果留在卡上（`buff` / `powerLog` 不回滚）；
   在静海期间因被抹除而错过的揭示 / 时机效果**不补结算**（口径同 `dice`/`rally` 的“时机已过不补”）。
   **日志**：每张牌**首次**被拦截时记一条（`card.muteNoted` 标记，避免每回合刷屏）。
   守卫点一览（全部读上面两个判定，无一处写状态）：`applyEffect` 入口（覆盖揭示 / 时机 / morph /
   集结 / 复活等所有连锁路径（v207 的 `retrigger` 再触发也逐张经过本入口））、`revealRound`（含四个分步演出键）、`resolveTimedEffects`、
   `revealEffectWillChange`、`cardAuraBonus` + `powerHistoryRows`（og 源卡）、`locNoDestroy`（蕾蒂）、
   `isDestroyable` / `indestructibleBlock` / `surviveDestroy` / `phoenixRevive`、
   `uiMoveFly` / `tryMoveFlyTo` / `renderZones` 的 canFly、`showFieldCard`（显示）。 */
function locMuted(locIdx) {
  const L = state.locs[locIdx];
  return !!(L && L.def && L.def.mute);
}
// 某张卡此刻是否“文本已被抹除”：必须在场上，且其当前所在区域带 mute
function cardMuted(card) {
  if (!card || !card.def) return false;
  const j = fieldLocOf(card);
  return j >= 0 && locMuted(j);
}
// 时机名 → 日志里的可读说法（供 resolveTimedEffects / applyEffect 的拦截日志复用）
const FX_TIMING_TXT = { turnStart: '「回合开始」效果', turnEnd: '「回合结束」效果', gameEnd: '「游戏结束」效果' };
/* 被「静海」抹除导致的拦截日志：每张牌**首次**记一条（kindTxt 如「揭示效果」「回合结束效果」
   「防摧毁」等），返回 true = 本次确实记了日志（false = 这张牌此前已提示过）。 */
function muteSkipLog(card, kindTxt) {
  if (!card || !card.def || card.muteNoted) return false;
  card.muteNoted = true;
  const j = fieldLocOf(card);
  const where = j >= 0 ? `「${locDef(j).n}」` : '场上';
  log('sys', `🌊 「${card.def.n}」在${where}失去了卡牌文字 → ${kindTxt}不发动（本局首次提示；该牌离开静海后文本会恢复）。`);
  return true;
}

/* ---- v180：自身不可摧毁（def.ind，现仅「佛体金刚石」ind:true）----
   口径（**v180 修订：判定式免疫，不是“跳过”**）：带 ind 的卡**照常参与摧毁判定**——
   `dw`（最弱）/`dwh`（最强）/`dwb`（双方最弱随机一张）/地形 `purge`（最低）算“谁是目标”时
   **把它一起算进去**；一旦判定**落在它身上**：
     ①**摧毁失败**：它不离场、战力不变，**也不触发** `surv`（改降战力）/ `phx`（回手成长）
       等“被摧毁时”的替代机制；
     ②**本次摧毁判定就此结束**：**不会改打其他牌**（如「聚变反应炉」里本区只有
       金刚石 6 力 + 辉夜 8 力时，判定落在 6 力的金刚石上 → 失败 → 辉夜**存活**）。
   ⚠️ 与“把它剔出候选池、改杀下一张”是**两种不同口径**：后者等于白送一次摧毁指向，本卡不采用。
   与 `prot` 的区别：`prot`（蕾蒂 / 地形「睡鼠神祠」）是**区域免摧毁**，保护**本区双方全部**卡牌、
   且在任何判定之前直接拦掉整条效果；`ind` **只保护它自己**（判定的对象集合不变，只是它打不死）。
   与 `surv` 的区别：`surv` 被点名后**永久 −N 战力**；`ind` 被点名后**什么都不发生**。
   ⚠️ 非“摧毁”类效果（战力增减 / 移动 `mv` / 换边 `switch`·`gift` / 回手等）照常对它生效。
   唯一收口 `indestructibleBlock`（结算点：dw/dwh/dwb/purge 各自选完目标之后）；
   `isDestroyable` 只用于 revealEffectWillChange 预判“这次摧毁会不会真的产生变化”。 */
function isDestroyable(card) {
  if (!card || !card.revealed || card.def.un || card.def.spell) return false;
  // v202：静海「抹除文本」——在静海里的 `ind` 同样被抹除（不再免疫摧毁）；本函数只作预判、不记日志
  return !(card.def.ind && !cardMuted(card));
}

/* v180：摧毁判定落在 ind 卡上时的统一处理 —— 记一条日志并返回 true，
   调用方据此**结束本次摧毁判定**（不离场、不改打其他卡、不触发 surv/phx）。
   返回 false = 该卡没有 ind，按原逻辑继续（phx → surv → 移除）。 */
function indestructibleBlock(card, srcName) {
  if (!card || !card.def || !card.def.ind) return false;
  // v202：静海「抹除文本」——静海里的 `ind` 已被抹除 ⇒ 不拦、照常摧毁（“判定结束、不改打别的”不再适用）
  if (cardMuted(card)) { muteSkipLog(card, '「自身不可摧毁」（ind）'); return false; }
  log('sys', `✦ ${srcName} 的摧毁判定落在「${card.def.n}」上，但它自身不可摧毁（无法被摧毁）→ 本次摧毁失败、判定结束（不改打其他牌）。`);
  return true;
}

// 防摧毁（def.surv=N，现仅灵乌路空 surv:2）：该卡被任何“摧毁”指向时不会离场，
// 取而代之**永久降低 N 点战力**（每次触发再降 N、可多次；若被反应炉类反复点名会反复降低）。
// 返回 true = 已替代（卡仍在场、由本函数自行记账）；false = 按原样移除摧毁。
function surviveDestroy(card) {
  const surv = card && card.def && card.def.surv;
  if (!surv) return false;
  // v202：静海「抹除文本」——静海里的「防摧毁」一并失效 ⇒ 该卡照常被摧毁（不降战力、不离场替代）
  if (cardMuted(card)) { muteSkipLog(card, '「防摧毁」（surv）'); return false; }
  // v201：区域「免减攻」（蓬莱药局）——替代降攻被拦下 ⇒ **不离场、也不降攻**（两个防护叠加）
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

// 凤凰重生（def.phx=N，现仅藤原妹红 phx:2）：被任何“摧毁”指向时**不消失**，
// 而是从场上移除后**返回自己手牌**并**永久 +N 战力**（每次触发 +N、可重复打出并再次触发）；
// 手牌已满 7 张则重生失败、按原样被摧毁。
// 返回 true = 本次摧毁已由本函数处理完毕（调用方不得再移除该卡）；false = 按原样移除摧毁。
function phoenixRevive(card, locIdx) {
  const phx = card && card.def && card.def.phx;
  if (!phx) return false;
  // v202：静海「抹除文本」——静海里的「凤凰重生」一并失效 ⇒ 该卡照常被摧毁（不回手、不 +N）
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

/* ==================== v192：复活弃牌池（`reviveDiscard` 效果键，现仅 6 费「四季映姬」）====================
   v193：**分步演出** —— 正常翻牌流程里由异步版 `applyReviveDiscardReveal` 驱动：
   逐张推进「**从池中捞出一张 → 渲染（播「凝聚显形」）→ 结算它自己的揭示 → 停 500ms → 下一张**」，
   避免一次性复活一大把牌（连锁揭示/生成叠加、演出互相盖住、极端情况下的渲染压力）。
   下面三个收口被同步版（applyEffect 的 case 'reviveDiscard'，供 morph / fx 时机效果 /
   落场生成等非翻牌路径使用）与异步分步版共用，保证两条路径口径完全一致：
     · reviveTargetZones(side, card)：候选区（**只在已开放且该侧放得下的区域里随机**，v192 用户口径）
     · reviveCardFromPile(side, card, pile)：离池 + 落地即翻开 + 占格位 + 进放置队列，返回落点区
     · reviveStuckLog(...)：收尾日志（法术不参与 / 无处可放 / 汇总）
   节奏常量 REVIVE_STEP_MS = 500（相邻两张之间；与 v171「集结」的 0.5s 同款口径；
   它是**纯 JS 计时**、没有对应的 CSS 关键帧，改节奏只改这一个数）。 */

/** v192：某张弃牌池里的牌**能落到哪些区**——候选 = 已开放（`locOpen`，避开七夕坂等 minTurn 锁定）
    且**自己该侧放得下**（`sideRoom ≥ occOf`，含大体积卡占格）。返回区域下标数组（可能为空）。 */
function reviveTargetZones(side, card) {
  const out = [];
  for (let j = 0; j < 3; j++) {
    if (!locOpen(j)) continue;                  // 未开放不算候选
    if (sideRoom(side, j) < occOf(card)) continue; // 该侧放不下（含大体积卡占格）不算候选
    out.push(j);
  }
  return out;
}

/** v192/v193：把牌从弃牌池**捞回场上**（共用核心，只做数据层）——
    ① 在候选区里**等概率随机**选一个（候选为空 → 返回 -1，调用方按“留在池里”处理）；
    ② 从池中移出并清掉入池元数据；③ `side` 归属、`revealed = true` 落地即翻开、`justSpawned`
    触发 v90 的「凝聚显形」演出；④ 占格位 + 进场上放置顺序队列（`fieldTurn`＝本回合 ⇒ 其
    `fx.turnStart` 按 v160 当回合不结算）。
    ⚠️ **不负责**结算揭示与渲染/节奏——由调用方（同步版 / 分步版）各自处理。 */
function reviveCardFromPile(side, card, pile) {
  const targets = reviveTargetZones(side, card);
  if (!targets.length) return -1;
  const i = pile.indexOf(card);
  if (i < 0) return -1; // 防御：已被连锁复活走
  const dst = targets.length === 1 ? targets[0] : targets[Math.floor(Math.random() * targets.length)];
  pile.splice(i, 1); // 离池（牌本体带走自己的一切：powerLog / costMod）
  delete card.pileKind; delete card.pileTurn; delete card.pileBy; delete card.pileLoc; delete card.pilePower;
  card.side = side;        // 归属按复活方
  card.revealed = true;    // 落地即翻开
  card.justSpawned = true; // v90：落场演出（凝聚显形）
  state.players[side].zones[dst].push(card);
  enqueueField(card);
  return dst;
}

/** v192/v193：`reviveDiscard` 的两条收尾日志（法术不参与复活 / 哪些牌留在池里 / 本次汇总）。
    同步版与分步版共用，避免两份措辞不一致。 */
function reviveStuckLog(side, card, revived, stuck, spellN, poolLeft) {
  const who = side === 'p' ? '你' : '对手';
  log(side, revived.length
    ? `✦ ${card.def.n}：本次共复活 ${revived.length} 张角色卡牌（${who}的弃牌池现 ${poolLeft} 张）。`
    : `✦ ${card.def.n}：本次没有任何卡牌成功复活（三个区域都放不下或未开放）。`);
  if (spellN) log('sys', `✦ ${card.def.n}：${spellN} 张法术不参与复活，仍留在${who}的弃牌池里。`);
  if (stuck.length) log('sys', `✦ ${card.def.n}：「${stuck.join('」「')}」因三个区域都放不下或未开放，本次未能复活（留在${who}的弃牌池）。`);
}

/* v193：复活弃牌池的**分步揭示演出**（只在正常翻牌流程 revealRound 里使用）——
   逐张推进：**第 1 张复活（渲染 → 播「凝聚显形」）→ 结算它自己的揭示 → 停 0.5s →
   第 2 张 …依次类推**，全部复活完再做收尾日志。
   与同步版（applyEffect 的 case 'reviveDiscard'）口径完全一致，只多出节奏与逐步渲染；
   中途重新开局（`state.gen` 变化）会立即中断（同 applyShiftReveal / applyGatherReveal 口径）。
   ⚠️ 连锁例外：若池里还有**另一张四季映姬**（哆来咪的 `gs.shuffleN` 可能从卡池带进第二张），
   她被复活时会在结算链内部**同步**再触发一次本效果（那一批一次性复活），回到本循环后继续按
   500ms 节奏推进——已被连锁复活走的条目由 `pile.indexOf(c) < 0` 自动跳过。 */
const REVIVE_STEP_MS = 500; // v193：相邻两张之间的间隔（口径同 v171「集结」的 0.5s；纯 JS 计时、无 CSS 关键帧）
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
  const cands = all.filter((c) => c && c.def && !c.def.spell); // ① 只复活角色卡牌（非法术）
  const spellN = all.length - cands.length;
  if (!cands.length) {
    log(side, `✦ ${card.def.n}：${who}的弃牌池里只有 ${spellN} 张法术（法术不参与复活），本次无事发生。`);
    return;
  }
  const order = shuffle(cands.slice()); // ② 随机顺序（先定序，再逐张推进）
  const revived = [];
  const stuck = [];
  for (const c of order) {
    if (gen !== state.gen) return;      // 重新开局等中断
    if (pile.indexOf(c) < 0) continue;  // 防御：已被连锁复活（另一张四季映姬）先复活走了
    const dst = reviveCardFromPile(side, c, pile);
    if (dst < 0) { stuck.push(c.def.n); continue; } // ③ “若可能”不成立 → 留在弃牌池
    revived.push({ card: c, loc: dst });
    renderZones(); // ③-1 先让这张牌在场上显形（.spawned-now → 「凝聚显形」入场动画）
    log(side, `✦ ${card.def.n}：「${c.def.n}」从${who}的弃牌池复活到「${st.locs[dst].def.n}」（落地即翻开，第 ${revived.length} 张；随后结算其揭示）。`);
    // ③-2 结算**这一张**自身的「揭示」（按它当前所在区域；若它已被自己的效果挪走也照常读到新位置）
    const nowLoc = fieldLocOf(c);
    if (c.def.k && nowLoc >= 0) applyEffect(side, nowLoc, c);
    renderZones(); // 让本次揭示的 ±N / 生成 / 摧毁等演出显示出来（与 v171 集结同款逐步渲染）
    await sleep(REVIVE_STEP_MS); // ③-3 等这一张“复活并翻开、揭示结算完”之后，停 0.5s 再复活下一张
    if (gen !== state.gen) return;
  }
  reviveStuckLog(side, card, revived, stuck, spellN, pile.length); // 收尾（汇总 / 法术跳过 / 放不下）
  renderZones();
}

/* ==================== v207：揭示再触发（`retrigger` 效果键，现仅 5 费「东风谷早苗」）====================
   一句话口径：**把此牌所在区域里、自己一侧「已翻开」的卡牌的「揭示」效果各再结算一次**
   （用户口径：**无法触发回合开始/结束、持续等非揭示效果**）。
   口径（用户确认，v207）：
     ① **候选**（收口 `retriggerTargets`）＝ 结算那一刻**此牌所在区域**（`locIdx`）里**自己一侧**、
        `revealed`、带 `k` 的卡牌；**四项排除**：早苗**自己**、**法术**（自身揭示结算完已消散、
        不在场上）、**`un` 占位卡**、**同为 `retrigger` 的卡**（另一张早苗 / `morph` 复制体）——
        最后一项是**防死循环**（口径同 `morph` 的“变身目标是同样会变形的卡则不再二次变形”），
        因此即便场上有多张早苗（自建卡组同名限 1 张，但哆来咪 `gs.shuffleN` 或 `morph` 复制体
        可能带进第二张）也**不会互相触发**，链条必然收敛；
     ② **只重触发「揭示」**：逐张调用 `applyEffect`，所有揭示键（`bf`/`de`/`ba`/`bl`/`dw`/`dwb`/
        `dwh`/`dwc`/`spawn*`/`clone`/`gather`/`give`/`shuffleIn`/`discard`/`reviveDiscard`/`switch`/
        `gift`/`morph`/`xform`/`xformR`/`mv`/`roam`/`shift`/`costUp`/`energyNext`/`tkBuff`/`deAll`）照常重跑，
        含落场 token 的揭示；**不触发** `fx` 时机效果（turnStart / turnEnd / gameEnd / handEnd）、
        持续 `og`、`surv`/`phx`/`prot`/`ind`/`fly` 等非揭示机制；地形类 `gamble`（翻开时博彩）
        与 `gust`（揭示后吹飞）也**不重跑**——那两者是**地形**写的效果、不是卡面文字；
     ③ **只作用于“结算那一刻已翻开”的卡**（同 `bf`/`de`/`ba` 的全局口径）：本区同侧**还没翻开的
        暗牌不吃**——翻牌顺序在其后的牌**错过**本次、之后也不补触发；
     ④ **顺序＝本区 zone 数组顺序**（＝卡牌放入本区的先后；全场序 `fieldQueue` 不用于此）；
        每张结算**前**用 `fieldLocOf` 重读它**当前所在区域**再结算（口径同 `reviveDiscard` 的 ⑤）：
        若前一张的揭示（如八云紫 `shift` 搬卡 / `mv` / `roam`）已把它挪出本区，它**仍会被触发一次**、
        只是按挪走后的**新区域**结算；已不在场上（被摧毁 / 回手）则跳过并记一条日志；
     ⑤ **非“摧毁”/非增减/非放置**：本键自身不改战力、不动区域字段与格位、不触发 `surv`/`phx`/
        `prot`/`ind`、不进 `powerLog`/`fieldQueue`（被重触发的那些效果当然各按自己的口径改盘面）；
     ⑥ **静海（v202）**：早苗自己在本区被抹除文本时本键不发动（`revealRound` 与 `applyEffect`
        入口两道守卫）；被重触发的**每张卡各自**再过一次 `applyEffect` 入口守卫 ⇒ 静海里的卡同样不发动；
     ⑦ **节奏（用户口径）**：正常翻牌流程走**逐张分步演出** `applyRetriggerReveal`——每张结算后
        `renderZones()` 让 ±N / 生成 / 摧毁等演出显示出来，**相邻两张之间停 500ms**
        （`RETRIGGER_STEP_MS`，口径同 v171「集结」每区 0.5s / v193「复活」每张 500ms）；
        `morph` 变身 / `fx` 时机效果 / 落场生成等**非翻牌路径**走**同步版**
        （`applyEffect` 的 `case 'retrigger'`：一次性结算、无 500ms 节奏与逐步渲染）——
        两条路径共用候选收口 `retriggerTargets` 与单张收口 `retriggerOne`，口径完全一致；
     ⑧ **中断保护**：重新开局（`state.gen` 变化）时立即停止后续步骤（同 `applyShiftReveal` 口径）。
   新键的登记点（三处）：`applyEffect` 的 `case 'retrigger'`、`revealEffectWillChange` 的
   `retrigger` 分支（本区存在可再触发的卡才为 true，否则跳过结算前的 400ms 停顿）、
   `revealRound` 的分步演出分支（与 shift / gather / reviveDiscard 并列，同为**绕过 applyEffect
   入口**的键 ⇒ 静海守卫在该分支之前已拦下）。 */

/** v207：本区**可被再触发揭示**的己方卡牌（候选收口，同步版与分步版共用）——
    口径见上：本区自己一侧 + 已翻开 + 带 `k`；排除自己 / 法术 / `un` 占位卡 / 同为 `retrigger` 的卡。
    返回**快照数组**（结算过程中盘面会变，故遍历用快照；每张结算前再由 retriggerOne 重读其当前区域）。 */
function retriggerTargets(side, locIdx, card) {
  const zone = state.players[side].zones[locIdx];
  if (!zone) return [];
  return zone.filter((c) => c && c !== card && c.revealed && c.def
    && !c.def.un && !c.def.spell && !!c.def.k && c.def.k !== 'retrigger');
}

/** v207：重触发**单张**卡的揭示（**同步版**）——按它**当前所在区域**结算（`fieldLocOf` 实时读）；
    已不在场上（被摧毁 / 回手 / 换边离场）则只记一条日志并跳过，返回 false。
    ⚠️ 静海（v202）由 `applyEffect` 入口守卫处理，本函数不重复判定（避免多记日志）。
    ⚠️ **v209 起本函数只供同步路径使用**（`applyEffect` 的 `case 'retrigger'`：morph 变身 / fx 时机效果 /
    落场生成等**非翻牌路径**——那些路径无法 `await`，故按既有口径一次性同步结算）；
    **翻牌流程内的再触发**（`applyRetriggerReveal`）改用 `retriggerOneStaged`，以便保留各键的分步间隔。 */
function retriggerOne(card) {
  const j = fieldLocOf(card);
  if (j < 0) {
    log('sys', `✦ 「${card.def.n}」此刻已不在场上（被摧毁或回到了手牌），本次不再触发它的揭示。`);
    return false;
  }
  applyEffect(card.side, j, card);
  return true;
}

/** v209：重触发**单张**卡的揭示（**分步版**，供翻牌流程的 `applyRetriggerReveal` 使用）——
    与 `retriggerOne` 的唯一差别：改走共用收口 `resolveRevealInZone`，因此
      ① **被再触发的那张牌**若属于四个「分步演出」键，会照常使用它自己的异步分步版与间隔
         （八云紫 shift 逐张 0.3s / 三妖精集结逐区 0.5s / 四季映姬逐张 500ms / 另一张早苗逐张 0.5s）；
      ② **v210**：这次再触发**也发生在“早苗所在的区域”里** —— 若该区域带 `repeatReveal`（守矢神社），
         这一条揭示**也执行两次**（用户口径的 6 次链：早苗两次揭示 × 每次再触发 2 次 + A 自身翻面 2 次）。
    资格**实时读**该牌当前所在区域（再触发发生在揭示链内部，没有“翻开那一刻”可言）。 */
async function retriggerOneStaged(card) {
  const j = fieldLocOf(card);
  if (j < 0) {
    log('sys', `✦ 「${card.def.n}」此刻已不在场上（被摧毁或回到了手牌），本次不再触发它的揭示。`);
    return false;
  }
  await resolveRevealInZone(card.side, j, card); // forceRepeat 省略 ⇒ 实时读该区 repeatReveal
  return true;
}

/* ==================== v211：东风谷早苗「揭示再触发」的可见演出 ====================
   用户口径：早苗揭示时要有一个**简单快速的小动画**，让玩家看得出“她放了一次光环”；
   守矢神社里打出早苗时，她的揭示会执行两次（自身 1 次 + 地形重复 1 次），
   两次演出**同款、不加任何文字标记**（用户确认），靠“光环又亮了一次 + 目标卡又闪了一轮”
   分辨出两次揭示分别发生在什么时候。
   两类演出（每次“早苗的揭示开始结算”都各来一遍）：
     ① **早苗本体光环** `playRetriggerAura`——以卡为中心的两圈「光环扩散」：
        外层泛光向外扩 + 淡出、内层光环略微外扩（`RETRIGGER_AURA_MS` ≈ 760ms，快且不拖节奏）；
     ② **每张被再触发的目标卡**各闪一下 `playRetriggerHit`——金白提亮 + 轻微放大
        （`RETRIGGER_HIT_MS` = 420ms，比相邻两张那 500ms 的间隔短 ⇒ 不会两张糊在一起）。
   实现要点：**光环/闪光都放在 body 悬浮层**（与 v80 战力绿环 `.gain-ring`、v169 费用动效同一路数）——
   `position:fixed` + 按卡面 getBoundingClientRect 定位、z-index 9450/9440、`pointer-events:none`；
   因为卡面本体有 overflow:hidden、且翻面时的 `.played-now`（flipIn）同样动 transform/box-shadow，
   挂在卡面本体上会被裁掉/打架；卡面本体只做只动 filter 的提亮，元素与动画调用都有防御分支。
   **排队-播出**：`case 'retrigger'` 只调 `queueRetriggerFx` 入队（结算**之前**），真正播放在
   `renderZones()` 末尾的 `flushRetriggerFx()`（口径同 v80 `flushBuffFlash`）——因此**不依赖
   DOM 是否已渲染**。
   不做的事（口径同 v207/v209/v210）：不改战力/费用/格位/`fieldQueue`/`powerLog`、
   不触发 `surv`/`phx`/`prot`/`ind`、不进任何日志、不参与任何判定——**纯观感**。
   ⚠️ 卡位取元素时用 id **全局**匹配（同一张实例可能因 `morph`/`shift` 等出现在别处；按 id 找最稳）；
      自建卡组同名限 1 张，但哆来咪洗入 / `morph` 复制体可能带进第二张早苗，
      此时第二张（同 `id` 不会重复，故各自独立）只作用于它自己的结算，互不干扰。 */
// 节奏常量（时长以 JS 为准；style.css 的 .retrigger-ring / .retrigger-hit-ring 关键帧时长按同值写死，改快慢两处一起改）
const RETRIGGER_AURA_MS = 760; // 早苗本体光环时长（快、不拖翻牌节奏）
const RETRIGGER_HIT_MS = 420;  // 目标卡闪光时长（短于相邻两张那 500ms 的间隔 ⇒ 不会糊在一起）
let retriggerFxQueue = [];

/** v211：早苗**本体光环**——快、醒目、**不依赖卡面本体**的演出：
    ① 卡面本体做一次提亮脉冲（WAAPI，`filter`，短促）；
    ② **光环放在 body 悬浮层**（`position:fixed`，按卡面 rect 定位，z-index 9450）——与 v80 的
       「+N」绿环（`.gain-ring`）同一路数：**不会被卡面的 `overflow: hidden` 裁掉**，也不会被
       `.played-now` 的 `flipIn` 关键帧（同样动 `transform`/`box-shadow`）盖掉。
    两层都只是观感；取不到卡面元素（已离场 / DOM 未渲染）时返回 false。 */
function playRetriggerAura(card) {
  const els = miniCardElsById(card && card.id);
  if (!els.length) return false;
  const el = els[0];
  // ① 卡面本体：短促提亮（只动 filter，避开 transform/box-shadow 的关键帧冲突）
  if (typeof el.animate === 'function') {
    try {
      el.animate([
        { filter: 'brightness(1) saturate(1)' },
        { filter: 'brightness(1.55) saturate(1.4)', offset: .2 },
        { filter: 'brightness(1)', offset: 1 },
      ], { duration: RETRIGGER_AURA_MS, easing: 'ease-out' });
    } catch (e) { /* 动画不可用：忽略（光环仍在悬浮层播） */ }
  }
  // ② body 悬浮层：两圈光环「扩散 + 淡出」（外层宽、内层窄，视觉上像自她身上绽开）
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return true; // 不可见（如已离场）则只做卡面提亮
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

/** v211：**被再触发的每一张目标卡**各闪一下（金白闪光），`RETRIGGER_HIT_MS` = 420ms。
    与光环同款：**金环放 body 悬浮层**（不设 `.gain-ring`，避免与 v80 的绿环样式冲突），
    卡面本体再叠一次极短提亮。取不到元素（已被自己的揭示挪走 / 摧毁）即跳过，返回 false。 */
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
    } catch (e) { /* 忽略 */ }
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

/** v211：早苗揭示的**整段演出**——把“本体光环 + 候选名单里每张卡各闪一下”**排进渲染队列**。
    由 `applyEffect` 的 `case 'retrigger'`（翻牌分步版与非翻牌同步版**共用**该分支）在**结算之前**调用，
    真正的播放在下一次 `renderZones()` 末尾（`flushRetriggerFx`）——翻牌流程里每张结算后都会渲染，
    故光环与闪光立刻可见；同步版（morph / fx / 落场生成）在本批结束后那次渲染统一播出。
    ⚠️ **候选卡是“同一刻一起闪一下”**（不是在它自己被再触发的那 0.5s 时点各闪一次，用户确认的口径）——
    这样每次揭示只有“光环 + 一轮闪光”这一组视觉事件，**两轮之间更好数**（守矢神社里就是两组）。
    口径：只有**本区自己一侧**的候选会亮（＝结算范围一致，对方的卡不亮）。 */
function queueRetriggerFx(side, locIdx, card) {
  const targets = retriggerTargets(side, locIdx, card);
  retriggerFxQueue.push({ kind: 'aura', card });
  for (const c of targets) retriggerFxQueue.push({ kind: 'hit', card: c });
}

/** v211：按卡牌 id 找**所有**当前渲染出的场上缩略卡元素（同一实例只会在场上出现一次；
    返回数组以容忍“理论上多张同 id”与 DOM 尚未渲染的情形，取不到即空数组）。 */
function miniCardElsById(id) {
  if (id == null) return [];
  return Array.prototype.slice.call(
    document.querySelectorAll('.zone [data-cardid="' + id + '"]')
  );
}

/** v211：`renderZones` 末尾统一播出（口径同 v80 `flushBuffFlash`）——纯演出，取不到元素
    （卡同刻被摧毁 / 被挪走 / 在对方手牌）即静默跳过，绝不因此改动盘面。
    ⚠️ **已知未修复问题（v211，待日后排查）**：实测中本演出在用户环境里没有可见效果。
    已确认：入队与播出函数都存在且被执行路径可达（`revealRound` → `resolveRevealInZone` →
    `resolveCardReveal` → `applyRetriggerReveal` → `applyEffect` 的 `case 'retrigger'`）；
    光环/闪光元素已改为放 **body 悬浮层**（避开 `.mini-card` 的 `overflow: hidden` 与翻面 `flipIn`
    关键帧），`el.animate` 与 `getBoundingClientRect` 都有防御分支。用户环境为 `file://` 直接打开页面，
    排查期间还出现过“页面执行的是旧内容、而磁盘已是新内容”的现象（`js/game.js` 与重命名的
    `js/game-v211.js` 副本都试过）。⇒ 结论：**演出本身未生效，原因未定位**，待日后（建议先在 HTTP 服务下
    复现，排除 `file://` 的脚本缓存/截断因素）再继续。 */
function flushRetriggerFx() {
  if (!retriggerFxQueue.length) return;
  const items = retriggerFxQueue;
  retriggerFxQueue = [];
  for (const q of items) {
    if (q.kind === 'aura') playRetriggerAura(q.card);
    else playRetriggerHit(q.card);
  }
}

/* v207：揭示再触发的**分步揭示演出**（只在正常翻牌流程 revealRound 里使用）——
   逐张推进：**第 1 张的揭示再触发 → 渲染 → 停 500ms → 第 2 张 ……**，
   口径与同步版完全一致（共用 retriggerTargets），只多出节奏与逐步渲染。
   与 shift（每张 0.3s）/ gather（每区 0.5s）/ reviveDiscard（每张 500ms）同款：**纯 JS 计时、
   没有对应的 CSS 关键帧**，改节奏只改 RETRIGGER_STEP_MS 这一个数；
   重新开局（state.gen 变化）会立即中断（同 applyShiftReveal / applyGatherReveal / applyReviveDiscardReveal）。
   ⚠️ v209：每张改走 `retriggerOneStaged`（→ `resolveCardReveal`），故**被再触发的牌若是
   shift / gather / reviveDiscard，也会保留它自己的分步间隔**（此前走同步版、间隔会被吞掉）。 */
const RETRIGGER_STEP_MS = 500;
/** v207/v209/v211：早苗的「揭示再触发」**分步演出**——
    逐张推进：**第 1 张的揭示再触发 → 渲染 → 停 500ms → 第 2 张 ……**，
    口径与同步版完全一致（共用 retriggerTargets），只多出节奏与逐步渲染。
    v211：**本条演出开始前**会先把早苗本体光环 + 候选名单里每张卡的闪光排进渲染队列
    （见 `applyEffect` 的 `case 'retrigger'` → `queueRetriggerFx`，由每次 `renderZones()` 末尾播出；
    早苗被守矢神社重复时本函数会被调用两次 ⇒ 光环与闪光各来一轮，玩家据此分辨两次揭示的时点）。 */
async function applyRetriggerReveal(side, card) {
  const gen = state.gen;
  const locIdx = fieldLocOf(card);
  if (locIdx < 0) return; // 防御：理论不会发生（此刻它刚翻开、正在本区）
  const targets = retriggerTargets(side, locIdx, card);
  if (!targets.length) {
    log(side, `✦ ${card.def.n}：本区没有可再触发揭示的其他己方已翻开卡牌（不含自己、法术与同为该效果的卡），本次无事发生。`);
    return;
  }
  log(side, `✦ ${card.def.n}：${side === 'p' ? '你' : '对手'}在本区「${locDef(locIdx).n}」的 ${targets.length} 张己方卡牌，其「揭示」将各再触发一次（逐张结算，每张间隔 0.5s）—— ${targets.map((c) => `「${c.def.n}」`).join('')}`);
  for (const c of targets) {
    if (gen !== state.gen) return; // 重新开局等中断
    await retriggerOneStaged(c); // v209：分步版 → 被再触发的牌若是 shift/gather/reviveDiscard 也保留其间隔
    renderZones(); // 让本次重触发的 ±N / 生成 / 摧毁等演出显示出来（口径同 v171 集结 / v193 复活）
    await sleep(RETRIGGER_STEP_MS); // 相邻两张之间停 0.5s（纯 JS 计时，无对应 CSS 关键帧）
    if (gen !== state.gen) return;
  }
}

/* ==================== v209：翻牌流程内的「揭示分派」收口（`resolveCardReveal`）====================
   **为什么需要它**：四个效果键（`shift` / `gather` / `reviveDiscard` / `retrigger`）在**翻牌流程**里
   走的是**异步分步演出**（各自带回自己的间隔：八云紫 每张 0.3s、三妖精集结 每区 0.5s、
   四季映姬 每张 500ms、东风谷早苗 每张 0.5s），而 `applyEffect` 里的同名分支是**同步版**
   （供 morph 变身 / fx 时机效果 / 落场生成等**无法 await 的非翻牌路径**复用）。
   于是**任何“在翻牌流程里再次执行某张牌揭示”的新机制**（v207 早苗的再触发、v208 地形「守矢神社」的
   重复触发）都必须走**同一套分派**，否则会静默退化成同步版、把这些间隔全部吞掉
   （v209 修的正是这个：三妖精集结被守矢神社重复时曾一次性生成三只、并发结算其揭示）。
   调用方（全部在可 await 的翻牌流程内）：
     · `revealRound` —— 每张暗牌翻面后的**首次**揭示；
     · `resolveRevealInZone`（v208/v210）—— **在本区执行一次揭示结算**（含守矢神社的“执行两次”逻辑），
       `revealRound` 与 `retriggerOneStaged` 都通过它间接调用本函数；
     · `retriggerOneStaged`（v207/v209）—— 早苗**再触发**的每一张。
   ⚠️ 静海（v202）守卫由**调用方**负责（这三个调用方都已在进入前拦下被抹除文本的牌），
      本函数不再重复判定；`applyEffect` 内仍有入口守卫作兜底。
   ⚠️ 非翻牌路径**不要**调用本函数（它们无法 await）：请继续直接用 `applyEffect` 的同步分支。 */
async function resolveCardReveal(side, locIdx, card) {
  const k = card.def.k;
  if (k === 'shift') { await applyShiftReveal(side, card.def.t); return; } // 八云紫：逐张 0.3s
  if (k === 'gather') { await applyGatherReveal(side, card); return; } // 三妖精集结：逐区 0.5s
  if (k === 'reviveDiscard') { await applyReviveDiscardReveal(side, card); return; } // 四季映姬：逐张 500ms
  if (k === 'retrigger') { await applyRetriggerReveal(side, card); return; } // 东风谷早苗：逐张 0.5s
  applyEffect(side, locIdx, card); // 其余键：同步结算（与既有口径一致）
}

/* v172/v179：`spawnS`（本区**自己一侧**生成特殊卡）的共用实现——
   `spawnS` 键本身（v172 祖母绿巨石 / v179 镇守大地之石）与 `tkBuff` 键的**可选落场生成子句**
   （v179 地精的起床：先在本区生成 1 张石块，再统一给己方石块 +N）共用同一套口径，
   避免两条路径各写一份。
   - 缺省：生成 `spawnS.n` 张；
   - `fill: true`（v179）：**不写死张数**，按结算那刻自己一侧的空余格数（sideRoom，occ 口径）
     铺满，且**施法的那张法术先消散**（把它占的 1 格也让给生成的卡），最终该侧正好铺满。
     提前消散之后，revealRound / settleFieldSpell 里那一句 `vanishSpell(card)` 会因
     “卡已不在场上”自行跳过，不会二次记日志或二次播动画。
   返回 { cnt, placed, name, fill }；条目缺失/键名写错时返回 null（调用方不记日志）。 */
function spawnSOwnSide(side, locIdx, card, fx) {
  const spcS = fx && fx.spawnS;
  const tkS = spcS && TOKENS[spcS.card];
  if (!spcS || !tkS) return null;
  let cntS = spcS.n || 1;
  if (spcS.fill) {
    if (isSpell(card) && fieldLocOf(card) === locIdx) vanishSpell(card); // v179：先让出自身那 1 格
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
  // 效果规格：揭示（默认，spec 缺省）= 整张卡的 def；时机效果（v55）= def.fx[timing] 条目。
  // 条目字段与 def 同构（k/a/spawn/xf/give/t），结算逻辑完全复用。
  const fx = spec || def;
  // 日志文案：条目自带 t > 卡面效果文案(def.t) > 卡名
  const txt = fx.t || (fx === def ? def.t : def.n);
  // v202：静海「抹除文本」——文本已被抹除的卡，其效果一律不发动。
  // 本守卫放在**结算入口**，因此覆盖所有路径：翻牌揭示（含 morph 重新触发）、
  // fx 时机效果（resolveTimedEffects 亦有一道带时机名的守卫）、落场法术 settleFieldSpell、
  // 集结/复活等连锁结算；法术的“消散”不受影响（那是法术规则，不在这里做）。
  if (cardMuted(card)) {
    muteSkipLog(card, spec ? '时机效果' : '揭示效果');
    return;
  }

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
      // v201：目标若在「免减攻」区域（蓬莱药局）则该次 −N 被拦下，不计入“影响 N 张”
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
      // v180（蓬莱的玉枝·法术）：**敌方全场削弱**——把**敌方三个区域**（左→中→右依次遍历）
      // 里**所有已翻开**的卡牌各**永久 −N**（`a`，现 N=1）。
      // 口径同 `de`，只有**范围**不同（`de` 打本区、`deAll` 打三个区域）：
      //   ①只作用于结算那一刻**已翻开**的卡——对方暗牌不吃（后翻开的牌错过本次）；
      //   ②排除 `un` 占位卡（隙间）与法术（法术无战力、且马上自行消散）；
      //   ③**含落场 token**（石块 / 厄运 / 分身 / 水银 / 龙玉等），一律照吃；
      //   ④**一次性结算、逐张 −N，不是“把 −6 随机分配给某几张”**——本卡的 −1 是每张都吃；
      //   ⑤走 applyPermBuff 收口：−N 演出 + 战力影响历史按来源记本卡；非“摧毁”，
      //     带 `surv`/`phx`/`prot`/`ind` 的卡照常被削（`ind` 只挡摧毁、不挡增减）。
      let nAll = 0;
      let blockedAll = 0; // v201：因「免减攻」被拦下的张数（逐区判，见 applyPermBuff 的收口）
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
      // v180：ind 卡（佛体金刚石）**照常参与判定**——判定落在它身上＝摧毁失败、判定结束，
      //   不会改打下一张最弱的（见 indestructibleBlock）
      const vis = theirs.filter((c) => c.revealed && !c.def.un && !c.def.spell);
      if (vis.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但对方在此区没有可摧毁的已翻开卡牌（暗牌与法术不算）。`); break; }
      let minP = Infinity, target = null;
      for (const c of vis) {
        const p = cardPowerIn(locIdx, c);
        if (p < minP) { minP = p; target = c; }
      }
      if (indestructibleBlock(target, def.n)) break; // v180：ind → 摧毁失败、判定结束（不改打其他牌）
      if (phoenixRevive(target, locIdx)) break; // 凤凰重生（如藤原妹红）：回手 +N 战力
      if (surviveDestroy(target)) break; // 防摧毁（如灵乌路空）：替代为降战力、卡不离场
      recordDestroy(target, locIdx, def.n); // v187：真正离场 → 牌本体进归属方的摧毁池（须在移出区域之前记）
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
      // v180：ind 卡（佛体金刚石）照常参与“双方最弱”的判定与随机抽取——抽中它＝摧毁失败、
      //   判定结束（不会再去打并列的第二张）；抽中其他并列牌则照常摧毁
      const both = mine.concat(theirs).filter((c) => c.revealed && !c.def.un && !c.def.spell);
      if (both.length === 0) { log(side, `✦ ${def.n} 想摧毁卡牌，但本区域没有可摧毁的已翻开卡牌（暗牌与法术不算）。`); break; }
      if (locNoDestroy(locIdx)) { log(side, `✦ ${def.n} 想摧毁卡牌，但本区域存在免摧毁效果（地形「睡鼠神祠」或「蕾蒂」等），所有卡牌都无法被摧毁。`); break; }
      let minBoth = Infinity;
      for (const c of both) minBoth = Math.min(minBoth, cardPowerIn(locIdx, c));
      const lowPool = both.filter((c) => cardPowerIn(locIdx, c) === minBoth);
      const lowTarget = lowPool[Math.floor(Math.random() * lowPool.length)]; // 并列最低：随机挑一张
      const lowSide = lowTarget.side;
      const lowZone = st.players[lowSide].zones[locIdx];
      if (indestructibleBlock(lowTarget, def.n)) break; // v180：ind → 摧毁失败、判定结束（不改打其他牌）
      if (phoenixRevive(lowTarget, locIdx)) break; // 凤凰重生（如藤原妹红）：回手 +N 战力
      if (surviveDestroy(lowTarget)) break; // 防摧毁（如灵乌路空）：替代为降战力、卡不离场
      recordDestroy(lowTarget, locIdx, def.n); // v187：真正离场 → 牌本体进归属方的摧毁池（须在移出区域之前记）
      playShatter(lowTarget); // 分崩离析演出（v88）
      lowZone.splice(lowZone.indexOf(lowTarget), 1);
      dequeueField(lowTarget); // 被摧毁：移出放置队列（后续时机不再结算它）
      log('danger', `✦ ${def.n} 摧毁了${lowSide === side ? '己方' : '对方'}「${lowTarget.def.n}」（威力 ${minBoth}${lowPool.length > 1 ? `；并列最低共 ${lowPool.length} 张，随机选中这一张` : ''}）`);
      break;
    }
    case 'dwc': {
      // v195（妖精大战争·法术）：揭示——摧毁**双方场上**（**三个区域**、敌我两侧）所有
      // **印刷费用 `def.c` 恰为 `dwc.cost`**（缺省 1，即“一费牌”）的**已翻开**卡牌。
      // 口径（**用户确认**）：
      //   ① 目标＝**已翻开**（`revealed`）＋ 非 `un` 占位卡（隙间）＋ **非法术**；
      //      **暗牌不可被提前摧毁** —— 与 dw/dwh/dwb/地形 purge 的候选口径完全一致；
      //   ② **含落场 token**（用户口径）：石块 / v184 冰块 / 祖母绿巨石占位 / 水银 的印刷费用
      //      都是 1，照常被扫掉（口径同 dw/dwh/dwb/purge「含落场 token」）；
      //   ③ 筛选按**印刷费用 `def.c`**（不是 `cardCost`）—— 与 `discard.cost` / `og.cost` /
      //      区域 `cb` / 图鉴与卡组页分档同口径：被桑尼米尔克加过费**不改变“是不是 1 费牌”**；
      //   ④ **逐区结算（左 → 中 → 右）**，每区先己方后对方；某区存在**免摧毁**（地形 `prot`
      //      「睡鼠神祠」/ 卡级 `prot`「蕾蒂」，`locNoDestroy`）时**该区整区跳过**（不选目标、
      //      也不触发 surv/phx）—— 与其它摧毁点的“整条拦下”口径一致（保护按区生效）；
      //   ⑤ 每张依次走 **ind（自身不可摧毁）→ phx（凤凰重生回手 +N）→ surv（防摧毁改降 N）→
      //      `recordDestroy`（真正离场 → 进**其归属方**的摧毁池）→ 分崩离析演出 → 出区 → 出放置队列**；
      //      ⚠️ `ind` 与 purge 同款：**逐张 continue**（它自己打不死，同区其它 1 费牌照常被摧毁），
      //      不像 dw/dwh/dwb 那样“判定结束、不改打别的”；
      //   ⑥ **没有“并列随机”**：命中的牌**全部摧毁**（不像 dwh/dwb 只挑一张）；
      //   ⑦ **可能摧毁己方自己的卡**（卡面写的就是“双方”）；
      //   ⑧ 非增减/非放置：不进 powerLog、不动区域字段；格位由出区自然腾出；
      //      法术自身结算完仍按 v170 口径自行消散（进放逐池）。
      const wantCost = (fx.dwc && fx.dwc.cost != null) ? fx.dwc.cost : 1;
      let goneAll = 0;
      const zoneSkipped = [];
      for (let j = 0; j < 3; j++) {
        const zP = st.players.p.zones[j];
        const zA = st.players.a.zones[j];
        // 快照：结算途中会 splice（本函数不新增卡，但 phx 会把它移去手牌）
        const hitZ = zP.concat(zA).filter((c) => c.revealed && !c.def.un && !c.def.spell && c.def.c === wantCost);
        if (!hitZ.length) continue;
        if (locNoDestroy(j)) { zoneSkipped.push(locDef(j).n); continue; } // ④ 该区免摧毁 → 整区跳过
        const goneZ = [];
        for (const c of hitZ) {
          if (indestructibleBlock(c, def.n)) continue; // ind：这一张打不死，同区其它牌照常摧毁
          if (phoenixRevive(c, j)) continue; // 凤凰重生：回手 +N
          if (surviveDestroy(c)) continue; // 防摧毁：改永久 −N、卡不离场
          const owner = c.side; // 归属方（换边后按新归属）——进池与日志都用它
          recordDestroy(c, j, def.n); // v187：真正离场 → 牌本体进归属方的摧毁池（须在移出区域之前记）
          playShatter(c); // 分崩离析演出（v88）
          const inP = zP.indexOf(c) >= 0;
          if (inP) zP.splice(zP.indexOf(c), 1);
          else zA.splice(zA.indexOf(c), 1);
          dequeueField(c); // 被摧毁：移出放置队列（后续时机不再结算它）
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
      // v179（镇守大地之石）：新增 `fill: true` 写法（填满该侧、法术先消散再铺满）——
      // 实现统一收口在 spawnSOwnSide()，`tkBuff` 键的可选生成子句也复用它。
      const r = spawnSOwnSide(side, locIdx, card, fx);
      if (r) {
        log(side, r.placed
          ? `✦ ${def.n}：在本区域自己一侧添加 ${r.placed} 张「${r.name}」${r.fill ? '，把这一侧的格位填满' : ''}`
          : `✦ ${def.n} 想把「${r.name}」放到自己一侧，但该侧已放满，未能落下。`);
      }
      break;
    }
    case 'spawnMine': {
      // v180（耀眼之龙玉·法术）：给**己方每个区域**（**含此牌所在区域**）自己一侧各生成
      // `spawnMine.n` 张特殊卡（现「龙玉」，3 费 / 3 战力白板）。与既有生成键的配位：
      //   `spawn` 本区双方各 n 张 / `spawnO` 只投本区对方一侧 / `spawnS` 只投本区自己一侧 /
      //   `clone` 只投**另外两个**区域自己一侧 → 本键**三个区域都投**（含本区）。
      // 口径：
      //   ①**逐区独立判定**：该侧已放满（`sideRoom < 1`，含被大体积卡占满；⚠️ 法术在揭示
      //     瞬间**仍占本区 1 格**（v170），因此若本区己方侧因这张法术而正好满 → 本区跳过）
      //     或区域未开放（`locOpen`，如七夕坂第 5 回合前）→ **跳过该区、不补到别区**；
      //   ②落场统一走 placeToken：落地即翻开、占格位、进放置队列、播“凝聚显形”，
      //     **不结算生成卡自身的揭示**（同 clone/spawnS 口径；现生成的龙玉是白板，无差别）；
      //   ③本键只产出“自己一侧”的卡，对方一侧完全不受影响；
      //   ④非“摧毁”类：与 surv/phx/prot/ind、区域字段都无交互；生成的卡之后照常可被
      //     增益/削弱/摧毁/移动；
      //   ⑤日志逐区点名（落场张数 + 被跳过的区域及原因）。
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
      // v179（地精的起床·法术）——**标记卡增幅**：己方（`own: true`）或**全场双方**带指定
      // `tk` 标记的**已翻开**卡牌**永久 +N**（走 applyPermBuff 收口：±N 演出 + 战力影响历史
      // 按来源记这张法术）；并**可选**先按 `spawnS` 口径在本区自己一侧落场生成
      // （本卡即「先在本区生成 1 张石块，再给己方石块 +1」——因为生成在前，**刚生成的这张
      // 也吃到本次 +1**，与卡面文案的先后顺序一致）。
      // 口径：①只作用于结算那一刻**已翻开**的卡（同 bf/de/ba；石块是落场即翻开，故照常命中，
      //      暗牌不会预领）；②排除 `un` 占位卡与法术（法术无战力）；③**一次性永久**，
      //      不是持续光环——与天子 `og: { tk:'rock', add:2 }`（在场期间实时 +2、离场失效）
      //      是两种不同机制，本键加完即留在永久 buff 台账里。
      const gen = spawnSOwnSide(side, locIdx, card, fx); // ① 可选子句：本区自己一侧生成
      if (gen) {
        log(side, gen.placed
          ? `✦ ${def.n}：在本区域自己一侧添加 ${gen.placed} 张「${gen.name}」`
          : `✦ ${def.n} 想把「${gen.name}」放到自己一侧，但该侧已放满，未能落下。`);
      }
      const tb = fx.tkBuff; // ② 标记卡增幅
      if (!tb || !tb.tk) break;
      const add = tb.a || 0;
      // tk 标记没有中文名表：直接由 TOKENS 里带该标记的卡名反推一个可读标签（现 'rock' → 石块）
      // v196：该反推抽成共用函数 tokenNameLabel()，与 `playReq` 的提示/标签共用同一口径
      const tkLabel = tokenNameLabel(tb.tk);
      const sides = tb.own ? [side] : ['p', 'a'];
      const hit = [];
      for (const s2 of sides) {
        for (let j = 0; j < 3; j++) {
          // 快照遍历：applyPermBuff 只改 buff 不增删卡，slice 仅作防御
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
        // v200：可用格数＝地形 max − 该侧已封隙间数（封格后大体积卡同样放不进）
        const legal = locSideMax(side, locIdx) === occOf(pick)
          && ownZone.length === 1 && ownZone[0] === card;
        if (!legal) {
          log('danger', `✦ ${def.n} 想变身成「${pick.def.n}」（占 ${occOf(pick)} 格），但本区域不满足条件（需该侧可用格数 = ${occOf(pick)} 且己方该区只有 ${def.n} 这一张卡），变身失败、保持原样。`);
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
      // v205：已破碎的区域永久锁定 —— 不能被任何路径再换地形
      if (locShattered(locIdx)) {
        log('danger', `✦ ${def.n} 想把本区变成「${target.n}」，但本区域已被摧毁（已破碎）、不能再改变地形，变形失败。`);
        break;
      }
      const over = ['p', 'a'].some((s2) => sideUsed(s2, locIdx) > target.max);
      if (over) { log('danger', `✦ ${def.n} 想把本区变成「${target.n}」，但双方牌数超出其上限，变形失败。`); break; }
      const prevLoc = state.locs[locIdx].def;
      state.locs[locIdx].def = target;
      resetLocGaps(locIdx); // v200：换地形 → 清空本列已封的隙间
      refreshLocHeader(locIdx); // 更新列名/图标/效果文字/配色（隙间随 max=4 自动消失）
      log('danger', `✦ ${def.n} 将本区域变成了「${target.n}」！`);
      // v151：区域变形等同于“该地形在本区出现”——立刻结算目标地形的「出现时」效果
      // （如变形成虹龙洞 → 双方各生成 1 张「石块」，与地形揭晓同一函数）。
      // 本区原本就已经是目标地形时不重复结算（同一地形不会二次“出现”）。
      if (prevLoc !== target) runLocAppearEffect(locIdx, target);
      // v203：把本区变成「虚假之月」→ 本局总回合数变 7；把虚假之月变成别的地形 → 退回 6
      //（进入第 7 回合后由 roundsTotal() 锁定，故第 7 回合中途变掉不影响本局继续）
      syncRoundTotal('卡牌区域变形');
      break;
    }
    case 'xformR': {
      // v213：区域「随机变形」（1 费「梅莉」）——把本区域地形换成地形池里**随机另一个**地形，
      // 并**立刻结算目标地形的「出现时」效果**。**完整沿用 v199 `xformTurn` 的随机变形口径**
      // （见本文件 v213 段注释）：候选＝`randomLocCandidates`（POOL 除自身、允许与另两列重复、
      // EXTRA 不入候选）；**不做上限防御**（超限照常变形 —— 与上面 `case 'xform'` 的“超限则失败”
      // 刻意相反）；换地形 → `resetLocGaps` → `refreshLocHeader` → `runLocAppearEffect` → `syncRoundTotal`。
      // 目标若抽到「虚假之月」→ 本局总回合数当场变 7；抽到「天界」→ 启动摧毁链（`revealRound`
      // 在每张牌结算后会 `await awaitShatterChain()` 补等）；已破碎的列一律跳过。
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
      resetLocGaps(locIdx);     // v200：换地形 → 清空本列已封的隙间
      refreshLocHeader(locIdx); // 列名/图标/效果文案/配色即时更新
      log('danger', `✦ ${def.n} 掷出了随机地形 —— 「${prevR ? prevR.n : '原地形'}」变成了「${targetR.icon} ${targetR.n}」！`);
      // v151 口径：变形 = 该地形在本区“出现”——立刻结算其「出现时」效果（v205：天界在此启动摧毁链）
      runLocAppearEffect(locIdx, targetR);
      syncRoundTotal('卡牌区域随机变形'); // v203：可能变出「虚假之月」→ 本局总回合数当场变 7
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
      // 揭示：把 def.give 指定的特殊卡加入**自己手牌**（手牌衍生物）。
      // v177：现由「雾雨魔理沙」使用（4 费 / 6 战力 → 加入**法术**「极限火花」；此前的
      // 「八云紫 → 废弃列车」自 v76 起已无生成来源，本键长期处于预留状态）。
      // 口径：每次生成**新卡实例**（newCard）并打 justHandAdded 标记（渲染后播“滑入”演出
      // `.hand-new`）；**手牌满 7 张则加入失败**（同 phoenixRevive 回手 / drawSpell 的既有口径）；
      // 归属按牌的所属方；加入手牌的衍生物仍需**手动暗出**——若它是法术（spell: true），
      // 就走「暗出 → 翻牌揭示 → 自行消散」的正常法术流程（暗牌与揭示瞬间各占 1 格）。
      // v180：加入后调用 flushHandAdd(side) **立刻渲染手牌**，否则本次的“滑入”演出看不到
      // （原因见该函数注释：阶段 ④ 结算完要到回合末才 renderAll，而那一刻紧接着的下一回合
      //  roundStartStage 会在同一个同步任务里再 renderAll 一次，把动画元素直接重建掉）。
      const gv = fx.give;
      const hand = st.players[side].hand;
      // ---- v180：`pool` 写法（不放回随机抽 n 张，互不相同）——现由「蓬莱山辉夜」使用：
      // 从 5 张神宝（无限生命泉 / 火蜥蜴之盾 / 佛体金刚石 / 耀眼之龙玉 / 蓬莱的玉枝）
      // 里随机抽 2 张加入自己手牌。除“来源是池、彼此不重复”外，其余口径与单卡写法完全一致：
      // 每次生成新卡实例、打 justHandAdded（播“滑入”演出）、手牌满 7 张则加入失败/只加入放得下的；
      // 池内条目缺失（键名写错）会被静默忽略，池空则只记一条日志、什么都不发生。
      if (gv && Array.isArray(gv.pool)) {
        const want = gv.n || 1;
        const cands = gv.pool.map((k) => TOKENS[k]).filter((d) => !!d);
        if (!cands.length) {
          log('sys', `✦ ${def.n}：神宝池里没有可加入的卡（数据缺失），本次无事发生。`);
          break;
        }
        // 不放回随机：洗牌后取前 min(want, 池大小) 张 → 互不相同
        const picked = shuffle(cands.slice()).slice(0, Math.min(want, cands.length));
        const names = [];
        let added = 0;
        for (const pd of picked) {
          if (hand.length >= 7) break;
          const c2 = newCard(pd);
          c2.side = side;
          c2.justHandAdded = true; // v90：加入手牌演出
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
        if (added > 0) flushHandAdd(side); // v180：立刻渲染手牌 → 播“滑入”演出（.hand-new）
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
          c2.justHandAdded = true; // v90：加入手牌演出
          hand.push(c2);
          added++;
        }
        // v177：把「完全失败 / 部分加入 / 全部加入」三种情况分开写日志
        // （此前只说“部分未能加入”，而 Marisa 是本键的首个实际使用者，满手时那句会误导）
        if (added === cnt) log(side, `✦ ${txt}`);
        else if (added > 0) log(side, `✦ ${txt}（手牌已满，仅加入了 ${added}/${cnt} 张）`);
        else log(side, `✦ ${def.n} 想把「${tk.n}」加入手牌，但手牌已满（7/7），本次未能加入。`);
        if (added > 0) flushHandAdd(side); // v180：立刻渲染手牌 → 播“滑入”演出（.hand-new）
      }
      break;
    }
    case 'shuffleIn': {
      // v184（洗入卡组）：把 `shuffleIn.card` 指定的牌 n 张**洗入某一方的牌库**，
      //  并把该方**整副牌库重新洗一次**（口径与实现见本文件上方的 shuffleCardsIntoDeck 段、
      //  以及 docs/现有机制.md §1「洗入卡组（shuffleIn）」段）。要点：
      //   ① 进的是**牌库**（隐藏区），既不是手牌（`give`）也不是场上（`spawn*`）：不翻开、
      //      不占格位、不进放置队列、**不结算被洗入卡自身的任何效果**（日后抽到再打出时才结算）；
      //   ② 张数**无上限**（牌库没有 7 张上限，「手牌满则失败」不适用）；开发调试空牌库也能洗入；
      //   ③ 洗牌范围＝该方**整副牌库**（含原本未抽到的牌），就地重洗 → 下一张抽什么立刻变化；
      //   ④ 目标方由 `to` 决定：`'opp'`（也接受 `'a'`）= 洗入**对方**牌库；缺省/其它值 = 洗入
      //      **自己**牌库（归属按牌的所属方 `side`，对双方一视同仁）；
      //   ⑤ 公开：日志点名（含洗后牌库张数）+ 轻量演出（牌库计数闪光 + 「洗入卡组」气泡）；
      //   ⑥ 非摧毁/非增减/非放置：与 surv/phx/prot/ind、区域字段、格位、战力影响历史均无交互。
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
      // 先刷新牌库计数，再播演出 → 玩家看到的是“洗入后”的张数
      if (tgtSide === 'p') updateDeckCount(); else renderSide();
      log(toOpp ? 'danger' : side,
        `🃏 ${def.n}：把 ${got} 张「${inDef.n}」洗入了${tgtWho}的牌库，并重新洗了一次牌（现牌库 ${state.players[tgtSide].deck.length} 张）。`);
      playShuffleInFx(tgtSide, got, inDef.n, def.n);
      break;
    }
    case 'discard': {
      // v189（弃牌）：把牌从**手牌**移出 → 放进**该牌归属方**的「弃牌池」，并播双方可见的
      // 「弹出完整卡面 + 从右上到左下斜切两半」演出（约 1.6s）。
      // ⚠️ 与「摧毁」的分工是**区域不同、互不重叠**（用户口径）：摧毁只作用于**场上**的牌、
      //   弃牌只作用于**手牌**；因此弃牌**不是**“摧毁”——不触发 `surv`/`phx`/`prot`/`ind`
      //   等任何摧毁类机制，不动区域字段 / 格位 / 放满加成 / `fieldQueue` / 战力台账。
      // 数据写法与逐条口径见本文件上方的 v189「弃牌」段（`discardFromHand` / `discardCandidates`）：
      //   `discard: { n, to, pick, card, cost }` —— `to` 缺省 `'own'`＝弃**自己**手牌、
      //   `'opp'`（也接受 `'a'`/`'enemy'`）＝弃**对方**手牌；`card` 按卡名（或 SPECIAL 键名）筛选、
      //   `cost` 按**印刷费用**筛选（数字＝恰好，或 `{min,max}` 区间）；两者都不写＝整副手牌都是候选；
      //   `pick`（**v190**）缺省 `'random'`＝候选里随机取，`'right'`/`'left'`＝从手牌**最右侧/最左侧**起取；
      //   `n` 缺省 1，写 `'all'` 则命中即全弃；候选不足时弃掉手上有的那些。
      //   **`give`（v198 可选子句）**＝弃牌成功后按**被弃牌的印刷费用**给**施放方自己**加手牌衍生物
      //   （`powerFromCost: true`），现由「姬虫百百世」使用；口径见上方 `discardGiveTokens` 段。
      // 目标公开：被弃的牌此后躺在该方「弃牌池」（侧栏徽标 + 弹窗页签）里，对玩家是明牌。
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
      // v198：可选子句 `discard.give` —— 弃牌**真的发生之后**，按**被弃掉的那张牌的印刷费用**为
      //   **施放方自己**加入手牌衍生物（现由「姬虫百百世」使用 → 1 张战力＝该卡费用的「石块」）。
      //   口径与逐条说明见上方 `discardGiveTokens` 段：弃牌落空时上面已 return（本条不结算）、
      //   加入目标恒为自己（与 `to` 无关）、手牌上限 7 张照常约束、加入后仍需手动暗出。
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
      // v192（四季映姬）：**复活弃牌池** —— 把**自己一方**的**弃牌池**（v187 的 `discardPile`，
      // 唯一入池来源是弃牌机制 `discard`）里**所有「角色卡牌」（非法术）**以**随机顺序**复活到场上。
      // ⚠️ **v193：正常翻牌流程走的是异步分步版 `applyReviveDiscardReveal`**（逐张复活：
      //    捞出一张 → 渲染「凝聚显形」→ 结算它的揭示 → **停 500ms** → 下一张）；
      //    本同步版供 morph 变身 / fx 时机效果 / 落场生成等非翻牌路径复用（一次性结算、无节奏），
      //    两条路径共用 `reviveTargetZones` / `reviveCardFromPile` / `reviveStuckLog` 三个收口，
      //    口径完全一致。
      // 用户口径（v192）：
      //   ① **只复活角色卡牌**：`def.spell === true` 的**法术不参与复活**，留在弃牌池（日志点名）；
      //   ② **随机顺序**：对候选快照做一次 `shuffle` 后逐张依次复活；
      //   ③ **随机区域**：每张牌**只在「已开放（`locOpen`，避开七夕坂等 minTurn 锁定）且己方该侧
      //      放得下（`sideRoom` ≥ 占格数 `occOf`，含大体积卡）」的区域里等概率随机**选一个 —— 因此
      //      **不会出现“掷到一个满区就复活失败”**（用户明确口径）；三区都放不下/未开放 → 该牌
      //      **留在弃牌池**（“若可能”），日志点名；
      //   ④ **落地即翻开**：`revealed = true`、占格位、进场上放置顺序队列（`enqueueField` 会记
      //      `fieldTurn`＝本回合，故其 `fx.turnStart` 按 v160 口径**当回合不结算**、下回合起才结算），
      //      并播「凝聚显形」演出（`justSpawned`，口径同 placeToken / 分身）；
      //   ⑤ **逐张重新结算其自身「揭示」**（用户口径）：每张复活后立刻按它**当前所在区域**调用
      //      `applyEffect`（白板跳过；同步结算，无 400ms 停顿与翻牌演出）——口径同 v166 的
      //      `spawn.reveal` / v171「集结」，所以复活辉夜会再抽 2 张神宝、复活魔理沙会再给 1 张极限火花；
      //      连锁复活（弃牌池里还躺着另一张四季映姬）走同一条路径，且每张复活后即从池中移出 ⇒ 必然收敛
      //      （循环里用 `pile.indexOf(c) < 0` 防御“已被连锁复活走”的条目）；
      //   ⑥ **同一卡实例、保留一切**：牌本体从池中移出后直接落到场上，永久增益台账 `powerLog` 与本场
      //      战斗的费用修正 `costMod` 都随实例保留（与 v187「入池的是牌本体」一致）；离池时清掉入池
      //      元数据（`pileKind`/`pileTurn`/`pileBy`/`pileLoc`/`pilePower`）；
      //   ⑦ **不是“打出”、也不是“暗出”**：不消耗能量、**不写 `playerMoves`/`aiMoves`** —— 因此
      //      不会被阶段 ④ 的翻牌流程二次结算，也不会被「重置暗牌」收回（重置只处理本回合暗出的牌）；
      //   ⑧ **不是“摧毁”、非增减**：与 `surv`/`phx`/`prot`/`ind`、摧毁池、战力台账均无交互；区域
      //      「翻开时」博彩 `gamble` 与「揭示后吹飞」`gust` 都只作用于“本回合在 revealRound 里翻开的
      //      牌”，复活卡落地即已翻开 ⇒ **不参与**（口径自然一致）；
      //   ⑨ 归属按**牌的所属方**（`side`）：玩家打出复活自己的弃牌池，AI 打出复活 AI 自己的。
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
        if (pile.indexOf(c) < 0) continue; // 防御：已被本次连锁复活（另一张四季映姬）先复活走了
        const dst = reviveCardFromPile(side, c, pile); // ③ 候选区里随机 + 离池 + 落地即翻开（共用核心）
        if (dst < 0) { stuck.push(c.def.n); continue; }   // “若可能”不成立 → 留在弃牌池
        revived.push({ card: c, loc: dst });
        log(side, `✦ ${def.n}：「${c.def.n}」从${who}的弃牌池复活到「${st.locs[dst].def.n}」（落地即翻开，并重新结算其揭示）。`);
        const nowLoc = fieldLocOf(c);
        if (c.def.k && nowLoc >= 0) applyEffect(side, nowLoc, c); // ⑤ 逐张重新结算其自身「揭示」
      }
      renderZones(); // 让复活的卡在场上显形（「凝聚显形」演出；末尾会顺带刷新侧栏牌池计数）
      reviveStuckLog(side, card, revived, stuck, spellN, pile.length); // 收尾（汇总 / 法术跳过 / 放不下）
      break;
    }
    case 'dwh': {
      // 揭示：摧毁本区对方一张“已翻开且战力最高”的卡。
      // 现使用者：token「废弃列车」与 v177 新增的法术「极限火花」（雾雨魔理沙 give 加入手牌）。
      // 与 dw 的差别只在“选最弱 / 选最强”；目标池与免疫口径完全一致（排除暗牌、un 与法术）。
      // v177 口径统一：**并列最高时在其中随机挑一张**（原先取第一张最高者）——与 dwb
      // 「并列最低里随机挑一张」对称，同为“只摧毁一张、并列也随机”的口径。
      if (theirs.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但该区空无一人。`); break; }
      if (locNoDestroy(locIdx)) { log(side, `✦ ${def.n} 想摧毁卡牌，但本区域存在免摧毁效果（地形「睡鼠神祠」或「蕾蒂」等），所有卡牌都无法被摧毁。`); break; }
      const vis = theirs.filter((c) => c.revealed && !c.def.un && !c.def.spell); // v170：法术不选为目标
      // v180：ind 卡照常参与“最强”判定与并列随机抽取——抽中它＝摧毁失败、判定结束
      if (vis.length === 0) { log(side, `✦ ${def.n} 想摧毁对方卡牌，但对方在此区没有可摧毁的已翻开卡牌（暗牌与法术不算）。`); break; }
      let maxP = -Infinity;
      for (const c of vis) maxP = Math.max(maxP, cardPowerIn(locIdx, c));
      const maxPool = vis.filter((c) => cardPowerIn(locIdx, c) === maxP); // 并列最高：全部进候选池
      const target = maxPool[Math.floor(Math.random() * maxPool.length)]; // 并列：随机挑一张
      if (indestructibleBlock(target, def.n)) break; // v180：ind → 摧毁失败、判定结束（不改打其他牌）
      if (phoenixRevive(target, locIdx)) break; // 凤凰重生（如藤原妹红）：回手 +N 战力
      if (surviveDestroy(target)) break; // 防摧毁（如灵乌路空）：替代为降战力、卡不离场
      recordDestroy(target, locIdx, def.n); // v187：真正离场 → 牌本体进归属方的摧毁池（须在移出区域之前记）
      playShatter(target); // 分崩离析演出（v88）
      theirs.splice(theirs.indexOf(target), 1);
      dequeueField(target); // 被摧毁：移出放置队列（后续时机不再结算它）
      log('danger', `✦ ${def.n} 摧毁了对方「${target.def.n}」（威力 ${maxP}${maxPool.length > 1 ? `；并列最高共 ${maxPool.length} 张，随机选中这一张` : ''}）`);
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
      //   ④ 终局边界：**本局最后一回合**翻开时已没有“下一回合”，该额外能量**不会被用到**
      //      （v203：本条件改读 `roundsTotal()` —— 无虚假之月时最后一回合＝第 6 回合；有则为第 7 回合，
      //       因此在有虚假之月的局里，第 6 回合翻开的这份**会在第 7 回合正常到账**）
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
      if (st.turn >= roundsTotal()) {
        log('sys', `⚠️ 这是最后一回合（第 ${roundsTotal()} 回合），下一回合不存在，这份额外能量本局不会生效。`);
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
    case 'retrigger': {
      // v207（东风谷早苗）：**再触发本区己方卡牌的揭示** —— 同步版（供 morph 变身 / fx 时机效果 /
      // 落场生成等**非翻牌路径**复用；正常翻牌流程走**分步演出** applyRetriggerReveal）。
      // 完整口径见本文件上方 v207 段与 `docs/现有机制.md` §1「揭示再触发（`retrigger`）」段。
      // 要点：候选排除 自己 / 法术 / un 占位卡 / 同为 retrigger 的卡（防死循环）；只重跑「揭示」，
      // 不跑 fx 时机效果与 og/surv/phx/prot/ind 等非揭示机制，也不重跑地形类 gamble/gust。
      // v211：结算**之前**先把演出排进渲染队列（早苗本体光环 + 候选名单里每张卡各闪一下）——
      // 翻牌流程里逐张结算都会 renderZones()，故光环与闪光立刻可见；非翻牌同步版
      // （morph/fx/落场生成）一次性结算、本批结束后才渲染 ⇒ 演出在那次渲染时统一播出。
      // ⚠️ 该演出目前**未生效**（原因未定位，见 flushRetriggerFx 上方的说明），代码保留待日后排查。
      queueRetriggerFx(side, locIdx, card);
      const targets = retriggerTargets(side, locIdx, card);
      if (!targets.length) {
        log(side, `✦ ${txt}：本区没有可再触发揭示的其他己方已翻开卡牌（不含自己、法术与同为该效果的卡），本次无事发生。`);
        break;
      }
      log(side, `✦ ${txt}：${side === 'p' ? '你' : '对手'}在本区「${locDef(locIdx).n}」的 ${targets.length} 张己方卡牌，其「揭示」各再触发一次 —— ${targets.map((c) => `「${c.def.n}」`).join('')}`);
      for (const c of targets) retriggerOne(c); // 同步版：逐张按“当前所在区域”重跑其揭示（无节奏）
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
    if (state.locs[j].shattered) continue; // v205：已破碎的区域不显示点数比大小 → 跳过放大高亮
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
// v205：本函数改为 async —— 崩塌目标若带 `shatter`（「天界」），要等整条摧毁演出播完；
//       已破碎的列永久锁定，直接跳过（不会重复崩塌、也不能再换地形）。
async function locCollapseEffects() {
  const st = state;
  for (let j = 0; j < 3; j++) {
    if (locShattered(j)) continue; // v205：已破碎的列跳过
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
    resetLocGaps(j);         // v200：换地形 → 清空本列已封的隙间
    refreshLocHeader(j);     // 列名/图标/效果文案/配色即时更新
    log('danger', `${def.icon} ${def.n}：本区双方共 ${cnt} 张卡牌（≥ ${col.cards}），结界崩塌 —— 本区域变成了「${target.n}」！`);
    // v151 口径：变形 = 该地形在本区“出现”——立刻结算其「出现时」效果
    // （冥界无 spawn，此处为空操作；若日后换成带 spawn 的目标地形则照常生成）
    runLocAppearEffect(j, target);
    // v203：崩塌出「虚假之月」→ 本局总回合数变 7（第 6 回合末崩塌同样会续出第 7 回合，用户口径）
    syncRoundTotal('地形崩塌');
    await awaitShatterChain(); // v205：目标若带 `shatter`（天界）→ 等摧毁链播完
  }
}

/* ---- v200：区域「回合结束封格」效果（地形字段 `gap: N`，现仅「八云紫的家」）----
   每回合翻牌结算后（阶段 ⑤-0 地形类回合结束效果的**最后一步**，排在 collapse 之后）结算：
   逐列检查本列地形是否带 `gap`，对**双方分别**判定 —— 某侧在本区**还有空位**
   （已占格 `sideUsed` < 该侧当前可用格数 `locSideMax`）就在回合末继续封 `gap`（缺省 1）格；
   该侧“剩下的空间已经被牌放满”（含已被封到底、可用格数 0）则本次**不加**。
   封格 = 把该侧「已封隙间数」+N（见 locGaps / locSideMax）：可用格数随之 −N，
   渲染层（buildZoneChildren）随即在**最靠后的空置不可用格**铺出「隙间」灰卡，
   于是表现就是“从后往前、逐回合各封一格”。口径详见 locGaps 注释与
   `docs/现有机制.md` §2「区域「回合结束封格」效果」段。 */
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
      if (used >= before) continue; // 该侧剩下的空间已被牌放满 / 已封到底 → 本次不加
      const L = st.locs[j];
      if (!L.gaps) L.gaps = { p: 0, a: 0 };
      L.gaps[side] = (L.gaps[side] || 0) + Math.min(n, before - used); // 至多封到“刚好放满”，不会超过可用格数
      const after = locSideMax(side, j);
      hit.push(`${side === 'p' ? '你方' : '敌方'}隙间 ${locGaps(side, j)} 张（可用 ${after} 格，已放 ${used} 张）`);
    }
    if (hit.length) {
      log('sys', `${def.icon} ${def.n}：回合结束 —— 双方各从后往前添加隙间 → ${hit.join('、')}`);
    }
  }
}

/* ==================== v208：区域「揭示重复触发」（地形字段 `repeatReveal`，现仅「守矢神社」）====================
   一句话口径（**v210 修订后的用户口径**）：**凡是在带本字段的区域里发生的「揭示结算」，都执行两次**
   （第 1 次照常 → 停 400ms → 第 2 次「重复」）。**只针对「揭示」**——持续 `og`、时机 `fx`
   （turnStart / turnEnd / gameEnd / handEnd）等**非揭示机制一律不算、一次都不跑**。
   ⚠️ **v210 的关键修订（用户实测反馈）**：v208 首版把本字段实现成“**那张牌翻面时**多结算一次”，于是
   **早苗（`retrigger`）再触发出来的那些揭示不算“翻面”、不会被执行两次** —— 这不对。正确模型是
   **“揭示在哪个区域结算，就按那个区域是否带本字段决定执行几次”**，因此：
     · 暗牌在本区**翻面** → 它的揭示执行 2 次（1 次 + 重复 1 次）；
     · **早苗在本区翻开** → 她自己的揭示执行 2 次（第 1 次 + 本地形的重复）；
     · **早苗每一次揭示所“再触发”的其它揭示牌** → 那些揭示**也发生在守矢神社里** ⇒ **各自执行 2 次**。
   ⇒ 用户口径的**总计 6 次**（以同区另一张已翻开的揭示牌 A 为例，早苗翻开后）：
       A 自身翻面 2 次（1 + 地形重复）
       + 早苗第 1 次揭示再触发 A → 2 次
       + 早苗第 2 次揭示（本地形重复出来的那一次）再触发 A → 2 次
       = **6 次**（早苗自己的揭示是 2 次：自身翻面 1 + 地形重复 1）。
   口径（用户确认，v208）：
     ① **候选＝“在本区域被翻开”的牌**（暗牌翻面那一刻，口径同 `gamble`/`gust`）：落地即翻开的
        落场 token（石块/厄运/分身/龙玉…）、「复活弃牌池」落地即翻开的牌、以及**已翻开后被移入本区**
        的卡都**不参与**；地形出现前就在本区的旧卡也不追溯。白板（`k: ''`）无揭示可重复，直接跳过。
     ② **只重复一次**（不是循环），且**只重复「揭示」**：重复 = 对同一张牌**再走一次翻牌流程的
        揭示分派** `resolveCardReveal`（v209 起；此前是直接调 `applyEffect`）⇒ 所有揭示键
        （`bf`/`de`/`ba`/`bl`/`dw`/`dwb`/`dwh`/`dwc`/`spawn*`/`clone`/`gather`/`give`/
        `shuffleIn`/`discard`/`reviveDiscard`/`switch`/`gift`/`morph`/`xform`/`xformR`/`mv`/`roam`/`shift`/
        `costUp`/`energyNext`/`tkBuff`/`deAll`/`retrigger`）照常重跑；**不触发** `og`/`surv`/`phx`/
        `prot`/`ind`/`fly` 与 `fx` 时机效果（本字段天生与它们无关——只执行一次揭示分派）。
        ⚠️ **v209 修（用户实测反馈）**：四个「分步演出」键**重复时照常保留各自的间隔**——
        重复「三妖精集结」会**逐区生成、逐区结算其揭示、每区之间 0.5s**（而不是一次性生成三只并
        并发结算）；同理重复八云紫 `shift` 逐张 0.3s、重复四季映姬 `reviveDiscard` 逐张 500ms、
        重复「东风谷早苗」逐张 0.5s。此前走同步 `applyEffect`、这些间隔会被静默吞掉。
     ③ **含法术**（用户口径）：调用点在 `revealRound` 里被刻意排在 `vanishSpell` **之前** ⇒
        「自身揭示 → 停 400ms → 重复一次 → 才自行消散」；法术在重复时仍占着它那 1 个格位（v170 口径）。
     ④ **触发面＝“在本区域结算的揭示”两种来源**（v210）：㈠ **在本区翻面的暗牌**——资格按
        「翻开那一刻」的**快照**认定（翻牌途中本列被卡牌 `xform` 换成别的地形也照常重复；
        `revealRound` 在翻面瞬间把 `locDef(mv.loc).repeatReveal` 记进 `repeatRevealHere` 传进来）；
        ㈡ **早苗 `retrigger` 再触发的每一条揭示**（v210 新增）——那一张牌**当前所在区域**若带本字段，
        这次被再触发的揭示**也执行 2 次**（资格**实时读**，因为再触发发生在揭示链内部、没有“翻开那一刻”）。
        ⚠️ 注意区分：**同一张牌两次不同来源的加倍会相乘**（A 自身翻面 2 次 + 早苗两次揭示各再触发 2 次
        = 6 次），这正是用户口径要的账。
     ⑤ **资格按「翻开那一刻」快照认定**（用户口径）：翻牌途中本列被卡牌 `xform` 换成别的地形
        （如灵乌路空 → 聚变反应炉）也**照常**重复一次；调用方（`revealRound`）因此在翻面瞬间就把
        `locDef(mv.loc).repeatReveal` 记进 `repeatRevealHere` 再传进来（本函数不重读地形）。
     ⑥ **重复时按该牌“当前所在区域”结算**（用户口径，口径同 v207 早苗）：若它自己的揭示已把它挪出
        本区（八云紫 `shift` / 幽灵 `roam` / 依神紫苑 `switch`），**仍重复一次**、只是按挪走后的
        **新区域**读盘面（`fieldLocOf` 实时读）；已不在场上（被摧毁 / 回手）则只记一条日志并跳过。
     ⑦ **与「揭示后吹飞」`gust` 的先后**：重复点在 `gust` **之前**。⚠️ 实战中同一列只可能有**一块**
        地形，故「守矢神社 + 魔力风暴」不会同列共存；这个顺序只在“翻牌途中本列被 `xform` 换掉”
        这类情形下才有可见差别。
     ⑧ **节奏**（用户口径）：**重复之前停 400ms**（与翻牌结算前那个停顿同款），重复结算完再
        `renderZones()`，让 ±N / 生成 / 摧毁等演出看得出“又触发了一次”；停顿后校验 `state.gen`
        （重新开局即放弃本次重复，同 applyShiftReveal 的中断保护口径）。
     ⑨ **非“摧毁”/非增减/非放置**：本字段自身不改战力、不动区域字段与格位、不触发 `surv`/`phx`/
        `prot`/`ind`、不进 `powerLog`/`fieldQueue`（被重复的那些效果当然各按自己的口径改盘面）；
        **不是**揭示键，`revealEffectWillChange` 与 `applyEffect` 都不需要新分支。
     ⑩ **静海（v202）**：本字段不发动任何非揭示机制；被重复的牌若此刻在带 `mute` 的区域里
        （如它自己的揭示把它挪进了静海），`applyEffect` 入口守卫照常拦下并记日志。
   与 v207 的**卡牌键 `retrigger`（东风谷早苗）**的分工：地形是**区域规则**（“在本区发生的揭示都执行两次”，
   不需要有卡、不需要额外卡位、逐处判定）；早苗是**卡牌效果**（“她自己翻开时把
   本区己方已翻开卡各再触发一次”）。两者**叠加后是乘积关系** —— 正是上面那套“总计 6 次”的账（v208 首版曾把“早苗再触发出来的揭示”排除在外，v210 修正）。 */

/** v208（**v210 修订**）：**在本区域执行一次揭示结算** —— 本字段的唯一语义收口：
    若该区域带 `repeatReveal`，就把这次揭示**执行两次**（第 1 次 → 停 400ms → 第 2 次「重复」）；否则只执行一次。
    调用方（都在可 `await` 的翻牌流程内）：
      · `revealRound` —— 暗牌翻面那一次，资格用**翻开那一刻的快照**（`forceRepeat`＝`repeatRevealHere`）；
      · `retriggerOneStaged` —— 早苗再触发的**每一条**揭示，资格**实时读**该牌当前所在区域。
    v209：两次执行都走**共用分派** `resolveCardReveal`（而非直接 `applyEffect`），故四个「分步演出」键
          照常使用各自的异步分步版与间隔（重复「三妖精集结」仍逐区 0.5s，而不是一次性生成三只）。
    v210：语义由“翻面那一下多结算一次”改为“**凡在本区发生的揭示结算都执行两次**”，因此早苗再触发出来的
          揭示**也会被加倍**（用户口径的“总计 6 次”链）。
    ⚠️ 重复那一次**不再递归加倍**（末尾直接调 `resolveCardReveal`），保证有限、不会无限递归。 */
async function resolveRevealInZone(side, locIdx, card, forceRepeat) {
  const gen = state.gen;
  const locName = locDef(locIdx).n; // 日志里的区域名（此刻本列地形可能已被该牌自己的揭示换掉）
  const doRepeat = (forceRepeat === undefined) ? !!locDef(locIdx).repeatReveal : !!forceRepeat;
  await resolveCardReveal(side, locIdx, card); // ① 第 1 次（正常揭示）
  if (!doRepeat) return;
  renderZones(); // 先让第 1 次的 ±N / 生成 / 摧毁等演出显示出来
  await sleep(400); // 用户口径：重复前停 400ms，让玩家看清“又触发了一次”
  if (gen !== state.gen) return; // 重新开局等中断
  if (cardMuted(card)) {
    // 该牌此刻在带 mute 的区域里（如它自己的揭示把它挪进了静海）→ 文本被抹除，重复不发动
    muteSkipLog(card, '揭示效果（地形「揭示重复触发」）');
    return;
  }
  const nowLoc = fieldLocOf(card);
  if (nowLoc < 0) {
    log('sys', `🔁 ${locName}：想重复结算「${card.def.n}」的揭示，但它已不在场上（被摧毁或回到了手牌），本次不重复。`);
    return;
  }
  log(side, `🔁 ${locName}：重复结算「${card.def.n}」的揭示效果 —— 第 2 次（仅重复揭示；持续与回合开始/结束等非揭示效果不重复）。`);
  // ② 第 2 次：走共用分派（分步键保留各自间隔）；**这里不再递归加倍**（本字段每处只多一次）
  await resolveCardReveal(card.side, nowLoc, card);
  renderZones();
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
  // tag = 地形名 → 战力影响历史按来源显示「驹草赌场」；v201：掷出负值且本区带 noDown 时被拦下
  if (applyPermBuff(card, d, null, def.n) === false) {
    log('sys', `${def.icon} ${def.n}：${side === 'p' ? '你方' : '敌方'}「${card.def.n}」赌了一把 → 掷出 ${d}，但被本区「免减攻」拦下（战力不变，现 ${cardPowerIn(locIdx, card)}）`);
    return d;
  }
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
        // v201：若本区带 noDown（不会与本字段共存，防御性保留）→ 掷出负值时被拦下
        if (applyPermBuff(c, d, null, def.n) === false) {
          hit.push(`${side === 'p' ? '你方' : '敌方'}「${c.def.n}」掷出 ${d} 但被「免减攻」拦下(${cardPowerIn(j, c)})`);
          continue;
        }
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
        // v201：add 为负且本区带 noDown（防御性）→ 该次被拦下，不计入“已加成”列表
        if (applyPermBuff(c, add, null, def.n) === false) continue; // tag = 地形名 → 战力影响历史按来源显示「演唱会」
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
    let blocked = 0; // v201：被本区「免减攻」拦下的张数（只在 delta<0 时可能出现）
    for (const side of ['p', 'a']) {
      // 快照遍历：applyPermBuff 只改 buff 不增删卡，slice 仅作防御
      for (const c of st.players[side].zones[j].slice()) {
        if (!c.revealed || c.def.un || c.def.spell) continue; // v170：法术无战力，不吃成长/衰减
        // tag = 地形名 → 战力影响历史按来源显示「寺子屋」/「间歇泉」
        if (applyPermBuff(c, delta, null, def.n) === false) { blocked++; continue; } // v201：免减攻 → 本次跳过
        hit.push(`${side === 'p' ? '你方' : '敌方'}「${c.def.n}」(${cardPowerIn(j, c)})`);
      }
    }
    // 本区没有已翻开的卡时不刷日志（与 reactorPurge 一致，避免空转噪音）
    if (hit.length) {
      const sign = delta > 0 ? '+' : '−';
      log(delta > 0 ? 'sys' : 'danger', // 成长走绿色 sys、衰减走红色 danger
        `${def.icon} ${def.n}：本区双方已翻开卡牌各 ${sign}${Math.abs(delta)} 战力 → ${hit.join('、')}${blocked ? `（另有 ${blocked} 张因本区「免减攻」被拦下）` : ''}`);
    } else if (blocked) {
      log('sys', `${def.icon} ${def.n}：本区双方已翻开卡牌本应各 −${Math.abs(delta)} 战力，但 ${blocked} 张全部因本区「免减攻」被拦下（战力不变）。`);
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
    // v180：ind 卡（佛体金刚石）**照常参与“最低战力”的比较**——它成为最低时摧毁失败、本回合不再
    //   波及别的牌（如只有金刚石 6 + 辉夜 8 时：最低＝金刚石 → 失败 → 辉夜存活）
    const all = zoneP.concat(zoneA).filter((c) => !c.def.un && !c.def.spell);
    if (all.length === 0) continue;
    if (locNoDestroy(j)) { log('danger', `⚡ ${def.n}：本区域存在免摧毁效果（地形「睡鼠神祠」或「蕾蒂」等），所有卡牌均无法被摧毁，本次跳过。`); continue; }
    let min = Infinity;
    for (const c of all) min = Math.min(min, cardPowerIn(j, c));
    const doomed = all.filter((c) => cardPowerIn(j, c) === min);
    const removed = [];
    for (const c of doomed) {
      if (indestructibleBlock(c, def.n)) continue; // v180：ind 卡摧毁失败（并列最低的其他牌照常被判摧毁）
      if (phoenixRevive(c, j)) continue; // 凤凰重生（如藤原妹红）：回手 +N 战力
      if (surviveDestroy(c)) continue; // 防摧毁（如灵乌路空）：替代为降战力、卡不离场
      recordDestroy(c, j, def.n); // v187：真正离场 → 牌本体进归属方的摧毁池（须在移出区域之前记）
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
  let shatteredN = 0; // v205：已破碎（被「天界」摧毁）的区域数
  for (let j = 0; j < 3; j++) {
    const def = st.locs[j].def;
    // v205：已破碎的区域**不计分、不参与胜负、也不显示点数比大小** —— 只留一行说明。
    //       ⚠️ 刻意不写原本的地形名（与棋盘上“看不出原来是什么地形”保持一致；
    //          原地形名在它被摧毁那一刻的日志里已经记过）。
    if (st.locs[j].shattered) {
      shatteredN++;
      lines.push(`⚡ 区域 ${j + 1}：<b>已破碎</b>（已被「天界」摧毁 —— 不计分、不参与胜负）`);
      continue;
    }
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
  const hasInv = st.locs.some((l) => !l.shattered && l.def.inv); // 只统计仍在场的区域
  const aliveN = 3 - shatteredN; // v205：仍参与判定的可用区域数（「天界」局通常为 1）
  let delta = 0, title, sub, emblem;
  if (tie > 0) {
    // 存在平局区域：按仍在场区域的总点数决胜（v205：已破碎区域不加进 pTotal/aTotal）
    sub = shatteredN
      ? `已被摧毁 ${shatteredN} 个区域 → 仅剩 ${aliveN} 个可用区域，且为平局 → 按剩余区域总点数决胜：你 ${pTotal} : ${aTotal} 对手`
      : `存在平局区域 → 三区总点数决胜：你 ${pTotal} : ${aTotal} 对手${hasInv ? '（反转区域按负值计入总点数）' : ''}`;
    if (pTotal > aTotal) { delta = st.stakes; title = '你赢了！'; emblem = '🏆'; }
    else if (aTotal > pTotal) { delta = -st.stakes; title = '你输了…'; emblem = '💀'; }
    else { title = '平局'; emblem = '🤝'; sub += ' · 总点数相同'; }
  } else {
    // 无平局区域：看谁赢下的区域更多
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
  const addStoneBtn = $('btnAddStone'); // v206：开发者「🪨 添加石块」
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
  // v203：顶栏「回合 N / 总数」的总数改读本局总回合数 —— 地形「虚假之月」在场 → / 7
  //（揭晓那一刻起就变 /7；被换掉则回 /6；已到第 7 回合则锁定为 7）。元素缺失时静默跳过（防御）。
  const turnMaxEl = $('turnMax');
  if (turnMaxEl) turnMaxEl.textContent = '/ ' + roundsTotal();
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
  // v186：能量槽（手牌上方那一排橙色小长条）**只画「本回合当前可用能量」的条数**，
  // 不再补灰色占位到 6 条：有多少可用就画几条橙色 —— 例如第 4 回合开局是 4 条（原来会是
  // 4 橙 + 2 灰）；出牌花掉能量后条数随之减少，用完就一条不画。
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
  // v205：某列已是「已破碎」时（防御；正常 restart 会先把 locs 全重置为未揭示）
  //       把整列换成损坏面板 —— 与 shatterZoneTerrain 走同一个渲染出口。
  state.locs.forEach((loc, idx) => { if (locShattered(idx)) renderShatteredColumn(idx); });
}

// 区域被“变形”（如鬼人正邪 → 辉针城）后刷新该列的标题/图标/效果文字/配色 class
// v205：若该列已「破碎」，整列换成损坏面板（没有列名 / 效果文字 / 点数 / 格位）
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
  if (!playReqCheck(playSide(), card).ok) return false; // v196：卡级放置条件（playReq）
  if (occOf(card) > 1 && !occZoneOk(card, idx, playSide())) return false; // 大体积卡需该侧可用格数恰为占格数
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
    // v170：法术卡框不显示战力（实际战力恒为 0），右上角战力位改显「✦」星标
    // v178：星标**只画一个 ✦**、不再写「法术」二字（悬停有 title 提示；完整说明仍在放大/详情弹窗里）
    const spell = isSpell(card);
    if (spell) el.classList.add('spell');
    const topRight = spell ? '<span class="mc-spell" title="法术 · 无战力（揭示后消散）">✦</span>' : `<span class="p${cls}">${live}</span>`;
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
    // v202：静海「抹除文本」——文本被抹除的牌失去该能力，不再提示/不进入移动模式
    const canFly = side === 'p' && state.phase === 'play' && card.def.fly && card.revealed && !state.flyMoved.has(card.id) && !cardMuted(card);
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
    // v205：已破碎的列整列由 renderShatteredColumn 负责（一块损坏面板：无地形名、无双方总点数、
    //       无格位、不可交互）——这里整列跳过，既不改它的 DOM，也不参与领先着色与格位渲染。
    if (locShattered(j)) continue;
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
    // v200：分母改用**该侧可用格数**（＝地形 max − 该侧已封隙间数），被隙间封掉的格不再算可用
    const count = sideUsed('p', j) + '/' + locSideMax('p', j);
    let locTag = '';
    if (ldef.id === 'unreveal') locTag = ` · 🃏 第 ${j + 1} 回合揭晓`;
    else if (ldef.minTurn && !locOpen(j)) locTag = ` · 🔒 第 ${ldef.minTurn} 回合开放`;
    if (locGaps('p', j)) locTag += ` · ≋ 隙间 ${locGaps('p', j)}`; // v200：本侧被隙间封掉几格
    mineZoneEl.querySelector('.slot-count').textContent = `已放 ${count}${locTag}`;
    mineZoneEl.parentElement.classList.toggle('hoverable', canPlaceP(j));
    // 未开放区域加灰色遮罩（如七夕坂第 5 回合前）
    Game._els.cols[j].classList.toggle('locked', !!locDef(j).minTurn && !locOpen(j));
  }
  flushBuffFlash(); // v80：本次渲染后触发“永久 +N”绿色动画（bf/ba/bl/oc/phx 等收口排队）
  flushCostFlash(); // v169：本次渲染后触发“费用 ±N”动画（costUp 等收口排队）
  flushRetriggerFx(); // v211：本次渲染后触发“早苗揭示光环 / 目标卡闪光”（retrigger 收口排队）
  renderPiles();    // v187：侧栏「特殊牌池」两个计数徽标（弹窗开着时同步重渲染当前页签）
}

/* 把区域的一侧 2×2 格位按规则填充：
   - 已放卡永远占其格位（含揭晓后超过上限的卡：不删除、不移动，见 locationRevealStage）；
   - 空位且属于允许格（i < 该侧可用格数）：地形 max=4 用浅灰虚线格，max<4 用透明占位；
   - 空位且是不允许格（i >= 该侧可用格数）：固定用「隙间」灰色卡占位——只铺在“空置”的不可用格，
     所以隙间数 = 4 − max(已放卡数, 可用格数)：未超限时 = 4−可用格数（如迷途竹林 2 个）；
     揭晓超限/被隙间封格时随卡占格递减（已放 3 张 → 1 个；放满 4 张或大体积卡占满整侧 → 0 个），
     与“不删卡”口径一致。
   ⚠️ v200：「可用格数」= 该地形 max − **该侧**已封隙间数（locSideMax，双方各记一份）——
     「八云紫的家」每回合末从后往前各封一格，封出来的正是这里渲染的隙间；换地形时清空。 */
function buildZoneChildren(side, locIdx) {
  const def = locDef(locIdx);
  const sideMax = locSideMax(side, locIdx); // v200：该侧可用格数（含隙间封格）
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
  // 隙间卡不可被操作：点击不触发任何区域/卡牌逻辑
  el.addEventListener('click', (e) => e.stopPropagation());
  return el;
}

/* ---- v180：把「加入手牌」的卡**立刻**渲染出来，让 v90 的「滑入」演出（`.hand-new`）真的能被看到 ----
   背景（为什么必须补这一下）：`give` / `drawSpell` 只改数据并给新卡打 `justHandAdded` 标记，
   `.hand-new` 由 renderHand 在“下一次渲染”时加上、且**加完即清标记**。而 `give` 的结算点在
   阶段 ④（翻牌揭示）里——那时只 `renderZones()`，手牌要等到回合末 `playRound` 的 `renderAll()`
   才渲染；偏偏紧接着**同一个同步任务内** `st.turn++ → playRound → roundStartStage()` 又会
   `renderAll()` 一次（`hand.innerHTML = ''` 整块重建）。于是带 `.hand-new` 的元素**一次都没被
   浏览器绘制就被替换掉**，动画时长实际为 0——表现就是“手牌里突然多出两张牌、没有任何演出”。
   （雾雨魔理沙的 `give`（v177）／本卡池写法（v180）都走这里；帕秋莉的回合开始 `drawSpell`
   不需要调用本函数：它的渲染点后面紧跟 `await waitPlayer()`，本来就能正常播动画。）
   口径：只对**玩家侧**调用——renderHand 渲染的是玩家手牌；对手手牌不渲染（只有侧栏计数，
   回合末的 renderAll 会照常刷新）。 */
function flushHandAdd(side) {
  if (side !== 'p') return;
  renderHand();
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
    // v196：卡级放置条件（`playReq`，现仅 6 费「大鲶鱼」）不满足时同样置灰，并给出数量提示
    //   （此时“费用够、但条件不够”，点击后 tryPlayAt 会说明现 N 张、不会白扣能量）
    const reqR = playReqCheck('p', card);
    if (!reqR.ok) {
      el.classList.add('unaffordable');
      el.title = `放置条件未满足：需要你的场上已有至少 ${reqR.need} 张已翻开的「${reqR.label}」（现 ${reqR.have} 张）`;
    }
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

// v184：更新与手牌计数并排的「牌库 N」提示 —— 玩家自己的牌库张数原本没有任何显示，
// 而 v184「洗入卡组」会把牌洗进自己/对手的牌库（张数会变），故补一个常驻计数，
// 它同时是「洗入卡组」玩家侧演出的锚点（见 playShuffleInFx）。
function updateDeckCount() {
  const el = $('deckCountVal');
  if (el) el.textContent = '牌库 ' + state.players.p.deck.length;
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
  return `<div class="hc-top"><span class="cost-orb${costSign}">${cost}</span>${isSpellDef(def) ? '<span class="hc-spell" title="法术 · 无战力（揭示后消散）">✦</span>' : `<span class="p${sign}">${power}</span>`}</div>
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
// v205：已破碎的列标成「已破碎（不可更换）」，一眼看出它被天界摧毁且永久锁定
function locTextAt(idx) {
  if (locShattered(idx)) return '💥 已破碎（不可更换）';
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
// v205：本函数**保持同步** —— 换上「天界」时只启动摧毁链、不在这里等它（弹窗必须立刻关）。
function uiOnPickLocConfirm() {
  if (!isDevMode()) return;
  const def = pickLocDefId ? findLocDef(pickLocDefId) : null;
  if (!def) { updatePickLocTip('还没选地形：请在下方点选一种地形，再点「替换」。'); return; }
  const locIdx = pickLocZoneIdx;
  if (locIdx < 0 || locIdx > 2 || !state.locs[locIdx]) {
    updatePickLocTip('请先在上方选中要替换的区域（1 / 2 / 3）。');
    return;
  }
  // v205：已破碎的区域**永久锁定** —— 任何路径（含开发者工具）都不能再给它换地形
  if (locShattered(locIdx)) {
    updatePickLocTip('区域 ' + (locIdx + 1) + ' 已被「天界」摧毁（已破碎）：永久锁定，不能再指定地形。需要重试请先「重新开始」。');
    return;
  }
  const prev = state.locs[locIdx].def;
  const spawnChk = $('pickLocSpawn');
  const wantSpawn = !spawnChk || spawnChk.checked; // v150：默认结算「出现时」效果（可勾掉）
  // 直接替换当前列显示地形；同步 locPlan，避免后续揭晓又盖回旧计划
  state.locs[locIdx].def = def;
  resetLocGaps(locIdx); // v200：换地形 → 清空本列已封的隙间
  if (state.locPlan && state.locPlan.length > locIdx) state.locPlan[locIdx] = def;
  refreshLocHeader(locIdx); // 列名/图标/效果文案/配色即时更新
  const spawnNote = !wantSpawn
    ? '（按设置不结算「出现时」效果）'
    : (def.spawn ? '（结算「出现时」效果）' : '（该地形没有「出现时」效果）');
  log('sys', '🗻 开发者指令：将区域 ' + (locIdx + 1) + '「' + (prev ? prev.n : '?') + '」替换为「' + def.n + '」' + spawnNote + '。');
  // v150：与地形揭晓走同一结算路径 —— 如虹龙洞 → 双方各生成 1 张「石块」
  // v205：换上「天界」时，这里同时启动「摧毁另外两块地形」的演出链
  const spawnCount = wantSpawn ? runLocAppearEffect(locIdx, def) : 0;
  // v203：换上/换掉「虚假之月」→ 本局总回合数当场变（顶栏即时刷新 + 留一条日志，便于调试验证）
  syncRoundTotal('开发者指定地形');
  // v205：⚠️ 这里**刻意不等** `awaitShatterChain()` —— 开发者工具必须**立刻关窗**，
  //       「天界降临」的逐张摧毁演出在后台继续播（它自己每摧毁一张就 renderZones 一次，
  //       结束时也会收尾重绘）。若在此 await，弹窗会一直挂到两块地形都拆完才消失（用户反馈）。
  //       注：正常对局里的四条路径（揭晓 / xformTurn / collapse / 卡牌 xform）**仍然会等** ——
  //       那里必须等，否则回合开始、翻牌、回合结束会插进摧毁节奏里。
  renderZones(); // 隙间 / 锁定遮罩 / 点数横幅 / 新生成的 token 一并刷新
  setStatus('区域 ' + (locIdx + 1) + ' 已替换为「' + def.n + '」'
    + (spawnCount > 0 ? '，并结算了「出现时」生成（共 ' + spawnCount + ' 张）。' : '。')
    + ((def.shatter && shatterChain) ? '「天界降临」演出进行中：另外两块区域正在被逐个摧毁…' : ''));
  closePickLoc(); // 立刻收起弹窗（演出在后台继续）
}

/* ---------- v206：开发者「🪨 添加石块」（批量生成石块，纯粹为调试方便）----------
   入口：顶栏 `.top-actions` 里紧接「🗻 指定地形」的 `#btnAddStone`（**仅开发调试显示**）。
   弹窗 `#addStoneMask`：上面三个按钮选区域 1/2/3（复用「指定地形」的 `.pick-loc-zone-row` /
   `.plz-btn` 样式与交互），下面一个可用 **◀ ▶ 箭头**增减的数字输入框 + 「添加石块」。
   口径（用户确认，v206）：**双方各 N 张** —— 与「虹龙洞 / 黄瓜田 / 幽灵洋馆」的
   「区域出现时：双方各生成 N 张」**完全同款**，统一走 `placeToken`（落地即翻开、占格位、
   进 `fieldQueue`、播「凝聚显形」演出），因此也**照常尊重**：
     · 限张地形（迷途竹林 max 2）、「八云紫的家」的隙间封格、大体积卡占满整侧；
     · **v205 的「已破碎」区域**（`locSideMax` 恒 0 ⇒ 一张也放不下，会明确提示而不是静默失败）。
   生成的石块是**普通 `SPECIAL.stone` token**（1 费 / 0 战力 / `tk:'rock'` / 无 `k`），
   因此照常吃「比那名居天子」的持续光环、计入「大鲶鱼」的 `playReq` 放置条件、
   也可被摧毁 / 移动 / 换边 —— 正是这几个机制需要的调试素材。
   ⚠️ 它不是“出现时”效果、不走 `runLocAppearEffect`、不触发任何 `spawn`（也就不会连锁别的机制）。
   N 的取值范围夹在 **1..4**（每侧 4 格、石块 occ=1）；空位不够时按实际可放张数少放并在日志写明。 */
const ADD_STONE_MAX = 4; // 每侧最多 4 格（石块占 1 格）——输入框夹在 1..4
let addStoneZoneIdx = 0; // 当前选中的目标区域 0/1/2

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
// ⚠️ 刻意**不在这里回写** `input.value` —— 否则用户清空输入框准备重打时会被立刻填回 "1"，
//    光标位置也会跳；回写只发生在「◀ ▶ 步进 / 失焦 / 确认」这三处。
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
// 选中要添加石块的目标区域（按钮点击 / 事件委托 都走这里）
function selectAddStoneZone(idx) {
  const i = Number(idx);
  if (!Number.isFinite(i) || i < 0 || i > 2) return;
  addStoneZoneIdx = i;
  syncAddStoneZones();
  updateAddStoneTip();
}
// 区域按钮直接绑定（幂等：data-bound 标记，重复打开不会重复挂监听）
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
    btn.textContent = pickLocZoneText(idx); // 与「指定地形」共用同一套区域文案
    btn.title = '把石块加到 ' + pickLocZoneText(idx) + '（当前 ' + locTextAt(idx) + '；双方各一份）';
  });
  syncAddStoneSteppers();
}
/** 步进按钮在边界置灰（1 / 4）——由 syncAddStoneZones 与 updateAddStoneTip 共同调用，
    所以无论是点按钮、直接键盘输入还是方向键改值，两个箭头都会立刻跟着置灰/解禁。 */
function syncAddStoneSteppers() {
  const n = readAddStoneCount();
  const minus = $('addStoneMinus');
  const plus = $('addStonePlus');
  if (minus) minus.disabled = n <= 1;
  if (plus) plus.disabled = n >= ADD_STONE_MAX;
}
// warn 非空时在弹窗内显示红字提示（校验失败 / 放不下用），否则显示当前选择与空位摘要
function updateAddStoneTip(warn) {
  const tip = $('addStoneTip');
  const note = $('addStoneNote');
  const idx = addStoneZoneIdx;
  const n = readAddStoneCount();
  const zoneTxt = pickLocZoneText(idx);
  const okBtn = $('btnAddStoneConfirm');
  const shattered = locShattered(idx);
  syncAddStoneSteppers(); // 最前面同步：输入框被直接改值时两个箭头也立刻跟着置灰/解禁（后面有几条 return）
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
  if (input) input.value = String(readAddStoneCount()); // 确认时把输入框回写成夹取后的值
  const n = readAddStoneCount();
  const made = []; // 收集本次生成的卡实例（供日志/后续扩展；placeToken 会塞进来）
  const placedP = placeToken('p', idx, tk, n, made);
  const placedA = placeToken('a', idx, tk, n, made);
  const short = (placedP < n || placedA < n);
  renderAll(); // 新石块立刻显形（带「凝聚显形」演出）+ 点数/领先着色/可放置状态一并刷新
  log('sys', `🪨 开发者指令：给「${locDef(idx).n}」区域**双方各生成 ${n} 张「${tk.n}」** → 你方实际 ${placedP} 张、敌方实际 ${placedA} 张（落地即翻开、占格位、进放置队列；该侧放满则少放）。`);
  setStatus(`区域 ${idx + 1}：双方各生成 ${n} 张石块 —— 你方 ${placedP} 张、敌方 ${placedA} 张`
    + (short ? '（空位不足，已按实际可放张数生成）' : '') + '。');
  closeAddStone(); // 与「指定地形」一致：关掉弹窗，方便立刻看盘面
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
    // v180：give 的 `pool` 写法（辉夜从 5 张神宝里随机抽 2 张）——把池内卡片一并列出
    if (Array.isArray(def.give.pool)) for (const k of def.give.pool) add(k);
  }
  if (def.spawn) add(def.spawn.card);
  if (def.spawnO) add(def.spawnO.card); // 如键山雏 → 厄运
  if (def.spawnS) add(def.spawnS.card); // v172：祖母绿巨石（法术）→ 同名的 1 费/3 战力占位卡
  if (def.spawnMine) add(def.spawnMine.card); // v180：耀眼之龙玉（法术）→ 龙玉（3 费/3 战力）
  if (def.shuffleIn) add(def.shuffleIn.card); // v184：洗入卡组 → 被洗入的牌也列进「衍生/相关卡牌」
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
  // v180：自身不可摧毁（ind，佛体金刚石）——只保护它自己，非区域免摧毁、也非防摧毁
  if (def.ind) parts.push('持续 · 自身不可摧毁');
  // v179：持续效果 og 的两种匹配口径——tk（强化指定 token）/ cost（强化己方指定费用的卡牌）
  if (def.og) parts.push((def.og.tk == null && def.og.cost != null) ? '持续 · 强化己方指定费用的卡牌' : '持续 · 强化指定 token');
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
  // v185：游戏开始时效果（`gs`，现仅 7 费「哆来咪」）——避免把这张开局被动卡误标成纯白板
  if (def.gs) {
    const bits = [];
    if (def.gs.shuffleN) bits.push(`洗入 ${def.gs.shuffleN} 张随机牌`);
    if (def.gs.energyAdd) bits.push(`每回合最大能量 +${def.gs.energyAdd}`);
    parts.push('游戏开始时 · 在卡组中即触发' + (bits.length ? `（${bits.join('、')}）` : ''));
  }
  // v194：费用随摧毁递减（`costDown`，现仅 8 费「纯狐」）——同样避免被误标成纯白板
  if (def.costDown) parts.push(`持续 · 双方每有一张牌被摧毁，此牌能量消耗 −${def.costDown}（最低 0 费）`);
  // v196：卡级放置条件（`playReq`，现仅 6 费「大鲶鱼」）——避免把这张无揭示的牌误标成纯白板
  if (def.playReq) parts.push(`放置条件 · 仅当你场上已有 ≥ ${def.playReq.n || 1} 张已翻开的「${tokenNameLabel(def.playReq.tk)}」时可从手牌打出`);
  // v197：手牌回合结束效果（`fx.handEnd`，现仅 1 费「稗田阿求」）——它只在**手牌里**生效，
  //   打到场上之后不再触发，故与 ⑤ 的 `fx.turnEnd`（场上的牌）分开标注
  if (def.fx && def.fx.handEnd) parts.push('手牌回合结束 · 仅当此牌仍在手牌中时触发（打到场上后不再生效）');
  // 有其它机制标签时不再前置「无特殊效果（白板）」；纯白板卡仍显示白板标签
  const base = (def.k || !parts.length) ? (KIND_LABEL[def.k] || '') : '';
  if (base && parts.length) return base + '；' + parts.join('、');
  return base || parts.join('、');
}

/* v194：费用随摧毁递减（`costDown`，现仅 8 费「纯狐」）在放大视图里的补充说明行 ——
   把「当前双方摧毁池合计」与「因此减了多少费」写清楚，方便核对本机制（没有该字段则返回空串）。
   显示点两处：showHandCard（手牌 / 特殊牌池卡）与 showFieldCard（场上已翻开卡）。 */
function costDownNote(def) {
  if (!def || !def.costDown) return '';
  const n = destroyCount();
  const cut = def.costDown * n;
  const atZero = cut >= def.c;
  return `<div class="zm-kind cost-mod-note">费用随摧毁递减（每张 −${def.costDown}）：本场战斗中双方已有 ${n} 张牌被摧毁 → 能量消耗 −${cut}${atZero ? '（已减到最低 0 费）' : ''}</div>`;
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
    ${costDownNote(def)}
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
  // 3) 持续效果（实时、分来源，如天子→己方石块 +2、**v179 克劳恩皮丝→己方 1 费牌 +1**；
  //    源卡被摧毁/离场即不再列出）。判定口径与 cardAuraBonus 完全一致（tk 标记 / 印刷费用），
  //    保证本面板“合计战力 = 场上当前威力”。
  for (let j = 0; j < 3; j++) {
    for (const c of state.players[card.side].zones[j]) {
      const og = c.def.og;
      if (!og || !c.revealed || c.def.un) continue;
      if (locMuted(j)) continue; // v202：静海「抹除文本」——与 cardAuraBonus 同口径（源卡被抹除则不计）
      const hit = (def.tk && og.tk === def.tk) || (og.cost != null && og.cost === def.c);
      if (hit) {
        // v201：免减攻区把负的持续加成也按 0 计（与 cardAuraBonus 同步）
        const dv = (locNoDown(locIdx) && og.add < 0) ? 0 : og.add;
        if (dv) rows.push({ d: dv, kind: 'aura', label: c.def.n, sub: '持续效果' });
      }
    }
  }
  // 4) 区域加成（实时）：阵营 aff / 费用 cb / 全区 all
  //    v201：本区带 noDown（蓬莱药局）时，**负的实时加成按 0 计**——与 cardPowerIn /
  //    cardAuraBonus 同口径，否则“面板合计 ≠ 场上当前威力”（第 3 段的持续效果同样处理）
  const noDown = locNoDown(locIdx);
  const fix = (v) => ((noDown && v < 0) ? 0 : v);
  if (loc.aff && def.g === loc.aff.group && fix(loc.aff.add)) rows.push({ d: fix(loc.aff.add), kind: 'loc', label: loc.n, sub: `区域加成（${GROUPS[loc.aff.group] || loc.aff.group}）` });
  if (loc.cb && def.c === loc.cb.c && fix(loc.cb.add)) rows.push({ d: fix(loc.cb.add), kind: 'loc', label: loc.n, sub: `区域加成（费用 ${loc.cb.c}）` });
  if (loc.all && fix(loc.all)) rows.push({ d: fix(loc.all), kind: 'loc', label: loc.n, sub: '区域效果' });
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
  // v202：静海「抹除文本」——这张牌此刻的文本是否已被抹除（决定效果文字置灰 + 顶部提示行）
  const muted = cardMuted(card);
  // v169：费用修正跟着这一份卡走（被加费后打出的卡，场上/放大视图同样显示修正后的费用）
  const liveCost = cardCost(card);
  const costDiff = liveCost - def.c;
  const costSign = costDiff > 0 ? 'up' : costDiff < 0 ? 'down' : '';
  const slot = $('zoomCardSlot');
  slot.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'zoom-card hand-card' + (muted ? ' text-muted' : '');
  el.style.setProperty('--cgrad', gradOf(def));
  el.innerHTML = cardFaceHTML(def, { power: live, sign, cost: liveCost, costSign });
  slot.appendChild(el);

  $('zoomInfo').innerHTML = `
    <div class="zoom-meta"><span class="zm-cost">费用 ${liveCost}</span>${isSpellDef(def) ? '<span class="zm-pow">法术 · 无战力</span>' : `<span class="zm-pow">场上威力 ${live}</span>`}</div>
    ${muted ? `<div class="zm-kind mute-note">🌊 文本已被「${locDef(locIdx).n}」抹除：此牌的揭示 / 持续 / 时机 / 防护效果一律不发动（战力照常计入；离开静海后文本恢复）</div>` : ''}
    ${costDiff !== 0 ? `<div class="zm-kind cost-mod-note">印刷费用 ${def.c} · 本场战斗费用修正 ${costDiff > 0 ? '+' : ''}${costDiff}（仅此一份卡有效）</div>` : ''}
    ${costDownNote(def)}
    <div class="zm-kind">${isSpellDef(def) ? '法术 · 无战力（揭示结算完后即自行消散）' : `基础威力 ${def.p}`}</div>
    <div class="zm-kind">${kindTags(def)}</div>
    <div class="zm-desc${muted ? ' text-muted' : ''}">${def.t || (isSpellDef(def) ? '法术：只有能量花费与揭示效果，揭示结算完后自行消散。' : '平平无奇的白板卡，纯靠身材作战。')}</div>`;
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
  updateDeckCount(); // v184：玩家牌库张数（手牌区「牌库 N」计数）
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

/* ==================== v187：特殊牌池（侧栏入口 + 弹窗） ====================
   数据侧见本文件上方的 PILE_KINDS / pushToPile / recordDestroy / recordSpellExile 段
   （摧毁池 / 弃牌池占位 / 放逐池），这里只做界面：
     · 入口 `#pileCard` —— 位于 **地形区域的下方、对手信息的上方**：它是侧栏 `#sidePanel`
       的第一个区块（桌面端侧栏在场地右侧、移动端 ≤900px 侧栏整体排在场地下方，
       两种布局下它都正好落在“地形下方、对手信息（.opponent）上方”），
       里面两个按钮分别打开**己方 / 对手**的特殊牌池，各带一个合计张数徽标；
     · 弹窗 `#pileMask` —— 顶部三个切换按钮（摧毁池 / 弃牌池 / 放逐池，标签取自 PILE_KINDS，
       按钮上带各自张数），下方按**入池顺序（旧 → 新）**用卡面网格列出该池里的牌，
       每张卡下方另起一行显示入池序号（#N）与入池回合，悬停显示完整元数据
       （来源 / 区域 / 入池时战力），点击复用 showHandCard 放大查看（关闭放大层后回到牌池弹窗）。
   刷新：renderPiles() 更新两个计数徽标，弹窗开着时顺带重渲染当前页签；
   调用点＝renderZones() 末尾 + 入池收口（recordDestroy / recordSpellExile）。
   Esc / 点遮罩空白关闭：见本文件底部 initOverlays。 */
let pileSide = 'p';       // 弹窗当前查看的一方（'p' 己方 / 'a' 对手）
let pileKind = 'destroy'; // 弹窗当前页签（PILE_KINDS 的 key）
function pileSideLabel(side) { return side === 'a' ? '对手' : '己方'; }
function isPilesOpen() {
  const m = $('pileMask');
  return !!m && !m.classList.contains('hidden');
}
// 侧栏两个按钮的计数徽标（合计三个池的张数；分项写进 title）+ 弹窗开着时的列表刷新
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
/* 调试探针用：某方三个池的入池清单（`Game._dbg().pileP / pileA`）——按入池顺序列出卡名与元数据 */
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
// 空池文案（三个池各写一句，说明“为什么现在是空的”）
function pileEmptyText(side, kind) {
  const who = pileSideLabel(side);
  if (kind === 'discard') return `${who}的弃牌池还是空的 —— 本局还没有牌被弃掉（弃牌只把手牌里的牌移出，与场上的摧毁是两回事）。`;
  if (kind === 'exile') return `${who}的放逐池还是空的 —— 本局还没有法术被使用（法术揭示结算完后消散时入池）。`;
  return `${who}的摧毁池还是空的 —— 本局还没有牌被摧毁（只有真正离场的摧毁才会入池）。`;
}
// 牌池里的一张卡：卡面（战力取“入池时”的记录值）+ 下方入池序号/回合小字 + 元数据悬停提示。
// 图标角标不叠在卡面上（卡面左上角是费用宝珠、右上角是战力），改为独立的一行小字，手机端同样可见。
function pileCardEl(card, ord) {
  const def = card.def;
  const power = (card.pilePower != null) ? card.pilePower : cardPower(card);
  const sign = power > def.p ? 'up' : power < def.p ? 'down' : '';
  // 费用按实例的实时费用显示（被桑尼米尔克加过费的牌入池后仍显示修正值与红字，口径同手牌）
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
  face.className = 'codex-card hand-card pile-item' + (def.img ? '' : ' no-img');
  face.style.setProperty('--cgrad', gradOf(def));
  face.innerHTML = cardFaceHTML(def, { power, sign, cost: liveCost, costSign });
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
  pileKind = 'destroy'; // 每次打开都从「摧毁池」这一页开始
  renderPilePanel();
  const mask = $('pileMask');
  if (mask) mask.classList.remove('hidden');
}
function closePiles() {
  const mask = $('pileMask');
  if (mask) mask.classList.add('hidden');
}
// 侧栏按钮：点一次打开；已打开时再点则收起（与「👁️ 查看」同款开关手感）
function uiOnPiles(side) {
  if (isPilesOpen()) { closePiles(); return; }
  openPiles(side);
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
    // v206：开发者「🪨 添加石块」（批量为某区域生成石块，口径＝双方各 N 张）
    onAddStone: uiOnAddStone,
    onAddStoneClose: uiOnAddStoneClose,
    onAddStoneConfirm: uiOnAddStoneConfirm,
    onEnergyDev: uiOnEnergyDev,
    onSwitchSide: uiOnSwitchSide,
    onAiSpy: uiOnAiSpy,
    closeAiSpy,
    // v187：特殊牌池（摧毁池 / 弃牌池 / 放逐池）——'p' 己方 / 'a' 对手
    onPiles: uiOnPiles,
    closePiles,
    onEnergyReset: uiEnergyReset,
    confirmEnergyReset,
    cancelEnergyReset,
  },
  _dbg: () => ({
    gen: state.gen, phase: state.phase, turn: state.turn,
    roundTotal: roundsTotal(), // v203：本局总回合数（虚假之月在场 → 7；已到第 7 回合则锁定为 7）
    energyTotal: state.players.p.energyTotal, energyLeft: state.players.p.energyLeft,
    energyTotalA: state.players.a.energyTotal, energyLeftA: state.players.a.energyLeft,
    energyGainP: state.players.p.energyGain || 0, energyGainA: state.players.a.energyGain || 0,
    // v185：开局效果登记的「每回合最大能量 +N」（哆来咪）；玩家牌库张数也一并暴露（洗入后 22）
    energyAddP: state.energyAddPerTurn.p || 0, energyAddA: state.energyAddPerTurn.a || 0,
    deckP: state.players.p.deck.length,
    pendingEnergyP: state.pendingEnergyGain.p || 0, pendingEnergyA: state.pendingEnergyGain.a || 0,
    hasWaiter: !!pendingResolve,
    handP: state.players.p.hand.map((c) => cardCost(c)),
    handA: state.players.a.hand.map((c) => cardCost(c)),
    pMoves: (state.playerMoves || []).length, aiMoves: (state.aiMoves || []).length,
    pZones: state.players.p.zones.map((z) => z.length),
    aZones: state.players.a.zones.map((z) => z.length),
    // v187：特殊牌池（摧毁池 / 弃牌池 / 放逐池）——按入池顺序列出卡名，便于核对机制
    pileP: pileDbg('p'),
    pileA: pileDbg('a'),
  }),
  /* v189/v190/v191：弃牌的**控制台探针** —— 已有两张卡引用本键（**「莉莉黑」**：弃自己最右侧手牌；
      **v191「小野塚小町」**：弃自己手牌里**印刷费用最高**的一张），探针仍用于任意口径的验证
      （与卡牌结算同一个 `discardFromHand` 收口，流程/日志/入池/演出一致）：
       Game._discard('a', { n: 1 })                        → 弃对手手牌随机 1 张
       Game._discard('p', { pick: 'right' })                → 弃自己手牌**最右侧**那张（v190 口径）
       Game._discard('p', { pick: 'maxCost' })              → 弃自己手牌里**印刷费用最高**的那张（v191 口径）
       Game._discard('p', { card: '琪露诺' })               → 弃自己手里的「琪露诺」
       Game._discard('a', { cost: { min: 5 }, n: 'all' })  → 弃对手手里所有 ≥5 费（印刷费用）的牌
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
  const pileMask = $('pileMask'); // v187：特殊牌池弹窗
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
  if (pileMask) pileMask.addEventListener('click', (e) => { if (e.target === pileMask) closePiles(); }); // v187
  // v206：开发者「🪨 添加石块」弹窗（遮罩点击关闭 + 区域按钮/步进按钮直接绑定 + 输入框实时刷新提示）
  const addStoneMask = $('addStoneMask');
  if (addStoneMask) {
    addStoneMask.addEventListener('click', (e) => { if (e.target === addStoneMask) closeAddStone(); });
    bindAddStoneZoneButtons(); // 直接绑定（事件委托仅作兜底）
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
    else if (addStoneMask && !addStoneMask.classList.contains('hidden')) closeAddStone(); // v206
    else if (!pickMask.classList.contains('hidden')) uiOnPickClose();
    else if (aiSpyMask && !aiSpyMask.classList.contains('hidden')) closeAiSpy();
    else if (pileMask && !pileMask.classList.contains('hidden')) closePiles(); // v187：牌池弹窗
    else if (!undoMask.classList.contains('hidden')) cancelEnergyReset();
  });
})();

// 启动
restart();
