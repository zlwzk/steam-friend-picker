// content/steam-group.js —— Steam 群组成员列表注入
// 匹配 /groups/<name>/members?p=N 翻页结构
(function () {
  'use strict';
  if (!window.SFPCommon) return;
  if (window.__SFP_STEAM_GROUP_LOADED__) return;
  window.__SFP_STEAM_GROUP_LOADED__ = true;

  const BTN_ID = 'sfp-steam-group-floating';

  function isGroupMembersPage() {
    return /\/groups\/.+\/members\/?(\?|$)/.test(location.pathname + location.search);
  }

  function ensureButton(onClick) {
    let btn = document.getElementById(BTN_ID);
    if (btn) return btn;
    btn = document.createElement('div');
    btn.id = BTN_ID;
    Object.assign(btn.style, {
      position: 'fixed', right: '20px', top: '90px', zIndex: '9999',
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
    return Array.from(ids);
  }

  async function fetchPage(page) {
    try {
      const u = new URL(location.href);
      u.searchParams.set('p', String(page));
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
    } catch (e) {
      return [];
    }
  }

  async function scanAll(maxPages = 10) {
    const all = new Set(collectFromDom());

    // 自动翻页直到重复
    for (let p = 1; p <= maxPages; p++) {
      const ids = await fetchPage(p);
      let added = 0;
      for (const id of ids) {
        if (!all.has(id)) { all.add(id); added++; }
      }
      if (added === 0) break; // 没有新内容，停止
    }
    return Array.from(all);
  }

  async function onClick() {
    const btn = ensureButton(() => {});
    btn.innerHTML = '<div style="font-size:10px;color:#67c1f5;margin-bottom:3px;letter-spacing:1px">SFP</div><div>扫描群成员…</div>';
    let ids;
    try {
      ids = await scanAll();
    } catch (e) {
      btn.innerHTML = `<div style="font-size:10px;color:#e15f5f;margin-bottom:3px">失败</div><div>${(e && e.message || e).toString().slice(0, 30)}</div>`;
      return;
    }
    if (ids.length === 0) {
      btn.innerHTML = '<div style="font-size:10px;color:#e1af5a;margin-bottom:3px">无结果</div><div>群成员为空？</div>';
      return;
    }
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SFP_ENQUEUE',
        ids,
        source: location.href,
        sourceType: 'steam-group-members'
      });
      btn.innerHTML = `<div style="font-size:10px;color:#67c1f5;margin-bottom:3px">已收割 ${resp.added}（重复 ${resp.duplicate}）</div><div>队列 ${resp.queueSize}</div>`;
    } catch (e) {
      btn.innerHTML = `<div style="font-size:10px;color:#e15f5f;margin-bottom:3px">入队失败</div><div>${(e && e.message || e).toString().slice(0, 30)}</div>`;
    }
  }

  // 首次注入
  setTimeout(() => { if (isGroupMembersPage()) ensureButton(onClick); }, 1500);

  // SPA 路由变化
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      const btn = document.getElementById(BTN_ID);
      if (btn) btn.remove();
      if (isGroupMembersPage()) setTimeout(() => ensureButton(onClick), 1200);
    }
  }, 800);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'SFP_SCAN_STEAM_GROUP') {
      scanAll().then(ids => sendResponse({ ids }));
      return true;
    }
  });
})();
