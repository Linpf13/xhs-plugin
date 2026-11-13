import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import "fake-indexeddb/auto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* 两种布局都支持：公开仓库里 src 在根上（tools/tests → ../../src），
 * 本地开发工作区里扩展在 xhs-fav/ 子目录（→ ../../xhs-fav/src）。 */
const SRC_REPO = path.resolve(HERE, "../../src");
const SRC_DEV = path.resolve(HERE, "../../xhs-fav/src");
const ROOT = fs.existsSync(path.join(SRC_REPO, "panel/panel.html")) ? SRC_REPO : SRC_DEV;
const html = fs.readFileSync(path.join(ROOT, "panel/panel.html"), "utf8").replace(
  /<script[\s\S]*?<\/script>/g,
  ""
);

const dom = new JSDOM(html, { url: "http://localhost/", pretendToBeVisual: true });
const { window } = dom;

global.window = window;
global.document = window.document;
global.Node = window.Node;
global.HTMLElement = window.HTMLElement;
global.MouseEvent = window.MouseEvent;
global.Event = window.Event;
global.Blob = window.Blob;
global.DOMParser = window.DOMParser;


global.URL = window.URL;
let lastBlob = null;
window.URL.createObjectURL = (b) => {
  lastBlob = b;
  return "blob:mock";
};
window.URL.revokeObjectURL = () => {};

let downloads = [];
const origCreate = window.document.createElement.bind(window.document);
window.document.createElement = (tag) => {
  const el = origCreate(tag);
  if (String(tag).toLowerCase() === "a") {
    el.click = () => {
      downloads.push({ name: el.download, href: el.href });
    };
  }
  return el;
};

global.IntersectionObserver = class {
  constructor(cb) {
    this.cb = cb;
  }
  observe() {}
  disconnect() {}
};

/* 测试用的假 Key：不依赖 src/config.local.js（那个文件不进仓库） */
const keyStore = { deepseekKey: "sk-testtesttest1234" };
const tabsSent = [];
let runtimeSent = [];
const runtimeListeners = [];
global.__runtimeListeners = runtimeListeners;
global.chrome = {
  runtime: {
    onMessage: {
      addListener: (fn) => {
        runtimeListeners.push(fn);
        if (!global.__onMsg) global.__onMsg = fn; /* 面板先注册，旧断言直接调它 */
      }
    },
    sendMessage: async (msg) => {
      runtimeSent.push(msg);
      /* 广播给所有上下文的监听器（面板 / 后台 / bridge 各自忽略不相关的类型） */
      for (const fn of [...runtimeListeners]) {
        try {
          fn(msg, {}, () => {});
        } catch (e) {}
      }
      return { ok: true };
    }
  },
  sidePanel: { setPanelBehavior: async () => {} },
  tabs: {
    query: async () => [{ id: 1, url: "https://www.xiaohongshu.com/user/profile/1?tab=fav" }],
    sendMessage: async (tabId, msg) => {
      /* 面板是 sendMessage(tabId, msg)，bridge 自己也用它回响应；两种都收 */
      tabsSent.push(msg && msg.type ? msg : { type: "raw", value: msg });
    },
    update: async (tabId, opts) => {
      /* 模拟真实导航：记下 URL、同步 jsdom location、触发 onUpdated complete */
      global.__lastTabUrl = opts && opts.url;
      try {
        window.history.replaceState({}, "", String(opts.url).replace("https://www.xiaohongshu.com", ""));
      } catch (e) {}
      for (const fn of global.__tabUpdatedListeners || []) {
        try {
          fn(tabId, { status: "complete" });
        } catch (e) {}
      }
      return { id: tabId };
    },
    onUpdated: {
      addListener: (fn) => {
        global.__tabUpdatedListeners = global.__tabUpdatedListeners || [];
        global.__tabUpdatedListeners.push(fn);
      }
    }
  },
  storage: {
    local: {
      get: async (k) => (Object.prototype.hasOwnProperty.call(keyStore, k) ? { [k]: keyStore[k] } : {}),
      set: async (o) => {
        Object.assign(keyStore, o);
      }
    }
  }
};

const results = [];
const ok = (name, cond, extra = "") => {
  results.push({ name, pass: !!cond, extra });
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  -> " + extra : ""));
};

const sleep = (ms) => new Promise((r) => window.setTimeout(r, ms));
const $ = (s) => window.document.querySelector(s);
const $$ = (s) => Array.from(window.document.querySelectorAll(s));

const db = await import("file:///" + path.join(ROOT, "db.js").replace(/\\/g, "/"));
await db.clearAll();

const now = Date.now();
const seed = [
  ["上海咖啡地图｜梧桐区 8 家小店", "一只小满", "9123"],
  ["租房改造｜30㎡ 客厅变书房", "改造日记", "2.1万"],
  ["早八人的 10 分钟通勤妆", "Momo", "4521"],
  ["麻辣拌在家做，比外卖香", "厨房小张", "1.3万"],
  ["川西自驾 7 天路线图", "路上的阿哲", "3.4万"]
].map(([t, a, l], i) => ({
  id: "n" + i,
  title: t,
  author: a,
  liked: l,
  cover: "https://example.com/c" + i + ".jpg",
  xsecToken: "T" + i,
  folder: null,
  note: "",
  firstSeen: now - i * 1000,
  lastSeen: now
}));
await db.saveNotes(seed);
await db.putFolder({ id: "f1", name: "装修灵感", createdAt: 1 });
await db.putFolder({ id: "f2", name: "菜谱", createdAt: 2 });

/* 真正加载面板 */
await import("file:///" + path.join(ROOT, "panel/panel.js").replace(/\\/g, "/"));
await sleep(120);

/* --- 1. 首屏渲染 --- */
ok("加载后列表有条目", $$(".item").length === 5, $$(".item").length + " 条");
ok("计数显示 5 条", $("#count").textContent === "5 条", $("#count").textContent);
ok(
  "chips 含全部/未分类/两个文件夹/新建",
  $$(".chip").length === 5 && $$(".chip")[4].dataset.view === "__new",
  $$(".chip").map((c) => c.textContent.trim()).join(" | ")
);

/* --- 2. 文件夹筛选 --- */
await db.setNotesFolder(["n1"], "f1");
await sleep(1600);
$$(".chip").find((c) => c.dataset.view === "f1").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
ok("筛选文件夹后只剩 1 条", $$(".item").length === 1, $$(".item").length + " 条");
ok("计数跟随筛选", $("#count").textContent === "1 条", $("#count").textContent);

/* --- 3. 搜索（含备注） --- */
$$(".chip").find((c) => c.dataset.view === "all").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const search = $("#search");
search.value = "咖啡";
search.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(60);
ok("搜索「咖啡」命中 1 条", $$(".item").length === 1, $$(".item").length + " 条");
search.value = "";
search.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(60);

/* --- 4. 详情：改文件夹 + 备注 --- */
$$(".item")[2].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
ok("点条目打开详情", $("#detail").classList.contains("on"));
ok("详情标题正确", $("#dTitle").textContent === "早八人的 10 分钟通勤妆", $("#dTitle").textContent);
$("#dFolder").value = "f2";
$("#dNote").value = "周末照着试一次";
$("#dSave").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(200);
const saved = (await db.getAllNotes()).find((n) => n.id === "n2");
ok("文件夹已保存", saved.folder === "f2", String(saved.folder));
ok("备注已保存", saved.note === "周末照着试一次", saved.note);
ok("详情已关闭", !$("#detail").classList.contains("on"));

/* --- 5. 备注可被搜索到 --- */
search.value = "照着试";
search.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(60);
ok("搜索能命中备注", $$(".item").length === 1, $$(".item").length + " 条");
search.value = "";
search.dispatchEvent(new window.Event("input", { bubbles: true }));
await sleep(60);

