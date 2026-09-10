/* =========================================================
   东方逆转 · 运行时冒烟测试（tests/smoke-test.js）
   ---------------------------------------------------------
   运行方式（项目根目录，无构建工具，直接 node）：
     node tests/smoke-test.js        # 或 npm test
     MATCHES=5 DECKS=3 SEED=12345 node tests/smoke-test.js   # 环境变量可选
   依赖：jsdom（见根目录 package.json 的 devDependencies；npm install 安装）。
   环境变量：
     MATCHES  随机对局局数（默认 3）
     DECKS    随机构造的卡组套数（默认 2，最少 2 套才能覆盖浏览器选择流程）
     SEED     随机种子（默认取当前时间；失败时用同一 SEED 复现）
     COVERAGE_BIAS=0  关闭「优先打出本局没出过的卡」的覆盖率引导（默认开启）

   测试环境（jsdom 30）：
     - 以 http://touhou.local/ 为源加载根目录 index.html，并用 requestInterceptor 把
       该源下的请求映射到项目目录的本地文件 —— 这样 js/、data/、assets/ 下的脚本、
       样式与图片都正常加载，同时 localStorage 可用（file:// 是 opaque origin，
       jsdom 会禁用 localStorage，卡组持久化（v135）就没法测）。
     - beforeParse 里把 window.Math.random 换成种子化 PRNG：
       游戏内随机（抽卡/地形/翻牌先后/AI）与测试驱动随机全部由 SEED 决定，失败可复现。

   覆盖点：
     A 初始状态：第 1 回合 4 张手牌、赌注 1、地形无「圣地之巅」等残留；
     B 随机卡组：通过卡组设置页 UI 新建卡组 → 随机点 12 张互不相同的人物卡 →
       💾 保存 → 校验 localStorage 持久化与 listReadyDecks()；
     C 随机出战：主页面「开始对战」→ 选出战卡组弹窗 → 点选/确认 →
       Game.restart({playerDeckDefs}) 后起手牌必须全部来自所选卡组；
     D 随机打牌：每回合随机双倍/随机移动（射命丸文）/随机暗出多张到随机合法区域 →
       结束回合，逐回合校验以下不变量（发现异常即 FAIL 并给出细节）：
         · 能量账目：energyLeft === energyTotal − 本回合已出牌费用之和（含 0 费）
         · 手牌 DOM 数 === 数据层手牌数；手牌 ≤ 7；手牌 N/7 提示一致
         · 每区渲染的 mini-card 数 === 数据层该区张数（含大体积卡 occ 口径）
         · 区域总点数 = (Σ已翻开卡面战力 + 放满加成) × 地形倍率
         · 领先方着色（.lead）与点数一致（反转地形按低者胜口径）
         · 手牌不可用置灰 === （费用 > 剩余能量）；出牌阶段按钮可用性
         · 一次暗出 ≥2 张时：翻牌顺序必须等于放置顺序（保留仍在场者比较）
         · 能量框重置：取消不动盘面；确认后暗牌回手、手牌顺序还原、能量全额返还
     E 再来一局复用上一局卡组（lastPlayerDeckDefs）；认输流程；图鉴/放大流程。

   失败判据：任一显式断言失败、页面 console.error、window error、
             unhandledRejection、jsdomError 都计入失败（重复问题只打印一次、末尾汇总）。
   ========================================================= */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

/* ==================== 配置 ==================== */
const ROOT = path.resolve(__dirname, '..'); // 项目根目录（测试文件在 tests/ 下，资源按根目录相对路径解析）
const ORIGIN = 'http://touhou.local/';
const MATCHES = intEnv('MATCHES', 3);
const DECKS_TO_BUILD = Math.max(2, intEnv('DECKS', 2));
const SEED = process.env.SEED ? parseInt(process.env.SEED, 10) : (Date.now() % 2147483647);
const ZERO_COST_CHANCE = 0.25; // 随机卡组里塞入 0 费「稗田阿求」的概率（边界卡：0 费 + 终局离场）
const COVERAGE_BIAS = process.env.COVERAGE_BIAS !== '0'; // 出牌时优先挑本局没打出过的卡（提高机制覆盖率）

function intEnv(name, def) {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

/* ==================== 断言与结果记录 ==================== */
const failures = new Map(); // 问题 → 出现次数
let passes = 0;
const warnings = [];

function fail(msg) {
  const n = (failures.get(msg) || 0) + 1;
  failures.set(msg, n);
  if (n === 1) console.log('FAIL - ' + msg);
  else if (n === 2) console.log('       ↑ 同类问题后续静默计数');
}
function ok(cond, msg) {
  if (cond) { passes++; console.log('PASS - ' + msg); }
  else fail(msg);
  return !!cond;
}
function warn(msg) {
  if (warnings.indexOf(msg) >= 0) return;
  warnings.push(msg);
  console.log('WARN - ' + msg);
}

/* ==================== 环境（jsdom 30：http 源 + 本地文件拦截器）==================== */
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json', '.md': 'text/plain',
};
const localFileInterceptor = requestInterceptor((request) => {
  let url;
  try { url = new URL(request.url); } catch (e) { return undefined; }
  if (url.origin !== new URL(ORIGIN).origin) return undefined; // 站外请求：不拦截
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
  if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
  return new Response(fs.readFileSync(file), {
    headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' },
  });
});

// 种子化 PRNG（mulberry32）：注入页面，游戏与驱动共用同一条随机流
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ==================== 页面句柄与工具 ==================== */
let win = null;
let doc = null;
let seedRandom = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const byId = (id) => doc.getElementById(id);
const q = (sel) => Array.from(doc.querySelectorAll(sel));
const click = (el) => {
  if (!el) throw new Error('click: 元素不存在');
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
};
const hidden = (id) => {
  const el = byId(id);
  return !el || el.classList.contains('hidden');
};
const modalOpen = () => !hidden('modalMask');
const turnNum = () => parseInt(byId('turnVal').textContent, 10);
const dbg = () => win.Game._dbg();
const handEls = () => q('#hand .hand-card');
const colEls = () => q('.location');
const logEntries = () => q('.log .entry');
const sum = (a) => a.reduce((x, y) => x + y, 0);

