import {
  getAllNotes,
  getAllFolders,
  putFolder,
  updateNote,
  setNotesFolder,
  deleteFolder,
  deleteFolderUnfav,
  markNotesPendingUnfav,
  getUnfavQueue,
  setUnfavQueue,
  clearAll
} from "../db.js";
import { classify, MAX_PER_RUN, isReservedFolderName } from "../ai.js";
import { DEFAULT_DEEPSEEK_KEY, MAX_FOLDERS, loadLocalKey } from "../config.js";

/* ---------------- 状态 ---------------- */

const state = {
  notes: [],
  folders: [],
  view: "all", // all | none | folderId
  query: "",
  shown: 60,
  picking: false,
  selected: new Set(),
  detailId: null,
  collecting: false,
  collected: false, // 本次会话采集过没，控制提示条
  tipClosed: false,
  /* 取消收藏同步的实时状态：面板开着就能看到第几条、剩几条 */
  sync: { active: false, done: 0, total: 0, remaining: 0, failed: 0, error: null, finished: false, closed: false },
  sig: ""
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const listEl = $("#list");
const countEl = $("#count");
const statusEl = $("#status");
const chipsEl = $("#chips");
const tipEl = $("#tipbar");
const syncEl = $("#syncbar");
const moreEl = $("#more");
const selbarEl = $("#selbar");
const selInfoEl = $("#selInfo");
const scrimEl = $("#scrim");
const searchEl = $("#search");
const toastEl = $("#toast");

/* ---------------- 小工具 ---------------- */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function noteUrl(n) {
  const base = "https://www.xiaohongshu.com/explore/" + encodeURIComponent(n.id);
  if (!n.xsecToken) return base;
  return (
    base +
    "?xsec_token=" +
    encodeURIComponent(n.xsecToken) +
    "&xsec_source=" +
    encodeURIComponent(n.xsecSource || "pc_collect")
  );
}

/* 库里可能存着旧数据（http 开头），渲染时再兜底一次：
 * chrome-extension:// 是安全上下文，http 图片会被混合内容策略拦掉。 */
function coverUrl(u) {
  return String(u || "").replace(/^http:\/\//i, "https://");
}

function folderName(id) {
  const f = state.folders.find((x) => x.id === id);
  return f ? f.name : "";
}

let toastTimer = null;
function toast(msg, ms = 2000) {
  toastEl.textContent = msg;
  toastEl.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("on"), ms);
}

/* ---------------- 浮层控制 ---------------- */

/* 二级浮层记住「从哪进来的」：返回键先回上一层（管理文件夹 → 更多操作），
 * 没有来路才真的退回面板首页 */
let sheetBackTo = null;

function openSheet(el) {
  el.classList.add("on");
  scrimEl.classList.add("on");
}

/* 从某个浮层里打开子浮层 */
function openChildSheet(el, parentSel) {
  closeSheets();
  openSheet(el);
  sheetBackTo = parentSel || null;
}

/* 返回：有来路就回上一层，否则关掉全部浮层 */
function backSheet() {
  const parent = sheetBackTo;
  sheetBackTo = null;
  closeSheets();
  if (parent && $(parent)) openSheet($(parent));
}

function closeSheets() {
  /* 列表内展开的详情不是浮层：先收起来，免得它跟着一起被当成 sheet 处理 */
  const d = $("#detail");
  if (d && d.classList.contains("inline")) closeDetail();
  $$(".sheet.on").forEach((s) => s.classList.remove("on"));
  scrimEl.classList.remove("on");
  sheetBackTo = null;
}

function closeModals() {
  $$(".modal.on").forEach((m) => m.classList.remove("on"));
}

scrimEl.addEventListener("click", () => {
  if (pendingConfirm) pendingConfirm(false);
  if (pendingNaming) pendingNaming(null);
  if (pendingPick) pendingPick(null);
  closeModals();
  closeSheets();
});

$$("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.dataset.close;
    const el = document.getElementById(id);
    if (el) el.classList.remove("on");
    if (!document.querySelector(".modal.on")) scrimEl.classList.remove("on");
    if (id === "pick" && pendingPick) pendingPick(null);
    if (id === "naming" && pendingNaming) pendingNaming(null);
    if (id === "confirm" && pendingConfirm) pendingConfirm(false);
  });
});

/* 通用三选一：确认框 / 输入框 / 单选列表，全部返回 Promise */

let pendingConfirm = null;
/* 确认框。可选一个勾选项（check）：删文件夹时用它区分「只删壳」和「连收藏一起取消」。
 * 勾不勾决定确定键写什么、是不是红的——默认那个动作不该看起来像危险操作。 */
function confirmBox({
  title,
  html,
  okText = "确定",
  danger = false,
  check = null,
}) {
  $("#confirmTitle").textContent = title;
  $("#confirmBody").innerHTML = html;

  const box = $("#confirmCheck");
  if (check) {
    box.hidden = false;
    box.innerHTML =
      `<label><input type="checkbox" id="confirmCheckBox"${
        check.checked ? " checked" : ""
      }><span>${check.label}</span></label>`;
  } else {
    box.hidden = true;
    box.innerHTML = "";
  }

  const ok = $("#confirmOk");
  const paintOk = () => {
    const cb = $("#confirmCheckBox");
    const on = !!(cb && cb.checked);
    ok.textContent = (on && check && check.okText) || okText;
    const hot = (on && check && check.danger) || danger;
    ok.className = hot ? "primary danger-solid" : "primary";
  };
  paintOk();

  openSheetNow("#confirm");

  /* 勾选状态变了，按钮文字和颜色立刻跟着变，不用关掉重开 */
  const cbEl = $("#confirmCheckBox");
  if (cbEl) cbEl.addEventListener("change", paintOk);

  const isChecked = () => {
    const cb = $("#confirmCheckBox");
    return !!(cb && cb.checked);
  };

  return new Promise((resolve) => {
    pendingConfirm = (val) => {
      const checked = isChecked();
      pendingConfirm = null;
      $("#confirm").classList.remove("on");
      if (!document.querySelector(".modal.on")) scrimEl.classList.remove("on");
      resolve({ ok: !!val, checked });
    };
  });
}

$("#confirmOk").addEventListener("click", () => pendingConfirm && pendingConfirm(true));

let pendingNaming = null;
/* 同一个输入框服务两种动作：新建（确定键是「创建」）和修改（确定键是「修改」）。
 * 按钮文字跟着场景走，别让「修改」最后按的是「创建」。 */
function nameBox({ title, placeholder = "", value = "", okText = "创建" }) {
  $("#namingTitle").textContent = title;
  $("#namingOk").textContent = okText;
  const input = $("#namingInput");
  input.placeholder = placeholder;
  input.value = value;
  openSheetNow("#naming");
  setTimeout(() => input.focus(), 60);
  return new Promise((resolve) => {
    pendingNaming = (val) => {
      pendingNaming = null;
      $("#naming").classList.remove("on");
      if (!document.querySelector(".modal.on")) scrimEl.classList.remove("on");
      resolve(val);
    };
  });
}

$("#namingOk").addEventListener("click", () => {
  const v = $("#namingInput").value.trim();
  if (!v) {
    toast("名字不能为空");
    return;
  }
  if (pendingNaming) pendingNaming(v);
});

$("#namingInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("#namingOk").click();
});

