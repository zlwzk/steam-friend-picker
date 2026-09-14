// popup/popup.js —— 弹窗主控 v2（多 Tab）
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  queue: [], tried: {}, settings: { ...DEFAULT_SETTINGS_SHAPE },
  running: false, loggedIn: false,
  blacklist: {}, whitelist: {}, friends: {}, dailyCounts: {}, todayCount: 0,
  selected: new Set(),           // 队列里勾选的 steamid
  activeTab: 'queue',
  search: { queue: '', history: '' },
  filter: { log: 'all', logGroup: '', queueGroup: '' }
};

const DEFAULT_SETTINGS_SHAPE = {
  intervalMinMs: 8000, intervalMaxMs: 15000, maxPerRun: 30,
  retryOnRateLimit: true, maxRetries: 3,
  dailyQuota: 50, enableTimeWindow: false, timeWindowStart: 9, timeWindowEnd: 23,
  adaptiveInterval: true, notifyComplete: true,
  skipBlacklist: true, skipAlreadyFriends: true, autoAddBlockedToBlacklist: true,
  theme: 'dark',
  autoCheckUpdate: true, checkUpdateIntervalHours: 6, notifyUpdate: true
};

// ==================== 工具 ====================
const RE_STEAM64 = /\b(7656119[0-9]{10})\b/g;
const RE_PROFILE = /https?:\/\/steamcommunity\.com\/(?:id|profiles)\/([^\/\s"'<>?#]+)/gi;
const RE_BBCODE = /\[steam\]([^\[]+)\[\/steam\]/gi;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function toast(message, type = 'info', timeout = 2400) {
  const area = $('#toast-area');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  area.appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; }, timeout - 300);
  setTimeout(() => { el.remove(); }, timeout);
}

async function extractIdsFromText(text) {
  if (!text) return [];
  const direct = new Set(); const vanity = new Set();
  let m;
  const re1 = new RegExp(RE_STEAM64.source, 'g');
  while ((m = re1.exec(text))) direct.add(m[1]);
  const re2 = new RegExp(RE_PROFILE.source, 'gi');
  while ((m = re2.exec(text))) {
    const slug = (m[1] || '').trim();
    if (!slug) continue;
    if (/^\d{16,}$/.test(slug)) direct.add(slug);
    else vanity.add(slug);
  }
  const re3 = new RegExp(RE_BBCODE.source, 'gi');
  while ((m = re3.exec(text))) {
    const inner = (m[1] || '').trim();
    if (!inner) continue;
    if (/^\d{16,}$/.test(inner)) direct.add(inner);
    else vanity.add(inner);
  }
  if (vanity.size > 0) {
    try {
      const r = await sendMsg({ type: 'SFP_RESOLVE_VANITY', slugs: Array.from(vanity) });
      Object.values((r && r.map) || {}).forEach(id => { if (id) direct.add(id); });
    } catch (e) { /* ignore */ }
  }
  return Array.from(direct);
}

// ==================== 状态刷新 ====================
async function refreshStatus() {
  const resp = await sendMsg({ type: 'SFP_STATUS' });
  state.queue = resp.queue || [];
  state.settings = { ...DEFAULT_SETTINGS_SHAPE, ...(resp.settings || {}) };
  state.running = !!resp.running;
  state.blacklist = {}; state.whitelist = {}; state.friends = {};
  state.dailyCounts = resp.dailyCounts || {};
  state.todayCount = resp.todayCount || 0;

  const [triedResp, blResp, wlResp, frResp] = await Promise.all([
    sendMsg({ type: 'SFP_TRIED_GET' }),
    sendMsg({ type: 'SFP_BLACKLIST_GET' }),
    sendMsg({ type: 'SFP_WHITELIST_GET' }),
    sendMsg({ type: 'SFP_STATUS' })
  ]);
  state.tried = triedResp.tried || {};
  state.blacklist = blResp.blacklist || {};
  state.whitelist = wlResp.whitelist || {};

  // 登录态
  sendMsg({ type: 'SFP_LOGIN_CHECK' })
    .then(r => { state.loggedIn = !!r.loggedIn; renderBadges(); })
    .catch(() => { state.loggedIn = false; renderBadges(); });

  // 设置输入框
  $('#interval-min').value = Math.round((state.settings.intervalMinMs || 8000) / 1000);
  $('#interval-max').value = Math.round((state.settings.intervalMaxMs || 15000) / 1000);
  $('#max-per-run').value = state.settings.maxPerRun || 30;
  $('#daily-quota').value = state.settings.dailyQuota ?? 50;
  $('#retry-ratelimit').checked = state.settings.retryOnRateLimit !== false;
  $('#max-retries').value = state.settings.maxRetries ?? 3;
  $('#adaptive-interval').checked = state.settings.adaptiveInterval !== false;
  $('#enable-time-window').checked = !!state.settings.enableTimeWindow;
  $('#time-start').value = state.settings.timeWindowStart ?? 9;
  $('#time-end').value = state.settings.timeWindowEnd ?? 23;
  $('#notify-complete').checked = state.settings.notifyComplete !== false;
  $('#skip-blacklist').checked = state.settings.skipBlacklist !== false;
  $('#skip-friends').checked = state.settings.skipAlreadyFriends !== false;
  $('#auto-blacklist').checked = state.settings.autoAddBlockedToBlacklist !== false;
  $('#auto-check-update').checked = state.settings.autoCheckUpdate !== false;
  $('#check-update-interval').value = state.settings.checkUpdateIntervalHours ?? 6;
  $('#notify-update').checked = state.settings.notifyUpdate !== false;
  document.body.dataset.theme = state.settings.theme || 'dark';
  const themeRadio = document.querySelector(`input[name="theme"][value="${state.settings.theme || 'dark'}"]`);
  if (themeRadio) themeRadio.checked = true;

  // 重建分组下拉
  rebuildGroupFilter('queue-group-filter', state.queue);
  rebuildGroupFilter('log-group-filter', state.tried);

  renderBadges();
  renderQueue();
  renderLog();
  renderBlacklist();
  renderWhitelist();
  renderStats();
}

// ==================== Badges ====================
function renderBadges() {
  const ls = $('#login-status');
  if (state.loggedIn) { ls.textContent = '✓ 已登录'; ls.className = 'badge badge-ok'; }
  else { ls.textContent = '✗ 未登录'; ls.className = 'badge badge-err'; }
  const rs = $('#running-status');
  if (state.running) { rs.textContent = '⚡ 运行中'; rs.className = 'badge badge-ok'; }
  else { rs.textContent = '● 空闲'; rs.className = 'badge badge-mute'; }
  $('#queue-count').textContent = state.queue.length;
  $('#tried-count').textContent = Object.keys(state.tried).length;
  const q = state.settings.dailyQuota;
  $('#today-quota-badge').textContent = q > 0 ? `今日 ${state.todayCount}/${q}` : `今日 ${state.todayCount}`;
}

function rebuildGroupFilter(selId, items) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  const groups = new Set();
  if (Array.isArray(items)) {
    items.forEach(it => { const g = (typeof it === 'object' && it.group) || '其他'; groups.add(g); });
  } else if (items && typeof items === 'object') {
    Object.values(items).forEach(it => { const g = (it && it.group) || '其他'; groups.add(g); });
  }
  const cur = sel.value;
  sel.innerHTML = '<option value="">全部分组</option>' +
    Array.from(groups).sort().map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');
  sel.value = cur || '';
}

