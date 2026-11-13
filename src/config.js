/* 本机配置（这个文件会进仓库，所以不要往里写任何私钥）。
 *
 * DeepSeek Key 有两种放法，都不进仓库：
 * 1. 面板「⋯ → 设置」里填 —— 存在 chrome.storage.local，优先级最高，随时能改也能清空；
 * 2. 想固定在自己电脑上 —— 新建 src/config.local.js（已在 .gitignore 里），内容：
 *      export const DEFAULT_DEEPSEEK_KEY = "sk-你的key";
 */
export const DEFAULT_DEEPSEEK_KEY = "";

/* 可选的本机私钥文件；不存在就当作没配（浏览器与 Node 测试里都静默降级） */
const localKey = import("./config.local.js")
  .then((m) => (m && m.DEFAULT_DEEPSEEK_KEY) || "")
  .catch(() => "");

export function loadLocalKey() {
  return localKey;
}

/* DeepSeek 的对话模型。deepseek-chat 便宜且够用。 */
export const DEEPSEEK_MODEL = "deepseek-chat";

/* 文件夹上限：类目太多反而分类效果不好，超过 10 个就不再新建。 */
export const MAX_FOLDERS = 10;