let pendingPick = null;
function pickBox({ title, options, current }) {
  $("#pickTitle").textContent = title;
  $("#pickBody").innerHTML = options
    .map(
      (o) =>
        `<label><input type="radio" name="pickf" value="${esc(o.id || "")}" ${
          String(o.id || "") === String(current || "") ? "checked" : ""
        }><span class="pick-name">${esc(o.name)}</span></label>`
    )
    .join("");
  openSheetNow("#pick");
  return new Promise((resolve) => {
    pendingPick = (val) => {
      pendingPick = null;
      $("#pick").classList.remove("on");
      if (!document.querySelector(".modal.on")) scrimEl.classList.remove("on");
      resolve(val);
    };
  });
}

$("#pickOk").addEventListener("click", () => {
  const sel = document.querySelector('input[name="pickf"]:checked');
  if (pendingPick) pendingPick(sel ? sel.value : null);
});

/* 移动文件夹也是「保存」：回车直接确定，不用挪鼠标去点 */
$("#pick").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    $("#pickOk").click();
  }
});

/* 弹窗层级高于 sheet，这里统一走 scrim */
function openSheetNow(sel) {
  const el = typeof sel === "string" ? $(sel) : sel;
  el.classList.add("on");
  scrimEl.classList.add("on");
}

/* ---------------- 计算与渲染 ---------------- */

function sortedNotes() {
  const q = state.query.trim().toLowerCase();
  let out = state.notes;
  if (state.view === "none") out = out.filter((n) => !n.folder);
  else if (state.view !== "all") out = out.filter((n) => n.folder === state.view);
  if (q) {
    out = out.filter((n) =>
      (n.title + " " + n.author + " " + (n.note || "")).toLowerCase().includes(q)
    );
  }
  return out.slice().sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0));
}

function renderChips() {
  const total = state.notes.length;
  const none = state.notes.filter((n) => !n.folder).length;
  const parts = [
    `<button type="button" class="chip ${state.view === "all" ? "on" : ""}" data-view="all">全部 <span class="n">${total}</span></button>`,
    `<button type="button" class="chip ${state.view === "none" ? "on" : ""}" data-view="none">未分类 <span class="n">${none}</span></button>`
  ];
  for (const f of state.folders) {
    const c = state.notes.filter((n) => n.folder === f.id).length;
    parts.push(
      `<button type="button" class="chip ${state.view === f.id ? "on" : ""}" data-view="${esc(
        f.id
      )}">${esc(f.name)} <span class="n">${c}</span></button>`
    );
  }
  parts.push(`<button type="button" class="chip new" data-view="__new">＋ 新建</button>`);
  chipsEl.innerHTML = parts.join("");
  revealActiveChip();
  chipsTick(paintChipEdges);
}

/* 让当前选中的 chip 始终在视野里（文件夹多了，选中项会被挤到右边看不见） */
function revealActiveChip() {
  const el = chipsEl.querySelector(".chip.on");
  if (!el || typeof el.scrollIntoView !== "function") return;
  try {
    el.scrollIntoView({ inline: "center", block: "nearest" });
  } catch (e) {
    /* 老内核不认 options，忽略即可 */
  }
}

/* 溢出时给两端加渐隐提示：右下角有东西可以滑，不用猜 */
function paintChipEdges() {
  const max = chipsEl.scrollWidth - chipsEl.clientWidth;
  const has = max > 2;
  chipsEl.classList.toggle("can-scroll", has);
  chipsEl.classList.toggle("fade-l", has && chipsEl.scrollLeft > 2);
  chipsEl.classList.toggle("fade-r", has && chipsEl.scrollLeft < max - 2);
}

function chipsTick(fn) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  /* 侧边栏切到后台时 rAF 会被节流，补一个定时器兜底（重复执行无副作用） */
  setTimeout(fn, 80);
}

function renderList() {
  /* 展开的详情就挂在列表里，innerHTML 重写会把它一起冲掉：
   * 先挪出去保命，渲染完再挂回原来那条下面。 */
  const openEl = (() => {
    const el = document.getElementById("detail");
    if (!el) return null;
    const live = el.classList.contains("on") && el.parentElement === listEl;
    if (live) document.body.appendChild(el);
    return live ? el : null;
  })();

  const filtered = sortedNotes();
  const slice = filtered.slice(0, state.shown);
  if (!slice.length) {
    listEl.innerHTML = state.notes.length
      ? `<div class="empty-hint">这里还没有内容</div>`
      : "";
  } else {
    listEl.innerHTML = slice
      .map((n) => {
        const fname = n.folder ? folderName(n.folder) : "";
        return `<div class="item ${state.selected.has(n.id) ? "sel" : ""}" data-id="${esc(n.id)}">
          <div class="tick"></div>
          <div class="cover">${
            n.cover ? `<img src="${esc(coverUrl(n.cover))}" loading="lazy" alt="">` : ""
          }</div>
          <div class="body">
            <p class="title">${esc(n.title)}</p>
            <p class="meta">${esc(n.author)}${
          n.liked ? " · 赞 " + esc(String(n.liked)) : ""
        }${fname ? `<span class="fol">${esc(fname)}</span>` : ""}</p>
          </div>
          <span class="fold" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12"><path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>收起</span>
        </div>`;
      })
      .join("");
  }

  if (openEl) {
    const row = state.detailId
      ? listEl.querySelector(`.item[data-id="${state.detailId}"]`)
      : null;
    if (row) {
      row.after(openEl);
      row.classList.add("open");
      detailRowEl = row;
    } else {
      /* 这一条被移走/删掉了，详情跟着收起 */
      closeDetail();
    }
  }

  moreEl.style.display = filtered.length > state.shown ? "block" : "none";
  countEl.textContent = filtered.length + " 条";
}

/* 未分类多到一定程度就别再让人一条条勾了：直接交给 AI 规划归类。
 * 少于这个数才走手动（条数少时手动反而更快、更准）。 */
const MANUAL_TIP_MAX = 10;

function renderTip() {
  const none = state.notes.filter((n) => !n.folder).length;
  const show = state.collected && !state.tipClosed && none > 0 && !state.picking;
  if (!show) {
    tipEl.classList.remove("on");
    tipEl.dataset.n = "";
    return;
  }
  if (tipEl.dataset.n === String(none) && tipEl.classList.contains("on")) return;
  tipEl.dataset.n = String(none);
  tipEl.classList.add("on");
  const useAi = none >= MANUAL_TIP_MAX;
  tipEl.innerHTML = `<span>采集完成，还有 <b>${none}</b> 条未分类</span>
    <button type="button" class="go" id="tipGo">${useAi ? "AI 自动整理 →" : "去整理 →"}</button>
    <button type="button" class="x" id="tipClose" title="先不管">×</button>`;
  $("#tipGo").addEventListener("click", async () => {
    /* 未分类 ≥ 10 条：直接打开 AI 归类并开跑，别让用户一条条勾
     * （动手成本太高就失去「省事」的意义了）；少于 10 条走手动多选 */
    if (useAi) {
      state.tipClosed = true;
      renderTip();
      toast(`未分类 ${none} 条，交给 AI 规划文件夹…`, 2600);
      startAi({ fromMenu: false });
      return;
    }
    state.view = "none";
    state.picking = true;
    document.body.classList.add("picking");
    renderAll();
    toast("勾选后点下方「移动」");
  });
  $("#tipClose").addEventListener("click", () => {
    state.tipClosed = true;
    renderTip();
  });
}

function renderSelbar() {
  selbarEl.classList.toggle("on", state.picking);
  selInfoEl.textContent = "已选 " + state.selected.size + " 条";
  /* 全选按钮：当前筛选下全选/全不选，一键切换 */
  const list = sortedNotes();
  const allSel = list.length > 0 && list.every((n) => state.selected.has(n.id));
  const allBtn = $("#selAll");
  if (allBtn) allBtn.textContent = allSel ? "全不选" : "全选";
  document.body.classList.toggle("picking", state.picking);
  $("#btn-select").textContent = state.picking ? "完成" : "选择";
  $("#btn-select").classList.toggle("on", state.picking);
}

