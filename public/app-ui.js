/* 夜曲 · 编辑 / 拖动 / 设置 / 命令面板 / 空间（在 nocturne.js 之后、midnight.js 之前）：原 index.html 内联脚本（顺序不变，每段仍是独立 IIFE）。改内容必须同时改 index.html 里的 ?v=（test/csp.test.js 校验为内容 sha256 前 10 位）。 */
/* Stage 2a · edit mode. Uses only the App API.
   "edit-item" / "add-item" listeners set d.handled = true; otherwise a 即将上线 toast shows. */
(function () {
  "use strict";
  var A = window.App, esc = A.util.esc, uid = A.util.uid, body = document.body, SPC = A.spaces;
  var groupsEl = document.getElementById("x-groups");
  var editing = false, depth = 0, lp = null, eatClick = false, sheetOpen = false, closeT = null, acts = [];

  var hint = document.createElement("p");
  hint.className = "x-ehint"; hint.textContent = "编辑中 · 长按拖动排序";
  document.querySelector(".x-head").appendChild(hint);
  var bar = document.createElement("div");
  bar.className = "x-ebar x-glass"; bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "编辑工具");
  bar.innerHTML = '<button type="button" data-e="undo" disabled>↶ 撤销</button><button type="button" data-e="addg">＋ 分组</button>' +
    '<span class="x-sp"></span><button type="button" class="x-done" data-e="done">完成</button>';
  var back = document.createElement("div"); back.className = "x-sback"; back.hidden = true;
  var sheet = document.createElement("div");
  sheet.className = "x-sheet x-glass"; sheet.hidden = true; sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true");
  body.append(bar, back, sheet);

  function gr(s, gid) { return s.groups.filter(function (g) { return g.id === gid; })[0]; }
  function find(s, gid, id) {
    var g = gr(s, gid); if (!g) return {};
    var i = g.items.findIndex(function (x) { return x.id === id; });
    return { g: g, i: i, item: g.items[i] };
  }
  function softEmit(evt, d) { d.handled = false; A.emit(evt, d); if (!d.handled) A.toast("即将上线"); }
  function syncUndo() { bar.querySelector('[data-e="undo"]').disabled = !depth; }
  A.on("change", function (d) {
    depth = d && d.label === "undo" ? Math.max(0, depth - 1) : Math.min(50, depth + 1);
    syncUndo();
  });

  /* ---- actions ---- */
  function delItem(gid, id) {
    var f = find(A.state, gid, id); if (!f.item) return;
    A.commit(function (s) { var x = find(s, gid, id); if (x.item) x.g.items.splice(x.i, 1); }, "delete-item");
    A.toast("已删除「" + f.item.title + "」", { action: "撤销", onAction: A.undo });
  }
  function dupItem(gid, id) {
    var f = find(A.state, gid, id); if (!f.item) return;
    A.commit(function (s) {
      var x = find(s, gid, id); if (!x.item) return;
      var c = structuredClone(x.item); c.id = uid(); x.g.items.splice(x.i + 1, 0, c);
      if (SPC) SPC.keepVisible(s, c.id); /* 在空间里复制：原项目是单独加进来的 → 副本也单独加进来（否则一复制就看不见） */
    }, "duplicate-item");
    A.toast("已复制「" + f.item.title + "」");
  }
  function moveItem(gid, id, to, name) {
    var pinned = false;
    A.commit(function (s) {
      var x = find(s, gid, id), t = gr(s, to); if (!x.item || !t) return;
      x.g.items.splice(x.i, 1); t.items.push(x.item);
      if (SPC) pinned = SPC.keepVisible(s, id); /* 在空间里移到一个不在本空间的分组：单独加进本空间，项目不会凭空消失 */
    }, "move-item");
    A.toast("已移到「" + name + "」" + (pinned ? "，仍显示在本空间" : ""));
  }
  /* 只改空间关系、不删分组 / 项目：从当前空间里移除整组或单独加进来的项目 */
  function unlink(kind, id, label) {
    var cs = SPC && SPC.current(); if (!cs) return;
    var how = null;
    A.commit(function (s) {
      var sp = SPC.model.get(s, cs.id); if (!sp) return;
      if (kind === "group") SPC.model.setGroups(s, cs.id, (sp.groupIds || []).filter(function (x) { return x !== String(id); }));
      else how = SPC.model.hide(s, cs.id, String(id)); /* 单独加入的 → 取消加入；随整组出现的 → 记一条排除（excludeItemIds） */
    }, "space-unlink");
    A.toast(kind === "group" ? "已从「" + cs.name + "」移除分组「" + label + "」（分组和项目都还在）"
      : how && how.action === "hide" ? "已在「" + cs.name + "」隐藏「" + label + "」，它在「全部」和其他空间照常显示"
      : "已从「" + cs.name + "」移除「" + label + "」（项目还在）", { action: "撤销", onAction: A.undo, duration: 6000 });
  }
  /* 编辑模式的减号：在「全部」里就是原来的直接删除（可撤销）；在自定义空间里先问清楚——默认只改本空间的关系，
     「从所有空间删除」是红色的第二选项，还要再确认一次，并写明它出现在几个空间里 */
  function removeFlow(gid, id) {
    var f = find(A.state, gid, id); if (!f.item) return;
    var cs = SPC && SPC.current();
    if (!cs) { delItem(gid, id); return; }
    var how = SPC.model.removal(A.state, cs.id, id), name = f.item.title || "未命名";
    var rows = [];
    if (how.action === "hide") rows.push({ label: "从「" + cs.name + "」移除", sub: "分组「" + f.g.name + "」整组在这个空间里：只在本空间隐藏这一项，分组、项目和其他空间都不变", fn: function () { unlink("item", id, name); } });
    else if (how.action === "unpin") rows.push({ label: "从「" + cs.name + "」移除", sub: "它是单独加进来的：只取消加入，项目还在「全部」和原来的分组里", fn: function () { unlink("item", id, name); } });
    rows.push({ label: "从所有空间删除…", red: true, keep: true, sub: "删除项目本身", fn: function () { confirmDelete(gid, id); } });
    menu("「" + name + "」", rows, "要从哪里去掉它？");
  }
  function confirmDelete(gid, id) {
    var f = find(A.state, gid, id); if (!f.item) return;
    var spaces = SPC ? SPC.model.spacesWith(A.state, id) : [], n = spaces.length + 1;
    var names = ["全部"].concat(spaces.map(function (s) { return s.name; }));
    var where = names.length > 4 ? names.slice(0, 4).join("、") + " 等" : names.join("、");
    menu("删除「" + (f.item.title || "未命名") + "」？", [
      { label: "删除项目（" + n + " 个空间）", red: true, fn: function () { delItem(gid, id); } }
    ], "它出现在 " + n + " 个空间里（" + where + "）。删除后所有空间都不再有它，图标和地址一并删除；之后几秒内可以撤销。");
  }
  function delGroup(gid) {
    var g = gr(A.state, gid); if (!g) return;
    A.commit(function (s) { s.groups = s.groups.filter(function (x) { return x.id !== gid; }); }, "delete-group");
    A.toast("已删除分组「" + g.name + "」及 " + g.items.length + " 个项目", { action: "撤销", onAction: A.undo });
  }
  function rename(gid) {
    var g = gr(A.state, gid); if (!g) return;
    prompt("重命名分组", g.name, function (v) { A.commit(function (s) { var x = gr(s, gid); if (x) x.name = v; }, "rename-group"); });
  }
  function addGroup() {
    var names = A.state.groups.map(function (g) { return g.name; }), def = "新分组", n = 2;
    if (names.indexOf(def) > -1) { while (names.indexOf("新分组 " + n) > -1) n++; def = "新分组 " + n; }
    prompt("新建分组", "", function (v) {
      var id = uid();
      A.commit(function (s) { s.groups.push({ id: id, name: v, style: "icon", items: [] }); if (SPC) SPC.adoptGroup(s, id); /* 在空间里新建 → 整组加进当前空间 */ }, "add-group");
      var sec = groupsEl.querySelector('.x-group[data-gid="' + A.util.sel(id) + '"]');
      if (sec) sec.scrollIntoView({ block: "center", behavior: "smooth" });
    }, "分组名称", def);
  }

  /* ---- sheets ---- */
  var sheetPrev = null;
  function show(html, label) {
    clearTimeout(closeT);
    if (!sheetOpen) sheetPrev = document.activeElement;
    sheet.innerHTML = html; sheet.setAttribute("aria-label", label);
    back.hidden = sheet.hidden = false; sheetOpen = true;
    void sheet.offsetWidth;
    back.classList.add("is-on"); sheet.classList.add("is-on");
  }
  function closeSheet() {
    if (!sheetOpen) return;
    sheetOpen = false; back.classList.remove("is-on"); sheet.classList.remove("is-on");
    closeT = setTimeout(function () { back.hidden = sheet.hidden = true; sheet.innerHTML = ""; }, 300);
    /* 焦点回到打开它的按钮（被删掉的项目就不回了） */
    if (sheetPrev && sheetPrev.focus && document.contains(sheetPrev) && sheet.contains(document.activeElement)) try { sheetPrev.focus({ preventScroll: true }); } catch (e) { /* gone */ }
  }
  function menu(title, rows, desc) {
    acts = rows;
    show("<h3>" + esc(title) + "</h3>" + (desc ? '<p class="x-sdesc">' + esc(desc) + "</p>" : "") + rows.map(function (r, i) {
      return '<button type="button" class="x-row' + (r.red ? " is-red" : "") + (r.sub ? " has-sub" : "") + '" data-i="' + i + '"><span class="x-rl">' + esc(r.label) + "</span>" +
        (r.sub ? '<small class="x-rs">' + esc(r.sub) + "</small>" : "") + "</button>";
    }).join("") + '<button type="button" class="x-row is-cancel" data-i="-1">取消</button>', desc ? title + "。" + desc : title);
    sheet.querySelector(".x-row").focus({ preventScroll: true });
  }
  function prompt(title, val, ok, ph, empty) {
    acts = [];
    show("<h3>" + esc(title) + '</h3><form><input type="text" maxlength="40" enterkeyhint="done" aria-label="' + esc(title) + '" value="' + esc(val) + '"' + (ph ? ' placeholder="' + esc(ph) + '"' : "") + ">" +
      '<div class="x-prow"><button type="button" data-i="-1">取消</button><button type="submit" class="x-ok">保存</button></div></form>', title);
    var f = sheet.querySelector("form"), inp = f.querySelector("input");
    f.onsubmit = function (e) { e.preventDefault(); var v = inp.value.trim() || empty || ""; closeSheet(); if (v && v !== val) ok(v); };
    setTimeout(function () { inp.focus(); inp.select(); }, 60);
  }
  back.addEventListener("click", closeSheet);
  sheet.addEventListener("click", function (e) {
    var b = e.target.closest("[data-i]"); if (!b) return;
    var r = acts[+b.getAttribute("data-i")];
    if (!r) { closeSheet(); return; }
    if (!r.keep) closeSheet();
    r.fn();
  });
  function itemSheet(gid, id) {
    var f = find(A.state, gid, id); if (!f.item) return;
    var others = A.state.groups.filter(function (g) { return g.id !== gid; });
    /* 同时有有效内网 / 外网地址：可以显式打开备用地址（只是打开，不代表能访问成功） */
    var alt = [], lanU = A.urlOf ? A.urlOf(f.item, "lan") : "", wanU = A.urlOf ? A.urlOf(f.item, "wan") : "";
    if (lanU && wanU) [["lan", "内网", lanU], ["wan", "外网", wanU]].forEach(function (k) {
      var h = k[2]; try { h = new URL(k[2]).host; } catch (e) { /* keep */ }
      alt.push({ label: "用" + k[1] + "地址打开 · " + h, fn: function () { window.open(k[2], "_blank", "noopener"); } });
    });
    var cs = SPC && SPC.current(), how = cs ? SPC.model.removal(A.state, cs.id, id) : null, pinnedHere = how && how.action !== "none";
    menu(f.item.title, alt.concat([
      { label: "编辑…", fn: function () { softEmit("edit-item", { gid: gid, id: id }); } },
      { label: "移到分组…", keep: others.length > 0, fn: function () {
        if (!others.length) { A.toast("没有其他分组"); return; }
        menu("移到分组", others.map(function (g) { return { label: g.name, fn: function () { moveItem(gid, id, g.id, g.name); } }; }));
      } },
      { label: "复制", fn: function () { dupItem(gid, id); } }
    ].concat(pinnedHere ? [{ label: "从「" + cs.name + "」移除", fn: function () { unlink("item", id, f.item.title); } }] : [])
     .concat([{ label: cs ? "从所有空间删除…" : "删除", red: true, keep: !!cs, fn: function () { if (cs) confirmDelete(gid, id); else delItem(gid, id); } }])));
  }
  function groupSheet(gid) {
    var g = gr(A.state, gid); if (!g) return;
    menu(g.name, [
      { label: "重命名", keep: true, fn: function () { rename(gid); } },
      { label: g.style === "chip" ? "改为图标" : "改为链接", fn: function () {
        A.commit(function (s) { var x = gr(s, gid); if (x) x.style = x.style === "chip" ? "icon" : "chip"; }, "group-style");
      } },
    ].concat(SPC && SPC.current() && SPC.model.groupInSpace(A.state, SPC.current().id, gid) ? [{ label: "从「" + SPC.current().name + "」移除", fn: function () { unlink("group", gid, g.name); } }] : [])
     .concat([{ label: SPC && SPC.current() ? "删除分组（所有空间）" : "删除分组", red: true, fn: function () { delGroup(gid); } }]));
  }

  /* ---- mode ---- */
  function decorate() {
    if (!editing) return;
    groupsEl.querySelectorAll(".x-tile[data-id], .x-chip[data-id]").forEach(function (el) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "x-ebadge"; var it = find(A.state, el.getAttribute("data-gid"), el.getAttribute("data-id")).item;
      b.setAttribute("aria-label", (SPC && SPC.current() ? "移除 " : "删除 ") + (it ? it.title : el.textContent.trim()));
      b.innerHTML = '<span aria-hidden="true">−</span>';
      el.setAttribute("draggable", "false"); el.prepend(b);
    });
    groupsEl.querySelectorAll(".x-group").forEach(function (sec) {
      var gid = sec.getAttribute("data-gid"), g = gr(A.state, gid); if (!g) return;
      var h = sec.querySelector(".x-gtitle"), box = sec.querySelector(".x-grid, .x-chips");
      h.insertAdjacentHTML("afterbegin", '<span class="grp-handle" aria-hidden="true">⠿</span>');
      h.insertAdjacentHTML("beforeend", '<button type="button" class="x-gmore" aria-label="分组选项：' + esc(g.name) + '">⋯</button>');
      box.insertAdjacentHTML("beforeend", g.style === "chip"
        ? '<button type="button" class="x-chip x-ghost" data-add="' + esc(gid) + '">+ 添加</button>'
        : '<button type="button" class="x-tile x-ghost" data-add="' + esc(gid) + '" aria-label="添加项目">+</button>');
      if (!g.items.length) box.insertAdjacentHTML("beforebegin", '<p class="x-eempty">把项目拖到这里，或点 +</p>');
    });
    groupsEl.insertAdjacentHTML("beforeend", '<button type="button" class="x-eaddg">＋ 添加分组</button>');
  }
  function enter() {
    if (editing) return;
    editing = true; body.classList.add("editing"); A.render(); syncUndo();
    A.emit("editmode", { on: true });
  }
  function exit() {
    if (!editing) return;
    editing = false; closeSheet(); body.classList.remove("editing"); A.render();
    A.emit("editmode", { on: false });
  }
  A.on("edit", function (d) { if (d) d.handled = true; enter(); });
  A.on("render", decorate);

  bar.addEventListener("click", function (e) {
    var b = e.target.closest("[data-e]"); if (!b) return;
    var a = b.getAttribute("data-e");
    if (a === "undo") A.undo(); else if (a === "addg") addGroup(); else exit();
  });
  groupsEl.addEventListener("click", function (e) {
    if (!editing) return;
    var t = e.target;
    if (t.closest("a")) e.preventDefault();
    var item = t.closest(".x-tile[data-id], .x-chip[data-id]");
    if (item && t.closest(".x-ebadge")) { removeFlow(item.getAttribute("data-gid"), item.getAttribute("data-id")); return; }
    var add = t.closest("[data-add]");
    if (add) { softEmit("add-item", { gid: add.getAttribute("data-add") }); return; }
    if (item) { itemSheet(item.getAttribute("data-gid"), item.getAttribute("data-id")); return; }
    var more = t.closest(".x-gmore");
    if (more) { groupSheet(more.closest(".x-group").getAttribute("data-gid")); return; }
    if (t.closest(".x-eaddg")) addGroup();
  });

  /* long-press to enter */
  function cancelLp() { if (lp) { clearTimeout(lp.t); lp = null; } }
  groupsEl.addEventListener("pointerdown", function (e) {
    if (editing || e.button > 0) return;
    if (!e.target.closest(".x-tile[data-id], .x-chip[data-id]")) return;
    cancelLp();
    lp = { x: e.clientX, y: e.clientY, t: setTimeout(function () {
      lp = null; eatClick = true;
      if (navigator.vibrate) navigator.vibrate(10);
      enter();
      try { if (!localStorage.getItem("yeqv.hint1")) { localStorage.setItem("yeqv.hint1", "1"); A.toast("已进入编辑 · 按住图标拖动，点一下更多操作"); } } catch (err) {}
    }, 500) };
  });
  groupsEl.addEventListener("pointermove", function (e) {
    if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 8) cancelLp();
  });
  groupsEl.addEventListener("pointercancel", cancelLp);
  window.addEventListener("pointerup", function () {
    cancelLp();
    if (eatClick) setTimeout(function () { eatClick = false; }, 400);
  });
  document.addEventListener("click", function (e) {
    if (eatClick) { eatClick = false; e.preventDefault(); e.stopPropagation(); }
  }, true);
  groupsEl.addEventListener("contextmenu", function (e) {
    if ((lp || eatClick || editing) && e.target.closest(".x-tile, .x-chip")) e.preventDefault();
  });

  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "e" || e.key === "E")) {
      e.preventDefault(); closeSheet();
      if (editing) exit(); else enter();
    } else if (e.key === "Escape") {
      if (sheetOpen) { e.preventDefault(); closeSheet(); } else if (editing) exit();
    }
  });
})();

