import OBR, { type Item } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { fromStored, toStored, type StoredRelief } from "./codec";
import type { ReliefData } from "./types";
import { ITEM_KEY, itemsOf, pack, partOf, partsOfText, reliefItemsKey, reliefsIn, unpack, versionId } from "./sceneItems";

// Where reliefs are kept: in the scene, in hidden items of their own (see
// sceneItems.ts; not the scene's metadata, 16 kB shared by every
// extension), so every client has them. One a map image. The background
// page reads them and hands them to the other windows (the editor, the
// Vistazo, the panels) by local broadcast, in parts (a relief can be large);
// the GM's editor sends its changes back the same way, and the GM's
// background writes them. (An earlier version kept them on the device:
// loadLocal and the like are left for moving those up.)

const CHANNEL = getPluginId("relief");
const PREFIX = "rising-ranges/relief/";
/** The most characters in one message (well under any limit a broadcast may have). */
const PART = 12000;

export const storageKey = (roomId: string, imageId: string) => `${PREFIX}${roomId}/${imageId}`;

/** A relief kept on this device, if any (and one this version can read). */
export function loadLocal(roomId: string, imageId: string): StoredRelief | null {
  try {
    const text = localStorage.getItem(storageKey(roomId, imageId));
    return text ? (JSON.parse(text) as StoredRelief) : null;
  } catch {
    return null;
  }
}

/** Kept (or, null, removed); false if it couldn't be (storage full or blocked). */
export function saveLocal(roomId: string, imageId: string, stored: StoredRelief | null): boolean {
  try {
    if (stored) {
      localStorage.setItem(storageKey(roomId, imageId), JSON.stringify(stored));
    } else {
      localStorage.removeItem(storageKey(roomId, imageId));
    }
    return true;
  } catch {
    return false;
  }
}

/** The images of a room with a relief kept here. */
export function keptImages(roomId: string): string[] {
  const prefix = `${PREFIX}${roomId}/`;
  const ids: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) {
        ids.push(key.slice(prefix.length));
      }
    }
  } catch {
    // None to be had.
  }
  return ids;
}

// ---------- Messages, in parts ----------

/**
 * "hello": a window asking for them all; "index": the background's answer,
 * the images with one (each then follows as "relief"); "relief": one of the
 * background's, for the windows; "save": a window's, for the background.
 */
export type ReliefMessage =
  | { kind: "hello" }
  | { kind: "index"; images: string[] }
  /** The background's answer to a save (its parts' `id`): whether it was kept in the scene. */
  | { kind: "saved"; image: string; id: string; ok: boolean }
  | { kind: "relief" | "save"; image: string; id: string; index: number; count: number; text: string };

/** A text as the messages that carry it (an empty text: the relief's gone). */
export function partsOf(kind: "relief" | "save", image: string, text: string): ReliefMessage[] {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const count = Math.max(1, Math.ceil(text.length / PART));
  return Array.from({ length: count }, (_, index) => ({ kind, image, id, index, count, text: text.slice(index * PART, (index + 1) * PART) }));
}

/** Parts put back together: each whole text once all its parts are in (a newer one for the same image wins). */
export function assembler(onWhole: (kind: "relief" | "save", image: string, text: string, id: string) => void) {
  const pending = new Map<string, { image: string; kind: "relief" | "save"; parts: string[]; got: number }>();
  const latest = new Map<string, string>();
  return (message: ReliefMessage) => {
    if (message.kind === "hello" || message.kind === "index" || message.kind === "saved") {
      return;
    }
    const { kind, image, id, index, count, text } = message;
    let entry = pending.get(id);
    if (!entry) {
      // The newest for its image: the last one started (a late part of an older one doesn't count).
      latest.set(`${kind}/${image}`, id);
      entry = { image, kind, parts: new Array(count).fill(null), got: 0 };
      pending.set(id, entry);
    }
    if (entry.parts[index] === null) {
      entry.parts[index] = text;
      entry.got++;
    }
    if (entry.got === count) {
      pending.delete(id);
      // An older one finishing after a newer one started: dropped.
      if (latest.get(`${kind}/${image}`) === id) {
        onWhole(kind, image, entry.parts.join(""), id);
      }
    }
  };
}

