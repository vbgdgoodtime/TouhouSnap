/* 运行时冒烟测试：jsdom 加载 demo，随机策略连打数局 + 图鉴/放大/认输流程 */
'use strict';
const path = require('path');
const { VirtualConsole, JSDOM } = require('jsdom');

const FILE = path.resolve(__dirname, 'index.html');
const MATCHES = parseInt(process.env.MATCHES || '3', 10);
const failures = [];
process.on('unhandledRejection', (r) => {
  console.error('UNHANDLED REJECTION:', r && (r.stack || r.message || r));
  failures.push('unhandled rejection: ' + (r && r.message));
});
const ok = (cond, msg) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg);
  if (!cond) failures.push(msg);
};

(async () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => {
    console.error('JSDOM ERROR:', e && e.message);
    if (e && e.detail && e.detail.stack) console.error(e.detail.stack.split('\n').slice(0, 6).join('\n'));
    failures.push('jsdom error: ' + (e && e.message));
  });
  vc.on('error', (...a) => console.error('console.error:', ...a));
  const dom = await JSDOM.fromFile(FILE, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  const { window } = dom;
  const { document } = window;
  window.addEventListener('error', (e) => {
    console.error('WINDOW ERROR:', e.message);
    failures.push('window error: ' + e.message);
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const byId = (id) => document.getElementById(id);
  const waitFor = async (fn, desc, timeout = 30000) => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > timeout) throw new Error('timeout: ' + desc);
      await sleep(40);
    }
  };
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  const q = (s) => [...document.querySelectorAll(s)];
  const handCards = () => q('#hand .hand-card');
  const rand = (n) => Math.floor(Math.random() * n);
  const shuffleArr = (a) => [...a].sort(() => Math.random() - 0.5);
  const dbg = () => window.Game._dbg();
  const pZoneCount = (d) => d.pZones.reduce((a, b) => a + b, 0);
  // 等回合推进（或终局弹窗）
  const waitTurnChange = async (prevTurn, timeoutMs = 45000) => {
    const t0 = Date.now();
    while (true) {
      const nowT = parseInt(byId('turnVal').textContent, 10);
      if (!byId('modalMask').classList.contains('hidden') || nowT !== prevTurn) return;
      if (Date.now() - t0 > timeoutMs) throw new Error('turn advance timeout');
      await sleep(80);
    }
  };
  let multiPlays = 0;   // 「一次结束出牌 ≥2 张」累计次数

  await waitFor(() => window.Game && window.Game._els && q('.location').length === 3, 'init');
  ok(true, 'init ok');
  ok(handCards().length === 3, 'initial hand 3');
  ok(byId('cubeVal').textContent === '1', 'initial stake 1');
  ok(handCards().some((el) => el.querySelector('.cost-orb').textContent === '1'), 'opening hand contains a 1-cost card');
  ok(q('.location.weight').length === 0, 'weighted location (圣地之巅) removed');

  // ---- 重置本回合暗牌：能量框 → 确认/取消 ----
  const baseNames = handCards().map((el) => el.querySelector('.hc-name').textContent);
  const playOneCard = async () => {
    const idx = handCards().findIndex((el) => el.querySelector('.cost-orb').textContent === '1');
    click(handCards()[idx]);
    await sleep(60);
    click(q('.location')[0]);
    await sleep(80);
    ok(dbg().pMoves === 1, 'played 1 hidden card');
  };
  await playOneCard();
  // 暗牌不计入区域总点数（牌已暗出，但该区己方总点数仍为 0）
  const col0MyTotal = q('.location')[0].querySelector('.my-total .lt-num').textContent;
  ok(col0MyTotal === '0', 'hidden card power not counted into zone total yet');
  click(byId('energyBox'));
  await waitFor(() => !byId('undoMask').classList.contains('hidden'), 'undo dialog open');
  ok(true, 'energy box opens reset dialog');
  // 先试取消：不应撤销
  click(q('.undo-modal .btn')[0]); // 取消
  await waitFor(() => byId('undoMask').classList.contains('hidden'), 'undo dialog cancel');
  ok(dbg().pMoves === 1 && dbg().pZones.reduce((a, b) => a + b, 0) === 1, 'cancel keeps cards placed');
  // 再确认：暗牌返回、能量返还
  click(byId('energyBox'));
  await waitFor(() => !byId('undoMask').classList.contains('hidden'), 'undo dialog reopen');
  click(q('.undo-modal .btn-primary')[0]); // 确认重置
  await waitFor(() => byId('undoMask').classList.contains('hidden'), 'undo dialog confirm');
  ok(dbg().pMoves === 0, 'reset clears this-turn moves');
  ok(dbg().pZones.reduce((a, b) => a + b, 0) === 0, 'reset removes cards from board');
  ok(handCards().length === 3, 'reset returns cards to hand');
  ok(dbg().energyLeft === dbg().energyTotal, 'reset refunds energy');
  const restoredNames = handCards().map((el) => el.querySelector('.hc-name').textContent);
  ok(restoredNames.join('|') === baseNames.join('|'), 'hand order restored as before');

  // 角落按钮仍在（认输左下 / 结束回合右下 由 CSS 定位）
  ok(!!byId('btnRetreat') && !!byId('btnPass'), 'corner buttons present');

  // ---- 回归：同一回合暗出 2 张牌 → 翻牌顺序必须等于放置顺序（偶数回合也不得倒序）----
  // 前 3 回合跳过，第 4 回合（偶数、能量 4）必然手握 ≥2 张 ≤2 费牌可双出
  for (let p = 1; p <= 3; p++) {
    await waitFor(() => !byId('btnPass').disabled && parseInt(byId('turnVal').textContent, 10) === p, 'pass phase turn ' + p);
    click(byId('btnPass'));
    await sleep(120);
    await waitTurnChange(p);
  }
  await waitFor(() => !byId('btnPass').disabled && parseInt(byId('turnVal').textContent, 10) === 4, 'turn4 play phase');
  const cheapCount = handCards().filter((el) => parseInt(el.querySelector('.cost-orb').textContent, 10) <= 2).length;
  ok(cheapCount >= 2, 'turn4 has two cheap affordable cards (' + cheapCount + ')');
  const playOrder = [];
  for (let k = 0; k < 2; k++) {
    const el = handCards().find((h) => parseInt(h.querySelector('.cost-orb').textContent, 10) <= 2);
    ok(!!el, 'dual play: cheap card ' + (k + 1) + ' found');
    playOrder.push(el.querySelector('.hc-name').textContent);
    click(el);
    await sleep(70);
    click(q('.location')[k]);
    await sleep(90);
    ok(dbg().pMoves === k + 1, 'dual play step ' + (k + 1) + ' placed');
  }
  const t0 = q('.location')[0].querySelector('.my-total .lt-num').textContent;
  const t1 = q('.location')[1].querySelector('.my-total .lt-num').textContent;
  ok(t0 === '0' && t1 === '0', 'dual hidden cards add no zone points yet');
  const markIdx = q('.log .entry').length;
  click(byId('btnPass'));
  await sleep(120);
  await waitTurnChange(4);
  const pFlips = q('.log .entry').slice(markIdx)
    .filter((el) => el.classList.contains('p') && el.textContent.includes('翻牌'))
    .map((el) => (el.textContent.match(/「(.+?)」翻牌/) || [])[1]);
  // 保留仍在场的卡做保序比较（被“摧毁”效果移走的暗牌不会翻牌，不算失败）
  const seq = playOrder.filter((n) => pFlips.includes(n));
  ok(seq.length > 0, 'dual reveal produced player flip logs (' + pFlips.join(',') + ')');
  ok(seq.join('|') === pFlips.join('|'),
    'dual reveal order equals placement order: ' + pFlips.join(',') + ' vs ' + seq.join(','));

  for (let m = 1; m <= MATCHES; m++) {
    const logBefore = q('.log .entry').length;
    let guard = 0;
    while (true) {
      if (++guard > 900) {
        console.error('STALL status=' + byId('statusText').textContent);
        console.error('buttons snap=' + byId('btnSnap').disabled + ' pass=' + byId('btnPass').disabled + ' retreat=' + byId('btnRetreat').disabled);
        console.error('hand=' + handCards().length + ' logs=' + q('.log .entry').length);
        console.error('dbg=' + JSON.stringify(dbg()));
        throw new Error('round loop over limit');
      }
      if (!byId('modalMask').classList.contains('hidden')) break;
      const turn = parseInt(byId('turnVal').textContent, 10);
      const phasePlay = !byId('btnPass').disabled;
      if (!phasePlay) { await sleep(120); continue; }

      // 随机双倍
      if (turn >= 2 && Math.random() < 0.25 && !byId('btnSnap').disabled) { click(byId('btnSnap')); await sleep(120); }

      const afford = handCards().filter((el) => !el.classList.contains('unaffordable'));
      // 无牌可出或（少量概率）提前收手 → 结束本回合出牌
      if (afford.length === 0 || Math.random() < 0.1) {
        click(byId('btnPass'));
        await sleep(100);
        await waitTurnChange(turn);
        continue;
      }
      // 暗出一张牌到随机合法区域
      click(afford[rand(afford.length)]);
      await sleep(60);
      const sum0 = pZoneCount(dbg());
      let placed = false;
      for (const col of shuffleArr(q('.location'))) {
        const n = col.querySelectorAll('.zone.mine .mini-card').length;
        const maxTag = col.className.includes('slot2') ? 2 : 4;
        if (n >= maxTag) continue;
        click(col);
        await sleep(70);
        if (pZoneCount(dbg()) > sum0) { placed = true; break; }
      }
      if (!placed) { await sleep(120); continue; } // 未能打出则重试

      const after = dbg();
      if (after.energyLeft > 0) {
        // 回归断言：出完第一张且仍有能量时，回合绝不能自动结束
        ok(after.phase === 'play', 'after 1st card w/ energy left, still in play phase (turn ' + turn + ')');
        ok(!byId('btnPass').disabled, 'after 1st card w/ energy left, end button available');
        ok(byId('btnPass').textContent.includes('结束回合'), 'button now says End Turn (turn ' + turn + ')');
      }
      // 继续循环：能量足够时同一回合还能再出牌
    }

    const title = byId('modalTitle').textContent;
    ok(['你赢了！', '你输了…', '平局'].includes(title), 'match ' + m + ' result: ' + title + ' / ' + byId('modalCubes').textContent);
    const logText = byId('log').textContent;
    ok(logText.includes('翻牌'), 'match ' + m + ' had reveals');
    ok(logText.includes('终局'), 'match ' + m + ' reached finish');
    ok(q('.log .entry').length > logBefore, 'match ' + m + ' logs grew');
    ok(logText.includes('结束出牌'), 'match ' + m + ' player ended a turn with cards');
    const sums = logText.match(/共暗出 (\d+) 张/g) || [];
    for (const s of sums) {
      const n = parseInt(s.match(/\d+/)[0], 10);
      if (n >= 2) multiPlays++;
    }
    if (m < MATCHES) {
      click(byId('btnAgain'));
      await waitFor(() => handCards().length === 3, 'rematch ' + (m + 1));
    }
  }
  ok(multiPlays >= 1, 'multi-card plays happened across matches (count=' + multiPlays + ')');

  // 区域总点数着色：谁领先谁 .lead（亮黄），平点则双方都不亮
  for (const col of q('.location')) {
    const pA = col.querySelector('.opp-total');
    const pP = col.querySelector('.my-total');
    const a = parseInt(pA.querySelector('.lt-num').textContent, 10);
    const p = parseInt(pP.querySelector('.lt-num').textContent, 10);
    const aLead = pA.classList.contains('lead');
    const pLead = pP.classList.contains('lead');
    ok(aLead === (a > p) && pLead === (p > a),
      'zone ' + col.querySelector('.loc-name').textContent.trim() + ' pill colors match (' + a + ':' + p + ')');
  }

  // codex flow
  click(byId('btnCodex'));
  await waitFor(() => !byId('codexMask').classList.contains('hidden'), 'codex open');
  ok(q('#codexGrid .codex-card').length === 24, 'codex 24 cards: ' + q('#codexGrid .codex-card').length);
  ok(/共 24 种/.test(byId('codexCount').textContent), 'codex count text');
  click(q('#codexGrid .codex-card')[0]);
  await waitFor(() => !byId('zoomMask').classList.contains('hidden'), 'zoom open');
  ok(q('#zoomCardSlot .zoom-card').length === 1, 'zoom card rendered');
  ok(/费用 \d+/.test(byId('zoomInfo').textContent), 'zoom info has cost');
  ok(/威力 \d+/.test(byId('zoomInfo').textContent), 'zoom info has power');
  click(document.querySelector('.zoom-stage .btn'));
  await waitFor(() => byId('zoomMask').classList.contains('hidden'), 'zoom close');
  ok(true, 'back to codex ok');
  click(byId('btnCodex'));
  await waitFor(() => byId('codexMask').classList.contains('hidden'), 'codex close');
  ok(true, 'codex toggle ok');

  // 场上已翻开的牌 → 点击放大（显示受修正后的场上威力）
  const insp = q('.zone .mini-card.can-inspect');
  ok(insp.length >= 1, 'revealed board cards clickable (' + insp.length + ' found)');
  click(insp[0]);
  await waitFor(() => !byId('zoomMask').classList.contains('hidden'), 'field zoom open');
  ok(/场上威力 \d+/.test(byId('zoomInfo').textContent), 'field zoom shows live power');
  ok(/场上修正|基础威力/.test(byId('zoomInfo').textContent), 'field zoom shows correction info');
  click(document.querySelector('.zoom-stage .btn')); // 关闭
  await waitFor(() => byId('zoomMask').classList.contains('hidden'), 'field zoom close');
  ok(true, 'field card zoom works');

  // retreat flow
  click(byId('btnAgain'));
  await waitFor(() => handCards().length === 3 && !byId('btnPass').disabled, 'new game');
  click(byId('btnRetreat'));
  await waitFor(() => !byId('modalMask').classList.contains('hidden'), 'retreat modal');
  ok(byId('modalTitle').textContent.includes('认输'), 'retreat title: ' + byId('modalTitle').textContent);
  ok(/-\d/.test(byId('modalCubes').textContent), 'retreat cubes: ' + byId('modalCubes').textContent);
  click(byId('btnAgain'));
  await waitFor(() => handCards().length === 3, 'restart again');
  ok(true, 'restart ok');

  console.log(failures.length === 0 ? 'ALL SMOKE TESTS PASSED' : 'FAILURES: ' + failures.join(' | '));
  process.exit(failures.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error('SMOKE CRASH:', e);
  process.exit(1);
});