import {
  extractNote,
  saveNotes,
  getUnfavQueue,
  setUnfavQueue,
  getNote,
  deleteNotes,
  getMeta,
  setMeta
} from "./db.js";

/* 点工具栏图标打开侧边栏。
 * Chrome / Edge 都是 Chromium，同一个 sidePanel API；但个别 Edge 版本
 * setPanelBehavior 不生效（点了图标没反应），所以再补一层 action.onClicked
 * 兜底——两个浏览器都能用，且重复触发只会报个无害的异常。 */
try {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch(() => {});
  }
} catch (e) {
  console.warn("[xhsfav] setPanelBehavior 不可用（Edge 老版本？）：", e);
}

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    try {
      if (chrome.sidePanel && chrome.sidePanel.open && tab && tab.windowId != null) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
        return;
      }
    } catch (e) {
      console.warn("[xhsfav] 侧边栏打不开，退回标签页：", e);
    }
    /* 老 Edge / 侧边栏被策略禁用时，面板开成普通标签页也能用 */
    try {
      chrome.tabs.create({ url: chrome.runtime.getURL("src/panel/panel.html") });
    } catch (e) {
      console.warn("[xhsfav] 打开面板失败：", e);
    }
  });
}

/* ---- 取消收藏同步（2026-11-13 定稿：UI 模拟，逐条导航） ----
 * 直调接口实测必 406/461（签名时效绑定），唯一可行是真人路径：
 * 逐条打开笔记详情页 → 点「已收藏」按钮 → 页面自己签名发请求 → 成功后
 * 从本地库真删该条 → 导航下一条。
 *
 * 编排：
 *   processNext()：
 *     1. 取队首 id；库里查笔记拿 xsec_token（没有就跳过这条——多半已处理过）
 *     2. chrome.tabs.update 导航到笔记页
 *     3. tabs.onUpdated complete 后向页面发 xhsfav-ui 指令
 *     4. 页面点按钮、等页面自己的 uncollect 请求，回报结果
 *     5. 成功 → deleteNotes + 出队 → 间隔几秒 → 下一条；失败 → 熔断
 *
 * 卡死自愈：当前条目 90 秒无任何动静自动作废，可重新发起。
 * 每一跳都打 [xhsfav] 日志（Service Worker 控制台可见）。
 */

let syncing = false;
let syncStats = { done: 0, total: 0, failed: 0, skipped: 0 };
let currentTabId = null;
let lastSyncActivity = 0;
let pendingId = null; /* 正在处理的笔记 id */
let navDeadline = 0; /* 本条的处理截止时间 */
let itemStartedAt = 0; /* 本条开始时间，用来量「一条到底花了多久」 */
let navRetries = 0; /* 本条「页面自己导航」的重试次数，防死循环 */
/* 开始同步前用户停留的页面（收藏页/个人主页等），跑完把人送回去。
 * 笔记详情页不算「原来的页面」，否则会把人丢在刚取消的那条笔记上。 */
let returnUrl = null;

function broadcast(payload) {
  try {
    chrome.runtime
      .sendMessage(Object.assign({ type: "xhsfav-uncollect-progress" }, payload))
      .catch(() => {});
  } catch (e) {}
}

async function findXhsTab() {
  try {
    const act = await chrome.tabs.query({ active: true, currentWindow: true });
    if (act && act[0] && /^https:\/\/www\.xiaohongshu\.com\//.test(act[0].url || "")) {
      return act[0];
    }
    const all = await chrome.tabs.query({ url: "https://www.xiaohongshu.com/*" });
    return (all && all[0]) || null;
  } catch (e) {
    return null;
  }
}

/* 收藏者自己的 uid：优先 meta（采集时记下），兜底当前小红书标签页 URL */
let ownerUidCache = null;
async function getOwnerUid(tabUrl) {
  if (ownerUidCache) return ownerUidCache;
  const saved = await getMeta("ownerUid");
  if (saved) {
    ownerUidCache = saved;
    return saved;
  }
  const m = /xiaohongshu\.com\/user\/profile\/([0-9a-f]+)/i.exec(tabUrl || "");
  const uid = m ? m[1] : null;
  if (uid) {
    ownerUidCache = uid;
    setMeta("ownerUid", uid).catch(() => {});
  }
  return uid;
}