// 驱动随机（共用页面随机流 → 全流程可复现）
const rnd = () => (seedRandom ? seedRandom() : Math.random());
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

async function waitFor(fn, desc, timeout = 45000) {
  const t0 = Date.now();
  while (true) {
    let v = false;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return true;
    if (Date.now() - t0 > timeout) throw new Error('等待超时：' + desc);
    await sleep(40);
  }
}

/* ==================== 卡牌 / 地形数据查询 ==================== */
function allPoolDefs() {
  const pool = (win.DS_CARDS && win.DS_CARDS.POOL) || {};
  const out = [];
  for (let c = 0; c <= 6; c++) for (const d of (pool[c] || [])) out.push(d);
  return out;
}
function allTokenDefs() {
  const sp = (win.DS_CARDS && win.DS_CARDS.SPECIAL) || {};
  return Object.keys(sp).map((k) => sp[k]);
}
const defByName = (n) => allPoolDefs().concat(allTokenDefs()).find((d) => d && d.n === n) || null;
const occOfName = (n) => (defByName(n) && defByName(n).occ) || 1;
function locDefById(id) {
  const pools = [].concat(win.DS_LOCATIONS.POOL || [], Object.keys(win.DS_LOCATIONS.EXTRA || {}).map((k) => win.DS_LOCATIONS.EXTRA[k]));
  return pools.find((d) => d && d.id === id) || null;
}
const deckNameSet = (deck) => new Set((deck.cards || []).map((d) => d.n));

/* ==================== 盘面读取（DOM 口径） ==================== */
// 一列的信息：地形、是否锁定、双方卡牌（名/实时战力/占格，暗牌无卡面 ⇒ 只有占格未知）
function colInfo(j) {
  const col = colEls()[j];
  const id = Array.from(col.classList).find((c) => c !== 'location' && c !== 'locked' && c !== 'hoverable' && c !== 'active-hover') || '';
  const def = locDefById(id) || { id, max: 4, dbl: 1 };
  const readSide = (sel) => Array.from(col.querySelectorAll(sel)).map((el) => {
    const pEl = el.querySelector('.p');
    const nameEl = el.querySelector('.mc-name');
    const name = nameEl ? nameEl.textContent : '';
    return {
      revealed: !!pEl,
      name,
      power: pEl ? parseInt(pEl.textContent, 10) : 0,
      occ: pEl ? occOfName(name) : 1,
    };
  });
  const my = readSide('.zone.mine .mini-card');
  const opp = readSide('.zone.opp .mini-card');
  return {
    col, def, j,
    locked: col.classList.contains('locked'),
    max: def.max || 4,
    my, opp,
    myUsed: sum(my.map((c) => c.occ)),
    oppUsed: sum(opp.map((c) => c.occ)),
    myHidden: my.some((c) => !c.revealed),
    myName: (col.querySelector('.loc-name') || {}).textContent || id,
    myTotalText: (col.querySelector('.my-total .lt-num') || {}).textContent,
    oppTotalText: (col.querySelector('.opp-total .lt-num') || {}).textContent,
  };
}
const zoneCounts = () => dbg().pZones;
const zoneTotalCards = () => sum(dbg().pZones);
function zoneIndexOfCard(cardId) {
  const cols = colEls();
  for (let j = 0; j < cols.length; j++) {
    if (cols[j].querySelector('.mini-card[data-cardid="' + cardId + '"]')) return j;
  }
  return -1;
}
function handNames() {
  return handEls().map((el) => (el.querySelector('.hc-name') || {}).textContent || '');
}
function affordableHand() {
  return handEls().map((el, index) => ({
    index,
    name: (el.querySelector('.hc-name') || {}).textContent || '',
    cost: parseInt((el.querySelector('.cost-orb') || {}).textContent, 10),
    afford: !el.classList.contains('unaffordable'),
  })).filter((c) => c.afford);
}

