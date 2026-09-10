/* 临时探针：验证 jsdom 30 的 http 源 + 本地文件拦截器方案 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole, requestInterceptor } = require('jsdom');

const ROOT = __dirname;
const BASE = 'http://touhou.local/';
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.md': 'text/plain',
};

const loader = requestInterceptor((request) => {
  const url = new URL(request.url);
  if (url.origin !== 'http://touhou.local') return undefined;
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT)) return new Response('forbidden', { status: 403 });
  if (!fs.existsSync(file)) {
    console.log('[loader] 404', rel);
    return new Response('not found', { status: 404 });
  }
  return new Response(fs.readFileSync(file), {
    headers: { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' },
  });
});

(async () => {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => console.log('[jsdomError]', e.message));
  vc.on('error', (...a) => console.log('[console.error]', ...a));
  vc.on('warn', (...a) => console.log('[console.warn]', ...a));

  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), {
    url: BASE + 'index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    resources: { interceptors: [loader] },
  });
  const { window } = dom;
  await new Promise((r) => setTimeout(r, 3500));
  console.log('Game?', !!window.Game, 'DeckStorage?', !!window.DeckStorage, 'DeckBuilder?', !!window.DeckBuilder);
  console.log('POOL costs?', window.DS_CARDS ? Object.keys(window.DS_CARDS.POOL) : null);
  console.log('locations?', window.DS_LOCATIONS ? window.DS_LOCATIONS.POOL.length : null);
  try {
    console.log('localStorage save ->', window.localStorage.setItem('probe', '1'), window.localStorage.getItem('probe'));
  } catch (e) {
    console.log('localStorage FAIL', e.message);
  }
  console.log('dbg', JSON.stringify(window.Game && window.Game._dbg()));
  console.log('hand', window.document.querySelectorAll('#hand .hand-card').length);
  console.log('turn', window.document.getElementById('turnVal').textContent);
  console.log('style rules', window.document.styleSheets.length, window.document.styleSheets[0] && window.document.styleSheets[0].cssRules.length);
  process.exit(0);
})().catch((e) => { console.error('PROBE CRASH', e); process.exit(1); });
