// background/service-worker.js —— 后台服务 v2
//
// 职责：
//   1. Steam AddFriendAjax 调用 + 错误码归类
//   2. 队列调度（间隔、限流、日配额、时段、自适应）
//   3. Vanity URL → Steam64 解析
//   4. 入队前过滤（黑名单 / 白名单 / 已知好友）
//   5. 完成时桌面通知
//   6. JSON 全量备份/恢复
//   7. 当前账号好友列表快照（用于入队去重）
//
// 存储键：
//   sfp_queue           [{ id, source, sourceType, group, addedAt, status }]
//   sfp_tried           { [steamid]: { steamid, timestamp, result, group } }
//   sfp_blacklist       { [steamid]: { reason, timestamp, auto } }
//   sfp_whitelist       { [steamid]: { reason, timestamp } }
//   sfp_known_friends   { [steamid]: timestamp }
//   sfp_profile_cache   { [steamid]: { name, avatar, lastlogoff, vac, gameCount, cachedAt } }
//   sfp_daily_count     { 'YYYY-MM-DD': count }
//   sfp_settings        { ... }
//   sfp_running         boolean

const QUEUE_KEY = 'sfp_queue';
const TRIED_KEY = 'sfp_tried';
const SETTINGS_KEY = 'sfp_settings';
const RUNNING_KEY = 'sfp_running';
const BLACKLIST_KEY = 'sfp_blacklist';
const WHITELIST_KEY = 'sfp_whitelist';
const FRIENDS_KEY = 'sfp_known_friends';
const PROFILE_CACHE_KEY = 'sfp_profile_cache';
const DAILY_KEY = 'sfp_daily_count';

const DEFAULT_SETTINGS = {
  intervalMinMs: 8000,
  intervalMaxMs: 15000,
  maxPerRun: 30,
  retryOnRateLimit: true,
  maxRetries: 3,

  // 新增
  dailyQuota: 50,                    // 每日最多加 N 人（0 = 不限）
  enableTimeWindow: false,           // 是否启用时段限制
  timeWindowStart: 9,                // 24h 制
  timeWindowEnd: 23,
  adaptiveInterval: true,            // 限流命中自动拉长间隔
  notifyComplete: true,              // 完成桌面通知
  skipBlacklist: true,               // 入队前跳过黑名单
  skipAlreadyFriends: true,          // 入队前跳过已知好友
  autoAddBlockedToBlacklist: true,   // 被 Block 自动进黑名单
  theme: 'dark'                      // dark / light
};

const STATE = {
  abortRequested: false,
  consecutiveRateLimit: 0,
  adaptiveMultiplier: 1.0,
  batchStartedAt: 0
};

// ---------- 存储 ----------
async function getSettings() {
  const { [SETTINGS_KEY]: s } = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}
async function saveSettings(s) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, ...s } });
}
async function isRunning() { const { [RUNNING_KEY]: r } = await chrome.storage.local.get(RUNNING_KEY); return !!r; }
async function setRunning(flag) { await chrome.storage.local.set({ [RUNNING_KEY]: !!flag }); }
async function getQueue() { const { [QUEUE_KEY]: q } = await chrome.storage.local.get(QUEUE_KEY); return Array.isArray(q) ? q : []; }
async function setQueue(q) { await chrome.storage.local.set({ [QUEUE_KEY]: q }); }
async function getTried() { const { [TRIED_KEY]: t } = await chrome.storage.local.get(TRIED_KEY); return t || {}; }
async function setTried(t) { await chrome.storage.local.set({ [TRIED_KEY]: t }); }
async function getBlacklist() { const { [BLACKLIST_KEY]: b } = await chrome.storage.local.get(BLACKLIST_KEY); return b || {}; }
async function setBlacklist(b) { await chrome.storage.local.set({ [BLACKLIST_KEY]: b }); }
async function getWhitelist() { const { [WHITELIST_KEY]: w } = await chrome.storage.local.get(WHITELIST_KEY); return w || {}; }
async function setWhitelist(w) { await chrome.storage.local.set({ [WHITELIST_KEY]: w }); }
async function getKnownFriends() { const { [FRIENDS_KEY]: f } = await chrome.storage.local.get(FRIENDS_KEY); return f || {}; }
async function setKnownFriends(f) { await chrome.storage.local.set({ [FRIENDS_KEY]: f }); }
async function getProfileCache() { const { [PROFILE_CACHE_KEY]: p } = await chrome.storage.local.get(PROFILE_CACHE_KEY); return p || {}; }
async function setProfileCache(p) { await chrome.storage.local.set({ [PROFILE_CACHE_KEY]: p }); }

