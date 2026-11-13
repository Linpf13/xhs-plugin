(() => {
  /* 实测（2026-11-12）：真实接口是
   *   //edith.xiaohongshu.com/api/sns/web/v2/note/collect/page?num=30&cursor=...
   * 版本号可能变，用正则匹配路径，不锁死版本与域名。
   */
  const TARGET_RE = /\/api\/sns\/web\/v\d+\/note\/collect\/page/;

  const post = (type, payload) => {
    try {
      const n =
        payload && payload.data && Array.isArray(payload.data.notes)
          ? payload.data.notes.length
          : 0;
      if (type === "collect-page") {
        console.debug("[xhsfav] 捕获收藏流", n, "条，has_more =", payload && payload.data && payload.data.has_more);
      }
      window.postMessage(
        { source: "xhsfav", type, payload },
        window.location.origin
      );
    } catch (e) {}
  };

  const hit = (url) => TARGET_RE.test(String(url));

  /* ---- 取消收藏（唯一写回操作）----
   * 2026-11-13 定稿：**UI 模拟，不再直调接口**。
   * 实测直调 note/uncollect 无论头多齐全都是 406/461（签名与时效强绑定，
   * 原样重放页面自己的头也不行）。唯一可行：像真人一样打开笔记页、
   * 点「已收藏」按钮，让页面自己的代码签名发请求。
   *
   * 流程（background 逐条驱动，每次完整导航一个笔记页）：
   *   1. background 导航到 /user/profile/<uid>/<noteId>?xsec_token=<token>
   *   2. 页面加载完，background 发 xhsfav-ui 指令
   *   3. 这里等 .collect-wrapper 出现 → use href 含 #collected 确认已收藏
   *      → JS 派发 mousedown/mouseup/click → 监听页面自己发的 uncollect 请求
   *      → code 0 = 成功，回报 background → 导航下一条
   * 每一步都打 [xhsfav] 日志，F12 Console 可见。
   */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---- 采集旁路（fetch + XHR 双钩子）---- */
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const url =
          typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (hit(url)) {
          p.then((resp) => {
            if (resp && resp.ok) {
              resp.clone().json().then((j) => post("collect-page", j)).catch(() => {});
            }
          }).catch(() => {});
        }
      } catch (e) {}
      return p;
    };
  }

  const XO = XMLHttpRequest.prototype.open;
  const XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__xhsfav_url = url;
    return XO.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (hit(this.__xhsfav_url)) {
      this.addEventListener("load", () => {
        try {
          post("collect-page", JSON.parse(this.responseText));
        } catch (e) {}
      });
    }
    return XS.apply(this, args);
  };

  /* ---- UI 取消收藏 ---- */

  const UNCOLLECT_RE = /\/api\/sns\/web\/v\d+\/note\/uncollect/;

  /* 页面自己发的 uncollect 请求，结果记在这里（XHR + fetch 双路） */
  let lastUncollectResp = null;
  function noteUncollectResult(status, body) {
    let j = null;
    try {
      j = body ? JSON.parse(body) : null;
    } catch (e) {}
    lastUncollectResp = {
      status,
      code: j && j.code,
      msg: (j && (j.msg || j.message)) || "",
      at: Date.now()
    };
    console.debug("[xhsfav] 页面发出取消收藏请求：", status, lastUncollectResp.code, lastUncollectResp.msg);
  }

  const XS_ = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (UNCOLLECT_RE.test(String(this.__xhsfav_url))) {
      this.addEventListener("load", () => {
        noteUncollectResult(this.status, this.responseText);
      });
    }
    return XS_.apply(this, args);
  };

  const SF_ = window.fetch;
  if (typeof SF_ === "function") {
    window.fetch = function (...args) {
      const p = SF_.apply(this, args);
      try {
        const url =
          typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
        if (UNCOLLECT_RE.test(url)) {
          p.then((resp) => {
            resp.clone().text().then((t) => noteUncollectResult(resp.status, t)).catch(() => {});
          }).catch(() => {});
        }
      } catch (e) {}
      return p;
    };
  }

  function collectState() {
    /* use href 含 #collected = 已收藏；#collect = 未收藏 */
    const use = document.querySelector(".collect-wrapper use");
    if (!use) return null;
    const href = String(use.getAttribute("href") || "");
    if (/#collected/.test(href)) return "collected";
    if (/#collect/.test(href)) return "uncollected";
    return null;
  }

  async function waitFor(fn, timeout, step) {
    const max = typeof window.__xhsfavWaitMax === "number" ? window.__xhsfavWaitMax : timeout;
    const end = Date.now() + Math.min(timeout, max);
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(step || 250);
    }
  }

  function humanClick(el) {
    ["mousedown", "mouseup", "click"].forEach((t) =>
      el.dispatchEvent(new window.MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
    );
  }

  /* 导航入口（测试里可注入替身；浏览器里就是本页跳转） */
  function navTo(url) {
    if (typeof window.__xhsfavNav === "function") {
      window.__xhsfavNav(url);
      return;
    }
    window.location.assign(url);
  }

  /* 在当前笔记页执行取消收藏；不在这页就导航过去（返回 navigated，等
   * background 下次再来驱动）。 */
  async function uiUncollect(id, token, uid) {
    const onNotePage = String(window.location.pathname).indexOf(String(id)) >= 0;
    if (!onNotePage) {
      if (!token || !uid) {
        return { id, ok: false, error: "缺 token 或 uid，无法打开笔记页" };
      }
      const url =
        "https://www.xiaohongshu.com/user/profile/" +
        encodeURIComponent(uid) + "/" + encodeURIComponent(id) +
        "?xsec_token=" + encodeURIComponent(token) + "&xsec_source=";
      console.debug("[xhsfav] 导航到笔记页：", id);
      navTo(url);
      return { id, ok: false, navigated: true };
    }

    const t0 = Date.now();
    console.debug("[xhsfav] 已在笔记页，等互动栏出现：", id);
    post("ui-step", { id, step: "等收藏按钮出现" });
    /* 页面是 SPA，DOM 里先出骨架、后出真实数据；轮询要密，按钮一出现立刻就点 */
    const state = await waitFor(collectState, 12000, 100);
    if (!state) {
      return { id, ok: false, error: "笔记页没加载出收藏按钮（笔记可能无法浏览/已删除/需要验证）" };
    }
    if (state === "uncollected") {
      /* 骨架屏也可能先显示未收藏，隔一下再确认一次，避免误判为「已取消」 */
      await sleep(600);
      if (collectState() !== "uncollected") {
        return uiUncollectClick(id, t0);
      }
      console.debug("[xhsfav] 这条本来就是未收藏，视为完成：", id);
      return { id, ok: true, already: true };
    }

    return uiUncollectClick(id, t0);
  }

  /* 点「已收藏」按钮，并等页面自己的请求回来。
   * 万一第一次点早了（骨架屏 / 按钮还没绑事件），只在「仍是已收藏」时补点一次——
   * 已经变成未收藏就绝不再点，否则会重新收藏回去。 */
  async function uiUncollectClick(id, t0) {
    let resp = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const wrapper = document.querySelector(".collect-wrapper");
      if (!wrapper) break;
      post("ui-step", { id, step: attempt === 1 ? "点击取消收藏" : "重试点击" });
      lastUncollectResp = null;
      humanClick(wrapper);
      console.debug("[xhsfav] 已点击收藏按钮，等页面自己的请求：", id, "第", attempt, "次");
      post("ui-step", { id, step: "等页面确认结果" });
      resp = await waitFor(() => lastUncollectResp, 2500, 100);
      if (resp) break;
      if (collectState() !== "collected") break; /* 已经变了，别再点 */
      await sleep(400 + Math.random() * 300);
    }

    const after = collectState();
    const cost = Date.now() - t0;
    if (resp && resp.status === 200 && (resp.code === 0 || resp.code === undefined)) {
      console.debug("[xhsfav] 本条完成，用时", cost, "ms：", id);
      return { id, ok: true, resp, cost };
    }
    if (!resp && after === "uncollected") {
      console.debug("[xhsfav] 本条完成（无响应但已变未收藏），用时", cost, "ms：", id);
      return { id, ok: true, already: true, cost };
    }
    return {
      id,
      ok: false,
      error: resp
        ? "HTTP " + resp.status + " code " + resp.code + " " + resp.msg
        : "点击后没等到页面请求（状态：" + (after || "未知") + "）"
    };
  }

  /* 同一条重复指令只执行一次：background 会「快速驱动 + load 事件兜底」
   * 两路都发指令，跑两次会把刚取消的又收藏回来 */
  const running = new Map();
  function uiUncollectOnce(id, token, uid) {
    if (running.has(id)) {
      console.debug("[xhsfav] 这条已在执行中，忽略重复指令：", id);
      return running.get(id);
    }
    const p = uiUncollect(id, token, uid).then(
      (v) => v,
      (e) => ({ id, ok: false, error: String((e && e.message) || e) })
    );
    running.set(id, p);
    p.then(() => setTimeout(() => running.delete(id), 3000));
    return p;
  }

  /* bridge（隔离世界）下发的指令从这里进来。
   * 不校验 e.source：jsdom 里 postMessage 的 source 语义和 Chrome 不一致，
   * 而这个指令本身无敏感数据、有 source 标记，足够了。 */
  window.addEventListener("message", (e) => {
    const m = e && e.data;
    if (!m || m.source !== "xhsfav-bridge") return;
    if (m.type === "ui-uncollect") {
      uiUncollectOnce(m.id, m.token, m.uid).then((r) => {
        post("ui-result", r);
        post("ui-run-done", {});
      });
    }
  });

  /* 测试钩子：Node/jsdom 里直接调用，不走 postMessage 路由 */
  window.__xhsfavHooks = { uiUncollect, uiUncollectOnce, collectState };
})();
