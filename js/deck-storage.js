/* =========================================================
   东方逆转 · deck-storage.js
   卡组信息的本地持久化（与 deck-page.js 解耦）。
   介质＝localStorage，键名 touhou2.decks.v1；卡组里的牌按**卡名**保存（POOL 内同名唯一），
   读回时由 deck-page 按名解析成 def 引用。
   对外 API（window.DeckStorage）：load() / save(data) / clear()
   ========================================================= */
(function () {
  'use strict';

  var KEY = 'touhou2.decks.v1';
  var VERSION = 1;

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return null;
      if (!Array.isArray(data.decks)) return null;
      return data;
    } catch (e) {
      console.warn('[DeckStorage] 读取失败，将使用默认卡组：', e);
      return null;
    }
  }

  function save(data) {
    if (!data || !Array.isArray(data.decks)) return false;
    try {
      var payload = {
        version: VERSION,
        deckSeq: data.deckSeq | 0,
        activeDeckId: data.activeDeckId || null,
        decks: data.decks,
      };
      localStorage.setItem(KEY, JSON.stringify(payload));
      return true;
    } catch (e) {
      console.warn('[DeckStorage] 写入失败：', e);
      return false;
    }
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
  }

  window.DeckStorage = {
    KEY: KEY,
    VERSION: VERSION,
    load: load,
    save: save,
    clear: clear,
  };
})();
