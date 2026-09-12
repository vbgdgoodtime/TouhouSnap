/* =========================================================
   东方逆转 · dev-page.js
   开发调试页面：直接进战斗页并复用对局 UI，但玩家牌库为空（起手无牌，靠顶栏「🎯 指定卡牌」加牌）、
   每回合能量固定 10、三块地形固定「无名之丘」、AI 每回合不出牌，
   顶栏另给「⇄ 切换立场」（落牌可进敌方区）并隐藏「修改能量 / 图鉴」；
   对手仍按既有费用曲线随机组牌并抽牌（只是不出牌）。
   入口 window.DevTools.open()（home.js 的 PAGES.dev），返回走 Home.show()。
   ========================================================= */
(function () {
  'use strict';

  function toast(text, ms) {
    if (window.Home && typeof window.Home.toast === 'function') {
      window.Home.toast(text, ms);
      return;
    }
    console.info('[DevTools]', text);
  }

  function open() {
    if (!window.Game || typeof window.Game.restart !== 'function') {
      toast('游戏脚本未就绪，无法进入开发调试（请检查 game.js 是否加载成功）。');
      return;
    }
    if (window.Home && typeof window.Home.hide === 'function') {
      window.Home.hide();
    } else {
      document.body.classList.remove('in-home');
      var home = document.getElementById('homeScreen');
      if (home) home.classList.add('hidden');
    }
    document.body.classList.add('in-dev');
    try {
      var p = window.Game.restart({ emptyPlayerDeck: true });
      if (p && typeof p.catch === 'function') {
        p.catch(function (err) {
          console.error('[DevTools] 开局失败：', err);
          document.body.classList.remove('in-dev');
          if (window.Home && typeof window.Home.show === 'function') window.Home.show();
          toast('开发调试开局失败，已返回主页面（详情见控制台）。');
        });
      }
      toast('开发调试：玩家牌库为空，可用「指定卡牌」加入手牌；每回合能量 10 · 三块无名之丘 · AI 不出牌。', 3600);
    } catch (err) {
      console.error('[DevTools] 开局失败：', err);
      document.body.classList.remove('in-dev');
      if (window.Home && typeof window.Home.show === 'function') window.Home.show();
      toast('开发调试开局失败，已返回主页面（详情见控制台）。');
    }
  }

  function close() {
    document.body.classList.remove('in-dev');
    if (window.Home && typeof window.Home.show === 'function') window.Home.show();
  }

  function isOpen() {
    return document.body.classList.contains('in-dev');
  }

  window.DevTools = {
    open: open,
    close: close,
    isOpen: isOpen,
  };
})();