/* 这条地址是不是「某篇笔记的详情页」（扩展自己会导航到这种页面） */
function isNoteDetailUrl(u) {
  const s = String(u || "");
  if (!/xiaohongshu\.com/i.test(s)) return false;
  return (
    /xiaohongshu\.com\/(?:explore|discovery\/item)\/[0-9a-zA-Z]{10,}/.test(s) ||
    /xiaohongshu\.com\/user\/profile\/[0-9a-f]+\/[0-9a-zA-Z]{10,}/.test(s)
  );
}

async function startSync() {
  if (syncing) {
    /* 90 秒没有任何动静的「同步中」视为卡死，作废重来 */
    if (Date.now() - lastSyncActivity > 90000) {
      console.debug("[xhsfav] 同步状态卡死超过 90 秒，自动作废重来");
      syncing = false;
    } else {
      broadcast({
        done: syncStats.done,
        total: syncStats.total,
        finished: true,
        error: "已经在同步中了（看下方状态行进度）"
      });
      return;
    }
  }
  const queue = await getUnfavQueue();
  if (!queue.length) {
    broadcast({ done: 0, total: 0, finished: true, empty: true });
    return;
  }
  const tab = await findXhsTab();
  if (!tab) {
    broadcast({
      done: 0,
      total: queue.length,
      finished: true,
      remaining: queue.length,
      error: "没找到打开的小红书页面。先打开收藏页，再点 ⋯ → 续跑取消收藏"
    });
    return;
  }
  console.debug("[xhsfav] 开始 UI 取消收藏：队列", queue.length, "条，标签页", tab.id);
  syncing = true;
  currentTabId = tab.id;
  /* 记住「原来停在哪个页面」，跑完送回去（收藏页 → 还在收藏页） */
  returnUrl = tab.url && /xiaohongshu\.com/i.test(tab.url) && !isNoteDetailUrl(tab.url) ? tab.url : null;
  await getOwnerUid(tab.url); /* 现在就把 uid 定下来 */
  lastSyncActivity = Date.now();
  syncStats = { done: 0, total: queue.length, failed: 0, skipped: 0 };
  broadcast({ done: 0, total: queue.length });
  processNext();
}

/* 逐条处理。每条都是：查 token → 导航 → 等加载 → 指令点击 → 收结果。 */
async function processNext() {
  if (!syncing) return;
  lastSyncActivity = Date.now();
  navDeadline = Date.now() + 60000;
  let queue = await getUnfavQueue();
  if (!queue.length) {
    finishSync(null);
    return;
  }
  const id = queue[0];
  pendingId = id;
  itemStartedAt = Date.now();
  navRetries = 0;
  const note = await getNote(id);
  const uid = await getOwnerUid(null);
  if (!note || !note.xsecToken || !uid) {
    /* 库里没这条（多半早已取消成功）或缺 token/uid：跳过 */
    console.debug("[xhsfav] 跳过（缺记录/token/uid）：", id);
    queue = queue.filter((x) => x !== id);
    await setUnfavQueue(queue);
    syncStats.skipped++;
    broadcast({ done: syncStats.done, total: syncStats.total, remaining: queue.length });
    processNext();
    return;
  }
  const url =
    "https://www.xiaohongshu.com/user/profile/" +
    encodeURIComponent(uid) + "/" + encodeURIComponent(id) +
    "?xsec_token=" + encodeURIComponent(note.xsecToken) + "&xsec_source=";
  console.debug("[xhsfav] 打开笔记页：", id);
  try {
    await chrome.tabs.update(currentTabId, { url });
  } catch (e) {
    finishSync("标签页没法导航（可能被关了）。打开小红书页面后点 ⋯ → 续跑取消收藏");
    return;
  }
  broadcast({ done: syncStats.done, total: syncStats.total, remaining: queue.length, step: "打开笔记页" });
  /* 关键提速点：不等 load 事件，页面脚本一能应答就点击 */
  waitPageReadyAndDrive();
}

/* 页面加载完成后驱动点击；页面回报结果走 ui-result 消息 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (!syncing || tabId !== currentTabId) return;
  if (changeInfo.status !== "complete") return;
  if (!pendingId) return;
  lastSyncActivity = Date.now();
  console.debug("[xhsfav] 页面加载完成，下发点击指令：", pendingId);
  await sleep(MOUNT_WAIT());
  driveClick();
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
/* 拟人节奏（测试里可压短）：页面挂载等待 / 条目间间隔。
 * 挂载等待只是兜底——导航后不等 load，靠 ping 发现页面脚本就绪就下发指令
 * （小红书笔记页 load 要 8 秒左右，收藏按钮 1~2 秒就渲染好了）。 */
const MOUNT_WAIT = () =>
  typeof globalThis.__xhsfavUiMount === "number" ? globalThis.__xhsfavUiMount : 250;
