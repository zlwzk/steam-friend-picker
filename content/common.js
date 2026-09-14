// content/common.js —— 内容脚本共享：Steam ID 提取 & 自定义 URL 解析
// 通过 window.SFPCommon 暴露给其他 content 脚本使用
(function (global) {
  'use strict';
  if (global.SFPCommon) return; // 防重复注入

  // 17 位 Steam64 ID
  const STEAM64_REGEX = /\b(7656119[0-9]{10})\b/g;
  // Steam 社区个人主页链接（捕获 slug）
  const PROFILE_URL_REGEX = /https?:\/\/steamcommunity\.com\/(?:id|profiles)\/([^\/\s"'<>?#]+)/gi;
  // 小黑盒 BBCode 签名档 [steam]xxx[/steam]
  const STEAM_BBCODE_REGEX = /\[steam\]([^\[]+)\[\/steam\]/gi;

  /**
   * 把一组自定义 URL（vanity）解析成 Steam64，去重并跳过空值。
   * 实际工作交给 background（避免 content script 受 CORS 限制）。
   */
  async function resolveVanityViaBackground(slugs) {
    if (!Array.isArray(slugs) || slugs.length === 0) return {};
    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'SFP_RESOLVE_VANITY',
        slugs: Array.from(new Set(slugs.filter(Boolean)))
      });
      return (resp && resp.map) || {};
    } catch (e) {
      return {};
    }
  }

  /**
   * 从一段文本中提取所有可用的 Steam64。
   * - 纯 17 位数字 → 直接收
   * - /profiles/<数字> → 直接收
   * - /id/<自定义> 或 BBCode 内非数字 → 交给 background 解析
   */
  async function extractSteamIdsFromText(text, opts) {
    const resolveVanity = !opts || opts.resolveVanity !== false;
    if (!text) return [];
    const found = new Set();
    const vanity = new Set();

    // 1) 纯 Steam64
    let m;
    const re1 = new RegExp(STEAM64_REGEX.source, 'g');
    while ((m = re1.exec(text))) found.add(m[1]);

    // 2) 个人主页链接
    const re2 = new RegExp(PROFILE_URL_REGEX.source, 'gi');
    while ((m = re2.exec(text))) {
      const slug = (m[1] || '').trim();
      if (!slug) continue;
      if (/^\d{16,}$/.test(slug)) found.add(slug);
      else if (resolveVanity) vanity.add(slug);
    }

    // 3) BBCode 签名档
    const re3 = new RegExp(STEAM_BBCODE_REGEX.source, 'gi');
    while ((m = re3.exec(text))) {
      const inner = (m[1] || '').trim();
      if (!inner) continue;
      if (/^\d{16,}$/.test(inner)) found.add(inner);
      else if (resolveVanity) vanity.add(inner);
    }

    if (vanity.size > 0) {
      const map = await resolveVanityViaBackground(Array.from(vanity));
      Object.values(map).forEach(id => { if (id) found.add(id); });
    }

    return Array.from(found);
  }

  /**
   * 兜底从 DOM 抓取当前页所属用户的 Steam64（用于排除自己）。
   * Steam 主页场景：g_steamID / userinfo / sessionID 等
   */
  function tryGetOwnSteam64() {
    const candidates = [
      () => global.g_steamID,
      () => global.g_steamID && String(global.g_steamID),
      () => global.userInfo && global.userInfo.steamID,
      () => global.g_user_info && global.g_user_info.steamid,
      () => global.__INITIAL_STATE__ && global.__INITIAL_STATE__.user && global.__INITIAL_STATE__.user.steamid,
      () => document.body && document.body.dataset && document.body.dataset.steamid,
      () => {
        const m = (document.documentElement.innerHTML || '').match(/"steamid"\s*:\s*"?(\d{16,})"?/);
        return m ? m[1] : null;
      },
      () => {
        const link = document.querySelector('a[href*="steamcommunity.com/profiles/"]');
        if (link) {
          const m = link.href.match(/profiles\/(\d+)/);
          return m ? m[1] : null;
        }
        return null;
      }
    ];
    for (const fn of candidates) {
      try {
        const v = fn();
        if (v && /^7656119\d{10}$/.test(String(v))) return String(v);
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  global.SFPCommon = {
    STEAM64_REGEX,
    PROFILE_URL_REGEX,
    STEAM_BBCODE_REGEX,
    extractSteamIdsFromText,
    tryGetOwnSteam64
  };
})(typeof window !== 'undefined' ? window : self);
