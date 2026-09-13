/* =========================================================
   东方逆转 · tools/css-cascade-check.js
   **卡面等价性核对**：不开浏览器、不跑测试，纯静态地证明「改 CSS 前后，
   每一类卡面在每个断点下算出来的生效值完全一致」。

   用法（在项目根目录跑）：
     node tools/css-cascade-check.js 旧style.css 新style.css   # 逐项比对，最后打印「差异 N 处」
     node tools/css-cascade-check.js style.css --selftest       # 自检：往副本里植入改动，必须报出差异
     node tools/css-cascade-check.js style.css --dump           # 打印各断点生效值基线 → _tmp_baseline.txt
     node tools/css-cascade-check.js style.css --why 6 6 ".hc-art" "margin-top"
                                                                # 追一条值的级联来源（上下文号 / 视口号）

   覆盖范围：19 类卡面上下文 × 8 个状态变体（.sealed / .no-img / .up / .down …）× 11 个视口
   × 16 个被查元素（含卡片根自身的全部属性）≈ 23562 次计算。差异明细写入 _tmp_diff.txt。

   口径：解析两份 CSS（注释先算区间再跳过；at-rule 与普通规则分开；单行规则一并覆盖）→
   按 (特异度, 源码顺序) 选出每个属性的胜者 → 展开简写（margin / padding / border / inset）→
   解析 var() 并递归取自定义属性 → 逐项比对。（对应 docs/UI优化计划.md 坑 6 / 坑 9 / 坑 10。）

   ⚠️ 它只证明「没变」，证明不了「好看」—— 视觉结论仍以用户实测为准（docs/开发规则.md 规则 6）。
   ⚠️ 增删场景/元素时要同步改下面的 contexts()：**没被建模的元素等于没被核对**。
   ========================================================= */
const fs = require('fs');

