// Remembers the files of the last set loaded from disk, so a reload doesn't lose them.
// Storage can be unavailable (private windows, blocked site data), so every call fails quietly.

const DB_NAME = "autocr";
const STORE = "sessions";
const KEY = "last";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  try {
    const db = await openDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
    });
  } catch (error) {
    console.warn("AutoCR session storage unavailable:", error);
    return undefined;
  }
}

/** @param {{id: number, title: string, files: Array<{name: string, text: string}>}} session */
export function saveSession(session) {
  return withStore("readwrite", (store) => store.put({ ...session, savedAt: Date.now() }, KEY));
}

export function loadSession() {
  return withStore("readonly", (store) => store.get(KEY));
}

export function clearSession() {
  return withStore("readwrite", (store) => store.delete(KEY));
}