/* --- 6. 多选 + 批量移动 --- */
$("#btn-select").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
ok("进入多选后操作条出现", $("#selbar").classList.contains("on"));
$$(".item")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
$$(".item")[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
ok("勾选 2 条", $("#selInfo").textContent === "已选 2 条", $("#selInfo").textContent);
$('#selbar button[data-act="move"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(80);
ok("移动弹窗打开且有 3 个选项", $$('#pickBody label').length === 3, $$('#pickBody label').length + " 项");
$$('#pickBody input[value="f1"]')[0].checked = true;
$("#pickOk").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(250);
const moved = await db.getAllNotes();
ok(
  "两条都移到装修灵感",
  moved.filter((n) => n.folder === "f1").length === 2,
  moved.filter((n) => n.folder === "f1").length + " 条"
);

/* --- 7. 导出 CSV --- */
downloads = [];
$("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
ok("菜单打开", $("#menu").classList.contains("on"));
$$('.menu-item').find((b) => b.dataset.menu === "export").dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await sleep(120);
ok("触发下载 1 个文件", downloads.length === 1, JSON.stringify(downloads));
ok("文件名含日期", /^xhs-fav-全部-\d{8}\.csv$/.test(downloads[0] ? downloads[0].name : ""), downloads[0] && downloads[0].name);

const csvText = lastBlob ? await lastBlob.text() : "";
const csvBytes = lastBlob ? new Uint8Array(await lastBlob.arrayBuffer()) : new Uint8Array();
ok(
  "CSV 带 UTF-8 BOM",
  csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csvBytes[2] === 0xbf,
  Array.from(csvBytes.slice(0, 3)).join(",")
);
ok("CSV 表头正确", csvText.includes("标题,作者,点赞,文件夹,备注,链接"));
ok("CSV 含全部 5 行数据", csvText.trim().split("\r\n").length === 6, csvText.trim().split("\r\n").length + " 行");
ok("CSV 备注有内容", csvText.includes("周末照着试一次"));
ok("CSV 链接是小红书地址", csvText.includes("https://www.xiaohongshu.com/explore/n0"));
ok("CSV 备注为空时不写 null", !csvText.includes("null"));

/* --- 8. 新建文件夹 --- */
$$(".chip").find((c) => c.dataset.view === "__new").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(80);
ok("新建文件夹弹窗打开", $("#naming").classList.contains("on"));
$("#namingInput").value = "出行探店";
$("#namingOk").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(250);
const folders = await db.getAllFolders();
ok("文件夹已创建", folders.some((f) => f.name === "出行探店"), folders.map((f) => f.name).join(","));

/* --- 9. 删除文件夹：笔记一起删 + 排队取消收藏 --- */
$("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
$$('.menu-item').find((b) => b.dataset.menu === "folders").dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await sleep(80);
const row = $$(".folder-row").find((r) => r.dataset.id === "f1");
row.querySelector('button[data-op="del"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(80);
ok("删除前有确认弹窗", $("#confirm").classList.contains("on"));
ok(
  "确认文案说明会取消收藏（UI 模拟）",
  /取消收藏/.test($("#confirmBody").textContent) && /笔记页/.test($("#confirmBody").textContent),
  $("#confirmBody").textContent.slice(0, 50)
);
$("#confirmOk").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(450);
const afterDel = await db.getAllNotes();
ok("文件夹已删除", !(await db.getAllFolders()).some((f) => f.id === "f1"));
/* 2026-11-13 UI 模拟语义：笔记记录保留（要拿 token 打开笔记页），
 * 标记 pendingUnfav 从列表隐藏，取消成功后由后台真删 */
ok("笔记记录保留（供打开笔记页用）", afterDel.length === 5, afterDel.length + " 条");
const pend = afterDel.filter((n) => n.pendingUnfav);
ok("文件夹里那两条被标记 pendingUnfav", pend.length === 2 && pend.every((n) => n.id === "n0" || n.id === "n1"), pend.map((n) => n.id).join(","));
ok("pendingUnfav 的 folder 被清空", pend.every((n) => !n.folder));
ok("token 还在（打开笔记页必需）", pend.every((n) => n.xsecToken), pend.map((n) => n.xsecToken).join(","));
ok("其他文件夹归属不受影响", afterDel.some((n) => n.folder === "f2"));
const queueAfterDel = await db.getUnfavQueue();
ok("被删笔记进了取消收藏队列", queueAfterDel.join(",") === "n0,n1", queueAfterDel.join(","));
ok("触发后台同步", runtimeSent.some((m) => m.type === "xhsfav-sync-start"), JSON.stringify(runtimeSent));
ok("toast 提示将逐条取消收藏", /正在取消收藏|逐条取消收藏/.test($("#toast").textContent), $("#toast").textContent.trim().slice(0, 40));
ok("删除后红色进度条出现", $("#syncbar").classList.contains("on"), $("#syncbar").textContent.trim().slice(0, 40));

/* --- 10. 采集完成后出现提示条 --- */
if (global.__onMsg) {
  global.__onMsg({ type: "xhsfav-progress", total: 5, target: 100, done: true, reason: "reached-target" });
  await sleep(200);
  const none = (await db.getAllNotes()).filter((n) => !n.folder && !n.pendingUnfav).length;
  ok("提示条出现（有未分类）", $("#tipbar").classList.contains("on"), "未分类 " + none);
  ok("提示条数字正确", $("#tipbar").textContent.includes(String(none)), $("#tipbar").textContent.trim());
  if ($("#tipGo")) {
    $("#tipGo").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(80);
    ok("点「去整理」进入未分类多选", $("#selbar").classList.contains("on") && $("#count").textContent !== "5 条", $("#count").textContent);
  }
}

/* --- 11. AI 解析的兜底（纯函数，不走网络） --- */
const aiMod = await import("file:///" + path.join(ROOT, "ai.js").replace(/\\/g, "/"));
{
  const folders = [
    { id: "g1", name: "装修灵感" },
    { id: "g2", name: "菜谱" }
  ];
  const notes = [
    { id: "a1", title: "A" },
    { id: "a2", title: "B" }
  ];

  const fenced = aiMod.parseSuggestions(
    '```json\n{"items":[{"i":1,"f":"装修灵感","c":93},{"i":2,"f":"菜谱","c":70}]}\n```',
    notes,
    folders
  );
  ok("解析带 ``` 包裹的 JSON", fenced[0].folderId === "g1" && fenced[1].folderId === "g2");
  ok("置信度三档：93→很确定", fenced[0].tier === "很确定", fenced[0].tier);
  ok("置信度三档：70→可能", fenced[1].tier === "可能", fenced[1].tier);

  const unknown = aiMod.parseSuggestions(
    '{"items":[{"i":1,"f":"学习资料","c":90},{"i":2,"f":null,"c":40}]}',
    notes,
    folders
  );
  ok("不存在的文件夹降级为未分类", unknown[0].folderId === null, String(unknown[0].folderId));
  ok("null 文件夹也是未分类", unknown[1].folderId === null);

  const messy = aiMod.parseSuggestions(
    '{"items":[{"i":1,"f":"《菜谱》","c":120},{"i":99,"f":"菜谱","c":80}]}',
    notes,
    folders
  );
  ok("带书名号的文件夹名能匹配上", messy[0].folderId === "g2", String(messy[0].folderId));
  ok("置信度上限截到 100", messy[0].confidence === 100, String(messy[0].confidence));
  ok("越界序号被忽略，仍输出 2 行", messy.length === 2 && messy[1].folderId === null);

  const garbage = aiMod.parseSuggestions('{"items":[]}', notes, folders);
  ok("模型什么都没给时补成两行未分类", garbage.length === 2 && garbage.every((r) => !r.folderId));

  const newSug = aiMod.parseSuggestions(
    '{"items":[{"i":1,"f":"new:AI学习","c":92},{"i":2,"f":"new: 装修灵感 ","c":80}]}',
    notes,
    folders
  );
  ok("new: 前缀识别为建议新建", newSug[0].newFolder === "AI学习" && newSug[0].folderId === null);
  ok("new: 撞名已有文件夹时直接归进去", newSug[1].folderId === "g1" && newSug[1].newFolder === null, String(newSug[1].folderId));

  let threw = "";
  try {
    aiMod.parseSuggestions("我不知道", notes, folders);
  } catch (e) {
    threw = e.message;
  }
  ok("完全没有 JSON 时抛错（好让面板提示）", !!threw, threw);
}

/* --- 12. AI 归类全流程（fetch 用桩，不花钱） --- */
await db.clearAll();
const aiSeed = [
  ["a1", "租房改造｜30㎡ 客厅变书房", "改造日记"],
  ["a2", "麻辣拌在家做，比外卖香", "厨房小张"],
  ["a3", "雅思 7.5 备考资料清单", "备考的人"]
].map(([id, t, a], i) => ({
  id,
  title: t,
  author: a,
  liked: "1",
  cover: "",
  xsecToken: "T",
  folder: null,
  note: "",
  firstSeen: now + 3000 - i,
  lastSeen: now
}));
await db.saveNotes(aiSeed);
await db.putFolder({ id: "g1", name: "装修灵感", createdAt: 1 });
await db.putFolder({ id: "g2", name: "菜谱", createdAt: 2 });
await sleep(1700);

ok("AI 直接读已存的 Key，不会偷偷改写 storage", keyStore.deepseekKey === "sk-testtesttest1234", String(keyStore.deepseekKey));

let fetchCalls = [];
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  fetchCalls.push({ url, body });
  const isPlan = /设计一套文件夹/.test(body.messages[0].content);
  const content = isPlan
    ? JSON.stringify({ folders: ["装修灵感", "菜谱", "学习资料"] })
    : JSON.stringify({
        items: [
          { i: 1, f: "装修灵感", c: 93 },
          { i: 2, f: "菜谱", c: 70 },
          { i: 3, f: "学习资料", c: 88 }
        ]
      });
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
};

await $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
ok("没跑之前首页没有 AI 进度条", !$("#aiprog").classList.contains("on"));
$$('.menu-item').find((b) => b.dataset.menu === "ai").dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await sleep(80);
ok(
  "点「AI 自动归类」直接开跑，不用再点「开始分析」",
  fetchCalls.length > 0 || $("#aiprog").classList.contains("on"),
  "fetch=" + fetchCalls.length
);
await sleep(400);
ok("跑完自动弹出结果面板", $("#ai").classList.contains("on"));
ok("结果面板的按钮变成「重新分析」", $("#aiStart").textContent === "重新分析", $("#aiStart").textContent);
ok("跑完首页进度条收起", !$("#aiprog").classList.contains("on"));
ok("说明写了这次分析了几条", /3 条里/.test($("#aiDesc").textContent), $("#aiDesc").textContent.slice(0, 40));

ok("结果列出 3 条建议", $$("#aiList .sug").length === 3, $$("#aiList .sug").length + " 条");
ok(
  "三条全部默认勾选（AI 规划的新文件夹也算）",
  $$('#aiList input[type="checkbox"]').filter((c) => c.checked).length === 3,
  String($$('#aiList input[type="checkbox"]').filter((c) => c.checked).length)
);
ok("确认按钮显示条数", /确认归类 3 条/.test($("#aiConfirm").textContent), $("#aiConfirm").textContent);

$("#aiConfirm").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(350);
const aiDone = await db.getAllNotes();
const byId = (id) => aiDone.find((n) => n.id === id) || {};
ok("第 1 条归到装修灵感", byId("a1").folder === "g1", String(byId("a1").folder));
ok("第 2 条归到菜谱", byId("a2").folder === "g2", String(byId("a2").folder));
const studyFolder = (await db.getAllFolders()).find((f) => f.name === "学习资料");
ok("AI 规划的新文件夹被自动创建", !!studyFolder, JSON.stringify((await db.getAllFolders()).map((f) => f.name)));
ok("第 3 条归进了 AI 新建的文件夹", !!studyFolder && byId("a3").folder === studyFolder.id, String(byId("a3").folder));
ok("归类后面板关闭", !$("#ai").classList.contains("on"));

/* --- 13. 出错要能看懂 --- */
await db.saveNotes([
  { id: "err1", title: "随便一条凑数的", author: "人", liked: "1", cover: "", xsecToken: "T", folder: null, note: "", firstSeen: now + 5000, lastSeen: now }
]);
await sleep(1700);
global.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });
await $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
$$('.menu-item').find((b) => b.dataset.menu === "ai").dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await sleep(450);
ok("401 会说 Key 无效", /Key 无效/.test($("#toast").textContent), $("#toast").textContent.trim());
ok(
  "出错时不弹结果面板、不勾选任何条目",
  !$("#ai").classList.contains("on") &&
    $$('#aiList input[type="checkbox"]').filter((c) => c.checked).length === 0
);
ok("出错后首页进度条收起", !$("#aiprog").classList.contains("on"));

/* --- 14. 设置里能改 Key --- */
await $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
$$('.menu-item').find((b) => b.dataset.menu === "settings").dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await sleep(120);
ok("设置面板打开并带出当前 Key", $("#settings").classList.contains("on") && /^sk-/.test($("#keyInput").value));
$("#keyInput").value = "随便写的";
$("#keySave").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(80);
ok("格式不对的 Key 被拒绝（storage 原样不动）", keyStore.deepseekKey === "sk-testtesttest1234", JSON.stringify(keyStore));
$("#keyInput").value = "sk-abcdefghijklmnopqrstuvwx";
$("#keySave").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(80);
ok("合法 Key 已写入 storage", keyStore.deepseekKey === "sk-abcdefghijklmnopqrstuvwx", String(keyStore.deepseekKey));

/* --- 15. AI 建议新建文件夹：确认后才创建 --- */
await db.clearAll();
await db.saveNotes([
  {
    id: "b1",
    title: "RAG 知识库搭建实操，把理论用案例演示",
    author: "技术号",
    liked: "1",
    cover: "",
    xsecToken: "T",
    folder: null,
    note: "",
    firstSeen: now + 9000,
    lastSeen: now
  }
]);
await db.putFolder({ id: "g9", name: "职场成长", createdAt: 9 });
await sleep(1700);

const section15Calls = [];
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  section15Calls.push(body);
  const isPlan = /设计一套文件夹/.test(body.messages[0].content);
  const content = isPlan
    ? JSON.stringify({ folders: ["职场成长", "AI学习"] })
    : JSON.stringify({ items: [{ i: 1, f: "new:AI学习", c: 92 }] });
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
};

await $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
$$('.menu-item').find((b) => b.dataset.menu === "ai").dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await sleep(450);
ok(
  "规划请求里带着现有文件夹（AI 才知道该复用哪些）",
  section15Calls.length > 0 && /职场成长/.test(section15Calls[0].messages[1].content),
  (section15Calls[0] || { messages: [{}, { content: "" }] }).messages[1].content.slice(0, 40)
);
ok(
  "建议行写着新建文件夹名",
  /新建文件夹「AI学习」/.test($("#aiList").textContent),
  $("#aiList").textContent.trim().slice(-30)
);
ok(
  "新建建议默认勾选且可勾",
  $$('#aiList input[type="checkbox"]')[0].checked === true && $$('#aiList input[type="checkbox"]')[0].disabled === false
);
ok("确认按钮显示 1 条", /确认归类 1 条/.test($("#aiConfirm").textContent), $("#aiConfirm").textContent);

$("#aiConfirm").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(350);
const createdFolder = (await db.getAllFolders()).find((f) => f.name === "AI学习");
ok("确认后文件夹真的创建了", !!createdFolder, JSON.stringify((await db.getAllFolders()).map((f) => f.name)));
const b1 = (await db.getAllNotes()).find((n) => n.id === "b1");
ok("笔记归进了新建的文件夹", !!createdFolder && b1.folder === createdFolder.id, String(b1.folder));

/* --- 16. 文件夹上限 10 个 --- */
const cfg = await import("file:///" + path.join(ROOT, "config.js").replace(/\\/g, "/"));
ok("上限常量是 10", cfg.MAX_FOLDERS === 10, String(cfg.MAX_FOLDERS));

{
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: "x" + i, name: "夹" + i }));
  const nine = ten.slice(0, 9);
  const mk = (id, nf) => ({ id, title: id, folderId: null, folderName: "", newFolder: nf, confidence: 90, tier: "很确定" });

  const atTen = aiMod.capNewFolders([mk("r1", "AI学习"), mk("r2", null)], ten);
  ok("已满 10 个时新建建议被降级", atTen[0].newFolder === null && atTen[0].confidence === 0, JSON.stringify(atTen[0]));

  const twoNames = aiMod.capNewFolders(
    [mk("r1", "AI学习"), mk("r2", "AI学习"), mk("r3", "职场干货"), mk("r4", "副业思路")],
    nine
  );
  ok("只剩 1 个余量时只留第一个新名字", twoNames[0].newFolder === "AI学习" && twoNames[1].newFolder === "AI学习");
  ok("后面的新名字被降级", twoNames[2].newFolder === null && twoNames[3].newFolder === null, [twoNames[2].newFolder, twoNames[3].newFolder].join(","));
  ok("降级行置信度归零", twoNames[2].confidence === 0, String(twoNames[2].confidence));

  const noNew = aiMod.capNewFolders([mk("r1", null)], ten);
  ok("本来就没有新建建议的不受影响", noNew[0].newFolder === null);
}

