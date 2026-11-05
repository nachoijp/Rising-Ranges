import OBR from "@owlbear-rodeo/sdk";
import { BandSet } from "../engine/types";
import { getPluginId } from "../util/getPluginId";
import { deflateSync, inflateSync } from "fflate";
import { customBandSetsFromMetadata, isBandSet } from "./bandSets";
import { DICTIONARY_D1 } from "./dictionary";

// The room's own ranges (custom BandSets): one list for every scene of the
// room, kept in the room's metadata (on Owlbear's servers: any machine that
// opens the room has it). That metadata is 16 kB shared by every extension,
// so the list is kept small: at most MAX_RANGES, compressed (deflate with a
// dictionary of the built-in presets, as base64), under BUDGET characters;
// more go to a file (export/import). New sets and Bandas get short ids.
// Earlier versions kept the list in each scene's metadata: it's moved up
// the first time the settings open in that scene (see adoptSceneRanges).

const KEY = getPluginId("ranges");
const SCENE_KEY = getPluginId("bandSets");

/**
 * A new set's id: 6 letters and digits at random (36⁶, about 2 × 10⁹: never twice in a room's five).
 * Short, as it's kept in the room's metadata: a UUID's 36 random characters barely compress. Ids made
 * before (UUIDs) stay as they are: a scene's active set and the filter's Banda point at them.
 */
export function newSetId(): string {
  const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(6))) {
    id += ALPHABET[byte % 36];
  }
  return id;
}

/**
 * A new Banda's id in its set: the next number after the set's own ("1", "2", …). It only has to be
 * one of a kind within its set (the filter's Banda is looked for in the set it's in).
 */
export function newBandId(bands: { id: string }[]): string {
  const taken = bands.map((band) => Number(band.id)).filter((n) => Number.isInteger(n) && n > 0);
  return String(Math.max(0, ...taken) + 1);
}

/** Bandas' ids for a new set (made, or copied from another): 1, 2, 3, … */
export function numberedBands<B extends { id: string }>(bands: B[]): B[] {
  return bands.map((band, i) => ({ ...band, id: String(i + 1) }));
}

/** The most ranges a room keeps. */
export const MAX_RANGES = 5;
/** The most characters the stored list may take (well under the room's 16 kB, shared by all extensions). */
export const BUDGET = 3000;

/**
 * How the list is stored: "d1:" + base64(deflate(JSON) with DICTIONARY_D1). Read too: "z1:" (2.1.0:
 * deflate-raw, no dictionary), "j1:" (JSON, where a browser couldn't compress), a bare list (none).
 */
const DICT = "d1:";
const ZIP = "z1:";
const RAW = "j1:";
const dictionary = new TextEncoder().encode(DICTIONARY_D1);

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
  return DICT + toBase64(deflateSync(new TextEncoder().encode(JSON.stringify(ranges)), { level: 9, dictionary }));
}

/** The list from what's stored (any version this one knows; nothing it can't read). */
export async function decodeRanges(stored: unknown): Promise<BandSet[]> {
  try {
    let value: unknown = stored;
    if (typeof stored === "string" && stored.startsWith(DICT)) {
      value = JSON.parse(new TextDecoder().decode(inflateSync(fromBase64(stored.slice(DICT.length)), { dictionary })));
    } else if (typeof stored === "string" && stored.startsWith(ZIP)) {
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
