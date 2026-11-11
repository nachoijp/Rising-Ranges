import { buildCurve, buildEffect, isCurve, isEffect, type Item, type Uniform, type Vector2 } from "@owlbear-rodeo/sdk";
import { getPluginId } from "../util/getPluginId";
import { isPlainObject } from "../util/isPlainObject";
import { templateColors, templateLook, templateTip, type Template, type TemplateLook, type TemplateShape } from "./templates";
import { TEMPLATE_SKSL } from "./templateSksl";

// The templates as the scene's items, shared with everyone: an outline on the map's Drawing layer
// (under the tokens), its point where the template starts (a sphere's, a cylinder's, a cube's middle;
// a cone's or a line's origin), turned as it points. What only the Glance knows (its kind, its look,
// its size, how high it is) in its metadata. Moved or turned on the map, the Glance follows; its look
// and heights are changed in the Glance.

const TEMPLATE_KEY = getPluginId("template");
/** Its outline's fill: under its look, there to be picked on the map. */
const FILL_OPACITY = 0.05;
/** On the Effect attached to a template's outline: its moving look (see templateSksl.ts). */
const LOOK_KEY = getPluginId("templateLook");

const SHAPES: TemplateShape[] = ["cone", "sphere", "cylinder", "line", "cube"];
const LOOKS: TemplateLook[] = ["fire", "ice", "poison", "lightning", "darkness", "arcane", "force", "necrotic", "acid", "thunder", "psychic", "radiant"];

/** What the item keeps of a template (its place and its way are the item's own). */
type Stored = { shape: TemplateShape; look: TemplateLook; size: number; lift: number; rise: number };

function storedOf(item: Item): Stored | null {
  const data = item.metadata[TEMPLATE_KEY];
  if (!isPlainObject(data)) {
    return null;
  }
  const { shape, look, size, lift, rise } = data as Record<string, unknown>;
  if (!SHAPES.includes(shape as TemplateShape) || !LOOKS.includes(look as TemplateLook) || typeof size !== "number" || !(size > 0)) {
    return null;
  }
  return {
    shape: shape as TemplateShape,
    look: look as TemplateLook,
    size,
    lift: typeof lift === "number" && Number.isFinite(lift) ? lift : 0,
    rise: typeof rise === "number" && Number.isFinite(rise) ? rise : 0,
  };
}

/** Whether an item is a template's. */
export function isTemplateItem(item: Item): boolean {
  return isCurve(item) && storedOf(item) !== null;
}

/**
 * The template an item is (its height: the ground under it, `groundAt`, plus its own); null if it
 * isn't one. Resized on the map (Owlbear's handles), as big as it's shown (the longer way, if it was
 * stretched one way only); flipped along its length, pointing the other way. `asDrawn`: as its outline
 * is, not resized (what its look on the map is drawn in: see templateLooks).
 */
export function templateOf(item: Item, groundAt: (x: number, y: number) => number, asDrawn = false): Template | null {
  const stored = isCurve(item) ? storedOf(item) : null;
  if (!stored) {
    return null;
  }
  const angle = (item.rotation * Math.PI) / 180;
  const { x, y } = item.position;
  const scale = asDrawn ? 1 : Math.max(Math.abs(item.scale.x), Math.abs(item.scale.y)) || 1;
  const flip = !asDrawn && item.scale.x < 0 ? -1 : 1;
  return {
    id: item.id,
    ...stored,
    size: stored.size * scale,
    x,
    y,
    z: groundAt(x, y) + stored.lift,
    dir: { x: flip * Math.cos(angle), y: flip * Math.sin(angle) },
  };
}

/** Its outline on the map (scene px, from its point, pointing along +x): what it covers seen from above. */
function outline(template: Template, dpi: number): Vector2[] {
  const s = template.size * dpi;
  switch (template.shape) {
    case "sphere":
    case "cylinder": {
      const n = 48;
      return Array.from({ length: n }, (_, i) => ({ x: s * Math.cos((2 * Math.PI * i) / n), y: s * Math.sin((2 * Math.PI * i) / n) }));
    }
    case "cube":
      return [
        { x: -s / 2, y: -s / 2 },
        { x: s / 2, y: -s / 2 },
        { x: s / 2, y: s / 2 },
        { x: -s / 2, y: s / 2 },
      ];
    case "line": {
      const across = templateTip(template).across * dpi;
      const half = dpi / 2;
      return [
        { x: 0, y: -half },
        { x: across, y: -half },
        { x: across, y: half },
        { x: 0, y: half },
      ];
    }
    case "cone":
    default: {
      // As wide at its end as it's long (along its axis: tilted, its end's as wide, nearer).
      const across = templateTip(template).across * dpi;
      return [
        { x: 0, y: 0 },
        { x: across, y: -s / 2 },
        { x: across, y: s / 2 },
      ];
    }
  }
}