async function getDailyCounts() {
  const { [DAILY_KEY]: d } = await chrome.storage.local.get(DAILY_KEY);
  return d || {};
}
async function setDailyCounts(d) { await chrome.storage.local.set({ [DAILY_KEY]: d }); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
async function getTodayCount() {
  const counts = await getDailyCounts();
  return counts[todayStr()] || 0;
}
async function incTodayCount(n) {
  const counts = await getDailyCounts();
  const today = todayStr();
  counts[today] = (counts[today] || 0) + n;
  // 只保留最近 30 天
  const dates = Object.keys(counts).sort();
  while (dates.length > 30) {
    delete counts[dates.shift()];
  }
  await setDailyCounts(counts);
}

// ---------- 工具 ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function rand(min, max) { return Math.floor(min + Math.random() * (max - min)); }
async function broadcast(msg) {
  try { await chrome.runtime.sendMessage(msg); } catch (e) { /* popup closed */ }
}

/** sourceType → 中文分组名 */
function inferGroup(sourceType) {
  switch (sourceType) {
    case 'xiaoheihe-comment': return '小黑盒评论';
    case 'steam-profile-friends': return 'Steam 好友列表';
    case 'steam-group-members': return 'Steam 群组';
    case 'steam-search': return 'Steam 搜索';
    case 'csv-import': return '导入';
    case 'manual': return '手动';
    default: return '其他';
  }
}

// ---------- Steam 接口 ----------
async function getSessionIdFromCookie() {
  try {
    const c = await chrome.cookies.get({ url: 'https://steamcommunity.com', name: 'sessionid' });
    return c?.value || null;
  } catch (e) { return null; }
}
async function checkLoggedIn() {
  const sid = await getSessionIdFromCookie();
  if (!sid) return false;
  try {
    const r = await fetch('https://steamcommunity.com/my/', {
      credentials: 'include', redirect: 'manual', cache: 'no-store'
    });
    return r.status === 200;
  } catch (e) { return false; }
}
async function addFriendAjax(steamid64, sessionid) {
  const body = new URLSearchParams({
    sessionid, steamid: String(steamid64), accept_invite: '0'
  });
  const r = await fetch('https://steamcommunity.com/actions/AddFriendAjax', {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://steamcommunity.com',
      'Referer': 'https://steamcommunity.com/'
    },
    body: body.toString()
  });
  if (!r.ok) {
    return { ok: false, httpStatus: r.status, error: `HTTP_${r.status}`, raw: (await r.text().catch(() => '')).slice(0, 300) };
  }
  let data; try { data = await r.json(); } catch (e) { data = {}; }
  return {
    ok: !!data.success,
    error: data.success ? null : (data.error || data.Error || 'UnknownError'),
    raw: data
  };
}
async function resolveVanityBatch(slugs) {
  const map = {};
  await Promise.all(slugs.map(async slug => {
    if (!slug) return;
    try {
      const u = `https://steamcommunity.com/id/${encodeURIComponent(slug)}/?xml=1`;
      const r = await fetch(u, { credentials: 'omit', cache: 'no-store' });
      if (!r.ok) return;
      const txt = await r.text();
      const m = txt.match(/<steamID64>(\d+)<\/steamID64>/);
      if (m) map[slug] = m[1];
    } catch (e) { /* skip */ }
  }));
  return map;
}

