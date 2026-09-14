// update/update.js —— 浏览器内一键更新器（v1.2.0 起，无需桌面脚本）
// 流程：检查 release → 选扩展文件夹（记住授权）→ 下载 zip（进度）→ 解压 → 写入 → 引导重新加载
'use strict';

const REPO = 'zlwzk/steam-friend-picker';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;

const $ = (sel) => document.querySelector(sel);

const ui = {
  curVer: $('#cur-version'),
  statusIcon: $('#status-icon'),
  statusLine: $('#status-line'),
  statusSub: $('#status-sub'),
  verCompare: $('#ver-compare'),
  verOld: $('#ver-old'),
  verNew: $('#ver-new'),
  verDate: $('#ver-date'),
  notesCard: $('#notes-card'),
  notes: $('#release-notes'),
  dirStatus: $('#dir-status'),
  btnPickDir: $('#btn-pick-dir'),
  progressCard: $('#progress-card'),
  steps: { dl: $('#step-dl'), un: $('#step-un'), wr: $('#step-wr') },
  details: { dl: $('#dl-detail'), un: $('#un-detail'), wr: $('#wr-detail') },
  barFill: $('#bar-fill'),
  barText: $('#bar-text'),
  btnUpdate: $('#btn-update'),
  btnRecheck: $('#btn-recheck'),
  doneCard: $('#done-card'),
  doneVer: $('#done-ver'),
  btnOpenExt: $('#btn-open-ext'),
};

let release = null;      // { tag, version, notes, assetUrl, assetSize, publishedAt }
let dirHandle = null;    // 扩展所在文件夹