/* Stage 2b · drag & drop with SortableJS. Uses only the App API. */
(function () {
  "use strict";
  var A = window.App, S = window.Sortable, body = document.body;
  var groupsEl = document.getElementById("x-groups");
  if (!S) return;
  var insts = [], lastEnd = 0, press = null;
  var BOX = ".x-grid[data-gid], .x-chips[data-gid]";

  function readDOM() {
    return [].map.call(groupsEl.querySelectorAll(".x-group[data-gid]"), function (sec) {
      var box = sec.querySelector(BOX);
      return { gid: sec.getAttribute("data-gid"), ids: box ? [].map.call(box.querySelectorAll("[data-id]"), function (el) { return el.getAttribute("data-id"); }) : [] };
    });
  }
  function ghostLast() {
    groupsEl.querySelectorAll(BOX).forEach(function (box) {
      var g = box.querySelector(":scope > .x-ghost"); if (g && g !== box.lastElementChild) box.appendChild(g);
    });
  }
  var prevTA = "";
  /* shared drag feel: always the pointer-driven fallback clone, which follows the finger on iOS Safari */
  function opts(o) {
    var base = {
      forceFallback: true, fallbackOnBody: true, fallbackTolerance: 4, delay: 0, delayOnTouchOnly: true, touchStartThreshold: 4,
      animation: 180, easing: "cubic-bezier(.2,.8,.2,1)",
      ghostClass: "is-ghost", chosenClass: "is-chosen", dragClass: "is-drag", fallbackClass: "is-floating",
      onStart: onStart, onEnd: onEnd
    };
    for (var k in o) base[k] = o[k];
    return base;
  }
  function onStart() {
    body.classList.add("x-dragging", "dragging");
    prevTA = body.style.touchAction; body.style.touchAction = "none";
    body.classList.remove("x-lock"); document.documentElement.style.overflow = ""; body.style.overflow = "";
    try { if (navigator.vibrate) navigator.vibrate(10); } catch (e) { /* unsupported */ }
  }
  function onEnd() {
    body.style.touchAction = prevTA;
    lastEnd = Date.now(); body.classList.remove("x-dragging", "dragging"); ghostLast();
    var order = readDOM(), SP = window.NocturneSpaces;
    /* 统一的全局顺序（spaces.js reorder）：在某个空间里拖动，只改「看得见的这些」彼此之间的先后，看不见的分组 / 项目原位不动；
     * 在「全部」里等同于整体重排。先在浅拷贝上试一次：没有实际变化就不提交（不产生撤销步骤、不同步） */
    var probe = { groups: A.state.groups.map(function (g) { return { id: g.id, items: (g.items || []).slice() }; }) };
    if (!SP.reorder(probe, order)) return;
    setTimeout(function () {
      A.commit(function (s) { SP.reorder(s, order); }, "reorder");
    }, 0);
  }
  function destroy() { insts.forEach(function (x) { try { x.destroy(); } catch (e) { /* already gone */ } }); insts = []; }
  function setup() {
    destroy();
    if (!body.classList.contains("editing")) return;
    groupsEl.querySelectorAll(BOX).forEach(function (box) {
      var chipBox = box.classList.contains("x-chips");
      insts.push(S.create(box, opts(chipBox ? {
        group: "items", draggable: ".x-chip[data-id], [data-id]", filter: ".x-ghost", preventOnFilter: false,
        swapThreshold: 1, invertSwap: false, emptyInsertThreshold: 28,
        scroll: true, bubbleScroll: true, scrollSensitivity: 80, scrollSpeed: 14,
        onMove: function (e) { if (e.related && e.related.classList.contains("x-ghost")) return -1; }
      } : {
        group: "items", draggable: "[data-id]", filter: ".x-ghost,.x-ebadge,.x-eaddg", preventOnFilter: false,
        swapThreshold: .65, emptyInsertThreshold: 28,
        scroll: true, bubbleScroll: true, scrollSensitivity: 80, scrollSpeed: 14,
        onMove: function (e) { if (e.related && e.related.classList.contains("x-ghost")) return -1; }
      })));
    });
    insts.push(S.create(groupsEl, opts({ draggable: ".x-group", handle: ".grp-handle", scroll: true })));
  }
  /* keep iOS from turning an item drag into a scroll once it has started */
  groupsEl.addEventListener("touchmove", function (e) {
    if (body.classList.contains("dragging")) e.preventDefault();
  }, { passive: false });
  document.addEventListener("touchmove", function (e) {
    if (body.classList.contains("dragging") && e.cancelable) e.preventDefault();
  }, { passive: false });
  /* hand a long-press that entered edit mode straight to Sortable, on the re-rendered tile under the finger */
  function handoff() {
    if (!press || !insts[0] || !insts[0].options.supportPointer || !window.PointerEvent) return;
    var el = groupsEl.querySelector('[data-id="' + A.util.sel(press.id) + '"]'); if (!el) return;
    try {
      el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, composed: true, clientX: press.x, clientY: press.y,
        screenX: press.x, screenY: press.y, button: 0, buttons: 1, isPrimary: true, pointerId: press.pid, pointerType: "mouse" }));
    } catch (e) { /* second press needed */ }
  }
  groupsEl.addEventListener("pointerdown", function (e) {
    if (!e.isTrusted || body.classList.contains("editing") || e.button > 0) { press = null; return; }
    var it = e.target.closest("[data-id]");
    press = it ? { id: it.getAttribute("data-id"), x: e.clientX, y: e.clientY, pid: e.pointerId } : null;
  }, true);
  window.addEventListener("pointermove", function (e) { if (press && e.isTrusted) { press.x = e.clientX; press.y = e.clientY; } }, true);
  ["pointerup", "pointercancel"].forEach(function (t) { window.addEventListener(t, function (e) { if (e.isTrusted) press = null; }, true); });

  A.on("render", setup);
  A.on("editmode", function (d) { setup(); if (d && d.on) handoff(); press = null; });
  document.addEventListener("click", function (e) {
    if (Date.now() - lastEnd < 250) { e.preventDefault(); e.stopPropagation(); }
  }, true);
})();

