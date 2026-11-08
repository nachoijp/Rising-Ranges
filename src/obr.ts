// What every page imports as "@owlbear-rodeo/sdk" (see the alias in vite.config.js): Owlbear's SDK as
// it is; but in the 3D Glance opened in a tab of its own (vistazo.html?tab, in the tab's page: see
// vistazo/tabHost.ts), far from Owlbear's frame the SDK talks to, a stand-in that hands each call to the
// extension's background inside Owlbear (see background/tabRelay.ts), through the tab's page, and its
// answer back. Calls go by their path
// ("scene.items.getItems") and plain arguments; a callback (an onChange's) stays here, the background
// telling it what to call it with. The few calls that take a function to run on Owlbear's items (an
// update's) run it here, on copies, and send what it changed.
import Real from "@owlbear-rodeo/sdk/lib/index.js";
import type { Item } from "@owlbear-rodeo/sdk/lib/index.js";

export * from "@owlbear-rodeo/sdk/lib/index.js";

/** A message between the tab and the background (see tabRelay.ts). `session`: the tab's, for the background to answer it alone. */
export type TabMessage =
  | { rrTab: "find"; session: string; since: number }
  | { rrTab: "taken"; session: string }
  | { rrTab: "closed"; session: string }
  | { rrTab: "found"; session: string; playerId: string; ready: boolean }
  | { rrTab: "call"; session: string; id: number; path: string; args: unknown[] }
  | { rrTab: "result"; session: string; id: number; value?: unknown; error?: string }
  | { rrTab: "event"; session: string; fn: number; args: unknown[] }
  | { rrTab: "drop"; session: string; fn: number }
  | { rrTab: "beat"; session: string }
  | { rrTab: "bye"; session: string };

/** A function argument as it's sent: the background calls back with its number. */
export type FnMark = { rrFn: number };
/** What an update changed on an item: its own fields (as they are now), its metadata's keys set and gone. */
export type ItemPatch = { id: string; fields: Record<string, unknown>; set: Record<string, unknown>; gone: string[] };

/** Whether this page is the Vistazo in a tab of its own. */
export const IN_TAB = typeof window !== "undefined" && typeof location !== "undefined" && window.parent !== window && new URLSearchParams(location.search).has("tab");

/** What an update did to items (copies, before and after): only what differs, for the background to do the same. */
export function patchesOf(before: Item[], after: Item[]): ItemPatch[] {
  return after.map((item, i) => {
    const was = before[i] as unknown as Record<string, unknown>;
    const now = item as unknown as Record<string, unknown>;
    const fields: Record<string, unknown> = {};
    for (const key of Object.keys(now)) {
      if (key !== "metadata" && JSON.stringify(now[key]) !== JSON.stringify(was[key])) {
        fields[key] = now[key];
      }
    }
    const set: Record<string, unknown> = {};
    const oldMeta = (was.metadata ?? {}) as Record<string, unknown>;
    const newMeta = (now.metadata ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(newMeta)) {
      if (JSON.stringify(newMeta[key]) !== JSON.stringify(oldMeta[key])) {
        set[key] = newMeta[key];
      }
    }
    return { id: item.id, fields, set, gone: Object.keys(oldMeta).filter((key) => !(key in newMeta)) };
  });
}

/** A patch done to an item (a draft of Owlbear's). */
export function applyPatch(item: Item, patch: ItemPatch) {
  const target = item as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch.fields)) {
    target[key] = value;
  }
  for (const [key, value] of Object.entries(patch.set)) {
    item.metadata[key] = value;
  }
  for (const key of patch.gone) {
    delete item.metadata[key];
  }
}

