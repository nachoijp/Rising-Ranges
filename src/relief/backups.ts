// The last few versions of each image's relief, kept on this device (in
// IndexedDB: a relief can be megabytes, more than localStorage holds): the
// one editing began from, and each one "Done" left. Restored from the
// editor's menu if one was lost (a wrong save, a slip that couldn't be
// undone).

const DB = "rising-ranges";
const STORE = "relief-backups";
/** How many versions an image keeps (the oldest let go). */
const KEEP = 5;

/** A version kept: when, and the relief as stored (codec.ts), as JSON. */
export type Backup = { at: number; json: string };

let opened: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
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

/** An image's versions, the newest first (none if they can't be read). */
export async function backupsOf(imageId: string): Promise<Backup[]> {
  try {
    const store = (await db()).transaction(STORE, "readonly").objectStore(STORE);
    return ((await asked(store.get(imageId))) as Backup[] | undefined) ?? [];
  } catch {
    return [];
  }
}

/** A version kept (not if it's the newest already kept); false if it couldn't be. */
export async function keepBackup(imageId: string, json: string): Promise<boolean> {
  try {
    const list = await backupsOf(imageId);
    if (list[0]?.json === json) {
      return true;
    }
    const store = (await db()).transaction(STORE, "readwrite").objectStore(STORE);
    await asked(store.put([{ at: Date.now(), json }, ...list].slice(0, KEEP), imageId));
    return true;
  } catch {
    return false;
  }
}
