/*
 * 夜曲 Nocturne · 轻量中文拼音首字母（V2.4，零依赖，浏览器与 Node 测试共用）
 * 浏览器里挂在 window.NocturnePinyin；Node 里 module.exports。
 * 利用标准 ICU zh-CN 拼音排序（Intl.Collator）按 23 个声母分界字查首字母，附常见多音字补丁与字符缓存。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NocturnePinyin = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var LETTERS = "abcdefghjklmnopqrstwxyz";
  var BOUNDS = Array.from("吖八嚓咑妸发旮哈丌咔垃妈拿喔妑七呥仨他屲夕丫帀");
  var POLY = {
    "阿": "ae", "便": "bp", "藏": "cz", "查": "cz", "长": "cz", "朝": "cz",
    "重": "zc", "传": "cz", "单": "ds", "调": "dt", "会": "hk", "降": "jx",
    "解": "jx", "卡": "kq", "乐": "ly", "率": "ls", "秘": "mb", "屏": "pb",
    "奇": "qj", "区": "qo", "盛": "sc", "省": "sx", "宿": "sx", "提": "td",
    "系": "xj", "纤": "xq", "校": "xj", "行": "xh"
  };
  var CJK = /[\u4e00-\u9fff]/;
  var col = null;
  try {
    if (typeof Intl === "object" && Intl.Collator) {
      var c = new Intl.Collator("zh-CN-u-co-pinyin");
      if (c.compare("白", "群") < 0 && c.compare("群", "影") < 0 && c.compare("八", "擦") < 0) col = c;
      else {
        c = new Intl.Collator("zh-CN");
        if (c.compare("白", "群") < 0 && c.compare("群", "影") < 0 && c.compare("八", "擦") < 0) col = c;
      }
    }
  } catch (e) { col = null; }

  var cache = Object.create(null);
  function charInitials(ch) {
    if (!ch) return "";
    if (/^[a-z0-9]$/i.test(ch)) return ch.toLowerCase();
    if (!CJK.test(ch)) return "";
    if (cache[ch] !== undefined) return cache[ch];
    var out = POLY[ch] || "";
    if (!out && col) {
      for (var i = BOUNDS.length - 1; i >= 0; i--) {
        if (col.compare(ch, BOUNDS[i]) >= 0) { out = LETTERS[i]; break; }
      }
      if (!out) out = "a";
    }
    cache[ch] = out;
    return out;
  }

  function hasCJK(s) { return CJK.test(String(s == null ? "" : s)); }

  /** 返回与 Array.from(text) 一一对应的首字母串数组（非中文/字母数字项为 ""） */
  function initials(text) {
    return Array.from(String(text == null ? "" : text)).map(charInitials);
  }

  /**
   * 用纯 ASCII 字母/数字查询串匹配含中文的文本（如 "bqh" → "白群晖"）。
   * 返回 { s, hits, sub, prefix, exact } 或 null；hits 为 Array.from(text) 的字符下标，可直接用于高亮。
   */
  function match(text, q) {
    if (!col) return null;
    text = String(text == null ? "" : text);
    if (!hasCJK(text)) return null;
    var tq = String(q == null ? "" : q).toLowerCase().replace(/\s+/g, "");
    if (!tq || !/^[a-z0-9]+$/.test(tq)) return null;
    var chars = Array.from(text), tokens = [], i, k, j;
    for (i = 0; i < chars.length; i++) {
      var ini = charInitials(chars[i]);
      if (ini) tokens.push({ idx: i, ini: ini });
    }
    if (tokens.length < tq.length) return null;
    /* 1. 连续首字母子串匹配（如 bqh → 白群晖、yy → 影音、nasfw → NAS服务） */
    for (k = 0; k + tq.length <= tokens.length; k++) {
      var ok = true;
      for (j = 0; j < tq.length; j++) {
        if (tokens[k + j].ini.indexOf(tq[j]) < 0) { ok = false; break; }
      }
      if (ok) {
        var hits = [];
        for (j = 0; j < tq.length; j++) hits.push(tokens[k + j].idx);
        var exact = k === 0 && tokens.length === tq.length;
        return {
          s: 95 - Math.min(k, 30) + (k === 0 ? 35 : 0) + (exact ? 25 : 0),
          hits: hits, sub: true, prefix: k === 0, exact: exact
        };
      }
    }
    /* 2. 首字母子序列匹配（如 ccjk → 存储与监控） */
    var hits2 = [], last = -1, gaps = 0;
    j = 0;
    for (k = 0; k < tokens.length && j < tq.length; k++) {
      if (tokens[k].ini.indexOf(tq[j]) >= 0) {
        if (last > -1) gaps += k - last - 1;
        hits2.push(tokens[k].idx);
        last = k; j++;
      }
    }
    if (j < tq.length) return null;
    return { s: Math.max(1, 55 - gaps * 3 - hits2[0]), hits: hits2, sub: false, prefix: false, exact: false };
  }

  return { available: !!col, hasCJK: hasCJK, charInitials: charInitials, initials: initials, match: match };
});