// ==================== Tab 切换 ====================
function switchTab(name) {
  state.activeTab = name;
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.tab === name));
  // 切到备份时刷新统计
  if (name === 'backup') renderStats();
}

// ==================== 队列渲染 ====================
function classifyResult(result) {
  if (!result) return { cls: 'failed', label: '?' };
  if (result.ok) return { cls: 'success', label: '✓ 已发邀请' };
  const e = result.error || '';
  if (e === 'AlreadyFriends') return { cls: 'already', label: '已是好友' };
  if (e === 'InvitePending') return { cls: 'invited', label: '邀请已发' };
  if (e === 'RateLimitExceeded') return { cls: 'ratelimited', label: '⚠ 限流' };
  if (/block/i.test(e)) return { cls: 'blocked', label: '被屏蔽' };
  return { cls: 'failed', label: e.replace(/^HTTP_/, 'HTTP ') };
}

function renderQueue() {
  const list = $('#queue-list');
  const search = state.search.queue.toLowerCase();
  const groupFilter = state.filter.queueGroup;

  let items = state.queue.slice();
  if (search) items = items.filter(it => {
    const id = typeof it === 'string' ? it : it.id;
    const src = (typeof it === 'object' && it.source) ? it.source : '';
    return id.toLowerCase().includes(search) || src.toLowerCase().includes(search);
  });
  if (groupFilter) items = items.filter(it => {
    const g = (typeof it === 'object' && it.group) || '其他';
    return g === groupFilter;
  });

  if (items.length === 0) {
    list.innerHTML = '<div class="empty">队列为空。<br>去小黑盒文章页 / Steam 主页 / 群组 / 搜索结果点悬浮按钮收割，或粘贴 ID 导入。</div>';
    updateBatchButtons();
    return;
  }
  const maxShow = 200;
  const slice = items.slice(0, maxShow);
  list.innerHTML = slice.map(item => {
    const id = typeof item === 'string' ? item : item.id;
    const src = (typeof item === 'object' && item.source) ? item.source : '';
    const group = (typeof item === 'object' && item.group) || '其他';
    const dispSrc = src.length > 50 ? src.slice(0, 50) + '…' : src;
    const isSel = state.selected.has(id);
    return `
      <div class="queue-item">
        <input type="checkbox" class="queue-check" data-id="${id}" ${isSel ? 'checked' : ''}>
        <span class="id" data-id="${id}" data-src="${escapeHtml(src)}" title="点击复制 / 双击打开 Steam 主页">${id}</span>
        <span class="group">${escapeHtml(group)}</span>
        <span class="src" title="${escapeHtml(src)}">${escapeHtml(dispSrc)}</span>
        <button class="remove-btn" data-id="${id}" title="移除">✕</button>
      </div>
    `;
  }).join('');
  if (items.length > maxShow) {
    list.innerHTML += `<div class="empty">还有 ${items.length - maxShow} 个未显示…</div>`;
  }
  bindQueueItemEvents();
  updateBatchButtons();
}