/* ==================== 逐回合不变量检查 ==================== */
function checkRenderInvariants(tag) {
  const d = dbg();
  const probs = [];

  // 1) 手牌：DOM 数 === 数据层数；≤ 7；N/7 提示一致；置灰口径 === 费用 > 剩余能量
  const domHand = handEls().length;
  if (domHand !== d.handP.length) probs.push(`手牌 DOM ${domHand} 张 ≠ 数据层 ${d.handP.length} 张`);
  if (d.handP.length > 7) probs.push(`手牌超过上限 7 张（${d.handP.length}）`);
  const hint = (byId('handCountVal') || {}).textContent;
  if (hint !== d.handP.length + '/7') probs.push(`手牌提示「${hint}」≠ 实际 ${d.handP.length}/7`);
  handEls().forEach((el, i) => {
    const cost = parseInt((el.querySelector('.cost-orb') || {}).textContent, 10);
    const dim = el.classList.contains('unaffordable');
    const shouldDim = !(cost <= d.energyLeft);
    // 终局（over）时手牌保持原色，是设计口径，不做置换灰判定
    if (d.phase === 'play' && dim !== shouldDim) {
      probs.push(`第 ${i + 1} 张手牌（${cost} 费）置灰=${dim} 与剩余能量 ${d.energyLeft} 不符`);
    }
  });

  // 2) 每区渲染卡数 === 数据层张数（大体积卡：1 张卡 → 1 个 mini-card）
  colEls().forEach((col, j) => {
    const mine = col.querySelectorAll('.zone.mine .mini-card').length;
    const opp = col.querySelectorAll('.zone.opp .mini-card').length;
    if (mine !== d.pZones[j]) probs.push(`第 ${j + 1} 列我方渲染 ${mine} 张 ≠ 数据层 ${d.pZones[j]} 张`);
    if (opp !== d.aZones[j]) probs.push(`第 ${j + 1} 列对手渲染 ${opp} 张 ≠ 数据层 ${d.aZones[j]} 张`);
  });

  // 3) 区域总点数 ===（Σ已翻开卡面战力 + 放满加成）× 地形倍率
  //    含暗牌且地形带 fill 时无法从 DOM 推出放满加成（暗牌看不到占格），跳过该区
  colEls().forEach((col, j) => {
    const info = colInfo(j);
    const dbl = info.def.dbl || 1;
    const check = (cards, used, text, label) => {
      if (info.def.fill && cards.some((c) => !c.revealed)) return; // 口径不可推
      let raw = sum(cards.map((c) => c.power));
      if (info.def.fill && used >= info.max) raw += info.def.fill;
      const expect = raw * dbl;
      if (text !== String(expect)) {
        probs.push(`${info.myName} 第 ${j + 1} 列${label}总点数显示 ${text} ≠ 由卡面推算 ${expect}` +
          `（卡面 [${cards.map((c) => (c.revealed ? c.name + ':' + c.power : '暗牌')).join(', ')}]，放满加成 ${info.def.fill || 0}，倍率 ${dbl}）`);
      }
    };
    check(info.my, info.myUsed, info.myTotalText, '我方');
    check(info.opp, info.oppUsed, info.oppTotalText, '对手');
  });

  // 4) 领先着色：谁有效点数高谁 .lead（反转地形取负值口径），平点双方都不亮
  colEls().forEach((col, j) => {
    const a = parseInt((col.querySelector('.opp-total .lt-num') || {}).textContent, 10);
    const p = parseInt((col.querySelector('.my-total .lt-num') || {}).textContent, 10);
    const inv = !!colInfo(j).def.inv;
    const eA = inv ? -a : a;
    const eP = inv ? -p : p;
    const aLead = col.querySelector('.opp-total').classList.contains('lead');
    const pLead = col.querySelector('.my-total').classList.contains('lead');
    if (aLead !== (eA > eP) || pLead !== (eP > eA)) {
      probs.push(`第 ${j + 1} 列领先着色不符（对手 ${a} : 我 ${p}${inv ? ' · 低者胜' : ''}）`);
    }
  });

  // 5) 能量与按钮状态
  if (d.energyLeft > d.energyTotal) probs.push(`剩余能量 ${d.energyLeft} > 本回合能量 ${d.energyTotal}`);
  if (d.energyLeft < 0) probs.push(`剩余能量为负：${d.energyLeft}`);
  const inPlay = d.phase === 'play';
  if (inPlay && byId('btnPass').disabled) probs.push('出牌阶段「结束回合」按钮却是禁用状态');
  if (!inPlay && !byId('btnPass').disabled) probs.push(`非出牌阶段（${d.phase}）「结束回合」按钮仍可点`);
  if (d.phase === 'over' && modalOpen() === false) probs.push('对局已结束但没有结算弹窗');

  // 6) 场上卡牌 id 唯一（同一张卡不能被两个格位重复渲染）+ 卡名必须是已知卡牌
  const ids = q('.zone .mini-card').map((el) => el.dataset.cardid);
  const dupIds = Array.from(new Set(ids.filter((v, i) => ids.indexOf(v) !== i)));
  if (dupIds.length) probs.push(`场上同一张卡被重复渲染（卡牌 id 重复）：${dupIds.join(',')}`);
  const unknown = [];
  for (const el of q('.zone .mini-card')) {
    const nameEl = el.querySelector('.mc-name');
    if (nameEl && !defByName(nameEl.textContent)) unknown.push(nameEl.textContent);
  }
  if (unknown.length) probs.push(`场上出现未知卡名（卡牌数据异常）：${Array.from(new Set(unknown)).join(',')}`);

  // 7) 侧栏对手信息：手牌张数显示与数据层一致
  const aiCount = (byId('aiCount') || {}).textContent;
  if (aiCount !== String(d.handA.length)) probs.push(`对手手牌数显示 ${aiCount} ≠ 数据层 ${d.handA.length}`);

  if (probs.length) fail(tag + ' 盘面不变量：' + probs.join(' ／ '));
  return probs.length === 0;
}

/* ==================== 阶段 A：初始状态 ==================== */
async function stageInit() {
  const d = dbg();
  ok(d.turn === 1, '开局回合 = 1');
  ok(byId('cubeVal').textContent === '1', '开局赌注 = 1');
  ok(handEls().length === 4, '第 1 回合手牌 4 张（开局 3 + 回合开始 1）');
  ok(q('.location').length === 3, '3 块地形列');
  ok(q('.location.weight').length === 0, '已移除的加权地形「圣地之巅」不再出现');
  ok(!!byId('btnRetreat') && !!byId('btnPass'), '角落按钮（认输/结束回合）存在');
  checkRenderInvariants('开局');
}

/* ==================== 阶段 B：随机卡组构造（走卡组设置页 UI） ==================== */
// 随机 12 张互不相同的人物卡：默认 1~6 费；有 ZERO_COST_CHANCE 概率换入 0 费「稗田阿求」
function randomDeckNames() {
  const names = shuffled(allPoolDefs().filter((d) => d.c >= 1)).slice(0, 12).map((d) => d.n);
  if (rnd() < ZERO_COST_CHANCE) names[Math.floor(rnd() * names.length)] = '稗田阿求';
  return names;
}

async function openDeckPage() {
  if (win.DeckBuilder.isOpen()) return;
  click(byId('homeBtnDeck'));
  await waitFor(() => win.DeckBuilder.isOpen(), '进入卡组设置页');
  await waitFor(() => q('#deckGrid .deck-pool-card').length > 0, '卡池渲染');
}

