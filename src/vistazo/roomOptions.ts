// The Vistazo's options in layers: the factory's, the room's (set by a GM, in the room's metadata),
// and each one's own (what they changed by hand, in this browser). Both stored layers are kept as
// short as they can be: a letter per option and its value as a whole number ("g1r0q1": anchor base,
// rings off, medium quality), only the options that differ from the layer under them.
import { getPluginId } from "../util/getPluginId";
import type { Options } from "./view/types";

/** The room's options, in the room's metadata: only what differs from the factory's. */
export const ROOM_KEY = getPluginId("vo");
/** This browser's own options: only what was changed by hand (see ownAfter). */
const OWN_KEY = "rising-ranges/vistazo-own";
/** The JSON of every option, as they were stored before (read once, see readOwn). */
const OLD_KEY = "rising-ranges/vistazo-options";
/** The room's options as last seen here, so that a change of them is told once (see the room note). */
const SEEN_KEY = "rising-ranges/vistazo-room-seen";

export const FACTORY: Options = {
  heightScale: 1, shade: 0.6, perspective: 45, tint: false, tokens: true, xray: false, edges: true, anchor: "center", levels: true, grid: false,
  distances: true, tokenLabels: "full", distanceLabels: "full", labelSize: 1, relief: 0.5, weather: true, clouds: "mist", waterMotion: true,
  videoMaps: true, quality: "high", props: "flat", showProps: true, propDistances: false, propShadows: true, propLines: true, propLabels: false,
  rings: true, ringFill: false, playerView: false,
};

type Field =
  | { code: string; key: keyof Options; kind: "bool" }
  | { code: string; key: keyof Options; kind: "enum"; values: readonly string[] }
  /** Stored times `by`, rounded: whole numbers only. */
  | { code: string; key: keyof Options; kind: "num"; by: number; min: number; max: number };

// Codes and enum orders are stored: never change or reuse one; a new option takes a new letter.
const FIELDS: readonly Field[] = [
  { code: "a", key: "heightScale", kind: "num", by: 4, min: 0.5, max: 3 },
  { code: "b", key: "shade", kind: "num", by: 100, min: 0, max: 1 },
  { code: "c", key: "perspective", kind: "num", by: 1, min: 0, max: 100 },
  { code: "d", key: "tint", kind: "bool" },
  { code: "e", key: "tokens", kind: "bool" },
  { code: "f", key: "xray", kind: "bool" },
  { code: "g", key: "anchor", kind: "enum", values: ["center", "base"] },
  { code: "h", key: "edges", kind: "bool" },
  { code: "i", key: "levels", kind: "bool" },
  { code: "j", key: "grid", kind: "bool" },
  { code: "k", key: "distances", kind: "bool" },
  { code: "l", key: "tokenLabels", kind: "enum", values: ["full", "nameHeight", "heightFull", "height", "name", "none"] },
  { code: "m", key: "distanceLabels", kind: "enum", values: ["full", "distance", "none"] },
  { code: "n", key: "labelSize", kind: "num", by: 10, min: 0.6, max: 1.6 },
  { code: "o", key: "relief", kind: "num", by: 100, min: 0, max: 1 },
  { code: "p", key: "weather", kind: "bool" },
  { code: "q", key: "quality", kind: "enum", values: ["high", "medium", "low"] },
  { code: "r", key: "rings", kind: "bool" },
  { code: "s", key: "ringFill", kind: "bool" },
  { code: "t", key: "clouds", kind: "enum", values: ["mist", "shadows"] },
  { code: "u", key: "waterMotion", kind: "bool" },
  { code: "v", key: "videoMaps", kind: "bool" },
  { code: "w", key: "props", kind: "enum", values: ["flat", "stand"] },
  { code: "x", key: "showProps", kind: "bool" },
  { code: "y", key: "propDistances", kind: "bool" },
  { code: "z", key: "propShadows", kind: "bool" },
  { code: "A", key: "propLines", kind: "bool" },
  { code: "B", key: "propLabels", kind: "bool" },
  { code: "C", key: "playerView", kind: "bool" },
];
const BY_CODE = new Map(FIELDS.map((field) => [field.code, field]));

/** What the room's options leave out: the GM's own preview of the players' view. */
const NOT_ROOM: ReadonlySet<keyof Options> = new Set(["playerView"]);
/** What going back to the room's options keeps: the same preview. */
const KEPT: ReadonlySet<keyof Options> = new Set(["playerView"]);

export function encode(options: Partial<Options>): string {
  let out = "";
  for (const field of FIELDS) {
    const value = options[field.key];
    if (value === undefined) {
      continue;
    }
    if (field.kind === "bool") {
      out += field.code + (value ? 1 : 0);
    } else if (field.kind === "enum") {
      const index = field.values.indexOf(value as string);
      if (index >= 0) {
        out += field.code + index;
      }
    } else {
      out += field.code + Math.round((value as number) * field.by);
    }
  }
  return out;
}

/** Unknown letters and values out of range left out (a newer version's, a hand-edited one). */
export function decode(text: unknown): Partial<Options> {
  const out: Record<string, unknown> = {};
  if (typeof text !== "string") {
    return out as Partial<Options>;
  }
  for (const [, code, digits] of text.matchAll(/([A-Za-z])(-?\d+)/g)) {
    const field = BY_CODE.get(code);
    const n = Number(digits);
    if (!field) {
      continue;
    }
    if (field.kind === "bool") {
      out[field.key] = n !== 0;
    } else if (field.kind === "enum") {
      if (field.values[n] !== undefined) {
        out[field.key] = field.values[n];
      }
    } else {
      out[field.key] = Math.min(field.max, Math.max(field.min, n / field.by));
    }
  }
  return out as Partial<Options>;
}

