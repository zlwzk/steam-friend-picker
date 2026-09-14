// content/steam-profile.js —— 注入到 Steam 个人主页，抓好友列表（含懒加载翻页）
(function () {
  'use strict';
  if (!window.SFPCommon) return;
  if (window.__SFP_STEAM_LOADED__) return;
  window.__SFP_STEAM_LOADED__ = true;

  const BTN_ID = 'sfp-steam-floating';
  let allFriendIds = new Set();
  let scanning = false;

  function isFriendsPage() {
    const path = location.pathname;
    return /\/friends\/?$/.test(path) || /\/friends\//.test(path);
  }

  function ensureButton(onClick) {
    let btn = document.getElementById(BTN_ID);
    if (btn) return btn;
    btn = document.createElement('div');
    btn.id = BTN_ID;
    Object.assign(btn.style, {
      position: 'fixed',
      right: '20px',
      top: '90px',
      zIndex: '9999',
      background: 'linear-gradient(135deg, #1b2838, #2a475e)',
      color: '#66c0f4',
      border: '1px solid #66c0f4',
      padding: '10px 14px',
      borderRadius: '6px',
      cursor: 'pointer',
      fontSize: '13px',
      fontWeight: 'bold',
      boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
      fontFamily: '"Motiva Sans", -apple-system, sans-serif',
      minWidth: '170px',
      textAlign: 'center',
      userSelect: 'none'
    });
    btn.innerHTML = '<div style="font-size:10px;color:#acb2b8;margin-bottom:3px;letter-spacing:1px">STEAM FRIEND PICKER</div><div>🎮 收割此页好友</div>';
    btn.onmouseenter = () => { btn.style.transform = 'translateY(-1px)'; };
    btn.onmouseleave = () => { btn.style.transform = 'translateY(0)'; };
    btn.onclick = onClick;
    (document.body || document.documentElement).appendChild(btn);
    return btn;
  }

  // 从当前页 DOM 收集好友 ID
  function collectFromDom() {
    const ids = new Set();
    document.querySelectorAll('a[href*="steamcommunity.com/profiles/"]').forEach(a => {
      const m = a.href.match(/profiles\/(\d+)/);
      if (m) ids.add(m[1]);
    });
    document.querySelectorAll('[data-steamid]').forEach(el => {
      const id = el.dataset.steamid;
      if (id && /^7656119\d{10}$/.test(id)) ids.add(id);
    });
    // 兜底：从好友卡片的小头像/名字块旁侧的链接
    document.querySelectorAll('.friendBlock, .friend_block, .persona').forEach(el => {
      el.querySelectorAll('a[href*="/profiles/"]').forEach(a => {
        const m = a.href.match(/profiles\/(\d+)/);
        if (m) ids.add(m[1]);
      });
    });
    return Array.from(ids);
  }

  async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // 滚动到底，触发懒加载，直到高度不再增长
  async function scrollToLoadAll() {
    for (let i = 0; i < 40; i++) {
      const before = document.documentElement.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(1200);
      // 看看有没有"显示更多"按钮
      document.querySelectorAll('a, button, span').forEach(el => {
        const t = (el.innerText || el.textContent || '').trim();
        if (/^(more|show more|load more|显示更多|加载更多|more friends)/i.test(t) && t.length < 30) {
          try { el.click(); } catch (e) { /* ignore */ }
        }
      });
      await sleep(500);
      const after = document.documentElement.scrollHeight;
      if (after <= before + 5) {
        // 再等一次确认没有再增长
        await sleep(800);
        const after2 = document.documentElement.scrollHeight;
        if (after2 <= after + 5) break;
      }
    }
    // 滚回顶部（不打扰用户）
    window.scrollTo(0, 0);
  }

  // 翻页：构造下一页链接并 fetch，解析返回的 HTML
  // Steam 好友列表：/id/<vanity>/friends/?p=<page>&appID=1 不一定可用，但很多
  // 个人主页只用滚到底就够；如果不行，再尝试分页接口
  async function tryPagedFetch() {
    // 不一定能拿到分页 URL（页面可能没有链接），这里尝试从 URL 拿 steam64/vanity
    const m = location.pathname.match(/\/(id|profiles)\/([^/]+)/);
    if (!m) return;
    const [, kind, slug] = m;
    let accumulated = collectFromDom();

    // 尝试 p=1, 2, 3... 直到重复
    for (let page = 1; page <= 10; page++) {
      try {
        const u = new URL(location.href);
        u.searchParams.set('p', String(page));
        const r = await fetch(u.toString(), { credentials: 'include', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        if (!r.ok) break;
        const html = await r.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        let addedThisPage = 0;
        doc.querySelectorAll('a[href*="steamcommunity.com/profiles/"]').forEach(a => {
          const mm = a.href.match(/profiles\/(\d+)/);
          if (mm && !accumulated.includes(mm[1])) {
            accumulated.push(mm[1]);
            addedThisPage++;
          }
        });
        if (addedThisPage === 0) break; // 没新内容
      } catch (e) {
        break;
      }
    }
    return accumulated;
  }

  async function scanAll() {
    if (scanning) return Array.from(allFriendIds);
    scanning = true;
    allFriendIds = new Set();
    try {
      // 1) 先滚到底触发懒加载
      await scrollToLoadAll();
      collectFromDom().forEach(id => allFriendIds.add(id));

      // 2) 再尝试分页接口
      const paged = await tryPagedFetch();
      if (paged) paged.forEach(id => allFriendIds.add(id));

      // 3) 排除自己
      const own = window.SFPCommon.tryGetOwnSteam64();
      if (own) allFriendIds.delete(own);
    } finally {
      scanning = false;
    }
    return Array.from(allFriendIds);
  }

  async function onHarvestClick() {
    const btn = document.getElementById(BTN_ID);
    if (!btn) return;
    btn.innerHTML = '<div style="font-size:10px;color:#67c1f5;margin-bottom:3px;letter-spacing:1px">SFP</div><div>扫描中…</div>';
    let ids;
    try {
      ids = await scanAll();
    } catch (e) {
      btn.innerHTML = `<div style="font-size:10px;color:#e15f5f;margin-bottom:3px">失败</div><div>${(e && e.message || e).toString().slice(0, 30)}</div>`;
      return;
    }
    if (ids.length === 0) {
      btn.innerHTML = '<div style="font-size:10px;color:#e1af5a;margin-bottom:3px">无结果</div><div>可能不是好友列表页 / 列表为空</div>';
      return;
    }
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SFP_ENQUEUE',
        ids,
        source: location.href,
        sourceType: 'steam-profile-friends'
      });
      btn.innerHTML = `<div style="font-size:10px;color:#67c1f5;margin-bottom:3px">已收割 ${resp.added}（重复 ${resp.duplicate}）</div><div>当前队列 ${resp.queueSize}</div>`;
    } catch (e) {
      btn.innerHTML = `<div style="font-size:10px;color:#e15f5f;margin-bottom:3px">入队失败</div><div>${(e && e.message || e).toString().slice(0, 30)}</div>`;
    }
  }

  // SPA 路由变化时也要重新挂按钮
  let lastUrl = location.href;
  function watchRoute() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.remove();
      if (isFriendsPage()) setTimeout(() => ensureButton(onHarvestClick), 1500);
    }
    setTimeout(watchRoute, 800);
  }
  watchRoute();

  // 首次注入（如果是好友页）
  setTimeout(() => { if (isFriendsPage()) ensureButton(onHarvestClick); }, 1500);

  // Popup 远程触发
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'SFP_SCAN_STEAM_PROFILE') {
      scanAll().then(ids => sendResponse({ ids }));
      return true;
    }
  });
})();
