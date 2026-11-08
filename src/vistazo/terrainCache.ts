// The terrains last worked out, kept on this device (IndexedDB, from the terrain's worker: see
// terrainWorker) by what they were built from: the 3D Glance opened again on the same map, its terrain
// is read, not worked out again. A few kept, the ones used longest ago let go.

const DB = "rising-ranges-terrain";
/** The terrains, by key; and when each was last used (small: read whole to let the oldest go). */
const STORE = "terrains";
const TIMES = "used";
/** How many terrains are kept (each a few megabytes). */
const KEEP = 8;

let opened: Promise<IDBDatabase> | null = null;
/** The database once open (a value kept then can be put at once, before its arrays are handed over). */
let ready: IDBDatabase | null = null;

function db(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
      request.result.createObjectStore(TIMES);
    };
    request.onsuccess = () => {
      ready = request.result;
      // Another tab upgrading it: let go (opened again next time).
      ready.onversionchange = () => {
        ready?.close();
        ready = null;
        opened = null;
      };
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
  // Failed (blocked, private window): asked again the next time.
  opened.catch(() => (opened = null));
  return opened;
}

function asked<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** A key as a short digest of what it says (SHA-256, hex). */
export async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What's kept under a key (marked used now), or undefined: none, or it can't be read. */
export async function cached<T>(key: string): Promise<T | undefined> {
  try {
    const t = (await db()).transaction([STORE, TIMES], "readwrite");
    const value = (await asked(t.objectStore(STORE).get(key))) as T | undefined;
    if (value !== undefined) {
      t.objectStore(TIMES).put(Date.now(), key);
    }
    return value;
  } catch {
    return undefined;
  }
}

/**
 * A value kept under a key, the ones used longest ago let go past KEEP. Copied as it's called (put at
 * once, or cloned while the database opens): its arrays can be handed over right after. Not waited
 * for; a failure (no room, a private window) only means it isn't kept.
 */
export function keep<T>(key: string, value: T) {
  const put = (database: IDBDatabase, v: T) => {
    const t = database.transaction([STORE, TIMES], "readwrite");
    t.objectStore(STORE).put(v, key);
    t.objectStore(TIMES).put(Date.now(), key);
    return t;
  };
  void (async () => {
    try {
      const t = ready ? put(ready, value) : null;
      const copy = t ? null : structuredClone(value);
      const database = await db();
      if (copy !== null) {
        put(database, copy);
      }
      const times = database.transaction([STORE, TIMES], "readwrite");
      const used = times.objectStore(TIMES);
      const [keys, ats] = await Promise.all([asked(used.getAllKeys()), asked(used.getAll())]);
      if (keys.length > KEEP) {
        const order = keys.map((k, i) => [k, ats[i] as number] as const).sort((a, b) => a[1] - b[1]);
        for (const [k] of order.slice(0, keys.length - KEEP)) {
          used.delete(k);
          times.objectStore(STORE).delete(k);
        }
      }
    } catch {
      // Not kept.
    }
  })();
}