async function buildRandomDeck(seq) {
  await openDeckPage();
  const decksBefore = win.DeckBuilder.DECKS.length;
  const newSlot = q('#deckSlots .deck-slot.new .ds-main')[0];
  ok(!!newSlot, '卡组页存在「＋ 新建卡组」位');
  click(newSlot);
  await waitFor(() => win.DeckBuilder.DECKS.length === decksBefore + 1, '新建卡组');
  const deck = win.DeckBuilder.DECKS[win.DeckBuilder.DECKS.length - 1];

  // 进入编辑态：点卡组位（v129 起点卡组位直接进入修改）
  const slot = q('#deckSlots .deck-slot').find((el) => el.dataset.deckId === deck.id);
  ok(!!slot, '新卡组出现在卡组栏');
  click(slot.querySelector('.ds-main'));
  await waitFor(() => win.DeckBuilder.editingDeck() && win.DeckBuilder.editingDeck().id === deck.id, '进入卡组编辑态');
  ok(q('#deckSlots .deck-card-slot.empty').length === 12, '编辑态显示 12 个空卡槽');

  // 随机点选 12 张卡（左键 = 加入卡组）
  const want = randomDeckNames();
  const added = [];
  let clickMisses = 0;
  for (const name of want) {
    const el = q('#deckGrid .deck-pool-card').find((x) => (x.querySelector('.hc-name') || {}).textContent === name);
    if (!el) { clickMisses++; continue; }
    if (el.classList.contains('in-deck')) { added.push(name); continue; }
    click(el);
    const nowFilled = q('#deckSlots .deck-card-slot.filled').length;
    if (nowFilled === added.length + 1) added.push(name);
    else if (el.classList.contains('token-card')) fail('卡池里的衍生卡竟然可加入卡组：' + name);
    else clickMisses++;
  }
  ok(clickMisses === 0, `随机取卡全部命中卡池（未命中 ${clickMisses} 张）`);
  ok(q('#deckSlots .deck-card-slot.filled').length === 12, '卡槽放满 12 张');
  ok((byId('deckUsed') || {}).textContent === '12 / 12', '卡组栏计数显示 12 / 12');
  const dup = added.filter((n, i) => added.indexOf(n) !== i);
  ok(dup.length === 0, '卡组内无重名卡（同名限 1）');

  // 💾 保存 → 持久化
  click(byId('deckDoneBtn'));
  await waitFor(() => !win.DeckBuilder.editingDeck(), '保存并退出编辑态');

  const namesAdded = deck.cards.map((d) => d.n);
  console.log(`  · 随机卡组 ${seq}：${deck.name} = ${namesAdded.join('、')}`);
  ok(namesAdded.length === 12, `「${deck.name}」内存卡组 12 张`);
  ok(new Set(namesAdded).size === 12, `「${deck.name}」内存卡组无重名`);

  const raw = win.localStorage.getItem(win.DeckStorage.KEY);
  const saved = raw ? JSON.parse(raw) : null;
  const row = saved && saved.decks.find((d) => d.id === deck.id);
  ok(!!row, `「${deck.name}」已写入 localStorage`);
  if (row) {
    ok(row.cards.length === 12, `「${deck.name}」存档 12 张`);
    ok(new Set(row.cards).size === 12, `「${deck.name}」存档无重名`);
    const missing = namesAdded.filter((n) => row.cards.indexOf(n) < 0);
    ok(missing.length === 0, `「${deck.name}」存档内容与内存一致` + (missing.length ? `（缺 ${missing.join(',')}）` : ''));
  }
  const ready = win.DeckBuilder.listReadyDecks().find((d) => d.id === deck.id);
  ok(!!ready && ready.cards.length === 12, `「${deck.name}」进入出战可选卡组（listReadyDecks）`);
  return deck;
}

/* ==================== 阶段 C/D：随机出战 + 随机打牌 ==================== */
async function startBattleFromHome(deck) {
  if (!win.Home.isHome()) win.Home.show(); // 一局结束后回到主页面（结果弹窗暂无回主页入口，直接调公共入口）
  await waitFor(() => !hidden('homeScreen'), '主页面显示');
  const genBefore = dbg().gen;

  click(byId('homeBtnBattle'));
  await waitFor(() => !hidden('battleDeckMask'), '出战卡组选择弹窗打开');
  const items = q('#battleDeckList .battle-deck-item');
  ok(items.length >= 1, '出战弹窗列出可选卡组（' + items.length + ' 套）');
  const item = items.find((el) => (el.querySelector('.bd-name') || {}).textContent === deck.name);
  ok(!!item, `出战弹窗里有「${deck.name}」`);
  click(item || items[0]);
  await waitFor(() => !byId('battleDeckOk').disabled, '「开始战斗」按钮可点');
  click(byId('battleDeckOk'));

  await waitFor(
    () => dbg().gen > genBefore && dbg().phase === 'play' && turnNum() === 1 && handEls().length === 4,
    '选出战卡组后进入第 1 回合出牌阶段', 60000);
  ok(hidden('battleDeckMask') && hidden('homeScreen'), '开战后出战弹窗与主页面都关闭');
  assertHandFromDeck(deck, '开局');
}

function assertHandFromDeck(deck, tag) {
  const names = deckNameSet(deck);
  const outside = handNames().filter((n) => !names.has(n));
  ok(outside.length === 0, `${tag}：起手牌全部来自所选卡组「${deck.name}」` +
    (outside.length ? `（越界卡：${outside.join('、')}）` : ''));
}

// 点手牌（已是选中态则不重复点，避免 toggle 取消选择）
async function ensureSelected(cand) {
  const els = handEls();
  const cur = els.findIndex((el) => el.classList.contains('selected'));
  if (cur === cand.index) return true;
  const el = els[cand.index];
  if (!el) return false;
  if ((el.querySelector('.hc-name') || {}).textContent !== cand.name) return false;
  click(el);
  await sleep(40);
  const now = handEls()[cand.index];
  return !!now && now.classList.contains('selected');
}