/* --- AI 自主规划：parsePlan 纯函数 --- */
{
  const reused = aiMod.parsePlan(
    '{"folders":["装修灵感","新家软装","装修灵感"]}',
    [{ id: "g1", name: "装修灵感" }]
  );
  ok("规划剔除已有名字并去重", reused.length === 1 && reused[0] === "新家软装", JSON.stringify(reused));

  const capped = aiMod.parsePlan(
    '{"folders":["a","b","c","d"]}',
    Array.from({ length: 8 }, (_, i) => ({ id: "y" + i, name: "夹" + i }))
  );
  ok("规划尊重 10 个上限（8 现有只留 2 个新的）", capped.length === 2, JSON.stringify(capped));

  const fromZero = aiMod.parsePlan('["美食探店","周末旅行"]', []);
  ok("从零开始也能拿到方案", fromZero.length === 2, JSON.stringify(fromZero));

  const junk = aiMod.parsePlan("我不输出 JSON", []);
  ok("规划解析失败返回空数组不抛错", Array.isArray(junk) && junk.length === 0, JSON.stringify(junk));

  const decorated = aiMod.parsePlan('{"folders":["「AI学习」","学习资料"]}', []);
  ok("规划剥掉装饰字符", decorated[0] === "AI学习", JSON.stringify(decorated));
}

/* --- AI 从零建文件夹：一个现有文件夹都没有也能跑 --- */
await db.clearAll();
await db.saveNotes([
  { id: "z9", title: "面包烘焙入门：欧包练起来", author: "面包师", liked: "1", cover: "", xsecToken: "T", folder: null, note: "", firstSeen: now + 21000, lastSeen: now }
]);
await sleep(1700);
global.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  const isPlan = /设计一套文件夹/.test(body.messages[0].content);
  const content = isPlan
    ? JSON.stringify({ folders: ["烘焙美食"] })
    : JSON.stringify({ items: [{ i: 1, f: "烘焙美食", c: 95 }] });
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
};
await $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
$$('.menu-item').find((b) => b.dataset.menu === "ai").dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await sleep(450);
ok("一个文件夹都没有也能直接跑（不再要求先手动建）", $("#ai").classList.contains("on"));
ok(
  "建议行是新文件夹",
  /新建文件夹「烘焙美食」/.test($("#aiList").textContent),
  $("#aiList").textContent.trim().slice(-30)
);
ok("新文件夹默认勾选", $$('#aiList input[type="checkbox"]')[0].checked === true);

$("#aiConfirm").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(350);
const bakedFolder = (await db.getAllFolders()).find((f) => f.name === "烘焙美食");
ok("确认后文件夹真的建出来了", !!bakedFolder, JSON.stringify((await db.getAllFolders()).map((f) => f.name)));
const z9 = (await db.getAllNotes()).find((n) => n.id === "z9");
ok("笔记归进了 AI 自建的文件夹", !!bakedFolder && z9.folder === bakedFolder.id, String(z9.folder));

/* 面板：已满 10 个时点「＋ 新建」被拦 */
await db.clearAll();
for (let i = 0; i < 10; i++) {
  await db.putFolder({ id: "cap" + i, name: "上限夹" + i, createdAt: i });
}
await db.saveNotes([
  { id: "c1", title: "随便一条", author: "人", liked: "1", cover: "", xsecToken: "T", folder: null, note: "", firstSeen: now + 20000, lastSeen: now }
]);
await sleep(1700);

$$(".chip").find((c) => c.dataset.view === "__new").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(120);
ok("满 10 个时点新建不弹输入框", !$("#naming").classList.contains("on"));
ok("满 10 个时给出 toast 提示", /10 个文件夹/.test($("#toast").textContent), $("#toast").textContent.trim().slice(0, 30));
ok("文件夹仍是 10 个", (await db.getAllFolders()).length === 10);

/* AI 在满额时也不再给新建建议 */
global.fetch = async () => {
  const content = JSON.stringify({ items: [{ i: 1, f: "new:AI学习", c: 95 }] });
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
};
await $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
$$('.menu-item').find((b) => b.dataset.menu === "ai").dispatchEvent(
  new window.MouseEvent("click", { bubbles: true })
);
await sleep(450);
ok("满额时新建建议被降级为无建议", $$('#aiList input[type="checkbox"]')[0].disabled === true, $("#aiList").textContent.trim().slice(0, 40));
if ($("#ai").classList.contains("on")) $("#aiBack").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
ok("确认后文件夹个数没变", (await db.getAllFolders()).length === 10);