function bindQueueItemEvents() {
  $$('.queue-check').forEach(cb => {
    cb.onchange = () => {
      if (cb.checked) state.selected.add(cb.dataset.id);
      else state.selected.delete(cb.dataset.id);
      $('#queue-selected-count').textContent = `已选 ${state.selected.size}`;
      updateBatchButtons();
    };
  });
  $$('.queue-item .id').forEach(el => {
    el.onclick = async () => {
      const id = el.dataset.id;
      await navigator.clipboard.writeText(id).catch(() => {});
      toast(`已复制 ${id}`);
    };
    el.ondblclick = () => {
      const src = el.dataset.src || `https://steamcommunity.com/profiles/${el.dataset.id}`;
      // 优先用 src 里的 URL，否则拼
      const m = (src || '').match(/https?:\/\/[^\s"']+/);
      chrome.tabs.create({ url: m ? m[0] : `https://steamcommunity.com/profiles/${el.dataset.id}` });
    };
  });
  $$('.queue-item .remove-btn').forEach(btn => {
    btn.onclick = async () => {
      await sendMsg({ type: 'SFP_REMOVE_FROM_QUEUE', steamid: btn.dataset.id });
      state.selected.delete(btn.dataset.id);
      await refreshStatus();
    };
  });
}

function updateBatchButtons() {
  const n = state.selected.size;
  $('#queue-selected-count').textContent = `已选 ${n}`;
  $('#btn-batch-remove').disabled = n === 0;
  $('#btn-batch-blacklist').disabled = n === 0;
  $('#btn-batch-retry').disabled = n === 0;
  const allChecks = $$('.queue-check');
  $('#queue-select-all').checked = allChecks.length > 0 && Array.from(allChecks).every(c => c.checked);
  $('#queue-select-all').indeterminate = n > 0 && !($('#queue-select-all').checked);
}

// ==================== 历史渲染 ====================
function renderLog() {
  const list = $('#log-list');
  const statusFilter = $('#log-filter').value;
  const groupFilter = $('#log-group-filter').value;
  const search = $('#log-search').value.trim().toLowerCase();

  const entries = Object.entries(state.tried)
    .map(([id, rec]) => ({ id, ...rec }))
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  let filtered = entries;
  if (statusFilter !== 'all') filtered = filtered.filter(e => classifyResult(e.result).cls === statusFilter);
  if (groupFilter) filtered = filtered.filter(e => (e.group || '其他') === groupFilter);
  if (search) filtered = filtered.filter(e => e.id.includes(search));

  // 统计
  const stats = { success: 0, already: 0, invited: 0, ratelimited: 0, failed: 0, blocked: 0 };
  entries.forEach(e => { const c = classifyResult(e.result); if (stats[c.cls] !== undefined) stats[c.cls]++; });
  $('#log-stats').innerHTML = `
    <span style="color:var(--ok)">✓ ${stats.success}</span>
    <span style="color:var(--warn)">友 ${stats.already}</span>
    <span style="color:var(--warn)">邀 ${stats.invited}</span>
    <span style="color:var(--warn)">限 ${stats.ratelimited}</span>
    <span style="color:var(--err-2)">屏 ${stats.blocked}</span>
    <span style="color:var(--err-2)">败 ${stats.failed}</span>
    <span style="margin-left:auto">共 ${entries.length} 条</span>
  `;

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty">${entries.length === 0 ? '尚无记录' : '当前筛选下无记录'}</div>`;
    return;
  }
  list.innerHTML = filtered.slice(0, 100).map(e => {
    const c = classifyResult(e.result);
    return `
      <div class="log-item ${c.cls}">
        <span class="id" data-id="${e.id}">${e.id}</span>
        <span class="status">${escapeHtml(c.label)}</span>
        <span class="time">${fmtTime(e.timestamp)}</span>
      </div>
    `;
  }).join('');
  $$('.log-item .id').forEach(el => {
    el.onclick = () => chrome.tabs.create({ url: `https://steamcommunity.com/profiles/${el.dataset.id}` });
  });
}

// ==================== 黑/白名单渲染 ====================
function renderBlacklist() {
  const list = $('#blacklist-list');
  $('#blacklist-count').textContent = Object.keys(state.blacklist).length;
  const entries = Object.entries(state.blacklist).sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));
  if (entries.length === 0) {
    list.innerHTML = '<div class="empty">空黑名单。</div>';
    return;
  }
  list.innerHTML = entries.slice(0, 100).map(([id, rec]) => `
    <div class="blacklist-item">
      <span class="id" data-id="${id}">${id}</span>
      <span class="reason">${escapeHtml(rec.reason || '')}</span>
      ${rec.auto ? '<span class="auto-tag">自动</span>' : ''}
      <button class="remove-btn" data-id="${id}" title="移除">✕</button>
    </div>
  `).join('');
  $$('.blacklist-item .id').forEach(el => el.onclick = () => chrome.tabs.create({ url: `https://steamcommunity.com/profiles/${el.dataset.id}` }));
  $$('.blacklist-item .remove-btn').forEach(btn => btn.onclick = async () => {
    await sendMsg({ type: 'SFP_BLACKLIST_REMOVE', steamid: btn.dataset.id });
    toast('已移出黑名单', 'success');
    await refreshStatus();
  });
}

