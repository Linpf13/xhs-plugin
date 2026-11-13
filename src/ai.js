/* DeepSeek 归类：两步走。
 *
 *   第一步「规划」：把这批笔记标题给 AI，让它自己设计一套文件夹——
 *                  可以复用现有文件夹，也可以新建，总数不超过 MAX_FOLDERS。
 *   第二步「分类」：把每条笔记分进这套文件夹，置信度低就建议不归。
 *
 * 三条硬规则：
 *   1. 只发标题和作者，不发封面、链接、备注（隐私最小化）
 *   2. 只输出建议，绝不自己写库；写不写、写哪条由用户确认
 *   3. 单次点击最多 MAX_PER_RUN 条，内部按 BATCH_SIZE 条一批分批调接口——
 *      一次请求塞太多条，返回的 JSON 会被 max_tokens 截断，整批就白跑了
 */

import { DEEPSEEK_MODEL, MAX_FOLDERS } from "./config.js";

export const API_URL = "https://api.deepseek.com/chat/completions";
/* 每批 50 条：单批输出约 1200 token，离 8k 上限还有余量，
 * 500 条 = 1 次规划 + 10 次分类，串行跑 2~4 分钟。 */
export const BATCH_SIZE = 50;
export const MAX_PER_RUN = 500;
/* 单批失败（超时 / 输出被截断 / 个别 JSON 坏了）时递归对半拆，
 * 拆到这么小还失败就只丢掉这一小撮，不让整轮 500 条陪葬。 */
const MIN_SPLIT = 10;

/* 置信度分三档，比一个精确到个位的百分数诚实：
 * 大模型对自己的把握估计得并不准，85 和 88 之间的差别没有意义。 */
export function tierOf(conf) {
  const c = Number(conf) || 0;
  if (c >= 85) return "很确定";
  if (c >= 60) return "可能";
  return "存疑";
}

/* ---------- 第一步：规划文件夹 ---------- */

export function buildPlanMessages(notes, folders) {
  const slots = Math.max(0, MAX_FOLDERS - folders.length);
  const existing = folders.length
    ? folders.map((f, i) => `${i + 1}. ${f.name}`).join("\n")
    : "（一个都没有，全部由你定）";
  const titles = notes.map((n) => n.title).join("\n");
  return [
    {
      role: "system",
      content:
        "你在帮用户给小红书收藏设计一套文件夹。判断依据只有标题和作者，不要臆测正文内容。\n" +
        "只输出 JSON，不要任何解释文字，格式：\n" +
        '{"folders":["文件夹名", ...]}\n' +
        "规则：\n" +
        "1) 输出完整文件夹清单：合适的现有文件夹原样保留名字，再补充需要的新文件夹；\n" +
        `2) 最终总数在 3 到 ${MAX_FOLDERS} 个之间` +
        (slots ? `，其中最多新增 ${slots} 个` : "——现有文件夹已满上限，只能全部复用现有名字") +
        "；\n" +
        "3) 每个名字不超过 6 个字、概括一类内容、彼此不重叠；宁少勿多，类目太多反而难用；\n" +
        "4) 实在归不进去的内容留给「未分类」，不要为它们硬造类目。"
    },
    {
      role: "user",
      content: `现有文件夹：\n${existing}\n\n收藏标题：\n${titles}`
    }
  ];
}

/* 把规划返回的 JSON 变成「要新建的文件夹名列表」：
 * 已有的名字剔除（那是复用）、去重、装饰字符剥掉、尊重 MAX_FOLDERS 余量。
 * 解析失败不抛错，返回空数组（还能靠第二步的兜底继续）。 */