function renderAll() {
  renderChips();
  renderList();
  renderTip();
  renderSelbar();
}

/* ---------------- 数据同步 ---------------- */

async function refresh(force) {
  try {
    let [notes, folders] = await Promise.all([getAllNotes(), getAllFolders()]);
    /* 老版本可能被 AI 建出过真实的「未分类」文件夹（chip 栏会重复两个）。
     * 这里就地并回兜底状态：里面的笔记回到未分类，文件夹壳删掉。
     * 纯本地动作，不碰小红书。 */
    if (folders.some((f) => isReservedFolderName(f.name))) {
      for (const f of folders.filter((x) => isReservedFolderName(x.name))) {
        await deleteFolder(f.id);
      }
      [notes, folders] = await Promise.all([getAllNotes(), getAllFolders()]);
    }
    /* pendingUnfav = 已排队取消收藏、等后台逐条处理的条目：列表里不再显示，
     * 记录保留（要拿 token 打开笔记页），取消成功后由后台真删。 */
    notes = notes.filter((n) => !n.pendingUnfav);
    const maxFirst = notes.reduce((m, n) => Math.max(m, n.firstSeen || 0), 0);
    /* 指纹要能察觉四种变化：新增条目、文件夹增删、归类数量变化、
     * 待取消条目增减（列表条数不变但 visible 数会变）。 */
    const classified = notes.reduce((c, n) => c + (n.folder ? 1 : 0), 0);
    const sig = notes.length + "|" + folders.length + "|" + maxFirst + "|" + classified;
    if (!force && sig === state.sig) return;
    state.sig = sig;
    state.notes = notes;
    state.folders = folders.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    for (const id of Array.from(state.selected)) {
      if (!notes.some((n) => n.id === id)) state.selected.delete(id);
    }
    renderAll();
  } catch (e) {
    /* 读库失败不打断面板 */
  }
}

refresh(true);
setInterval(() => refresh(false), 1500);

new IntersectionObserver((entries) => {
  if (entries[0] && entries[0].isIntersecting) {
    state.shown += 60;
    renderList();
  }
}).observe(moreEl);

/* ---------------- 列表交互 ---------------- */

listEl.addEventListener("click", (e) => {
  const item = e.target.closest(".item");
  if (!item) return;
  const id = item.dataset.id;
  if (state.picking) {
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    item.classList.toggle("sel");
    renderSelbar();
    return;
  }
  openDetail(id);
});

/* 详情不再另开一屏：直接在这条笔记下面展开，只放「所属文件夹」和「备注」两栏。
 * 标题和封面在上面那一行已经看得到，重复一遍是视觉冗余。
 * 点同一条、点「收起」、Esc 都收起，保存后自动收起。 */
let detailRowEl = null;

function closeDetail() {
  const el = $("#detail");
  el.classList.remove("on", "inline");
  if (detailRowEl) detailRowEl.classList.remove("open");
  detailRowEl = null;
  state.detailId = null;
  fsClose();
  /* 放回 body，否则下次渲染列表会把它一起冲掉 */
  if (el.parentElement && el.parentElement !== document.body) {
    document.body.appendChild(el);
  }
}

function openDetail(id) {
  const n = state.notes.find((x) => x.id === id);
  if (!n) return;

  /* 同一条再点一次 = 收起 */
  if (state.detailId === id && $("#detail").classList.contains("on")) {
    closeDetail();
    return;
  }
  closeDetail();

  state.detailId = id;
  const current = n.folder || "";
  $("#dFolder").value = current;
  const items = [{ id: "", name: "未分类" }].concat(state.folders);
  $("#dFolderList").innerHTML = items
    .map(
      (f) =>
        `<button type="button" class="fs-opt${f.id === current ? " on" : ""}" role="option" ` +
        `data-id="${esc(f.id)}" aria-selected="${f.id === current}">${esc(f.name)}</button>`
    )
    .join("");
  $("#dFolderLabel").textContent =
    (items.find((f) => f.id === current) || items[0]).name;
  $("#dNote").value = n.note || "";
  $("#dNote").placeholder = NOTE_PLACEHOLDER;

  /* 插到这一条下面，而不是盖住整屏 */
  const row = listEl.querySelector(`.item[data-id="${id}"]`);
  if (row) {
    row.after($("#detail"));
    row.classList.add("open");
    detailRowEl = row;
  }
  $("#detail").classList.add("on", "inline");
  if (detailRowEl && typeof $("#detail").scrollIntoView === "function") {
    try {
      $("#detail").scrollIntoView({ block: "nearest" });
    } catch (e) {
      /* 老内核不认 options，忽略 */
    }
  }
}

/* 所属文件夹：自定义下拉（原生 select 的悬停蓝色和直角用 CSS 改不掉，只能自己画） */
const fsEl = $("#dFolderSel");
const fsBtn = $("#dFolderBtn");
const fsList = $("#dFolderList");

function fsClose() {
  fsList.hidden = true;
  fsBtn.setAttribute("aria-expanded", "false");
}

function fsOpen() {
  fsList.hidden = false;
  fsBtn.setAttribute("aria-expanded", "true");
  const on = fsList.querySelector(".fs-opt.on");
  if (on) on.scrollIntoView({ block: "nearest" });
}

fsBtn.addEventListener("click", () => {
  if (fsList.hidden) fsOpen();
  else fsClose();
});

fsList.addEventListener("click", (e) => {
  const opt = e.target.closest(".fs-opt");
  if (!opt) return;
  $("#dFolder").value = opt.dataset.id;
  $("#dFolderLabel").textContent = opt.textContent;
  fsList.querySelectorAll(".fs-opt").forEach((o) => {
    o.classList.toggle("on", o === opt);
    o.setAttribute("aria-selected", o === opt ? "true" : "false");
  });
  fsClose();
});

/* 点别处 / Esc 收起；上下键在选项间移动（选项是 button，Enter/空格天然触发选中） */
document.addEventListener("click", (e) => {
  if (!fsList.hidden && !fsEl.contains(e.target)) fsClose();
});

fsEl.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    fsClose();
    fsBtn.focus();
    return;
  }
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  if (fsList.hidden) {
    fsOpen();
    return;
  }
  const opts = Array.from(fsList.querySelectorAll(".fs-opt"));
  if (!opts.length) return;
  const i = opts.indexOf(document.activeElement);
  const j =
    e.key === "ArrowDown" ? Math.min(i + 1, opts.length - 1) : Math.max(i - 1, 0);
  (opts[j] || opts[0]).focus();
});

/* 备注提示语：颜色调浅（见 CSS），一出现光标就收起来——
 * 否则那行灰字看着像「已经写好的备注」，容易让人以为存过了。 */
const NOTE_PLACEHOLDER = $("#dNote").getAttribute("placeholder") || "";
$("#dNote").addEventListener("focus", () => {
  $("#dNote").placeholder = "";
});
$("#dNote").addEventListener("blur", () => {
  if (!$("#dNote").value.trim()) $("#dNote").placeholder = NOTE_PLACEHOLDER;
});

/* 备注：Enter 直接保存（Shift+Enter 换行；中文输入法组词中的 Enter 不触发） */
$("#dNote").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#dSave").click();
  }
});

/* 收起靠这三条路：再点这条笔记、按 Esc、保存完自动收。
 * 展开块里不再放「收起」按钮——它压在「所属文件夹」那行右边，看着像属于那里。 */

/* Esc 收起展开的详情 */
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $("#detail").classList.contains("inline")) closeDetail();
});