/** 抓某人 Steam 个人主页 XML 拿元数据（用于入队前预览 + 智能筛选） */
async function fetchProfileMeta(steamid64) {
  // 缓存 1 小时
  const cache = await getProfileCache();
  const hit = cache[steamid64];
  if (hit && (Date.now() - hit.cachedAt) < 3600 * 1000) return hit;
  try {
    const r = await fetch(`https://steamcommunity.com/profiles/${steamid64}/?xml=1`, { credentials: 'omit', cache: 'no-store' });
    if (!r.ok) return null;
    const txt = await r.text();
    const pick = (tag) => {
      const m = txt.match(new RegExp(`<${tag}>([^<]*)<\/${tag}>`));
      return m ? m[1] : null;
    };
    const meta = {
      name: pick('steamID'),
      avatar: pick('avatarFull') || pick('avatarMedium') || pick('avatarIcon'),
      lastlogoff: parseInt(pick('lastLogoff') || '0', 10) || 0,
      vac: pick('vacBanned') === '1',
      gameCount: parseInt(pick('gameCount') || '0', 10) || 0,
      cachedAt: Date.now()
    };
    cache[steamid64] = meta;
    await setProfileCache(cache);
    return meta;
  } catch (e) {
    return null;
  }
}

/** 抓某人好友列表全部 ID（用于已知好友对照表） */
async function snapshotFriendsList(steamid64) {
  // 优先用传入的 steamid64；否则从 sessionid 拿自己的
  let ownId = steamid64;
  if (!ownId) {
    // 没办法直接拿到当前用户的 steam64，只能从 /my/ 页面抓
    try {
      const r = await fetch('https://steamcommunity.com/my/', { credentials: 'include', redirect: 'follow' });
      const html = await r.text();
      const m = html.match(/"steamid"\s*:\s*"?(\d{16,})"?/);
      if (m) ownId = m[1];
    } catch (e) { return { error: 'fetch my page failed' }; }
  }
  if (!ownId) return { error: 'cannot resolve own steamid' };

  const ids = new Set();
  // 翻页：p=1.. 直到重复
  for (let p = 1; p <= 30; p++) {
    try {
      const u = `https://steamcommunity.com/profiles/${ownId}/friends/?p=${p}`;
      const r = await fetch(u, { credentials: 'include', cache: 'no-store' });
      if (!r.ok) break;
      const html = await r.text();
      let added = 0;
      const re = /steamcommunity\.com\/profiles\/(\d+)/g;
      let m;
      while ((m = re.exec(html))) {
        const id = m[1];
        if (id !== ownId && !ids.has(id)) {
          ids.add(id);
          added++;
        }
      }
      if (added === 0) break;
    } catch (e) { break; }
  }
  // 也尝试 id 形式
  if (ids.size === 0) {
    // 从 cookie 拿 steamLoginSecure 解析（base64），但较复杂，跳过
  }

  const friends = await getKnownFriends();
  const now = Date.now();
  for (const id of ids) friends[id] = now;
  await setKnownFriends(friends);
  return { count: ids.size };
}

// ---------- 入队（带过滤） ----------
async function enqueueIds(ids, source, sourceType) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { added: 0, duplicate: 0, skippedBlacklist: 0, skippedWhitelist: 0, skippedFriend: 0, queueSize: 0 };
  }
  const [queue, tried, blacklist, whitelist, friends, settings] = await Promise.all([
    getQueue(), getTried(), getBlacklist(), getWhitelist(), getKnownFriends(), getSettings()
  ]);
  const inQueue = new Set(queue.map(x => typeof x === 'string' ? x : x.id));

  let added = 0, duplicate = 0, skippedBlacklist = 0, skippedWhitelist = 0, skippedFriend = 0, skippedInvalid = 0;
  const now = Date.now();
  const group = inferGroup(sourceType);
  const addedItems = [];

  for (const id of ids) {
    if (typeof id !== 'string' || !/^7656119\d{10}$/.test(id)) { skippedInvalid++; continue; }
    if (settings.skipBlacklist && blacklist[id]) { skippedBlacklist++; continue; }
    if (whitelist[id]) { skippedWhitelist++; continue; }
    if (settings.skipAlreadyFriends && friends[id]) { skippedFriend++; continue; }
    if (inQueue.has(id) || tried[id]) { duplicate++; continue; }

    queue.push({
      id,
      source: source || 'unknown',
      sourceType: sourceType || 'unknown',
      group,
      addedAt: now,
      status: 'pending'
    });
    inQueue.add(id);
    added++;
    addedItems.push(id);
  }
  await setQueue(queue);
  return { added, duplicate, skippedBlacklist, skippedWhitelist, skippedFriend, skippedInvalid, queueSize: queue.length, addedItems };
}

