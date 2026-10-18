(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.NocturneConfigShape = factory();
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";
  function record(value) { return Object.prototype.toString.call(value) === "[object Object]"; }
  function identity(value, seen) {
    if (value == null) return true;
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value))) return false;
    var key = String(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }
  function valid(data, options) {
    if (!record(data) || !Array.isArray(data.groups)) return false;
    if (!(options && options.settingsOptional && data.settings === undefined) && !record(data.settings)) return false;
    var groups = new Set(), items = new Set(), engines = new Set();
    if (!data.groups.every(function (group) {
      return record(group) && identity(group.id, groups) && (group.items == null || (Array.isArray(group.items) && group.items.every(function (item) {
        return record(item) && identity(item.id, items);
      })));
    })) return false;
    var list = data.settings && data.settings.engines;
    return list === undefined || (Array.isArray(list) && list.every(function (engine) { return record(engine) && identity(engine.id, engines); }));
  }
  return { valid: valid };
});