$("#dSave").addEventListener("click", async () => {
  if (!state.detailId) return;
  const folder = $("#dFolder").value || null;
  const note = $("#dNote").value.trim();
  const id = state.detailId;
  await updateNote(id, { folder, note });
  closeDetail();
  await refresh(true);
  toast("已保存");
});

$("#dOpen").addEventListener("click", () => {
  const n = state.notes.find((x) => x.id === state.detailId);
  if (n) window.open(noteUrl(n), "_blank");
});

/* 单条取消收藏：插件里移除 + 同步到小红书（慢速执行，进度看红色提示条） */
$("#dUnfav").addEventListener("click", async () => {
  const n = state.notes.find((x) => x.id === state.detailId);
  if (!n) return;
  const { ok } = await confirmBox({
    title: "取消收藏这条？",
    html: `「${esc(n.title)}」<br><br>` +
      `① 插件里：这条收藏<b>立即移除</b>；<br>` +
      `② 小红书：排队<b>取消收藏</b>，马上开始执行，进度看面板里的红色进度条。<br><br>` +
      `万一没取消成功也不会丢——它仍收藏在小红书，下次采集会自动回来。`,
    okText: "取消收藏",
    danger: true
  });
  if (!ok) return;
  closeSheets();
  await unfavNotes([n.id], "这条收藏");
});

/* ---------------- 多选 ---------------- */

$("#btn-select").addEventListener("click", () => {
  state.picking = !state.picking;
  if (!state.picking) state.selected.clear();
  renderAll();
});

selbarEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const act = btn.dataset.act;
  const ids = Array.from(state.selected);

  if (act === "cancel") {
    state.picking = false;
    state.selected.clear();
    renderAll();
    return;
  }

  if (act === "all") {
    /* 全选只作用于「当前筛选出来的」条目（未分类页就是全部未分类），
     * 再点一次全不选 */
    const list = sortedNotes();
    if (!list.length) return toast("这里还没有内容");
    const allSel = list.every((n) => state.selected.has(n.id));
    if (allSel) list.forEach((n) => state.selected.delete(n.id));
    else list.forEach((n) => state.selected.add(n.id));
    renderList();
    renderSelbar();
    return;
  }

  if (act === "move") {
    if (!ids.length) return toast("先勾选几条");
    if (!state.folders.length) {
      toast("还没有文件夹，先新建一个");
      return;
    }
    const target = await pickBox({
      title: `移动 ${ids.length} 条到`,
      options: [{ id: "", name: "未分类" }].concat(state.folders)
    });
    if (target === null) return;
    await setNotesFolder(ids, target || null);
    /* 一次批量移动做完就退回浏览状态，否则底栏一直占着、提示条也出不来 */
    state.picking = false;
    state.selected.clear();
    await refresh(true);
    renderSelbar();
    toast(target ? `已移到「${folderName(target)}」` : "已移回未分类");
    return;
  }

  if (act === "unfav") {
    if (!ids.length) return toast("先勾选几条");
    const { ok } = await confirmBox({
      title: `取消收藏 ${ids.length} 条？`,
      html: `① 插件里：这 <b>${ids.length}</b> 条<b>立即移除</b>；<br>` +
        `② 小红书：排队<b>逐条取消收藏</b>（每条间隔几秒慢速执行，防风控），进度看红色进度条。<br><br>` +
        `中途失败会自动停止；没取消成功的不会丢——仍收藏在小红书，下次采集会自动回来。`,
      okText: "取消收藏",
      danger: true
    });
    if (!ok) return;
    state.picking = false;
    state.selected.clear();
    renderSelbar();
    await unfavNotes(ids, `${ids.length} 条收藏`);
    return;
  }

  if (act === "export") {
    const rows = state.notes.filter((n) => state.selected.has(n.id));
    if (!rows.length) return toast("先勾选几条");
    exportCsv(rows, "选中");
  }
});

/* ---------------- 导出 ---------------- */

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv(rows, scope) {
  if (!rows.length) return toast("没有可导出的内容");
  const head = ["标题", "作者", "点赞", "文件夹", "备注", "链接"];
  const lines = [head.join(",")];
  for (const n of rows) {
    lines.push(
      [
        n.title,
        n.author,
        n.liked,
        n.folder ? folderName(n.folder) : "",
        n.note || "",
        noteUrl(n)
      ]
        .map(csvCell)
        .join(",")
    );
  }
  const d = new Date();
  const stamp =
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");
  const name = `xhs-fav-${scope}-${stamp}.csv`;
  /* BOM 让 Excel 按 UTF-8 打开，否则中文乱码 */
  const blob = new Blob(["\ufeff" + lines.join("\r\n")], {
    type: "text/csv;charset=utf-8"
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast(`已导出 ${rows.length} 条到下载文件夹`, 2600);
}

/* ---------------- 菜单 ---------------- */

$("#btn-menu").addEventListener("click", () => openSheet($("#menu")));

/* 「更多操作」也要能退出去——不想操作的时候得有返回，不然只能点空白处 */
$("#menuBack").addEventListener("click", closeSheets);

$("#menu").addEventListener("click", async (e) => {
  const item = e.target.closest(".menu-item");
  if (!item) return;
  const act = item.dataset.menu;
  closeSheets();

  if (act === "collect") return openCollectSheet();

  if (act === "export") {
    const rows = sortedNotes();
    if (!rows.length) return toast("没有可导出的内容");
    const scope =
      state.view === "all" ? "全部" : state.view === "none" ? "未分类" : folderName(state.view);
    return exportCsv(rows, scope);
  }

  if (act === "folders") return openFolders();

  if (act === "sync") {
    const q = await getUnfavQueue();
    if (!q.length) return toast("没有待取消收藏的条目（删文件夹时会自动开始）");
    startUnfavSync();
    toast(`开始续跑 ${q.length} 条取消收藏，保持小红书页面在前台`, 2600);
    return;
  }

  if (act === "ai") return startAi({ fromMenu: true });

  if (act === "settings") return openSettings();

  if (act === "clear") {
    const { ok } = await confirmBox({
      title: "清空本地数据",
      html: `这会删掉本插件里的 <b>${state.notes.length}</b> 条收藏和所有文件夹。<br>只影响插件，<b>不动小红书</b>；需要时重新采集即可。`,
      okText: "清空",
      danger: true
    });
    if (!ok) return;
    await clearAll();
    state.selected.clear();
    state.picking = false;
    await refresh(true);
    toast("本地数据已清空");
  }
});

/* 采集条数：预设点了直接开跑，自定义填完再点按钮 */
$("#collectBack").addEventListener("click", backSheet);

$("#targetGrid").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-target]");
  if (!btn) return;
  startCollect(Number(btn.dataset.target));
});

$("#targetStop").addEventListener("click", stopCollect);

/* ---------------- 文件夹管理 ---------------- */
function openFolders() {
  const rows = state.folders.map((f) => {
    const c = state.notes.filter((n) => n.folder === f.id).length;
    return `<div class="folder-row" data-id="${esc(f.id)}">
      <div>
        <div class="name">${esc(f.name)}</div>
        <div class="num">${c} 条</div>
      </div>
      <div class="ops">
        <button type="button" data-op="rename">修改</button>
        <button type="button" class="del" data-op="del">删除</button>
      </div>
    </div>`;
  });
  $("#folderList").innerHTML = rows.length
    ? rows.join("")
    : `<div class="empty-hint">还没有文件夹</div>`;
  openChildSheet($("#folders"), "#menu");
}

$("#foldersBack").addEventListener("click", backSheet);

