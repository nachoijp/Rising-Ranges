import OBR, { buildPath, isImage, type GridScale, type GridType, type Image, type Item, type PathCommand } from "@owlbear-rodeo/sdk";
import { getTokenBounds } from "../render/iconAnchor";
import { onFloor } from "../tokenHeight/lift";
import { svgCommands } from "../render/svgPath";
import fallSvg from "../assets/fall.svg?raw";
import { getBandLabel, LABEL_FONT_SIZE, lecturaColor } from "../render/lecturaItems";
import { getPluginId } from "../util/getPluginId";
import { terrainNow } from "../relief/live";
import { terrainAt } from "../terrain/terrain";
import { formatDistance } from "../util/flattenGridScale";
import { globalSettingsFromMetadata, terrainOn } from "../settings/globalSettings";

// A token this player let go lower on the terrain than it stood (off a
// ledge, down a pit): how far it fell, for a moment beside it (a falling
// figure and the drop), for the fall's rules. Only on this client (local
// items), the one that moved it.

const FALL_KEY = getPluginId("fall");
/** The least drop (grid units) told: a whole one (the drop is shown in whole units of the scene's measure). */
const FALL_MIN = 1;
/** How long it's shown (ms). */
const SHOWN_MS = 3500;

/** The label's background: a Lectura's own grey. */
const LABEL_COLOR = lecturaColor;

/** The falling figure (src/assets/fall.svg, drawn in Inkscape), in a 64-unit box. */
const FIGURE = svgCommands(fallSvg, 64, 64);

const isToken = (item: Item): item is Image => isImage(item) && (item.layer === "CHARACTER" || item.layer === "MOUNT");

export function startFalls() {
  /** Where each token was last seen. */
  const seen = new Map<string, { x: number; y: number }>();
  /** What's shown for each token's last fall (one at a time: a new one takes its place). */
  const shown = new Map<string, string[]>();
  const drop = (tokenId: string) => {
    const ids = shown.get(tokenId);
    shown.delete(tokenId);
    return ids ? OBR.scene.local.deleteItems(ids).catch(() => {}) : Promise.resolve();
  };
  let me = "";
  let scale: GridScale | null = null;
  let dpi = 150;
  let gridType: GridType = "SQUARE";
  let metadata: Record<string, unknown> = {};
  const read = async () => {
    [me, scale, dpi, gridType, metadata] = await Promise.all([
      OBR.player.getId(),
      OBR.scene.grid.getScale(),
      OBR.scene.grid.getDpi(),
      OBR.scene.grid.getType(),
      OBR.scene.getMetadata(),
    ]);
  };
  const show = async (token: Image, fell: number) => {
    if (!scale) {
      return;
    }
    // Under the token, centred: a Lectura's label (the same rules: it follows the map's zoom, as the
    // token does), its background fainter, the figure drawn over the room its text leaves at its left.
    const { topLeft, scaledWidth, scaledHeight } = getTokenBounds(onFloor(token), dpi);
    const text = formatDistance(scale, fell);
    const label = getBandLabel({ x: 0, y: 0 }, { x: 0, y: 0 }, `  ${text}`, LABEL_COLOR);
    // Its left end where it's put (so the figure's place in it is known), the whole about centred.
    const padding = 8;
    const width = padding * 2 + LABEL_FONT_SIZE * 1.5 + text.length * LABEL_FONT_SIZE * 0.55;
    const left = topLeft.x + scaledWidth / 2 - width / 2;
    const y = topLeft.y + scaledHeight + LABEL_FONT_SIZE;
    label.position = { x: left, y };
    label.style.pointerDirection = "LEFT";
    label.style.backgroundOpacity = 0.55;
    label.zIndex = 1;
    label.metadata[FALL_KEY] = true;
    const size = LABEL_FONT_SIZE * 1.35;
    const k = size / 64;
    const figure = buildPath()
      .commands(FIGURE.map((command) => command.map((v, i) => (i === 0 ? v : v * k)) as PathCommand))
      .position({ x: left + padding + LABEL_FONT_SIZE / 2 - size / 2, y: y - size / 2 })
      .fillColor("#ffffff")
      .fillOpacity(1)
      .fillRule("nonzero")
      .strokeWidth(0)
      .strokeOpacity(0)
      .layer("POPOVER")
      .locked(true)
      .disableHit(true)
      .zIndex(2)
      .metadata({ [FALL_KEY]: true })
      .build();
    const items = [label, figure];
    const ids = items.map((item) => item.id);
    // This one's in place before anything's awaited: a fall right after it takes its place, not the other way.
    void drop(token.id);
    shown.set(token.id, ids);
    await OBR.scene.local.addItems(items).catch(() => {});
    // Replaced (or the token moved on) while it was being added: its own gone too.
    if (shown.get(token.id) !== ids) {
      void OBR.scene.local.deleteItems(ids).catch(() => {});
      return;
    }
    setTimeout(() => {
      if (shown.get(token.id) === ids) {
        void drop(token.id);
      }
    }, SHOWN_MS);
  };
  const take = (items: Item[]) => {
    const settings = globalSettingsFromMetadata(metadata);
    const terrain = terrainOn(settings, gridType) && (settings.showFalls ?? true) ? terrainNow() : [];
    for (const token of items.filter(isToken)) {
      const before = seen.get(token.id);
      seen.set(token.id, { ...token.position });
      if (!before || (before.x === token.position.x && before.y === token.position.y)) {
        continue;
      }
      // Moved on: a fall told of where it was isn't where it is (what's told isn't attached to it).
      if (shown.has(token.id)) {
        void drop(token.id);
      }
      if (terrain.length === 0 || token.lastModifiedUserId !== me) {
        continue;
      }
      // Its own height over the ground is the same where it lands: what it falls is the ground's drop.
      const fell = terrainAt(terrain, before) - terrainAt(terrain, token.position);
      if (fell >= FALL_MIN) {
        void show(token, fell).catch((error) => console.error("Rising Ranges: couldn't show a fall", error));
      }
    }
  };
  const load = async () => {
    await read();
    seen.clear();
    shown.clear();
    take(await OBR.scene.items.getItems());
    // Shown when the scene was left: gone.
    const left = await OBR.scene.local.getItems((item) => FALL_KEY in item.metadata);
    if (left.length > 0) {
      await OBR.scene.local.deleteItems(left.map((item) => item.id));
    }
  };
  OBR.scene.items.onChange(take);
  OBR.scene.onMetadataChange((next) => (metadata = next));
  OBR.scene.grid.onChange(() => void read().catch(() => {}));
  OBR.scene.onReadyChange((ready) => {
    if (ready) {
      void load().catch((error) => console.error("Rising Ranges: falls couldn't start", error));
    } else {
      seen.clear();
    }
  });
  void OBR.scene.isReady().then((ready) => (ready ? load() : undefined)).catch(() => {});
}