/* Stage 3 · add / edit item sheet. Uses only the App API. */
(function () {
  "use strict";
  var A = window.App, esc = A.util.esc, uid = A.util.uid, body = document.body;
  var PORTS = { 8096: "Emby", 32400: "Plex", 8080: "qBittorrent", 3000: "MoviePilot", 5000: "群晖", 5001: "群晖", 3001: "Uptime Kuma", 8123: "Home Assistant", 9000: "Portainer", 8920: "Jellyfin", 2283: "Immich" };
  var QUICK = "emby plex jellyfin qbittorrent synology uptime-kuma home-assistant portainer immich notion github docker tailscale cloudflare".split(" ").map(function (s) { return "selfhst:" + s; });
  var EMO = "🎬 📺 🍿 🎵 📷 🧭 ⬇️ 🗄️ 💾 🛡️ 📊 🏠 🔧 🐳 ☁️ 🔐 📚 📝 🤖 🌐 ⚙️ 🧪 🎮 📡".split(" ");
  var BGS = [["transparent", "透明"], ["#2A3142"], ["#1F3A5F"], ["#3B2A4A"], ["#4A3324"], ["#23463A"], ["#E9B26A"], ["#EEE8DC"]];
  var MODES = [["auto", "自动"], ["lib", "图标库"], ["emoji", "Emoji"], ["text", "文字"], ["image", "图片"]];
  var API = window.NOCTURNE ? "api/icon/" : "https://api.iconify.design/";
  var back = document.createElement("div"), sh = document.createElement("div");
  back.className = "x-ib"; back.hidden = true;
  sh.className = "x-is x-glass"; sh.hidden = true; sh.setAttribute("role", "dialog"); sh.setAttribute("aria-modal", "true");
  body.append(back, sh);
  var s = null, F = {}, open = false, closeT = null, lastFocus = null;

  function isIP(h) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(h); }
  function hasScheme(v) { return /^[a-z][\w+.-]*:\/\//i.test(v); }
  function norm(v) {
    v = v.trim(); if (!v || hasScheme(v)) return v;
    var h = v.split(/[\/?#]/)[0], hn = h.replace(/:\d+$/, "").toLowerCase();
    var lan = isIP(hn) || hn === "localhost" || /\.(local|lan)$/.test(hn) || /:\d+$/.test(h);
    return (lan ? "http://" : "https://") + v;
  }
  var U = window.NocturneURL;
  function parse(v) {
    if (!U.http(norm(v))) return null; /* 严格白名单：只收 http(s)，不含控制字符 / 首尾空白 */
    try { var u = new URL(norm(v)); return /^https?:$/.test(u.protocol) && /^[\w.-]+$|^\[/.test(u.hostname) && (u.hostname.indexOf(".") > 0 || u.hostname === "localhost" || /^\[/.test(u.hostname)) ? u : null; }
    catch (e) { return null; }
  }
  function priv(u) {
    var h = u.hostname;
    return (isIP(h) && /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) || h === "localhost" || /\.(local|lan)$/.test(h);
  }
  function guess(u) {
    if (PORTS[u.port]) return PORTS[u.port];
    var h = u.hostname.replace(/^www\./, ""); if (isIP(h)) return "";
    var l = h.split(".")[0]; return l.charAt(0).toUpperCase() + l.slice(1);
  }
  function slug(n) { return n.trim().toLowerCase().replace(/\s+/g, "-"); }
  function btn(v, pressed) {
    var p = v.split(":");
    return '<button type="button" data-ic="' + esc(v) + '" aria-label="' + esc(p[1]) + '" aria-pressed="' + pressed + '"><img src="' + API + encodeURIComponent(p[0]) + "/" + encodeURIComponent(p[1]) + '.svg" alt="" loading="lazy"></button>';
  }
  function field(name, label, extra, cnt) {
    return '<div class="x-f"><div class="x-lab"><label for="x-f-' + name + '">' + label + "</label>" + (cnt ? '<span data-cnt="' + name + '">0/' + cnt + "</span>" : "") + "</div>" +
      '<input id="x-f-' + name + '" name="' + name + '" type="text" autocomplete="off" ' + (extra || "") + (cnt ? ' maxlength="' + cnt + '"' : "") + '><p class="x-err" data-err="' + name + '" hidden></p></div>';
  }
  var URLX = 'inputmode="url" autocapitalize="off" spellcheck="false" ';

  function build(add) {
    var gs = A.state.groups;
    sh.innerHTML = '<div class="x-is-h"><button type="button" data-a="cancel">取消</button><h3>' + (add ? "添加项目" : "编辑项目") + '</h3><button type="button" class="x-is-save" data-a="save">保存</button></div>' +
      '<div class="x-confirm" hidden><span>放弃修改？</span><button type="button" class="is-red" data-a="discard">放弃</button><button type="button" data-a="keep">继续编辑</button></div><form novalidate>' +
      field("url", "网址", URLX + 'placeholder="nas.local:5000 或 https://…"') + field("nm", "名称", "", 20) +
      '<div class="x-f"><span class="x-lab">图标</span><div class="x-icrow"><div class="x-prev" aria-hidden="true"></div><div class="x-seg" role="group" aria-label="图标来源">' +
      MODES.map(function (m) { return '<button type="button" data-m="' + m[0] + '" aria-pressed="false">' + m[1] + "</button>"; }).join("") + "</div></div>" +
      '<div class="x-pane" data-p="auto"><p class="x-note">按名称匹配 selfh.st 图标，找不到时显示首字母。</p></div>' +
      '<div class="x-pane" data-p="lib"><div class="x-qrow" role="group" aria-label="常用图标">' + QUICK.map(function (v) { return btn(v, false); }).join("") + "</div>" +
      '<input name="q" type="search" autocomplete="off" aria-label="搜索图标" placeholder="搜索图标，如 jellyfin"><p class="x-note" data-lmsg hidden></p><div class="x-igrid" data-lres></div></div>' +
      '<div class="x-pane" data-p="emoji"><input name="emoji" type="text" maxlength="8" aria-label="Emoji" placeholder="输入或选一个 Emoji"><div class="x-igrid">' +
      EMO.map(function (e) { return '<button type="button" data-emo="' + e + '" aria-label="' + e + '">' + e + "</button>"; }).join("") + "</div></div>" +
      '<div class="x-pane" data-p="text"><input name="text" type="text" maxlength="2" aria-label="图标文字" placeholder="1–2 个字"></div>' +
      '<div class="x-pane" data-p="image"><input name="image" type="text" ' + URLX + 'aria-label="图片网址" placeholder="图片网址 https://…"><label class="x-upl">上传图片<input type="file" accept="image/*" hidden></label></div>' +
      '<span class="x-lab">背景色</span><div class="x-sw" role="group" aria-label="背景色">' +
      BGS.map(function (b) { return '<button type="button" data-bg="' + b[0] + '" aria-label="' + (b[1] || b[0]) + '" aria-pressed="false"' + (b[1] ? "" : ' style="background:' + b[0] + '"') + "></button>"; }).join("") + "</div></div>" +
      '<div class="x-f"><span class="x-lab">分组</span><div class="x-gch" role="group" aria-label="分组">' +
      gs.map(function (g) { return '<button type="button" data-g="' + esc(g.id) + '" aria-pressed="false">' + esc(g.name) + "</button>"; }).join("") +
      '<button type="button" data-g="__new" aria-pressed="false">新分组…</button></div><input name="newg" type="text" maxlength="20" aria-label="新分组名称" placeholder="新分组名称" hidden></div>' +
      '<details class="x-more"><summary>更多</summary>' + field("lan", "内网地址", URLX + 'placeholder="http://192.168.1.20:8096"') +
      field("wan", "外网地址", URLX + 'placeholder="https://emby.example.com"') + field("desc", "描述", "", 40) +
      field("aliases", "搜索别名", 'autocapitalize="off" spellcheck="false" enterkeyhint="next" maxlength="400" placeholder="如 mp, 影视订阅"') +
      '<p class="x-note" data-anote>逗号或回车分隔 · 最多 10 个、每个 ≤32 字 · 只用于命令面板搜索</p></details></form>';
    F = {}; sh.querySelectorAll("input[name]").forEach(function (i) { F[i.name] = i; });
  }
  function curIcon() {
    var m = s.mode, v = "", t = "";
    if (m === "auto") { var n = F.nm.value.trim(); if (n) { t = "iconify"; v = "selfhst:" + slug(n); } }
    else if (m === "lib") { if (s.lib) { t = "iconify"; v = s.lib; } }
    else if (m === "image") { v = F.image.value.trim() || s.upload; if (v) t = "image"; }
    else { v = F[m].value.trim(); if (v) t = m; }
    return { type: t, value: v, bg: s.bg };
  }
  function preview(now) {
    clearTimeout(s.pt);
    var go = function () { if (s) sh.querySelector(".x-prev").innerHTML = A.util.iconHTML(curIcon(), F.nm.value.trim() || s.hint || "?"); };
    if (now) go(); else s.pt = setTimeout(go, 400);
  }
  function press(sel, attr, val) { sh.querySelectorAll(sel).forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute(attr) === val)); }); }
  function setMode(m) {
    s.mode = m; press("[data-m]", "data-m", m);
    sh.querySelectorAll("[data-p]").forEach(function (p) { p.hidden = p.getAttribute("data-p") !== m; });
    preview(true);
  }
  function setGroup(g) { s.gid = g; press("[data-g]", "data-g", g); F.newg.hidden = g !== "__new"; }
  function count() { sh.querySelectorAll("[data-cnt]").forEach(function (c) { var n = c.getAttribute("data-cnt"); c.textContent = Array.from(F[n].value).length + "/" + F[n].maxLength; }); }
  function snap() { return JSON.stringify([Object.keys(F).filter(function (k) { return k !== "q"; }).map(function (k) { return F[k].value; }), s.mode, s.lib, s.bg, s.gid, s.upload]); }
  function validate() {
    var any = false, bad = false;
    ["url", "lan", "wan"].forEach(function (k) {
      var v = F[k].value.trim(), u = v ? parse(v) : null, e = sh.querySelector('[data-err="' + k + '"]');
      if (u) any = true;
      var msg = v && !u ? (/^[a-z][\w+.-]*:(?!\d)/i.test(v) && !/^https?:\/\//i.test(v) ? "地址无效：只支持 http:// 或 https:// 开头的地址，请修改或清空" : "地址格式不对，例如 nas.local:5000 或 https://example.com") : "";
      if (k === "url" && !msg && s.touched && !F.url.value.trim() && !F.lan.value.trim() && !F.wan.value.trim()) msg = "至少填写一个地址";
      if (v && !u) bad = true;
      e.textContent = msg; e.hidden = !msg; F[k].classList.toggle("is-bad", !!msg); F[k].setAttribute("aria-invalid", String(!!msg));
    });
    var am = aliasMsg(), ae = sh.querySelector('[data-err="aliases"]');
    ae.textContent = am; ae.hidden = !am; F.aliases.classList.toggle("is-bad", !!am); F.aliases.setAttribute("aria-invalid", String(!!am));
    if (am) bad = true;
    var u0 = parse(F.url.value.trim() || F.wan.value.trim() || F.lan.value.trim());
    s.hint = u0 ? (guess(u0) || u0.hostname) : "";
    sh.querySelector("[data-a=save]").disabled = !any || bad;
    return any && !bad;
  }
  /* 搜索别名：逗号 / 回车分隔，去空白、大小写不敏感去重；≤10 个、每个 ≤32 字 */
  function aliasList() { return U.normAliases(F.aliases.value); }
  function aliasMsg() {
    var a = aliasList();
    if (a.length > U.ALIAS_MAX) return "别名最多 " + U.ALIAS_MAX + " 个（现在 " + a.length + " 个）";
    var long = a.filter(function (x) { return Array.from(x).length > U.ALIAS_LEN; })[0];
    if (long) return "每个别名最多 " + U.ALIAS_LEN + " 个字：「" + Array.from(long).slice(0, 12).join("") + "…」";
    return U.aliasProblem(a) ? "别名里有不可见字符，请删掉重输" : "";
  }
  function tidyAliases() { var a = aliasList(); if (F.aliases.value.trim()) F.aliases.value = a.join(", "); }
  function syncUrl() {
    var v = F.url.value.trim(), u = v && parse(v); if (!u) return;
    var n = norm(v), p = priv(u), tgt = p ? F.lan : F.wan, oth = p ? F.wan : F.lan;
    F.url.value = n;
    if (n === s.urlApplied) return;
    s.urlApplied = n;
    if (s.copied && s.copied.el === oth && oth.value === s.copied.v) oth.value = "";
    tgt.value = n; s.copied = { el: tgt, v: n };
    if (!F.nm.value.trim()) { var g = guess(u); if (g) { F.nm.value = Array.from(g).slice(0, 20).join(""); count(); } }
    validate(); preview(true);
  }
  function search() {
    clearTimeout(s.qt);
    var q = F.q.value.trim(), box = sh.querySelector("[data-lres]"), msg = sh.querySelector("[data-lmsg]");
    if (!q) { box.innerHTML = ""; msg.hidden = true; return; }
    s.qt = setTimeout(function () {
      var tok = ++s.qn; msg.hidden = false; msg.textContent = "搜索中…";
      fetch(API + "search?query=" + encodeURIComponent(q) + "&limit=48&prefixes=selfhst,simple-icons,logos,mdi,arcticons")
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (d) {
          if (!s || tok !== s.qn) return;
          var ic = (d && d.icons) || [];
          msg.textContent = ic.length ? "" : "没有找到，换个关键词试试"; msg.hidden = !!ic.length;
          box.innerHTML = ic.map(function (v) { return btn(v, v === s.lib); }).join("");
        })
        .catch(function () { if (!s || tok !== s.qn) return; box.innerHTML = ""; msg.hidden = false; msg.textContent = "图标库暂时连不上，换 Emoji 或文字试试"; });
    }, 400);
  }
  function upload(file) {
    if (!file) return;
    var r = new FileReader();
    r.onload = function () {
      var im = new Image();
      im.onload = function () {
        var c = document.createElement("canvas"), k = Math.max(128 / im.width, 128 / im.height), w = im.width * k, h = im.height * k;
        c.width = c.height = 128; var cx = c.getContext("2d"); cx.drawImage(im, (128 - w) / 2, (128 - h) / 2, w, h);
        /* 没有透明像素就用 JPEG（照片类图标小很多），有透明才用 PNG */
        var opaque = true;
        try { var px = cx.getImageData(0, 0, 128, 128).data; for (var i = 3; i < px.length; i += 4) if (px[i] < 255) { opaque = false; break; } } catch (x) { opaque = false; }
        var type = opaque ? "image/jpeg" : "image/png", st = s;
        function done(v) { if (s !== st) return; s.upload = v; F.image.value = ""; F.image.placeholder = "已上传图片 · 或输入网址替换"; preview(true); }
        var dataUrl = opaque ? c.toDataURL(type, 0.9) : c.toDataURL(type);
        /* 接了 NAS 后端：图标存成文件（api/icons/<id>），配置里只记地址；失败就先用 data URL，服务器同步时会再转存 */
        if (!A.uploadIcon || !c.toBlob) return done(dataUrl);
        c.toBlob(function (blob) {
          if (!blob) return done(dataUrl);
          A.uploadIcon(blob).then(done, function (e) {
            /* 413：超过每个账户的图标配额（或单个太大）—— 提示原因，不退回 data URL（那样只会把配置撑大） */
            if (e && e.status === 413) { A.toast(e.message || "上传的图标太多了", { duration: 8000 }); return; }
            done(dataUrl);
          });
        }, type, 0.9);
      };
      im.onerror = function () { A.toast("图片读取失败"); };
      im.src = r.result;
    };
    r.readAsDataURL(file);
  }

  function openSheet(o) {
    clearTimeout(closeT);
    var gs = A.state.groups, g = gs.filter(function (x) { return x.id === o.gid; })[0], item = g && o.id ? g.items.filter(function (x) { return x.id === o.id; })[0] : null;
    if (o.id && !item) return;
    build(!item);
    s = { id: item ? item.id : null, gid0: g ? g.id : null, mode: "auto", lib: "", bg: "", upload: "", qn: 0, touched: false, urlApplied: "" };
    setGroup(g ? g.id : gs[0] ? gs[0].id : "__new");
    if (item) {
      var ic = item.icon || {}, v = ic.value || "";
      F.url.value = item.wan || item.lan || ""; F.nm.value = item.title || ""; F.lan.value = item.lan || ""; F.wan.value = item.wan || ""; F.desc.value = item.desc || "";
      s.urlApplied = norm(F.url.value);
      F.aliases.value = Array.isArray(item.aliases) ? item.aliases.filter(function (x) { return typeof x === "string"; }).join(", ") : "";
      s.copied = { el: item.wan ? F.wan : F.lan, v: F.url.value }; s.bg = ic.bg || "";
      if (ic.type === "iconify" && v) { if (v !== "selfhst:" + slug(item.title || "")) { s.mode = "lib"; s.lib = v; } }
      else if (ic.type === "image" && v) { s.mode = "image"; if (/^(data:|api\/icons\/)/.test(v)) { s.upload = v; F.image.placeholder = "已上传图片 · 或输入网址替换"; } else F.image.value = v; }
      else if ((ic.type === "emoji" || ic.type === "text") && v) { s.mode = ic.type; F[ic.type].value = v; }
      if ((item.lan && item.wan) || F.aliases.value) sh.querySelector(".x-more").open = true;
    }
    press("[data-bg]", "data-bg", s.bg); press("[data-ic]", "data-ic", s.lib);
    setMode(s.mode); count(); validate(); s.init = snap();
    if (o.url) { F.url.value = o.url; syncUrl(); }
    lastFocus = document.activeElement;
    back.hidden = sh.hidden = false; open = true; sh.setAttribute("aria-label", item ? "编辑项目" : "添加项目");
    void sh.offsetWidth; back.classList.add("is-on"); sh.classList.add("is-on"); sh.scrollTop = 0;
    setTimeout(function () { if (open) (item || o.url ? sh.querySelector("[data-a=cancel]") : F.url).focus({ preventScroll: true }); }, 60);
  }
  function close() {
    if (!open) return;
    open = false; clearTimeout(s.pt); clearTimeout(s.qt); s = null;
    back.classList.remove("is-on"); sh.classList.remove("is-on");
    closeT = setTimeout(function () { back.hidden = sh.hidden = true; sh.innerHTML = ""; }, 300);
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }
  function confirmBox(on) { var c = sh.querySelector(".x-confirm"); c.hidden = !on; if (on) c.querySelector("[data-a=keep]").focus(); }
  function tryClose() { if (snap() !== s.init) confirmBox(true); else close(); }
  function save() {
    syncUrl(); s.touched = true;
    if (!validate()) return;
    if (s.mode === "image" && F.image.value.trim() && !U.image(F.image.value.trim())) { A.toast("图片网址无效：只支持 http:// 或 https:// 开头的地址"); return; }
    var lan = F.lan.value.trim() ? norm(F.lan.value) : "", wan = F.wan.value.trim() ? norm(F.wan.value) : "";
    var title = F.nm.value.trim() || s.hint || "未命名", id = s.id, gid0 = s.gid0, gid = s.gid, ng = F.newg.value.trim() || "新分组";
    var data = { title: title, desc: F.desc.value.trim(), lan: lan, wan: wan, icon: curIcon() }, aliases = aliasList();
    if (aliases.length) data.aliases = aliases; /* 没填别名的项目不加这个字段，保持原样 */
    var SPC = A.spaces, pinned = false;
    A.commit(function (st) {
      var tg = gid === "__new" ? null : st.groups.filter(function (x) { return x.id === gid; })[0];
      if (!tg) { tg = { id: uid(), name: ng, style: "icon", items: [] }; st.groups.push(tg); if (SPC) SPC.adoptGroup(st, tg.id); /* 在空间里新建的分组整组进本空间 */ }
      /* 在空间里添加 / 改分组：目标分组不在本空间 → 这个项目单独加进本空间（itemIds），保存后仍在眼前；在「全部」里不改任何空间 */
      var keep = function (x) { if (SPC) pinned = SPC.keepVisible(st, x); };
      if (!id) { data.id = uid(); tg.items.push(data); keep(data.id); return; }
      var og = st.groups.filter(function (x) { return x.id === gid0; })[0], i = og ? og.items.findIndex(function (x) { return x.id === id; }) : -1;
      if (i < 0) { data.id = id; tg.items.push(data); keep(id); return; }
      var it = Object.assign(og.items[i], data);
      if (!aliases.length) delete it.aliases;
      if (og !== tg) { og.items.splice(i, 1); tg.items.push(it); keep(id); }
    }, id ? "edit-item" : "add-item");
    close();
    A.toast((id ? "已保存" : "已添加「" + title + "」") + (pinned ? "（分组「" + (gid === "__new" ? ng : (A.state.groups.filter(function (x) { return x.id === gid; })[0] || {}).name) + "」不在本空间，已单独加入本空间）" : ""));
  }

  back.addEventListener("click", function () { if (open) tryClose(); });
  sh.addEventListener("click", function (e) {
    if (!s) return;
    var t = e.target, b;
    if ((b = t.closest("[data-a]"))) {
      var a = b.getAttribute("data-a");
      if (a === "cancel") tryClose(); else if (a === "save") save(); else if (a === "discard") close(); else confirmBox(false);
    } else if ((b = t.closest("[data-m]"))) setMode(b.getAttribute("data-m"));
    else if ((b = t.closest("[data-ic]"))) { s.lib = b.getAttribute("data-ic"); press("[data-ic]", "data-ic", s.lib); preview(true); }
    else if ((b = t.closest("[data-emo]"))) { F.emoji.value = b.getAttribute("data-emo"); preview(true); }
    else if ((b = t.closest("[data-bg]"))) { s.bg = s.bg === b.getAttribute("data-bg") ? "" : b.getAttribute("data-bg"); press("[data-bg]", "data-bg", s.bg); preview(true); }
    else if ((b = t.closest("[data-g]"))) { setGroup(b.getAttribute("data-g")); if (s.gid === "__new") F.newg.focus(); }
  });
  sh.addEventListener("input", function (e) {
    if (!s) return;
    var n = e.target.name;
    if (n === "q") search();
    else if (n === "nm") { count(); preview(false); validate(); }
    else if (n === "desc") count();
    else if (n === "aliases") validate();
    else if (n === "url" || n === "lan" || n === "wan") validate();
    else if (n === "emoji" || n === "text" || n === "image") { if (n === "image") s.upload = ""; preview(n !== "image"); }
  });
  sh.addEventListener("focusout", function (e) {
    if (s && e.target === F.url) { s.touched = true; syncUrl(); validate(); }
    if (s && e.target === F.aliases) { tidyAliases(); validate(); }
  });
  /* 别名框里回车 = 分隔（不提交表单） */
  sh.addEventListener("keydown", function (e) {
    if (!s || e.target !== F.aliases || e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
    e.preventDefault(); tidyAliases(); if (F.aliases.value) F.aliases.value += ", "; validate();
  });
  sh.addEventListener("change", function (e) { if (s && e.target.type === "file") { upload(e.target.files[0]); e.target.value = ""; } });
  sh.addEventListener("submit", function (e) { e.preventDefault(); if (s) save(); });
  window.addEventListener("keydown", function (e) {
    if (!open) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); if (!sh.querySelector(".x-confirm").hidden) confirmBox(false); else tryClose(); }
    else if ((e.metaKey || e.ctrlKey) && (e.key === "e" || e.key === "E")) e.stopImmediatePropagation();
  }, true);

  A.on("add-item", function (d) { d.handled = true; openSheet({ gid: d.gid }); });
  A.on("edit-item", function (d) { d.handled = true; openSheet({ gid: d.gid, id: d.id }); });
  document.addEventListener("paste", function (e) {
    var t = e.target;
    if (open || (t && t.closest && t.closest("input, textarea, select, [contenteditable]"))) return;
    var tx = ((e.clipboardData || window.clipboardData).getData("text") || "").trim();
    if (!tx || /\s/.test(tx) || !(hasScheme(tx) || /^[\w-]+(\.[\w-]+)*(\.[a-z]{2,}|:\d{2,5})(:\d{2,5})?([\/?#]\S*)?$/i.test(tx)) || !parse(tx)) return;
    e.preventDefault();
    var g = A.spaces ? A.spaces.defaultGroup() : A.state.groups.filter(function (x) { return x.style !== "chip"; })[0] || A.state.groups[0];
    openSheet({ gid: g && g.id, url: tx });
  });
})();

/* Stage 4 · network, status, recent. Uses only the App API. */
(function () {
  "use strict";
  var A = window.App, esc = A.util.esc, body = document.body;
  var groupsEl = document.getElementById("x-groups");
  var NM = window.NocturneNet, NAMES = NM.NAMES, ST = window.NocturneStatus;
  var s0 = A.state;
  /* 迁移：本机已存的 lan / wan 原样保留；新设备（本机没存过）或非法值 → auto（只按本页的访问主机名判断） */
  s0.settings.net = NM.migrate(s0.settings.net);
  if (!Array.isArray(s0.recent)) s0.recent = [];
  A.save();
  var keep = { net: s0.settings.net, recent: s0.recent.slice() };
  var stat = new Map(), gen = 0, lastCheck = 0;

  function all() {
    var m = A.util.dict();
    A.state.groups.forEach(function (g) { (g.items || []).forEach(function (i) { m[i.id] = { item: i, icon: g.style !== "chip" }; }); });
    return m;
  }
  /* 用户选的模式（auto / lan / wan，本机） */
  function pref() { return NM.migrate(A.state.settings.net); }
  /* 实际生效的方向（lan / wan）：auto 只看当前页面的访问主机名，不探测、不测速 */
  function mode() { return NM.effective(pref(), location.hostname); }
  /* 唯一的地址选择出口：网格、最近使用、离线列表、命令面板都走这里。无效地址（非 http/https）按没填处理 */
  A.url = function (item) {
    return NM.pick(item, mode(), A.util.url.safeNav).url || "#";
  };
  /* 显式打开某一类地址（备用地址）：只返回通过白名单的地址，否则 "" */
  A.urlOf = function (item, kind) { return item && (kind === "lan" || kind === "wan") ? A.util.url.safeNav(item[kind]) : ""; };
  A.net = {
    modes: NM.MODES, names: NAMES,
    mode: pref, effective: mode,
    label: function () { return NM.label(pref(), location.hostname); },
    /* 切换模式：只改本机 settings.net（不参与同步、不产生服务器版本）。返回是否真的改了 */
    set: function (v, quiet) {
      v = NM.norm(v); if (!v) return false;
      var changed = v !== pref();
      A.state.settings.net = keep.net = v; A.save();
      if (changed) { A.render(); check(true); }
      if (!quiet) A.toast(v === "auto" ? "网络：自动（当前" + NAMES[mode()] + "优先）" : "网络：优先" + NAMES[v]);
      return changed;
    }
  };

  /* ---- UI ---- */
  var nw = document.createElement("button");
  nw.type = "button"; nw.className = "x-net x-glass"; nw.setAttribute("aria-haspopup", "menu"); nw.setAttribute("aria-expanded", "false");
  nw.innerHTML = '<i aria-hidden="true"></i><span></span>';
  document.querySelector(".x-head").insertBefore(nw, document.getElementById("btn-menu"));
  var side = document.createElement("aside");
  side.className = "x-side"; side.setAttribute("aria-label", "状态与最近");
  side.innerHTML = '<section class="x-card x-glass"><h2>系统状态</h2><div class="x-stat"><svg class="x-ring" viewBox="0 0 40 40" aria-hidden="true">' +
    '<circle class="bg" cx="20" cy="20" r="17"/><circle class="fg" cx="20" cy="20" r="17"/></svg><p class="x-cnt"></p></div><p class="x-sline"></p><p class="x-snote" hidden></p></section>' +
    '<section class="x-card x-glass" data-recent hidden><h2>最近使用</h2><div class="x-recent"></div></section>';
  groupsEl.after(side);
  var live = document.createElement("div");
  live.className = "x-sr"; live.setAttribute("role", "status"); live.setAttribute("aria-live", "polite");
  body.appendChild(live);
  var C = 2 * Math.PI * 17, fg = side.querySelector(".fg");
  fg.style.strokeDasharray = C; fg.style.strokeDashoffset = C;

  function syncNet() {
    var n = mode(), l = A.net.label();
    nw.setAttribute("data-eff", n);
    nw.querySelector("span").textContent = l;
    nw.setAttribute("aria-label", "网络模式：" + (pref() === "auto" ? "自动，当前优先" + NAMES[n] : "优先" + NAMES[n]) + "。点按更改");
    if (netOpen) drawNetMenu();
  }
  /* 状态检测永远覆盖全部项目（与空间无关）；这里的「在线 x / y」只统计当前空间看得见的图标项目 */
  function inScope() { var sc = A.spaces ? A.spaces.scope() : null; return function (id) { return !sc || sc.has(String(id)); }; }
  function apply() {
    var m = all(), ids = [], on = 0, pend = 0, off = [], auth = 0, ok = inScope(), cs = A.spaces && A.spaces.current();
    side.querySelector(".x-card h2").textContent = cs ? "系统状态 · " + cs.name : "系统状态";
    /* 可信标注（status.js）：服务器测到的才说在线 / 离线 / ms / 检测时间；浏览器探测只说「可能在线 / 无法确认」 */
    groupsEl.querySelectorAll(".x-tile[data-id], .x-chip[data-id]").forEach(function (el) {
      var e = m[el.getAttribute("data-id")]; if (!e) return;
      el.setAttribute("href", A.url(e.item));
      var d = el.querySelector(":scope > .dot"); if (!d) return;
      var c = stat.get(e.item.id) || ST.classify(null), t = ST.text(c);
      d.className = "dot " + c.s; d.title = t;
      el.setAttribute("data-s", c.s);
      var sx = el.querySelector(".x-st"); if (sx) { sx.textContent = ST.short(c); sx.setAttribute("data-s", c.s); }
      var hx = el.querySelector(".x-host"), hu = A.url(e.item); if (hx) { try { hx.textContent = hu !== "#" ? new URL(hu).host : "没有地址"; } catch (er) { hx.textContent = ""; } }
      el.title = [e.item.title, e.item.desc, t].filter(Boolean).join(" · ");
    });
    var cs2 = [];
    Object.keys(m).forEach(function (id) {
      if (!m[id].icon || !ok(id)) return;
      var c = stat.get(id) || ST.classify(null); cs2.push(c);
      if (c.s === "off") off.push(m[id].item.title);
    });
    var sm = ST.summary(cs2), total = sm.total, sl = side.querySelector(".x-sline"), card = side.querySelector(".x-card");
    lastSummary = sm;
    card.setAttribute("data-mode", sm.mode);
    side.querySelector(".x-cnt").innerHTML = !total ? "0<small>个服务</small>"
      : sm.mode === "browser" ? sm.counts.maybe + " / " + total + "<small>可能在线</small>"
      : sm.online + " / " + sm.certain + "<small>在线</small>";
    fg.style.strokeDashoffset = C * (1 - (!total ? 0 : sm.mode === "browser" ? sm.counts.maybe / total : sm.certain ? sm.online / sm.certain : 0));
    sl.className = "x-sline" + (sm.tone ? " is-" + sm.tone : "");
    sl.textContent = sm.tone === "off" ? "离线：" + off.join("、") : sm.line;
    var nt = side.querySelector(".x-snote"); if (nt) { nt.textContent = [sm.note, sm.mode === "browser" ? "纯静态页没有服务器检测" : ""].filter(Boolean).join(" · "); nt.hidden = !nt.textContent; }
  }
  var lastSummary = null;
  function renderRecent() {
    var m = all(), rc = (A.state.recent || []).filter(function (id) { return m[id]; }).slice(0, 4);
    side.querySelector("[data-recent]").hidden = !rc.length;
    side.querySelector(".x-recent").innerHTML = rc.map(function (id) {
      var i = m[id].item;
      return '<a class="x-rt" href="' + esc(A.url(i)) + '" target="_blank" rel="noopener" data-rid="' + esc(id) + '">' + A.util.iconHTML(i.icon, i.title) + "<span>" + esc(i.title) + "</span></a>";
    }).join("");
  }
  function refresh() { syncNet(); apply(); renderRecent(); }

  /* ---- status ---- */
  function timed(u, ms) {
    var c = new AbortController(), t = setTimeout(function () { c.abort(); }, ms);
    return fetch(u, { mode: "no-cors", cache: "no-store", signal: c.signal }).then(
      function () { clearTimeout(t); return true; }, function () { clearTimeout(t); return false; });
  }
  /* reserved placeholder domains (RFC 2606) never resolve: mark offline without a request */
  function reserved(u) {
    try { return /(^|\.)(example\.(com|net|org)|example|test|invalid)$/i.test(new URL(u).hostname); } catch (e) { return true; }
  }
  /* private-network hosts: only reachable (and only worth requesting) from inside the home network */
  function privName(h) {
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(h) || /\.(local|lan|home\.arpa|internal)$/i.test(h);
  }
  function privHost(u) { try { return privName(new URL(u).hostname); } catch (e) { return false; } }
  function onLan() { return privName(location.hostname); }
  function check(reset) {
    var g = ++gen, m = all(), list = Object.keys(m).filter(function (id) { return m[id].icon; }).map(function (id) { return m[id].item; });
    lastCheck = Date.now();
    if (reset) list.forEach(function (i) { stat.set(i.id, ST.classify(null)); });
    apply();
    var q = list.slice(), active = 0, left = q.length;
    function run(it) {
      var u = A.url(it);
      active++;
      /* 浏览器探测（no-cors）：只知道有没有网络错误 → {source:"browser", reachable}；不计时（测到的不是服务的响应时间） */
      function local() {
        if (u === "#") return Promise.resolve({ source: "none", reason: "noaddr" });
        if (reserved(u)) return Promise.resolve({ source: "none", reason: "reserved" });
        if (privHost(u) && mode() !== "lan" && !onLan()) return Promise.resolve({ source: "none", reason: "offlan" });
        return timed(u, 3000).then(function (ok) { return { source: "browser", reachable: ok }; });
      }
      /* Nocturne backend hook: A.statusFor(item, local) → Promise<{source:"server", up, status, ms, checkedAt, code}>；服务器没给这一项时退回 local() */
      (A.statusFor ? A.statusFor(it, local) : local()).then(function (r) {
        if (g !== gen) return;
        if (typeof r === "boolean") r = { source: "browser", reachable: r }; /* 旧接口兼容 */
        stat.set(it.id, ST.classify(r));
        active--; left--; apply();
        if (left) next(); else finish();
      });
    }
    function next() { while (active < 4 && q.length) run(q.shift()); }
    if (left) next(); else finish();
  }
  function finish() {
    var m = all(), ok = inScope(), cs = [];
    Object.keys(m).forEach(function (id) { if (!m[id].icon || !ok(id)) return; cs.push(stat.get(id) || ST.classify(null)); });
    var sm = ST.summary(cs), n = sm.counts;
    live.textContent = "";
    setTimeout(function () { live.textContent = ST.spoken(sm); }, 50);
    var w = doneWaiters; doneWaiters = [];
    var d = { on: sm.online, off: n.off, maybe: n.maybe, unknown: n.unknown, na: n.na, mode: sm.mode };
    w.forEach(function (f) { try { f(d); } catch (e) { console.error(e); } });
  }
  /** 某个项目当前的可信状态（compact 行、读屏、测试用） */
  A.statusOf = function (id) { return stat.get(String(id)) || null; };
  var doneWaiters = [];
  function recheck() { if (Date.now() - lastCheck > 60000) check(false); }
  /* cb({on, off})：这一轮检测真正结束后回调（命令面板「重新检测状态」据此报告结果） */
  A.recheck = function (reset, cb) { if (typeof cb === "function") doneWaiters.push(cb); check(!!reset); };

  /* ---- events ---- */
  /* ---- 网络模式菜单：一次点按即可纠正，不做任何自动探测 ---- */
  var netm = document.createElement("div"), netOpen = false, netT = null;
  netm.className = "x-netm"; netm.hidden = true; netm.setAttribute("role", "menu"); netm.setAttribute("aria-label", "网络模式");
  body.appendChild(netm);
  function drawNetMenu() {
    var p = pref(), auto = NM.decide(location.hostname);
    var opts = [
      ["auto", "自动", "按本页访问地址判断 · 当前优先" + NAMES[auto]],
      ["lan", "优先内网", "没有内网地址时用外网"],
      ["wan", "优先外网", "没有外网地址时用内网"]
    ];
    netm.innerHTML = opts.map(function (o) {
      return '<button type="button" role="menuitemradio" aria-checked="' + (o[0] === p) + '" data-net="' + o[0] + '"><b aria-hidden="true">' + (o[0] === p ? "✓" : "") + "</b><span>" + o[1] + "<small>" + esc(o[2]) + "</small></span></button>";
    }).join("") + "<p>只影响这台设备</p>";
  }
  function placeNetMenu() {
    var r = nw.getBoundingClientRect(), vw = document.documentElement.clientWidth;
    netm.style.top = Math.round(r.bottom + 8) + "px";
    netm.style.right = Math.max(8, Math.round(vw - r.right)) + "px";
  }
  function openNet() {
    clearTimeout(netT); drawNetMenu(); netm.hidden = false; placeNetMenu();
    netOpen = true; nw.setAttribute("aria-expanded", "true");
    requestAnimationFrame(function () { netm.classList.add("is-on"); });
    var cur = netm.querySelector('[aria-checked="true"]') || netm.querySelector("button");
    if (cur) cur.focus({ preventScroll: true });
  }
  function closeNet(refocus) {
    if (!netOpen) return;
    netOpen = false; nw.setAttribute("aria-expanded", "false"); netm.classList.remove("is-on");
    netT = setTimeout(function () { if (!netOpen) netm.hidden = true; }, 180);
    if (refocus) nw.focus({ preventScroll: true });
  }
  A.net.openMenu = openNet;
  nw.addEventListener("click", function () { if (netOpen) closeNet(true); else openNet(); });
  netm.addEventListener("click", function (e) {
    var b = e.target.closest("[data-net]"); if (!b) return;
    closeNet(true); A.net.set(b.getAttribute("data-net"));
  });
  /* 点菜单外面任何地方只关闭菜单：这次点按不会顺带打开下面的服务 */
  var eatNet = 0;
  document.addEventListener("pointerdown", function (e) {
    if (netOpen && !netm.contains(e.target) && !nw.contains(e.target)) { closeNet(false); eatNet = Date.now(); }
  }, true);
  document.addEventListener("click", function (e) {
    if (eatNet && Date.now() - eatNet < 800 && !netm.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
    eatNet = 0;
  }, true);
  document.addEventListener("keydown", function (e) {
    if (!netOpen) return;
    var bs = [].slice.call(netm.querySelectorAll("button")), i = bs.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closeNet(true); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); bs[(i + (e.key === "ArrowDown" ? 1 : bs.length - 1)) % bs.length].focus(); }
    else if (e.key === "Tab") closeNet(false);
  }, true);
  window.addEventListener("resize", function () { if (netOpen) placeNetMenu(); });
  window.addEventListener("scroll", function () { if (netOpen) closeNet(false); }, { passive: true });
  function track(e) {
    if (e.defaultPrevented || body.classList.contains("editing") || (e.type === "auxclick" && e.button !== 1)) return;
    var a = e.target.closest && e.target.closest("#x-groups [data-id], .x-side [data-rid]"); if (!a || a.tagName !== "A") return;
    remember(a.getAttribute("data-id") || a.getAttribute("data-rid"));
  }
  /** 记入「最近使用」（本机）：点图标 / 最近使用 / 离线芯片，或命令面板打开了一个不在当前空间里的项目 */
  function remember(id) {
    if (id == null) return;
    var r = (A.state.recent || []).filter(function (x) { return x !== id; }); r.unshift(id);
    A.state.recent = keep.recent = r.slice(0, 8); A.save();
    setTimeout(renderRecent, 0);
  }
  A.trackRecent = function (id) { if (!body.classList.contains("editing")) remember(String(id)); };
  document.addEventListener("click", track);
  document.addEventListener("auxclick", track);
  /* 没有地址 / 地址无效的项目不可点击：不再打开一个空白的新标签页 */
  document.addEventListener("click", function (e) {
    if (body.classList.contains("editing")) return;
    var a = e.target.closest && e.target.closest("#x-groups a[data-id], .x-side a[data-rid]");
    if (!a || a.getAttribute("href") !== "#") return;
    e.preventDefault();
    var r = all()[a.getAttribute("data-id") || a.getAttribute("data-rid")], i = r && r.item;
    A.toast(i && (i.lan || i.wan) ? "「" + i.title + "」的地址无效，请在编辑里修改" : "这个项目还没有地址");
  }, true);
  A.on("render", refresh);
  /* 网络模式、最近使用是这台设备自己的：撤销 / 导入 / 恢复默认都不改它们 */
  A.on("change", function (d) {
    var s = A.state, lbl = d && d.label;
    if (!s.settings) return;
    var netChanged = s.settings.net !== keep.net;
    if (lbl !== "undo" && lbl !== "import" && lbl !== "reset" && !netChanged) return;
    s.settings.net = keep.net;
    if (lbl === "undo" || lbl === "import" || lbl === "reset") s.recent = keep.recent.slice();
    A.save();
    if (netChanged) A.render(); else renderRecent();
  });
  A.on("editmode", function (d) { if (d && !d.on) check(false); });
  window.addEventListener("online", recheck);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) recheck(); });
  setInterval(function () { if (!document.hidden) check(false); }, 60000);

  refresh();
  check(true);
})();