function renderWhitelist() {
  const list = $('#whitelist-list');
  $('#whitelist-count').textContent = Object.keys(state.whitelist).length;
  const entries = Object.entries(state.whitelist).sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));
  if (entries.length === 0) {
    list.innerHTML = '<div class="empty">空白名单。</div>';
    return;
  }
  list.innerHTML = entries.slice(0, 100).map(([id, rec]) => `
    <div class="whitelist-item">
      <span class="id" data-id="${id}">${id}</span>
      <span class="reason">${escapeHtml(rec.reason || '')}</span>
      <button class="remove-btn" data-id="${id}" title="移除">✕</button>
    </div>
  `).join('');
  $$('.whitelist-item .id').forEach(el => el.onclick = () => chrome.tabs.create({ url: `https://steamcommunity.com/profiles/${el.dataset.id}` }));
  $$('.whitelist-item .remove-btn').forEach(btn => btn.onclick = async () => {
    await sendMsg({ type: 'SFP_WHITELIST_REMOVE', steamid: btn.dataset.id });
    toast('已移出白名单', 'success');
    await refreshStatus();
  });
}

// ==================== 统计 ====================
function renderStats() {
  let success = 0, failed = 0;
  Object.values(state.tried).forEach(rec => {
    if (!rec || !rec.result) return;
    if (rec.result.ok) success++;
    else failed++;
  });
  $('#stat-total-success').textContent = success;
  $('#stat-total-failed').textContent = failed;
  $('#stat-today').textContent = state.todayCount;
  const quota = state.settings.dailyQuota || 0;
  $('#stat-quota-left').textContent = quota > 0 ? Math.max(0, quota - state.todayCount) : '∞';

  drawDailyChart();
}

function drawDailyChart() {
  const cvs = $('#daily-chart');
  if (!cvs) return;
  const ctx = cvs.getContext('2d');
  // 高 DPI 适配
  const dpr = window.devicePixelRatio || 1;
  const cssW = cvs.clientWidth || 520, cssH = cvs.clientHeight || 80;
  cvs.width = cssW * dpr; cvs.height = cssH * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  // 收集近 7 天
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    days.push({ key, label: `${d.getMonth()+1}/${d.getDate()}`, count: state.dailyCounts[key] || 0 });
  }
  const max = Math.max(1, ...days.map(d => d.count));

  // 配色（从 CSS 变量取）
  const cs = getComputedStyle(document.body);
  const colorBar = cs.getPropertyValue('--accent').trim() || '#66c0f4';
  const colorText = cs.getPropertyValue('--fg-3').trim() || '#8b95a1';
  const colorGrid = cs.getPropertyValue('--border').trim() || 'rgba(102,192,244,0.18)';

  const padding = { l: 26, r: 8, t: 6, b: 18 };
  const chartW = cssW - padding.l - padding.r;
  const chartH = cssH - padding.t - padding.b;
  const barW = Math.max(8, (chartW - (days.length - 1) * 6) / days.length);

  // 网格线
  ctx.strokeStyle = colorGrid; ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padding.t + (chartH * i) / 3;
    ctx.beginPath(); ctx.moveTo(padding.l, y); ctx.lineTo(cssW - padding.r, y); ctx.stroke();
    ctx.fillStyle = colorText; ctx.font = '9px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(String(Math.round(max - (max * i) / 3)), padding.l - 3, y + 3);
  }

  // 柱
  days.forEach((d, i) => {
    const x = padding.l + i * (barW + 6);
    const h = (d.count / max) * chartH;
    const y = padding.t + chartH - h;
    ctx.fillStyle = d.count > 0 ? colorBar : colorGrid;
    ctx.fillRect(x, y, barW, Math.max(2, h));
    ctx.fillStyle = colorText; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(d.label, x + barW / 2, cssH - 4);
    if (d.count > 0) ctx.fillText(String(d.count), x + barW / 2, y - 2);
  });
}

