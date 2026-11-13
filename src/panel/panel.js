import {
  getAllNotes,
  getAllFolders,
  putFolder,
  updateNote,
  setNotesFolder,
  deleteFolderUnfav,
  markNotesPendingUnfav,
  getUnfavQueue,
  setUnfavQueue,
  clearAll
} from "../db.js";
import { classify, MAX_PER_RUN } from "../ai.js";
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
function confirmBox({ title, html, okText = "确定", danger = false }) {
  $("#confirmTitle").textContent = title;
  $("#confirmBody").innerHTML = html;
  const ok = $("#confirmOk");
  ok.textContent = okText;
  ok.className = danger ? "primary danger-solid" : "primary";
  openSheetNow("#confirm");
  return new Promise((resolve) => {
    pendingConfirm = (val) => {
      pendingConfirm = null;
      $("#confirm").classList.remove("on");
      if (!document.querySelector(".modal.on")) scrimEl.classList.remove("on");
      resolve(val);
    };
  });
}

$("#confirmOk").addEventListener("click", () => pendingConfirm && pendingConfirm(true));

let pendingNaming = null;
function nameBox({ title, placeholder = "", value = "" }) {
  $("#namingTitle").textContent = title;
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
        </div>`;
      })
      .join("");
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
      await openAi();
      if ($("#ai").classList.contains("on") && !aiRunning) {
        toast(`未分类 ${none} 条，交给 AI 规划文件夹…`, 2600);
        runAi();
      }
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

function openDetail(id) {
  const n = state.notes.find((x) => x.id === id);
  if (!n) return;
  state.detailId = id;
  const img = $("#dCover");
  if (n.cover) img.src = coverUrl(n.cover);
  else img.removeAttribute("src");
  $("#dTitle").textContent = n.title;
  $("#dMeta").textContent =
    (n.author || "未知作者") + (n.liked ? " · 赞 " + n.liked : "");
  const opts = [`<option value="">未分类</option>`].concat(
    state.folders.map(
      (f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`
    )
  );
  $("#dFolder").innerHTML = opts.join("");
  $("#dFolder").value = n.folder || "";
  $("#dNote").value = n.note || "";
  openSheet($("#detail"));
}

$("#detailBack").addEventListener("click", closeSheets);