const send = (messages: ReliefMessage[]) => {
  for (const message of messages) {
    OBR.broadcast.sendMessage(CHANNEL, message, { destination: "LOCAL" }).catch((error) => {
      console.error("Rising Ranges: a relief message didn't go", error);
    });
  }
};

// ---------- The background's side ----------

/**
 * The background page's reliefs for the scene: read from its relief items
 * (see sceneItems.ts) on every client, handed to every window that says
 * hello (once they're read: before, a window would start from nothing),
 * written when the GM's editor sends one, and `onChange` told each time
 * (for the measuring done here). A relief kept on this device by an earlier
 * version goes up to the scene the first time (the GM's).
 */
export async function startReliefService(onChange: (image: string, data: ReliefData | null) => void) {
  /** Each image's relief as handed out: its stored JSON. */
  const texts = new Map<string, string>();
  let ready = false;
  let seen: string | null = null;
  let role: "GM" | "PLAYER" = await OBR.player.getRole();
  OBR.player.onChange((player) => {
    role = player.role;
  });
  const handOut = (image: string) => send(partsOf("relief", image, texts.get(image) ?? ""));
  /**
   * What this GM last wrote of each image: Owlbear's own undo takes back
   * changes to items (seen live), so a version older than this, or the
   * items gone while the map's still there, is put back (the relief's undo
   * is the editor's).
   */
  const mine = new Map<string, { v: string; text: string }>();

  // Reading: one pass at a time, of the newest items.
  let latest: Item[] | null = null;
  /** The scene's items, as last told (what a save may be for: see saved). */
  let inScene = new Set<string>();
  let reading = false;
  const read = async () => {
    if (reading) {
      return;
    }
    reading = true;
    try {
      while (latest) {
        const items: Item[] = latest;
        latest = null;
        const key = reliefItemsKey(items);
        if (key === seen) {
          continue;
        }
        seen = key;
        const found = reliefsIn(items);
        for (const [image, own] of mine) {
          const kept = found.get(image);
          const undone = kept === undefined ? items.some((item) => item.id === image) : kept !== "partial" && kept.v < own.v;
          if (undone && !toWrite.has(image)) {
            toWrite.set(image, { text: own.text });
            void write();
          }
        }
        for (const [image, kept] of found) {
          if (kept === "partial") {
            continue;
          }
          const own = mine.get(image);
          if (own && kept.v < own.v) {
            // Taken back by Owlbear's undo: being put back (above), not handed out.
            continue;
          }
          let text: string;
          try {
            text = await unpack(kept.packed);
            JSON.parse(text);
          } catch (error) {
            console.error("Rising Ranges: a relief in the scene couldn't be read", error);
            continue;
          }
          if (texts.get(image) !== text) {
            texts.set(image, text);
            onChange(image, fromStored(JSON.parse(text)));
            if (ready) {
              handOut(image);
            }
          }
        }
        for (const image of [...texts.keys()]) {
          if (!found.has(image)) {
            texts.delete(image);
            onChange(image, null);
            if (ready) {
              handOut(image);
            }
          }
        }
        if (!ready) {
          ready = true;
          void migrate(items);
          // A scene read (the first, or after a change of scene, see onReadyChange): the windows already
          // open have the last one's, and won't ask again.
          send([{ kind: "index", images: [...texts.keys()] }]);
          for (const image of texts.keys()) {
            handOut(image);
          }
        }
      }
    } finally {
      reading = false;
    }
  };
  const take = (items: Item[]) => {
    latest = items;
    inScene = new Set(items.map((item) => item.id));
    void read();
  };

  /** The scene's relief items for an image made `text` (empty: removed): in place, or the new ones added before the old go. */
  const writeRelief = async (image: string, text: string) => {
    const old = await OBR.scene.items.getItems((item) => item.attachedTo === image && partOf(item) !== undefined);
    if (!text) {
      mine.delete(image);
      if (old.length > 0) {
        await OBR.scene.items.deleteItems(old.map((item) => item.id));
      }
      return;
    }
    const [map] = await OBR.scene.items.getItems([image]);
    if (!map) {
      return;
    }
    const parts = partsOfText(await pack(text), versionId());
    if (old.length === parts.length) {
      const order = [...old].sort((a, b) => partOf(a)!.index - partOf(b)!.index).map((item) => item.id);
      await OBR.scene.items.updateItems(order, (drafts) => {
        for (const draft of drafts) {
          draft.metadata[ITEM_KEY] = parts[order.indexOf(draft.id)];
        }
      });
      // Only once it's there (a write refused isn't put back over and over).
      mine.set(image, { v: parts[0].v, text });
      return;
    }
    await OBR.scene.items.addItems(itemsOf(map, parts));
    mine.set(image, { v: parts[0].v, text });
    if (old.length > 0) {
      await OBR.scene.items.deleteItems(old.map((item) => item.id));
    }
  };
  // Writing (the GM's): one at a time, the newest for each image; `id`, the save it answers (none: put back after an undo).
  const toWrite = new Map<string, { text: string; id?: string }>();
  const answer = (image: string, id: string | undefined, ok: boolean) => {
    if (id) {
      send([{ kind: "saved", image, id, ok }]);
    }
  };
  let writing = false;
  const write = async () => {
    if (writing) {
      return;
    }
    writing = true;
    try {
      while (toWrite.size > 0) {
        const [image, { text, id }] = toWrite.entries().next().value as [string, { text: string; id?: string }];
        toWrite.delete(image);
        try {
          await writeRelief(image, text);
          // Taken as it is now, without waiting to hear back from the scene (nor counting on it: the
          // same text, or a change of this client's own maybe not told back to it): the editor's told it's kept.
          if ((texts.get(image) ?? "") !== text) {
            if (text) {
              texts.set(image, text);
            } else {
              texts.delete(image);
            }
            onChange(image, text ? fromStored(JSON.parse(text)) : null);
          }
          handOut(image);
          answer(image, id, true);
        } catch (error) {
          console.error("Rising Ranges: the relief couldn't be kept in the scene", error);
          // What's there handed out again, and the editor told it wasn't kept.
          handOut(image);
          answer(image, id, false);
        }
      }
    } finally {
      writing = false;
    }
  };
  const saved = assembler((kind, image, text, id) => {
    if (kind !== "save") {
      return;
    }
    if (role !== "GM") {
      handOut(image);
      answer(image, id, false);
      return;
    }
    // Its map image not in this scene (a save sent as the scene changed, its editor closing): not written
    // here, where it'd be a relief of nothing.
    if (!inScene.has(image)) {
      answer(image, id, false);
      return;
    }
    // A save still waiting is replaced by this newer one (its editor only waits for the answer to its last).
    toWrite.set(image, { text, id });
    void write();
  });

  /** Reliefs this device kept (an earlier version's way) for maps of this scene with none in it: up to the scene, then forgotten here. */
  const migrate = async (items: Item[]) => {
    if (role !== "GM") {
      return;
    }
    const roomId = OBR.room.id;
    for (const image of keptImages(roomId)) {
      const stored = loadLocal(roomId, image);
      if (!stored || texts.has(image) || !items.some((item) => item.id === image)) {
        continue;
      }
      try {
        await writeRelief(image, JSON.stringify(stored));
        saveLocal(roomId, image, null);
      } catch (error) {
        console.error("Rising Ranges: a relief kept on this device couldn't go up to the scene", error);
      }
    }
  };

  OBR.broadcast.onMessage(CHANNEL, (event) => {
    const message = event.data as ReliefMessage;
    if (message?.kind === "hello") {
      if (!ready) {
        // Not read yet: the window asks again.
        return;
      }
      const images = [...texts.keys()];
      send([{ kind: "index", images }]);
      for (const image of images) {
        handOut(image);
      }
    } else if (message?.kind === "save") {
      saved(message);
    }
  });
  OBR.scene.items.onChange(take);
  OBR.scene.onReadyChange((sceneReady) => {
    if (sceneReady) {
      OBR.scene.items.getItems().then(take, (error) => console.error("Rising Ranges: the scene's reliefs couldn't be read", error));
      return;
    }
    // Another scene: none of these (the windows told, see watchReliefs' index).
    ready = false;
    inScene = new Set();
    seen = null;
    mine.clear();
    for (const image of [...texts.keys()]) {
      texts.delete(image);
      onChange(image, null);
    }
    send([{ kind: "index", images: [] }]);
  });
  if (await OBR.scene.isReady()) {
    take(await OBR.scene.items.getItems());
  }
}