/* Stage 5a · ⋯ menu + settings shell (外观). App API only. */
(function () {
  "use strict";
  var A = window.App, esc = A.util.esc, body = document.body, $ = function (id) { return document.getElementById(id); };
  var WP = { star: ["星环湖", ""], night: ["深夜", "linear-gradient(160deg,#0A0D14,#1A2030)"], dusk: ["暮色", "linear-gradient(160deg,#1B1626,#3A2A2A)"], min: ["极简", "#0E1116"] };
  var SHOW = [["clock", "时钟"], ["sec", "秒"], ["date", "日期"], ["greet", "问候语"], ["search", "搜索栏"], ["status", "系统状态"], ["recent", "最近使用"]];
  function wp() { return Object.assign({ id: "star", url: "", dim: 35, blur: 0 }, A.state.settings.wallpaper || {}); }
  function show() { var s = { }; SHOW.forEach(function (k) { s[k[0]] = true; }); return Object.assign(s, A.state.settings.show || {}); }
  function set(fn, label) { A.commit(function (s) { fn(s.settings); }, label || "settings"); }

  /* ---- wallpaper + visibility ---- */
  var imgs = [].slice.call(document.querySelectorAll(".x-bg")), shade = document.querySelector(".x-shade");
  var layer = document.createElement("div"); layer.className = "x-wp"; layer.hidden = true; shade.before(layer);
  /* 自定义壁纸先预加载：加载成功才替换；文件不见了（404 / 导出导入没带上）就保留默认壁纸，不会整页变黑 */
  var wpState = A.util.dict(), wpWarned = false, wpShown = "";
  function wpReady(src, isFile) {
    if (wpState[src] === "ok") return true;
    if (wpState[src]) return false; // loading / failed
    wpState[src] = "loading";
    var im = new Image();
    im.onload = function () { wpState[src] = "ok"; applyWp(wp()); };
    im.onerror = function () {
      wpState[src] = "failed";
      if (!wpWarned) { wpWarned = true; A.toast(isFile ? "自定义壁纸文件不见了，已用默认壁纸" : "自定义壁纸加载失败，已用默认壁纸"); }
    };
    im.src = src;
    return false;
  }
  function applyWp(w) {
    // file:true → 存在 NAS 上的自定义壁纸（/api/wallpaper）；纯静态页没有后端时退回默认壁纸
    var src = w.id !== "custom" ? "" : w.file ? (A.wallpaperUrl ? A.wallpaperUrl(w) : "") : A.util.url.wallpaper(w.url) ? w.url : "";
    // 新图还没加载好：先保留正在显示的那张（没有就显示默认壁纸）
    if (src && !wpReady(src, !!w.file)) src = wpShown && wpState[wpShown] === "ok" && w.id === "custom" ? wpShown : "";
    wpShown = src;
    var bg = src ? 'url("' + String(src).replace(/["\\\n]/g, encodeURIComponent) + '") center / cover no-repeat' : w.id === "custom" ? "" : (WP[w.id] || WP.star)[1];
    layer.style.background = bg; layer.hidden = !bg;
    var f = w.blur > 0 ? "blur(" + w.blur + "px)" : "";
    imgs.concat(layer).forEach(function (e) { e.style.filter = f; e.style.transform = f ? "scale(1.08)" : ""; });
    imgs.forEach(function (i) { i.style.visibility = bg ? "hidden" : ""; });
    var d = Math.max(0, Math.min(100, w.dim == null ? 35 : +w.dim || 0)) / 100;
    shade.style.background = "linear-gradient(180deg, rgba(6, 8, 13, " + d + ") 0%, rgba(6, 8, 13, " + Math.min(.92, d + (d ? .4 : 0)) + ") 100%)";
  }
  var clock = $("x-clock");
  function trim() { if (!show().sec && clock.textContent.length > 5) clock.textContent = clock.textContent.slice(0, 5); }
  new MutationObserver(trim).observe(clock, { childList: true, characterData: true, subtree: true });
  function applyShow() {
    var s = show();
    clock.hidden = !s.clock; $("x-date").hidden = !s.date; $("x-greet").hidden = !s.greet; $("x-search").hidden = !s.search;
    document.querySelector(".x-hero").classList.toggle("x-off", !s.clock && !s.date && !s.greet);
    var side = document.querySelector(".x-side");
    if (side) {
      var st = side.querySelector(".x-card:not([data-recent])"), rc = side.querySelector("[data-recent]");
      if (st) st.classList.toggle("x-off", !s.status);
      if (rc) rc.classList.toggle("x-off", !s.recent);
      side.classList.toggle("x-off", !s.status && !s.recent);
    }
    trim();
  }

  /* ---- overlays ---- */
  var scrim = document.createElement("div"); scrim.className = "x-sb"; scrim.hidden = true;
  var menu = document.createElement("div"); menu.className = "x-menu x-glass"; menu.hidden = true;
  menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", "菜单");
  menu.innerHTML = '<button type="button" role="menuitem" data-m="palette">快速打开</button><button type="button" role="menuitem" data-m="edit">编辑主页</button><button type="button" role="menuitem" data-m="add">添加项目</button><button type="button" role="menuitem" data-m="spaces">管理空间</button><button type="button" role="menuitem" data-m="set">设置</button>';
  var sp = document.createElement("div"); sp.className = "x-set"; sp.hidden = true;
  sp.setAttribute("role", "dialog"); sp.setAttribute("aria-modal", "true"); sp.setAttribute("aria-labelledby", "x-set-t");
  var TABS = ["外观", "搜索", "数据"];
  function sw(k, l) { return '<label class="x-row"><span>' + l + '</span><input class="x-tg" type="checkbox" role="switch" data-show="' + k + '"></label>'; }
  function txt(k, l, ph) { return '<label class="x-row"><span>' + l + '</span><input type="text" data-txt="' + k + '" placeholder="' + ph + '" maxlength="24"></label>'; }
  function rng(k, l, max) { return '<label class="x-row"><span>' + l + '</span><input type="range" min="0" max="' + max + '" step="1" data-rng="' + k + '"><output data-out="' + k + '"></output></label>'; }
  sp.innerHTML = '<div class="x-set-h"><h3 id="x-set-t">设置</h3><button type="button" class="x-set-done" data-a="done">完成</button></div>' +
    '<div class="x-sg" role="tablist" aria-label="设置分类">' + TABS.map(function (t, i) { return '<button type="button" role="tab" data-tab="' + t + '" aria-selected="' + !i + '">' + t + "</button>"; }).join("") + "</div>" +
    TABS.map(function (t, i) { return '<div class="x-set-p" role="tabpanel" aria-label="' + t + '" data-pane="' + t + '"' + (i ? " hidden" : "") + "></div>"; }).join("");
  var panes = {}; [].forEach.call(sp.querySelectorAll("[data-pane]"), function (p) { panes[p.getAttribute("data-pane")] = p; });
  panes["外观"].innerHTML = '<p class="x-gt">壁纸</p><div class="x-wps" role="group" aria-label="壁纸">' +
    Object.keys(WP).map(function (k) { return '<button type="button" class="x-wpt" data-wp="' + k + '" aria-pressed="false"><i' + (WP[k][1] ? ' style="background:' + WP[k][1] + '"' : "") + "></i>" + WP[k][0] + "</button>"; }).join("") + "</div>" +
    '<div class="x-gl" style="margin-top:12px"><label class="x-row"><span>图片网址</span><input type="url" data-wpurl inputmode="url" placeholder="https://…"></label>' +
    '<label class="x-row"><span>从相册选择</span><input type="file" accept="image/*" hidden></label>' + rng("dim", "暗度", 80) + rng("blur", "模糊", 20) + "</div>" +
    '<p class="x-gt">标题</p><div class="x-gl">' + txt("title", "标题", "夜曲") + txt("subtitle", "副标题", "Nocturne") + txt("user", "称呼", "你的名字") + "</div>" +
    '<p class="x-gt">显示</p><div class="x-gl">' + SHOW.map(function (k) { return sw(k[0], k[1]); }).join("") + "</div>" +
    '<p class="x-gt">布局</p><div class="x-gl"><div class="x-row"><span>手机每行</span><div class="x-sg" role="group" aria-label="手机每行图标数">' +
    [3, 4, 5].map(function (n) { return '<button type="button" data-cols="' + n + '" aria-pressed="false">' + n + "</button>"; }).join("") + "</div></div></div>";
  var thumb = imgs[0] && imgs[0].cloneNode(); if (thumb) { thumb.className = ""; sp.querySelector('[data-wp="star"] i').appendChild(thumb); }
  body.append(scrim, menu, sp);
  A.settingsPanes = { "搜索": panes["搜索"], "数据": panes["数据"] };

  function sync() {
    var w = wp(), s = show(), st = A.state.settings, f = document.activeElement;
    sp.querySelectorAll("[data-wp]").forEach(function (b) { b.setAttribute("aria-pressed", b.getAttribute("data-wp") === w.id); });
    var u = sp.querySelector("[data-wpurl]"); if (u !== f) u.value = w.id === "custom" && !/^data:/.test(w.url) ? w.url : "";
    ["dim", "blur"].forEach(function (k) { sp.querySelector('[data-rng="' + k + '"]').value = w[k]; out(k, w[k]); });
    sp.querySelectorAll("[data-txt]").forEach(function (i) { if (i !== f) i.value = st[i.getAttribute("data-txt")] || ""; });
    sp.querySelectorAll("[data-show]").forEach(function (i) { i.checked = !!s[i.getAttribute("data-show")]; });
    sp.querySelector('[data-show="sec"]').disabled = !s.clock;
    sp.querySelectorAll("[data-cols]").forEach(function (b) { b.setAttribute("aria-pressed", +b.getAttribute("data-cols") === (+st.cols || 4)); });
  }
  function out(k, v) { sp.querySelector('[data-out="' + k + '"]').textContent = k === "blur" ? v + "px" : v + "%"; }

  var cur = null, back = null;
  function open(el) {
    if (cur) { cur.classList.remove("is-on"); cur.hidden = true; } else back = document.activeElement;
    cur = el; el.hidden = false; scrim.hidden = false; body.classList.add("x-lock");
    scrim.classList.toggle("is-clear", el === menu);
    if (el === sp) sync();
    requestAnimationFrame(function () { requestAnimationFrame(function () { scrim.classList.add("is-on"); el.classList.add("is-on"); }); });
    (el === sp ? sp.querySelector(".x-set-done") : menu.querySelector("button")).focus({ preventScroll: true });
  }
  function close() {
    if (!cur) return;
    var el = cur; cur = null; el.classList.remove("is-on"); scrim.classList.remove("is-on"); body.classList.remove("x-lock");
    setTimeout(function () { if (cur !== el) el.hidden = true; if (!cur) scrim.hidden = true; }, 320);
    if (back && back.focus) back.focus({ preventScroll: true });
  }
  document.querySelector(".x-dock").addEventListener("click", function (e) {
    if (cur && e.target.closest('[data-act="search"]')) close();
  }, true);
  function openMenu() {
    open(menu);
    if (matchMedia("(min-width: 768px)").matches) {
      var r = $("btn-menu").getBoundingClientRect();
      menu.style.top = r.bottom + 8 + "px"; menu.style.right = Math.max(8, innerWidth - r.right) + "px";
    } else { menu.style.top = ""; menu.style.right = ""; }
  }
  scrim.addEventListener("click", close);
  menu.addEventListener("click", function (e) {
    var b = e.target.closest("[data-m]"); if (!b) return;
    var m = b.getAttribute("data-m");
    if (m === "set") return open(sp);
    close();
    if (m === "palette") { if (A.palette) A.palette.open(""); return; } /* 手机上的命令面板入口：在这次点按里直接聚焦输入框，软键盘才会弹出 */
    if (m === "edit") return A.emit("edit");
    if (m === "spaces") { if (A.spaces) A.spaces.manage(); return; }
    var g = A.spaces ? A.spaces.defaultGroup() : A.state.groups.filter(function (x) { return x.style !== "chip"; })[0] || A.state.groups[0];
    var d = { gid: g && g.id, handled: false }; A.emit("add-item", d);
    if (!d.handled) A.toast("即将上线");
  });

  /* ---- settings events ---- */
  sp.addEventListener("click", function (e) {
    var t = e.target.closest("[data-tab],[data-wp],[data-cols],[data-a]"); if (!t) return;
    if (t.hasAttribute("data-a")) return close();
    if (t.hasAttribute("data-tab")) {
      var n = t.getAttribute("data-tab");
      sp.querySelectorAll("[data-tab]").forEach(function (b) { b.setAttribute("aria-selected", b === t); });
      Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== n; });
      return;
    }
    if (t.hasAttribute("data-wp")) { var id = t.getAttribute("data-wp"); if (id !== wp().id) set(function (s) { s.wallpaper = Object.assign(wp(), { id: id }); }, "wallpaper"); return; }
    var c = +t.getAttribute("data-cols"); if (c !== (+A.state.settings.cols || 4)) set(function (s) { s.cols = c; }, "cols");
  });
  sp.addEventListener("input", function (e) {
    var k = e.target.getAttribute("data-rng"); if (!k) return;
    var w = wp(); w[k] = +e.target.value; out(k, w[k]); applyWp(w);
  });
  sp.addEventListener("change", function (e) {
    var t = e.target, k;
    if ((k = t.getAttribute("data-rng"))) { var v = +t.value; if (v !== wp()[k]) set(function (s) { s.wallpaper = wp(); s.wallpaper[k] = v; }, "wallpaper"); }
    else if ((k = t.getAttribute("data-txt"))) { var x = t.value.trim(); if (x !== (A.state.settings[k] || "")) set(function (s) { s[k] = x; }, k); }
    else if ((k = t.getAttribute("data-show"))) { var on = t.checked; set(function (s) { s.show = show(); s.show[k] = on; }, "show"); }
    else if (t.hasAttribute("data-wpurl")) {
      var u = t.value.trim();
      if (u && !A.util.url.http(u)) { A.toast("请输入 http(s) 开头的图片网址"); return; }
      set(function (s) { s.wallpaper = Object.assign(wp(), u ? { id: "custom", url: u, file: false } : { id: "star", url: "", file: false }); }, "wallpaper");
    } else if (t.type === "file") { pick(t.files && t.files[0]); t.value = ""; }
  });
  function pick(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var src = URL.createObjectURL(file), im = new Image();
    im.onerror = function () { URL.revokeObjectURL(src); A.toast("无法读取这张图片"); };
    im.onload = function () {
      URL.revokeObjectURL(src);
      var up = A.uploadWallpaper; // 有 NAS 后端：传文件，配置里只存引用
      var k = Math.min(1, (up ? 2560 : 2000) / Math.max(im.naturalWidth, im.naturalHeight)), c = document.createElement("canvas");
      c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
      c.getContext("2d").drawImage(im, 0, 0, c.width, c.height);
      if (up) {
        c.toBlob(function (blob) {
          if (!blob) { A.toast("无法读取这张图片"); return; }
          up(blob).then(function (v) {
            set(function (s) { s.wallpaper = Object.assign(wp(), { id: "custom", file: true, v: v, url: "" }); }, "wallpaper");
          }, function (e) { A.toast(e && e.message ? "壁纸上传失败：" + e.message : "壁纸上传失败"); });
        }, "image/jpeg", 0.85);
        return;
      }
      var url = c.toDataURL("image/jpeg", 0.85), probe = structuredClone(A.state);
      probe.settings.wallpaper = Object.assign(wp(), { id: "custom", url: url, file: false });
      try { localStorage.setItem("yeqv.v1", JSON.stringify(probe)); }
      catch (err) { if (/quota/i.test(err.name) || err.code === 22) { A.toast("图片太大，换一张小点的"); return; } }
      set(function (s) { s.wallpaper = probe.settings.wallpaper; }, "wallpaper");
    };
    im.src = src;
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && cur) { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    else if (e.key === "," && (e.metaKey || e.ctrlKey)) { e.preventDefault(); if (cur !== sp) open(sp); }
  }, true);
  A.on("menu", function (d) { if (d) d.handled = true; if (cur === menu) close(); else openMenu(); });
  A.on("settings", function (d) { if (d) d.handled = true; open(sp); });
  A.on("render", function () { applyWp(wp()); applyShow(); if (cur === sp) sync(); });
  applyWp(wp()); applyShow();
})();

