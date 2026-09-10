/* =========================================================
   东方逆转 · deck-storage.js（v135）
   卡组信息本地持久化（与 deck-page.js 解耦）。

   存储介质：浏览器 localStorage（纯前端、无服务端文件可写）。
   键名：touhou2.decks.v1
   序列化口径：卡组里的牌用卡名字符串保存（POOL 内同名唯一），
               读回时由 deck-page 按名解析为 def 引用。

   对外 API（window.DeckStorage）：
     load()  → { version, deckSeq, activeDeckId, decks } | null
     save(data) → boolean（写入成功）
     clear() → 清除本地存档（调试用）
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
