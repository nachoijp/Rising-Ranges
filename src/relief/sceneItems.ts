import { buildShape, type Item } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { fromBase64, toBase64 } from "./codec";

// A relief kept in the scene, so every client has it (Owlbear shares the
// scene's items): in hidden items of its own, attached to the map image it
// follows (deleted and copied with it), its stored JSON gzipped, in parts
// of at most PART characters (an item's JSON is refused past about 1 MB,
// measured). A version id the parts share: one written while another is
// being read isn't mixed with it, and of two whole ones the newer wins.

export const ITEM_KEY = getPluginId("relief");
/** The most characters of a relief in one item. */
export const PART = 900_000;

export type ReliefPart = { v: string; index: number; count: number; text: string };

/** A new version id, later ones sorting after earlier ones. */
export const versionId = () => `${Date.now().toString(36).padStart(9, "0")}-${Math.random().toString(36).slice(2, 8)}`;

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function pack(json: string): Promise<string> {
  return toBase64(await through(new TextEncoder().encode(json), new CompressionStream("gzip")));
}

export async function unpack(text: string): Promise<string> {
  return new TextDecoder().decode(await through(fromBase64(text), new DecompressionStream("gzip")));
}

export const partOf = (item: Item): ReliefPart | undefined => {
  const part = item.metadata[ITEM_KEY] as ReliefPart | undefined;
  return part && typeof part.v === "string" && typeof part.text === "string" && item.attachedTo ? part : undefined;
};

/** A relief's packed text as its parts. */
export function partsOfText(packed: string, v: string): ReliefPart[] {
  const count = Math.max(1, Math.ceil(packed.length / PART));
  return Array.from({ length: count }, (_, index) => ({ v, index, count, text: packed.slice(index * PART, (index + 1) * PART) }));
}

/** The items carrying a relief's parts, attached to its map image (where it is). */
export function itemsOf(image: Item, parts: ReliefPart[]): Item[] {
  return parts.map((part) => {
    const item = buildShape()
      .shapeType("RECTANGLE")
      .width(1)
      .height(1)
      .fillOpacity(0)
      .strokeOpacity(0)
      .strokeWidth(0)
      .position(image.position)
      .layer("DRAWING")
      .attachedTo(image.id)
      .visible(false)
      .locked(true)
      .disableHit(true)
      .name("Rising Ranges relief")
      .build();
    item.metadata[ITEM_KEY] = part;
    return item;
  });
}

/**
 * Each map image's relief in the items: its newest whole version's packed
 * text, or "partial" (one being written: the one before holds till it's whole).
 */
export function reliefsIn(items: Item[]): Map<string, { v: string; packed: string } | "partial"> {
  const byImage = new Map<string, Map<string, ReliefPart[]>>();
  for (const item of items) {
    const part = partOf(item);
    if (!part) {
      continue;
    }
    const versions = byImage.get(item.attachedTo!) ?? new Map<string, ReliefPart[]>();
    byImage.set(item.attachedTo!, versions);
    versions.set(part.v, [...(versions.get(part.v) ?? []), part]);
  }
  const out = new Map<string, { v: string; packed: string } | "partial">();
  for (const [image, versions] of byImage) {
    const whole = [...versions.entries()]
      .filter(([, parts]) => parts.length > 0 && new Set(parts.map((p) => p.index)).size === parts[0].count)
      .sort(([a], [b]) => (a < b ? 1 : -1));
    if (whole.length === 0) {
      out.set(image, "partial");
      continue;
    }
    const [v, parts] = whole[0];
    out.set(image, { v, packed: [...parts].sort((a, b) => a.index - b.index).map((p) => p.text).join("") });
  }
  return out;
}

/** A key of the relief items (what's in them, not their text): the same, nothing to read again. */
export const reliefItemsKey = (items: Item[]) =>
  items
    .flatMap((item) => {
      const part = partOf(item);
      return part ? [`${item.id}:${item.attachedTo}:${part.v}:${part.index}/${part.count}`] : [];
    })
    .sort()
    .join("|");
