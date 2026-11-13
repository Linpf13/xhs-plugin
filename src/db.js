const DB_NAME = "xhsfav";
const DB_VERSION = 2;
const NOTE_STORE = "notes";
const META_STORE = "meta";
const FOLDER_STORE = "folders";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(NOTE_STORE)) {
        const s = db.createObjectStore(NOTE_STORE, { keyPath: "id" });
        s.createIndex("firstSeen", "firstSeen");
        s.createIndex("folder", "folder");
      }
      if (!db.objectStoreNames.contains(FOLDER_STORE)) {
        const f = db.createObjectStore(FOLDER_STORE, { keyPath: "id" });
        f.createIndex("name", "name", { unique: false });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* 统一的事务封装。
 * fn(tx) 里派发请求，并返回一个「取值函数」，在事务提交后再调用，
 * 这样既能在 tx.oncomplete 里安全读结果，也不用给每个方法重复写一遍。
 */
function run(stores, mode, fn) {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        let getter;
        try {
          getter = fn(tx);
        } catch (e) {
          db.close();
          reject(e);
          return;
        }
        tx.oncomplete = () => {
          db.close();
          try {
            resolve(typeof getter === "function" ? getter() : getter);
          } catch (e) {
            reject(e);
          }
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      })
  );
}

/* 从收藏流响应里提取一条笔记。
 * 实测结构（2026-11，v2/note/collect/page，num=30）：
 *   { note_id, display_title, type, xsec_token,
 *     user: { user_id, nickname, avatar },
 *     interact_info: { liked, liked_count },
 *     cover: { url_pre, url_default, info_list: [{ image_scene, url }] } }
 * 旧版本会用 note_card 包一层，这里都兼容。
 */
export function extractNote(n) {
  if (!n) return null;
  const card = n.note_card || n;
  const id = n.note_id || n.id || card.note_id;
  if (!id) return null;

  const c = card.cover || {};
  let cover = c.url_pre || c.url_default || c.url || "";
  if (!cover && Array.isArray(c.info_list)) {
    const hitItem =
      c.info_list.find((i) => /DFT/i.test(String(i.image_scene || ""))) || c.info_list[0];
    cover = (hitItem && hitItem.url) || "";
  }
  /* 接口给的是 http://sns-webpic-qc.xhscdn.com/...，
   * 而扩展面板是 chrome-extension:// 安全上下文，http 图片会被当混合内容拦掉，
   * 表现为列表里全是灰块。统一升到 https。 */
  cover = String(cover).replace(/^http:\/\//i, "https://");

  const user = card.user || n.user || {};
  return {
    id,
    type: card.type || "normal",
    title: String(card.display_title || card.title || "").trim() || "（无标题）",
    author: user.nickname || user.nick_name || "",
    authorId: user.user_id || "",
    liked: String((card.interact_info && card.interact_info.liked_count) || ""),
    cover,
    xsecToken: card.xsec_token || n.xsec_token || "",
    xsecSource: card.xsec_source || n.xsec_source || "pc_collect",
    /* 归属：null = 未分类。纯本地字段，采集永不覆盖。 */
    folder: null,
    note: "",
    firstSeen: Date.now(),
    lastSeen: Date.now()
  };
}

export function saveNotes(items) {
  return run(NOTE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(NOTE_STORE);
    for (const item of items) {
      const getReq = store.get(item.id);
      getReq.onsuccess = () => {
        const prev = getReq.result;
        const merged = Object.assign({}, prev || {}, item, {
          /* 本地编辑过的字段不被采集覆盖 */
          folder: prev ? prev.folder : item.folder,
          note: prev ? prev.note : item.note,
          firstSeen: prev ? prev.firstSeen : item.firstSeen,
          lastSeen: item.lastSeen
        });
        store.put(merged);
      };
    }
    return items.length;
  });
}

export function getAllNotes() {
  return run(NOTE_STORE, "readonly", (tx) => {
    let out = [];
    const req = tx.objectStore(NOTE_STORE).getAll();
    req.onsuccess = () => {
      out = req.result || [];
    };
    return () => out;
  });
}

export function putNote(note) {
  return run(NOTE_STORE, "readwrite", (tx) => {
    tx.objectStore(NOTE_STORE).put(note);
    return note;
  });
}

/* 改单条：文件夹 / 备注都走这里 */
export function updateNote(id, patch) {
  return run(NOTE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(NOTE_STORE);
    const r = store.get(id);
    r.onsuccess = () => {
      const n = r.result;
      if (!n) return;
      Object.assign(n, patch);
      store.put(n);
    };
    return id;
  });
}

export function deleteNotes(ids) {
  return run(NOTE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(NOTE_STORE);
    for (const id of ids) store.delete(id);
    return ids.length;
  });
}

/* 批量改文件夹归属（纯本地）。folderId 传 null 表示移回未分类。 */
export function setNotesFolder(ids, folderId) {
  return run(NOTE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(NOTE_STORE);
    for (const id of ids) {
      const r = store.get(id);
      r.onsuccess = () => {
        const n = r.result;
        if (!n) return;
        n.folder = folderId || null;
        store.put(n);
      };
    }
    return ids.length;
  });
}