// ==================== 设置 ====================
async function saveSettings() {
  const settings = {
    intervalMinMs: Math.max(2000, parseInt($('#interval-min').value, 10) || 8) * 1000,
    intervalMaxMs: Math.max(2000, parseInt($('#interval-max').value, 10) || 15) * 1000,
    maxPerRun: Math.max(1, parseInt($('#max-per-run').value, 10) || 30),
    dailyQuota: Math.max(0, parseInt($('#daily-quota').value, 10) || 0),
    retryOnRateLimit: $('#retry-ratelimit').checked,
    maxRetries: Math.max(0, parseInt($('#max-retries').value, 10) || 3),
    adaptiveInterval: $('#adaptive-interval').checked,
    enableTimeWindow: $('#enable-time-window').checked,
    timeWindowStart: parseInt($('#time-start').value, 10) || 9,
    timeWindowEnd: parseInt($('#time-end').value, 10) || 23,
    notifyComplete: $('#notify-complete').checked,
    skipBlacklist: $('#skip-blacklist').checked,
    skipAlreadyFriends: $('#skip-friends').checked,
    autoAddBlockedToBlacklist: $('#auto-blacklist').checked,
    theme: document.querySelector('input[name="theme"]:checked')?.value || 'dark',
    autoCheckUpdate: $('#auto-check-update').checked,
    checkUpdateIntervalHours: Math.max(1, Math.min(168, parseInt($('#check-update-interval').value, 10) || 6)),
    notifyUpdate: $('#notify-update').checked
  };
  // 验证 min ≤ max
  if (settings.intervalMinMs > settings.intervalMaxMs) {
    toast('间隔 min 必须 ≤ max', 'error');
    await refreshStatus();
    return;
  }
  await sendMsg({ type: 'SFP_SAVE_SETTINGS', settings });
  state.settings = { ...DEFAULT_SETTINGS_SHAPE, ...settings };
  if (settings.theme) document.body.dataset.theme = settings.theme;
  renderBadges();
  toast('设置已保存', 'success');
}

// ==================== 操作 ====================
async function scanCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) { toast('找不到当前标签', 'error'); return; }
  const url = tab.url;
  let msgType, sourceType, scripts;
  if (/xiaoheihe\.cn/.test(url)) {
    msgType = 'SFP_SCAN_XIAOHEIHE_PAGE'; sourceType = 'xiaoheihe-comment';
    scripts = ['content/common.js', 'content/xiaoheihe.js'];
  } else if (/steamcommunity\.com\/groups\/.+\/members/.test(url)) {
    msgType = 'SFP_SCAN_STEAM_GROUP'; sourceType = 'steam-group-members';
    scripts = ['content/common.js', 'content/steam-group.js'];
  } else if (/steamcommunity\.com\/search\/users/.test(url)) {
    msgType = 'SFP_SCAN_STEAM_SEARCH'; sourceType = 'steam-search';
    scripts = ['content/common.js', 'content/steam-search.js'];
  } else if (/steamcommunity\.com/.test(url)) {
    msgType = 'SFP_SCAN_STEAM_PROFILE'; sourceType = 'steam-profile-friends';
    scripts = ['content/common.js', 'content/steam-profile.js'];
  } else {
    toast('当前页面不在支持范围（请打开 小黑盒 / Steam 个人主页 / 群组成员 / 搜索结果）', 'warn', 4000);
    return;
  }
  try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: scripts }); } catch (e) { /* 已注入 */ }
  let resp;
  try { resp = await chrome.tabs.sendMessage(tab.id, { type: msgType }); }
  catch (e) { toast('抓取失败：' + (e.message || e) + '\n请刷新目标页面重试', 'error', 4000); return; }
  const ids = (resp && resp.ids) || [];
  if (ids.length === 0) { toast('没找到 Steam ID', 'warn'); return; }
  const enq = await sendMsg({ type: 'SFP_ENQUEUE', ids, source: url, sourceType });
  toast(`抓到 ${ids.length} · 新增 ${enq.added} · 重复 ${enq.duplicate} · 黑名单 ${enq.skippedBlacklist || 0} · 已是好友 ${enq.skippedFriend || 0}`, 'success', 3500);
  state.selected.clear();
  await refreshStatus();
}

async function snapshotFriends() {
  toast('正在抓取你的好友列表…', 'info');
  const r = await sendMsg({ type: 'SFP_SNAPSHOT_FRIENDS' });
  if (r && r.error) { toast('失败：' + r.error, 'error', 4000); return; }
  toast(`已入库 ${r.count || 0} 个已知好友，入队时自动跳过`, 'success');
  await refreshStatus();
}