$("#folderNew").addEventListener("click", async () => {
  if (state.folders.length >= MAX_FOLDERS) {
    toast(`最多 ${MAX_FOLDERS} 个文件夹，类目太多分类效果反而差。先删或合并几个再来。`, 3200);
    return;
  }
  const name = await nameBox({ title: "新建文件夹", placeholder: "比如「装修灵感」" });
  if (!name) return;
  if (isReservedFolderName(name))
    return toast("「未分类」是系统自带的兜底分类，不用手动建", 2600);
  if (state.folders.some((f) => f.name === name)) return toast("已有同名文件夹");
  await putFolder({ id: "f" + Date.now().toString(36), name, createdAt: Date.now() });
  await refresh(true);
  openFolders();
  toast(`已新建「${name}」`);
});

$("#folderList").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-op]");
  if (!btn) return;
  const row = btn.closest(".folder-row");
  const id = row.dataset.id;
  const folder = state.folders.find((f) => f.id === id);
  if (!folder) return;
  const count = state.notes.filter((n) => n.folder === id).length;

  if (btn.dataset.op === "rename") {
    const name = await nameBox({
      title: "修改文件夹名",
      value: folder.name,
      okText: "完成",
    });
    if (!name) return;
    if (name === folder.name) return toast("名字没有变化");
    if (isReservedFolderName(name))
      return toast("「未分类」是系统自带的兜底分类，换个名字", 2600);
    if (state.folders.some((f) => f.id !== id && f.name === name))
      return toast("已有同名文件夹");
    await putFolder(Object.assign({}, folder, { name }));
    await refresh(true);
    openFolders();
    toast("修改成功");
    return;
  }

  const { ok, checked } = await confirmBox({
    title: `删除「${folder.name}」`,
    html:
      `这个文件夹里有 <b>${count}</b> 条收藏。<br><br>` +
      `默认<b>只删文件夹</b>：里面的收藏回到「未分类」，小红书上的收藏原样不动。` +
      (count
        ? `<br><br>要连小红书上的收藏一起清掉，勾选下面的选项。`
        : ""),
    okText: "只删文件夹",
    check: count
      ? {
          label: `同时取消收藏这 ${count} 条（在小红书逐条点「取消收藏」，每条几秒）`,
          okText: "删除并取消收藏",
          danger: true,
        }
      : null,
  });
  if (!ok) return;

  if (state.view === id) {
    state.view = "all";
    state.shown = 60;
  }

  /* ① 只删文件夹：壳删掉，笔记回「未分类」，不碰小红书 */
  if (!checked) {
    await deleteFolder(id);
    await refresh(true);
    openFolders();
    toast(
      count
        ? `已删除「${folder.name}」，${count} 条收藏回到「未分类」`
        : `已删除「${folder.name}」（里面是空的）`,
      2600
    );
    return;
  }

  /* ② 连收藏一起取消：标记待取消（列表立即隐藏、记录保留供打开笔记页用），返回笔记 id 排队 */
  const res = await deleteFolderUnfav(id);
  const removedIds = (res && res.ids) || [];
  /* 进「待取消收藏」队列（持久化，重启不丢），去重合并 */
  if (removedIds.length) {
    const q = await getUnfavQueue();
    const merged = q.concat(removedIds.filter((x) => !q.includes(x)));
    await setUnfavQueue(merged);
  }
  await refresh(true);
  openFolders();
  if (removedIds.length) {
    setSync({
      active: true,
      done: 0,
      total: removedIds.length,
      remaining: removedIds.length,
      error: null,
      finished: false
    });
    startUnfavSync();
    toast(`已删「${folder.name}」，${removedIds.length} 条正在取消收藏——进度看红色进度条`, 3200);
  } else {
    toast(`已删除「${folder.name}」（里面是空的）`);
  }
});

/* ---------------- 取消收藏同步 ---------------- */

function startUnfavSync() {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
    try {
      const p = chrome.runtime.sendMessage({ type: "xhsfav-sync-start" });
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (e) {}
  }
}

/* 进度条：删文件夹 / 单条取消收藏 / 批量取消收藏之后，这里实时显示
 * 「正在同步取消收藏到小红书：x / y 条」，完成、暂停、失败也都在这里交代。 */
function renderSync() {
  const s = state.sync || {};
  const show =
    !s.closed && (s.active || (s.remaining || 0) > 0 || ((s.done || 0) > 0 && s.finished));
  if (!show) {
    syncEl.classList.remove("on");
    return;
  }

  if (s.error && !s.active) {
    syncEl.innerHTML = `<div class="row"><span class="err">⚠️ ${esc(s.error)}${
      s.remaining ? `（剩 ${s.remaining} 条在队列里）` : ""
    }</span><button type="button" class="x" id="syncClose" title="知道了">×</button></div>`;
  } else if (s.active) {
    const pct = s.total ? Math.round(((s.done || 0) / s.total) * 100) : 0;
    syncEl.innerHTML =
      `<div class="row"><span>正在同步取消收藏到小红书：<b>${s.done || 0} / ${s.total}</b> 条 · 剩 ${
        s.remaining || 0
      } 条</span>` +
      `<button type="button" class="x" id="syncClose" title="收起">×</button></div>` +
      `<i class="bar"><i style="width:${pct}%"></i></i>` +
      `<span class="hint">${
        s.step ? "当前：" + esc(s.step) : "每条间隔几秒慢速执行，保持小红书页面打开"
      }</span>`;
  } else if ((s.remaining || 0) > 0) {
    syncEl.innerHTML =
      `<div class="row"><span>还有 <b>${s.remaining}</b> 条待取消收藏（同步已暂停）</span>` +
      `<button type="button" class="go" id="syncGo">续跑 →</button>` +
      `<button type="button" class="x" id="syncClose" title="先不管">×</button></div>`;
  } else {
    syncEl.innerHTML =
      `<div class="row"><span>✅ 取消收藏完成：共 <b>${s.done}</b> 条${
        s.failed ? `，失败 ${s.failed} 条` : ""
      }</span><button type="button" class="x" id="syncClose" title="知道了">×</button></div>`;
  }

  syncEl.classList.add("on");
  const go = $("#syncGo");
  if (go) {
    go.addEventListener("click", () => {
      startUnfavSync();
      state.sync.active = true;
      state.sync.error = null;
      renderSync();
      toast("继续同步，保持小红书页面打开", 2200);
    });
  }
  const x = $("#syncClose");
  if (x) {
    x.addEventListener("click", () => {
      state.sync.closed = true;
      renderSync();
    });
  }
}

function setSync(patch) {
  state.sync = Object.assign({}, state.sync, patch, { closed: false });
  renderSync();
}

/* 面板刚打开时问一句后台「现在同步到哪了」，别让用户重开面板就看不到进度 */
async function querySyncStatus() {
  try {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return;
    const s = await chrome.runtime.sendMessage({ type: "xhsfav-sync-status" });
    if (s && (s.syncing || (s.remaining || 0) > 0)) {
      state.sync = {
        active: !!s.syncing,
        done: s.done || 0,
        total: s.total || 0,
        remaining: s.remaining || 0,
        failed: s.failed || 0,
        error: null,
        finished: false,
        closed: false
      };
      renderSync();
    }
  } catch (e) {}
}
querySyncStatus();

/* 取消收藏（隐藏 + 排队，由后台逐条同步到小红书）的公共入口 */
async function unfavNotes(ids, label) {
  if (!ids || !ids.length) return;
  await markNotesPendingUnfav(ids);
  const q = await getUnfavQueue();
  const merged = q.concat(ids.filter((x) => !q.includes(x)));
  await setUnfavQueue(merged);
  setSync({ active: true, done: 0, total: merged.length, remaining: merged.length, error: null, step: "准备中", finished: false });
  await refresh(true);
  startUnfavSync();
  toast(`${label}正在小红书逐条取消收藏…（看下方红色进度条）`, 3200);
}