// ---------- 主调度 ----------
async function runBatch() {
  if (await isRunning()) return { skipped: 'already-running' };
  await setRunning(true);
  STATE.abortRequested = false;
  STATE.consecutiveRateLimit = 0;
  STATE.adaptiveMultiplier = 1.0;
  STATE.batchStartedAt = Date.now();

  try {
    const sid = await getSessionIdFromCookie();
    if (!sid) {
      const msg = '未登录 Steam（缺少 sessionid cookie）。请先打开 https://steamcommunity.com 登录。';
      await broadcast({ type: 'SFP_DONE', payload: { error: msg } });
      await safeNotify('Steam 好友收割机', msg);
      return { error: msg };
    }

    const settings = await getSettings();
    let queue = await getQueue();
    const tried = await getTried();
    const blacklist = await getBlacklist();
    const friends = await getKnownFriends();

    // 时段检查
    if (settings.enableTimeWindow) {
      const h = new Date().getHours();
      if (h < settings.timeWindowStart || h >= settings.timeWindowEnd) {
        const msg = `当前 ${h} 点不在设置的 ${settings.timeWindowStart}~${settings.timeWindowEnd} 时段内，已暂停。`;
        await broadcast({ type: 'SFP_DONE', payload: { error: msg } });
        return { error: msg };
      }
    }

    // 日配额检查
    const todayBefore = await getTodayCount();
    if (settings.dailyQuota > 0 && todayBefore >= settings.dailyQuota) {
      const msg = `今日已加 ${todayBefore} 人，达到日配额 ${settings.dailyQuota}，明天再来。`;
      await broadcast({ type: 'SFP_DONE', payload: { error: msg } });
      await safeNotify('Steam 好友收割机', msg);
      return { error: msg };
    }
    const quotaLeft = settings.dailyQuota > 0 ? (settings.dailyQuota - todayBefore) : Infinity;
    const effectiveMaxPerRun = Math.min(settings.maxPerRun, quotaLeft);

    const stats = { success: 0, already: 0, invited: 0, ratelimited: 0, failed: 0, blocked: 0, skippedBlacklist: 0 };
    let processed = 0;
    let processedToday = 0;

    while (queue.length > 0 && processed < effectiveMaxPerRun && !STATE.abortRequested) {
      const head = queue[0];
      const steamid = typeof head === 'string' ? head : head.id;

      // 黑名单 / 好友二次过滤（防止设置开关变化）
      if (settings.skipBlacklist && blacklist[steamid]) {
        stats.skippedBlacklist++;
        queue.shift();
        await setQueue(queue);
        continue;
      }
      if (settings.skipAlreadyFriends && friends[steamid]) {
        queue.shift();
        await setQueue(queue);
        continue;
      }
      if (tried[steamid]) {
        queue.shift();
        await setQueue(queue);
        continue;
      }

      let result = await addFriendAjax(steamid, sid);
      let retries = 0;

      while (!result.ok && result.error === 'RateLimitExceeded' && settings.retryOnRateLimit && retries < settings.maxRetries && !STATE.abortRequested) {
        retries++;
        STATE.consecutiveRateLimit++;
        // 自适应间隔：每次重试都拉长
        if (settings.adaptiveInterval) {
          STATE.adaptiveMultiplier = Math.min(3.0, STATE.adaptiveMultiplier + 0.5);
        }
        await broadcast({
          type: 'SFP_PROGRESS',
          payload: { processed, total: effectiveMaxPerRun, lastResult: { steamid, timestamp: Date.now(), result }, stats, queueSize: queue.length - 1, retrying: true, retryInSec: 30, adaptive: STATE.adaptiveMultiplier }
        });
        await sleep(30000);
        if (STATE.abortRequested) break;
        result = await addFriendAjax(steamid, sid);
      }

      if (result.ok) {
        STATE.consecutiveRateLimit = 0;
        if (settings.adaptiveInterval) STATE.adaptiveMultiplier = Math.max(1.0, STATE.adaptiveMultiplier - 0.1);
      }

      const record = { steamid, timestamp: Date.now(), result, group: (typeof head === 'object' && head.group) || '其他' };
      tried[steamid] = record;
      await setTried(tried);

      if (result.ok) {
        stats.success++;
        processedToday++;
      } else if (result.error === 'AlreadyFriends') {
        stats.already++;
        processedToday++;
      } else if (result.error === 'InvitePending') {
        stats.invited++;
        processedToday++;
      } else if (result.error === 'RateLimitExceeded') {
        stats.ratelimited++;
      } else if (result.error && /block/i.test(result.error)) {
        stats.blocked++;
        processedToday++;
        // 自动加入黑名单
        if (settings.autoAddBlockedToBlacklist) {
          blacklist[steamid] = { reason: result.error, timestamp: Date.now(), auto: true };
          await setBlacklist(blacklist);
        }
      } else {
        stats.failed++;
        processedToday++;
      }

      processed++;
      queue.shift();
      await setQueue(queue);

      await broadcast({
        type: 'SFP_PROGRESS',
        payload: {
          processed,
          total: effectiveMaxPerRun,
          lastResult: record,
          stats,
          queueSize: queue.length,
          adaptive: STATE.adaptiveMultiplier
        }
      });

      if (queue.length === 0 || processed >= effectiveMaxPerRun) break;

      const baseMin = settings.intervalMinMs * STATE.adaptiveMultiplier;
      const baseMax = settings.intervalMaxMs * STATE.adaptiveMultiplier;
      const wait = rand(baseMin, baseMax);
      await sleep(wait);
    }

    if (processedToday > 0) await incTodayCount(processedToday);

    const finalPayload = {
      processed,
      stats,
      aborted: STATE.abortRequested,
      remaining: queue.length,
      addedToDaily: processedToday,
      adaptive: STATE.adaptiveMultiplier,
      elapsedMs: Date.now() - STATE.batchStartedAt
    };
    await broadcast({ type: 'SFP_DONE', payload: finalPayload });

    if (settings.notifyComplete && !STATE.abortRequested && processed > 0) {
      await safeNotify('Steam 好友收割机 · 完成', `成功 ${stats.success} · 已是好友 ${stats.already} · 邀请已发 ${stats.invited} · 限流 ${stats.ratelimited} · 失败 ${stats.failed}`);
    }

    return finalPayload;
  } catch (e) {
    const msg = e && e.message || String(e);
    await broadcast({ type: 'SFP_DONE', payload: { error: msg } });
    return { error: msg };
  } finally {
    await setRunning(false);
  }
}