// 该区域是否可能放下这张卡（未锁定 / 占格规则 / 还有空位）
function zoneAccepts(j, cand) {
  const info = colInfo(j);
  if (info.locked) return false;
  const occ = occOfName(cand.name);
  if (occ > 1 && info.max !== occ) return false; // 大体积卡只能进上限恰为占格数的区域
  return info.max - info.myUsed >= occ;
}

// 随机出一张牌：随机挑一张可用手牌 → 随机挑合法区域 → 直到张数真的增加
// 选牌顺序仍随机，但**优先挑本局尚未打出过的卡**（覆盖率引导；COVERAGE_BIAS=0 可关掉），
// 让每次运行的随机卡组尽可能把更多卡的效果跑一遍。
function orderedHandCandidates(ctx) {
  const cands = affordableHand();
  if (!COVERAGE_BIAS) return shuffled(cands);
  const fresh = cands.filter((c) => !ctx.stats.cards[c.name]);
  const seen = cands.filter((c) => ctx.stats.cards[c.name]);
  if (fresh.length && rnd() < 0.7) return shuffled(fresh).concat(shuffled(seen));
  return shuffled(cands);
}

async function tryPlayOneRandom(ctx) {
  const cands = orderedHandCandidates(ctx);
  for (const cand of cands) {
    if (!ctx.deckNames.has(cand.name)) fail(`打出的手牌不在所选卡组内：${cand.name}`);
    const zones = shuffled([0, 1, 2].filter((j) => zoneAccepts(j, cand)));
    for (const j of zones) {
      const before = zoneTotalCards();
      if (!(await ensureSelected(cand))) break; // 手牌已变（重新来一轮）
      click(colEls()[j]);
      await sleep(60);
      if (zoneTotalCards() > before) {
        ctx.spent += cand.cost;
        ctx.played.push({ name: cand.name, cost: cand.cost, zone: j });
        ctx.stats.plays++;
        ctx.stats.cards[cand.name] = (ctx.stats.cards[cand.name] || 0) + 1;
        return { name: cand.name, cost: cand.cost, zone: j };
      }
      // 未放下：保持在选中态继续试下一个区域
    }
  }
  return null;
}

async function endTurnAndWait(t, timeout = 90000) {
  click(byId('btnPass'));
  const t0 = Date.now();
  while (true) {
    if (modalOpen()) return 'modal';
    if (turnNum() !== t) return 'turn';
    if (Date.now() - t0 > timeout) throw new Error(`结束回合后等待推进超时（第 ${t} 回合）`);
    await sleep(50);
  }
}

// 翻牌顺序回归：一次暗出 ≥2 张时，翻牌日志顺序必须等于放置顺序（过滤已被效果移走、不翻牌者）
function verifyFlipOrder(playedNames, logMark, tag) {
  const flips = logEntries().slice(logMark)
    .filter((el) => el.classList.contains('p') && el.textContent.includes('翻牌'))
    .map((el) => (el.textContent.match(/「(.+?)」翻牌/) || [])[1])
    .filter(Boolean);
  const seq = playedNames.filter((n) => flips.indexOf(n) >= 0);
  if (flips.length === 0) { warn(`${tag}：本回合玩家没有翻牌日志（暗牌可能被效果移走），跳过顺序校验`); return; }
  ok(seq.join('|') === flips.join('|'),
    `${tag}：翻牌顺序 = 放置顺序（放置 ${playedNames.join('、')} ／ 翻牌 ${flips.join('、')}）`);
}

// 能量框重置回归：取消不动盘面；确认后暗牌回手 / 手牌顺序还原 / 能量全额返还
async function tryResetRegression(ctx, t) {
  if (dbg().pMoves !== 0) return false; // 只在回合刚开始、还没暗出牌时做
  if (affordableHand().length === 0) return false;
  const handBefore = handNames();
  const zonesBefore = zoneTotalCards();
  const energyBefore = dbg().energyLeft;
  const played = await tryPlayOneRandom(ctx);
  if (!played) { ctx.played.length = 0; return false; } // 没有能落下的牌，下回合再试

  click(byId('energyBox'));
  await waitFor(() => !hidden('undoMask'), '重置弹窗打开');
  const cancelBtn = q('#undoMask .btn').find((b) => !b.classList.contains('btn-primary'));
  click(cancelBtn);
  await waitFor(() => hidden('undoMask'), '重置弹窗取消关闭');
  ok(dbg().pMoves === 1 && zoneTotalCards() === zonesBefore + 1, '重置弹窗「取消」后暗牌与能量保持不动');

  click(byId('energyBox'));
  await waitFor(() => !hidden('undoMask'), '重置弹窗再次打开');
  click(q('#undoMask .btn-primary')[0]);
  await waitFor(() => hidden('undoMask'), '重置弹窗确认关闭');
  const after = dbg();
  ok(after.pMoves === 0, '确认重置后本回合暗出记录清零');
  ok(zoneTotalCards() === zonesBefore, '确认重置后场上暗牌回到手牌');
  ok(after.energyLeft === energyBefore, `确认重置后能量全额返还（${after.energyLeft}/${energyBefore}）`);
  ok(handNames().join('|') === handBefore.join('|'), '确认重置后手牌顺序恢复原样');
  ctx.spent = 0;
  ctx.played.length = 0;
  ctx.stats.resets++;
  console.log(`  · 第 ${t} 回合完成「能量重置」回归：暗出「${played.name}」→ 取消/确认双向校验通过`);
  return true;
}