/* ---------------- AI 归类 ---------------- */

const KEY_STORE = "deepseekKey";
const aiDescEl = $("#aiDesc");
const aiListEl = $("#aiList");
const aiToolsEl = $("#aiTools");
const aiStartEl = $("#aiStart");
const aiConfirmEl = $("#aiConfirm");

/* 进度条放在首页（不在浮层里）：点完「AI 自动归类」就把浮层收起，
 * 边跑边在首页看进度，跑完再弹结果让人确认。 */
const aiProgEl = $("#aiprog");
const aiProgTextEl = $("#aiprogText");
const aiProgFillEl = $("#aiprogFill");

let aiResults = [];
let aiRunning = false;
let aiCtrl = null;
/* 结果面板该退回哪：'#menu' 或 null（直接回首页） */
let aiParentSel = null;

function showAiProg(text, pct) {
  aiProgEl.classList.add("on");
  aiProgTextEl.textContent = text;
  aiProgFillEl.style.width = Math.max(0, Math.min(100, Number(pct) || 0)) + "%";
}

function hideAiProg() {
  aiProgEl.classList.remove("on");
  aiProgFillEl.style.width = "0%";
}

function hasKeyStore() {
  return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
}

/* 优先级：用户在「设置」里填的 > 代码里的默认值。
 * 存 null 表示用户主动清空，这时不再回落到默认值。 */
async function getKey() {
  try {
    if (hasKeyStore()) {
      const got = await chrome.storage.local.get(KEY_STORE);
      if (got && Object.prototype.hasOwnProperty.call(got, KEY_STORE)) {
        return got[KEY_STORE] || "";
      }
    }
  } catch (e) {}
  /* 仓库里默认没有 Key；自己电脑上可以放 src/config.local.js（不进仓库） */
  if (DEFAULT_DEEPSEEK_KEY) return DEFAULT_DEEPSEEK_KEY;
  try {
    return (await loadLocalKey()) || "";
  } catch (e) {
    return "";
  }
}

async function setKey(v) {
  if (hasKeyStore()) await chrome.storage.local.set({ [KEY_STORE]: v });
}

async function openSettings() {
  $("#keyInput").value = (await getKey()) || "";
  openSheet($("#settings"));
}

$("#settingsBack").addEventListener("click", () => {
  closeSheets();
  openSheet($("#menu"));
});

$("#keySave").addEventListener("click", async () => {
  const v = $("#keyInput").value.trim();
  if (v && !/^sk-[A-Za-z0-9]{10,}$/.test(v)) {
    toast("Key 格式不对，应该是 sk- 开头的一长串");
    return;
  }
  await setKey(v || null);
  closeSheets();
  toast(v ? "Key 已保存" : "Key 已清空");
});

$("#keyClear").addEventListener("click", async () => {
  $("#keyInput").value = "";
  await setKey(null);
  toast("Key 已清空");
});

/* Key 也是「保存」：回车直接存 */
$("#keyInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    $("#keySave").click();
  }
});

/* ---------- 外观：浅色 / 深色，两档自选 ----------
 * 不做「跟随系统」：Chrome 在 Windows 上跟的是「应用模式」，系统深色但
 * Chrome 报 light 时媒体查询压根不触发，用户只会觉得坏了一半。
 * 现在由 <html data-theme> 驱动，默认浅色，选哪档就是哪档。 */
const THEME_STORE = "theme";
const THEME_LS = "xhsfav-theme";
const THEME_MODES = ["light", "dark"];
const THEME_DEFAULT = "light";

let themeMode = THEME_DEFAULT;

function paintTheme(mode) {
  themeMode = THEME_MODES.indexOf(mode) >= 0 ? mode : THEME_DEFAULT;
  document.documentElement.setAttribute("data-theme", themeMode);
  /* localStorage 放一份镜像：首屏前的内联脚本要同步读，chrome.storage 是异步的 */
  try {
    localStorage.setItem(THEME_LS, themeMode);
  } catch (e) {}
  $$("#themeSeg button").forEach((b) =>
    b.classList.toggle("on", b.dataset.theme === themeMode)
  );
}

async function setTheme(mode) {
  paintTheme(mode);
  try {
    if (hasKeyStore()) await chrome.storage.local.set({ [THEME_STORE]: themeMode });
  } catch (e) {}
}

async function loadTheme() {
  let mode = THEME_DEFAULT;
  try {
    if (hasKeyStore()) {
      const got = await chrome.storage.local.get(THEME_STORE);
      /* 老版本存过 system，这里归一成浅色 */
      if (got && THEME_MODES.indexOf(got[THEME_STORE]) >= 0) mode = got[THEME_STORE];
    }
  } catch (e) {}
  paintTheme(mode);
}

$$("#themeSeg button").forEach((b) =>
  b.addEventListener("click", () => setTheme(b.dataset.theme))
);

loadTheme();

$("#aiBack").addEventListener("click", () => {
  if (aiCtrl) aiCtrl.abort();
  backSheet();
});

function renderAiList() {
  aiListEl.innerHTML = aiResults
    .map((r) => {
      const isNew = !!r.newFolder;
      const on = !!r.folderId || isNew;
      const meta = r.folderId
        ? `→ <b>${esc(r.folderName)}</b> · ${esc(r.tier)}`
        : isNew
        ? `→ 新建文件夹「<b>${esc(r.newFolder)}</b>」 · ${esc(r.tier)}`
        : "没有合适的文件夹 · 保持未分类";
      const attrs = r.folderId
        ? `data-fid="${esc(r.folderId)}"`
        : isNew
        ? `data-new="${esc(r.newFolder)}"`
        : "";
      return `<label class="sug ${on ? "" : "none"}">
        <input type="checkbox" data-id="${esc(r.id)}" ${attrs} ${on ? "checked" : ""} ${
        on ? "" : "disabled"
      }>
        <div class="st">
          <p class="t">${esc(r.title)}</p>
          <p class="m">${meta}</p>
        </div>
      </label>`;
    })
    .join("");
  aiToolsEl.hidden = !aiResults.length;
}

$("#aiAll").addEventListener("click", () => {
  aiListEl.querySelectorAll('input[type="checkbox"]:not(:disabled)').forEach((c) => {
    c.checked = true;
  });
  syncAiConfirm();
});

$("#aiNone").addEventListener("click", () => {
  aiListEl.querySelectorAll('input[type="checkbox"]').forEach((c) => {
    c.checked = false;
  });
  syncAiConfirm();
});

function checkedAiRows() {
  return Array.from(aiListEl.querySelectorAll('input[type="checkbox"]')).filter(
    (c) => c.checked && (c.dataset.fid || c.dataset.new)
  );
}

function syncAiConfirm() {
  const n = checkedAiRows().length;
  aiConfirmEl.disabled = n === 0;
  aiConfirmEl.textContent = n ? `确认归类 ${n} 条` : "确认归类";
}

aiListEl.addEventListener("change", syncAiConfirm);

/* 点「AI 自动归类」/ 提示条「AI 自动整理 →」都走这里：
 * 不弹中间面板、不选条数，直接按上限 500 条开跑，进度显示在首页。 */
async function startAi({ fromMenu = false } = {}) {
  if (aiRunning) {
    toast("AI 正在跑，首页有进度条，等它跑完", 2600);
    return;
  }
  const pending = state.notes
    .filter((n) => !n.folder)
    .sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0))
    .slice(0, MAX_PER_RUN);
  if (!pending.length) return toast("没有未分类的收藏了");

  const key = await getKey();
  if (!key) {
    openSettings();
    toast("先填 DeepSeek Key", 2600);
    return;
  }
  aiParentSel = fromMenu ? "#menu" : null;
  closeSheets();
  await runAi(pending, key);
}

