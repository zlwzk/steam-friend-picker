// content/steam-search.js —— Steam 用户搜索结果注入
// 匹配 https://steamcommunity.com/search/users/#text=xxx 或 /search/users/?text=xxx
(function () {
  'use strict';
  if (!window.SFPCommon) return;
  if (window.__SFP_STEAM_SEARCH_LOADED__) return;
  window.__SFP_STEAM_SEARCH_LOADED__ = true;

  const BTN_ID = 'sfp-steam-search-floating';

  function isSearchPage() {
    return /\/search\/users\/?(\?|$|#)/.test(location.pathname + location.search + location.hash);
  }

  function ensureButton(onClick) {
    let btn = document.getElementById(BTN_ID);
    if (btn) return btn;
    btn = document.createElement('div');
    btn.id = BTN_ID;
    Object.assign(btn.style, {
      position: 'fixed', right: '20px', top: '130px', zIndex: '9999',
      background: 'linear-gradient(135deg, #1b2838, #2a475e)',
      color: '#66c0f4', border: '1px solid #66c0f4',
      padding: '10px 14px', borderRadius: '6px', cursor: 'pointer',
      fontSize: '13px', fontWeight: 'bold',
      boxShadow: '0 4px 14px rgba(0,0,0,0.45)',
      fontFamily: '"Motiva Sans", -apple-system, sans-serif',
      minWidth: '180px', textAlign: 'center', userSelect: 'none'
    });
    btn.onclick = onClick;
    (document.body || document.documentElement).appendChild(btn);
    return btn;
  }

  // 搜索结果通常为 .search_row，每个里面有用户链接
  function collectFromDom() {
    const ids = new Set();
    // 搜索结果页的链接形如 /profiles/<id>/<name>
    document.querySelectorAll('a[href*="steamcommunity.com/profiles/"]').forEach(a => {
      const m = a.href.match(/profiles\/(\d+)/);
      if (m) ids.add(m[1]);
    });
    // 兜底：search_row 里的 data-steamid
    document.querySelectorAll('.search_row[data-steamid]').forEach(el => {
      const id = el.dataset.steamid;
      if (id && /^7656119\d{10}$/.test(id)) ids.add(id);
    });
    return Array.from(ids);
  }

  // 搜索结果有翻页 ?p=N（部分情况）
  async function fetchPage(page) {
    try {
      const u = new URL(location.href);
      u.searchParams.set('p', String(page));
      // 保留 hash 里的 text
      const r = await fetch(u.toString(), { credentials: 'include', cache: 'no-store' });
      if (!r.ok) return [];
      const html = await r.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const ids = new Set();
      doc.querySelectorAll('a[href*="steamcommunity.com/profiles/"]').forEach(a => {
        const m = a.href.match(/profiles\/(\d+)/);
        if (m) ids.add(m[1]);
      });
      return Array.from(ids);
    } catch (e) { return []; }
  }

  async function scanAll(maxPages = 5) {
    const all = new Set(collectFromDom());
    for (let p = 1; p <= maxPages; p++) {
      const ids = await fetchPage(p);
      let added = 0;
      for (const id of ids) {
        if (!all.has(id)) { all.add(id); added++; }
      }
      if (added === 0) break;
    }
    return Array.from(all);
  }

  async function onClick() {
    const btn = ensureButton(() => {});
    btn.innerHTML = '<div style="font-size:10px;color:#67c1f5;margin-bottom:3px;letter-spacing:1px">SFP</div><div>扫描搜索结果…</div>';
    let ids;
    try {
      ids = await scanAll();
    } catch (e) {
      btn.innerHTML = `<div style="font-size:10px;color:#e15f5f;margin-bottom:3px">失败</div><div>${(e && e.message || e).toString().slice(0, 30)}</div>`;
      return;
    }
    if (ids.length === 0) {
      btn.innerHTML = '<div style="font-size:10px;color:#e1af5a;margin-bottom:3px">无结果</div><div>先在搜索框输入</div>';
      return;
    }
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SFP_ENQUEUE',
        ids,
        source: location.href,
        sourceType: 'steam-search'
      });
      btn.innerHTML = `<div style="font-size:10px;color:#67c1f5;margin-bottom:3px">已收割 ${resp.added}（重复 ${resp.duplicate}）</div><div>队列 ${resp.queueSize}</div>`;
    } catch (e) {
      btn.innerHTML = `<div style="font-size:10px;color:#e15f5f;margin-bottom:3px">入队失败</div><div>${(e && e.message || e).toString().slice(0, 30)}</div>`;
    }
  }

  setTimeout(() => { if (isSearchPage()) ensureButton(onClick); }, 1500);

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.remove();
      if (isSearchPage()) setTimeout(() => ensureButton(onClick), 1200);
    }
  }, 800);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'SFP_SCAN_STEAM_SEARCH') {
      scanAll().then(ids => sendResponse({ ids }));
      return true;
    }
  });
})();