export function getAllFolders() {
  return run(FOLDER_STORE, "readonly", (tx) => {
    let out = [];
    const req = tx.objectStore(FOLDER_STORE).getAll();
    req.onsuccess = () => {
      out = req.result || [];
    };
    return () => out;
  });
}

export function putFolder(folder) {
  return run(FOLDER_STORE, "readwrite", (tx) => {
    tx.objectStore(FOLDER_STORE).put(folder);
    return folder;
  });
}

export function renameFolder(id, name) {
  return run(FOLDER_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(FOLDER_STORE);
    const r = store.get(id);
    r.onsuccess = () => {
      const f = r.result;
      if (!f) return;
      f.name = name;
      store.put(f);
    };
    return id;
  });
}

/* 删文件夹（本地壳）：只删这层壳，里面的笔记回到未分类（不动小红书、不删数据）。 */
export function deleteFolder(id) {
  return run([FOLDER_STORE, NOTE_STORE], "readwrite", (tx) => {
    tx.objectStore(FOLDER_STORE).delete(id);
    const notes = tx.objectStore(NOTE_STORE);
    const r = notes.getAll();
    r.onsuccess = () => {
      for (const n of r.result || []) {
        if (n.folder === id) {
          n.folder = null;
          notes.put(n);
        }
      }
    };
    return id;
  });
}

/* 删文件夹（UI 模拟取消收藏版，2026-11-13 定稿）：
 * 文件夹壳删除；里面的笔记标记 pendingUnfav（面板立即隐藏，但记录保留——
 * 取消收藏要走「打开笔记页点收藏按钮」的真人路径，需要每条的 xsec_token）。
 * 后台逐条取消成功后才 deleteNotes 真删；失败/中断的下次采集自动恢复。
 * 返回受影响的笔记 id 列表，调用方拿去排取消收藏队列。 */
export function deleteFolderUnfav(id) {
  return run([FOLDER_STORE, NOTE_STORE], "readwrite", (tx) => {
    const notes = tx.objectStore(NOTE_STORE);
    const r = notes.getAll();
    const ids = [];
    r.onsuccess = () => {
      for (const n of r.result || []) {
        if (n.folder === id) {
          ids.push(n.id);
          n.folder = null;
          n.pendingUnfav = true;
          notes.put(n);
        }
      }
      tx.objectStore(FOLDER_STORE).delete(id);
    };
    return () => ({ id, ids });
  });
}

/* 单条/批量取消收藏：同样先标记隐藏，成功后由后台真删。 */
export function markNotesPendingUnfav(ids) {
  return run(NOTE_STORE, "readwrite", (tx) => {
    const store = tx.objectStore(NOTE_STORE);
    for (const id of ids) {
      const r = store.get(id);
      r.onsuccess = () => {
        const n = r.result;
        if (!n) return;
        n.pendingUnfav = true;
        n.folder = null;
        store.put(n);
      };
    }
    return ids.length;
  });
}

export function getNote(id) {
  /* 空 id 直接返回 undefined：IndexedDB 的 get(undefined) 会抛 DataError */
  if (!id) return Promise.resolve(undefined);
  return run(NOTE_STORE, "readonly", (tx) => {
    let out;
    const req = tx.objectStore(NOTE_STORE).get(id);
    req.onsuccess = () => {
      out = req.result;
    };
    return () => out;
  });
}

/* 待取消收藏队列：删文件夹时攒下的笔记 id，
 * 由后台在小红书页面打开时逐条慢速执行，成功一条出队一条。 */
export async function getUnfavQueue() {
  const q = await getMeta("unfavQueue");
  return Array.isArray(q) ? q : [];
}

export function setUnfavQueue(ids) {
  return setMeta("unfavQueue", Array.isArray(ids) ? ids.filter(Boolean) : []);
}

export function clearAll() {
  return run([NOTE_STORE, FOLDER_STORE, META_STORE], "readwrite", (tx) => {
    tx.objectStore(NOTE_STORE).clear();
    tx.objectStore(FOLDER_STORE).clear();
    tx.objectStore(META_STORE).clear(); /* 连待取消队列一起清 */
    return true;
  });
}

/* 统计：条数、未分类数、各文件夹条数（pendingUnfav 的不算，它们即将消失）。 */
export async function getStats() {
  const notes = (await getAllNotes()).filter((n) => !n.pendingUnfav);
  const byFolder = {};
  let unclassified = 0;
  for (const n of notes) {
    if (n.folder) byFolder[n.folder] = (byFolder[n.folder] || 0) + 1;
    else unclassified++;
  }
  return { total: notes.length, unclassified, byFolder };
}

export function getMeta(key) {
  return run(META_STORE, "readonly", (tx) => {
    let out;
    const req = tx.objectStore(META_STORE).get(key);
    req.onsuccess = () => {
      out = req.result;
    };
    return () => out;
  });
}

export function setMeta(key, value) {
  return run(META_STORE, "readwrite", (tx) => {
    tx.objectStore(META_STORE).put(value, key);
    return value;
  });
}
