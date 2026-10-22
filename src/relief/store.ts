import OBR from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { fromStored, toStored, type StoredRelief } from "./codec";
import type { ReliefData } from "./types";

// Where reliefs are kept: on this device, not in the scene (its metadata is
// 16 kB shared by every extension). One a map image, by room. The
// background page owns them: it keeps them in its storage (always loaded
// while the room is open; an extension's windows don't reliably share the
// background's storage) and hands them to the other windows (the editor, the
// Vistazo, the panels) by local broadcast, in parts (a relief can be large);
// the editor sends its changes back the same way. Players and other devices
// don't have them yet.

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
  | { kind: "relief" | "save"; image: string; id: string; index: number; count: number; text: string };

/** A text as the messages that carry it (an empty text: the relief's gone). */
export function partsOf(kind: "relief" | "save", image: string, text: string): ReliefMessage[] {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const count = Math.max(1, Math.ceil(text.length / PART));
  return Array.from({ length: count }, (_, index) => ({ kind, image, id, index, count, text: text.slice(index * PART, (index + 1) * PART) }));
}

/** Parts put back together: each whole text once all its parts are in (a newer one for the same image wins). */
export function assembler(onWhole: (kind: "relief" | "save", image: string, text: string) => void) {
  const pending = new Map<string, { image: string; kind: "relief" | "save"; parts: string[]; got: number }>();
  const latest = new Map<string, string>();
  return (message: ReliefMessage) => {
    if (message.kind === "hello" || message.kind === "index") {
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
        onWhole(kind, image, entry.parts.join(""));
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
 * The background page's reliefs for the room: read from this device, handed
 * to every window that says hello, saved when a window sends one, and
 * `onChange` told each time (for the measuring done here).
 */
export async function startReliefService(onChange: (image: string, data: ReliefData | null) => void) {
  const roomId = OBR.room.id;
  for (const image of keptImages(roomId)) {
    onChange(image, fromStored(loadLocal(roomId, image)));
  }
  const handOut = (image: string) => {
    const stored = loadLocal(roomId, image);
    send(partsOf("relief", image, stored ? JSON.stringify(stored) : ""));
  };
  const take = assembler((kind, image, text) => {
    if (kind !== "save") {
      return;
    }
    const stored = text ? (JSON.parse(text) as StoredRelief) : null;
    if (!saveLocal(roomId, image, stored)) {
      console.error("Rising Ranges: the relief couldn't be kept on this device (storage full?)");
    }
    onChange(image, stored ? fromStored(stored) : null);
    handOut(image);
  });
  OBR.broadcast.onMessage(CHANNEL, (event) => {
    const message = event.data as ReliefMessage;
    if (message?.kind === "hello") {
      const images = keptImages(roomId);
      send([{ kind: "index", images }]);
      for (const image of images) {
        handOut(image);
      }
    } else if (message?.kind === "save") {
      take(message);
    }
  });
}

// ---------- A window's side ----------

/**
 * This window's reliefs from the background: all of them now (asked with a
 * hello, again until the background answers: it may not be up yet), then
 * each change. `onIndex`: which images have one, once the background answers.
 */
export function watchReliefs(onRelief: (image: string, data: ReliefData | null) => void, onIndex?: (images: string[]) => void): () => void {
  let answered = false;
  const take = assembler((kind, image, text) => {
    if (kind === "relief") {
      onRelief(image, text ? fromStored(JSON.parse(text)) : null);
    }
  });
  const stop = OBR.broadcast.onMessage(CHANNEL, (event) => {
    const message = event.data as ReliefMessage;
    if (message?.kind === "index" && !answered) {
      answered = true;
      onIndex?.(message.images);
    } else if (message?.kind === "relief") {
      take(message);
    }
  });
  let tries = 0;
  const hello = () => {
    if (answered || tries++ >= 20) {
      return;
    }
    send([{ kind: "hello" }]);
    retry = setTimeout(hello, 1000);
  };
  let retry: ReturnType<typeof setTimeout> | undefined;
  hello();
  return () => {
    clearTimeout(retry);
    stop();
  };
}

/** A window's relief for an image, sent to the background to keep (null: removed). */
export function saveRelief(image: string, data: ReliefData | null) {
  send(partsOf("save", image, data ? JSON.stringify(toStored(data)) : ""));
}