async function runAi(pending, key) {
  aiCtrl = new AbortController();
  aiRunning = true;
  aiResults = [];
  showAiProg(`AI 正在规划文件夹…（共 ${pending.length} 条）`, 3);

  try {
    let aiFailed = 0;
    const res = await classify({
      apiKey: key,
      notes: pending,
      folders: state.folders,
      signal: aiCtrl.signal,
      onProgress: ({ phase, done, total, batch, batches, failed }) => {
        if (phase === "done") {
          aiFailed = failed || 0;
          return;
        }
        if (phase === "plan") {
          showAiProg(`AI 正在规划文件夹…（共 ${total} 条）`, 3);
          return;
        }
        const pct = Math.max(3, Math.round((done / Math.max(total, 1)) * 100));
        showAiProg(
          `AI 分类中 ${done} / ${total}` + (batches > 1 ? ` · 第 ${batch} / ${batches} 批` : ""),
          pct
        );
      }
    });
    hideAiProg();
    showAiResults(res, aiFailed);
  } catch (e) {
    hideAiProg();
    /* 清掉上一轮的建议，免得再打开面板看到一份过期的列表 */
    aiResults = [];
    renderAiList();
    if (e && e.name === "AbortError") {
      toast("已停止，什么都没改。", 2600);
    } else {
      const msg = (e && e.message) || String(e);
      toast("AI 归类失败：" + msg, 3600);
    }
  } finally {
    aiRunning = false;
    aiCtrl = null;
    aiStartEl.textContent = "重新分析";
  }
}

/* 跑完把建议摆进面板让人确认；确认前不写库 */
function showAiResults(res, failed) {
  aiResults = res;
  aiStartEl.textContent = "重新分析";
  aiConfirmEl.disabled = true;
  aiConfirmEl.textContent = "确认归类";
  renderAiList();
  const hit = res.filter((r) => r.folderId || r.newFolder).length;
  const fresh = new Set(res.filter((r) => r.newFolder).map((r) => r.newFolder));
  aiDescEl.innerHTML =
    `分析完成：${res.length} 条里 <b>${hit}</b> 条给出归属` +
    (fresh.size ? `（新建文件夹：${[...fresh].map(esc).join("、")}）` : "") +
    `。` +
    (failed
      ? `<br>其中 <b>${failed}</b> 条模型没返回结果（超时或返回被截断），可再点一次「重新分析」补上。`
      : "") +
    `<br><b>已全部自动勾选</b>，点「确认归类」一次完成；不想动的先勾掉。<b>不会改动小红书</b>。`;
  syncAiConfirm();
  openChildSheet($("#ai"), aiParentSel);
}

aiStartEl.addEventListener("click", () => {
  if (aiRunning && aiCtrl) {
    aiCtrl.abort();
    return;
  }
  startAi({ fromMenu: aiParentSel === "#menu" });
});

$("#aiprogStop").addEventListener("click", () => {
  if (aiCtrl) aiCtrl.abort();
});

aiConfirmEl.addEventListener("click", async () => {
  const rows = checkedAiRows();
  if (!rows.length) return toast("没有勾选要归类的条目");

  /* 先按「已有文件夹」和「建议新建」分两组 */
  const byFolder = new Map();
  const byNew = new Map();
  for (const c of rows) {
    if (c.dataset.fid) {
      const fid = c.dataset.fid;
      if (!byFolder.has(fid)) byFolder.set(fid, []);
      byFolder.get(fid).push(c.dataset.id);
    } else {
      const name = c.dataset.new;
      /* 兜底：AI 结果里就算混进了「未分类」，也只当没有建议，绝不建同名文件夹 */
      if (isReservedFolderName(name)) continue;
      if (!byNew.has(name)) byNew.set(name, []);
      byNew.get(name).push(c.dataset.id);
    }
  }

  /* 新建文件夹（本地建，不碰小红书）；重名或与已有的重复就复用；
   * 上限兜底：即使 AI 结果里漏了裁剪，这里也绝不多建。 */
  let created = 0;
  let skippedNew = 0;
  for (const [name, ids] of byNew) {
    let folder = state.folders.find((f) => f.name === name);
    if (!folder) {
      if (state.folders.length >= MAX_FOLDERS) {
        skippedNew += ids.length;
        continue;
      }
      folder = { id: "f" + Date.now().toString(36) + created, name, createdAt: Date.now() };
      await putFolder(folder);
      state.folders.push(folder);
      created++;
    }
    byFolder.set(folder.id, (byFolder.get(folder.id) || []).concat(ids));
  }

  let total = 0;
  for (const [fid, ids] of byFolder) {
    await setNotesFolder(ids, fid);
    total += ids.length;
  }
  aiResults = [];
  closeSheets();
  await refresh(true);
  toast(
    created
      ? `已归类 ${total} 条，新建了 ${created} 个文件夹`
      : `已归类 ${total} 条（只改本地，小红书未动）` +
        (skippedNew ? `；${skippedNew} 条因文件夹已满 ${MAX_FOLDERS} 个保持未分类` : ""),
    3200
  );
});

/* ---------------- 采集 ---------------- */

/* 点菜单的「开始采集」先选条数：四档没有默认，第一次打开不预选，点哪档跑哪档；
 * 选过之后记住上一次的选择（只做高亮提示，不点不会开跑）。
 * 上限 5000 是拍出来的：再大这一屏的收藏页也刷不完，而且滚动太久易掉线。 */
const COLLECT_DEFAULT = 1000;
const COLLECT_MIN = 20;
const COLLECT_MAX = 5000;
const TARGET_STORE = "collectTarget";
let collectTarget = null;

function clampTarget(v) {
  const n = Math.round(Number(v) || 0);
  if (!n) return 0;
  return Math.max(COLLECT_MIN, Math.min(COLLECT_MAX, n));
}

async function loadCollectTarget() {
  try {
    if (!hasKeyStore()) return;
    const got = await chrome.storage.local.get(TARGET_STORE);
    const v = got && clampTarget(got[TARGET_STORE]);
    if (v) collectTarget = v;
  } catch (e) {}
}

async function saveCollectTarget(v) {
  try {
    if (hasKeyStore()) await chrome.storage.local.set({ [TARGET_STORE]: v });
  } catch (e) {}
}

async function openCollectSheet() {
  await loadCollectTarget();
  $$("#targetGrid button").forEach((b) =>
    b.classList.toggle("on", Number(b.dataset.target) === collectTarget)
  );
  $("#collectDesc").innerHTML = state.collecting
    ? "正在采集中。<b>点任意条数会先停下来重新开始</b>；只想停就点下面的「停止采集」。"
    : "点一个条数就开始。页面会自动往下滚，<b>别切走这个标签页</b>，中途可以点「停止采集」。";
  $("#targetStop").hidden = !state.collecting;
  openChildSheet($("#collect"), "#menu");
}

async function activeXhsTab() {
  if (typeof chrome === "undefined" || !chrome.tabs) return null;
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.url || !tab.url.startsWith("https://www.xiaohongshu.com/")) return null;
  return tab;
}

async function stopCollect() {
  const tab = await activeXhsTab();
  if (tab) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "xhsfav-stop" });
    } catch (e) {}
  }
  state.collecting = false;
  statusEl.classList.remove("live");
  statusEl.textContent = "已停止采集。";
  closeSheets();
}

