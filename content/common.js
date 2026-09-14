// content/common.js —— 内容脚本共享：Steam ID 提取 & 自定义 URL 解析
// 通过 window.SFPCommon 暴露给其他 content 脚本使用
(function (global) {
  'use strict';
  if (global.SFPCommon) return; // 防重复注入

  // 17 位 Steam64 ID（真实区间 76561197960265728 ~ 76561202255213023，即 7656119/7656120 开头）
  const STEAM64_REGEX = /\b(76561(?:19|20)[0-9]{10})\b/g;
  // Steam 好友代码（客户端「添加好友」页显示的短数字 = Steam64 - 76561197960265728）
  // 5~10 位独立数字：太短（楼层号/点赞数）误报多，太长不是好友代码
  const FRIEND_CODE_REGEX = /\b(\d{5,10})\b/g;
  const FRIEND_CODE_OFFSET = 76561197960265728n;
  const STEAM64_MIN = 76561197960265728n;
  const STEAM64_MAX = 76561202255233023n; // = MIN + 0xFFFFFFFF（32 位 accountid 上限），实测 BigInt 换算
  // Steam 社区个人主页链接（捕获 slug）
  const PROFILE_URL_REGEX = /https?:\/\/steamcommunity\.com\/(?:id|profiles)\/([^\/\s"'<>?#]+)/gi;
  // 小黑盒 BBCode 签名档 [steam]xxx[/steam]
  const STEAM_BBCODE_REGEX = /\[steam\]([^\[]+)\[\/steam\]/gi;

  /** 好友代码 → Steam64；非法（转换后不在 Steam64 区间）返回 null */
  function friendCodeToSteam64(code) {
    if (!/^\d{5,10}$/.test(code)) return null;
    try {
      const n = BigInt(code) + FRIEND_CODE_OFFSET;
      return (n >= STEAM64_MIN && n <= STEAM64_MAX) ? n.toString() : null;
    } catch (e) {
      return null;
    }
  }

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
   * - 5~10 位独立数字 → 视为 Steam 好友代码，换算成 Steam64
   * - /profiles/<数字> → 直接收
   * - /id/<自定义> 或 BBCode 内非数字 → 交给 background 解析
   */
  async function extractSteamIdsFromText(text, opts) {
    const resolveVanity = !opts || opts.resolveVanity !== false;
    const acceptFriendCode = !opts || opts.friendCodes !== false;
    if (!text) return [];
    const found = new Set();
    const vanity = new Set();

    // 1) 纯 Steam64
    let m;
    const re1 = new RegExp(STEAM64_REGEX.source, 'g');
    while ((m = re1.exec(text))) found.add(m[1]);

    // 2) 好友代码（独立 5~10 位数字，换算）
    if (acceptFriendCode) {
      const re4 = new RegExp(FRIEND_CODE_REGEX.source, 'g');
      while ((m = re4.exec(text))) {
        const id64 = friendCodeToSteam64(m[1]);
        if (id64) found.add(id64);
      }
    }

    // 3) 个人主页链接
    const re2 = new RegExp(PROFILE_URL_REGEX.source, 'gi');
    while ((m = re2.exec(text))) {
      const slug = (m[1] || '').trim();
      if (!slug) continue;
      if (/^\d{16,}$/.test(slug)) found.add(slug);
      else if (resolveVanity) vanity.add(slug);
    }

    // 4) BBCode 签名档
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
        if (v && /^76561(?:19|20)\d{10}$/.test(String(v))) return String(v);
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  global.SFPCommon = {
    STEAM64_REGEX,
    FRIEND_CODE_REGEX,
    PROFILE_URL_REGEX,
    STEAM_BBCODE_REGEX,
    friendCodeToSteam64,
    extractSteamIdsFromText,
    tryGetOwnSteam64
  };
})(typeof window !== 'undefined' ? window : self);
