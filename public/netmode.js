/*
 * 夜曲 Nocturne · 网络地址选择（纯函数，浏览器与 Node 测试共用，零依赖）
 * 浏览器里挂在 window.NocturneNet；Node 里 module.exports。
 *
 * 三种模式（只存在本机 settings.net，不参与账户同步）：
 *  - auto：只看「当前这个页面是从哪个主机名打开的」（location.hostname）：
 *          私网 IP / 回环 / IPv6 ULA / 链路本地 / .lan .local .home.arpa / localhost → 优先内网；其余一律优先外网（保守）。
 *          不做网段扫描、不测速、不发 no-cors 请求——这些都无法可靠证明「这台设备能打开某个地址」。
 *          Tailscale（100.64.0.0/10、*.ts.net）按外网处理：它不是本地网络入口。
 *  - lan：优先内网地址，没有有效内网地址时回退到外网地址
 *  - wan：优先外网地址，没有有效外网地址时回退到内网地址
 * 迁移：本机已存的 lan / wan 原样保留；没有存过（新设备）或存的值非法 → auto。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NocturneNet = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var MODES = ["auto", "lan", "wan"];
  var NAMES = { auto: "自动", lan: "内网", wan: "外网" };

  function ipv4(h) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m) return null;
    var o = [+m[1], +m[2], +m[3], +m[4]];
    for (var i = 0; i < 4; i++) if (o[i] > 255) return null;
    return o;
  }
  function lanV4(o) {
    return o[0] === 10 || o[0] === 127 || (o[0] === 172 && o[1] >= 16 && o[1] <= 31) || (o[0] === 192 && o[1] === 168) || (o[0] === 169 && o[1] === 254);
  }
  /** 主机名 → "lan" | "wan"。只根据字面判断，不解析 DNS。 */
  function decide(hostname) {
    var h = String(hostname == null ? "" : hostname).trim().toLowerCase().replace(/\.$/, "");
    if (!h) return "wan";
    if (h.charAt(0) === "[") h = h.slice(1, h.indexOf("]") > 0 ? h.indexOf("]") : h.length);
    if (h === "localhost" || /\.localhost$/.test(h)) return "lan";
    if (/(^|\.)ts\.net$/.test(h)) return "wan"; // Tailscale MagicDNS
    if (/\.(lan|local|home\.arpa)$/.test(h)) return "lan";
    var v4 = ipv4(h);
    if (v4) return lanV4(v4) ? "lan" : "wan"; // 100.64.0.0/10（Tailscale / CGNAT）落在这里 → wan
    if (h.indexOf(":") > -1) { // IPv6
      var mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h) || /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
      if (mapped) { var o = ipv4(mapped[1]); return o && lanV4(o) ? "lan" : "wan"; }
      var hx = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h); // URL 解析后的 IPv4 映射形式 [::ffff:c0a8:101]
      if (hx) { var a = parseInt(hx[1], 16), b = parseInt(hx[2], 16); return lanV4([a >> 8, a & 255, b >> 8, b & 255]) ? "lan" : "wan"; }
      if (h === "::1" || /^(0{1,4}:){7}0{0,3}1$/.test(h)) return "lan"; // 回环
      if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return "lan"; // fc00::/7 ULA
      if (/^fe[89ab][0-9a-f]?:/.test(h)) return "lan"; // fe80::/10 链路本地
      return "wan";
    }
    return "wan";
  }
  /** 合法模式原样返回，否则 null */
  function norm(m) { return MODES.indexOf(m) > -1 ? m : null; }
  /** 本机存储迁移：已存 lan / wan / auto 保留；没有（新设备）或非法 → auto */
  function migrate(stored) { return norm(stored) || "auto"; }
  /** 实际生效的方向（"lan" | "wan"） */
  function effective(mode, hostname) { mode = migrate(mode); return mode === "auto" ? decide(hostname) : mode; }
  /**
   * 为一个项目选地址。safe(u)：合法则返回 u，否则 ""（浏览器里传 NocturneURL.safeNav）。
   * 返回 {url, kind:"lan"|"wan"|null, fallback:bool}；两个都无效 → {url:"", kind:null}
   */
  function pick(item, eff, safe) {
    if (!item) return { url: "", kind: null, fallback: false };
    var lan = safe(item.lan) || "", wan = safe(item.wan) || "", want = eff === "lan" ? "lan" : "wan";
    var first = want === "lan" ? lan : wan, other = want === "lan" ? wan : lan;
    if (first) return { url: first, kind: want, fallback: false };
    if (other) return { url: other, kind: want === "lan" ? "wan" : "lan", fallback: true };
    return { url: "", kind: null, fallback: false };
  }
  /** 页头显示的文字，例如「自动·外网」「内网」 */
  function label(mode, hostname) {
    mode = migrate(mode);
    return mode === "auto" ? NAMES.auto + "·" + NAMES[decide(hostname)] : NAMES[mode];
  }
  return { MODES: MODES, NAMES: NAMES, decide: decide, norm: norm, migrate: migrate, effective: effective, pick: pick, label: label };
});