/* ==================== 解析 ==================== */
function parseCss(file) {
  const src = fs.readFileSync(file, 'utf8');
  const mask = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? src.length : e + 2;
      for (let j = i; j < end; j++) mask[j] = 1;
      i = end - 1;
    }
  }
  const rules = [];
  const stack = [];
  let i = 0, preludeStart = 0, order = 0;
  const clean = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').trim();
  while (i < src.length) {
    if (mask[i]) { i++; continue; }
    const ch = src[i];
    if (ch === '{') {
      const prelude = clean(src.slice(preludeStart, i));
      if (prelude.startsWith('@')) { stack.push(prelude); preludeStart = i + 1; }
      else {
        let j = i + 1;
        while (j < src.length && (mask[j] || src[j] !== '}')) j++;
        const body = src.slice(i + 1, j).replace(/\/\*[\s\S]*?\*\//g, ' ');
        const decls = [];
        for (const part of body.split(';')) {
          const t = part.trim();
          if (!t) continue;
          const c = t.indexOf(':');
          if (c < 0) continue;
          const prop = t.slice(0, c).trim();
          let val = t.slice(c + 1).trim();
          const important = /!\s*important$/.test(val);
          if (important) val = val.replace(/!\s*important$/, '').trim();
          decls.push({ prop, val, important });
        }
        for (const sel of splitTop(prelude)) {
          rules.push({ media: stack.slice(), sel: sel.trim().replace(/\s+/g, ' '), decls, order: order++ });
        }
        preludeStart = j + 1;
        i = j;
      }
    } else if (ch === '}') { stack.pop(); preludeStart = i + 1; }
    else if (ch === ';' && clean(src.slice(preludeStart, i)).startsWith('@')) preludeStart = i + 1;
    i++;
  }
  return { src, rules };
}
/* 选择器列表按顶层逗号切开（括号内逗号不算） */
function splitTop(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/* ==================== 选择器匹配 ==================== */
const PSEUDO_FAIL = /:(hover|focus|active|visited|disabled|checked|first-child|last-child|nth-child|first-of-type|last-of-type|empty|focus-visible|focus-within)\b/;

function parseCompound(str) {
  const el = { tag: null, id: null, classes: [], not: [], bad: false };
  let i = 0;
  const s = str.trim();
  const m = /^([a-zA-Z][\w-]*|\*)/.exec(s);
  if (m) { el.tag = m[1] === '*' ? null : m[1].toLowerCase(); i = m[1].length; }
  while (i < s.length) {
    const c = s[i];
    if (c === '.' || c === '#') {
      const mm = /^[.#]([\w-]+)/.exec(s.slice(i));
      if (!mm) { el.bad = true; break; }
      if (c === '.') el.classes.push(mm[1]); else el.id = mm[1];
      i += mm[0].length;
    } else if (c === ':') {
      if (s[i + 1] === ':') { el.bad = true; break; } // 伪元素不建模
      const mm = /^:([\w-]+)(\(([^)]*)\))?/.exec(s.slice(i));
      if (!mm) { el.bad = true; break; }
      const name = mm[1];
      if (name === 'not') el.not.push(mm[3] || '');
      else if (!['root', 'where', 'is'].includes(name)) el.bad = true;
      if (name === 'where' || name === 'is') el.bad = true;
      i += mm[0].length;
    } else if (c === '[') {
      const mm = /^\[[^\]]*\]/.exec(s.slice(i));
      if (!mm) { el.bad = true; break; }
      el.bad = true; break; // 属性选择器不建模
    } else { el.bad = true; break; }
  }
  return el;
}
function compoundMatches(node, comp) {
  if (!comp || comp.bad) return false;
  if (comp.tag && comp.tag !== node.tag) return false;
  if (comp.id && comp.id !== node.id) return false;
  for (const c of comp.classes) if (!node.classes.includes(c)) return false;
  for (const inner of comp.not) {
    for (const part of splitTop(inner)) {
      const ic = parseCompound(part);
      if (!ic.bad && compoundMatches(node, ic)) return false;
    }
  }
  return true;
}
/* 选择器 → 左→右的 [{compound, comb}]，comb = 与**左侧**邻件的组合符（' ' 后代 / '>' 子代） */
function parseSelector(sel) {
  if (PSEUDO_FAIL.test(sel)) return null;
  const parts = [];
  let buf = '', pending = null, depth = 0;
  const flush = () => {
    if (!buf.trim()) return;
    parts.push({ compound: parseCompound(buf), comb: parts.length ? (pending || ' ') : null });
    buf = '';
  };
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth === 0 && /\s/.test(c)) { flush(); if (pending === null) pending = ' '; continue; }
    if (depth === 0 && c === '>') { flush(); pending = '>'; continue; }
    buf += c;
    if (/\S/.test(c)) pending = pending === '>' ? '>' : null;
  }
  flush();
  return parts;
}
function selectorMatches(chain, idx, parts) {
  if (!parts || !parts.length) return false;
  const n = parts.length;
  if (!compoundMatches(chain[idx], parts[n - 1].compound)) return false;
  let cur = idx;
  for (let k = n - 2; k >= 0; k--) {
    const rel = parts[k + 1].comb;
    const comp = parts[k].compound;
    if (rel === '>') {
      cur -= 1;
      if (cur < 0 || !compoundMatches(chain[cur], comp)) return false;
    } else {
      let found = false;
      for (let x = cur - 1; x >= 0; x--) {
        if (compoundMatches(chain[x], comp)) { cur = x; found = true; break; }
      }
      if (!found) return false;
    }
  }
  return true;
}
function specificity(sel) {
  const noNot = sel.replace(/:not\(([^)]*)\)/g, ' $1 ');
  const ids = (noNot.match(/#[\w-]+/g) || []).length;
  const cls = (noNot.match(/\.[\w-]+/g) || []).length
    + (noNot.match(/\[[^\]]*\]/g) || []).length
    + (noNot.replace(/::[a-z-]+/g, ' ').match(/:[a-z-]+/g) || []).length;
  const el = (noNot.replace(/\.[\w-]+/g, ' ').replace(/#[\w-]+/g, ' ').match(/(^|[\s>])[a-zA-Z][\w-]*/g) || []).length;
  return ids * 10000 + cls * 100 + el;
}

/* ==================== 媒体查询 ==================== */
function mediaMatches(list, vp) {
  for (const q of list) {
    if (!q.startsWith('@media')) return false; // @supports / @keyframes 等一律不参与
    const text = q.slice(6).trim();
    for (const part of text.split(/\s+and\s+/i)) {
      const t = part.trim().replace(/^\(|\)$/g, '').trim();
      const m = /^(min|max)-(width|height)\s*:\s*([\d.]+)px$/.exec(t);
      if (m) {
        const val = parseFloat(m[3]);
        const actual = m[2] === 'width' ? vp.w : vp.h;
        if (m[1] === 'max' ? actual > val : actual < val) return false;
        continue;
      }
      if (/^hover\s*:\s*none$/.test(t)) { if (vp.hover) return false; continue; }
      if (/^hover\s*:\s*hover$/.test(t)) { if (!vp.hover) return false; continue; }
      if (/^(orientation|pointer|prefers-)/.test(t)) return false; // 未建模 ⇒ 视为不命中
      return false; // 未知条件：保守视为不命中
    }
  }
  return true;
}

/* ==================== 级联 ==================== */
/* 性能：把规则按「最右复合选择器」建索引，元素只在自己的候选集里比级联
   （全表扫描 1132 条 × 每个元素会退化到分钟级） */
let stampSeq = 0;
const mediaCache = new Map();
const varCache = new Map();
function chainSig(chain) {
  if (!chain.__sig) chain.__sig = chain.map((n) => n.tag + (n.id ? '#' + n.id : '') + (n.classes.length ? '.' + n.classes.join('.') : '')).join('>');
  return chain.__sig;
}
function buildIndex(rules) {
  const idx = { any: [], byClass: new Map(), byId: new Map(), byTag: new Map() };
  const push = (map, key, r) => { let a = map.get(key); if (!a) { a = []; map.set(key, a); } a.push(r); };
  for (const r of rules) {
    const parts = r.parts || (r.parts = parseSelector(r.sel));
    if (!parts) continue; // 永不匹配（:hover / 伪元素等）——本核对只比对静态态
    const c = parts[parts.length - 1].compound;
    if (c.bad) continue; // 属性选择器 / 伪元素 / 关键帧里的 `0%`、`from` 等：不可能匹配到本核对的元素
    if (!c.tag && !c.id && !c.classes.length) { idx.any.push(r); continue; } // `*`、`:root` 这类通配
    if (c.tag) push(idx.byTag, c.tag, r);
    if (c.id) push(idx.byId, c.id, r);
    for (const cl of c.classes) push(idx.byClass, cl, r);
  }
  return idx;
}
function candidates(rules, el) {
  const idx = rules.__index || (rules.__index = buildIndex(rules));
  const st = ++stampSeq;
  const out = [];
  const take = (arr) => { if (!arr) return; for (const r of arr) { if (r.__st !== st) { r.__st = st; out.push(r); } } };
  take(idx.any);
  take(idx.byTag.get(el.tag));
  if (el.id) take(idx.byId.get(el.id));
  for (const cl of el.classes) take(idx.byClass.get(cl));
  return out;
}
const INHERITED = ['font-size', 'font-weight', 'line-height', 'color', 'text-align', 'text-shadow', 'letter-spacing', 'font-family'];
const BOX = ['margin', 'padding'];
const SIDES = ['top', 'right', 'bottom', 'left'];

/* 简写展开成具体属性 —— 否则「先 margin: a b c d，后 margin-top: X」这种覆盖会被漏算 */
function expand(prop, val) {
  if (BOX.includes(prop)) {
    const t = val.trim().split(/\s+/);
    const v = t.length === 1 ? [t[0], t[0], t[0], t[0]]
      : t.length === 2 ? [t[0], t[1], t[0], t[1]]
        : t.length === 3 ? [t[0], t[1], t[2], t[1]]
          : [t[0], t[1], t[2], t[3]];
    return SIDES.map((s, i) => [prop + '-' + s, v[i]]);
  }
  if (prop === 'inset') {
    const t = val.trim().split(/\s+/);
    const v = t.length === 1 ? [t[0], t[0], t[0], t[0]]
      : t.length === 2 ? [t[0], t[1], t[0], t[1]]
        : t.length === 3 ? [t[0], t[1], t[2], t[1]]
          : [t[0], t[1], t[2], t[3]];
    return SIDES.map((s, i) => [s, v[i]]);
  }
  if (prop === 'border-width') {
    const t = val.trim().split(/\s+/);
    const v = t.length === 1 ? [t[0], t[0], t[0], t[0]]
      : t.length === 2 ? [t[0], t[1], t[0], t[1]]
        : t.length === 3 ? [t[0], t[1], t[2], t[1]]
          : [t[0], t[1], t[2], t[3]];
    return SIDES.map((s, i) => ['border-' + s + '-width', v[i]]);
  }
  if (prop === 'border') {
    const toks = val.trim().split(/\s+/);
    let style, width, color;
    for (const t of toks) {
      if (/^(none|solid|dashed|dotted|double|groove|ridge|inset|outset|hidden)$/.test(t)) { style = t; continue; }
      if (/^[\d.]+(px|em|rem)$/.test(t) || /^(thin|medium|thick)$/.test(t)) { width = t; continue; }
      // var(--x) 可能是宽度也可能是颜色：按「先宽度后颜色」补空位（本项目只有这两种写法）
      if (t.indexOf('var(') >= 0 && width === undefined) { width = t; continue; }
      color = color === undefined ? t : color + ' ' + t;
    }
    const out = [];
    for (const s of SIDES) {
      if (width) out.push(['border-' + s + '-width', width]);
      if (style) out.push(['border-' + s + '-style', style]);
      if (color) out.push(['border-' + s + '-color', color]);
    }
    return out.length ? out : [[prop, val]];
  }
  return [[prop, val]];
}

function winnerOn(rules, chain, idx, vp, rawOnly) {
  const map = new Map(); // prop -> {val, spec, order, important}
  for (const r of candidates(rules, chain[idx])) {
    const mk = r.media.join(' ') + '@' + vp.name;
    let ok = mediaCache.get(mk);
    if (ok === undefined) { ok = mediaMatches(r.media, vp); mediaCache.set(mk, ok); }
    if (!ok) continue;
    if (!selectorMatches(chain, idx, r.parts)) continue;
    const spec = r.spec !== undefined ? r.spec : (r.spec = specificity(r.sel));
    for (const d of r.decls) {
      // ⚠️ 两个要点：
      //   ① 必须先把 var() 解析掉再展开简写 —— 否则 `margin: var(--art-m, 4px auto 2px)` 会被按空格切碎；
      //   ② **自定义属性自身不解析**、且查自定义属性时整张表都不解析（rawOnly）—— 否则
      //      `margin: var(--art-m)` → 查 --art-m → 又回来解析同一条 margin，无限递归。
      const raw = (!rawOnly && !d.prop.startsWith('--') && d.val.indexOf('var(') >= 0)
        ? resolveVars(d.val, chain, idx, vp, rules, 0)
        : d.val;
      for (const [prop, val] of expand(d.prop, raw)) {
        const cur = map.get(prop);
        const cand = { val, spec, order: r.order, important: d.important };
        if (!cur
          || (cand.important && !cur.important)
          || (cand.important === cur.important && (cand.spec > cur.spec || (cand.spec === cur.spec && cand.order >= cur.order)))) {
          map.set(prop, cand);
        }
      }
    }
  }
  return map;
}
function resolveVars(val, chain, idx, vp, rules, depth) {
  if (depth > 12 || val.indexOf('var(') < 0) return val;
  return val.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (all, name, fb) => {
    const got = customProp(name, chain, idx, vp, rules, depth + 1);
    if (got !== undefined) return resolveVars(got, chain, idx, vp, rules, depth + 1);
    return fb !== undefined ? resolveVars(fb, chain, idx, vp, rules, depth + 1) : all;
  });
}
function customProp(name, chain, idx, vp, rules, depth) {
  if (depth > 12) return undefined; // 自引用（--x: var(--x)）兜底，避免无限递归
  const ck = name + '|' + vp.name + '|' + idx + '|' + chainSig(chain);
  const hit = varCache.get(ck);
  if (hit !== undefined) return hit === '\u0000' ? undefined : hit;
  for (let k = idx; k >= 0; k--) {
    const map = winnerOn(rules, chain, k, vp, true); // rawOnly：只要原始值，避免递归
    const w = map.get(name);
    if (w) {
      const val = resolveVars(w.val, chain, k, vp, rules, depth);
      varCache.set(ck, val);
      return val;
    }
  }
  varCache.set(ck, '\u0000');
  return undefined;
}
function computed(rules, chain, idx, vp) {
  const out = {};
  const map = winnerOn(rules, chain, idx, vp);
  for (const [prop, w] of map) out[prop] = resolveVars(w.val, chain, idx, vp, rules, 0);
  // 继承属性：本级没有声明就往祖先找最近的一次声明
  for (const p of INHERITED) {
    if (out[p] !== undefined) continue;
    for (let k = idx - 1; k >= 0; k--) {
      const m = winnerOn(rules, chain, k, vp);
      if (m.has(p)) { out[p] = resolveVars(m.get(p).val, chain, k, vp, rules, 0); break; }
    }
  }
  if (out['font-size'] === undefined) out['font-size'] = '16px';
  return out;
}

/* ==================== 场景定义 ==================== */
const S = (tag, spec) => {
  const classes = (spec || '').split('.').filter(Boolean);
  return { tag, id: null, classes };
};
const el = (tag, cls, id) => ({ tag, id: id || null, classes: cls.split('.').filter(Boolean) });

const VIEWPORTS = [
  { name: '桌面 1440×900', w: 1440, h: 900, hover: true },
  { name: '1000×800', w: 1000, h: 800, hover: true },
  { name: '950×800', w: 950, h: 800, hover: true },
  { name: '800×800', w: 800, h: 800, hover: true },
  { name: '730×800', w: 730, h: 800, hover: true },
  { name: '660×800', w: 660, h: 800, hover: true },
  { name: '600×800', w: 600, h: 800, hover: true },
  { name: '500×800', w: 500, h: 800, hover: true },
  { name: '桌面矮屏 1440×600', w: 1440, h: 600, hover: true },
  { name: '手机横屏 730×600', w: 730, h: 600, hover: true },
  { name: '手机横屏 660×600', w: 660, h: 600, hover: true },
];

/* 每个场景：祖先链（含目标卡面） + 要检查的后代 */
function contexts() {
  const html = S('html'); const body = S('body');
  const mk = (ancestors, target, children) => ({ chain: [html, body].concat(ancestors, [target]), children });
  const BADGES = ['.hc-top .cost-orb', '.hc-top .p', '.hc-top .hc-spell', '.hc-top .cost-orb.up', '.hc-top .cost-orb.down', '.hc-top .p.up', '.hc-top .p.down'];
  const FACE = ['.hc-top', '.hc-art', '.hc-art .hc-icon', '.hc-art .hc-seal', '.hc-icon', '.hc-icon .hc-seal', '.hc-name', '.hc-text'];
  return [
    { name: '手牌', ...mk([el('div', 'hand', 'hand')], el('div', 'card-face.hand-card'), BADGES.concat(FACE)) },
    { name: '手牌(无图)', ...mk([el('div', 'hand', 'hand')], el('div', 'card-face.hand-card.no-img'), BADGES.concat(FACE)) },
    { name: '手牌(封印)', ...mk([el('div', 'hand', 'hand')], el('div', 'card-face.hand-card.sealed'), BADGES.concat(FACE)) },
    { name: '对手手牌情报', ...mk([el('div', 'ai-spy-grid')], el('div', 'card-face.hand-card.ai-spy-card'), BADGES.concat(FACE)) },
    { name: '图鉴', ...mk([el('div', 'codex-grid', 'codexGrid')], el('div', 'card-face.hand-card.codex-card'), BADGES.concat(FACE)) },
    { name: '指定卡牌', ...mk([el('div', 'codex-grid', 'pickGrid')], el('div', 'card-face.hand-card.codex-card'), BADGES.concat(FACE)) },
    { name: '三池', ...mk([el('div', 'pile-grid', 'pileGrid'), el('div', 'pile-cell')], el('div', 'card-face.hand-card.codex-card.pile-item'), BADGES.concat(FACE)) },
    { name: '卡组编辑槽', ...mk([el('div', 'deck-slots.edit-mode', 'deckSlots')], el('button', 'card-face.hand-card.deck-card-slot.filled'), BADGES.concat(FACE)) },
    { name: '卡组池', ...mk([el('div', 'deck-grid')], el('div', 'card-face.hand-card.deck-pool-card'), BADGES.concat(FACE)) },
    { name: '放大弹窗', ...mk([el('div', 'zoom-stage'), el('div', 'zoom-row'), el('div', 'zoom-main-col'), el('div', '', 'zoomCardSlot')], el('div', 'card-face.hand-card.zoom-card'), BADGES.concat(FACE)) },
    { name: '放大·无衍生卡', ...mk([el('div', 'zoom-stage.no-deriv'), el('div', 'zoom-row'), el('div', 'zoom-main-col'), el('div', '', 'zoomCardSlot')], el('div', 'card-face.hand-card.zoom-card'), BADGES.concat(FACE)) },
    { name: '衍生卡', ...mk([el('div', 'zoom-stage'), el('div', 'zoom-row'), el('div', 'zoom-deriv'), el('div', 'deriv-item')], el('div', 'card-face.hand-card.zoom-card.deriv-card'), BADGES.concat(FACE)) },
    { name: '登场演出', ...mk([el('div', 'gs-reveal'), el('div', 'gs-reveal-inner'), el('div', 'gs-reveal-item'), el('div', 'gs-reveal-cardwrap')], el('div', 'card-face.hand-card.zoom-card.gs-reveal-card'), BADGES.concat(FACE)) },
    { name: '弃牌演出', ...mk([el('div', 'discard-reveal'), el('div', 'discard-reveal-inner'), el('div', 'discard-card-wrap')], el('div', 'card-face.hand-card.zoom-card.discard-face'), BADGES.concat(FACE)) },
    { name: '弃牌演出(半片)', ...mk([el('div', 'discard-reveal'), el('div', 'discard-reveal-inner'), el('div', 'discard-card-wrap'), el('div', 'discard-half')], el('div', 'card-face.hand-card.zoom-card.discard-face'), BADGES.concat(FACE)) },
    { name: '场上缩略(有图)', ...mk([el('div', 'zone'), el('div', 'slot-row')], el('div', 'mini-card.has-art'), ['.mc-cost', '.p', '.mc-spell', '.mc-icon', '.mini-img', '.mc-shade', '.mc-name', '.mc-mod', '.mc-seal', '.mc-q', '.mc-tag', '.mc-fly']) },
    { name: '场上缩略(无图)', ...mk([el('div', 'zone'), el('div', 'slot-row')], el('div', 'mini-card'), ['.mc-cost', '.p', '.mc-spell', '.mc-icon', '.mc-name', '.mc-mod', '.mc-seal', '.mc-q', '.mc-tag']) },
    { name: '场上缩略(暗牌)', ...mk([el('div', 'zone'), el('div', 'slot-row')], el('div', 'mini-card.sealed'), ['.mc-cost', '.p', '.mc-icon', '.mc-name', '.mc-seal', '.mc-q', '.mc-tag']) },
    { name: '场上缩略(大体积有图)', ...mk([el('div', 'zone'), el('div', 'slot-row')], el('div', 'mini-card.has-art.big-occ'), ['.mc-cost', '.p', '.mc-icon', '.mc-name', '.mc-mod']) },
  ];
}

/* ==================== 比对 ==================== */
const DUMP = process.argv[3] === '--dump';
const SELFTEST = process.argv[3] === '--selftest';
let pathB = process.argv[3];
if (SELFTEST) {
  // 自测：故意改掉一处（图鉴 ≤640 的角标字号 10px → 13px），核对脚本必须报出差异，
  // 否则说明脚本本身没在看这条规则（脚本可信度先于结论）。
  const raw = fs.readFileSync(process.argv[2], 'utf8');
  /* 自检：往副本里植入 4 处「应该被抓出来」的改动（覆盖基准档 / 放大档 / 断点档 / ID 级规则） */
  const PLANTS = [
    ['--badge: 26px;', '--badge: 29px;'],                     // .card-face 基准档
    ['--badge-bw: 2.5px;', '--badge-bw: 3px;'],               // .zoom-card 桌面档
    ['{ margin: 3px auto 2px; }', '{ margin: 9px auto 2px; }'], // #codexGrid/#pickGrid 的 ID 级立绘区边距
    ['--name-fs: 12.5px;', '--name-fs: 12.9px;'],             // 卡名字号基准
  ];
  let mutated = raw;
  for (const [needle, repl] of PLANTS) {
    const hits = mutated.split(needle).length - 1;
    if (hits !== 1) { console.log('自测失败：植入点命中 ' + hits + ' 次（应为 1）：' + needle); process.exit(1); }
    mutated = mutated.replace(needle, repl);
  }
  pathB = '_tmp_selftest.css';
  fs.writeFileSync(pathB, mutated, 'utf8');
}
const A = parseCss(process.argv[2]);
const B = (DUMP || process.argv[3] === '--why') ? A : parseCss(pathB);

if (process.argv[3] === '--why') {
  /* 用法：node _tmp_cascade.js style.css --why <上下文序号> <视口序号> <后代选择器> <属性>
     （序号用数字，避免中文参数在 shell 里被转码） */
  const [, , , , ctxIdx, vpIdx, sel, prop] = process.argv;
  const ctx = contexts()[Number(ctxIdx)];
  const vp = VIEWPORTS[Number(vpIdx)];
  if (!ctx || !vp) { console.log('上下文 0..' + (contexts().length - 1) + '，视口 0..' + (VIEWPORTS.length - 1)); process.exit(1); }
  console.log('上下文：' + ctx.name + ' ／ 视口：' + vp.name);
  const chain = ctx.chain.concat(childChain(sel));
  const idx = chain.length - 1;
  console.log('元素链：', chain.map((n) => n.tag + (n.id ? '#' + n.id : '') + (n.classes.length ? '.' + n.classes.join('.') : '')).join(' > '));
  const rows = [];
  for (const r of A.rules) {
    if (!mediaMatches(r.media, vp)) continue;
    const parts = r.parts || (r.parts = parseSelector(r.sel));
    if (!parts || !selectorMatches(chain, idx, parts)) continue;
    const spec = r.spec !== undefined ? r.spec : (r.spec = specificity(r.sel));
    for (const d of r.decls) {
      for (const [p, v] of expand(d.prop, d.val)) {
        if (p === prop) rows.push({ spec, order: r.order, line: r.line, sel: r.sel, val: v, media: r.media.join(' ') });
      }
    }
  }
  rows.sort((a, b) => a.spec - b.spec || a.order - b.order);
  for (const x of rows) console.log(`  spec=${x.spec} order=${x.order} line=${x.line}  ${x.val}   ← ${x.sel}   ${x.media}`);
  const win = computed(A.rules, chain, idx, vp)[prop];
  console.log('生效值 =', win);
  process.exit(0);
}

if (DUMP) {
  /* 基线表：每个上下文在**各断点下的生效值**（只在取值变化的那一档打印一行） */
  const WANT = {
    '.hc-top .cost-orb': ['width', 'height', 'font-size', 'border-top-width', 'border-radius'],
    '.hc-top .p': ['width', 'height', 'font-size', 'border-top-width', 'border-radius'],
    '.hc-top .hc-spell': ['width', 'height', 'font-size', 'border-top-width', 'border-radius'],
    '.hc-art .hc-seal': ['font-size'],
    '.hc-icon .hc-seal': ['font-size'],
    '.hc-icon': ['font-size', 'margin-top', 'margin-bottom', 'width', 'border-radius'],
    '.hc-art': ['width', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'border-radius'],
    '.hc-art .hc-icon': ['font-size'],
    '.hc-name': ['font-size', 'min-height', 'line-height'],
    '.hc-text': ['font-size', 'line-height', 'min-height', 'margin-top', '-webkit-line-clamp', 'display'],
    '.mc-cost': ['font-size', 'min-width', 'padding-top', 'padding-left', 'border-radius'],
    '.mc-p': ['font-size', 'min-width', 'padding-top', 'padding-right', 'border-radius'],
    '.mc-seal': ['font-size'],
  };
  const out = [];
  for (const ctx of contexts()) {
    out.push('\n== ' + ctx.name);
    let last = null;
    for (const vp of VIEWPORTS) {
      const rows = [];
      for (const [sel, props] of Object.entries(WANT)) {
        const target = sel === '.mc-p' ? '.p' : sel; // .mc-p 只是表里的别名，实际选择器是 .mini-card 下的 .p
        const chain = ctx.chain.concat(childChain(target));
        const idx = chain.length - 1;
        const own = computed(A.rules, chain, idx, vp);
        const isBadge = /\.(cost-orb|hc-spell)$/.test(target) || / \.p$/.test(target);
        const parts = props.map((p) => p + '=' + (own[p] === undefined ? '—' : own[p]));
        if (isBadge) parts.unshift('size=' + (own.width === undefined ? '—' : own.width + '×' + own.height));
        parts.unshift(target.split(' ').pop());
        rows.push(parts.join(' '));
      }
      const key = rows.join(' | ');
      if (key !== last) {
        out.push('  ' + vp.name.padEnd(16) + rows.join('  ·  '));
        last = key;
      }
    }
  }
  fs.writeFileSync('_tmp_baseline.txt', out.join('\n'), 'utf8');
  console.log('基线表已写入 _tmp_baseline.txt（' + out.length + ' 行）');
  process.exit(0);
}
if (SELFTEST) console.log('【自测模式】已在副本里植入 4 处改动（基准档 / 放大档 / 断点档 / ID 级规则），下面必须报出差异：\n');
const vps = VIEWPORTS;
let diffs = 0, checks = 0;
const report = [];

for (const ctx of contexts()) {
  const isMini = ctx.chain[ctx.chain.length - 1].classes.includes('mini-card');
  const variants = isMini
    ? ['', '.sealed', '.has-art', '.can-inspect', '.spell', '.big-occ']
    : ['', '.sealed', '.no-img', '.token-card', '.selected', '.unaffordable', '.in-deck', '.pick-picked'];
  for (const vp of vps) {
    for (const variant of variants) {
      const chain = ctx.chain.map((n, i) => (i === ctx.chain.length - 1
        ? { tag: n.tag, id: n.id, classes: n.classes.concat(variant.split('.').filter(Boolean)) }
        : n));
      const label = (variant ? '［目标卡面' + variant + '］' : '［目标卡面］')
        + chain[chain.length - 1].tag + (chain[chain.length - 1].id ? '#' + chain[chain.length - 1].id : '') + '.' + chain[chain.length - 1].classes.join('.');
      checkOne(ctx.name + variant, chain, chain.length - 1, vp, label);
      for (const child of ctx.children) {
        const sub = chain.concat(childChain(child));
        checkOne(ctx.name + variant, sub, sub.length - 1, vp, child);
      }
    }
  }
}
function checkOne(name, chain, idx, vp, label) {
  const a = computed(A.rules, chain, idx, vp);
  const b = computed(B.rules, chain, idx, vp);
  checks++;
  const props = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const p of props) {
    if (p.startsWith('--')) continue; // 自定义属性本身不是视觉结果，它折算出的具体属性在下面比对
    if (a[p] !== b[p]) {
      diffs++;
      report.push(`${name} @ ${vp.name} › ${label}\n    ${p}\n      旧: ${a[p]}\n      新: ${b[p]}`);
    }
  }
}
/* '.hc-art .hc-icon' → 两个元素节点（后代链），保证后代选择器能匹配上 */
function childChain(s) {
  return s.trim().split(/\s+/).map((tok) => {
    const classes = tok.replace(/^[a-zA-Z][\w-]*/, '').split('.').filter(Boolean);
    const tagM = /^([a-zA-Z][\w-]*)/.exec(tok);
    return { tag: tagM ? tagM[1].toLowerCase() : 'span', id: null, classes };
  });
}
const byProp = {};
for (const r of report) { const p = r.split('\n')[1].trim(); byProp[p] = (byProp[p] || 0) + 1; }
if (report.length) fs.writeFileSync('_tmp_diff.txt', report.join('\n\n'), 'utf8');
console.log('\n差异按属性汇总：');
for (const [k, v] of Object.entries(byProp).sort((a, b) => b[1] - a[1])) console.log(`  ${k} × ${v}`);
console.log(`\n比对完成：场景×视口×元素 = ${checks} 次计算，差异 ${diffs} 处` + (report.length ? '（明细见 _tmp_diff.txt）' : ''));
if (A.rules.length !== B.rules.length) console.log(`（规则总数：旧 ${A.rules.length} / 新 ${B.rules.length}）`);