const ITEM_PACE = () =>
  typeof globalThis.__xhsfavUiPace === "number"
    ? globalThis.__xhsfavUiPace
    : 1500 + Math.floor(Math.random() * 1500);
/* ping 探测窗口（测试里可压短） */
const PING_MAX = () =>
  typeof globalThis.__xhsfavUiPing === "number" ? globalThis.__xhsfavUiPing : 8000;

/* 导航之后：每 200ms 戳一下页面脚本，能应答就说明新页面的脚本装好了，
 * 立刻下发点击指令；页面自己会轮询「收藏按钮」出现（100ms 一次）。 */
async function waitPageReadyAndDrive() {
  const id = pendingId;
  const t0 = Date.now();
  const deadline = t0 + PING_MAX();
  for (;;) {
    if (!syncing || pendingId !== id) return;
    try {
      const r = await chrome.tabs.sendMessage(currentTabId, { type: "xhsfav-ping" });
      /* 地址必须已经是目标笔记页：导航瞬间旧页面可能还没卸载，别对着旧页发指令 */
      if (r && r.ok && (!r.href || String(r.href).indexOf(String(id)) >= 0)) {
        console.debug("[xhsfav] 页面脚本就绪，用时", Date.now() - t0, "ms");
        break;
      }
    } catch (e) {}
    if (Date.now() > deadline) break;
    await sleep(200);
  }
  if (!syncing || pendingId !== id) return;
  driveClick();
}

async function driveClick() {
  const id = pendingId;
  if (!id) return; /* 队列刚被清空/已切下一条：别拿空 id 去查库 */
  const note = await getNote(id);
  const uid = await getOwnerUid(null);
  if (!note || !uid) return;
  let resp = null;
  try {
    resp = await chrome.tabs.sendMessage(currentTabId, {
      type: "xhsfav-ui",
      id,
      token: note.xsecToken,
      uid
    });
  } catch (e) {
    resp = null;
  }
  if (!resp || !resp.ok) {
    finishSync(
      "连不上页面脚本——多半是重载扩展后小红书页面没刷新。F5 刷新小红书页面后，点 ⋯ → 续跑取消收藏"
    );
    return;
  }
  /* inject 收到指令后在笔记页直接点，结果走 ui-result 消息回来 */
}

function finishSync(error) {
  syncing = false;
  pendingId = null;
  getUnfavQueue()
    .then((queue) => {
      broadcast({
        done: syncStats.done,
        total: syncStats.total,
        failed: syncStats.failed,
        skipped: syncStats.skipped,
        finished: true,
        remaining: queue.length,
        error: error || null
      });
    })
    .catch(() => {});
  /* 小红书笔记页取消收藏后自己会跳回首页，跑完把人送回原来的收藏页 */
  restoreReturnUrl();
}

/* 跑完把标签页导航回「开始前的页面」。当前已经在那页就不动。 */
function restoreReturnUrl() {
  const url = returnUrl;
  const tabId = currentTabId;
  returnUrl = null;
  if (!url || tabId == null) return;
  navBack(tabId, url);
  /* 小红书偶尔在取消收藏后自己再跳一次（跳首页），稍后再校一次 */
  const t = setTimeout(() => {
    if (!syncing) navBack(tabId, url);
  }, 1500);
  if (t && typeof t.unref === "function") t.unref();
}

function navBack(tabId, url) {
  const doNav = (current) => {
    if (current === url) return;
    /* 只在还停在小红书上时把人送回去，别抢用户自己的导航 */
    if (current && !/xiaohongshu\.com/i.test(current)) return;
    console.debug("[xhsfav] 回到开始前的页面：", url);
    try {
      const q = chrome.tabs.update(tabId, { url });
      if (q && typeof q.catch === "function") q.catch(() => {});
    } catch (e) {}
  };
  let p = null;
  try {
    p = chrome.tabs && chrome.tabs.get ? chrome.tabs.get(tabId) : null;
  } catch (e) {
    p = null;
  }
  if (p && typeof p.then === "function") {
    p.then((tab) => doNav(tab && tab.url)).catch(() => {});
  } else {
    doNav(null);
  }
}

/* 卡死看门狗：每 20 秒查一次，当前条目 90 秒无动静就作废报错
 * （Node 测试环境里 unref，不拖住进程退出；SW 环境无影响） */