async function importText() {
  const text = prompt('粘贴 Steam ID 列表（每行一个，支持纯 17 位数字 / 主页链接 / BBCode）：', '');
  if (!text) return;
  const ids = await extractIdsFromText(text);
  if (ids.length === 0) { toast('没提取到任何 Steam ID', 'warn'); return; }
  const r = await sendMsg({ type: 'SFP_IMPORT_CSV', ids });
  toast(`导入 ${r.added} · 重复 ${r.duplicate} · 黑名单 ${r.skippedBlacklist || 0} · 已是好友 ${r.skippedFriend || 0}`, 'success');
  await refreshStatus();
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function exportCSV() {
  const r = await sendMsg({ type: 'SFP_EXPORT_CSV' });
  const lines = ['steam64,source,source_type,group,added_at,last_status,last_tried_at'];
  r.queue.forEach(item => {
    const id = typeof item === 'string' ? item : item.id;
    const src = (item.source || '');
    const st = item.sourceType || '';
    const g = item.group || '';
    const aa = item.addedAt ? new Date(item.addedAt).toISOString() : '';
    lines.push([csvEscape(id), csvEscape(src), csvEscape(st), csvEscape(g), csvEscape(aa), '', ''].join(','));
  });
  Object.entries(r.tried).forEach(([id, rec]) => {
    const c = classifyResult(rec.result);
    const t = new Date(rec.timestamp).toISOString();
    lines.push([csvEscape(id), '', 'history', csvEscape(rec.group || ''), csvEscape(t), csvEscape(c.cls), csvEscape(t)].join(','));
  });
  download('\uFEFF' + lines.join('\n'), `steam-friend-picker-${todayStr()}.csv`, 'text/csv;charset=utf-8');
}

async function exportBackup() {
  const r = await sendMsg({ type: 'SFP_EXPORT_BACKUP' });
  const json = JSON.stringify(r.data, null, 2);
  download(json, `sfp-backup-${todayStr()}.json`, 'application/json');
  toast('备份已导出', 'success');
}

async function importBackup() {
  if (!confirm('恢复 JSON 备份将合并/覆盖你的本地数据。\n\n点确定继续（默认合并，可在下一步选择是否覆盖）。')) return;
  // 用 file picker
  const input = document.createElement('input');
  input.type = 'file'; input.accept = '.json,application/json';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const text = await file.text();
    let data;
    try { data = JSON.parse(text); }
    catch (e) { toast('JSON 解析失败', 'error'); return; }
    if (!data.__sfp) { toast('不是有效的 SFP 备份文件', 'error'); return; }
    const merge = confirm('点「确定」= 合并到现有数据（推荐）\n点「取消」= 完全覆盖现有数据');
    const r = await sendMsg({ type: 'SFP_IMPORT_BACKUP', data, merge });
    toast(`已恢复：队列 ${r.queue} · 历史 ${r.tried} · 黑名单 ${r.blacklist} · 白名单 ${r.whitelist} · 好友对照 ${r.friends} · 设置 ${r.settings ? '是' : '否'}`, 'success', 4000);
    await refreshStatus();
  };
  input.click();
}

function download(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

async function startBatch() {
  if (!state.loggedIn) {
    if (!confirm('检测到未登录 Steam。继续运行会失败。\n要打开登录页吗？')) return;
    chrome.tabs.create({ url: 'https://steamcommunity.com/login/' });
    return;
  }
  if (state.queue.length === 0) { toast('队列为空，先抓取或导入', 'warn'); return; }
  $('#btn-start').disabled = true; $('#btn-stop').disabled = false;
  state.running = true; renderBadges();
  sendMsg({ type: 'SFP_START' }).catch(err => {
    toast('启动失败：' + (err.message || err), 'error');
    $('#btn-start').disabled = false; $('#btn-stop').disabled = true;
    state.running = false; renderBadges();
  });
}

async function stopBatch() {
  await sendMsg({ type: 'SFP_STOP' });
  toast('已请求停止', 'warn');
}

async function batchRemove() {
  if (state.selected.size === 0) return;
  await sendMsg({ type: 'SFP_REMOVE_FROM_QUEUE_BATCH', steamids: Array.from(state.selected) });
  toast(`已移除 ${state.selected.size} 个`, 'success');
  state.selected.clear();
  await refreshStatus();
}

async function batchBlacklist() {
  if (state.selected.size === 0) return;
  const ids = Array.from(state.selected);
  let n = 0;
  for (const id of ids) {
    const r = await sendMsg({ type: 'SFP_BLACKLIST_ADD', steamid: id, reason: 'queue-batch' });
    if (r && r.ok) n++;
  }
  toast(`已加入黑名单 ${n} 个`, 'success');
  state.selected.clear();
  await refreshStatus();
}

async function batchRetry() {
  if (state.selected.size === 0) return;
  const ids = Array.from(state.selected);
  // 清掉这些 ID 的历史记录，下一次调度器会把它们当新目标重新尝试
  await sendMsg({ type: 'SFP_CLEAR_TRIED_OF', steamidList: ids });
  toast(`已清历史 ${ids.length} 个，下次运行会重试`, 'success');
  state.selected.clear();
  await refreshStatus();
}

async function addToBlacklistFromInput() {
  const text = $('#blacklist-input').value.trim();
  if (!text) return;
  const ids = await extractIdsFromText(text);
  if (ids.length === 0) { toast('没提取到 Steam ID', 'warn'); return; }
  let n = 0;
  for (const id of ids) {
    const r = await sendMsg({ type: 'SFP_BLACKLIST_ADD', steamid: id, reason: 'manual' });
    if (r && r.ok) n++;
  }
  toast(`已加黑名单 ${n} 个`, 'success');
  $('#blacklist-input').value = '';
  await refreshStatus();
}

async function addAllQueueToBlacklist() {
  if (state.queue.length === 0) { toast('队列为空', 'warn'); return; }
  if (!confirm(`确认把队列里 ${state.queue.length} 个全部加入黑名单？`)) return;
  for (const it of state.queue) {
    const id = typeof it === 'string' ? it : it.id;
    await sendMsg({ type: 'SFP_BLACKLIST_ADD', steamid: id, reason: 'queue-all' });
  }
  toast(`已全部加入黑名单`, 'success');
  await refreshStatus();
}

async function addToWhitelistFromInput() {
  const text = $('#whitelist-input').value.trim();
  if (!text) return;
  const ids = await extractIdsFromText(text);
  if (ids.length === 0) { toast('没提取到 Steam ID', 'warn'); return; }
  let n = 0;
  for (const id of ids) {
    const r = await sendMsg({ type: 'SFP_WHITELIST_ADD', steamid: id, reason: 'manual' });
    if (r && r.ok) n++;
  }
  toast(`已加白名单 ${n} 个`, 'success');
  $('#whitelist-input').value = '';
  await refreshStatus();
}

// ==================== 自动更新 ====================
function fmtDate(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  } catch (e) { return ''; }
}