/* --- 17. 页面侧 UI 取消收藏执行器（inject.js 真代码，jsdom 模拟笔记页） --- */
{
  global.XMLHttpRequest = window.XMLHttpRequest;

  /* 页面自己的 uncollect 请求桩：inject 的 send 包装会挂 load 监听，
   * 这里模拟「点击后页面发请求、20ms 后返回」。响应内容由 __uncollectResp 控制。 */
  window.__uncollectResp = { status: 200, body: JSON.stringify({ code: 0, success: true, msg: "成功" }) };
  const origSend = window.XMLHttpRequest.prototype.send;
  window.XMLHttpRequest.prototype.send = function (b) {
    const self = this;
    if (/uncollect/.test(String(self.__xhsfav_url))) {
      setTimeout(() => {
        Object.defineProperty(self, "status", { value: window.__uncollectResp.status });
        Object.defineProperty(self, "responseText", { value: window.__uncollectResp.body });
        self.dispatchEvent(new window.Event("load"));
      }, 20);
      return;
    }
    return origSend.apply(this, arguments);
  };

  const posted = [];
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m && m.source === "xhsfav" && (m.type === "ui-result" || m.type === "ui-run-done")) {
      posted.push(m);
    }
  });

  await import("file:///" + path.join(ROOT, "inject.js").replace(/\\/g, "/"));

  /* 1) 不在笔记页 → 不点击，要求导航（带 token/uid 才给导航） */
  window.__navUrl = null;
  window.__xhsfavNav = (u) => {
    window.__navUrl = String(u);
  };
  const navProbe = await window.__xhsfavHooks.uiUncollect("note1", "TOK1", "UID1").then((r) => r, (r) => r);
  ok("不在笔记页时要求先导航", navProbe && navProbe.navigated === true && navProbe.ok === false, JSON.stringify(navProbe));
  ok(
    "导航 URL 用 uid + id + xsec_token 拼装",
    /xiaohongshu\.com\/user\/profile\/UID1\/note1\?xsec_token=TOK1/.test(window.__navUrl || ""),
    window.__navUrl || "(null)"
  );

  /* 缺 token/uid 时不导航，直接报错 */
  const noTok = await window.__xhsfavHooks.uiUncollect("noteX", "", "").then((r) => r, (r) => r);
  ok("缺 token/uid 给可读错误", noTok && noTok.ok === false && /token/.test(noTok.error), JSON.stringify(noTok));

  /* 2) 在笔记页但互动栏没出现 → 超时报可读错误（把等待压短） */
  window.__xhsfavWaitMax = 400;
  window.history.replaceState({}, "", "/user/profile/U/noteY?xsec_token=T&xsec_source=");
  const noBtn = await window.__xhsfavHooks.uiUncollect("noteY", "T", "U").then((r) => r, (r) => r);
  ok("页面没收藏按钮时给可读错误", noBtn && noBtn.ok === false && /收藏按钮/.test(noBtn.error), JSON.stringify(noBtn));
  window.__xhsfavWaitMax = 15000;

  /* 3) 完整成功流：模拟笔记页 DOM（挂在 body 外，避免砸掉面板 DOM）→ 已收藏 → JS 点击 → 页面自己发请求 → code 0 */
  const fakeWrap = document.createElement("div");
  fakeWrap.innerHTML =
    '<span class="collect-wrapper"><svg><use href="/x.svg#collected"></use></svg></span>';
  document.documentElement.appendChild(fakeWrap);
  window.history.replaceState({}, "", "/user/profile/U/noteZ?xsec_token=T&xsec_source=");
  let clicks = 0;
  const cw = document.querySelector(".collect-wrapper");
  cw.addEventListener("click", () => {
    clicks++;
    /* 模拟页面响应点击：发 uncollect 请求（经 inject 包装挂监听）+ 图标切换 */
    const x = new window.XMLHttpRequest();
    x.open("POST", "https://edith.xiaohongshu.com/api/sns/web/v1/note/uncollect");
    x.send("{}");
    cw.querySelector("use").setAttribute("href", "/x.svg#collect");
  });

  const okRes = await window.__xhsfavHooks.uiUncollect("noteZ", "T", "U").then((r) => r, (r) => r);
  ok("已收藏状态会点击收藏按钮", clicks === 1, String(clicks));
  ok("页面请求 code 0 → 成功", okRes && okRes.ok === true, JSON.stringify(okRes));

  /* 4) 本来就是未收藏：不点击直接视为完成 */
  clicks = 0;
  cw.querySelector("use").setAttribute("href", "/x.svg#collect");
  const already = await window.__xhsfavHooks.uiUncollect("noteZ", "T", "U").then((r) => r, (r) => r);
  ok("未收藏状态不点击", clicks === 0, String(clicks));
  ok("未收藏视为已完成", already && already.ok === true && already.already === true, JSON.stringify(already));

  /* 5) 页面请求失败（code 非 0）→ 失败回报 */
  clicks = 0;
  cw.querySelector("use").setAttribute("href", "/x.svg#collected");
  cw.addEventListener("click", function onFail() {
    clicks++;
    window.__uncollectResp = { status: 200, body: JSON.stringify({ code: -1000, success: false, msg: "参数错误" }) };
    const x = new window.XMLHttpRequest();
    x.open("POST", "https://edith.xiaohongshu.com/api/sns/web/v1/note/uncollect");
    x.send("{}");
    cw.removeEventListener("click", onFail);
  });
  const failRes = await window.__xhsfavHooks.uiUncollect("noteZ", "T", "U").then((r) => r, (r) => r);
  ok("页面请求失败时如实回报", failRes && failRes.ok === false && /-1000/.test(failRes.error), JSON.stringify(failRes));
  window.__uncollectResp = { status: 200, body: JSON.stringify({ code: 0, success: true, msg: "成功" }) };

  /* 6) bridge 指令路径：postMessage ui-uncollect → inject 执行 → ui-result 回报 */
  window.__uncollectResp = { status: 200, body: JSON.stringify({ code: 0, success: true, msg: "成功" }) };
  cw.querySelector("use").setAttribute("href", "/x.svg#collected");
  window.postMessage(
    { source: "xhsfav-bridge", type: "ui-uncollect", id: "noteZ", token: "T", uid: "U" },
    window.location.origin
  );
  await sleep(300);
  ok(
    "bridge 指令驱动点击并回报 ui-result",
    posted.some((m) => m.type === "ui-result" && m.payload && m.payload.ok) &&
      posted.some((m) => m.type === "ui-run-done"),
    JSON.stringify(posted.map((m) => m.type))
  );
  if (fakeWrap.parentNode) fakeWrap.remove();
  window.history.replaceState({}, "", "/user/profile/1?tab=fav");
}

/* --- 18. 菜单「同步取消收藏」与进度显示 --- */
{
  runtimeSent = [];
  await db.setUnfavQueue([]);
  $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  const syncItem = $$('.menu-item').find((b) => b.dataset.menu === "sync");
  ok("菜单里有同步入口", !!syncItem);
  syncItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(120);
  ok("空队列点同步给出提示", /没有待取消收藏/.test($("#toast").textContent), $("#toast").textContent.trim().slice(0, 30));

  await db.setUnfavQueue(["z1", "z2"]);
  runtimeSent = [];
  $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  $$('.menu-item').find((b) => b.dataset.menu === "sync").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(120);
  ok("有队列时触发后台同步", runtimeSent.some((m) => m.type === "xhsfav-sync-start"), JSON.stringify(runtimeSent));

  global.__onMsg({ type: "xhsfav-uncollect-progress", done: 3, total: 10, remaining: 7 });
  ok("状态行显示同步进度", /取消收藏中 3 \/ 10/.test($("#status").textContent), $("#status").textContent);

  global.__onMsg({
    type: "xhsfav-uncollect-progress",
    done: 3,
    total: 10,
    finished: true,
    error: "取消收藏失败：HTTP 461 当前账号存在异常",
    remaining: 7
  });
  ok("失败时状态行说明已停止", /停止/.test($("#status").textContent) && /461/.test($("#status").textContent), $("#status").textContent.slice(0, 60));

  global.__onMsg({ type: "xhsfav-uncollect-progress", done: 10, total: 10, finished: true, remaining: 0 });
  ok("全部完成时状态行收尾", /全部完成/.test($("#status").textContent), $("#status").textContent);
}

