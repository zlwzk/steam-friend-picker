// content/xiaoheihe.js —— 注入到小黑盒文章/讨论页，抓评论区里的 Steam ID
(function () {
  'use strict';
  if (!window.SFPCommon) return;
  if (window.__SFP_XIAOHEIHE_LOADED__) return;
  window.__SFP_XIAOHEIHE_LOADED__ = true;

  const FLOATING_ID = 'sfp-xhh-floating';
  let lastIds = []; // 最近一次扫描结果（供 Popup 读取）

  function ensureFloating(count, onClick) {
    let btn = document.getElementById(FLOATING_ID);
    if (!btn) {
      btn = document.createElement('button');
      btn.id = FLOATING_ID;
      btn.type = 'button';
      Object.assign(btn.style, {
        position: 'fixed',
        right: '20px',
        bottom: '80px',
        zIndex: '2147483646',
        background: 'linear-gradient(135deg, #1b2838, #2a475e)',
        color: '#66c0f4',
        border: '1px solid #66c0f4',
        padding: '10px 16px',
        borderRadius: '8px',
        cursor: 'pointer',
        fontSize: '13px',
        fontWeight: 'bold',
        boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
        fontFamily: '"Motiva Sans", -apple-system, "Microsoft YaHei", sans-serif'
      });
      btn.onmouseenter = () => { btn.style.transform = 'translateY(-1px)'; };
      btn.onmouseleave = () => { btn.style.transform = 'translateY(0)'; };
      btn.onclick = onClick;
      (document.body || document.documentElement).appendChild(btn);
    }
    btn.textContent = count > 0
      ? `🎮 收割 ${count} 个 Steam ID`
      : '🎮 扫描 Steam ID';
    btn.dataset.count = String(count);
    btn.disabled = false;
    return btn;
  }

  // 尝试点"加载更多评论"，触发懒加载
  async function tryExpandComments() {
    const keywords = /展开更多|查看更多|加载更多|more comments|更多回复|更多评论/i;
    let clicked = 0;
    document.querySelectorAll('button, a, span, div').forEach(el => {
      if (clicked > 5) return;
      const t = (el.innerText || el.textContent || '').trim();
      if (t && t.length < 30 && keywords.test(t)) {
        try {
          el.click();
          clicked++;
        } catch (e) { /* ignore */ }
      }
    });
    if (clicked > 0) await new Promise(r => setTimeout(r, 1200));
  }

  // 从评论区范围抓取文本
  function collectCommentText() {
    // 小黑盒评论区容器猜测
    const candidates = [
      '[class*="comment"]',
      '[class*="Comment"]',
      '[class*="reply"]',
      '[class*="Reply"]',
      '[class*="discussion"]',
      '[class*="Discussion"]',
      '[class*="floor"]',
      '[class*="Floor"]',
      '[id*="comment"]',
      'article + *',
      'main'
    ];
    for (const sel of candidates) {
      const nodes = document.querySelectorAll(sel);
      if (nodes.length === 0) continue;
      let text = '';
      nodes.forEach(n => { text += '\n' + (n.innerText || n.textContent || ''); });
      if (text.length > 200) return text;
    }
    return document.body ? (document.body.innerText || '') : '';
  }

  async function scanComments() {
    await tryExpandComments();
    const text = collectCommentText();
    const ids = await window.SFPCommon.extractSteamIdsFromText(text);
    return ids;
  }

  // 主流程：扫描 → 显示按钮 → 持续监听 DOM 变化
  let scanTimer = null;
  async function refreshScan() {
    const ids = await scanComments();
    lastIds = ids;
    ensureFloating(ids.length, onHarvestClick);
  }

  async function onHarvestClick() {
    const btn = document.getElementById(FLOATING_ID);
    if (!btn) return;
    const ids = lastIds.length > 0 ? lastIds : await scanComments();
    if (ids.length === 0) {
      btn.textContent = '⚠ 没找到 Steam ID';
      setTimeout(refreshScan, 1500);
      return;
    }
    btn.disabled = true;
    btn.textContent = '⏳ 加入队列…';
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SFP_ENQUEUE',
        ids,
        source: location.href,
        sourceType: 'xiaoheihe-comment'
      });
      btn.textContent = `✓ 新增 ${resp.added} / 队列 ${resp.queueSize}`;
      setTimeout(refreshScan, 2500);
    } catch (e) {
      btn.textContent = '✗ 失败：' + (e && e.message || e);
      setTimeout(refreshScan, 2500);
    }
  }

  // Popup 也可远程触发扫描
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'SFP_SCAN_XIAOHEIHE_PAGE') {
      scanComments().then(ids => {
        lastIds = ids;
        sendResponse({ ids });
      });
      return true; // 异步
    }
  });

  // 首次扫描 + 监听评论区加载（点击"加载更多"）
  setTimeout(refreshScan, 1500);

  const observer = new MutationObserver(() => {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(refreshScan, 1500);
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
})();
