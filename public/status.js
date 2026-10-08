/*
 * 夜曲 Nocturne · 服务状态的「可信」标注（V2.0 阶段 3）。前端（window.NocturneStatus）与测试（require）共用，零依赖。
 *
 * 原则：只有真正测到的才说「在线 / 离线 / 多少 ms / 几点检测」。
 *   - NAS 模式：服务器 /api/status 的结果 {up, status, ms, checkedAt, code} —— 服务器真的发了 HTTP 请求，可以定论。
 *   - 浏览器探测（纯静态页，或服务器没给这一项）：fetch(no-cors) 只能知道「请求有没有报网络错误」，
 *     拿不到状态码、分不清代理 / 登录页 / 证书页，所以成功只能说「可能在线」，失败只能说「无法确认」；从不显示延迟和时间。
 *   - 没法检测（没有地址、示例域名、服务器策略不探测）：「未检测」；还没出结果：「检测中」。
 * 输入（run 阶段产生的原始结果）：
 *   {source:"server", up, status:"up"|"auth"|"down"|"blocked", ms, checkedAt, code}
 *   {source:"browser", reachable:boolean}
 *   {source:"none", reason:"noaddr"|"reserved"|"offlan"|"policy"}
 *   null / undefined = 还在检测
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NocturneStatus = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  /** 检测时间的人话：今天 → 「21:46」；别的日子 → 「10月7日 21:46」；无效 → "" */
  function at(iso, now) {
    if (!iso) return "";
    var t = new Date(iso); if (isNaN(t.getTime())) return "";
    var n = now ? new Date(now) : new Date();
    var hm = pad(t.getHours()) + ":" + pad(t.getMinutes());
    return t.toDateString() === n.toDateString() ? hm : (t.getMonth() + 1) + "月" + t.getDate() + "日 " + hm;
  }
  function msOk(v) { return typeof v === "number" && isFinite(v) && v >= 0 && v < 600000; }
  /**
   * 原始结果 → 显示用：{s, label, detail, ms, at, certain, source}
   *   s：checking | on | auth | off | maybe | unknown | na（也是图标右上角小点的 class）
   *   ms / at 只在服务器真的测到时才有值（null 表示不显示）
   */
  function classify(r, now) {
    if (!r) return { s: "checking", label: "检测中", detail: "", ms: null, at: "", certain: false, source: null };
    if (r.source === "server") {
      var when = at(r.checkedAt, now), ms = msOk(r.ms) ? Math.round(r.ms) : null;
      var tail = (ms != null ? ms + " ms" : "") + (when ? (ms != null ? " · " : "") + "检测于 " + when : "");
      if (r.status === "blocked") return { s: "na", label: "未检测", detail: "服务器不探测这个地址", ms: null, at: "", certain: false, source: "server" };
      if (!r.checkedAt && !r.up) return { s: "na", label: "未检测", detail: "服务器还没有检测这个地址", ms: null, at: "", certain: false, source: "server" };
      if (r.up && (r.status === "auth" || r.auth || r.code === 401 || r.code === 403)) return { s: "auth", label: "在线 · 需登录", detail: tail, ms: ms, at: when, certain: true, source: "server" };
      if (r.up) return { s: "on", label: "在线", detail: tail, ms: ms, at: when, certain: true, source: "server" };
      return { s: "off", label: "离线", detail: when ? "检测于 " + when : "", ms: null, at: when, certain: true, source: "server" };
    }
    if (r.source === "browser") return r.reachable
      ? { s: "maybe", label: "可能在线", detail: "浏览器探测，无法确认真实状态", ms: null, at: "", certain: false, source: "browser" }
      : { s: "unknown", label: "无法确认", detail: "浏览器探测失败，可能离线，也可能被浏览器拦截", ms: null, at: "", certain: false, source: "browser" };
    var why = { noaddr: "没有地址", reserved: "示例地址，不检测", offlan: "内网地址，当前不在内网", policy: "服务器不探测这个地址" }[r.reason] || "";
    if (r.reason === "offlan") return { s: "unknown", label: "无法确认", detail: why, ms: null, at: "", certain: false, source: "none" };
    return { s: "na", label: "未检测", detail: why, ms: null, at: "", certain: false, source: "none" };
  }
  /** 完整的一句话（tooltip / 读屏）："在线 · 23 ms · 检测于 21:46" / "可能在线 · 浏览器探测，无法确认真实状态" */
  function text(c) { return c.label + (c.detail ? " · " + c.detail : ""); }
  /** 紧凑行右侧的短标注："23 ms" / "在线" / "离线" / "可能在线" / "无法确认" / "未检测" */
  function short(c) { return c.s === "on" && c.ms != null ? c.ms + " ms" : c.s === "auth" ? "需登录" : c.label; }
  /**
   * 汇总（状态卡 / 读屏 / 命令面板报告）：list = classify() 的结果数组。
   * total 只算能下结论或可能下结论的（不含「未检测」）。headline / line 是界面文字。
   */
  function summary(list) {
    var n = { on: 0, auth: 0, off: 0, maybe: 0, unknown: 0, na: 0, checking: 0 };
    (list || []).forEach(function (c) { if (c && Object.prototype.hasOwnProperty.call(n, c.s)) n[c.s]++; });
    var certain = n.on + n.auth + n.off, total = certain + n.maybe + n.unknown + n.checking;
    var out = { counts: n, total: total, online: n.on + n.auth, certain: certain, mode: certain ? (n.maybe || n.unknown ? "mixed" : "server") : (n.maybe || n.unknown ? "browser" : "none") };
    if (n.checking) { out.line = "检测中…"; out.tone = ""; }
    else if (!total) { out.line = n.na ? "这些服务都没有可检测的地址" : "还没有图标服务"; out.tone = ""; }
    else if (out.mode === "browser") { out.line = "浏览器无法确认真实状态：" + n.maybe + " 个可能在线" + (n.unknown ? "，" + n.unknown + " 个无法确认" : ""); out.tone = "maybe"; }
    else if (n.off && n.off === certain && !n.maybe) { out.line = "全部离线——可能是地址还没填，或当前网络到不了这些服务"; out.tone = "alloff"; }
    else if (n.off) { out.line = "离线 " + n.off + " 个"; out.tone = "off"; }
    else { out.line = (n.auth ? "全部在线 · " + n.auth + " 个需登录" : "全部正常") + (n.maybe + n.unknown ? "（另有 " + (n.maybe + n.unknown) + " 个无法确认）" : ""); out.tone = "ok"; }
    if (n.na) out.note = n.na + " 个未检测";
    return out;
  }
  /** 读屏 / 命令面板播报 */
  function spoken(sm) {
    var n = sm.counts;
    if (sm.mode === "browser") return n.maybe + " 个可能在线，" + n.unknown + " 个无法确认（浏览器探测）";
    return sm.online + " 个服务在线，" + n.off + " 个离线" + (n.maybe + n.unknown ? "，" + (n.maybe + n.unknown) + " 个无法确认" : "");
  }
  return { classify: classify, text: text, short: short, summary: summary, spoken: spoken, at: at };
});