/* --- 19. 全链路集成：面板 → 后台导航 → bridge → inject UI 点击 → 出队 --- */
{
  await db.clearAll();
  await db.saveNotes([
    { id: "d1", title: "删除同步1", author: "a", liked: "1", cover: "", xsecToken: "T", folder: null, note: "", firstSeen: now + 30000, lastSeen: now },
    { id: "d2", title: "删除同步2", author: "a", liked: "1", cover: "", xsecToken: "T", folder: null, note: "", firstSeen: now + 29000, lastSeen: now }
  ]);
  await db.setMeta("ownerUid", "UIDX");
  await db.setUnfavQueue(["d1", "d2"]);
  await sleep(300);

  /* 测试节奏压短；请求桩复位为成功 */
  globalThis.__xhsfavUiPace = 5;
  globalThis.__xhsfavUiMount = 5;
  window.__uncollectResp = { status: 200, body: JSON.stringify({ code: 0, success: true, msg: "成功" }) };

  /* 模拟笔记页 DOM：collect-wrapper + 点击后发请求并切图标（17 节的 send 桩还在）
   * 同样挂在 body 外，避免砸掉面板 DOM */
  const fakeWrap19 = document.createElement("div");
  fakeWrap19.innerHTML =
    '<span class="collect-wrapper"><svg><use href="/x.svg#collected"></use></svg></span>';
  document.documentElement.appendChild(fakeWrap19);
  const cw19 = document.querySelector(".collect-wrapper");
  cw19.addEventListener("click", () => {
    const x = new window.XMLHttpRequest();
    x.open("POST", "https://edith.xiaohongshu.com/api/sns/web/v1/note/uncollect");
    x.send("{}");
    cw19.querySelector("use").setAttribute("href", "/x.svg#collect");
    /* 下一条开始前把图标复位成已收藏（每条都是独立页面） */
    setTimeout(() => cw19.querySelector("use").setAttribute("href", "/x.svg#collected"), 50);
  });

  /* 后台与 bridge 在真实环境是独立上下文；这里同一窗口 + 手动路由模拟 */
  await import("file:///" + path.join(ROOT, "background.js").replace(/\\/g, "/"));
  const preBridge = global.__runtimeListeners.length;
  await import("file:///" + path.join(ROOT, "bridge.js").replace(/\\/g, "/"));
  const bridgeListeners = global.__runtimeListeners.slice(preBridge);
  global.__bridgeListeners = bridgeListeners;

  /* tabs 消息路由给 bridge；window 消息用 shim 派发
   * （jsdom 的 postMessage source 语义与 Chrome 不一致，路由语义手动补齐） */
  global.chrome.tabs.sendMessage = async (tabId, msg) => {
    let resp;
    for (const fn of [...bridgeListeners]) {
      try {
        fn(msg, {}, (r) => {
          resp = r;
        });
      } catch (e) {}
    }
    return resp;
  };
  const origPostMessage = window.postMessage.bind(window);
  window.postMessage = (m, o) => {
    if (m && m.source === "xhsfav-bridge") {
      if (m.type === "ui-uncollect" && window.__xhsfavHooks) {
        window.__xhsfavHooks.uiUncollect(m.id, m.token, m.uid).then((r) => {
          window.postMessage({ source: "xhsfav", type: "ui-result", payload: r }, window.location.origin);
          window.postMessage({ source: "xhsfav", type: "ui-run-done", payload: {} }, window.location.origin);
        });
      }
      return;
    }
    if (m && m.source === "xhsfav" && window.__xhsfavBridgeTest) {
      window.__xhsfavBridgeTest.onPageMessage({ source: window, data: m });
      return;
    }
    return origPostMessage(m, o);
  };

  const tabUrls = [];
  const origUpdate = global.chrome.tabs.update;
  global.chrome.tabs.update = async (tabId, opts) => {
    tabUrls.push(String(opts.url));
    return origUpdate(tabId, opts);
  };

  runtimeSent = [];
  await global.chrome.runtime.sendMessage({ type: "xhsfav-sync-start" });
  await sleep(900);

  ok(
    "逐条导航到带 token 的笔记页",
    tabUrls.length >= 2 &&
      /user\/profile\/UIDX\/d1\?xsec_token=T/.test(tabUrls[0]) &&
      /user\/profile\/UIDX\/d2\?xsec_token=T/.test(tabUrls[1]),
    tabUrls.join(" | ")
  );
  ok("成功后本地记录真删（d1、d2 都没了）", !(await db.getNote("d1")) && !(await db.getNote("d2")), JSON.stringify(await db.getAllNotes()));
  ok("成功一条出队一条，队列清空", (await db.getUnfavQueue()).length === 0, JSON.stringify(await db.getUnfavQueue()));
  ok("状态行报告全部完成", /全部完成/.test($("#status").textContent), $("#status").textContent);

  /* 失败熔断：页面请求 code 非 0 → 停止、队列保留、本地记录保留 */
  window.__uncollectResp = { status: 200, body: JSON.stringify({ code: -100, success: false, msg: "异常" }) };
  await db.saveNotes([
    { id: "e1", title: "e1", author: "a", liked: "1", cover: "", xsecToken: "T", folder: null, note: "", firstSeen: now + 40000, lastSeen: now },
    { id: "e2", title: "e2", author: "a", liked: "1", cover: "", xsecToken: "T", folder: null, note: "", firstSeen: now + 39000, lastSeen: now }
  ]);
  await db.setUnfavQueue(["e1", "e2"]);
  await sleep(100);
  await global.chrome.runtime.sendMessage({ type: "xhsfav-sync-start" });
  await sleep(600);
  ok("失败时状态行如实报错", /停止/.test($("#status").textContent) && /-100/.test($("#status").textContent), $("#status").textContent.slice(0, 80));
  ok("失败后队列原样保留", (await db.getUnfavQueue()).join(",") === "e1,e2", (await db.getUnfavQueue()).join(","));
  ok("失败后本地记录保留（token 还能用）", !!(await db.getNote("e1")), String(!!(await db.getNote("e1"))));
  window.__uncollectResp = { status: 200, body: JSON.stringify({ code: 0, success: true, msg: "成功" }) };

  /* 过期队列容错：库里根本没有的 id → 自动跳过，不熔断 */
  await db.setUnfavQueue(["ghost1", "e1"]);
  await sleep(100);
  await global.chrome.runtime.sendMessage({ type: "xhsfav-sync-start" });
  await sleep(600);
  ok("幽灵 id 被自动跳过", (await db.getUnfavQueue()).join(",") === "e1" || (await db.getUnfavQueue()).length === 0, JSON.stringify(await db.getUnfavQueue()));
  await db.setUnfavQueue([]);

  /* 跑完要回「开始前的页面」：小红书取消收藏后会自己跳首页，不能把人丢在那儿 */
  ok(
    "跑完导航回开始前的收藏页",
    tabUrls.filter((u) => /user\/profile\/1\?tab=fav/.test(u)).length >= 1,
    tabUrls.slice(-3).join(" | ")
  );

  /* 起点本来就是笔记详情页时不乱跳 */
  await db.saveNotes([
    { id: "f1abcdef1234", title: "f1", author: "a", liked: "1", cover: "", xsecToken: "T", folder: null, note: "", firstSeen: now + 50000, lastSeen: now }
  ]);
  await db.setUnfavQueue(["f1abcdef1234"]);
  const origQuery = global.chrome.tabs.query;
  global.chrome.tabs.query = async () => [
    { id: 1, url: "https://www.xiaohongshu.com/explore/f1abcdef1234?xsec_token=T" }
  ];
  tabUrls.length = 0;
  await sleep(100);
  await global.chrome.runtime.sendMessage({ type: "xhsfav-sync-start" });
  await sleep(700);
  global.chrome.tabs.query = origQuery;
  ok(
    "起点是笔记详情页时不回跳（只导航到笔记页本身）",
    tabUrls.length >= 1 && tabUrls.every((u) => /f1abcdef1234/.test(u)),
    tabUrls.join(" | ")
  );
  await db.setUnfavQueue([]);
  if (fakeWrap19.parentNode) fakeWrap19.remove();
  window.postMessage = origPostMessage;
  global.chrome.tabs.update = origUpdate;
}

/* --- 20. 未点「开始采集」时滚动不写库；点采集时补录缓冲 --- */
{
  await db.clearAll();
  const before = (await db.getAllNotes()).length;
  const pageMsg = (ids) =>
    window.__xhsfavBridgeTest.onPageMessage({
      source: window,
      data: {
        source: "xhsfav",
        type: "collect-page",
        payload: {
          data: {
            notes: ids.map((id) => ({ note_id: id, display_title: "被动" + id, user: { nickname: "n" } })),
            has_more: true
          }
        }
      }
    });

  runtimeSent = [];
  pageMsg(["p1", "p2"]);
  pageMsg(["p3"]);
  await sleep(100);
  ok("未采集时滚动不写库", (await db.getAllNotes()).length === before, (await db.getAllNotes()).length + " 条");
  ok("未采集时也不发给后台", !runtimeSent.some((m) => m.type === "collect-page"), JSON.stringify(runtimeSent));

  /* 点开始采集 → 缓冲补录 */
  runtimeSent = [];
  let startResp;
  global.__bridgeListeners[0]({ type: "xhsfav-start", target: 10 }, {}, (r) => {
    startResp = r;
  });
  await sleep(150);
  ok("点采集后缓冲被补录入库", (await db.getAllNotes()).length === before + 3, (await db.getAllNotes()).length + " 条");
  ok("补录走了后台保存通道", runtimeSent.some((m) => m.type === "collect-page"));
  ok("start 有响应", startResp && startResp.ok === true && startResp.target === 10);

  /* 采集中新页立即写库 */
  pageMsg(["p4"]);
  await sleep(100);
  ok("采集中新页立即写库", (await db.getAllNotes()).length === before + 4, (await db.getAllNotes()).length + " 条");

  /* 停止后又回到只缓冲不写库 */
  global.__bridgeListeners[0]({ type: "xhsfav-stop" }, {}, () => {});
  pageMsg(["p5"]);
  await sleep(100);
  ok("停止后又回到只缓冲", (await db.getAllNotes()).length === before + 4, (await db.getAllNotes()).length + " 条");

  await db.clearAll();
}

