/* 隔离世界：把页面侧捕获到的收藏流转给后台，并负责「滚多少、什么时候停」。
 *
 * 实测（2026-11-12，v2/note/collect/page）：
 *   - 每页 num=30，翻页靠响应里的 data.cursor
 *   - data.has_more 为 false 表示到底
 *   - 滚动容器就是 document.scrollingElement（html），window.scrollTo 有效
 *
 * 重要（2026-11-12 晚，修「滚动页面就自动采集」bug）：
 *   页面自己发的收藏流请求，只要用户在收藏页滚动就会产生。
 *   以前不管采没采集都往库里写，用户会觉得「我没点采集怎么自己采了」。
 *   现在只有点过「开始采集」（collecting = true）才写库；
 *   页面加载/滚动产生的第一屏数据先进滚动缓冲，
 *   点「开始采集」时把缓冲补录进去——这样「先 F5 再点开始」的流程还能拿到第一屏。
 */

let collecting = false;
let hasMore = true;
let lastDataAt = 0;
let timer = null;
let target = 1000;
let seen = new Set();
let total = 0;

/* 非采集状态下的滚动缓冲：最多 8 页、10 分钟内有效 */
let buffer = [];
const BUFFER_MAX = 8;
const BUFFER_TTL = 10 * 60 * 1000;

function report(done, reason) {
  try {
    chrome.runtime
      .sendMessage({ type: "xhsfav-progress", total, target, done, reason })
      .catch(() => {});
  } catch (e) {}
}

function finish(reason) {
  collecting = false;
  hasMore = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  report(true, reason);
}

function forwardAndCount(payload) {
  lastDataAt = Date.now();
  const d = (payload && payload.data) || payload || {};

  const arr = Array.isArray(d.notes) ? d.notes : [];
  for (const it of arr) {
    const id = it && (it.note_id || it.id || (it.note_card && it.note_card.note_id));
    if (id && !seen.has(id)) {
      seen.add(id);
      total++;
    }
  }
  if (d.has_more === false) hasMore = false;

  const uid =
    (/(?:\/|^)user\/profile\/([0-9a-f]+)/i.exec(window.location.pathname) || [])[1] || null;
  chrome.runtime
    .sendMessage({ type: "collect-page", payload, uid: uid })
    .catch(() => {});

  if (collecting && (total >= target || !hasMore)) {
    finish(total >= target ? "reached-target" : "no-more");
  } else if (collecting) {
    report(false);
  }
}

function onPageMessage(e) {
  const m = e && e.data;
  if (!m || m.source !== "xhsfav") return;

  if (m.type === "collect-page") {
    if (collecting) {
      forwardAndCount(m.payload);
    } else {
      /* 没在采集：只缓冲，不写库 */
      buffer.push({ at: Date.now(), payload: m.payload });
      if (buffer.length > BUFFER_MAX) buffer.shift();
      console.debug("[xhsfav] 未采集，收藏流进缓冲（不写库），现缓存", buffer.length, "页");
    }
    return;
  }

  /* 取消收藏：页面（MAIN world）执行到哪一步、执行完一条，都转发给后台 */
  if (m.type === "ui-result" || m.type === "ui-run-done" || m.type === "ui-step") {
    chrome.runtime.sendMessage({ type: m.type, payload: m.payload }).catch(() => {});
  }
}

window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  onPageMessage(e);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === "xhsfav-start") {
    collecting = true;
    hasMore = true;
    lastDataAt = Date.now();
    target = Number(msg.target) > 0 ? Number(msg.target) : 1000;
    seen = new Set();
    total = 0;
    if (timer) clearTimeout(timer);
    /* 补录缓冲里的旧页面（F5 后页面自己加载的第一屏就是靠这个进来的） */
    const now = Date.now();
    const valid = buffer.filter((b) => now - b.at <= BUFFER_TTL);
    buffer = [];
    for (const b of valid) {
      forwardAndCount(b.payload);
    }
    console.debug("[xhsfav] 开始采集，补录缓冲", valid.length, "页，已计", total, "条");
    report(false, "start");
    tick();
    sendResponse({ ok: true, target });
  } else if (msg.type === "xhsfav-stop") {
    finish("stopped");
    sendResponse({ ok: true, total });
  } else if (msg.type === "xhsfav-status") {
    sendResponse({ collecting, total, target, hasMore });
  } else if (msg.type === "xhsfav-ping") {
    /* 后台导航后靠这个探测「新页面的脚本装好了没」，就绪就立刻下发点击指令，
     * 不等 load 事件（小红书笔记页 load 要 8 秒左右，按钮 1~2 秒就在了）。
     * 带上当前地址：导航瞬间旧页面可能还没卸载，后台靠它判断是不是目标页。 */
    sendResponse({ ok: true, href: String(window.location.href) });
  } else if (msg.type === "xhsfav-ui") {
    /* 后台下发的单条 UI 取消收藏指令，转给页面里的 inject 执行 */
    console.debug("[xhsfav] 转发 UI 取消收藏指令给页面：", msg.id);
    window.postMessage(
      {
        source: "xhsfav-bridge",
        type: "ui-uncollect",
        id: msg.id,
        token: msg.token,
        uid: msg.uid
      },
      window.location.origin
    );
    sendResponse({ ok: true });
  }
  return false;
});

function scrollDown() {
  const se = document.scrollingElement || document.documentElement;
  try {
    window.scrollTo(0, se.scrollTop + Math.max(600, se.clientHeight * 0.9));
  } catch (e) {}
}

function tick() {
  if (!collecting) return;

  if (!hasMore) {
    finish("no-more");
    return;
  }
  if (total >= target) {
    finish("reached-target");
    return;
  }
  /* 连续 15 秒没有任何新数据，说明页面滚不动或已到底 */
  if (Date.now() - lastDataAt > 15000) {
    finish("timeout");
    return;
  }

  scrollDown();
  timer = setTimeout(tick, 1400);
}

/* 测试钩子：Node/jsdom 里直接喂页面消息（jsdom 的 postMessage source 语义与 Chrome 不同） */
window.__xhsfavBridgeTest = { onPageMessage, forwardAndCount };