// 随机移动（射命丸文 fly）：点己方已翻开可移动卡 → 点另一个可用区域
async function tryFlyMove(ctx) {
  if (dbg().phase !== 'play') return false;
  const flyEl = q('.zone.mine .mini-card.can-fly')[0];
  if (!flyEl) return false;
  const cardId = flyEl.dataset.cardid;
  const from = zoneIndexOfCard(cardId);
  click(flyEl);
  await sleep(60);
  if (!q('.zone.mine .mini-card[data-cardid="' + cardId + '"].fly-moving')[0]) return false;
  const targets = shuffled([0, 1, 2].filter((j) => j !== from && zoneAccepts(j, { name: '石块' }))); // 占格 1 的通用占用判定
  for (const j of targets) {
    click(colEls()[j]);
    await sleep(70);
    if (zoneIndexOfCard(cardId) === j) {
      ctx.stats.flyMoves++;
      ok(!q('.zone.mine .mini-card[data-cardid="' + cardId + '"].can-fly').length,
        '移动后该卡本回合不再可移动（每回合一次）');
      console.log(`  · 「射命丸文」从第 ${from + 1} 列移动到第 ${j + 1} 列`);
      return true;
    }
  }
  return false;
}

async function playTurnRandom(t, ctx) {
  ctx.stats.turns++;
  checkRenderInvariants(`第 ${t} 回合开始`);
  const d0 = dbg();
  if (d0.energyLeft !== d0.energyTotal) {
    fail(`第 ${t} 回合开始时能量不是满格：${d0.energyLeft}/${d0.energyTotal}`);
  }
  const startLogs = logEntries().length;

  // 1) 机会性回归：能量重置（每局只做一次，尽量早）
  if (ctx.wantReset) {
    ctx.wantReset = !(await tryResetRegression(ctx, t));
  }
  // 2) 随机双倍下注
  if (t >= 2 && !byId('btnSnap').disabled && rnd() < 0.25) {
    click(byId('btnSnap'));
    ctx.stats.snaps++;
    await sleep(80);
  }
  // 3) 机会性随机移动
  if (rnd() < 0.25) await tryFlyMove(ctx);

  // 4) 随机暗出：直到没有可用手牌 / 随机提前收手 / 一张也放不下
  let safety = 0;
  while (true) {
    if (++safety > 24) { fail(`第 ${t} 回合出牌循环超过 24 次（疑似能量/手牌状态异常）`); break; }
    if (affordableHand().length === 0) break;
    if (ctx.played.length > 0 && rnd() < 0.12) break; // 少量概率提前收手，制造「有余能量也结束」的局面
    const before = ctx.played.length;
    const played = await tryPlayOneRandom(ctx);
    if (!played) break;
    // 能量账目：energyLeft 必须等于 能量上限 − 本回合已出牌费用之和
    const expect = dbg().energyTotal - ctx.spent;
    if (dbg().energyLeft !== expect) {
      fail(`第 ${t} 回合能量账目不符：已出 ${ctx.played.length} 张（${ctx.played.map((p) => p.name + p.cost).join('+')}）` +
        `应为 ${expect}，实际 ${dbg().energyLeft}`);
    }
    if (dbg().phase !== 'play' && ctx.played.length < 12) {
      fail(`第 ${t} 回合出牌后阶段变为「${dbg().phase}」（未结束回合却离开出牌阶段）`);
      break;
    }
    if (before + 1 !== ctx.played.length) fail('出牌记录与实际不符');
  }
  console.log(`  · 第 ${t} 回合：暗出 ${ctx.played.length} 张` +
    (ctx.played.length ? `（${ctx.played.map((p) => `${p.name}→${colInfo(p.zone).myName}`).join('，')}）` : '（跳过）') +
    ` · 能量 ${dbg().energyTotal}→${dbg().energyLeft} · 赌注 ${byId('cubeVal').textContent}`);

  // 5) 结束回合并等推进
  const mark = logEntries().length;
  const res = await endTurnAndWait(t);
  // 6) 一次暗出 ≥2 张 → 校验翻牌顺序等于放置顺序
  if (ctx.played.length >= 2) {
    ctx.stats.multiPlayTurns++;
    verifyFlipOrder(ctx.played.map((p) => p.name), mark, `第 ${t} 回合`);
  }
  // 7) 房间末日志/盘面
  if (res === 'turn') {
    checkRenderInvariants(`第 ${t} 回合结算后`);
    // 场上的己方卡数不能被结算过程凭空增加（除暗出外只能被效果生成/摧毁，故只记录不硬判）
    const nowZones = zoneCounts();
    if (nowZones.some((n) => n < 0) || nowZones.some((n) => n > 4)) {
      fail(`第 ${t} 回合结算后某区卡数越界：[${nowZones.join(',')}]`);
    }
    if (logEntries().length <= startLogs) fail(`第 ${t} 回合没有任何日志增加`);
  }
  return res;
}

async function playMatch(seq, deck) {
  const ctx = {
    deck,
    deckNames: deckNameSet(deck),
    stats: stats,
    spent: 0,
    played: [],
    wantReset: true,
  };
  ok(dbg().phase === 'play' && turnNum() === 1, `第 ${seq} 局开始于第 1 回合出牌阶段`);
  console.log(`第 ${seq} 局开始 · 卡组「${deck.name}」（${deck.cards.length} 张）`);

  let res = 'turn';
  let guard = 0;
  while (!modalOpen()) {
    if (++guard > 40) { dumpDiagnostics('对局回合数超过 40'); throw new Error('对局回合数异常'); }
    if (dbg().phase !== 'play') { await sleep(60); continue; }
    ctx.spent = 0;
    ctx.played = [];
    res = await playTurnRandom(turnNum(), ctx);
    if (res === 'modal') break;
  }
  void res;
  stats.matches++;

  // 终局校验
  checkRenderInvariants(`第 ${seq} 局终局盘面`);
  const title = byId('modalTitle').textContent;
  ok(['你赢了！', '你输了…', '平局'].indexOf(title) >= 0, `第 ${seq} 局结算标题合法：「${title}」`);
  const logText = byId('log').textContent;
  ok(logText.includes('翻牌'), `第 ${seq} 局存在翻牌结算`);
  ok(logText.includes('终局'), `第 ${seq} 局走到终局结算`);
  const stakes = parseInt(byId('cubeVal').textContent, 10);
  const cubes = byId('modalCubes').textContent;
  const m = /([+-]?\d+)/.exec(cubes);
  if (title === '平局') ok(cubes.includes('无立方变动'), `第 ${seq} 局平局无立方变动`);
  else ok(!!m && Math.abs(parseInt(m[1], 10)) === stakes, `第 ${seq} 局立方变动 ${cubes} 与赌注 ${stakes} 一致`);
  console.log(`第 ${seq} 局结束 · ${title} · ${cubes} · 暗出合计 ${Object.values(stats.cards).reduce((a, b) => a + b, 0)} 张（累计）`);
  return title;
}