/** Only what differs from `under`. */
export function differences(options: Partial<Options>, under: Options): Partial<Options> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined && value !== under[key as keyof Options]) {
      out[key] = value;
    }
  }
  return out as Partial<Options>;
}

/** The room's options as stored (without what the room's leave out). */
export function roomOf(metadata: Record<string, unknown>): Partial<Options> {
  const room = decode(metadata[ROOM_KEY]);
  for (const key of NOT_ROOM) {
    delete room[key];
  }
  return room;
}

/**
 * This device's: a system asking for less motion gets low quality and still water, over the room's
 * (never sent to the room, nor kept as chosen: see roomText, readOwn).
 */
export const DEVICE: Partial<Options> = (() => {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? { quality: "low", waterMotion: false } : {};
  } catch {
    return {};
  }
})();
/** The factory's on this device. */
const BASE: Options = { ...FACTORY, ...DEVICE };

/**
 * The text to store as the room's for what one sees ("" for the factory's: nothing stored): the room's
 * and one's own over the factory's, not this device's (another GM's reduced motion isn't everyone's).
 */
export function roomText(room: Partial<Options>, own: Partial<Options>): string {
  const out = differences({ ...FACTORY, ...room, ...own }, FACTORY);
  for (const key of NOT_ROOM) {
    delete out[key];
  }
  return encode(out);
}

/** The options as shown: the factory's, the room's over them, this device's, one's own over those. */
export function resolve(room: Partial<Options>, own: Partial<Options>): Options {
  return { ...FACTORY, ...room, ...DEVICE, ...own };
}

/**
 * One's own after a change: what's changed by hand kept as chosen, even the same as the room's now
 * (a later room save doesn't take it away).
 */
export function ownAfter(own: Partial<Options>, change: Partial<Options>): Partial<Options> {
  return { ...own, ...change };
}

/** Back to the room's: one's own dropped, but for what that keeps. */
export function ownReset(own: Partial<Options>): Partial<Options> {
  const out: Record<string, unknown> = {};
  for (const key of KEPT) {
    if (own[key] !== undefined) {
      out[key] = own[key];
    }
  }
  return out as Partial<Options>;
}

/** The room's taken (its note's "Use them"): one's own dropped only where the room sets something. */
export function ownTakeRoom(own: Partial<Options>, room: Partial<Options>): Partial<Options> {
  const out = { ...own };
  for (const key of Object.keys(room) as (keyof Options)[]) {
    if (!KEPT.has(key)) {
      delete out[key];
    }
  }
  return out;
}

/** One's own for the factory's options (this device's kept) over the room's: what that keeps kept. */
export function ownFactory(own: Partial<Options>, room: Partial<Options>): Partial<Options> {
  return { ...differences(BASE, resolve(room, {})), ...ownReset(own) };
}

/** Whether the options shown are the factory's on this device (the preview aside). */
export function isFactory(options: Options): boolean {
  return Object.keys(withoutKept(differences(options, BASE))).length === 0;
}

/** Whether one's own change anything from the room's (what a reset would change, the preview aside). */
export function ownMatters(own: Partial<Options>, room: Partial<Options>): boolean {
  return Object.keys(differences(withoutKept(own), resolve(room, {}))).length > 0;
}

/** Whether one's own hide something the room sets (what its note offers to take). */
export function hidesRoom(own: Partial<Options>, room: Partial<Options>): boolean {
  return (Object.keys(room) as (keyof Options)[]).some((key) => !KEPT.has(key) && own[key] !== undefined && own[key] !== room[key]);
}

function withoutKept(own: Partial<Options>): Partial<Options> {
  const out = { ...own };
  for (const key of KEPT) {
    delete out[key];
  }
  return out;
}

/**
 * This browser's own options. The first time, those stored before (every option, as JSON) taken as
 * own where they differ from the factory's on this device: what was changed then, by hand.
 */
export function readOwn(): Partial<Options> {
  try {
    const stored = localStorage.getItem(OWN_KEY);
    if (stored !== null) {
      return decode(stored);
    }
    const old = localStorage.getItem(OLD_KEY);
    let own: Partial<Options> = {};
    if (old !== null) {
      const parsed = JSON.parse(old) as Partial<Options> & { props?: string };
      // "Hidden" was a position of the props once; then their own checkbox.
      if (parsed.props === "none") {
        parsed.props = "flat";
        parsed.showProps = false;
      }
      // (What this device sets by itself, as before, isn't taken as chosen: see DEVICE.)
      own = differences(decode(encode(parsed)), BASE);
    }
    saveOwn(own);
    localStorage.removeItem(OLD_KEY);
    return own;
  } catch {
    return {};
  }
}

export function saveOwn(own: Partial<Options>) {
  try {
    localStorage.setItem(OWN_KEY, encode(own));
  } catch {
    // Only a convenience.
  }
}

export function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function saveSeen(text: string) {
  try {
    localStorage.setItem(SEEN_KEY, text);
  } catch {
    // Told again next time, at worst.
  }
}
