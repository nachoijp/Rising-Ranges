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
//
// 2.2 keeps it under a key of its own (KEY), in a format 2.1.0 can't read:
// a 2.1.0 still open reads only its old key (OLD_KEY), so it never takes the
// new list for an empty one and writes that over it. The old key's list is
// moved up the first time a 2.2 GM opens the settings (see moveOldRanges).

const KEY = getPluginId("sets");
const OLD_KEY = getPluginId("ranges");
const SCENE_KEY = getPluginId("bandSets");

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** `length` letters and digits at random, evenly (bytes of 252 and up, which would favour 0–3, drawn again). */
function randomId(length: number): string {
  let id = "";
  while (id.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
      if (byte < 252 && id.length < length) {
        id += ALPHABET[byte % 36];
      }
    }
  }
  return id;
}

/**
 * A new set's id: 6 letters and digits at random (36⁶, about 2 × 10⁹: never twice in a room's five).
 * Short, as it's kept in the room's metadata: a UUID's 36 random characters barely compress. Ids made
 * before (UUIDs) stay as they are: a scene's active set and the filter's Banda point at them.
 */
export function newSetId(): string {
  return randomId(6);
}

/**
 * A new Banda's id: 4 letters and digits at random (36⁴, about 1.7 × 10⁶), none its set has. Not a
 * number in its set: the Banda filter is the room's, and looks for its id in whatever set is active, so
 * one set's "2" mustn't be another's, nor a deleted Banda's id come back on a new one.
 */
export function newBandId(bands: { id: string }[] = []): string {
  for (;;) {
    const id = randomId(4);
    if (!bands.some((band) => band.id === id)) {
      return id;
    }
  }
}

/** Bandas with ids of their own, for a new set (made, or copied from another). */
export function freshBands<B extends { id: string }>(bands: B[]): B[] {
  const out: B[] = [];
  for (const band of bands) {
    out.push({ ...band, id: newBandId(out) });
  }
  return out;
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
/** The dictionary as bytes, made when first needed (not by every page that loads this). */
let dictionaryBytes: Uint8Array | null = null;
const dictionary = () => (dictionaryBytes ??= new TextEncoder().encode(DICTIONARY_D1));

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

/** 2.1.0's "z1" undone: deflate-raw, with the browser's own stream. */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw")));
  return new Uint8Array(await out.arrayBuffer());
}

/** The list as it's stored. */
export async function encodeRanges(ranges: BandSet[]): Promise<string> {
  return DICT + toBase64(deflateSync(new TextEncoder().encode(JSON.stringify(ranges)), { level: 9, dictionary: dictionary() }));
}

/** The list from what's stored (any version this one knows; nothing it can't read). */
export async function decodeRanges(stored: unknown): Promise<BandSet[]> {
  try {
    let value: unknown = stored;
    if (typeof stored === "string" && stored.startsWith(DICT)) {
      value = JSON.parse(new TextDecoder().decode(inflateSync(fromBase64(stored.slice(DICT.length)), { dictionary: dictionary() })));
    } else if (typeof stored === "string" && stored.startsWith(ZIP)) {
      value = JSON.parse(new TextDecoder().decode(await inflateRaw(fromBase64(stored.slice(ZIP.length)))));
    } else if (typeof stored === "string" && stored.startsWith(RAW)) {
      value = JSON.parse(stored.slice(RAW.length));
    }
    return Array.isArray(value) ? value.filter(isBandSet) : [];
  } catch (error) {
    console.warn("Rising Ranges: the room's ranges couldn't be read", error);
    return [];
  }
}

/** What the room keeps of its ranges: under 2.2's key, or (till they're moved: see moveOldRanges) the old one. */
const storedIn = (metadata: Record<string, unknown>) => (metadata[KEY] !== undefined ? metadata[KEY] : metadata[OLD_KEY]);

/** The room's ranges now. */
export async function loadRanges(): Promise<BandSet[]> {
  return decodeRanges(storedIn(await OBR.room.getMetadata()));
}

/** A GM's: the list 2.1.0 kept under the old key moved to the new one (once; the old key then goes). */
export async function moveOldRanges(): Promise<void> {
  const metadata = await OBR.room.getMetadata();
  if (metadata[KEY] === undefined && metadata[OLD_KEY] !== undefined) {
    const ranges = await decodeRanges(metadata[OLD_KEY]);
    await saveRanges(ranges.slice(0, MAX_RANGES));
  }
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
    // The old key goes with the first save: the list's under the new one from then on.
    await OBR.room.setMetadata({ [KEY]: ranges.length > 0 ? stored : undefined, [OLD_KEY]: undefined });
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
    const stored = storedIn(metadata);
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