async function safeNotify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/128.png',
      title,
      message,
      priority: 0
    });
  } catch (e) { /* notifications 权限可能未授予 */ }
}

// ---------- 黑/白名单管理 ----------
async function addToBlacklist(steamid, reason, auto = false) {
  if (!/^7656119\d{10}$/.test(steamid)) return { error: 'invalid steamid' };
  const b = await getBlacklist();
  if (b[steamid]) return { ok: true, existed: true };
  b[steamid] = { reason: reason || 'manual', timestamp: Date.now(), auto };
  await setBlacklist(b);
  // 同步从队列里删
  const queue = await getQueue();
  const filtered = queue.filter(item => {
    const id = typeof item === 'string' ? item : item.id;
    return id !== steamid;
  });
  if (filtered.length !== queue.length) await setQueue(filtered);
  return { ok: true };
}
async function removeFromBlacklist(steamid) {
  const b = await getBlacklist();
  if (!b[steamid]) return { ok: true, existed: false };
  delete b[steamid];
  await setBlacklist(b);
  return { ok: true };
}
async function addToWhitelist(steamid, reason) {
  if (!/^7656119\d{10}$/.test(steamid)) return { error: 'invalid steamid' };
  const w = await getWhitelist();
  if (w[steamid]) return { ok: true, existed: true };
  w[steamid] = { reason: reason || 'manual', timestamp: Date.now() };
  await setWhitelist(w);
  return { ok: true };
}
async function removeFromWhitelist(steamid) {
  const w = await getWhitelist();
  if (!w[steamid]) return { ok: true, existed: false };
  delete w[steamid];
  await setWhitelist(w);
  return { ok: true };
}