// ---------- A window's side ----------

/**
 * This window's reliefs from the background: all of them now (asked with a
 * hello, again until the background answers: it may not be up yet), then
 * each change. `onIndex`: which images have one, once the background has
 * answered and every one of them has come (they follow the index, in parts:
 * before that, an editor would start from nothing).
 */
export function watchReliefs(onRelief: (image: string, data: ReliefData | null) => void, onIndex?: (images: string[]) => void): () => void {
  let known = false;
  /** The images of the index not come yet. */
  let waiting: Set<string> | null = null;
  let listed: string[] = [];
  const complete = () => {
    if (!known && waiting && waiting.size === 0) {
      known = true;
      clearTimeout(retry);
      onIndex?.(listed);
    }
  };
  /**
   * The text of each image's relief this window has: one sent again unchanged (every window's hello
   * has the background send them all) isn't taken again (a relief worked out again, the Vistazo
   * rebuilt).
   */
  const have = new Map<string, string>();
  const take = assembler((kind, image, text) => {
    if (kind === "relief") {
      if ((have.get(image) ?? "") !== text) {
        if (text) {
          have.set(image, text);
        } else {
          have.delete(image);
        }
        onRelief(image, text ? fromStored(JSON.parse(text)) : null);
      }
      waiting?.delete(image);
      complete();
    }
  });
  const stop = OBR.broadcast.onMessage(CHANNEL, (event) => {
    const message = event.data as ReliefMessage;
    if (message?.kind === "index" && known) {
      // Another scene read (see the background's): those not in it are gone; the rest follow.
      for (const image of [...have.keys()]) {
        if (!message.images.includes(image)) {
          have.delete(image);
          onRelief(image, null);
        }
      }
    } else if (message?.kind === "index") {
      listed = message.images;
      waiting = new Set(message.images);
      complete();
    } else if (message?.kind === "relief") {
      take(message);
    }
  });
  let tries = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  // Again (everything sent again) until it's all come: a part may have been lost.
  const hello = () => {
    if (known || tries++ >= 20) {
      return;
    }
    send([{ kind: "hello" }]);
    retry = setTimeout(hello, 1500);
  };
  hello();
  return () => {
    clearTimeout(retry);
    stop();
  };
}

/** A window's relief for an image, sent to the background to keep (null: removed): the save's id (see onSaved). */
export function saveRelief(image: string, data: ReliefData | null): string {
  const parts = partsOf("save", image, data ? JSON.stringify(toStored(data)) : "");
  send(parts);
  return (parts[0] as { id: string }).id;
}

/** The background's answers to saves (see saveRelief): each save's id, and whether it was kept. */
export function onSaved(listener: (image: string, id: string, ok: boolean) => void): () => void {
  return OBR.broadcast.onMessage(CHANNEL, (event) => {
    const message = event.data as ReliefMessage;
    if (message?.kind === "saved") {
      listener(message.image, message.id, message.ok);
    }
  });
}