export function parsePlan(content, folders) {
  const text = String(content == null ? "" : content).trim();
  const stripped = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let data = null;
  try {
    data = JSON.parse(stripped);
  } catch (e) {
    const m = stripped.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) return [];
    try {
      data = JSON.parse(m[0]);
    } catch (e2) {
      return [];
    }
  }
  let arr = Array.isArray(data) ? data : data.folders || data.names || data.list || [];
  if (!Array.isArray(arr)) return [];

  const slots = Math.max(0, MAX_FOLDERS - folders.length);
  const existing = new Set(folders.map((f) => String(f.name).trim()));
  const out = [];
  for (const raw of arr) {
    if (out.length >= slots) break;
    let name = raw;
    if (raw && typeof raw === "object") {
      if (raw.name == null) continue;
      name = raw.name;
    }
    name = String(name)
      .replace(/[「」『』《》"'“”【】:：]/g, "")
      .trim()
      .slice(0, 12);
    if (!name || existing.has(name) || out.includes(name)) continue;
    out.push(name);
  }
  return out;
}

/* ---------- 第二步：逐条分类 ---------- */

export function buildMessages(notes, folders) {
  const folderLines = folders.map((f, i) => `${i + 1}. ${f.name}`).join("\n");
  const noteLines = notes
    .map((n, i) => `${i + 1}. ${n.title}${n.author ? `（作者：${n.author}）` : ""}`)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "你在帮用户把小红书收藏归入文件夹。判断依据只有标题和作者，不要臆测正文内容。\n" +
        "只输出 JSON，不要任何解释文字，格式：\n" +
        '{"items":[{"i":1,"f":"文件夹名","c":85}]}\n' +
        "规则：\n" +
        "1) i 是笔记序号，从 1 开始，每条笔记都要出现一次；\n" +
        "2) f 从下面列出的文件夹里原样照抄一个——列表是刚为这批内容规划好的，" +
        "不要自创列表之外的名字；\n" +
        "3) 实在没有合适的就填 null，不要硬塞；\n" +
        "4) c 是 0-100 的整数，表示你有多确定；拿不准就把 c 写低。"
    },
    {
      role: "user",
      content: `文件夹：\n${folderLines}\n\n笔记：\n${noteLines}`
    }
  ];
}

/* 把模型返回的 JSON 变成 [{id, title, folderId, folderName, newFolder, confidence, tier}]
 * 对模型的各种不听话做兜底：带 ``` 包裹、多说话、给的是文件夹 id、给了不存在的名字、
 * 序号越界、重复序号、c 超出范围 —— 一律降级成「保持未分类」而不是抛错。
 * folders 里可能混着「拟新建」的伪文件夹（{id: null, isNew: true}）：
 * 命中它们时 folderId 留空、newFolder 记名字，由面板在确认后真正创建。 */