/* ==================== 阶段 E：图鉴 / 放大 / 认输 ==================== */
async function stageUiFlows() {
  // 图鉴数量与数据源一致（不再硬编码张数）
  const poolCount = allPoolDefs().length;
  click(byId('btnCodex'));
  await waitFor(() => !hidden('codexMask'), '图鉴打开');
  ok(q('#codexGrid .codex-card').length === poolCount, `图鉴卡数 = 卡池人物卡数（${poolCount}）`);
  ok((byId('codexCount').textContent || '').includes(poolCount + ' 种'), '图鉴计数文案与卡池一致');
  click(q('#codexGrid .codex-card')[0]);
  await waitFor(() => !hidden('zoomMask'), '图鉴放大打开');
  ok(q('#zoomCardSlot .zoom-card').length === 1, '放大视图渲染出 1 张卡');
  ok(/费用 \d+/.test(byId('zoomInfo').textContent), '放大信息含费用');
  ok(/威力 -?\d+/.test(byId('zoomInfo').textContent), '放大信息含威力');
  click(q('#zoomMask .zoom-stage .btn').find((b) => /返回/.test(b.textContent)) || q('#zoomMask .zoom-stage .btn')[0]);
  await waitFor(() => hidden('zoomMask'), '放大关闭回到图鉴');
  click(byId('btnCodex'));
  await waitFor(() => hidden('codexMask'), '图鉴关闭');

  // 场上已翻开卡牌 → 点击放大（显示受修正后的场上威力）
  const insp = q('.zone .mini-card.can-inspect');
  ok(insp.length >= 1, `场上已翻开可点击卡牌（${insp.length} 张）`);
  if (insp.length) {
    ok(hidden('zoomMask'), '点击场上卡之前放大弹窗处于关闭状态');
    const cardName = (insp[0].querySelector('.mc-name') || {}).textContent || '(暗牌)';
    const shownPower = (insp[0].querySelector('.p') || {}).textContent;
    click(insp[0]);
    await waitFor(() => !hidden('zoomMask'), '场上卡放大打开');
    const info = (byId('zoomInfo').textContent || '').replace(/\s+/g, ' ').trim();
    ok(/场上威力 -?\d+/.test(info),
      `场上放大显示实时威力（点「${cardName}」，卡面威力 ${shownPower}，详情区实际：「${info.slice(0, 140)}」）`);
    ok(/场上修正|基础威力/.test(byId('zoomInfo').textContent), '场上放大显示修正信息');
    click(q('#zoomMask .zoom-stage .btn').find((b) => /返回/.test(b.textContent)) || q('#zoomMask .zoom-stage .btn')[0]);
    await waitFor(() => hidden('zoomMask'), '场上卡放大关闭');
  }

  // 认输流程（重新开一局，沿用同一套卡组）
  const genBefore = dbg().gen;
  click(byId('btnAgain'));
  await waitFor(() => dbg().gen > genBefore && dbg().phase === 'play' && handEls().length === 4, '再来一局进入出牌阶段', 60000);
  ok(true, '「再来一局」复用同一套卡组并正常开局');
  click(byId('btnRetreat'));
  await waitFor(() => modalOpen(), '认输弹窗');
  ok(byId('modalTitle').textContent.includes('认输'), '认输标题正确：' + byId('modalTitle').textContent);
  ok(/-\d/.test(byId('modalCubes').textContent), '认输扣除立方：' + byId('modalCubes').textContent);
  const gen2 = dbg().gen;
  click(byId('btnAgain'));
  await waitFor(() => dbg().gen > gen2 && dbg().phase === 'play' && handEls().length === 4, '认输后再来一局', 60000);
  ok(true, '认输后可重新开始');
}

/* ==================== 诊断 ==================== */
function dumpDiagnostics(label) {
  console.log('---------- 诊断（' + label + '）----------');
  try {
    console.log('status =', byId('statusText').textContent);
    console.log('buttons: pass.disabled=' + byId('btnPass').disabled + ' snap.disabled=' + byId('btnSnap').disabled +
      ' retreat.disabled=' + byId('btnRetreat').disabled + ' turn=' + byId('turnVal').textContent);
    console.log('hand =', handEls().length, 'logs =', logEntries().length, 'modal=' + modalOpen());
    console.log('dbg =', JSON.stringify(dbg()));
    colEls().forEach((col, j) => {
      const info = colInfo(j);
      console.log(`  列${j + 1} ${info.myName} 我方[${info.my.map((c) => c.name + (c.revealed ? ':' + c.power : ':暗')).join(',')}]` +
        ` 对手[${info.opp.map((c) => c.name + (c.revealed ? ':' + c.power : ':暗')).join(',')}]`);
    });
    console.log('最近日志：');
    for (const el of logEntries().slice(-25)) console.log('   ' + el.textContent);
  } catch (e) {
    console.log('诊断输出失败：', e && e.message);
  }
  console.log('--------------------------------------');
}