// ---------- JSON 备份/恢复 ----------
async function exportAll() {
  const [queue, tried, blacklist, whitelist, friends, settings, dailyCounts, profileCache] = await Promise.all([
    getQueue(), getTried(), getBlacklist(), getWhitelist(), getKnownFriends(), getSettings(), getDailyCounts(), getProfileCache()
  ]);
  return {
    __sfp: 'backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    queue, tried, blacklist, whitelist, friends, settings, dailyCounts, profileCache
  };
}

async function importAll(data, opts = {}) {
  if (!data || data.__sfp !== 'backup') return { error: '不是有效的 SFP 备份文件' };
  const merge = opts.merge !== false;
  const out = { queue: 0, tried: 0, blacklist: 0, whitelist: 0, friends: 0, settings: false };

  if (Array.isArray(data.queue)) {
    if (merge) {
      const cur = await getQueue();
      const existing = new Set(cur.map(x => typeof x === 'string' ? x : x.id));
      for (const it of data.queue) {
        const id = typeof it === 'string' ? it : it.id;
        if (id && !existing.has(id)) { cur.push(it); existing.add(id); out.queue++; }
      }
      await setQueue(cur);
    } else {
      await setQueue(data.queue);
      out.queue = data.queue.length;
    }
  }
  if (data.tried && typeof data.tried === 'object') {
    const cur = merge ? await getTried() : {};
    const merged = merge ? { ...cur, ...data.tried } : data.tried;
    await setTried(merged);
    out.tried = Object.keys(data.tried).length;
  }
  if (data.blacklist && typeof data.blacklist === 'object') {
    const cur = merge ? await getBlacklist() : {};
    await setBlacklist(merge ? { ...cur, ...data.blacklist } : data.blacklist);
    out.blacklist = Object.keys(data.blacklist).length;
  }
  if (data.whitelist && typeof data.whitelist === 'object') {
    const cur = merge ? await getWhitelist() : {};
    await setWhitelist(merge ? { ...cur, ...data.whitelist } : data.whitelist);
    out.whitelist = Object.keys(data.whitelist).length;
  }
  if (data.friends && typeof data.friends === 'object') {
    const cur = merge ? await getKnownFriends() : {};
    await setKnownFriends(merge ? { ...cur, ...data.friends } : data.friends);
    out.friends = Object.keys(data.friends).length;
  }
  if (data.settings && typeof data.settings === 'object') {
    await saveSettings(data.settings);
    out.settings = true;
  }
  return out;
}