export function parseSuggestions(content, notes, folders) {
  const byName = new Map();
  for (const f of folders) byName.set(String(f.name).trim(), f);
  const byId = new Map(folders.filter((f) => f.id).map((f) => [f.id, f]));

  const text = String(content == null ? "" : content).trim();
  let data = null;
  const stripped = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    data = JSON.parse(stripped);
  } catch (e) {
    const m = stripped.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!m) throw new Error("AI 没返回 JSON");
    data = JSON.parse(m[0]);
  }

  const items = Array.isArray(data) ? data : data.items || data.result || data.list || [];
  const seen = new Map();

  /* 名字落到「真文件夹」还是「拟新建文件夹」 */
  const resolve = (entry) => {
    if (!entry) return { folder: null, newFolder: null };
    return entry.isNew
      ? { folder: null, newFolder: String(entry.name).trim() }
      : { folder: entry, newFolder: null };
  };

  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    let idx = Number(it.i != null ? it.i : it.index != null ? it.index : NaN);
    let note = null;
    if (Number.isFinite(idx) && idx >= 1 && idx <= notes.length) note = notes[idx - 1];
    if (!note && it.id) note = notes.find((n) => n.id === it.id);
    if (!note) continue;

    const rawName = it.f != null ? it.f : it.folder != null ? it.folder : it.folder_name;
    let folder = null;
    let newFolder = null;
    if (rawName != null && String(rawName).trim() && String(rawName).trim() !== "null") {
      let key = String(rawName).trim();
      /* 建议 new: 名字 —— 去掉前缀和装饰字符 */
      if (/^new[:：]/i.test(key)) {
        const proposed = key
          .replace(/^new[:：]/i, "")
          .replace(/[「」『』《》"'“”【】:：]/g, "")
          .trim()
          .slice(0, 12);
        if (proposed) {
          const hit = byName.get(proposed);
          if (hit) {
            const r = resolve(hit);
            folder = r.folder;
            newFolder = r.newFolder;
          } else newFolder = proposed;
        }
      } else {
        const entry = byName.get(key) || byId.get(key) || null;
        if (entry) {
          const r = resolve(entry);
          folder = r.folder;
          newFolder = r.newFolder;
        } else {
          /* 模型偶尔会加书名号、引号或者写「文件夹：菜谱」，再宽松匹配一次 */
          const loose = key.replace(/[「」『』《》"'“”【】:：]/g, "").trim();
          const hit =
            folders.find((f) => loose.includes(String(f.name).trim())) ||
            folders.find((f) => String(f.name).trim().includes(loose)) ||
            null;
          const r = resolve(hit);
          folder = r.folder;
          newFolder = r.newFolder;
        }
      }
    }

    const conf = folder || newFolder ? Math.max(0, Math.min(100, Math.round(Number(it.c) || 0))) : 0;
    seen.set(note.id, {
      id: note.id,
      title: note.title,
      folderId: folder ? folder.id : null,
      folderName: folder ? folder.name : "",
      newFolder: newFolder || null,
      confidence: conf,
      tier: folder || newFolder ? tierOf(conf) : "存疑"
    });
  }

  /* 模型漏掉的笔记也补一行，让用户看到「这条被看过了，但没给建议」 */
  return notes.map(
    (n) =>
      seen.get(n.id) || {
        id: n.id,
        title: n.title,
        folderId: null,
        folderName: "",
        newFolder: null,
        confidence: 0,
        tier: "存疑"
      }
  );
}

function httpError(status) {
  if (status === 401) return "Key 无效或已被删除";
  if (status === 402) return "DeepSeek 余额不足，去 platform.deepseek.com 充值";
  if (status === 429) return "请求太频繁，等一会儿再试";
  if (status >= 500) return "DeepSeek 服务端出错（" + status + "）";
  return "请求失败（HTTP " + status + "）";
}

async function callOnce({ apiKey, messages, signal, maxTokens = 1600, timeoutMs = 60000 }) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onAbort);
  }
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        response_format: { type: "json_object" },
        temperature: 0.1,
        max_tokens: maxTokens
      }),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(httpError(res.status));
    const json = await res.json();
    const content =
      json && json.choices && json.choices[0] && json.choices[0].message
        ? json.choices[0].message.content
        : "";
    if (!content) throw new Error("AI 返回为空");
    return content;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

/* Key 无效、余额不足、被限流这几种错误，重试和拆分都没意义，直接抛出去 */
function fatalAiError(e) {
  const msg = (e && e.message) || "";
  return /Key 无效|余额不足|请求太频繁|没有 DeepSeek Key/.test(msg);
}

function blankSuggestion(n) {
  return {
    id: n.id,
    title: n.title,
    folderId: null,
    folderName: "",
    newFolder: null,
    confidence: 0,
    tier: "存疑"
  };
}

/* 一批（或拆分后的半批）分类。
 * 500 条是长任务：单批超时 / 输出被截断不能让整轮白跑，
 * 所以失败就对半拆开重试，拆到 MIN_SPLIT 还失败就只把这几条标成
 * 「没给建议」，接着跑下一批。 */