function stored(template: Template): Stored {
  return { shape: template.shape, look: template.look, size: template.size, lift: template.lift, rise: template.rise };
}

function rotationOf(template: Template): number {
  return (Math.atan2(template.dir.y, template.dir.x) * 180) / Math.PI;
}

/** A new template's item (`name`: what Owlbear lists it as). */
export function templateItem(template: Template, dpi: number, name: string): Item {
  const { deep, bright } = templateColors(template.look);
  return buildCurve()
    .id(template.id)
    .name(name)
    .layer("DRAWING")
    .position({ x: template.x, y: template.y })
    .rotation(rotationOf(template))
    .points(outline(template, dpi))
    .closed(true)
    .tension(0)
    // Barely seen: its look is the effect's (see templateEffect), clipped to it; this what's picked and
    // moved (a fill Owlbear can pick: a wholly clear one it can't).
    .strokeColor(deep)
    .strokeWidth(Math.max(2, dpi / 30))
    .strokeOpacity(0)
    .fillColor(bright)
    .fillOpacity(FILL_OPACITY)
    .metadata({ [TEMPLATE_KEY]: stored(template) })
    .build();
}

/** A template's item made as the template is now (in an update's draft). */
export function setTemplateItem(item: Item, template: Template, dpi: number) {
  if (!isCurve(item)) {
    return;
  }
  const { deep, bright } = templateColors(template.look);
  item.position = { x: template.x, y: template.y };
  item.rotation = rotationOf(template);
  // Its size and way are in its points and its turn now (as the Glance read them: see templateOf).
  item.scale = { x: 1, y: 1 };
  item.points = outline(template, dpi);
  item.style.strokeColor = deep;
  item.style.fillColor = bright;
  item.style.strokeOpacity = 0;
  item.style.fillOpacity = FILL_OPACITY;
  item.metadata[TEMPLATE_KEY] = stored(template);
}

/** Whether an item is a template's look (the Effect on its outline). */
export function isTemplateLook(item: Item): boolean {
  return isEffect(item) && item.metadata[LOOK_KEY] === true;
}

/**
 * Kinds made a little different on the map: in the Glance, fire glows (adds light), which a map's
 * effect doesn't; its deep colour as dark as it is there looks dull, so it's yellower and fuller here.
 */
const ON_MAP: Partial<Record<TemplateLook, { deep?: [number, number, number]; opacity?: number }>> = {
  fire: { deep: [1, 0.5, 0.05], opacity: 0.65 },
};

const SHAPE_INDEX: Record<TemplateShape, number> = { sphere: 0, cylinder: 0, cube: 1, line: 2, cone: 3 };

/** What the look's shader is told (see templateSksl.ts): its shape and its kind. */
function lookUniforms(template: Template, dpi: number): Uniform[] {
  const look = { ...templateLook(template.look), ...ON_MAP[template.look] };
  const v3 = ([x, y, z]: [number, number, number]) => ({ x, y, z });
  return [
    { name: "uShape", value: SHAPE_INDEX[template.shape] },
    { name: "uSize", value: template.size * dpi },
    { name: "uAcross", value: templateTip(template).across * dpi },
    { name: "uCell", value: dpi },
    { name: "uDeep", value: v3(look.deep) },
    { name: "uBright", value: v3(look.bright) },
    { name: "uOpacity", value: look.opacity },
    { name: "uRise", value: look.rise },
    { name: "uGrain", value: look.grain },
    { name: "uSpeed", value: look.speed },
    { name: "uMode", value: look.modeIndex },
  ];
}

/**
 * A template's moving look on the map: an Effect filling its outline (attached to it). Owlbear keeps
 * effects local only: each client puts its own (see background/templateLooks.ts).
 */
export function templateEffect(template: Template, dpi: number): Item {
  return buildEffect()
    .effectType("ATTACHMENT")
    .attachedTo(template.id)
    .layer("DRAWING")
    .sksl(TEMPLATE_SKSL)
    .uniforms(lookUniforms(template, dpi))
    .locked(true)
    .disableHit(true)
    .metadata({ [LOOK_KEY]: true })
    .build();
}

/** What a template's look is told, as a key (changed: its effect's told again). */
export function templateLookKey(template: Template, dpi: number): string {
  return JSON.stringify(lookUniforms(template, dpi));
}

/** A template's look made as the template is now (in an update's draft). */
export function setTemplateEffect(item: Item, template: Template, dpi: number) {
  if (isEffect(item)) {
    item.uniforms = lookUniforms(template, dpi);
  }
}