function tabOBR(): typeof Real {
  const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const origin = window.origin;
  let relay: Window | null = null;
  let playerId = "";
  let ready = false;
  let calls = 0;
  const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let fns = 0;
  const callbacks = new Map<number, (...args: unknown[]) => unknown>();
  const whenFound: (() => void)[] = [];
  let lastHeard = 0;
  let ended: "closed" | "taken" | null = null;
  const since = Date.now();
  // All through the tab's page (it finds the background, and passes each message on).
  const host = window.parent;
  const search = () => host.postMessage({ rrTab: "find", session, since } satisfies TabMessage, origin);
  const post = (message: TabMessage) => relay && host.postMessage(message, origin);

  window.addEventListener("message", (event) => {
    const data = event.data as TabMessage | null;
    if (event.origin !== origin || event.source !== host || !data?.rrTab || data.session !== session) {
      return;
    }
    lastHeard = performance.now();
    if (data.rrTab === "closed" || data.rrTab === "taken") {
      ended = data.rrTab;
    } else if (data.rrTab === "found") {
      const first = !relay;
      relay = host;
      ended = null;
      playerId = data.playerId;
      ready = data.ready;
      if (first) {
        whenFound.splice(0).forEach((f) => f());
      }
    } else if (data.rrTab === "result") {
      const call = waiting.get(data.id);
      waiting.delete(data.id);
      if (data.error !== undefined) {
        call?.reject(new Error(data.error));
      } else {
        call?.resolve(data.value);
      }
    } else if (data.rrTab === "event") {
      callbacks.get(data.fn)?.(...data.args);
    }
  });
  // Looked for till found; then a beat now and then, for the background to tell when this tab's gone.
  search();
  window.setInterval(() => (ended === "taken" ? undefined : relay ? post({ rrTab: "beat", session }) : search()), 1000);
  window.addEventListener("pagehide", () => post({ rrTab: "bye", session }));

  const call = (path: string, args: unknown[]): Promise<unknown> => {
    const id = ++calls;
    const plain = args.map((arg) => {
      if (typeof arg !== "function") {
        return arg;
      }
      const fn = ++fns;
      callbacks.set(fn, arg as (...a: unknown[]) => unknown);
      return { rrFn: fn } satisfies FnMark;
    });
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      const send = () => post({ rrTab: "call", session, id, path, args: plain });
      if (relay) {
        send();
      } else {
        whenFound.push(send);
      }
    });
  };

  // The calls that take a function to run on the items: run here, on copies.
  const getItems = (local: boolean) => async (filter?: unknown) => {
    const path = local ? "scene.local.getItems" : "scene.items.getItems";
    if (typeof filter === "function") {
      return ((await call(path, [])) as Item[]).filter(filter as (item: Item) => boolean);
    }
    return call(path, filter === undefined ? [] : [filter]);
  };
  const updateItems = (local: boolean) => async (which: unknown, update: (drafts: Item[]) => void) => {
    const base = local ? "scene.local" : "scene.items";
    const items =
      typeof which === "function"
        ? ((await call(`${base}.getItems`, [])) as Item[]).filter(which as (item: Item) => boolean)
        : ((await call(`${base}.getItems`, [(which as (string | Item)[]).map((x) => (typeof x === "string" ? x : x.id))])) as Item[]);
    const after = structuredClone(items);
    update(after);
    await call(`${base}.updatePatched`, [patchesOf(items, after)]);
  };
  const startItemInteraction = async (start: Item | Item[]) => {
    const handle = (await call("interaction.startPatched", [start])) as number;
    let now = structuredClone(start);
    const update = (f: (draft: Item | Item[]) => void) => {
      const before = now;
      now = structuredClone(before);
      f(now);
      const list = (x: Item | Item[]) => (Array.isArray(x) ? x : [x]);
      void call("interaction.updatePatched", [handle, patchesOf(list(before), list(now))]);
      return now;
    };
    const stop = () => void call("interaction.stopPatched", [handle]);
    return [update, stop];
  };

  const special: Record<string, unknown> = {
    "scene.items.getItems": getItems(false),
    "scene.local.getItems": getItems(true),
    "scene.items.updateItems": updateItems(false),
    "scene.local.updateItems": updateItems(true),
    "interaction.startItemInteraction": startItemInteraction,
  };
  const values: Record<string, () => unknown> = {
    isAvailable: () => true,
    isReady: () => ready,
    "player.id": () => playerId,
  };

  const at = (path: string): unknown =>
    new Proxy(() => {}, {
      get(_target, key) {
        if (typeof key !== "string" || key === "then") {
          return undefined;
        }
        const next = path ? `${path}.${key}` : key;
        if (next in values) {
          return values[next]();
        }
        if (next === "onReady") {
          return (callback: () => void) => (relay ? callback() : whenFound.push(callback));
        }
        return special[next] ?? at(next);
      },
      apply(_target, _this, args: unknown[]) {
        const result = call(path, args);
        // A subscription: what it answers is how to end it (its callbacks let go here and there).
        if (/\.on[A-Z]\w*$/.test(path)) {
          void result.catch(() => {});
          return () => {
            for (const [fn, callback] of callbacks) {
              if (args.includes(callback)) {
                callbacks.delete(fn);
                post({ rrTab: "drop", session, fn });
              }
            }
          };
        }
        return result;
      },
    });
  state = () => ended ?? (!relay ? "searching" : performance.now() - lastHeard > 4000 ? "lost" : "connected");
  return at("") as typeof Real;
}

let state: () => TabState = () => "connected";
/** How the tab's link to Owlbear is (see vistazo/tab.ts): looking for it, there, gone quiet, Owlbear closed or reloaded. */
export type TabState = "searching" | "connected" | "lost" | "closed" | "taken";
export const tabState = (): TabState => state();

export default (IN_TAB ? tabOBR() : Real) as typeof Real;