function relTime(ms) {
  if (!ms) return '从未';
  const diff = Date.now() - ms;
  if (diff < 60 * 1000) return `${Math.floor(diff / 1000)} 秒前`;
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

async function loadUpdateState() {
  try {
    const r = await sendMsg({ type: 'SFP_UPDATE_STATE' });
    if (r && r.state) renderUpdateBanner(r.state);
    if (r && r.currentVersion) {
      const badge = $('#version-badge');
      badge.textContent = `v${r.currentVersion}`;
      badge.title = `当前 v${r.currentVersion} · 点击立即检查更新`;
    }
  } catch (e) { /* ignore */ }
}

function renderUpdateBanner(s) {
  if (!s) return;
  const banner = $('#update-banner');
  const badge = $('#version-badge');
  const hint = $('#update-status-hint');

  // 版本徽章样式：有更新时变橙色
  if (s.hasUpdate) {
    badge.classList.add('update-available');
    badge.title = `当前 v${s.currentVersion} → 最新 v${s.latestVersion} · 点击立即检查更新`;
  } else {
    badge.classList.remove('update-available');
  }

  // Banner
  if (s.hasUpdate) {
    const date = fmtDate(s.publishedAt);
    $('#update-banner-detail').textContent = `v${s.latestVersion} · ${date || '已发布'} · 当前 v${s.currentVersion}`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  // 设置页 hint
  if (hint) {
    if (s.lastError) {
      hint.textContent = `检查失败：${s.lastError} · 上次 ${relTime(s.lastCheckedAt)}`;
    } else if (!s.latestVersion) {
      hint.textContent = `尚未检查过（首次安装 1 分钟后会自动跑）`;
    } else {
      const cmp = s.hasUpdate ? '🆕 有新版本' : '✓ 已是最新';
      hint.textContent = `${cmp} v${s.latestVersion} · 上次检查 ${relTime(s.lastCheckedAt)}`;
    }
  }
}

async function manualCheckUpdate() {
  const btn = $('#btn-check-update');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '⏳ 检查中…';
  try {
    const r = await sendMsg({ type: 'SFP_CHECK_UPDATE' });
    if (r && r.error) {
      toast('检查失败：' + r.error, 'error', 4000);
    } else if (r && r.noRelease) {
      toast('GitHub 仓库尚未发布任何 release', 'warn', 4000);
    } else if (r && r.state) {
      renderUpdateBanner(r.state);
      if (r.state.hasUpdate) toast(`🆕 发现新版本 v${r.state.latestVersion}`, 'success', 4000);
      else toast(`✓ 已是最新 v${r.state.latestVersion}`, 'success', 3000);
    }
  } catch (e) {
    toast('检查出错：' + (e.message || e), 'error', 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = oldText;
  }
}

// ==================== 监听后台进度 ====================
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'SFP_PROGRESS') {
    state.running = true;
    if (msg.payload && msg.payload.lastResult) state.tried[msg.payload.lastResult.steamid] = msg.payload.lastResult;
    renderBadges();
    renderLog();
    renderStats();
    if (msg.payload && msg.payload.stats) {
      const s = msg.payload.stats;
      const adapt = msg.payload.adaptive && msg.payload.adaptive > 1.05 ? ` ×${msg.payload.adaptive.toFixed(1)}` : '';
      $('#running-status').textContent = `⚡ ${msg.payload.processed}/${msg.payload.total}${adapt} · ✓${s.success} 友${s.already} 邀${s.invited} 限${s.ratelimited} 败${s.failed}${s.blocked ? ' 屏' + s.blocked : ''}`;
      $('#running-status').className = 'badge badge-ok';
    }
    if (typeof msg.payload.queueSize === 'number') {
      $('#queue-count').textContent = msg.payload.queueSize;
      if (msg.payload.queueSize === 0) { state.queue = []; renderQueue(); }
    }
  } else if (msg.type === 'SFP_DONE') {
    state.running = false;
    $('#btn-start').disabled = false; $('#btn-stop').disabled = true;
    if (msg.payload && msg.payload.error) {
      toast(msg.payload.error, 'error', 4000);
    } else if (msg.payload) {
      const s = msg.payload.stats || {};
      toast(`完成 ✓${s.success} · 友${s.already} · 邀${s.invited} · 限${s.ratelimited} · 败${s.failed}`, 'success', 4000);
    }
    refreshStatus();
  } else if (msg.type === 'SFP_UPDATE_STATE') {
    renderUpdateBanner(msg.payload);
  }
});

