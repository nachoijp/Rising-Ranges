import OBR from "@owlbear-rodeo/sdk";
import { BandSet } from "../engine/types";
import { getPluginId } from "../util/getPluginId";
import { customBandSetsFromMetadata, isBandSet } from "./bandSets";

// The room's own ranges (custom BandSets): one list for every scene of the
// room, kept in the room's metadata (on Owlbear's servers: any machine that
// opens the room has it). That metadata is 16 kB shared by every extension,
// so the list is kept small: at most MAX_RANGES, compressed (deflate, as
// base64), under BUDGET characters; more go to a file (export/import).
// Earlier versions kept the list in each scene's metadata: it's moved up
// the first time the settings open in that scene (see adoptSceneRanges).

const KEY = getPluginId("ranges");
const SCENE_KEY = getPluginId("bandSets");

/** The most ranges a room keeps. */
export const MAX_RANGES = 5;
/** The most characters the stored list may take (well under the room's 16 kB, shared by all extensions). */
export const BUDGET = 3000;

/** How the list is stored: "z1:" + base64(deflate-raw(JSON)); or "j1:" + JSON where the browser can't compress. */
const ZIP = "z1:";
const RAW = "j1:";

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** The list as it's stored. */
export async function encodeRanges(ranges: BandSet[]): Promise<string> {
  const json = JSON.stringify(ranges);
  if (typeof CompressionStream === "undefined") {
    return RAW + json;
  }
  return ZIP + toBase64(await through(new TextEncoder().encode(json), new CompressionStream("deflate-raw")));
}

/** The list from what's stored (any version this one knows; nothing it can't read). */
export async function decodeRanges(stored: unknown): Promise<BandSet[]> {
  try {
    let value: unknown = stored;
    if (typeof stored === "string" && stored.startsWith(ZIP)) {
      value = JSON.parse(new TextDecoder().decode(await through(fromBase64(stored.slice(ZIP.length)), new DecompressionStream("deflate-raw"))));
    } else if (typeof stored === "string" && stored.startsWith(RAW)) {
      value = JSON.parse(stored.slice(RAW.length));
    }
    return Array.isArray(value) ? value.filter(isBandSet) : [];
  } catch (error) {
    console.warn("Rising Ranges: the room's ranges couldn't be read", error);
    return [];
  }
}

/** The room's ranges now. */
export async function loadRanges(): Promise<BandSet[]> {
  return decodeRanges((await OBR.room.getMetadata())[KEY]);
}

export type SaveResult = { ok: true } | { ok: false; reason: "tooMany" | "tooBig" | "failed" };

/** Keeps the room's ranges (all of them, as they are now). Never writes more than MAX_RANGES or BUDGET. */
export async function saveRanges(ranges: BandSet[]): Promise<SaveResult> {
  if (ranges.length > MAX_RANGES) {
    return { ok: false, reason: "tooMany" };
  }
  const stored = await encodeRanges(ranges);
  if (stored.length > BUDGET) {
    return { ok: false, reason: "tooBig" };
  }
  try {
    await OBR.room.setMetadata({ [KEY]: ranges.length > 0 ? stored : undefined });
    return { ok: true };
  } catch (error) {
    console.warn("Rising Ranges: the room's ranges couldn't be saved", error);
    return { ok: false, reason: "failed" };
  }
}

/** Calls back with the room's ranges whenever they change (another GM's edit too). */
export function onRangesChange(callback: (ranges: BandSet[]) => void): () => void {
  let last: unknown = undefined;
  // Read in order: a change decoded after a newer one is dropped (decoding takes its time).
  let latest = 0;
  return OBR.room.onMetadataChange((metadata) => {
    const stored = metadata[KEY];
    if (stored === last) {
      return;
    }
    last = stored;
    const mine = ++latest;
    decodeRanges(stored).then((ranges) => {
      if (mine === latest) {
        callback(ranges);
      }
    });
  });
}

/** Whether a list fits what the room keeps (see BUDGET). */
export async function fitsRoom(ranges: BandSet[]): Promise<boolean> {
  return ranges.length <= MAX_RANGES && (await encodeRanges(ranges)).length <= BUDGET;
}

/**
 * Ranges an earlier version kept in this scene, moved up to the room: as
 * many as fit (by id, none twice), the rest left in the scene. Returns the
 * room's list and how many stayed behind.
 */
export async function adoptSceneRanges(sceneMetadata: Record<string, unknown>, room: BandSet[]): Promise<{ ranges: BandSet[]; left: BandSet[] }> {
  const scene = customBandSetsFromMetadata(sceneMetadata);
  if (scene.length === 0) {
    return { ranges: room, left: [] };
  }
  const known = new Set(room.map((r) => r.id));
  const fresh = scene.filter((r) => !known.has(r.id));
  const ranges = [...room];
  const left: BandSet[] = [];
  for (const range of fresh) {
    if (ranges.length < MAX_RANGES) {
      const result = await saveRanges([...ranges, range]);
      if (result.ok) {
        ranges.push(range);
        continue;
      }
    }
    left.push(range);
  }
  // The scene keeps only what didn't fit (none: its key goes).
  await OBR.scene.setMetadata({ [SCENE_KEY]: left.length > 0 ? left : undefined }).catch((error) => {
    console.warn("Rising Ranges: the scene's old ranges couldn't be cleared", error);
  });
  return { ranges, left };
}

/** A file of ranges (export): readable JSON. */
export const FILE_FORMAT = "rising-ranges/ranges";

export function rangesFile(ranges: BandSet[]): string {
  return JSON.stringify({ format: FILE_FORMAT, version: 1, ranges }, null, 2);
}

/** The ranges in a file (import); null if it isn't one. */
export function rangesFromFile(text: string): BandSet[] | null {
  try {
    const value = JSON.parse(text);
    const list = value?.format === FILE_FORMAT ? value.ranges : Array.isArray(value) ? value : isBandSet(value) ? [value] : null;
    return Array.isArray(list) ? list.filter(isBandSet) : null;
  } catch {
    return null;
  }
}