async function classifyChunk({ apiKey, chunk, folders, signal, stat }) {
  try {
    const content = await callOnce({
      apiKey,
      messages: buildMessages(chunk, folders),
      signal,
      /* 一条建议约 25 token，留足余量，别让 JSON 说到一半被截断 */
      maxTokens: Math.min(8000, 300 + chunk.length * 45),
      timeoutMs: chunk.length > 20 ? 120000 : 90000
    });
    return parseSuggestions(content, chunk, folders);
  } catch (e) {
    if (signal && signal.aborted) throw e;
    if (fatalAiError(e)) throw e;
    if (chunk.length > MIN_SPLIT) {
      const mid = Math.ceil(chunk.length / 2);
      stat.splits++;
      const left = await classifyChunk({
        apiKey,
        chunk: chunk.slice(0, mid),
        folders,
        signal,
        stat
      });
      const right = await classifyChunk({
        apiKey,
        chunk: chunk.slice(mid),
        folders,
        signal,
        stat
      });
      return left.concat(right);
    }
    stat.failed += chunk.length;
    return chunk.map(blankSuggestion);
  }
}

/* 主入口：先规划、再分批分类。onProgress 用于面板进度条，signal 可中途取消。
 * folders 允许为空——AI 会从零建一套。
 * 进度事件里 batch/batches 是第几批；结束时 phase="done" 带 failed 条数。 */
export async function classify({ apiKey, notes, folders = [], onProgress, signal }) {
  if (!apiKey) throw new Error("没有 DeepSeek Key");
  const list = notes.slice(0, MAX_PER_RUN);
  if (!list.length) return [];

  const batches = Math.ceil(list.length / BATCH_SIZE);
  if (onProgress)
    onProgress({ phase: "plan", done: 0, total: list.length, batch: 0, batches });
  const planContent = await callOnce({
    apiKey,
    messages: buildPlanMessages(list, folders),
    signal,
    /* 规划只要一串文件夹名，给 800 token 绰绰有余；500 条标题一起进去要算一会儿 */
    maxTokens: 800,
    timeoutMs: 120000
  });
  const proposed = parsePlan(planContent, folders);
  const effective = folders.concat(
    proposed.map((name) => ({ id: null, name, isNew: true }))
  );
  if (!effective.length) {
    throw new Error("AI 没给出文件夹方案，再点一次「重新分析」试试");
  }

  const stat = { failed: 0, splits: 0 };
  const out = [];
  for (let i = 0; i < list.length; i += BATCH_SIZE) {
    const chunk = list.slice(i, i + BATCH_SIZE);
    const batch = Math.floor(i / BATCH_SIZE) + 1;
    if (onProgress)
      onProgress({ phase: "classify", done: i, total: list.length, batch, batches });
    const rows = await classifyChunk({
      apiKey,
      chunk,
      folders: effective,
      signal,
      stat
    });
    out.push(...rows);
    if (onProgress)
      onProgress({
        phase: "classify",
        done: i + chunk.length,
        total: list.length,
        batch,
        batches
      });
  }

  /* 全部分批都失败才算真失败——否则会显示成「分析完成 0 条」，让人以为 AI 说没救 */
  if (stat.failed >= list.length) {
    throw new Error("这一轮没拿到有效结果（超时或返回被截断），再点一次「重新分析」试试");
  }
  if (onProgress)
    onProgress({
      phase: "done",
      done: list.length,
      total: list.length,
      batches,
      failed: stat.failed
    });
  return capNewFolders(out, folders);
}

/* 模型分批跑可能合计报出超过余量的新建名字，这里统一收口：
 * 现有 + 新建不得超过 MAX_FOLDERS，超出的建议降级为「保持未分类」。 */
export function capNewFolders(results, folders) {
  const slots = Math.max(0, MAX_FOLDERS - folders.length);
  if (!slots) {
    return results.map((r) =>
      r.newFolder ? Object.assign({}, r, { newFolder: null, confidence: 0, tier: "存疑" }) : r
    );
  }
  const kept = new Set();
  return results.map((r) => {
    if (!r.newFolder) return r;
    const name = String(r.newFolder).trim();
    if (kept.has(name) || kept.size < slots) {
      kept.add(name);
      return r;
    }
    return Object.assign({}, r, { newFolder: null, confidence: 0, tier: "存疑" });
  });
}