/* Stage 5b · settings panes 搜索 + 数据. App API only. */
(function () {
  "use strict";
  var A = window.App, esc = A.util.esc, P = A.settingsPanes;
  if (!P) return;
  var S = P["搜索"], D = P["数据"];
  function undoToast(msg) { A.toast(msg, { action: "撤销", onAction: A.undo }); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function stamp(t) { var d = new Date(); return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + (t ? "-" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) : ""); }
  async function save(name, st) {
    var url = URL.createObjectURL(new Blob([JSON.stringify(st, null, 2)], { type: "application/json" })), a;
    try { a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); }
    finally { if (a) a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); }
  }
  function hasFileIcons(state) {
    return state.groups.some(function (g) { return (g.items || []).some(function (i) { return i.icon && i.icon.type === "image" && /^api\/icons\//.test(String(i.icon.value || "")); }); });
  }
  async function download(name, captured) {
    if (A.exportState) return save(name, await A.exportState(captured));
    if (hasFileIcons(captured)) throw new Error("无法读取 NAS 图标，请连接原 NAS 后重试");
    return save(name, captured);
  }

  /* ---- 搜索 ---- */
  S.innerHTML = '<p class="x-gt">搜索引擎</p><div class="x-gl" data-elist></div><p class="x-hint">点按一行设为默认；默认引擎不能关闭或删除。</p>' +
    '<div class="x-gl x-addf" style="margin-top:12px"><button type="button" class="x-row x-rb is-amber" data-s="add" aria-expanded="false">添加搜索引擎</button>' +
    '<div data-form hidden><label class="x-row"><span>名称</span><input type="text" data-f="name" placeholder="可选" maxlength="24"></label>' +
    '<label class="x-row"><span>网址模板</span><input type="url" data-f="url" inputmode="url" autocapitalize="off" spellcheck="false" placeholder="https://example.com/search?q=%s"></label>' +
    '<p class="x-hint">用 %s 代表搜索词</p><div class="x-acts"><button type="button" class="x-pb" data-s="cancel">取消</button><button type="button" class="x-pb is-amber" data-s="save" disabled>添加</button></div></div></div>';
  var list = S.querySelector("[data-elist]"), form = S.querySelector("[data-form]"), addBtn = S.querySelector('[data-s="add"]');
  var fName = S.querySelector('[data-f="name"]'), fUrl = S.querySelector('[data-f="url"]'), fSave = S.querySelector('[data-s="save"]');
  function okUrl(u) { return A.util.url.engine(u); }
  function drawEngines() {
    var st = A.state.settings;
    list.innerHTML = (st.engines || []).map(function (e) {
      var def = e.id === st.engine;
      return '<div class="x-row x-eg" data-eid="' + esc(e.id) + '"' + (def ? " data-def" : "") + '><button type="button" class="x-rb x-en" aria-pressed="' + def + '"><span class="x-ck" aria-hidden="true">✓</span><span>' + esc(e.name) + "</span></button>" +
        '<input class="x-tg" type="checkbox" role="switch" aria-label="启用 ' + esc(e.name) + '"' + (e.on || def ? " checked" : "") + (def ? " disabled" : "") + ">" +
        '<button type="button" class="x-del" data-del' + (def ? " hidden" : "") + ">删除</button></div>";
    }).join("");
  }
  function showForm(on) {
    form.hidden = !on; addBtn.setAttribute("aria-expanded", on);
    if (on) fUrl.focus(); else { fName.value = fUrl.value = ""; fSave.disabled = true; }
  }
  S.addEventListener("click", function (e) {
    var t = e.target, s = t.closest("[data-s]");
    if (s) {
      var a = s.getAttribute("data-s");
      if (a === "add") return showForm(form.hidden);
      if (a === "cancel") return showForm(false);
      var url = fUrl.value.trim(); if (!okUrl(url)) return;
      var name = fName.value.trim(); try { name = name || new URL(url.replace("%s", "q")).hostname.replace(/^www\./, ""); } catch (err) { name = name || "搜索"; }
      A.commit(function (st) { st.settings.engines.push({ id: A.util.uid(), name: name, url: url, on: true }); }, "add-engine");
      showForm(false); A.toast("已添加「" + name + "」"); return;
    }
    var row = t.closest("[data-eid]"); if (!row || t.matches(".x-tg")) return;
    var id = row.getAttribute("data-eid"), eng = A.state.settings.engines.filter(function (x) { return x.id === id; })[0];
    if (!eng) return;
    if (t.closest("[data-del]")) {
      if (id === A.state.settings.engine) return;
      A.commit(function (st) { st.settings.engines = st.settings.engines.filter(function (x) { return x.id !== id; }); }, "delete-engine");
      return undoToast("已删除「" + eng.name + "」");
    }
    if (id !== A.state.settings.engine) A.commit(function (st) { st.settings.engine = id; st.settings.engines.forEach(function (x) { if (x.id === id) x.on = true; }); }, "default-engine");
  });
  S.addEventListener("input", function () { fSave.disabled = !okUrl(fUrl.value.trim()); });
  S.addEventListener("change", function (e) {
    e.stopPropagation();
    var t = e.target, row = t.closest("[data-eid]"); if (!row || !t.matches(".x-tg")) return;
    var id = row.getAttribute("data-eid"), on = t.checked;
    if (id === A.state.settings.engine) { t.checked = true; return; }
    A.commit(function (st) { st.settings.engines.forEach(function (x) { if (x.id === id) x.on = on; }); }, "toggle-engine");
  });

  /* ---- 数据 ---- */
  D.innerHTML = '<p class="x-gt">备份</p><div class="x-gl"><button type="button" class="x-row x-rb" data-d="export">导出配置</button>' +
    '<button type="button" class="x-row x-rb" data-d="import">导入配置</button><p class="x-err" data-err role="alert" hidden></p><input type="file" accept="application/json,.json" hidden data-file></div>' +
    '<p class="x-gt">重置</p><div class="x-gl"><button type="button" class="x-row x-rb is-red" data-d="reset" aria-expanded="false">恢复默认</button>' +
    '<div class="x-cf" data-cf hidden><p>会清空所有分组和设置。恢复前会自动导出一份备份。</p><div class="x-acts"><button type="button" class="x-pb is-red" data-d="confirm">恢复默认</button><button type="button" class="x-pb" data-d="cancel">取消</button></div></div></div>' +
    '<p class="x-foot5">配置只保存在这台设备的浏览器里</p>';
  var err = D.querySelector("[data-err]"), file = D.querySelector("[data-file]"), cf = D.querySelector("[data-cf]"), resetBtn = D.querySelector('[data-d="reset"]');
  var replacement = null;
  function showErr(m) { err.textContent = m || ""; err.hidden = !m; }
  function showCf(on) {
    cf.hidden = !on; resetBtn.setAttribute("aria-expanded", on);
    if (!on && replacement && replacement.kind === "reset") replacement = null;
  }
  function beginReplacement(kind) {
    var intent = { kind: kind, state: structuredClone(A.state) };
    intent.raw = JSON.stringify(intent.state);
    replacement = intent;
    return intent;
  }
  function currentReplacement(intent) {
    if (replacement !== intent) return false;
    if (JSON.stringify(A.state) === intent.raw) return true;
    showErr("本机内容已变化，未替换配置，请重新操作");
    return false;
  }
  async function replaceState(intent, candidate, label, message) {
    try {
      if (!currentReplacement(intent)) return;
      await download("yeqv-before-" + label + "-" + stamp(true) + ".json", intent.state);
      if (!currentReplacement(intent)) return;
      if (A.commit(function (s) { Object.keys(s).forEach(function (k) { delete s[k]; }); Object.assign(s, candidate); }, label, true) === false) return showErr("无法备份损坏的本机缓存，未" + (label === "reset" ? "恢复默认" : "导入"));
      if (label === "reset") showCf(false);
      undoToast(message);
    } catch (e) {
      if (replacement === intent) showErr("备份失败，未" + (label === "reset" ? "恢复默认" : "导入") + "：" + (e.message || "无法下载文件"));
    }
  }
  D.addEventListener("click", function (e) {
    var b = e.target.closest("[data-d]"); if (!b) return;
    var a = b.getAttribute("data-d");
    if (a === "export") {
      showErr("");
      var captured = structuredClone(A.state), w = captured.settings.wallpaper;
      download("yeqv-backup-" + stamp() + ".json", captured).then(function () {
        A.toast(w && w.id === "custom" && w.file ? "已导出配置 · 壁纸文件不包含在导出里" : "已导出配置", w && w.file ? { duration: 6000 } : undefined);
      }, function (e) { showErr("导出失败：" + (e.message || "无法下载文件")); });
    }
    else if (a === "import") file.click();
    else if (a === "reset") showCf(cf.hidden);
    else if (a === "cancel") showCf(false);
    else if (a === "confirm") {
      var intent = beginReplacement("reset"), candidate = structuredClone(A.defaults);
      if (!window.NocturneConfigShape.valid(candidate)) return showErr("默认配置格式不正确，未恢复默认");
      showErr("");
      replaceState(intent, candidate, "reset", "已恢复默认");
    }
  });
  function valid(d) {
    return window.NocturneConfigShape.valid(d, { settingsOptional: true });
  }
  function fillIds(list) {
    var seen = new Set();
    list.forEach(function (item) { if (item.id != null) { item.id = String(item.id); seen.add(item.id); } });
    list.forEach(function (item) {
      if (item.id != null) return;
      var base = A.util.uid(), id = base, suffix = 0;
      while (seen.has(String(id))) id = base + "-" + (++suffix);
      item.id = id; seen.add(String(id));
    });
  }
  D.addEventListener("change", function (e) {
    e.stopPropagation();
    var f = file.files && file.files[0]; file.value = ""; if (!f) return;
    var intent = beginReplacement("import");
    Promise.resolve().then(function () { return f.text(); }).then(function (txt) {
      if (!currentReplacement(intent)) return;
      var data; try { data = JSON.parse(txt); } catch (x) { data = null; }
      if (!valid(data)) return showErr("文件不是有效的夜曲配置");
      var SPm = window.NocturneSpaces, badS = SPm ? SPm.check(data, { lenient: true }) : [];
      if (badS.length) return showErr("文件里的空间定义不合法，未导入：" + badS.slice(0, 2).map(function (x) { return x.where + "（" + x.problem + "）"; }).join("；"));
      var badA = A.util.url.checkAliases(data);
      if (badA.length) return showErr("文件里有 " + badA.length + " 个项目的别名不合法，未导入：" + badA.slice(0, 2).map(function (x) { return x.where + "（" + x.problem + "）"; }).join("；"));
      var bad = A.util.url.checkConfig(data);
      if (bad.length) return showErr("文件里有 " + bad.length + " 个不安全的地址（只支持 http/https），未导入：" + bad.slice(0, 3).map(function (x) { return x.where + "「" + A.util.url.show(x.value) + "」"; }).join("；"));
      showErr("");
      var base = structuredClone(A.defaults), merged = Object.assign(base, data);
      merged.settings = Object.assign(structuredClone(A.defaults.settings), data.settings || {});
      var items = [];
      merged.groups.forEach(function (g) { if (g.items == null) g.items = []; items = items.concat(g.items); });
      items.forEach(function (item) { if (item.id === "") delete item.id; });
      fillIds(merged.groups); fillIds(items); fillIds(merged.settings.engines);
      if (typeof merged.settings.engine === "number") merged.settings.engine = String(merged.settings.engine);
      if (SPm) SPm.normalize(merged); /* 重名加序号、清悬空引用（文件里没有 spaces = 只有「全部」） */
      if (!window.NocturneConfigShape.valid(merged)) return showErr("文件不是有效的夜曲配置");
      return replaceState(intent, merged, "import", "已导入");
    }).catch(function () { if (replacement === intent) showErr("文件不是有效的夜曲配置"); });
  });

  A.on("render", drawEngines);
  drawEngines();
})();

/* QA fix pass · keep native link/image drag out of edit mode */
(function () {
  var A = window.App, groupsEl = document.getElementById("x-groups");
  if (!A || !groupsEl) return;
  groupsEl.addEventListener("dragstart", function (e) { if (document.body.classList.contains("editing")) e.preventDefault(); }, true);
  function nodrag() {
    if (!document.body.classList.contains("editing")) return;
    groupsEl.querySelectorAll(".x-tile, .x-chip, a, img").forEach(function (el) { el.setAttribute("draggable", "false"); });
  }
  A.on("render", nodrag);
  A.on("editmode", nodrag);
})();

/* Desktop pass · ⌘K command palette, search-box hint, structured offline list. App API only. */
(function () {
  "use strict";
  var A = window.App; if (!A) return;
  var esc = A.util.esc, body = document.body, groupsEl = document.getElementById("x-groups");
  var MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  /* 触屏（iPhone 横屏、iPad 无触控板）不显示 ⌘K 提示；CSS 也只在 (hover: hover) and (pointer: fine) 下显示 */
  var FINE = !window.matchMedia || window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  var MOD = MAC ? "⌘" : "Ctrl ";

  /* ---- status card: offline names as compact chips (desktop CSS shows it; mobile keeps the sentence) ---- */
  var side = document.querySelector(".x-side"), sline = side && side.querySelector(".x-sline");
  if (sline) {
    var card = sline.closest(".x-card"), offl = document.createElement("div");
    offl.className = "x-offl"; offl.hidden = true; sline.after(offl);
    var drawOff = function () {
      var off = sline.classList.contains("is-off") || sline.classList.contains("is-alloff"), items = [];
      if (off) {
        var m = A.util.dict(); A.state.groups.forEach(function (g) { (g.items || []).forEach(function (i) { m[i.id] = i; }); });
        groupsEl.querySelectorAll(".x-tile[data-id] > .dot.off").forEach(function (d) {
          var i = m[d.parentNode.getAttribute("data-id")]; if (i) items.push(i);
        });
      }
      card.classList.toggle("has-off", off);
      offl.hidden = !items.length;
      // 点芯片 = 点图标：按当前内网/外网打开，并记入「最近使用」（data-rid）
      offl.innerHTML = items.length ? "<p>离线 · " + items.length + "</p><ul>" + items.map(function (i) {
        var u = A.url(i);
        return '<li><a href="' + esc(u) + '"' + (u === "#" ? "" : ' target="_blank" rel="noopener"') + ' data-rid="' + esc(i.id) + '" title="打开 ' + esc(i.title) + '"><i aria-hidden="true"></i><span>' + esc(i.title) + "</span></a></li>";
      }).join("") + "</ul>" : "";
    };
    new MutationObserver(drawOff).observe(sline, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    drawOff();
  }

  /* ---- palette DOM ---- */
  var back = document.createElement("div"); back.className = "x-cmdk-back"; back.hidden = true;
  var pal = document.createElement("div"); pal.className = "x-cmdk x-glass"; pal.hidden = true;
  pal.setAttribute("role", "dialog"); pal.setAttribute("aria-modal", "true"); pal.setAttribute("aria-label", "命令面板");
  pal.innerHTML = '<div class="x-cmdk-in"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>' +
    '<input type="text" role="combobox" aria-expanded="true" aria-controls="x-cmdk-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="搜索服务、分组或操作，> 只看操作" aria-label="搜索服务、分组或操作，输入 > 只看操作"><kbd>Esc</kbd><button type="button" class="x-cmdk-x">取消</button></div>' +
    '<div class="x-cmdk-list" id="x-cmdk-list" role="listbox" aria-label="结果"></div>' +
    '<div class="x-cmdk-foot"><span>↑↓ 选择</span><span>↵ 打开</span><span>' + MOD.trim() + '↵ 新标签页</span><span>Esc 关闭</span></div>';
  body.append(back, pal);
  var inp = pal.querySelector("input"), list = pal.querySelector(".x-cmdk-list");
  pal.querySelector(".x-cmdk-x").addEventListener("click", function () { close(); });
  /* iOS Safari：软键盘弹出时只有 visualViewport 变小——把面板放进可见区域，输入框和结果都不被键盘挡住 */
  var VV = window.visualViewport, safeTop = 0;
  (function () { var pr = document.createElement("div"); pr.style.cssText = "position:fixed;top:0;left:0;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top)"; body.appendChild(pr); safeTop = parseFloat(getComputedStyle(pr).paddingTop) || 0; pr.remove(); })();
  function fit() {
    if (!isOpen) return;
    var small = window.innerWidth < 768, vh = VV ? VV.height : window.innerHeight, oy = VV ? VV.offsetTop : 0;
    if (!small && vh >= window.innerHeight - 1) { pal.style.top = ""; pal.style.maxHeight = ""; return; }
    var top = oy + Math.max(12, safeTop + 8, small ? Math.min(vh * 0.06, 48) : vh * 0.12);
    pal.style.top = Math.round(top) + "px";
    pal.style.maxHeight = Math.round(Math.max(150, Math.min(520, oy + vh - top - 12))) + "px";
  }
  if (VV) { VV.addEventListener("resize", fit); VV.addEventListener("scroll", fit); }
  window.addEventListener("resize", fit);

  /* search-box hint (CSS shows it ≥900px only) */
  var bar = document.querySelector(".x-bar");
  if (bar && FINE) {
    var kb = document.createElement("kbd"); kb.className = "x-kbd"; kb.title = "命令面板"; kb.textContent = MOD + "K";
    kb.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); open(document.getElementById("x-q").value.trim()); });
    bar.appendChild(kb);
  }

  /* ---- fuzzy matching ---- */
  function match(text, q) {
    text = String(text || ""); if (!q) return { s: 0, hits: [] };
    var t = text.toLowerCase(), at = t.indexOf(q), hits = [], k;
    if (at > -1) {
      for (k = 0; k < q.length; k++) hits.push(at + k);
      return { s: 100 - Math.min(at, 30) + (at === 0 ? 40 : /[\s\-_.\/:]/.test(t[at - 1] || "") ? 20 : 0) + (t.length === q.length ? 30 : 0), hits: hits };
    }
    var j = 0, last = -1, gaps = 0;
    for (k = 0; k < t.length && j < q.length; k++) {
      if (t[k] === q[j]) { if (last > -1) gaps += k - last - 1; hits.push(k); last = k; j++; }
    }
    if (j < q.length) return null;
    return { s: Math.max(1, 60 - gaps * 3 - hits[0]), hits: hits };
  }
  function mark(text, hits) {
    if (!hits || !hits.length) return esc(text);
    var set = new Set(hits);
    return Array.from(String(text)).map(function (c, i) { return set.has(i) ? "<mark>" + esc(c) + "</mark>" : esc(c); }).join("");
  }
  function host(u) { try { return new URL(u).host; } catch (e) { return u || ""; } }

  /* ---- results ---- */
  function engine() {
    var st = A.state.settings;
    return (st.engines || []).filter(function (x) { return x.id === st.engine; })[0] || (st.engines || [])[0];
  }
  /* 内置动作。'>' 开头只显示这些；结果按真实执行情况提示，不提前宣告成功 */
  function actions() {
    var editing = body.classList.contains("editing"), N = A.net, pm = N ? N.mode() : "wan", eff = N ? N.effective() : "wan";
    var nm = function (k) { return pm === k ? "当前模式" : ""; };
    return [
      { k: "net:auto", t: "自动网络", d: (nm("auto") ? "当前模式 · " : "") + "按本页访问地址判断 · 会优先" + (window.NocturneNet && N ? N.names[NocturneNet.decide(location.hostname)] : "外网"), g: "⇄", kw: "自动 网络 auto network 内网 外网 lan wan" },
      { k: "net:lan", t: "优先内网", d: nm("lan") || "优先用内网地址打开", g: "⌂", kw: "内网 lan 局域网 network 网络 切换" },
      { k: "net:wan", t: "优先外网", d: nm("wan") || "优先用外网地址打开", g: "◍", kw: "外网 wan 公网 network 网络 切换" },
      (function () { var sa = statusText(); return { k: "recheck", t: sa.t, d: sa.d, g: "↻", kw: "刷新状态 重新检测 状态 刷新 在线 离线 status refresh recheck" }; })(),
      { k: "edit", t: editing ? "退出编辑" : "进入编辑", d: MOD + "E", g: "✎", kw: "编辑 edit 排序 拖动" },
      { k: "settings", t: "打开设置", d: MOD + ",", g: "⚙", kw: "设置 settings 壁纸 外观 preferences" },
      { k: "add", t: "添加项目", d: "新建一个服务或链接", g: "+", kw: "添加 新建 add new item" }
    ].concat(spaceActions()).map(function (a) { a.cur = eff; return a; });
  }
  /* 空间相关的内置动作：「切换到空间：X」（含「全部」）与「管理空间」。只出现在操作里（排在服务 / 分组结果之后），不挤掉搜索结果 */
  function spaceActions() {
    var SPC = A.spaces; if (!SPC) return [];
    var cur = SPC.selected(), M = SPC.model;
    var out = [{ id: M.ALL, name: M.ALL_NAME }].concat(SPC.list()).map(function (sp) {
      var n = M.stats(A.state, sp.id).items;
      return { k: "space:" + sp.id, t: "切换到空间：" + sp.name, d: sp.id === cur ? "当前空间" : n + " 个项目", g: "◫", kw: "空间 切换 space switch " + sp.name };
    });
    out.push({ k: "spaces", t: "管理空间", d: "新建、重命名、排序、选择分组", g: "▤", kw: "管理空间 空间 管理 新建 编辑 space spaces manage" });
    return out;
  }
  var rows = [], base = [], sel = 0, altFor = null;
  /* 备用地址：同时有有效内网 / 外网地址的项目，在它被选中时下面多出「用内网地址打开」「用外网地址打开」 */
  function alts(i) {
    var l = A.urlOf ? A.urlOf(i, "lan") : "", w = A.urlOf ? A.urlOf(i, "wan") : "";
    return l && w ? [["lan", l], ["wan", w]] : null;
  }
  function expand() {
    var out = [];
    base.forEach(function (r) {
      out.push(r);
      if (r.type === "item" && r.x.i.id === altFor) {
        var a = alts(r.x.i), cur = A.url(r.x.i);
        if (a) a.forEach(function (k) { out.push({ type: "alt", sec: r.sec, x: r.x, kind: k[0], url: k[1], rec: k[1] === cur, hits: [] }); });
      }
    });
    return out;
  }
  function focusAlts(n) {
    var r = rows[n]; if (!r || r.type !== "item" || r.x.i.id === altFor) return n;
    altFor = alts(r.x.i) ? r.x.i.id : null;
    var keepRow = r; rows = expand(); draw(true);
    return rows.indexOf(keepRow);
  }
  function build() {
    var raw = inp.value.trim(), out = [], R = window.NocturneRank;
    var cmd = raw.charAt(0) === ">" || raw.charAt(0) === "＞", q = R.norm(cmd ? raw.slice(1) : raw);
    var items = [], seenId = new Set();
    A.state.groups.forEach(function (g) { (g.items || []).forEach(function (i) { if (i && !seenId.has(String(i.id))) { seenId.add(String(i.id)); items.push({ i: i, g: g }); } }); });
    if (cmd) { /* '>'：只显示内置动作 */
      actions().forEach(function (a) {
        var m = q ? R.match(a.t, q) : { s: 0, hits: [] }, mk = q ? R.match(a.kw, q) : null;
        if (m || mk) out.push({ type: "action", sec: "操作", a: a, hits: m ? m.hits : [], s: Math.max(m ? m.s * 2 : 0, mk ? mk.s : 0) });
      });
      if (q) out.sort(function (a, b) { return b.s - a.s; });
    } else if (!q) {
      var byId = new Map(); items.forEach(function (x) { byId.set(String(x.i.id), x); });
      var rec = (A.state.recent || []).map(function (id) { return byId.get(String(id)); }).filter(Boolean).slice(0, 5);
      rec.forEach(function (x) { out.push({ type: "item", sec: "最近使用", x: x, hits: [] }); });
      var seen = new Set(); rec.forEach(function (x) { seen.add(String(x.i.id)); });
      items.filter(function (x) { return !seen.has(String(x.i.id)); }).slice(0, Math.max(0, 6 - rec.length)).forEach(function (x) { out.push({ type: "item", sec: rec.length ? "最近使用" : "服务", x: x, hits: [] }); });
      /* 空输入：常用动作（和以前一样：切到另一种网络、编辑、添加、设置）；输入 > 看全部动作 */
      var other = A.net && A.net.effective() === "lan" ? "net:wan" : "net:lan", order = [other, "edit", "add", "settings"], acts = actions();
      order.forEach(function (k) { acts.forEach(function (a) { if (a.k === k) out.push({ type: "action", sec: "操作", a: a, hits: [] }); }); });
    } else {
      /* 服务：标题精确 > 标题前缀 > 别名 > 标题模糊 > 描述 / 地址；同层里最近使用靠前；同一项目只出现一次 */
      R.rank(items.map(function (x) { return { item: x.i, urls: [A.url(x.i), x.i.lan, x.i.wan], x: x }; }), q, A.state.recent).slice(0, 12).forEach(function (o) {
        out.push({ type: "item", sec: "服务", x: o.entry.x, hits: o.r.hits || [], alias: o.r.alias, tier: o.r.tier });
      });
      var gs = [];
      A.state.groups.forEach(function (g) { var m = R.match(g.name, q); if (m) gs.push({ type: "group", sec: "分组", g: g, hits: m.hits, s: m.s }); });
      gs.sort(function (a, b) { return b.s - a.s; }); out = out.concat(gs);
      var as = [];
      actions().forEach(function (a) { var m = R.match(a.t, q), mk = R.match(a.kw, q); if (m || mk) as.push({ type: "action", sec: "操作", a: a, hits: m ? m.hits : [], s: Math.max(m ? m.s * 2 : 0, mk ? mk.s : 0) }); });
      as.sort(function (a, b) { return b.s - a.s; }); out = out.concat(as);
      var e = engine();
      if (e) out.push({ type: "search", sec: "搜索", e: e, q: raw, hits: [] });
    }
    base = out; altFor = null; rows = out; sel = 0;
    if (rows[0] && rows[0].type === "item" && q && !cmd) { altFor = alts(rows[0].x.i) ? rows[0].x.i.id : null; rows = expand(); }
    draw();
  }
  function rowHTML(r, n) {
    var icon, title, sub, tag = "";
    if (r.type === "alt") {
      icon = '<span class="x-cmdk-g" aria-hidden="true">' + (r.kind === "lan" ? "⌂" : "◍") + "</span>";
      title = "用" + (r.kind === "lan" ? "内网" : "外网") + "地址打开"; sub = esc(host(r.url) + (r.rec ? " · 当前推荐" : "")); tag = r.kind === "lan" ? "内网" : "外网";
    } else if (r.type === "item") {
      icon = A.util.iconHTML(r.x.i.icon, r.x.i.title); title = mark(r.x.i.title, r.hits);
      sub = esc([r.alias ? "别名：" + r.alias : "", r.x.i.desc, host(A.url(r.x.i))].filter(Boolean).join(" · ")); tag = "服务 · " + esc(r.x.g.name);
    } else if (r.type === "group") {
      icon = '<span class="x-cmdk-g" aria-hidden="true">#</span>'; title = mark(r.g.name, r.hits); sub = (r.g.items || []).length + " 个项目"; tag = "分组";
    } else if (r.type === "action") {
      icon = '<span class="x-cmdk-g" aria-hidden="true">' + r.a.g + "</span>"; title = mark(r.a.t, r.hits); sub = esc(r.a.d); tag = "操作";
    } else {
      icon = '<span class="x-cmdk-g" aria-hidden="true">↗</span>'; title = "用 " + esc(r.e.name) + " 搜索 “" + esc(r.q) + "”"; sub = esc(host(r.e.url)); tag = "搜索";
    }
    return '<div class="x-cmdk-row' + (r.type === "alt" ? " x-cmdk-alt" : "") + '" role="option" id="x-cmdk-o' + n + '" data-n="' + n + '" aria-selected="' + (n === sel) + '">' + icon +
      '<span class="x-cmdk-t"><b>' + title + "</b>" + (sub ? "<small>" + sub + "</small>" : "") + "</span>" + (tag ? '<span class="x-cmdk-tag">' + tag + "</span>" : "") + "</div>";
  }
  function draw(keepScroll) {
    var h = "", lastSec = null, st = list.scrollTop;
    rows.forEach(function (r, n) {
      if (r.sec !== lastSec) { h += '<p class="x-cmdk-sec" role="presentation">' + esc(r.sec) + "</p>"; lastSec = r.sec; }
      h += rowHTML(r, n);
    });
    list.innerHTML = h || '<p class="x-cmdk-empty">没有匹配的结果</p>';
    if (keepScroll) list.scrollTop = st;
    setSel(sel, true);
  }
  /* 键盘移动选中：移到另一个有备用地址的项目时，展开它的备用地址行 */
  function move(n) {
    if (!rows.length) return;
    n = (n + rows.length) % rows.length;
    var m = focusAlts(n); setSel(m < 0 ? n : m);
  }
  function setSel(n, quiet) {
    if (!rows.length) { inp.removeAttribute("aria-activedescendant"); return; }
    sel = (n + rows.length) % rows.length;
    list.querySelectorAll(".x-cmdk-row").forEach(function (el) { el.setAttribute("aria-selected", String(+el.getAttribute("data-n") === sel)); });
    var cur = list.querySelector('[data-n="' + sel + '"]');
    inp.setAttribute("aria-activedescendant", "x-cmdk-o" + sel);
    if (cur && !quiet) cur.scrollIntoView({ block: "nearest" });
    else if (cur && sel === 0) list.scrollTop = 0;
  }

  /* ---- run ---- */
  var suppress = false;
  /* registered after Stage 4's tracker, so a synthetic tile click records 最近使用 and is then cancelled */
  document.addEventListener("click", function (e) { if (suppress) e.preventDefault(); });
  function record(id) {
    if (body.classList.contains("editing")) return;
    var a = groupsEl.querySelector('a[data-id="' + A.util.sel(id) + '"]');
    if (!a) { if (A.trackRecent) A.trackRecent(id); return; } /* 项目不在当前空间（命令面板搜的是全部空间）：直接记入最近使用 */
    suppress = true;
    try { a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window })); } finally { suppress = false; }
  }
  function go(url, newTab) {
    if (!url || url === "#") { A.toast("这个项目还没有地址"); return; }
    if (!A.util.url.http(url)) { A.toast("地址无效：只支持 http:// 或 https://"); return; }
    if (newTab) window.open(url, "_blank", "noopener"); else location.assign(url);
  }
  function run(r, newTab) {
    if (!r) return;
    close(r.type !== "group");
    if (r.type === "item") { record(r.x.i.id); go(A.url(r.x.i), newTab); }
    else if (r.type === "alt") { record(r.x.i.id); go(r.url, newTab); } // 只是按用户选的地址打开；能不能打开由浏览器决定，不记为「可访问」
    else if (r.type === "search") go(r.e.url.replace("%s", encodeURIComponent(r.q)), newTab);
    else if (r.type === "group") {
      var sec = groupsEl.querySelector('.x-group[data-gid="' + A.util.sel(r.g.id) + '"]');
      if (!sec && A.spaces && A.spaces.selected() !== A.spaces.ALL) { /* 分组不在当前空间：先回到「全部」再定位 */
        A.spaces.select(A.spaces.ALL); A.toast("这个分组不在当前空间，已切换到「全部」");
        sec = groupsEl.querySelector('.x-group[data-gid="' + A.util.sel(r.g.id) + '"]');
      }
      if (sec) {
        sec.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
        sec.classList.remove("x-flash"); void sec.offsetWidth; sec.classList.add("x-flash");
        setTimeout(function () { sec.classList.remove("x-flash"); }, 1300);
        var first = sec.querySelector("a[data-id]"); if (first) first.focus({ preventScroll: true });
      }
    } else {
      var k = r.a.k;
      if (k.indexOf("net:") === 0) {
        var want = k.slice(4);
        if (!A.net) A.toast("网络模式不可用");
        else if (A.net.mode() === want) A.toast("已经是「" + (want === "auto" ? "自动（当前优先" + A.net.names[A.net.effective()] + "）" : "优先" + A.net.names[want]) + "」");
        else A.net.set(want);
      } else if (k.indexOf("space:") === 0) {
        var want2 = k.slice(6), was = A.spaces.selected(), got = A.spaces.select(want2), sp2 = A.spaces.model.get(A.state, got);
        A.toast(got === was ? "已经在「" + (sp2 ? sp2.name : "全部") + "」" : "已切换到「" + (sp2 ? sp2.name : "全部") + "」");
      } else if (k === "spaces") { if (A.spaces) A.spaces.manage(); }
      else if (k === "recheck") recheck();
      else if (k === "edit") {
        if (body.classList.contains("editing")) { var dn = document.querySelector('.x-ebar [data-e="done"]'); if (dn) dn.click(); }
        else A.emit("edit", { handled: false });
      } else if (k === "add") {
        var g = A.spaces ? A.spaces.defaultGroup() : A.state.groups.filter(function (x) { return x.style !== "chip"; })[0] || A.state.groups[0];
        var d = { gid: g && g.id, handled: false }; A.emit("add-item", d);
        if (!d.handled) A.toast("即将上线");
      } else if (k === "settings") A.emit("settings", { handled: false });
    }
  }

  /* 状态动作：NAS 模式 =「刷新状态」，只读取 NAS 最近一次后台检测的结果，不触发新的检测；
     纯静态模式 =「重新检测状态」，在浏览器里真的重新检测。等结果真正到了再提示，读取失败就如实说 */
  function nasMode() { return !!(window.NOCTURNE && A.refreshStatus); }
  function statusText() { return window.NocturneRank && NocturneRank.statusAction ? NocturneRank.statusAction(nasMode()) : { t: "重新检测状态", d: "", busy: "正在重新检测…" }; }
  function recheck() {
    if (!A.recheck) { A.toast("状态检测不可用"); return; }
    var nas = nasMode(), R = window.NocturneRank;
    A.toast(statusText().busy, { duration: 8000 });
    if (!nas) { A.recheck(true, function (d) { A.toast(R.statusReport(false, d)); }); return; }
    A.refreshStatus().then(function (map) {
      var at = R.latestCheck(map);
      A.recheck(true, function (d) { A.toast(R.statusReport(true, d, at)); });
    }, function (e) {
      A.toast("无法从 NAS 读取状态：" + (e && e.message ? e.message : "网络错误"));
    });
  }

  /* ---- open / close ---- */
  var isOpen = false, prev = null;
  function overlayOpen() { return !!document.querySelector(".x-set.is-on, .x-is.is-on, .x-spm.is-on, .x-sheet.is-on, .x-menu.is-on, .x-netm.is-on, .nc-auth:not([hidden])") || document.documentElement.classList.contains("nc-locked"); }
  function open(prefill) {
    if (isOpen) { inp.select(); return; }
    isOpen = true; prev = document.activeElement;
    back.hidden = false; pal.hidden = false;
    inp.value = prefill || ""; build(); fit();
    requestAnimationFrame(function () { back.classList.add("is-on"); pal.classList.add("is-on"); });
    inp.focus({ preventScroll: true });
  }
  function close(keepFocus) {
    if (!isOpen) return;
    isOpen = false; back.classList.remove("is-on"); pal.classList.remove("is-on");
    setTimeout(function () { if (!isOpen) { back.hidden = true; pal.hidden = true; } }, 200);
    if (!keepFocus && prev && prev.focus && document.contains(prev)) prev.focus({ preventScroll: true });
  }
  A.palette = { open: open, close: close };

  inp.addEventListener("input", build);
  list.addEventListener("mousemove", function (e) { var r = e.target.closest("[data-n]"); if (r && +r.getAttribute("data-n") !== sel) setSel(+r.getAttribute("data-n"), true); });
  list.addEventListener("mousedown", function (e) { e.preventDefault(); });
  list.addEventListener("click", function (e) { var r = e.target.closest("[data-n]"); if (r) run(rows[+r.getAttribute("data-n")], e.metaKey || e.ctrlKey); });
  list.addEventListener("auxclick", function (e) { var r = e.target.closest("[data-n]"); if (r && e.button === 1) run(rows[+r.getAttribute("data-n")], true); });
  back.addEventListener("click", function () { close(); });

  function typing(t) { return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }
  window.addEventListener("keydown", function (e) {
    if (document.documentElement.classList.contains("nc-locked")) return;
    var k = e.key;
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (k === "k" || k === "K")) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (isOpen) close(); else if (!overlayOpen()) open(e.target && e.target.id === "x-q" ? e.target.value.trim() : "");
      return;
    }
    if (!isOpen) {
      if (k === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !typing(e.target) && !overlayOpen()) { e.preventDefault(); open(""); }
      return;
    }
    if (e.isComposing || e.keyCode === 229) return;
    if (k === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); }
    else if (k === "ArrowDown" || (k === "n" && e.ctrlKey)) { e.preventDefault(); e.stopImmediatePropagation(); move(sel + 1); }
    else if (k === "ArrowUp" || (k === "p" && e.ctrlKey)) { e.preventDefault(); e.stopImmediatePropagation(); move(sel - 1); }
    else if (k === "Enter") { e.preventDefault(); e.stopImmediatePropagation(); run(rows[sel], e.metaKey || e.ctrlKey); }
    else if (k === "Tab") { e.preventDefault(); e.stopImmediatePropagation(); move(sel + (e.shiftKey ? -1 : 1)); }
    else if (e.metaKey || e.ctrlKey) { e.stopImmediatePropagation(); }
  }, true);
  A.on("render", function () { if (isOpen) build(); });
})();