$("#dSave").addEventListener("click", async () => {
  if (!state.detailId) return;
  const folder = $("#dFolder").value || null;
  const note = $("#dNote").value.trim();
  await updateNote(state.detailId, { folder, note });
  closeSheets();
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
  const ok = await confirmBox({
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
    const ok = await confirmBox({
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

  if (act === "ai") return openAi(true);

  if (act === "settings") return openSettings();

  if (act === "clear") {
    const ok = await confirmBox({
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

$("#targetGo").addEventListener("click", () => {
  const v = clampTarget($("#targetCustom").value);
  if (!v) return toast("先填个条数，比如 2000", 2400);
  startCollect(v);
});

$("#targetCustom").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("#targetGo").click();
  }
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
        <button type="button" data-op="rename">改名</button>
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
    const name = await nameBox({ title: "重命名文件夹", value: folder.name });
    if (!name || name === folder.name) return;
    await putFolder(Object.assign({}, folder, { name }));
    await refresh(true);
    openFolders();
    return;
  }

  const ok = await confirmBox({
    title: `删除「${folder.name}」`,
    html: `里面有 <b>${count}</b> 条收藏。确认后两件事一起发生：<br><br>` +
      `① 插件里：文件夹和这 <b>${count}</b> 条收藏立即隐藏；<br>` +
      `② 小红书：后台逐条<b>打开笔记页点「取消收藏」</b>（完全模拟真人操作，安全）。<br><br>` +
      `每条要几秒钟，中途失败会立即停止；<b>没取消成功的记录会保留</b>，随时可续跑。`,
    okText: "删除并取消收藏",
    danger: true
  });
  if (!ok) return;
  /* 标记待取消（列表立即隐藏、记录保留供打开笔记页用），返回笔记 id 排队 */
  const res = await deleteFolderUnfav(id);
  const removedIds = (res && res.ids) || [];
  if (state.view === id) {
    state.view = "all";
    state.shown = 60;
  }
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
const aiBarEl = $("#aiBar");
const aiFillEl = aiBarEl.querySelector("i");
const aiListEl = $("#aiList");
const aiToolsEl = $("#aiTools");
const aiStartEl = $("#aiStart");
const aiConfirmEl = $("#aiConfirm");

let aiResults = [];
let aiRunning = false;
let aiCtrl = null;

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

async function openAi(fromMenu = false) {
  const pending = state.notes.filter((n) => !n.folder).length;
  if (!pending) {
    toast("没有未分类的收藏了");
    return;
  }
  const key = await getKey();
  if (!key) {
    openSettings();
    toast("先填 DeepSeek Key", 2600);
    return;
  }
  aiResults = [];
  renderAiList();
  aiToolsEl.hidden = true;
  aiBarEl.classList.remove("on");
  aiFillEl.style.width = "0%";
  aiStartEl.textContent = "开始分析";
  aiConfirmEl.disabled = true;
  aiConfirmEl.textContent = "确认归类";
  const capped = Math.min(pending, MAX_PER_RUN);
  const over = pending - capped;
  const slots = Math.max(0, MAX_FOLDERS - state.folders.length);
  aiDescEl.innerHTML = `有 <b>${pending}</b> 条未分类，本次处理前 <b>${capped}</b> 条。<br>` +
    (over
      ? `余下 <b>${over}</b> 条这一轮先不动，跑完再点一次「重新分析」接着归类。<br>`
      : "") +
    (state.folders.length
      ? `AI 会结合现有文件夹（${state.folders.map((f) => esc(f.name)).join("、")}）规划方案。`
      : `你还没有任何文件夹——AI 会<b>自己创建</b>一套，不用手动建。`) +
    (slots
      ? `缺的文件夹会自动新建（总数不超过 ${MAX_FOLDERS} 个）。`
      : `文件夹已满 ${MAX_FOLDERS} 个，这次只从现有文件夹里选。`) +
    `<br>建议会<b>全部自动勾选</b>，点一次「确认归类」就完成；个别不想动的先勾掉。<b>不会改动小红书</b>。`;
  openChildSheet($("#ai"), fromMenu ? "#menu" : null);
}

async function runAi() {
  const pending = state.notes
    .filter((n) => !n.folder)
    .sort((a, b) => (b.firstSeen || 0) - (a.firstSeen || 0))
    .slice(0, MAX_PER_RUN);
  if (!pending.length) return toast("没有未分类的收藏了");

  aiCtrl = new AbortController();
  aiRunning = true;
  aiResults = [];
  renderAiList();
  aiToolsEl.hidden = true;
  aiConfirmEl.disabled = true;
  aiConfirmEl.textContent = "确认归类";
  aiStartEl.textContent = "停止";
  aiBarEl.classList.add("on");
  aiFillEl.style.width = "0%";
  aiDescEl.textContent = "AI 正在看这批收藏，规划文件夹…";

  try {
    let aiFailed = 0;
    const res = await classify({
      apiKey: await getKey(),
      notes: pending,
      folders: state.folders,
      signal: aiCtrl.signal,
      onProgress: ({ phase, done, total, batch, batches, failed }) => {
        if (phase === "done") {
          aiFailed = failed || 0;
          return;
        }
        aiFillEl.style.width = Math.round((done / Math.max(total, 1)) * 100) + "%";
        aiDescEl.textContent =
          phase === "plan"
            ? `AI 正在看这 ${total} 条收藏，规划文件夹…`
            : `分类中 ${done} / ${total}…` +
              (batches > 1 ? `（第 ${batch} / ${batches} 批）` : "");
      }
    });
    aiResults = res;
    renderAiList();
    const hit = res.filter((r) => r.folderId || r.newFolder).length;
    const fresh = new Set(res.filter((r) => r.newFolder).map((r) => r.newFolder));
    aiFillEl.style.width = "100%";
    aiDescEl.innerHTML =
      `分析完成：${res.length} 条里 <b>${hit}</b> 条给出归属` +
      (fresh.size ? `（新建文件夹：${[...fresh].map(esc).join("、")}）` : "") +
      `。` +
      (aiFailed
        ? `<br>其中 <b>${aiFailed}</b> 条模型没返回结果（超时或返回被截断），可再点一次「重新分析」补上。`
        : "") +
      `<br><b>已全部自动勾选</b>，点「确认归类」一次完成；不想动的先勾掉。`;
    syncAiConfirm();
  } catch (e) {
    aiResults = [];
    renderAiList();
    aiBarEl.classList.remove("on");
    if (e && e.name === "AbortError") {
      aiDescEl.textContent = "已停止，什么都没改。";
    } else {
      const msg = (e && e.message) || String(e);
      aiDescEl.textContent = "出错了：" + msg;
      toast("AI 归类失败：" + msg, 3200);
    }
  } finally {
    aiRunning = false;
    aiCtrl = null;
    aiStartEl.textContent = "重新分析";
  }
}

aiStartEl.addEventListener("click", () => {
  if (aiRunning && aiCtrl) {
    aiCtrl.abort();
    return;
  }
  runAi();
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

/* 默认采 1000 条（旧版是 100）；点菜单的「开始采集」先选条数，选过就记住。
 * 上限 5000 是拍出来的：再大这一屏的收藏页也刷不完，而且滚动太久易掉线。 */
const COLLECT_DEFAULT = 1000;
const COLLECT_MIN = 20;
const COLLECT_MAX = 5000;
const TARGET_STORE = "collectTarget";
let collectTarget = COLLECT_DEFAULT;

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
  $("#targetCustom").value = "";
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
