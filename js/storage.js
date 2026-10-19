// Browser-side persistence: the files of the last set loaded from disk (so a reload doesn't lose
// them) and per-game review progress. Storage can be unavailable (private windows, blocked site
// data), so every call fails quietly.

const DB_NAME = "autocr";
const SESSIONS = "sessions";
const REVIEWS = "reviews";
const KEY = "last";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      for (const store of [SESSIONS, REVIEWS]) {
        if (!req.result.objectStoreNames.contains(store)) {
          req.result.createObjectStore(store);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(name, mode, fn) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const req = fn(tx.objectStore(name));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn("AutoCR storage unavailable:", error);
    return undefined;
  }
}

/** @param {{id: number, title: string, files: Array<{name: string, text: string}>}} session */
export function saveSession(session) {
  return withStore(SESSIONS, "readwrite", (store) =>
    store.put({ ...session, savedAt: Date.now() }, KEY),
  );
}

export function loadSession() {
  return withStore(SESSIONS, "readonly", (store) => store.get(KEY));
}

export function clearSession() {
  return withStore(SESSIONS, "readwrite", (store) => store.delete(KEY));
}

/** @param {Object<string, {done: boolean, comment: string}>} reviews keyed by asset */
export function saveReviews(gameid, reviews) {
  return withStore(REVIEWS, "readwrite", (store) => store.put(reviews, gameid));
}

export async function loadReviews(gameid) {
  return (await withStore(REVIEWS, "readonly", (store) => store.get(gameid))) ?? {};
}