/* V2.0 阶段 2 · 空间切换器（桌面：搜索栏下方的轻量导航；手机：底部快捷栏上方的拇指区横滑条）+ 管理空间。只用 App 接口。
 * 切换只改本机选择（App.spaces.select → 重新渲染展示范围与该范围的状态统计），从不 commit、不同步、不产生版本；
 * 管理空间里的每个修改都走 App.commit（可撤销、走现有同步 / 409 冲突 / opId / bad_spaces 处理）。 */
(function () {
  "use strict";
  var A = window.App; if (!A || !A.spaces) return;
  var SPC = A.spaces, M = SPC.model, esc = A.util.esc, body = document.body;
  var TEMPLATES = ["日常", "娱乐", "NAS"]; /* 只填名称，不按名称猜测、不自动放入任何分组 */
  var GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>';
  function typing(t) { return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }
  function allSpaces() { return [{ id: M.ALL, name: M.ALL_NAME }].concat(SPC.list()); }

  /* ------------------------------------------------ 切换器 */
  var nav = document.createElement("nav");
  nav.className = "x-spaces x-glass"; nav.setAttribute("aria-label", "空间");
  nav.innerHTML = '<div class="x-sp-track" role="toolbar" aria-label="切换空间" aria-orientation="horizontal"></div>' +
    '<button type="button" class="x-sp-manage" data-space-manage aria-label="管理空间" title="管理空间">' + GEAR + "</button>";
  var track = nav.querySelector(".x-sp-track");
  document.getElementById("x-groups").before(nav);
  function drawNav() {
    var cur = SPC.selected(), had = nav.contains(document.activeElement) && document.activeElement.getAttribute("data-space");
    track.innerHTML = allSpaces().map(function (s) {
      var on = s.id === cur, n = M.stats(A.state, s.id).items;
      return '<button type="button" class="x-sp" data-space="' + esc(s.id) + '"' + (on ? ' aria-current="true"' : "") + ' tabindex="' + (on ? 0 : -1) + '"' +
        ' aria-label="' + esc(s.name) + "，" + n + ' 个项目" title="' + esc(s.name) + '"><span>' + esc(s.name) + "</span><small aria-hidden=\"true\">" + n + "</small></button>";
    }).join("");
    if (had) { var b = track.querySelector('[data-space="' + A.util.sel(had) + '"]') || track.querySelector('[aria-current="true"]'); if (b) { roving(b); b.focus({ preventScroll: true }); } }
    /* 读布局放到下一帧：切换空间时不在同步路径里多算一次整页布局 */
    if (!revealQ) { revealQ = true; (window.requestAnimationFrame || setTimeout)(function () { revealQ = false; reveal(false); }); }
  }
  var revealQ = false;
  /* 让当前空间出现在横向滚动区里：只改 track.scrollLeft（不用 scrollIntoView，避免页面跟着纵向跳）。
     已经完整可见（留出 pad）就不动；否则居中；名称比可视区还宽时左对齐 */
  function revealLeft(sl, vw, sw, cl, cw, pad) {
    pad = pad || 0;
    var max = Math.max(0, sw - vw), want = sl;
    if (cw + 2 * pad >= vw) want = cl - pad;
    else if (cl - pad < sl || cl + cw + pad > sl + vw) want = cl - (vw - cw) / 2;
    return Math.round(Math.max(0, Math.min(max, want)));
  }
  function reveal(smooth) {
    var c = track.querySelector('[aria-current="true"]');
    if (!c || !track.clientWidth || track.scrollWidth <= track.clientWidth) return;
    var tr = track.getBoundingClientRect(), cr = c.getBoundingClientRect();
    var cs = getComputedStyle(track), pad = (parseFloat(cs.scrollPaddingLeft) || 0) || 12;
    var left = revealLeft(track.scrollLeft, track.clientWidth, track.scrollWidth, cr.left - tr.left + track.scrollLeft, cr.width, pad);
    if (left === Math.round(track.scrollLeft)) return;
    var still = !smooth || matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (track.scrollTo) track.scrollTo({ left: left, behavior: still ? "auto" : "smooth" }); else track.scrollLeft = left;
  }
  SPC.reveal = reveal; SPC.revealLeft = revealLeft;
  function roving(b) { track.querySelectorAll(".x-sp").forEach(function (x) { x.tabIndex = x === b ? 0 : -1; }); }
  track.addEventListener("click", function (e) {
    var b = e.target.closest("[data-space]"); if (!b) return;
    roving(b); SPC.select(b.getAttribute("data-space"));
  });
  track.addEventListener("keydown", function (e) {
    var bs = [].slice.call(track.querySelectorAll(".x-sp")), i = bs.indexOf(document.activeElement); if (i < 0) return;
    var k = e.key, n = k === "ArrowRight" || k === "ArrowDown" ? i + 1 : k === "ArrowLeft" || k === "ArrowUp" ? i - 1 : k === "Home" ? 0 : k === "End" ? bs.length - 1 : null;
    if (n == null) return;
    e.preventDefault(); n = (n + bs.length) % bs.length; roving(bs[n]); bs[n].focus();
  });
  nav.querySelector("[data-space-manage]").addEventListener("click", function () { open(SPC.selected() !== M.ALL ? SPC.selected() : null); });
  /* Alt+1 =「全部」，Alt+2… = 自定义空间（按顺序）。输入框里、浮层打开时不响应 */
  document.addEventListener("keydown", function (e) {
    if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || typing(e.target) || isOpen) return;
    var m = /^Digit([1-9])$/.exec(e.code || ""); if (!m) return;
    if (document.querySelector(".x-set.is-on, .x-is.is-on, .x-sheet.is-on, .x-cmdk.is-on, .x-menu.is-on") || document.documentElement.classList.contains("nc-locked")) return;
    var s = allSpaces()[+m[1] - 1]; if (!s) return;
    e.preventDefault(); SPC.select(s.id);
  });

  /* ------------------------------------------------ 管理空间 */
  var back = document.createElement("div"); back.className = "x-spm-back"; back.hidden = true;
  var sh = document.createElement("div");
  sh.className = "x-spm"; sh.hidden = true; sh.setAttribute("role", "dialog"); sh.setAttribute("aria-modal", "true"); sh.setAttribute("aria-labelledby", "x-spm-t");
  body.append(back, sh);
  var isOpen = false, expanded = null, confirmDel = null, newName = "", lastFocus = null, closeT = null, sortable = null;

  function groupsLine(s) {
    var g = (s.groupIds || []).length, it = (s.itemIds || []).length, x = (s.excludeItemIds || []).length;
    return g || it ? [g ? g + " 个分组" : "", it ? it + " 个单独项目" : "", x ? x + " 个已隐藏" : ""].filter(Boolean).join(" · ") : "还没有选分组";
  }
  function editorHTML(s) {
    var st = A.state, mem = M.membership(st), gset = new Set(s.groupIds || []), iset = new Set(s.itemIds || []), xset = new Set(s.excludeItemIds || []);
    var groups = st.groups.map(function (g) {
      var others = (mem[g.id] || []).filter(function (x) { return x !== s.id; }).length;
      return '<label class="x-spm-ck"><input type="checkbox" data-sp-group="' + esc(g.id) + '"' + (gset.has(String(g.id)) ? " checked" : "") + ">" +
        "<span><b>" + esc(g.name) + "</b><small>" + (g.items || []).length + " 个项目" + (others ? " · 也在 " + others + " 个其他空间" : "") + "</small></span></label>";
    }).join("") || '<p class="x-note">还没有分组。先在「全部」里新建分组和项目。</p>';
    var pins = st.groups.map(function (g) {
      var whole = gset.has(String(g.id)), items = g.items || [];
      if (!items.length) return "";
      /* 整组包含的分组：取消勾选 = 只在本空间隐藏这一项（excludeItemIds），再勾上 = 取消隐藏 */
      return '<p class="x-spm-ig">' + esc(g.name) + (whole ? " · 已整组包含，取消勾选可在本空间隐藏某一项" : "") + "</p>" + items.map(function (i) {
        var on = whole ? !xset.has(String(i.id)) || iset.has(String(i.id)) : iset.has(String(i.id));
        return '<label class="x-spm-ck' + (whole ? " is-whole" : "") + '"><input type="checkbox" data-sp-item="' + esc(i.id) + '"' + (whole ? ' data-whole="1"' : "") + (on ? " checked" : "") + ">" +
          "<span><b>" + esc(i.title || "未命名") + "</b>" + (whole && !on ? "<small>已在本空间隐藏</small>" : "") + "</span></label>";
      }).join("");
    }).join("");
    return '<div class="x-spm-ed" data-ed="' + esc(s.id) + '">' +
      '<form class="x-spm-f" data-spm-rename="' + esc(s.id) + '" novalidate><input type="text" data-sp-name="' + esc(s.id) + '" value="' + esc(s.name) + '" maxlength="60" aria-label="空间名称" autocomplete="off" enterkeyhint="done">' +
      '<span class="x-spm-cnt" data-cnt-for="' + esc(s.id) + '">' + Array.from(s.name).length + "/" + M.NAME_MAX + '</span><button type="submit" class="x-spm-btn">改名</button></form>' +
      '<p class="x-err" data-err-for="' + esc(s.id) + '" role="alert" hidden></p>' + lookHTML(s) +
      '<p class="x-spm-lab" id="x-spm-gl-' + esc(s.id) + '">包含的分组（整组：以后加进这些分组的项目也会出现）</p><div class="x-spm-gl" role="group" aria-labelledby="x-spm-gl-' + esc(s.id) + '">' + groups + "</div>" +
      (pins ? "<details" + ((s.itemIds || []).length || (s.excludeItemIds || []).length ? " open" : "") + "><summary>单独添加 / 隐藏项目（可选）</summary><div class=\"x-spm-gl\">" + pins + "</div></details>" : "") +
      (confirmDel === s.id
        ? '<div class="x-spm-cf" role="alert"><span>删除空间「' + esc(s.name) + '」？只删除这个空间，分组、项目、图标和壁纸都不会删。</span><div><button type="button" class="x-spm-btn is-red" data-spm="del-yes" data-sid="' + esc(s.id) + '">删除空间</button><button type="button" class="x-spm-btn" data-spm="del-no">取消</button></div></div>'
        : '<div class="x-spm-f"><button type="button" class="x-spm-btn is-red" data-spm="del" data-sid="' + esc(s.id) + '">删除这个空间</button></div>') + "</div>";
  }
  /* 空间外观（新版外观里生效）：氛围光与密度。「自动」= 不存字段，按名称模板（日常 / 娱乐 / NAS）给默认样子，其余为中性 */
  var LOOKS = { theme: [["", "自动"], ["default", "中性"], ["dawn", "晨光"], ["dusk", "靛紫"], ["frost", "冷霜"]],
    density: [["", "自动"], ["comfortable", "舒适"], ["poster", "海报"], ["compact", "紧凑"]] };
  function lookHTML(s) {
    return '<p class="x-spm-lab">氛围与密度（新版外观）</p>' + ["theme", "density"].map(function (k) {
      return '<div class="x-spm-look" role="group" aria-label="' + (k === "theme" ? "氛围" : "密度") + '">' + LOOKS[k].map(function (o) {
        return '<button type="button" data-sp-look="' + k + '" data-v="' + o[0] + '" data-sid="' + esc(s.id) + '" aria-pressed="' + ((s[k] || "") === o[0]) + '">' + o[1] + "</button>";
      }).join("") + "</div>";
    }).join("");
  }
  function draw() {
    var cur = SPC.selected(), list = SPC.list(), full = list.length >= M.MAX_SPACES;
    if (expanded && !M.get(A.state, expanded)) expanded = null;
    var fk = document.activeElement && sh.contains(document.activeElement) ? focusKey(document.activeElement) : null, sc = sh.scrollTop;
    var nb = 0; A.state.groups.forEach(function (g) { nb += (g.items || []).length; });
    sh.innerHTML = '<div class="x-spm-h"><button type="button" data-spm="close">关闭</button><h3 id="x-spm-t">管理空间</h3><button type="button" class="x-spm-done" data-spm="close">完成</button></div>' +
      '<p class="x-note">空间只引用已有的分组和项目，不复制。项目在哪个空间里改，所有空间都同步变化；删除空间不会删除分组或项目。顺序永远按「全部」里的全局顺序。</p>' +
      '<ol class="x-spm-list" aria-label="空间列表">' +
      '<li class="x-spm-row is-all' + (cur === M.ALL ? " is-cur" : "") + '"><span>' + M.ALL_NAME + "</span><small>固定在最前，不可删除 · " + A.state.groups.length + " 个分组、" + nb + " 个项目</small></li>" +
      list.map(function (s, i) {
        var ex = expanded === s.id;
        return '<li data-sid="' + esc(s.id) + '"><div class="x-spm-row' + (cur === s.id ? " is-cur" : "") + '"><span class="x-spm-drag" aria-hidden="true" title="拖动排序">⠿</span>' +
          '<button type="button" class="x-spm-open" data-spm="open" data-sid="' + esc(s.id) + '" aria-expanded="' + ex + '"><span>' + esc(s.name) + "</span><small>" + groupsLine(s) + "</small></button>" +
          '<button type="button" class="x-spm-ib" data-spm="up" data-sid="' + esc(s.id) + '" aria-label="上移「' + esc(s.name) + '」"' + (i ? "" : " disabled") + ">↑</button>" +
          '<button type="button" class="x-spm-ib" data-spm="down" data-sid="' + esc(s.id) + '" aria-label="下移「' + esc(s.name) + '」"' + (i < list.length - 1 ? "" : " disabled") + ">↓</button></div>" +
          (ex ? editorHTML(s) : "") + "</li>";
      }).join("") + "</ol>" +
      '<form class="x-spm-new" data-spm-new novalidate><h4>新建空间</h4>' +
      '<div class="x-spm-tpl" role="group" aria-label="名称模板">' + TEMPLATES.map(function (t) { return '<button type="button" data-tpl="' + t + '">' + t + "</button>"; }).join("") + "</div>" +
      '<div class="x-spm-f"><input type="text" name="name" maxlength="60" placeholder="空间名称，如 日常" aria-label="新空间名称" autocomplete="off" enterkeyhint="done" value="' + esc(newName) + '"' + (full ? " disabled" : "") + '>' +
      '<span class="x-spm-cnt" data-cnt-for="__new">' + Array.from(newName).length + "/" + M.NAME_MAX + '</span><button type="submit" class="x-spm-btn is-pri"' + (full ? " disabled" : "") + ">新建</button></div>" +
      '<p class="x-err" data-err-for="__new" role="alert"' + (full ? "" : " hidden") + ">" + (full ? "最多 " + M.MAX_SPACES + " 个空间，先删掉不用的再新建" : "") + "</p>" +
      '<p class="x-note">模板只帮你填名称，不会自动放入任何分组；新建后勾选要包含的分组。</p></form>';
    sh.scrollTop = sc;
    if (fk) { var el = sh.querySelector(fk); if (el) el.focus({ preventScroll: true }); }
    setupSort();
    if (newName) validateName("__new", newName);
  }
  function focusKey(el) {
    var attrs = ["data-sp-name", "data-sp-group", "data-sp-item", "data-tpl"];
    for (var i = 0; i < attrs.length; i++) if (el.hasAttribute(attrs[i])) return "[" + attrs[i] + '="' + A.util.sel(el.getAttribute(attrs[i])) + '"]';
    if (el.getAttribute("data-spm")) return '[data-spm="' + el.getAttribute("data-spm") + '"]' + (el.getAttribute("data-sid") ? '[data-sid="' + A.util.sel(el.getAttribute("data-sid")) + '"]' : "");
    if (el.name === "name") return "[data-spm-new] input[name=name]";
    return null;
  }
  /** 名称校验（与服务器同一套规则：spaces.js nameProblem / MAX_SPACES） */
  function validateName(key, v) {
    var msg = M.nameProblem(A.state, v, key === "__new" ? undefined : key);
    if (!msg && key === "__new" && SPC.list().length >= M.MAX_SPACES) msg = "最多 " + M.MAX_SPACES + " 个空间";
    var err = sh.querySelector('[data-err-for="' + A.util.sel(key) + '"]'), cnt = sh.querySelector('[data-cnt-for="' + A.util.sel(key) + '"]');
    var inp = key === "__new" ? sh.querySelector("[data-spm-new] input[name=name]") : sh.querySelector('[data-sp-name="' + A.util.sel(key) + '"]');
    var empty = !String(v).trim();
    if (err) { err.textContent = msg && !(empty && key === "__new") ? msg : ""; err.hidden = !err.textContent; }
    if (cnt) { var n = Array.from(String(v).trim()).length; cnt.textContent = n + "/" + M.NAME_MAX; cnt.style.color = n > M.NAME_MAX ? "#E26D5A" : ""; }
    if (inp) { inp.classList.toggle("is-bad", !!msg && !empty); inp.setAttribute("aria-invalid", String(!!msg && !empty)); }
    return msg;
  }
  function setupSort() {
    if (sortable) { try { sortable.destroy(); } catch (e) { /* gone */ } sortable = null; }
    var S = window.Sortable, ol = sh.querySelector(".x-spm-list"); if (!S || !ol) return;
    sortable = S.create(ol, { draggable: "li[data-sid]", handle: ".x-spm-drag", animation: 160, forceFallback: true, fallbackOnBody: true, onEnd: function () {
      var ids = [].map.call(ol.querySelectorAll("li[data-sid]"), function (li) { return li.getAttribute("data-sid"); });
      var now = SPC.list().map(function (s) { return s.id; });
      if (ids.join("\u0000") === now.join("\u0000")) return;
      setTimeout(function () { A.commit(function (st) { ids.forEach(function (id, i) { M.move(st, id, i); }); }, "space-order"); }, 0);
    } });
  }
  function open(id) {
    clearTimeout(closeT);
    if (id && M.get(A.state, id)) expanded = id;
    confirmDel = null;
    if (!isOpen) { lastFocus = document.activeElement; newName = ""; }
    isOpen = true; body.classList.add("x-spm-open");
    back.hidden = sh.hidden = false; draw();
    void sh.offsetWidth; back.classList.add("is-on"); sh.classList.add("is-on");
    var target = expanded ? sh.querySelector('[data-ed="' + A.util.sel(expanded) + '"] input[type=checkbox], [data-sp-name="' + A.util.sel(expanded) + '"]') : sh.querySelector("[data-spm-new] input[name=name]:not(:disabled)") || sh.querySelector('[data-spm="close"]');
    if (target) { target.focus({ preventScroll: true }); if (target.scrollIntoView && expanded) try { target.scrollIntoView({ block: "center" }); } catch (e) { /* ok */ } }
  }
  function close() {
    if (!isOpen) return;
    isOpen = false; confirmDel = null; body.classList.remove("x-spm-open");
    back.classList.remove("is-on"); sh.classList.remove("is-on");
    closeT = setTimeout(function () { if (!isOpen) { back.hidden = sh.hidden = true; sh.innerHTML = ""; } }, 300);
    if (sortable) { try { sortable.destroy(); } catch (e) { /* gone */ } sortable = null; }
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
  }
  function create() {
    var inp = sh.querySelector("[data-spm-new] input[name=name]"), v = inp ? inp.value : "";
    var msg = validateName("__new", v) || (v.trim() ? "" : "名称不能为空");
    if (msg) { var err = sh.querySelector('[data-err-for="__new"]'); err.textContent = msg; err.hidden = false; if (inp) inp.focus(); return; }
    var id = null;
    A.commit(function (st) { id = M.add(st, { name: v }); }, "space-add");
    newName = ""; expanded = id; confirmDel = null;
    SPC.select(id); /* 新建后直接切到它（本机），并展开它来勾选分组 */
    draw();
    var first = sh.querySelector('[data-ed="' + A.util.sel(id) + '"] input[type=checkbox]') || sh.querySelector('[data-sp-name="' + A.util.sel(id) + '"]');
    if (first) { first.focus({ preventScroll: true }); try { first.scrollIntoView({ block: "center" }); } catch (e) { /* ok */ } }
    A.toast("已新建「" + M.get(A.state, id).name + "」，勾选要包含的分组");
  }
  function rename(id) {
    var inp = sh.querySelector('[data-sp-name="' + A.util.sel(id) + '"]'), s = M.get(A.state, id); if (!inp || !s) return;
    var v = inp.value, msg = validateName(id, v);
    if (msg) { inp.focus(); return; }
    if (v.trim() === s.name) return;
    A.commit(function (st) { M.rename(st, id, v); }, "space-rename");
    A.toast("已改名为「" + M.get(A.state, id).name + "」");
  }

  sh.addEventListener("click", function (e) {
    var lk = e.target.closest("[data-sp-look]");
    if (lk) {
      var k = lk.getAttribute("data-sp-look"), v = lk.getAttribute("data-v") || null, sid0 = lk.getAttribute("data-sid"), sp0 = M.get(A.state, sid0);
      if (!sp0 || (sp0[k] || null) === v) return;
      var look = {}; look[k] = v;
      A.commit(function (st) { if (M.get(st, sid0)) M.setLook(st, sid0, look); }, "space-look");
      var nb2 = sh.querySelector('[data-sp-look="' + k + '"][data-v="' + (v || "") + '"][data-sid="' + A.util.sel(sid0) + '"]'); if (nb2) nb2.focus({ preventScroll: true });
      return;
    }
    var b = e.target.closest("[data-spm],[data-tpl]"); if (!b) return;
    if (b.hasAttribute("data-tpl")) {
      var inp = sh.querySelector("[data-spm-new] input[name=name]"); if (!inp || inp.disabled) return;
      inp.value = newName = b.getAttribute("data-tpl"); validateName("__new", newName); inp.focus(); return;
    }
    var a = b.getAttribute("data-spm"), id = b.getAttribute("data-sid");
    if (a === "close") return close();
    if (a === "open") { expanded = expanded === id ? null : id; confirmDel = null; draw(); var ob = sh.querySelector('[data-spm="open"][data-sid="' + A.util.sel(id) + '"]'); if (ob) ob.focus({ preventScroll: true }); return; }
    if (a === "up" || a === "down") {
      var l = SPC.list(), i = l.findIndex(function (s) { return s.id === id; }), to = a === "up" ? i - 1 : i + 1;
      if (i < 0 || to < 0 || to >= l.length) return;
      A.commit(function (st) { M.move(st, id, to); }, "space-order");
      var nb = sh.querySelector('[data-spm="' + a + '"][data-sid="' + A.util.sel(id) + '"]:not(:disabled)') || sh.querySelector('[data-spm="open"][data-sid="' + A.util.sel(id) + '"]');
      if (nb) nb.focus({ preventScroll: true });
      return;
    }
    if (a === "del") { confirmDel = id; draw(); var y = sh.querySelector('[data-spm="del-no"]'); if (y) y.focus({ preventScroll: true }); return; }
    if (a === "del-no") { var was = confirmDel; confirmDel = null; draw(); var d = sh.querySelector('[data-spm="del"][data-sid="' + A.util.sel(was) + '"]'); if (d) d.focus({ preventScroll: true }); return; }
    if (a === "del-yes") {
      var s = M.get(A.state, id); if (!s) return;
      confirmDel = null; expanded = null;
      A.commit(function (st) { M.remove(st, id); }, "space-delete"); /* 只删这条空间记录：分组、项目、图标、壁纸都不动 */
      A.toast("已删除空间「" + s.name + "」（分组和项目都还在）", { action: "撤销", onAction: A.undo, duration: 6000 });
      var o = sh.querySelector('[data-spm="open"]') || sh.querySelector('[data-spm="close"]'); if (o) o.focus({ preventScroll: true });
    }
  });
  sh.addEventListener("change", function (e) {
    var t = e.target, gid = t.getAttribute("data-sp-group"), iid = t.getAttribute("data-sp-item");
    var ed = t.closest("[data-ed]"), sid = ed && ed.getAttribute("data-ed"); if (!sid || (gid == null && iid == null)) return;
    var on = t.checked;
    if (gid != null) A.commit(function (st) {
      var s = M.get(st, sid); if (!s) return;
      var l = (s.groupIds || []).filter(function (x) { return x !== gid; }); if (on) l.push(gid);
      M.setGroups(st, sid, l);
    }, "space-groups");
    else if (t.hasAttribute("data-whole")) A.commit(function (st) { if (!M.get(st, sid)) return; if (on) M.unhide(st, sid, iid); else M.hide(st, sid, iid); }, on ? "space-unhide" : "space-hide");
    else A.commit(function (st) { if (M.get(st, sid)) M.pin(st, sid, iid, on); }, "space-pin");
  });
  sh.addEventListener("input", function (e) {
    var t = e.target;
    if (t.name === "name" && t.closest("[data-spm-new]")) { newName = t.value; validateName("__new", t.value); }
    else if (t.hasAttribute("data-sp-name")) validateName(t.getAttribute("data-sp-name"), t.value);
  });
  sh.addEventListener("submit", function (e) {
    e.preventDefault();
    var f = e.target;
    if (f.hasAttribute("data-spm-new")) create();
    else if (f.hasAttribute("data-spm-rename")) rename(f.getAttribute("data-spm-rename"));
  });
  back.addEventListener("click", close);
  window.addEventListener("keydown", function (e) {
    if (!isOpen || document.querySelector(".nc-cfs")) return; /* 冲突面板在上面：键盘归它 */
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation();
      if (confirmDel) { confirmDel = null; draw(); } else close();
    } else if (e.key === "Tab") { /* 焦点留在面板里 */
      var f = [].filter.call(sh.querySelectorAll("button, input, summary, [tabindex]"), function (x) { return !x.disabled && x.offsetParent !== null || x === document.activeElement; });
      if (!f.length) return;
      var i = f.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
    } else if ((e.metaKey || e.ctrlKey) && /^[ek]$/i.test(e.key)) e.stopImmediatePropagation();
  }, true);

  A.on("spaces-manage", function (d) { if (d) d.handled = true; open(d && d.id); });
  A.on("render", function () { drawNav(); if (isOpen) draw(); });
  drawNav();
})();