const watchdog = setInterval(() => {
  if (!syncing) return;
  if (Date.now() - lastSyncActivity > 90000) {
    console.debug("[xhsfav] 看门狗：当前条目超时", pendingId);
    finishSync(
      "取消收藏超时（页面没响应）。F5 刷新小红书页面后，点 ⋯ → 续跑取消收藏"
    );
  }
}, 20000);
if (watchdog && typeof watchdog.unref === "function") watchdog.unref();

/* 队列读改严格串行，避免结果消息与调度竞态 */
let dbChain = Promise.resolve();
function serializeDb(fn) {
  dbChain = dbChain.then(fn, fn);
  return dbChain;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  if (msg.type === "collect-page") {
    const data = (msg.payload && msg.payload.data) || msg.payload || {};
    const raw = data.notes || [];
    const items = raw.map(extractNote).filter(Boolean);
    /* 记下收藏者自己的 uid（打开笔记页要用） */
    if (msg.uid) setMeta("ownerUid", msg.uid).catch(() => {});
    if (items.length) {
      saveNotes(items)
        .then(() => sendResponse({ ok: true, count: items.length }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
    } else {
      sendResponse({ ok: true, count: 0 });
    }
    return true;
  }

  if (msg.type === "xhsfav-sync-start") {
    startSync();
    sendResponse({ ok: true });
    return false;
  }

  /* 面板重开时问一句「同步到哪了」，让进度条能接上 */
  if (msg.type === "xhsfav-sync-status") {
    getUnfavQueue()
      .then((queue) =>
        sendResponse({
          syncing,
          done: syncStats.done,
          total: syncStats.total,
          failed: syncStats.failed,
          remaining: queue.length
        })
      )
      .catch(() => sendResponse({ syncing: false, remaining: 0 }));
    return true; /* 异步回包 */
  }

  /* 页面报告「这一步做到了哪」，原样透到面板进度条上，别让人干等 */
  if (msg.type === "ui-step") {
    const step = (msg.payload && msg.payload.step) || "";
    /* 已经停了（完成/熔断）就别再用迟到的步骤覆盖状态行 */
    if (!step || !syncing) return false;
    console.debug("[xhsfav] 步骤：", step, "（本条已用", Date.now() - itemStartedAt, "ms）");
    getUnfavQueue()
      .then((queue) =>
        broadcast({
          done: syncStats.done,
          total: syncStats.total,
          remaining: queue.length,
          step
        })
      )
      .catch(() => {});
    return false;
  }

  /* inject 在笔记页点完按钮，回报结果 */
  if (msg.type === "ui-result") {
    const r = msg.payload || {};
    /* 同一个 id 可能收到两次结果（快速驱动 + load 兜底两路指令），只认第一次 */
    if (!pendingId || (r.id && r.id !== pendingId)) {
      console.debug("[xhsfav] 忽略重复/过期结果：", r.id);
      return false;
    }
    lastSyncActivity = Date.now();
    if (r.navigated) {
      /* 页面说自己跳去了笔记页：保持 pendingId，稍后再驱动一次（最多 3 次） */
      if (++navRetries > 3) {
        pendingId = null;
        finishSync("笔记页反复跳转，没能停在可操作的位置。F5 刷新小红书页面后，点 ⋯ → 续跑取消收藏");
        return false;
      }
      setTimeout(() => {
        if (syncing && pendingId) waitPageReadyAndDrive();
      }, 600);
      return false;
    }
    pendingId = null;
    serializeDb(async () => {
      const queue = await getUnfavQueue();
      if (r.ok) {
        const next = queue.filter((x) => x !== r.id);
        if (next.length !== queue.length) {
          await setUnfavQueue(next);
        }
        /* 小红书上确实取消了，本地记录才真删 */
        await deleteNotes([r.id]);
        syncStats.done++;
        console.debug(
          "[xhsfav] 取消收藏成功：",
          r.id,
          "（累计", syncStats.done, "，本条共", Date.now() - itemStartedAt, "ms）"
        );
        broadcast({ done: syncStats.done, total: syncStats.total, remaining: next.length });
        await sleep(ITEM_PACE());
        if (syncing) processNext();
      } else {
        syncStats.failed++;
        syncing = false;
        console.debug("[xhsfav] 取消收藏失败，熔断：", r.error);
        broadcast({
          done: syncStats.done,
          total: syncStats.total,
          failed: syncStats.failed,
          remaining: queue.length,
          finished: true,
          error:
            "取消收藏失败：" + (r.error || "未知错误") +
            "。已全部停止；剩余条目保留在队列里（它们仍收藏在小红书）"
        });
      }
    });
    return false;
  }
});