/* --- 21. 取消收藏：红色进度条 + 详情页单条 + 多选批量 --- */
{
  /* 第 10 节点过「去整理」，多选状态可能残留，先退出 */
  if (window.document.body.classList.contains("picking")) {
    $("#btn-select").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(80);
  }
  /* 断掉后台→页面的执行链（本轮只测面板行为），队列保持原样可断言 */
  global.chrome.tabs.sendMessage = async () => undefined;
  await db.clearAll();
  await db.setUnfavQueue([]);
  await db.saveNotes([
    { id: "u1", title: "单条取消收藏", author: "a", liked: "1", cover: "", xsecToken: "T", folder: null, note: "", firstSeen: now + 40000, lastSeen: now },
    { id: "u2", title: "批量取消1", author: "a", liked: "1", cover: "", xsecToken: "T", folder: null, note: "", firstSeen: now + 39000, lastSeen: now },
    { id: "u3", title: "批量取消2", author: "a", liked: "1", cover: "", xsecToken: "T", folder: null, note: "", firstSeen: now + 38000, lastSeen: now }
  ]);
  await sleep(1700);

  /* 单条：点开帖子 →「取消收藏」 */
  $$("#list .item")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  ok("详情页有取消收藏按钮", !!$("#dUnfav"));
  $("#dUnfav").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(100);
  ok("单条取消收藏有确认弹窗", $("#confirm").classList.contains("on"));
  $("#confirmOk").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(400);
  /* UI 模拟语义：先隐藏（pendingUnfav），取消成功后才由后台真删 */
  const u1note = await db.getNote("u1");
  ok("笔记先隐藏（pendingUnfav）", u1note && u1note.pendingUnfav === true, JSON.stringify(u1note && u1note.pendingUnfav));
  ok("token 保留（打开笔记页用）", u1note && u1note.xsecToken === "T");
  ok("id 进了待取消队列", (await db.getUnfavQueue()).includes("u1"), (await db.getUnfavQueue()).join(","));
  ok("发出了同步指令", runtimeSent.some((m) => m.type === "xhsfav-sync-start"));
  ok(
    "红色进度条出现",
    $("#syncbar").classList.contains("on") && /取消收藏/.test($("#syncbar").textContent),
    $("#syncbar").textContent.trim().slice(0, 50)
  );

  /* 进度推进：进行中态，进度条数字与宽度 */
  global.__onMsg({ type: "xhsfav-uncollect-progress", done: 1, total: 3, remaining: 2 });
  ok(
    "进行中显示 x/y 和剩余",
    /正在同步取消收藏到小红书/.test($("#syncbar").textContent) && /1 \/ 3/.test($("#syncbar").textContent) && /剩 2 条/.test($("#syncbar").textContent),
    $("#syncbar").textContent.trim().slice(0, 60)
  );
  ok("进度条宽度按比例", $("#syncbar .bar i") && $("#syncbar .bar i").style.width === "33%", ($("#syncbar .bar i") || {}).style ? $("#syncbar .bar i").style.width : "无进度条");

  /* 完成态 */
  global.__onMsg({ type: "xhsfav-uncollect-progress", done: 3, total: 3, remaining: 0, finished: true });
  ok("完成态进度条", /取消收藏完成/.test($("#syncbar").textContent), $("#syncbar").textContent.trim().slice(0, 40));

  /* 暂停态：剩 N 条，给续跑按钮 */
  global.__onMsg({ type: "xhsfav-uncollect-progress", done: 2, total: 4, remaining: 2, finished: true });
  ok("暂停态显示剩余条数", /还有 2 条待取消收藏/.test($("#syncbar").textContent), $("#syncbar").textContent.trim().slice(0, 40));
  ok("暂停态有续跑按钮", !!$("#syncGo"));

  /* 失败态：错误上条，可关闭 */
  global.__onMsg({ type: "xhsfav-uncollect-progress", done: 2, total: 4, remaining: 2, finished: true, error: "取消收藏失败：HTTP 461 账号异常" });
  ok("失败态显示错误", /461/.test($("#syncbar").textContent), $("#syncbar").textContent.trim().slice(0, 60));
  $("#syncClose").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  ok("错误条可以关闭", !$("#syncbar").classList.contains("on"));

  /* 批量：多选 → 底栏「取消收藏」 */
  runtimeSent = [];
  await db.setUnfavQueue([]);
  await db.clearAll();
  await db.saveNotes([
    { id: "u2", title: "批量取消1", author: "a", liked: "1", cover: "", xsecToken: "T", folder: null, note: "", firstSeen: now + 39000, lastSeen: now },
    { id: "u3", title: "批量取消2", author: "a", liked: "1", cover: "", xsecToken: "T", folder: null, note: "", firstSeen: now + 38000, lastSeen: now }
  ]);
  await sleep(600);
  $("#btn-select").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const items = $$("#list .item");
  items[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  items[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  ok("多选栏有取消收藏按钮", !!$('button[data-act="unfav"]'));
  $$('button[data-act="unfav"]')[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(100);
  ok("批量取消收藏有确认弹窗", $("#confirm").classList.contains("on"));
  $("#confirmOk").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(400);
  const left21 = (await db.getAllNotes()).filter((n) => n.pendingUnfav);
  ok("两条都标记 pendingUnfav", left21.length === 2, left21.length + " 条");
  const q21 = await db.getUnfavQueue();
  ok("两条都进队列", q21.includes("u2") && q21.includes("u3"), q21.join(","));
  ok("批量也触发同步指令", runtimeSent.some((m) => m.type === "xhsfav-sync-start"));
  ok("批量后进度条出现", $("#syncbar").classList.contains("on"));

  await db.setUnfavQueue([]);
  await db.clearAll();
}

/* --- 22. 面板小修：更多操作返回 / 全选 / 移动弹窗排版 / 未分类多时直接 AI --- */
{
  await db.clearAll();
  await db.setUnfavQueue([]);
  await db.putFolder({ id: "pf1", name: "装修灵感", createdAt: 1 });
  const many = Array.from({ length: 12 }, (_, i) => ({
    id: "m" + i,
    title: "未分类帖子" + i,
    author: "a",
    liked: "1",
    cover: "",
    xsecToken: "T",
    folder: null,
    note: "",
    firstSeen: now + 90000 - i,
    lastSeen: now
  }));
  await db.saveNotes(many);
  await sleep(1700);

  /* ①「更多操作」面板要有返回，不然只能点空白处 */
  $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  ok("更多操作面板打开", $("#menu").classList.contains("on"));
  ok("更多操作面板有返回按钮", !!$("#menuBack"));
  $("#menuBack").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  ok(
    "返回按钮能关掉更多操作面板",
    !$("#menu").classList.contains("on") && !$("#scrim").classList.contains("on")
  );

  /* ①b 返回键一律是「‹」角标，不出现「返回」两个字 */
  const backIds = ["detailBack", "menuBack", "foldersBack", "aiBack", "settingsBack"];
  const backEls = backIds.map((id) => document.getElementById(id));
  ok("五个返回键都在", backEls.every(Boolean), backEls.map((e) => !!e).join(","));
  ok(
    "返回键里都是角标图标、没有「返回」文字",
    backEls.every((b) => b && !!b.querySelector("svg") && !/返回/.test(b.textContent)),
    backEls.map((b) => (b ? b.textContent.trim() : "null")).join("|")
  );
  ok(
    "角标保留了可读的无障碍名（aria-label=返回）",
    backEls.every((b) => b && b.getAttribute("aria-label") === "返回"),
    backEls.map((b) => (b ? b.getAttribute("aria-label") : "")).join("|")
  );
  const cssBack = fs.readFileSync(path.join(ROOT, "panel/panel.css"), "utf8");
  ok(
    "样式：角标返回是方形热区 + hover 反馈",
    /\.sheet-head \.link\.back\s*\{[\s\S]*?width:\s*26px[\s\S]*?height:\s*26px/.test(cssBack) &&
      /\.sheet-head \.link\.back:hover/.test(cssBack),
    "panel.css 缺 .link.back 规则"
  );

  /* ② 进入多选后能全选 / 全不选 */
  $("#btn-select").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  ok("多选栏有全选按钮", !!$("#selAll"));
  $("#selAll").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  ok("点全选后全部选中", $("#selInfo").textContent === "已选 12 条", $("#selInfo").textContent);
  ok("全选后按钮变成全不选", $("#selAll").textContent === "全不选", $("#selAll").textContent);
  ok("列表条目都打上选中标记", $$("#list .item.sel").length === 12, $$("#list .item.sel").length + " 条");
  $("#selAll").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  ok("再点一次全不选清空", $("#selInfo").textContent === "已选 0 条", $("#selInfo").textContent);

  /* ③「移动 x 条到」弹窗：圆圈靠左、文件夹名靠右且同一行 */
  const items22 = $$("#list .item");
  items22[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  items22[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  $$('#selbar button[data-act="move"]')[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(150);
  ok("移动弹窗标题带条数", /移动 2 条到/.test($("#pickTitle").textContent), $("#pickTitle").textContent);
  const rows22 = $$("#pickBody label");
  ok(
    "每行都是「圆圈 + 名称」两个子元素",
    rows22.length >= 2 &&
      rows22.every((l) => l.querySelector('input[type="radio"]') && l.querySelector(".pick-name")),
    rows22.length + " 行"
  );
  ok(
    "第一行是「未分类」",
    !!rows22[0] && rows22[0].querySelector(".pick-name").textContent === "未分类",
    rows22[0] ? rows22[0].querySelector(".pick-name").textContent : "无"
  );
  const css22 = fs.readFileSync(path.join(ROOT, "panel/panel.css"), "utf8");
  ok(
    "样式：名称右对齐 + 不换行省略",
    /\.pick-body \.pick-name\s*\{[\s\S]*?text-align:\s*right[\s\S]*?white-space:\s*nowrap/.test(css22),
    "panel.css 缺 .pick-name 规则"
  );
  $('#pick button[data-close="pick"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  $("#btn-select").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);

  /* ④ 未分类 ≥ 10：提示条直接走 AI 归类；< 10 才手动 */
  global.__onMsg({ type: "xhsfav-progress", total: 12, target: 100, done: true, reason: "reached-target" });
  await sleep(320);
  ok(
    "未分类 12 条时提示条按钮是 AI 整理",
    /AI 自动整理/.test($("#tipbar").textContent),
    $("#tipbar").textContent.trim()
  );

  const origFetch22 = global.fetch;
  let aiFetch = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    aiFetch.push(body);
    const isPlan = /设计一套文件夹/.test(body.messages[0].content);
    const content = isPlan
      ? JSON.stringify({ folders: ["装修灵感", "菜谱"] })
      : JSON.stringify({
          items: Array.from({ length: 12 }, (_, i) => ({
            i: i + 1,
            f: i % 2 ? "菜谱" : "装修灵感",
            c: 90
          }))
        });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };
  $("#tipGo").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(900);
  ok("点它直接打开 AI 面板", $("#ai").classList.contains("on"));
  ok("并且自动开始分析（规划 + 分类两次调用）", aiFetch.length >= 2, String(aiFetch.length));
  ok("分析出 12 条建议", $$("#aiList .sug").length === 12, $$("#aiList .sug").length + " 条");
  ok("没有掉进手动多选", !$("#selbar").classList.contains("on"));
  $("#aiBack").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  global.fetch = origFetch22;

  /* 少于 10 条仍然手动整理（条数少时手动更快） */
  await db.clearAll();
  await db.saveNotes(many.slice(0, 3));
  await sleep(1700);
  global.__onMsg({ type: "xhsfav-progress", total: 3, target: 100, done: true, reason: "reached-target" });
  await sleep(320);
  ok("未分类 3 条时按钮还是「去整理」", /去整理/.test($("#tipbar").textContent), $("#tipbar").textContent.trim());
  $("#tipGo").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(150);
  ok("少于 10 条进入手动多选", $("#selbar").classList.contains("on"));
  $("#btn-select").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await db.clearAll();

  /* ①c 二级浮层返回 → 回上一层，不是一路退回面板首页 */
  await db.putFolder({ id: "fb1", name: "FB1", createdAt: now });
  await db.putFolder({ id: "fb2", name: "FB2", createdAt: now + 1 });
  await db.saveNotes(many.slice(0, 12).map((n) => ({ ...n, folder: null })));
  await sleep(1700);

  $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  $('#menu .menu-item[data-menu="folders"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(120);
  ok(
    "更多操作 → 管理文件夹：开着管理文件夹、关掉更多操作",
    $("#folders").classList.contains("on") && !$("#menu").classList.contains("on"),
    $("#folders").className + " / " + $("#menu").className
  );
  $("#foldersBack").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(100);
  ok(
    "管理文件夹点返回 → 回到「更多操作」（不是直接回首页）",
    $("#menu").classList.contains("on") && !$("#folders").classList.contains("on"),
    $("#menu").className + " / " + $("#folders").className
  );
  ok("回到上一层时遮罩还在（还在浮层里）", $("#scrim").classList.contains("on"));
  $("#menuBack").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(100);
  ok(
    "再从更多操作返回 → 才收起全部浮层",
    !$("#menu").classList.contains("on") && !$("#scrim").classList.contains("on")
  );

  /* AI 从「更多操作」进来，返回也回更多操作 */
  $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  $('#menu .menu-item[data-menu="ai"]').dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(200);
  ok("更多操作 → AI 自动归类：AI 浮层打开", $("#ai").classList.contains("on"), $("#ai").className);
  $("#aiBack").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(100);
  ok(
    "AI 点返回 → 回到「更多操作」",
    $("#menu").classList.contains("on") && !$("#ai").classList.contains("on"),
    $("#menu").className + " / " + $("#ai").className
  );
  $("#menuBack").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(100);
  await db.clearAll();

  /* ================= 23. 标签栏横向滑动 ================= */
  for (let i = 0; i < 12; i++) {
    await db.putFolder({ id: "f23_" + i, name: "文件夹" + i, createdAt: now + i });
  }
  await sleep(1700);

  const chips23 = $("#chips");
  ok(
    "文件夹多时 chips 排满一排（全部/未分类/12 个文件夹/新建）",
    $$("#chips .chip").length === 15,
    $$("#chips .chip").length + " 个"
  );

  /* jsdom 不做布局，scrollWidth/clientWidth 恒为 0，这里手动给尺寸 */
  const setChipSize = (sw, cw) => {
    for (const [k, v] of [
      ["scrollWidth", sw],
      ["clientWidth", cw]
    ]) {
      Object.defineProperty(chips23, k, { value: v, configurable: true });
    }
  };
  const wheelEv = (dy) => {
    const e = new window.Event("wheel", { bubbles: true, cancelable: true });
    Object.assign(e, { deltaY: dy, deltaX: 0 });
    return e;
  };
  const pointerEv = (type, x) => {
    const e = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(e, { clientX: x, clientY: 10, button: 0, pointerType: "mouse" });
    return e;
  };

  setChipSize(900, 300); /* 溢出 600px */
  chips23.scrollLeft = 0;
  chips23.dispatchEvent(new window.Event("scroll"));
  await sleep(40);
  ok(
    "溢出时挂 can-scroll 并显示右侧渐隐（提示还能往右滑）",
    chips23.classList.contains("can-scroll") && chips23.classList.contains("fade-r"),
    chips23.className
  );
  ok("在最左边时不显示左渐隐", !chips23.classList.contains("fade-l"), chips23.className);

  /* ① 普通鼠标滚轮（竖向）转成横向滑动 */
  const w1 = wheelEv(120);
  chips23.dispatchEvent(w1);
  ok("滚轮下滑 → 标签栏向右滑 120px", chips23.scrollLeft === 120, String(chips23.scrollLeft));
  ok("滚轮被拦下，不会带着整个面板乱滚", w1.defaultPrevented === true);
  ok("滑动后左侧出现渐隐", chips23.classList.contains("fade-l"), chips23.className);

  /* 滑到右头：右渐隐消失，滚轮交回页面 */
  chips23.scrollLeft = 600;
  chips23.dispatchEvent(new window.Event("scroll"));
  await sleep(40);
  ok(
    "滑到头后右侧渐隐消失、左侧渐隐保留",
    !chips23.classList.contains("fade-r") && chips23.classList.contains("fade-l"),
    chips23.className
  );
  const w2 = wheelEv(120);
  chips23.dispatchEvent(w2);
  ok("到头后再滚滚轮不拦（交回面板滚动）", w2.defaultPrevented === false);

  /* 没溢出时完全不插手 */
  setChipSize(300, 300);
  chips23.dispatchEvent(new window.Event("scroll"));
  await sleep(40);
  ok("没溢出时不挂 can-scroll", !chips23.classList.contains("can-scroll"), chips23.className);
  setChipSize(900, 300);
  chips23.dispatchEvent(new window.Event("scroll"));
  await sleep(40);

  /* ② 按住左右拖 */
  const viewBefore23 = $("#chips .chip.on") && $("#chips .chip.on").dataset.view;
  chips23.scrollLeft = 100;
  chips23.dispatchEvent(pointerEv("pointerdown", 200));
  window.dispatchEvent(pointerEv("pointermove", 202));
  ok("位移 2px 不算拖动（不影响点击）", chips23.scrollLeft === 100, String(chips23.scrollLeft));
  window.dispatchEvent(pointerEv("pointermove", 140));
  ok("按住往左拖 → 标签栏往右滑", chips23.scrollLeft === 160, String(chips23.scrollLeft));
  ok("拖动时显示抓手光标", chips23.classList.contains("grabbing"), chips23.className);
  window.dispatchEvent(pointerEv("pointerup", 140));
  ok("松手后去掉抓手光标", !chips23.classList.contains("grabbing"), chips23.className);

  /* 拖完松手会补一个 click，不能因此误切文件夹 */
  $("#chips .chip[data-view='f23_3']").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  ok(
    "拖完松手那一下不会误切文件夹",
    ($("#chips .chip.on") || {}).dataset.view === viewBefore23,
    "now=" + (($("#chips .chip.on") || {}).dataset || {}).view
  );

  /* ③ 选中项自动滚进视野 */
  let scrolled23 = null;
  window.Element.prototype.scrollIntoView = function (opt) {
    scrolled23 = opt;
  };
  await sleep(420); /* 等过误触保护窗口，再正常点击 */
  $("#chips .chip[data-view='f23_3']").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  ok("误触保护过期后点击正常切文件夹", ($("#chips .chip.on") || {}).dataset.view === "f23_3");
  ok(
    "切换后把选中的 chip 滚进视野（横向居中）",
    !!scrolled23 && scrolled23.inline === "center",
    JSON.stringify(scrolled23)
  );

  const css23 = fs.readFileSync(path.join(ROOT, "panel/panel.css"), "utf8");
  ok(
    "样式：溢出时可滑 + 抓手光标 + 触屏横扫",
    /\.chips\.can-scroll\s*\{[\s\S]*?cursor:\s*grab/.test(css23) &&
      /overscroll-behavior-x:\s*contain/.test(css23) &&
      /touch-action:\s*pan-x/.test(css23),
    "panel.css 缺 chips 滑动规则"
  );

  /* ④ 两端翻页小箭头 */
  ok("有左右两个翻页箭头", !!$("#chipPrev") && !!$("#chipNext"));
  ok(
    "箭头放在 chipwrap 里、和 chips 同级（CSS 靠 ~ 控制显隐）",
    chips23.parentElement.classList.contains("chipwrap") && $("#chipNext").parentElement === chips23.parentElement
  );
  ok(
    "样式：箭头默认隐藏、只在对应方向还有内容时出现",
    /\.chipnav\s*\{[\s\S]*?display:\s*none/.test(css23) &&
      /\.chips\.can-scroll\.fade-r ~ \.chipnav\.r\s*\{[\s\S]*?display:\s*flex/.test(css23)
  );

  setChipSize(900, 320);
  chips23.scrollLeft = 0;
  chips23.dispatchEvent(new window.Event("scroll"));
  await sleep(40);
  const viewBeforeNav = ($("#chips .chip.on") || {}).dataset.view;

  const step23 = Math.max(140, Math.round(320 * 0.7));
  $("#chipNext").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(40);
  ok("点右箭头往右翻大半屏", chips23.scrollLeft === step23, chips23.scrollLeft + " vs " + step23);
  ok(
    "点箭头不会顺手切文件夹",
    (($("#chips .chip.on") || {}).dataset || {}).view === viewBeforeNav
  );
  $("#chipPrev").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(40);
  ok("点左箭头退回去", chips23.scrollLeft === 0, String(chips23.scrollLeft));
  ok("退到最左边不出现负数", chips23.scrollLeft >= 0);

  await db.clearAll();
}

/* --- 24. 取消收藏完成条：× 贴最右（用户报「x 挤在文字后面」） --- */
{
  const css24 = fs.readFileSync(path.join(ROOT, "panel/panel.css"), "utf8");
  ok(
    "完成条的文字吃掉剩余宽度",
    /\.syncbar \.row > span\s*\{[\s\S]*?flex:\s*1 1 auto/.test(css24),
    "缺 .syncbar .row > span { flex: 1 1 auto }"
  );
  ok(
    "完成条的 × 靠右对齐",
    /\.syncbar \.x\s*\{[\s\S]*?margin-left:\s*auto/.test(css24),
    "缺 .syncbar .x { margin-left: auto }"
  );
  ok(
    "完成条的 × 不会被挤扁",
    /\.syncbar \.x\s*\{[\s\S]*?flex:\s*0 0 auto/.test(css24)
  );
}

/* --- 25. 采集条数：默认 1000，可选预设 / 自定义，记住上次选择 --- */
{
  await db.clearAll();
  /* 后面几节把 tabs.sendMessage 改成了路由/stub，这里恢复成「记下来发给页面什么」 */
  global.chrome.tabs.sendMessage = async (tabId, msg) => {
    tabsSent.push(msg && msg.type ? msg : { type: "raw", value: msg });
  };
  const aiSrc = fs.readFileSync(path.join(ROOT, "ai.js"), "utf8");
  ok("AI 单次上限 500 条", /export const MAX_PER_RUN = 500;/.test(aiSrc));
  ok("AI 每批 50 条（一次 500 不会一次塞爆）", /export const BATCH_SIZE = 50;/.test(aiSrc));
  ok("桥接默认目标也是 1000", /let target = 1000;/.test(fs.readFileSync(path.join(ROOT, "bridge.js"), "utf8")));

  tabsSent.length = 0;
  $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  const collectItem = $$(".menu-item").find((b) => b.dataset.menu === "collect");
  ok("菜单里标默认 1000 条", /默认 1000 条/.test(collectItem.textContent), collectItem.textContent.trim());
  collectItem.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(120);
  ok("点「开始采集」先出条数选择面板", $("#collect").classList.contains("on"));
  ok("选择面板有返回角标", !!$("#collectBack svg") && !/返回<\/button>/.test($("#collect").innerHTML));
  const presets = $$("#targetGrid button");
  ok(
    "4 个预设：100/300/500/1000",
    presets.map((b) => b.dataset.target).join("/") === "100/300/500/1000",
    presets.map((b) => b.dataset.target).join("/")
  );
  ok(
    "默认高亮 1000 条",
    ($$("#targetGrid button.on")[0] || {}).dataset &&
      $$("#targetGrid button.on")[0].dataset.target === "1000",
    $$("#targetGrid button.on").map((b) => b.dataset.target).join(",")
  );
  ok("采集中才有「停止采集」按钮，且默认不显示", $("#targetStop").hidden === true);

  presets.find((b) => b.dataset.target === "500").dispatchEvent(
    new window.MouseEvent("click", { bubbles: true })
  );
  await sleep(150);
  const startMsg = tabsSent.filter((m) => m.type === "xhsfav-start").pop() || {};
  ok("点 500 直接把 500 条目标下发到页面", startMsg.target === 500, String(startMsg.target));
  ok("选过的条数写进 storage", keyStore.collectTarget === 500, String(keyStore.collectTarget));
  ok("状态栏显示 0 / 500 条", /0 \/ 500 条/.test($("#status").textContent), $("#status").textContent);
  ok("开跑后浮层自动收起", !$("#collect").classList.contains("on"));

  /* 再打开：记住上次 500，并且能停下来 */
  $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  $$(".menu-item").find((b) => b.dataset.menu === "collect").dispatchEvent(
    new window.MouseEvent("click", { bubbles: true })
  );
  await sleep(150);
  ok(
    "再次打开记住上次选的 500",
    ($$("#targetGrid button.on")[0] || {}).dataset &&
      $$("#targetGrid button.on")[0].dataset.target === "500",
    $$("#targetGrid button.on").map((b) => b.dataset.target).join(",")
  );
  ok("采集中时出现「停止采集」", $("#targetStop").hidden === false);
  ok("采集中时说明会重开一轮", /重新开始/.test($("#collectDesc").textContent));

  $("#targetStop").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(120);
  ok("点停止会下发 stop 指令", tabsSent.some((m) => m.type === "xhsfav-stop"));
  ok("停止后状态栏说明已停止", /已停止采集/.test($("#status").textContent), $("#status").textContent);

  /* 按需求去掉自定义：只有四个预设，点完立刻开跑，没有第二个「开始」按钮 */
  ok("面板里没有自定义条数输入框", !$("#targetCustom") && !$("#targetGo"));
  ok("面板底部没有多余按钮（选完即开跑）", !$("#collect .sheet-foot"));

  const beforeStart = tabsSent.filter((m) => m.type === "xhsfav-start").length;
  $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  $$(".menu-item").find((b) => b.dataset.menu === "collect").dispatchEvent(
    new window.MouseEvent("click", { bubbles: true })
  );
  await sleep(120);
  $$("#targetGrid button").find((b) => b.dataset.target === "1000").dispatchEvent(
    new window.MouseEvent("click", { bubbles: true })
  );
  await sleep(150);
  ok(
    "点 1000 立刻按 1000 条开跑",
    (tabsSent.filter((m) => m.type === "xhsfav-start").pop() || {}).target === 1000,
    String((tabsSent.filter((m) => m.type === "xhsfav-start").pop() || {}).target)
  );
  ok(
    "一次点击只下发一条开跑指令（不需要再点第二个按钮）",
    tabsSent.filter((m) => m.type === "xhsfav-start").length === beforeStart + 1,
    String(tabsSent.filter((m) => m.type === "xhsfav-start").length - beforeStart)
  );

  /* 返回键回到「更多操作」，不是首页 */
  $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  $$(".menu-item").find((b) => b.dataset.menu === "collect").dispatchEvent(
    new window.MouseEvent("click", { bubbles: true })
  );
  await sleep(120);
  $("#collectBack").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(80);
  ok("条数面板返回落到更多操作", $("#menu").classList.contains("on") && !$("#collect").classList.contains("on"));
  closeSheetsFor25();
  function closeSheetsFor25() {
    document.querySelectorAll(".sheet.on").forEach((s) => s.classList.remove("on"));
    const scrim = $("#scrim");
    if (scrim) scrim.classList.remove("on");
  }
}

/* --- 26. 500 条真的能分批跑完；单批坏掉自动拆半重试 --- */
{
  /* user 消息里「文件夹：」和「笔记：」都带序号，只数笔记那段 */
  const noteLinesOf = (body) => {
    const raw = body.messages[1].content;
    const tail = raw.split("笔记：")[1] || "";
    return tail.split("\n").filter((l) => /^\d+\./.test(l));
  };
  const many = Array.from({ length: 120 }, (_, i) => ({
    id: "m" + i,
    title: "测试笔记标题 " + i,
    author: "作者" + (i % 3)
  }));
  const folders = [{ id: "g1", name: "装修灵感" }];

  let calls = [];
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const isPlan = /设计一套文件夹/.test(body.messages[0].content);
    if (isPlan) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"folders":["装修灵感"]}' } }] })
      };
    }
    const n = noteLinesOf(body).length;
    const items = Array.from({ length: n }, (_, i) => ({ i: i + 1, f: "装修灵感", c: 80 }));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: JSON.stringify({ items }) } }] })
    };
  };

  const res = await aiMod.classify({ apiKey: "sk-x", notes: many, folders });
  const classifyCalls = calls.filter((c) => !/设计一套文件夹/.test(c.messages[0].content));
  ok("120 条分成 3 批（每批 50）", classifyCalls.length === 3, String(classifyCalls.length));
  ok(
    "每批不超过 50 条",
    classifyCalls.every((c) => noteLinesOf(c).length <= 50),
    classifyCalls.map((c) => noteLinesOf(c).length).join("/")
  );
  ok("120 条全部拿到建议", res.length === 120 && res.every((r) => r.folderId === "g1"), String(res.length));
  ok(
    "批量越大 max_tokens 越宽（避免 JSON 被截断）",
    Number(classifyCalls[0].max_tokens) > 1600,
    String(classifyCalls[0].max_tokens)
  );

  /* 第二批返回坏 JSON → 自动对半拆开重试，整轮不失败 */
  calls = [];
  let badOnce = true;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const isPlan = /设计一套文件夹/.test(body.messages[0].content);
    if (isPlan) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"folders":["装修灵感"]}' } }] })
      };
    }
    const lines = noteLinesOf(body);
    if (lines.length > 40 && badOnce) {
      badOnce = false;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "我说点别的，没有 JSON" } }] })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: lines.map((_, i) => ({ i: i + 1, f: "装修灵感", c: 70 }))
              })
            }
          }
        ]
      })
    };
  };
  const res2 = await aiMod.classify({ apiKey: "sk-x", notes: many, folders });
  ok("坏掉的那批被拆小后重跑，120 条仍有建议", res2.length === 120 && res2.every((r) => r.folderId === "g1"), String(res2.length));
  ok("确实多调用了（拆分重试）", calls.length > 4, String(calls.length));

  /* 全批都失败 → 抛错，而不是「分析完成 0 条」 */
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (/设计一套文件夹/.test(body.messages[0].content)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"folders":["装修灵感"]}' } }] })
      };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "坏" } }] }) };
  };
  let thrown = "";
  try {
    await aiMod.classify({ apiKey: "sk-x", notes: many, folders });
  } catch (e) {
    thrown = e.message;
  }
  ok("全部失败时明确报错", /再点一次/.test(thrown), thrown);

  /* 余额不足这类错误不要重试，直接抛 */
  global.fetch = async () => ({ ok: false, status: 402, json: async () => ({}) });
  let thrown2 = "";
  try {
    await aiMod.classify({ apiKey: "sk-x", notes: many, folders });
  } catch (e) {
    thrown2 = e.message;
  }
  ok("余额不足直接抛错", /余额不足/.test(thrown2), thrown2);
}