// ==================== 版本工具 ====================
function stripTagPrefix(t) { return String(t || '').replace(/^[vV]/, ''); }
function verParts(v) {
  return String(v || '').split('.').map(n => parseInt(n, 10) || 0);
}
function compareVersions(a, b) {
  const A = verParts(a), B = verParts(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const d = (A[i] || 0) - (B[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ==================== IndexedDB（记住文件夹授权） ====================
function openIdb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('sfp-updater', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v) {
  const db = await openIdb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, k);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(k) {
  const db = await openIdb();
  return new Promise((res, rej) => {
    const tx = db.transaction('kv', 'readonly');
    const rq = tx.objectStore('kv').get(k);
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}

// ==================== zip 解压（central directory + DecompressionStream） ====================
async function unzip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const td = new TextDecoder();
  // 找 EOCD（End of Central Directory）
  let eocd = -1;
  const scanStart = Math.max(0, u8.byteLength - 22 - 65536);
  for (let i = u8.byteLength - 22; i >= scanStart; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 结构异常：找不到 EOCD');
  const count = dv.getUint16(eocd + 10, true);
  let ptr = dv.getUint32(eocd + 16, true);
  const rawEntries = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(ptr, true) !== 0x02014b50) throw new Error('zip 结构异常：central directory 损坏');
    const method = dv.getUint16(ptr + 10, true);
    const csize = dv.getUint32(ptr + 20, true);
    const nameLen = dv.getUint16(ptr + 28, true);
    const extraLen = dv.getUint16(ptr + 30, true);
    const commentLen = dv.getUint16(ptr + 32, true);
    const lho = dv.getUint32(ptr + 42, true);
    const name = td.decode(u8.subarray(ptr + 46, ptr + 46 + nameLen)).replace(/\\/g, '/'); // 兼容 PS Compress-Archive 的反斜杠分隔符
    ptr += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.split('/').pop().startsWith('.') || !name.split('/').pop()) continue; // 跳过目录与隐藏文件
    rawEntries.push({ name, method, csize, lho });
  }
  // 解压每个文件
  const entries = [];
  for (let i = 0; i < rawEntries.length; i++) {
    const e = rawEntries[i];
    const nl = dv.getUint16(e.lho + 26, true);
    const el = dv.getUint16(e.lho + 28, true);
    const off = e.lho + 30 + nl + el;
    const comp = u8.subarray(off, off + e.csize);
    let data;
    if (e.method === 0) {
      data = comp;
    } else if (e.method === 8) {
      const ds = new DecompressionStream('deflate-raw');
      const buf = await new Response(new Blob([comp]).stream().pipeThrough(ds)).arrayBuffer();
      data = new Uint8Array(buf);
    } else {
      throw new Error(`不支持的压缩方式：${e.method}`);
    }
    entries.push({ name: e.name, data });
    reportStep('un', i + 1, rawEntries.length, `${i + 1}/${rawEntries.length} 个文件`);
  }
  return entries;
}

// 剥掉统一的顶层目录（asset zip 顶层是 steam-friend-picker/，zipball 是 <repo>-<sha>/）
function stripTopDir(entries) {
  if (entries.length === 0) return entries;
  const top = entries[0].name.split('/')[0];
  if (!top || !entries.every(e => e.name.startsWith(top + '/'))) return entries;
  return entries.map(e => ({ name: e.name.slice(top.length + 1), data: e.data }));
}

// ==================== 下载（流式进度） ====================
async function fetchWithProgress(url, onProgress) {
  const r = await fetch(url, { headers: { 'Accept': 'application/octet-stream' } });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}`);
  const total = parseInt(r.headers.get('content-length') || '0', 10);
  const reader = r.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }
  const buf = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf;
}

// ==================== 写入文件夹 ====================
async function writeEntries(root, entries) {
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const parts = e.name.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let dh = root;
    for (let j = 0; j < parts.length - 1; j++) {
      dh = await dh.getDirectoryHandle(parts[j], { create: true });
    }
    const fh = await dh.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable();
    await w.write(e.data);
    await w.close();
    reportStep('wr', i + 1, entries.length, `${i + 1}/${entries.length} · ${e.name}`);
  }
}

// ==================== UI ====================
function setStep(key, state, detail) {
  const el = ui.steps[key];
  el.className = 'step' + (state ? ' ' + state : '');
  const dot = el.querySelector('.dot');
  dot.textContent = state === 'done' ? '✓' : state === 'error' ? '✗' : ({ dl: '1', un: '2', wr: '3' }[key]);
  if (detail !== undefined) ui.details[key].textContent = detail;
}
function reportStep(key, done, total, text) {
  setStep(key, 'active', text);
}
function setBar(pct, text) {
  ui.barFill.style.width = pct + '%';
  ui.barText.textContent = text || Math.round(pct) + '%';
}
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 发布`;
}

async function refreshDirStatus() {
  if (!dirHandle) {
    ui.dirStatus.textContent = '未选择';
    ui.dirStatus.className = 'dir-status';
    return;
  }
  try {
    await dirHandle.getFileHandle('manifest.json'); // 校验确实像扩展目录
  } catch (e) {
    ui.dirStatus.textContent = `「${dirHandle.name}」里没有 manifest.json，请重新选择`;
    ui.dirStatus.className = 'dir-status';
    return;
  }
  ui.dirStatus.textContent = `✓ ${dirHandle.name}`;
  ui.dirStatus.className = 'dir-status ok';
}

function refreshUpdateButton() {
  ui.btnUpdate.disabled = !(release && release.hasUpdate && dirHandle);
}

// ==================== 检查更新 ====================
async function checkUpdate() {
  release = null;
  ui.statusIcon.textContent = '⏳';
  ui.statusLine.textContent = '正在检查更新…';
  ui.statusSub.textContent = '查询 GitHub 最新 release';
  ui.verCompare.classList.add('hidden');
  ui.notesCard.classList.add('hidden');
  ui.doneCard.classList.add('hidden');
  ui.progressCard.classList.add('hidden');
  refreshUpdateButton();
  try {
    const cur = chrome.runtime.getManifest().version;
    ui.curVer.textContent = `v${cur}`;
    const r = await fetch(API_LATEST, { headers: { 'Accept': 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`GitHub API HTTP ${r.status}`);
    const data = await r.json();
    const latest = stripTagPrefix(data.tag_name);
    const asset = (data.assets || []).find(a => /\.zip$/i.test(a.name || ''));
    release = {
      tag: data.tag_name,
      version: latest,
      notes: (data.body || '').slice(0, 4000),
      assetUrl: asset ? asset.browser_download_url : data.zipball_url,
      assetSize: asset ? asset.size : 0,
      publishedAt: data.published_at,
      hasUpdate: compareVersions(latest, cur) > 0,
      current: cur,
    };
    if (release.hasUpdate) {
      ui.statusIcon.textContent = '🆕';
      ui.statusLine.textContent = `发现新版本 v${latest}`;
      ui.statusSub.textContent = '点下方「🚀 一键更新」开始（下载 → 解压 → 写入，全自动）';
      ui.curVer.classList.add('update-available');
      ui.curVer.title = `当前 v${cur} → 最新 v${latest}`;
      ui.verOld.textContent = `v${cur}`;
      ui.verNew.textContent = `v${latest}`;
      ui.verDate.textContent = fmtDate(data.published_at);
      ui.verCompare.classList.remove('hidden');
      ui.notes.textContent = release.notes || '（发布页有完整说明）';
      ui.notesCard.classList.remove('hidden');
    } else {
      ui.statusIcon.textContent = '✅';
      ui.statusLine.textContent = `已是最新版本 v${latest}`;
      ui.statusSub.textContent = '无需更新。也可以点「重新检查」再确认一次。';
      ui.curVer.classList.remove('update-available');
    }
  } catch (e) {
    ui.statusIcon.textContent = '⚠️';
    ui.statusLine.textContent = '检查更新失败';
    ui.statusSub.textContent = String(e && e.message || e) + '（GitHub 偶尔抽风，可点「重新检查」重试）';
  }
  refreshUpdateButton();
}

// ==================== 选择文件夹 ====================
async function pickDir() {
  try {
    const h = await window.showDirectoryPicker({ mode: 'readwrite', id: 'sfp-ext-dir' });
    dirHandle = h;
    await idbSet('ext-dir', h);
    await refreshDirStatus();
    refreshUpdateButton();
  } catch (e) {
    if (e && e.name !== 'AbortError') {
      ui.dirStatus.textContent = '选择失败：' + (e.message || e);
    }
  }
}

// 恢复上次授权的文件夹
async function restoreDir() {
  try {
    const h = await idbGet('ext-dir');
    if (!h) return;
    if (await h.queryPermission({ mode: 'readwrite' }) === 'granted') {
      dirHandle = h;
    }
  } catch (e) { /* ignore */ }
  await refreshDirStatus();
}

// ==================== 一键更新 ====================
async function runUpdate() {
  if (!release || !release.hasUpdate || !dirHandle) return;
  // 需要用户手势内补授权（浏览器重启后授权会失效）
  if (await dirHandle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
    const p = await dirHandle.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') {
      ui.statusSub.textContent = '未获得文件夹写入权限，请重新点「🚀 一键更新」并在弹窗中允许';
      return;
    }
  }
  ui.btnUpdate.disabled = true;
  ui.btnRecheck.disabled = true;
  ui.btnPickDir.disabled = true;
  ui.doneCard.classList.add('hidden');
  ui.progressCard.classList.remove('hidden');
  setStep('dl', 'active', '准备下载…');
  setStep('un', '');
  setStep('wr', '');
  ui.details.un.textContent = '';
  ui.details.wr.textContent = '';
  setBar(0);

  const phases = { dl: 0.55, un: 0.1, wr: 0.35 }; // 各阶段占总进度权重
  let phaseDone = 0;

  try {
    // 1) 下载
    const buf = await fetchWithProgress(release.assetUrl, (recv, total) => {
      const t = total || release.assetSize || 0;
      const pct = t ? Math.min(100, recv / t * 100) : 0;
      setStep('dl', 'active', `${(recv / 1024).toFixed(1)} KB${t ? ` / ${(t / 1024).toFixed(1)} KB` : ''}`);
      setBar((phaseDone + phases.dl * pct / 100) * 100, `下载中 ${pct ? Math.round(pct) + '%' : ''}`);
    });
    setStep('dl', 'done', `${(buf.byteLength / 1024).toFixed(1)} KB`);
    phaseDone += phases.dl;
    setBar(phaseDone * 100, '下载完成');

    // 2) 解压
    setStep('un', 'active', '');
    let entries = await unzip(buf);
    entries = stripTopDir(entries);
    if (!entries.some(e => e.name === 'manifest.json')) throw new Error('更新包里没有 manifest.json，包结构异常');
    setStep('un', 'done', `${entries.length} 个文件`);
    phaseDone += phases.un;
    setBar(phaseDone * 100, '解压完成');

    // 3) 写入
    setStep('wr', 'active', '');
    await writeEntries(dirHandle, entries);
    setStep('wr', 'done', `${entries.length} 个文件已写入`);
    setBar(100, '✓ 全部完成');

    // 完成
    ui.doneVer.textContent = release.version;
    ui.doneCard.classList.remove('hidden');
    ui.statusIcon.textContent = '✅';
    ui.statusLine.textContent = `已更新到 v${release.version}`;
    ui.statusSub.textContent = `写入目标：${dirHandle.name}`;
    ui.doneCard.scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    ['dl', 'un', 'wr'].forEach(k => {
      if (ui.steps[k].classList.contains('active')) setStep(k, 'error');
    });
    setBar(0, '❌ 失败');
    ui.statusIcon.textContent = '⚠️';
    ui.statusLine.textContent = '更新失败';
    ui.statusSub.textContent = String(e && e.message || e) + '（可点「重新检查」后重试）';
  } finally {
    ui.btnUpdate.disabled = false;
    ui.btnRecheck.disabled = false;
    ui.btnPickDir.disabled = false;
    refreshUpdateButton();
  }
}

// ==================== 事件 ====================
ui.btnPickDir.onclick = pickDir;
ui.btnRecheck.onclick = checkUpdate;
ui.btnUpdate.onclick = runUpdate;
ui.btnOpenExt.onclick = () => {
  // Edge / Chrome 的扩展管理页
  const isEdge = navigator.userAgent.includes('Edg/');
  chrome.tabs.create({ url: isEdge ? 'edge://extensions/' : 'chrome://extensions/' });
};

// ==================== 启动 ====================
(async function init() {
  // 同步主题
  try {
    const { sfp_settings: s } = await chrome.storage.local.get('sfp_settings');
    if (s && s.theme) document.body.dataset.theme = s.theme;
  } catch (e) { /* ignore */ }
  await restoreDir();
  await checkUpdate();
})();
