/* =========================================================
   东方逆转 · dev-page.js
   开发调试页面入口（主页面「开发调试」）。

   与「开始对战」不同：
     - 不弹出出战卡组选择、不检查满编卡组；
     - 直接进入战斗页面（复用既有对局 UI）；
     - 玩家牌库为空（起手无牌，可用顶栏「🎯 指定卡牌」等调试工具加牌）；
     - 每回合能量固定 10；三块地形固定「无名之丘」；AI 每回合不出牌；
     - 顶栏隐藏「修改能量 / 图鉴」，提供「⇄ 切换立场」（落牌可进敌方区）；
     - 对手仍按既有费用曲线随机组牌并抽牌（仅不出牌）。

   入口 / 返回：
     window.DevTools.open()  ← home.js 的 PAGES.dev（ready:true）
     对局内「← 主页」→ Home.show()（与普通对战相同）
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