/* ==================== 统计 ==================== */
const stats = {
  decks: 0, matches: 0, turns: 0, plays: 0, snaps: 0, resets: 0, flyMoves: 0,
  multiPlayTurns: 0, cards: {},
};

/* ==================== 主流程 ==================== */
(async () => {
  console.log(`=== 东方逆转 冒烟测试 · SEED=${SEED} · MATCHES=${MATCHES} · DECKS=${DECKS_TO_BUILD} ===`);

  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    const msg = (e && e.message) || String(e);
    if (/Could not load img|Could not parse CSS/i.test(msg)) { warn('jsdom 资源告警：' + msg); return; }
    console.error('JSDOM ERROR:', msg);
    if (e && e.detail && e.detail.stack) console.error(e.detail.stack.split('\n').slice(0, 6).join('\n'));
    fail('jsdom error: ' + msg);
  });
  vc.on('error', (...a) => {
    const msg = a.map((x) => (x && x.stack) || String(x)).join(' ');
    fail('页面 console.error: ' + msg.split('\n').slice(0, 3).join(' | '));
  });
  vc.on('warn', (...a) => warn('页面 console.warn: ' + a.map(String).join(' ')));

  const prng = mulberry32(SEED);
  seedRandom = prng;
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    url: ORIGIN + 'index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: { interceptors: [localFileInterceptor] },
    beforeParse(window) { window.Math.random = prng; }, // 页面内随机也走种子流
  });
  win = dom.window;
  doc = win.document;
  win.addEventListener('error', (e) => fail('window error: ' + e.message));
  process.on('unhandledRejection', (r) => {
    fail('unhandled rejection: ' + ((r && (r.stack || r.message)) || r));
  });

  const watchdog = setTimeout(() => {
    dumpDiagnostics('整体超时');
    console.error('整体运行超时（>12 分钟）');
    finalize(1);
  }, 12 * 60 * 1000);

  try {
    // 等首局初始化到第 1 回合出牌阶段（开局演出 3 张 + 回合 1 抽 1 张 = 4 张手牌）
    await waitFor(() => win.Game && win.Game._els && colEls().length === 3 && dbg().phase === 'play' && handEls().length === 4,
      '游戏初始化到第 1 回合出牌阶段', 30000);
    ok(true, '页面脚本加载并初始化完成');

    await stageInit();

    // B 随机构造卡组
    const decks = [];
    for (let i = 0; i < DECKS_TO_BUILD; i++) decks.push(await buildRandomDeck(i + 1));
    stats.decks = decks.length;
    ok(win.DeckBuilder.listReadyDecks().length >= decks.length, '出战可选卡组数量与已构造卡组一致');

    // C+D 随机出战 + 随机打牌
    let currentDeck = decks[0];
    await startBattleFromHome(currentDeck);
    for (let m = 1; m <= MATCHES; m++) {
      if (m > 1) {
        if (m % 2 === 1) {
          // 隔局回主页面、换一套随机卡组重新开战
          const next = pick(decks);
          await startBattleFromHome(next);
          currentDeck = next;
          assertHandFromDeck(currentDeck, `第 ${m} 局换卡组`);
        } else {
          // 偶数局走「再来一局」：restart() 无参 → 必须复用上一局自建卡组
          const genBefore = dbg().gen;
          click(byId('btnAgain'));
          await waitFor(() => dbg().gen > genBefore && dbg().phase === 'play' && handEls().length === 4,
            `第 ${m} 局「再来一局」进入出牌阶段`, 60000);
          assertHandFromDeck(currentDeck, `第 ${m} 局复用卡组`);
        }
      }
      await playMatch(m, currentDeck);
    }

    // E 图鉴 / 放大 / 认输
    await stageUiFlows();

    clearTimeout(watchdog);
    finalize(0);
  } catch (e) {
    clearTimeout(watchdog);
    console.error('SMOKE CRASH:', (e && e.stack) || e);
    dumpDiagnostics('崩溃点');
    fail('测试驱动异常：' + ((e && e.message) || e));
    finalize(1);
  }
})();

function finalize(code) {
  console.log('\n================ 覆盖统计 ================');
  console.log(`随机卡组 ${stats.decks} 套 · 对局 ${stats.matches} 局 · 回合 ${stats.turns} 个 · 暗出 ${stats.plays} 张` +
    ` · 多张同回合 ${stats.multiPlayTurns} 次 · 双倍 ${stats.snaps} 次 · 重置回归 ${stats.resets} 次 · 移动 ${stats.flyMoves} 次`);
  const played = Object.keys(stats.cards).sort((a, b) => stats.cards[b] - stats.cards[a]);
  const poolNames = new Set(allPoolDefs().map((d) => d.n));
  const covered = played.filter((n) => poolNames.has(n));
  console.log(`本局实际打出过的人物卡 ${covered.length} 种：` + covered.map((n) => n + '×' + stats.cards[n]).join('、'));
  const zeroCost = poolNames.size && covered.length ? [...poolNames].filter((n) => !stats.cards[n]) : [];
  console.log(`未被打出过的人物卡 ${zeroCost.length} 种：` + (zeroCost.join('、') || '（无）'));
  if (warnings.length) {
    console.log('\n---------------- 警告 ----------------');
    for (const w of warnings) console.log('WARN - ' + w);
  }
  console.log('\n================ 结果 ================');
  if (failures.size === 0) {
    console.log(`ALL SMOKE TESTS PASSED（断言通过 ${passes} 项）`);
  } else {
    let i = 0;
    for (const [msg, n] of failures) console.log(`FAIL[${++i}] ×${n} - ${msg}`);
    console.log(`FAILURES: ${failures.size} 类问题（断言通过 ${passes} 项）`);
  }
  process.exit(code === 0 && failures.size === 0 ? 0 : 1);
}