/* --- 27. AI 归类：不弹中间面板、直接跑 500 条，进度在首页 --- */
{
  await db.clearAll();
  const manyNotes = Array.from({ length: 505 }, (_, i) => ({
    id: "p" + i,
    title: "批量笔记 " + i,
    author: "作者",
    liked: "1",
    cover: "",
    xsecToken: "T",
    folder: null,
    note: "",
    firstSeen: now + i,
    lastSeen: now
  }));
  await db.saveNotes(manyNotes);
  await sleep(1700);

  const noteCount = (body) => {
    const tail = String(body.messages[1].content).split("笔记：")[1] || "";
    return tail.split("\n").filter((l) => /^\d+\./.test(l)).length;
  };
  let sent27 = 0;
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    await sleep(30); /* 拖一点时间，好观察「跑的时候进度条在首页」 */
    const isPlan = /设计一套文件夹/.test(body.messages[0].content);
    const n = isPlan ? 0 : noteCount(body);
    if (!isPlan) sent27 += n;
    const content = isPlan
      ? JSON.stringify({ folders: ["批量夹"] })
      : JSON.stringify({
          items: Array.from({ length: n }, (_, i) => ({ i: i + 1, f: "批量夹", c: 80 }))
        });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content } }] }) };
  };

  $("#btn-menu").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await sleep(60);
  $$(".menu-item").find((b) => b.dataset.menu === "ai").dispatchEvent(
    new window.MouseEvent("click", { bubbles: true })
  );
  await sleep(130);
  ok("跑起来时进度条出现在首页面板", $("#aiprog").classList.contains("on"));
  ok(
    "进度文案带条数 / 总数",
    /\d+ \/ \d+/.test($("#aiprogText").textContent),
    $("#aiprogText").textContent
  );
  ok("跑的过程中不弹结果面板", !$("#ai").classList.contains("on"));

  await sleep(2500);
  ok("跑完自动弹结果面板", $("#ai").classList.contains("on"));
  ok("跑完首页进度条收起", !$("#aiprog").classList.contains("on"));
  ok("单轮只跑 500 条（多的留到下次）", sent27 === 500, String(sent27));
  ok("结果列表 500 行", $$("#aiList .sug").length === 500, $$("#aiList .sug").length + " 行");
  ok("说明写的是 500 条", /500 条里/.test($("#aiDesc").textContent), $("#aiDesc").textContent.slice(0, 30));
  ok("确认前不写库（505 条仍未分类）", (await db.getAllNotes()).filter((n) => !n.folder).length === 505);
  ok(
    "没有「选数量 / 余下 N 条」的旧文案",
    !/本次处理前|余下/.test($("#aiDesc").textContent),
    $("#aiDesc").textContent.slice(0, 40)
  );
  await db.clearAll();
}