// ==================== 初始化 ====================
async function init() {
  // refreshStatus 抛错不能阻止后续事件绑定（否则「按钮无反应」）
  try {
    await refreshStatus();
  } catch (e) {
    console.error('[SFP] init refreshStatus failed:', e);
    toast('初始加载失败：' + ((e && e.message) || e), 'error', 4000);
  }

  // Tab
  $$('.tab-btn').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

  // 队列
  $('#btn-scan-current').onclick = scanCurrentPage;
  $('#btn-import').onclick = importText;
  $('#btn-snapshot-friends').onclick = snapshotFriends;
  $('#btn-clear-queue').onclick = async () => {
    if (state.queue.length === 0) return;
    if (!confirm(`确认清空 ${state.queue.length} 个队列项？`)) return;
    await sendMsg({ type: 'SFP_CLEAR_QUEUE' });
    state.selected.clear();
    await refreshStatus();
  };
  $('#btn-start').onclick = startBatch;
  $('#btn-stop').onclick = stopBatch;

  // 队列过滤 / 勾选
  $('#queue-search').oninput = (e) => { state.search.queue = e.target.value; renderQueue(); };
  $('#queue-group-filter').onchange = (e) => { state.filter.queueGroup = e.target.value; renderQueue(); };
  $('#queue-select-all').onchange = (e) => {
    $$('.queue-check').forEach(cb => {
      cb.checked = e.target.checked;
      if (e.target.checked) state.selected.add(cb.dataset.id);
      else state.selected.delete(cb.dataset.id);
    });
    updateBatchButtons();
  };
  $('#btn-batch-remove').onclick = batchRemove;
  $('#btn-batch-blacklist').onclick = batchBlacklist;
  $('#btn-batch-retry').onclick = batchRetry;

  // 历史
  $('#log-filter').onchange = renderLog;
  $('#log-group-filter').onchange = renderLog;
  $('#log-search').oninput = renderLog;
  $('#btn-clear-history').onclick = async () => {
    const n = Object.keys(state.tried).length;
    if (n === 0) return;
    if (!confirm(`确认清空 ${n} 条历史？\n清空后这些 ID 会被视为新目标。`)) return;
    await sendMsg({ type: 'SFP_CLEAR_TRIED' });
    await refreshStatus();
  };

  // 黑/白名单
  $('#btn-blacklist-add').onclick = addToBlacklistFromInput;
  $('#btn-blacklist-add-current').onclick = addAllQueueToBlacklist;
  $('#btn-whitelist-add').onclick = addToWhitelistFromInput;

  // 设置（全部 onchange 自动保存）
  ['interval-min','interval-max','max-per-run','daily-quota','max-retries',
   'retry-ratelimit','adaptive-interval','enable-time-window','time-start','time-end',
   'notify-complete','skip-blacklist','skip-friends','auto-blacklist',
   'auto-check-update','check-update-interval','notify-update'].forEach(id => {
    $(`#${id}`).onchange = saveSettings;
  });
  $$('input[name="theme"]').forEach(r => r.onchange = saveSettings);

  // 备份
  $('#btn-export-csv').onclick = exportCSV;
  $('#btn-export-backup').onclick = exportBackup;
  $('#btn-import-csv').onclick = importText;
  $('#btn-import-backup').onclick = importBackup;

  // 自动更新
  $('#btn-check-update').onclick = manualCheckUpdate;
  $('#btn-open-release').onclick = () => sendMsg({ type: 'SFP_OPEN_RELEASE' });
  $('#btn-update-open').onclick = () => sendMsg({ type: 'SFP_OPEN_RELEASE' });
  $('#btn-update-dismiss').onclick = () => { $('#update-banner').classList.add('hidden'); };
  $('#version-badge').onclick = manualCheckUpdate;

  // 重绘图表（主题切换 / 窗口大小变化时）
  window.addEventListener('resize', () => { if (state.activeTab === 'backup') drawDailyChart(); });
  new MutationObserver(() => { if (state.activeTab === 'backup') drawDailyChart(); })
    .observe(document.body, { attributes: true, attributeFilter: ['data-theme'] });

  // 加载更新状态
  await loadUpdateState();
}

init();