// ---------- 消息路由 ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'SFP_ENQUEUE': {
          const r = await enqueueIds(msg.ids, msg.source, msg.sourceType);
          sendResponse(r);
          break;
        }
        case 'SFP_RESOLVE_VANITY': {
          const map = await resolveVanityBatch(Array.isArray(msg.slugs) ? msg.slugs : []);
          sendResponse({ map });
          break;
        }
        case 'SFP_FETCH_PROFILE': {
          const meta = await fetchProfileMeta(msg.steamid);
          sendResponse({ meta });
          break;
        }
        case 'SFP_START': {
          if (await isRunning()) { sendResponse({ skipped: 'already-running' }); break; }
          runBatch().then(sendResponse).catch(err => sendResponse({ error: String(err) }));
          break;
        }
        case 'SFP_STOP': {
          STATE.abortRequested = true;
          sendResponse({ ok: true });
          break;
        }
        case 'SFP_STATUS': {
          const [queue, tried, settings, running, blacklist, whitelist, friends, daily] = await Promise.all([
            getQueue(), getTried(), getSettings(), isRunning(),
            getBlacklist(), getWhitelist(), getKnownFriends(), getDailyCounts()
          ]);
          sendResponse({
            queue, triedCount: Object.keys(tried).length, settings, running,
            blacklistCount: Object.keys(blacklist).length,
            whitelistCount: Object.keys(whitelist).length,
            friendsCount: Object.keys(friends).length,
            dailyCounts: daily,
            todayCount: daily[todayStr()] || 0
          });
          break;
        }
        case 'SFP_BLACKLIST_GET': {
          sendResponse({ blacklist: await getBlacklist() });
          break;
        }
        case 'SFP_BLACKLIST_ADD': {
          const r = await addToBlacklist(msg.steamid, msg.reason || 'manual', false);
          sendResponse(r);
          break;
        }
        case 'SFP_BLACKLIST_REMOVE': {
          const r = await removeFromBlacklist(msg.steamid);
          sendResponse(r);
          break;
        }
        case 'SFP_WHITELIST_GET': {
          sendResponse({ whitelist: await getWhitelist() });
          break;
        }
        case 'SFP_WHITELIST_ADD': {
          const r = await addToWhitelist(msg.steamid, msg.reason || 'manual');
          sendResponse(r);
          break;
        }
        case 'SFP_WHITELIST_REMOVE': {
          const r = await removeFromWhitelist(msg.steamid);
          sendResponse(r);
          break;
        }
        case 'SFP_LOGIN_CHECK': {
          sendResponse({ loggedIn: await checkLoggedIn() });
          break;
        }
        case 'SFP_TRIED_GET': {
          sendResponse({ tried: await getTried() });
          break;
        }
        case 'SFP_CLEAR_QUEUE': {
          await setQueue([]);
          sendResponse({ ok: true });
          break;
        }
        case 'SFP_CLEAR_TRIED': {
          await setTried({});
          sendResponse({ ok: true });
          break;
        }
        case 'SFP_CLEAR_TRIED_OF': {
          const tried = await getTried();
          const targets = new Set(Array.isArray(msg.steamidList) ? msg.steamidList : []);
          let n = 0;
          for (const id of targets) { if (tried[id]) { delete tried[id]; n++; } }
          await setTried(tried);
          sendResponse({ ok: true, cleared: n });
          break;
        }
        case 'SFP_REMOVE_FROM_QUEUE': {
          const queue = await getQueue();
          const filtered = queue.filter(item => {
            const id = typeof item === 'string' ? item : item.id;
            return id !== msg.steamid;
          });
          await setQueue(filtered);
          sendResponse({ ok: true, removed: queue.length - filtered.length });
          break;
        }
        case 'SFP_REMOVE_FROM_QUEUE_BATCH': {
          const queue = await getQueue();
          const targets = new Set(Array.isArray(msg.steamids) ? msg.steamids : []);
          const filtered = queue.filter(item => {
            const id = typeof item === 'string' ? item : item.id;
            return !targets.has(id);
          });
          await setQueue(filtered);
          sendResponse({ ok: true, removed: queue.length - filtered.length });
          break;
        }
        case 'SFP_EXPORT_CSV': {
          const [queue, tried] = await Promise.all([getQueue(), getTried()]);
          sendResponse({ queue, tried });
          break;
        }
        case 'SFP_IMPORT_CSV': {
          const r = await enqueueIds(msg.ids || [], 'imported', msg.sourceType || 'csv-import');
          sendResponse(r);
          break;
        }
        case 'SFP_EXPORT_BACKUP': {
          const data = await exportAll();
          sendResponse({ data });
          break;
        }
        case 'SFP_IMPORT_BACKUP': {
          const r = await importAll(msg.data, { merge: msg.merge !== false });
          sendResponse(r);
          break;
        }
        case 'SFP_SNAPSHOT_FRIENDS': {
          const r = await snapshotFriendsList(msg.steamid);
          sendResponse(r);
          break;
        }
        case 'SFP_SAVE_SETTINGS': {
          await saveSettings(msg.settings || {});
          sendResponse({ ok: true });
          break;
        }
        case 'SFP_GET_DAILY': {
          sendResponse({ dailyCounts: await getDailyCounts(), today: todayStr() });
          break;
        }
        default:
          sendResponse({ error: 'unknown message type: ' + (msg && msg.type) });
      }
    } catch (e) {
      sendResponse({ error: String(e && e.message || e) });
    }
  })();
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  await saveSettings(await getSettings());
});