async function startCollect(target = collectTarget) {
  const t = clampTarget(target) || COLLECT_DEFAULT;
  collectTarget = t;
  await saveCollectTarget(t);

  const tab = await activeXhsTab();
  if (!tab) {
    statusEl.textContent = "当前标签页不是小红书，先切过去再点开始。";
    closeSheets();
    return;
  }
  /* 已经在采：先让页面那边收尾，再按新条数重开一轮，不叠着跑 */
  if (state.collecting) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "xhsfav-stop" });
    } catch (e) {}
    state.collecting = false;
  }
  closeSheets();
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "xhsfav-start",
      target: t
    });
    state.collecting = true;
    statusEl.classList.add("live");
    statusEl.textContent = `采集中：0 / ${t} 条 · 页面会自动往下滚，别切走这个标签页。`;
  } catch (e) {
    statusEl.textContent =
      "无法连接页面脚本，请刷新小红书页面后重试（F5）。错误：" + esc(String(e && e.message));
  }
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "xhsfav-progress") {
      const { total, target, done, reason } = msg;
      if (!done) {
        statusEl.classList.add("live");
        statusEl.textContent = `采集中：${total} / ${target} 条 · 页面会自动往下滚，别切走这个标签页。`;
        return;
      }
      state.collecting = false;
      statusEl.classList.remove("live");
      const why =
        reason === "reached-target"
          ? "已达目标条数"
          : reason === "no-more"
          ? "已到收藏底部"
          : reason === "stopped"
          ? "手动停止"
          : "15 秒无新数据，页面可能没刷新，按 F5 后重试";
      statusEl.textContent = `采集结束（${why}）：本次 ${total} 条。`;
      if (reason !== "stopped") state.collected = true;
      state.tipClosed = false;
      refresh(true).then(renderTip);
      return;
    }

  if (msg.type === "xhsfav-uncollect-progress") {
    const { done, total, failed, remaining, error, finished, empty, step } = msg;
    if (empty) {
      statusEl.textContent = "没有待取消收藏的条目。";
      return;
    }
    setSync({
      active: !finished && !error,
      done: done || 0,
      total: total || 0,
      remaining: remaining || 0,
      failed: failed || 0,
      error: error || null,
      step: finished || error ? null : step || (state.sync && state.sync.step) || null,
      finished: !!finished
    });
    if (error) {
      statusEl.classList.remove("live");
      statusEl.textContent =
        `取消收藏停止：${error}` +
        (remaining ? `。剩 ${remaining} 条留在队列，下次采集也会回来。` : "");
      return;
    }
    if (finished) {
      statusEl.classList.remove("live");
      statusEl.textContent = remaining
        ? `已处理 ${done} 条，剩 ${remaining} 条待续。点 ⋯ → 续跑取消收藏 继续。`
        : `取消收藏全部完成：${done} 条${failed ? `，失败 ${failed} 条` : ""}。`;
      return;
    }
    statusEl.classList.add("live");
    statusEl.textContent = `取消收藏中 ${done} / ${total} 条 · 每条间隔几秒，别关小红书页面。`;
    return;
  }
  });
}

/* ---------------- 搜索 ---------------- */

searchEl.addEventListener("input", () => {
  state.query = searchEl.value;
  state.shown = 60;
  renderList();
});

/* ---------- chips 横向滑动 ----------
 * 侧边栏很窄，文件夹一多 chips 就溢出。浏览器只在有滚动条 /
 * Shift+滚轮 / 触控板横扫时才横向滚，普通鼠标滚轮完全没反应，
 * 用户看到的就是「后面的文件夹打不开」。这里补三条路： */
let chipDrag = null; /* { x, left } */
let chipDragEndAt = 0; /* 拖动结束时刻：拖完那一下不算点击 */

/* ① 滚轮：竖向滚轮转成横向滑动，滑到头再让面板自己滚 */
chipsEl.addEventListener(
  "wheel",
  (e) => {
    const max = chipsEl.scrollWidth - chipsEl.clientWidth;
    if (max <= 0) return; /* 没溢出就不拦，别影响正常滚动 */
    const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (!d) return;
    const next = Math.max(0, Math.min(max, chipsEl.scrollLeft + d));
    if (next === chipsEl.scrollLeft) return; /* 已经到头，交给页面滚 */
    e.preventDefault();
    chipsEl.scrollLeft = next;
    paintChipEdges();
  },
  { passive: false }
);

/* ② 按住左右拖，像手机上滑标签那样 */
chipsEl.addEventListener("pointerdown", (e) => {
  if (e.pointerType !== "mouse" || e.button !== 0) return;
  chipDrag = { x: e.clientX, left: chipsEl.scrollLeft, moved: false };
});

window.addEventListener("pointermove", (e) => {
  if (!chipDrag) return;
  const dx = e.clientX - chipDrag.x;
  if (!chipDrag.moved) {
    if (Math.abs(dx) < 5) return; /* 手抖不算拖动，别影响点击 */
    chipDrag.moved = true;
    chipsEl.classList.add("grabbing");
  }
  chipsEl.scrollLeft = chipDrag.left - dx;
  paintChipEdges();
});

function endChipDrag() {
  if (!chipDrag) return;
  if (chipDrag.moved) chipDragEndAt = Date.now();
  chipDrag = null;
  chipsEl.classList.remove("grabbing");
}
window.addEventListener("pointerup", endChipDrag);
window.addEventListener("pointercancel", endChipDrag);

/* ③ 触摸板 / 手指横扫走原生滚动，只要跟着更新两端渐隐 */
chipsEl.addEventListener("scroll", paintChipEdges, { passive: true });
window.addEventListener("resize", paintChipEdges);

/* ④ 两端小箭头：点一下翻大半屏，箭头本身也是「右边还有内容」的明确提示 */
function chipNudge(dir) {
  const max = Math.max(0, chipsEl.scrollWidth - chipsEl.clientWidth);
  const step = Math.max(140, Math.round(chipsEl.clientWidth * 0.7));
  const to = Math.max(0, Math.min(max, chipsEl.scrollLeft + dir * step));
  if (typeof chipsEl.scrollTo === "function") {
    try {
      chipsEl.scrollTo({ left: to, behavior: "smooth" });
    } catch (e) {
      chipsEl.scrollLeft = to;
    }
  } else {
    chipsEl.scrollLeft = to;
  }
  paintChipEdges();
}

const chipPrevEl = $("#chipPrev");
const chipNextEl = $("#chipNext");
if (chipPrevEl) chipPrevEl.addEventListener("click", () => chipNudge(-1));
if (chipNextEl) chipNextEl.addEventListener("click", () => chipNudge(1));

/* chips 点击（事件委托，chips 会整块重绘） */
chipsEl.addEventListener("click", async (e) => {
  /* 刚拖动过的那一下松手会补一个 click，别当成翻页 */
  if (Date.now() - chipDragEndAt < 400) return;
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const v = chip.dataset.view;
  if (v === "__new") {
    if (state.folders.length >= MAX_FOLDERS) {
      toast(`最多 ${MAX_FOLDERS} 个文件夹，类目太多分类效果反而差。`, 3200);
      return;
    }
    const name = await nameBox({ title: "新建文件夹", placeholder: "比如「装修灵感」" });
    if (!name) return;
    if (state.folders.some((f) => f.name === name)) return toast("已有同名文件夹");
    const f = { id: "f" + Date.now().toString(36), name, createdAt: Date.now() };
    await putFolder(f);
    await refresh(true);
    state.view = f.id;
    renderAll();
    toast(`已新建「${name}」`);
    return;
  }
  state.view = v;
  state.shown = 60;
  renderAll();
});