/* --- 28. 采集条数面板的样式（320px 下两列、不挤） --- */
{
  const css28 = fs.readFileSync(path.join(ROOT, "panel/panel.css"), "utf8");
  ok(
    "预设按钮两列排布",
    /\.target-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr 1fr/.test(css28)
  );
  ok("选中的预设高亮", /\.target-grid button\.on\s*\{[\s\S]*?border-color:\s*#ff2442/.test(css28));
  ok("首页 AI 进度条默认不占位", /\.aiprog\s*\{[\s\S]*?display:\s*none/.test(css28));
  ok("跑起来才显示", /\.aiprog\.on\s*\{[\s\S]*?display:\s*block/.test(css28));
  ok(
    "进度文字吃掉剩余宽度（停止按钮不被挤）",
    /\.aiprog-head span\s*\{[\s\S]*?flex:\s*1 1 auto/.test(css28)
  );
  ok("停止按钮隐藏时真的不占位", /#targetStop\[hidden\]\s*\{[\s\S]*?display:\s*none/.test(css28));
}

const failed = results.filter((r) => !r.pass);
process.exitCode = failed.length ? 1 : 0;
console.log("\n=== " + (results.length - failed.length) + "/" + results.length + " 通过 ===");
if (failed.length) {
  console.log("失败项：");
  failed.forEach((f) => console.log("  - " + f.name + " " + (f.extra || "")));
  process.exit(1);
}

process.exit(failed.length ? 1 : 0);
