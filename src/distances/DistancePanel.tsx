import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import OBR, { isImage, type GridScale, type GridType, type Image, type Item } from "@owlbear-rodeo/sdk";

import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import IconButton from "@mui/material/IconButton";
import ButtonBase from "@mui/material/ButtonBase";
import { alpha } from "@mui/material/styles";
import Box from "@mui/material/Box";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import CloseRounded from "@mui/icons-material/CloseRounded";

import { useTranslation } from "../i18n/useTranslation";
import { GLASS_FRAME } from "../util/glass";
import { roomBelow, roomBeside } from "../util/roomBelow";
import { DragHandle } from "./DragHandle";
import { ResizeHandle, type PanelSize } from "./ResizeHandle";
import { measuredBands } from "../engine/bands";
// The eyes outlined, as the rows' own and the relief editor's (visible.svg, hidden.svg).
import VisibilityOutlined from "@mui/icons-material/VisibilityOutlined";
import LandscapeRounded from "@mui/icons-material/LandscapeRounded";
import VisibilityOffOutlined from "@mui/icons-material/VisibilityOffOutlined";
import { EYE, inSight } from "../relief/sight";
import { viewportReaches } from "../util/menuRoom";
import { getColorString } from "../util/color";
import { formatDistance } from "../util/flattenGridScale";
import { getStoredTheme } from "../theme/themes";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { globalSettingsFromMetadata, terrainOn } from "../settings/globalSettings";
import { isTokenHeightMarker, tokenHeightsFromMarkers } from "../tokenHeight/markers";
import { terrainAt } from "../terrain/terrain";
import { mapAnchors, reliefZones } from "../relief/measure";
import { useReliefs } from "../relief/useReliefs";
import { computeDistanceRows, tokenName } from "./rows";
import { axonometryOf } from "../engine/axonometry";
import { getGridType } from "../util/gridAxonometry";
import { onGrid } from "../engine/hex";
import {
  DISTANCES_POPOVER_ID,
  PANEL_MAX_HEIGHT,
  getPanelPosition,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  closeDistancesPanel,
  readPanelSize,
  savePanelSize,
} from "./panelPopover";
import { visibleNow } from "../util/attachments";

/** `axonometry`: the grid's rhombus ratio, 0 on a flat grid (see axonometry.ts). */
type Grid = { dpi: number; scale: GridScale; axonometry: number; type: GridType };

// Five columns in a narrow popover: tighter than MUI's small-table padding.
const cellSx = { px: 0.75, py: 0.5 };
// The columns' names as the extension's other labels (small, grey) over a
// thin rule, on the panel itself: no colour of their own. They stay put over
// the rows, which scroll on their own under them (see the panel's layout).
const headSx = {
  ...cellSx,
  fontSize: 12,
  fontWeight: 500,
  color: "text.secondary",
  borderBottom: 1,
  borderColor: "divider",
  bgcolor: "transparent",
};
// The same names in the rows' own table, there only to size its columns to
// them too (and for screen readers: the head they're read with), not seen.
const sizerSx = {
  ...headSx,
  py: 0,
  height: 0,
  lineHeight: 0,
  border: 0,
  color: "transparent",
  pointerEvents: "none",
  userSelect: "none",
};
// The page's own side padding (p: 1), added to the table's natural width
// when sizing the popover to fit it — plus room for a vertical scrollbar,
// only when the content is too tall to fit and the page has to scroll.
const PANEL_PADDING_WIDTH = 16;
const SCROLLBAR_WIDTH = 14;
// The glass frames around the content (see GlassFrame): the popover is
// this much bigger than the content it fits.
const FRAME = GLASS_FRAME;
/** The least a hand-set size can be: the token, the buttons, the head and a couple of rows. */
const PANEL_MIN_HEIGHT = 160;
// Rough room the open dropdown list needs: where it starts (just under the
// select) plus one row per option, the "pick a token" one included.
const MENU_TOP = 64;
const MENU_ITEM_HEIGHT = 40;
const menuHeight = (options: number) => MENU_TOP + (options + 1) * MENU_ITEM_HEIGHT;

const THUMB_SIZE = 24;

/**
 * The token's own image, small — many tokens show no name on the map, so this is how they're recognized
 * here. Whole, as Owlbear draws it (as the Vistazo does too), not cut round: its art may go past its circle.
 */
function TokenThumb({ token }: { token: Image }) {
  const [broken, setBroken] = useState(false);
  const style = { width: THUMB_SIZE, height: THUMB_SIZE, flexShrink: 0 };
  if (broken || !token.image?.url) {
    return (
      <span aria-hidden style={{ ...style, display: "inline-block", borderRadius: "50%", background: "rgba(127,127,127,0.4)" }} />
    );
  }
  return (
    <img
      src={token.image.url}
      alt=""
      aria-hidden
      style={{ ...style, objectFit: "contain" }}
      onError={() => setBroken(true)}
    />
  );
}

function TokenLabel({ token }: { token: Image }) {
  return (
    <Stack direction="row" alignItems="center" gap={0.75}>
      <TokenThumb token={token} />
      <span style={{ display: "block", maxWidth: 140, wordBreak: "break-word" }}>{tokenName(token)}</span>
    </Stack>
  );
}

const SHOW_HIDDEN_KEY = "distancesShowHidden";

function readShowHidden(): boolean {
  try {
    return localStorage.getItem(SHOW_HIDDEN_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeShowHidden(show: boolean) {
  try {
    localStorage.setItem(SHOW_HIDDEN_KEY, String(show));
  } catch {
    // Not remembered; it still applies until the panel closes.
  }
}

const SIGHT_KEY = "rising-ranges/distances/sight";

/** Whether the rows say when the terrain hides one token from the other (this browser's choice; on unless turned off). */
function readSight(): boolean {
  try {
    return localStorage.getItem(SIGHT_KEY) !== "false";
  } catch {
    return true;
  }
}

function writeSight(on: boolean) {
  try {
    localStorage.setItem(SIGHT_KEY, String(on));
  } catch {
    // Not remembered; it still applies until the panel closes.
  }
}

export function DistancePanel() {
  const t = useTranslation();
  const [metadata, setMetadata] = useState<Record<string, unknown> | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [grid, setGrid] = useState<Grid | null>(null);
  const reliefs = useReliefs();
  const [role, setRole] = useState<"GM" | "PLAYER">("PLAYER");
  const [selection, setSelection] = useState<string[]>([]);
  const [originId, setOriginId] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // The rows' part (it scrolls on its own), the head over it and its columns' widths, taken from the
  // rows' table (see the sizer row in it).
  const bodyRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLTableRowElement>(null);
  const [headWidths, setHeadWidths] = useState<number[]>([]);
  const panelSize = useRef({ width: PANEL_MIN_WIDTH, height: 0 });
  // Its size set by hand with the corner handle (then it no longer fits its content: the rows scroll
  // in it, both ways); null, it fits its content.
  const [manualSize, setManualSize] = useState<PanelSize | null>(readPanelSize);
  // The dropdown list opens inside the popover and sizes itself to the room
  // there is at the moment it opens, so the popover grows to fit it first
  // and the list only opens once that's done. menuWanted covers the gap in
  // between, so a re-render meanwhile doesn't shrink the popover back.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWanted = useRef(false);
  // Where the panel sits; the drag handle moves it.
  const [position, setPosition] = useState(getPanelPosition);
  // As tall as the screen allows below the panel's top, and no wider than
  // the room to its right (a phone held upright), rather than fixed bounds
  // — measured again whenever it's moved.
  const [maxHeight, setMaxHeight] = useState(PANEL_MAX_HEIGHT);
  const [maxWidth, setMaxWidth] = useState(PANEL_MAX_WIDTH);
  useEffect(() => {
    roomBelow(position.top).then((room) => {
      if (room !== null) {
        setMaxHeight(Math.max(menuHeight(1), room));
      }
    });
    roomBeside(position.left).then((room) => {
      if (room !== null) {
        setMaxWidth(Math.max(PANEL_MIN_WIDTH, Math.min(PANEL_MAX_WIDTH, room)));
      }
    });
  }, [position]);
  // The GM's own choice, remembered in their browser: hidden creatures in
  // the list or not (say, while sharing their screen). Players never get them.
  const [showHidden, setShowHidden] = useState(() => readShowHidden());
  // Sight: whether the terrain between them hides the token from the origin (only with a terrain).
  const [sightOn, setSightOn] = useState(() => readSight());

  useEffect(() => {
    let mounted = true;
    Promise.all([
      OBR.scene.getMetadata(),
      OBR.scene.items.getItems(),
      OBR.scene.grid.getDpi(),
      OBR.scene.grid.getScale(),
      getGridType(),
      OBR.player.getRole(),
      OBR.player.getSelection(),
    ])
      .then(([metadata, items, dpi, scale, type, role, selection]) => {
        if (!mounted) {
          return;
        }
        setMetadata(metadata);
        setItems(items);
        setGrid({ dpi, scale, axonometry: axonometryOf(type), type });
        setRole(role);
        setSelection(selection ?? []);
      })
      .catch((error) => console.error("Rising Ranges: failed to load the Distancias panel", error));
    const unsubscribers = [
      OBR.scene.onMetadataChange(setMetadata),
      OBR.scene.items.onChange(setItems),
      OBR.scene.grid.onChange(async (grid) => {
        const [dpi, scale, axonometry] = await Promise.all([
          OBR.scene.grid.getDpi(),
          OBR.scene.grid.getScale(),
          axonometryOf(grid.type),
        ]);
        setGrid({ dpi, scale, axonometry, type: grid.type });
      }),
      OBR.player.onChange((player) => {
        setRole(player.role);
        setSelection(player.selection ?? []);
      }),
    ];
    return () => {
      mounted = false;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  // A player never gets distances to tokens the GM has hidden (or to what's attached to them, see
  // util/attachments.ts).
  const byId = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const tokens = useMemo(
    () =>
      items
        .filter((item): item is Image => isImage(item) && item.layer === "CHARACTER")
        .filter((token) => visibleNow(byId, token) || (role === "GM" && showHidden))
        .sort((a, b) => tokenName(a).localeCompare(tokenName(b))),
    [items, byId, role, showHidden]
  );
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  const hasTokens = tokens.length > 0;

  // Selecting a token (with Owlbear's own tools) makes it the origin; the
  // dropdown can still pick any other one by hand.
  useEffect(() => {
    const selected = tokensRef.current.find((token) => selection.includes(token.id));
    if (selected) {
      setOriginId(selected.id);
    }
  }, [selection, hasTokens]);

  // The popover fits its content: the table's natural width (long Banda
  // or token names widen it, short ones narrow it) and the content's
  // height, within fixed bounds — past the height bound the page scrolls.
  // Checked after every render, but only resized when it actually changes.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) {
      return;
    }
    // The head's columns as wide as the rows' (each as the widest of its name and its values).
    const widths = [...(sizerRef.current?.children ?? [])].map((cell) => cell.getBoundingClientRect().width);
    if (widths.length !== headWidths.length || widths.some((width, i) => Math.abs(width - headWidths[i]) > 0.5)) {
      setHeadWidths(widths);
    }
    // All of it: what stays put (the token, the buttons, the head) and the rows, however tall.
    const contentHeight = Math.ceil(
      content.getBoundingClientRect().height + (bodyRef.current?.getBoundingClientRect().height ?? 0)
    );
    const menuRoom = menuOpen || menuWanted.current ? menuHeight(tokens.length) : 0;
    // The room inside: its size set by hand, or as much as the screen allows. The size set by hand is
    // as big as it gets: with fewer rows (or no token picked) it's only as tall as they are, and with
    // a narrower table only as wide.
    const roomHeight = manualSize ? Math.min(maxHeight, manualSize.height - FRAME) : maxHeight;
    const roomWidth = manualSize ? Math.min(maxWidth, Math.max(PANEL_MIN_WIDTH, manualSize.width - FRAME)) : maxWidth;
    const height = Math.min(maxHeight, Math.max(Math.min(contentHeight, roomHeight), menuRoom)) + FRAME;
    const scrollbar = contentHeight > roomHeight ? SCROLLBAR_WIDTH : 0;
    // Only scrolls when the content really is taller than the panel can get;
    // otherwise the scrollbar flashed while Owlbear caught up with a resize.
    if (scrollRef.current) {
      scrollRef.current.style.overflowY = scrollbar ? "auto" : "hidden";
    }
    const natural = tableRef.current?.getBoundingClientRect().width;
    const wanted = natural ? Math.ceil(natural) + PANEL_PADDING_WIDTH + scrollbar : 0;
    const width = Math.min(roomWidth, Math.max(PANEL_MIN_WIDTH, wanted)) + FRAME;
    // A table wider than the panel can be (or than it's been made) scrolls sideways instead.
    if (scrollRef.current) {
      scrollRef.current.style.overflowX = wanted > roomWidth ? "auto" : "hidden";
    }
    if (Math.abs(width - panelSize.current.width) > 2) {
      panelSize.current.width = width;
      OBR.popover.setWidth(DISTANCES_POPOVER_ID, width);
    }
    if (Math.abs(height - panelSize.current.height) > 2) {
      panelSize.current.height = height;
      OBR.popover.setHeight(DISTANCES_POPOVER_ID, height);
    }
  });

  async function openMenu() {
    menuWanted.current = true;
    const needed = Math.min(maxHeight, menuHeight(tokens.length)) + FRAME;
    if (needed > panelSize.current.height + 2) {
      panelSize.current.height = needed;
      await OBR.popover.setHeight(DISTANCES_POPOVER_ID, needed);
      await viewportReaches(needed);
    }
    if (menuWanted.current) {
      setMenuOpen(true);
    }
  }

  function closeMenu() {
    menuWanted.current = false;
    setMenuOpen(false);
  }

  if (!metadata || !grid) {
    return null;
  }

  const settings = globalSettingsFromMetadata(metadata);
  const access = settings.distancePanel ?? "off";
  if (access === "off" || (access === "gm" && role !== "GM")) {
    return (
      <Typography ref={contentRef} sx={{ p: 2 }} variant="body2" color="text.secondary">
        {t("distances.disabled")}
      </Typography>
    );
  }

  const bandSet = onGrid(bandSetFromMetadata(metadata), grid.type);
  const altitude = settings.enableAltitude ?? true;
  const heights = altitude
    ? tokenHeightsFromMarkers(items.filter(isTokenHeightMarker), bandSet)
    : new Map<string, number>();
  // Heights are kept above the ground each one stands on; the terrain there is added here.
  const withTerrain = terrainOn(settings, grid.type);
  const terrain = withTerrain ? reliefZones(reliefs, mapAnchors(items), grid.dpi) : [];
  for (const token of withTerrain ? tokens : []) {
    heights.set(token.id, (heights.get(token.id) ?? 0) + terrainAt(terrain, token.position));
  }
  const hasTerrain = terrain.length > 0;
  const origin = tokens.find((token) => token.id === originId);
  const rows = origin
    ? computeDistanceRows(
        origin,
        tokens.filter((token) => token.id !== origin.id),
        heights,
        bandSet,
        grid.dpi,
        grid.axonometry
      )
    : [];
  /** The terrain between the origin's eye and a token's hides it (with the sight on, and a terrain). */
  const hidden = (token: Image) =>
    !!origin &&
    sightOn &&
    hasTerrain &&
    !inSight(
      (x, y) => terrainAt(terrain, { x, y }),
      { ...origin.position, z: (heights.get(origin.id) ?? 0) + EYE },
      { ...token.position, z: (heights.get(token.id) ?? 0) + EYE },
      grid.dpi
    );
  const theme = getStoredTheme();
  const distanceText = (gridUnits: number) => formatDistance(grid.scale, gridUnits);

  // The columns' names, in the head that stays put and (unseen) in the rows' table.
  const heads: { label: string; tooltip?: string; right?: boolean }[] = [
    { label: t("distances.token") },
    { label: t("distances.band") },
    ...(altitude
      ? [
          { label: t("distances.horizontal"), tooltip: t("distances.horizontalTooltip"), right: true },
          { label: t("distances.vertical"), tooltip: t("distances.verticalTooltip"), right: true },
        ]
      : []),
    { label: t(altitude ? "distances.total" : "distances.distance"), tooltip: t("distances.totalTooltip"), right: true },
  ];
  const showTable = !!origin && rows.length > 0;

  // The token, the buttons and the columns' names stay put; only the rows
  // scroll, in their own box (so nothing has to be drawn over them). It
  // scrolls rather than the page: the extension's scrollbar style
  // (settings/index.css) deliberately leaves the page's own scrollbar alone.
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <Stack ref={contentRef} sx={{ p: 1, pb: showTable ? 0 : 1, gap: 1, flexShrink: 0 }}>
        <Stack direction="row" alignItems="center" gap={0.5}>
          <DragHandle position={position} size={() => panelSize.current} onMoved={setPosition} />
          <Select
            aria-label={t("distances.origin")}
            value={origin ? origin.id : ""}
            onChange={(event) => setOriginId(event.target.value || null)}
            size="small"
            displayEmpty
            open={menuOpen}
            onOpen={openMenu}
            onClose={closeMenu}
            // 32px as the other small fields: the token's picture (24px) sets its height.
            sx={{ flexGrow: 1, minWidth: 0, "& .MuiSelect-select": { py: "3px" } }}
          >
            <MenuItem value="">
              <Box component="span" sx={{ color: "text.secondary" }}>{t("distances.pickToken")}</Box>
            </MenuItem>
            {tokens.map((token) => (
              <MenuItem key={token.id} value={token.id}>
                <TokenLabel token={token} />
              </MenuItem>
            ))}
          </Select>
          {/* The header's buttons get the browser's own tooltip (title), not
              MUI's: MUI's is drawn inside the panel's page, and a one-row
              panel has no room for it. The browser draws its own over
              everything. */}
          {hasTerrain && (
            <IconButton
              size="small"
              aria-label={t(sightOn ? "distances.sightOff" : "distances.sightOn")}
              title={t(sightOn ? "distances.sightOff" : "distances.sightOn")}
              aria-pressed={sightOn}
              color={sightOn ? "primary" : "default"}
              // On: its icon in the accent on a faint accent, as Owlbear's toolbar (and the Vistazo's buttons).
              sx={sightOn ? { bgcolor: (theme) => alpha(theme.palette.primary.main, 0.18), "&:hover": { bgcolor: (theme) => alpha(theme.palette.primary.main, 0.26) } } : undefined}
              onClick={() => {
                setSightOn(!sightOn);
                writeSight(!sightOn);
              }}
            >
              <LandscapeRounded fontSize="small" />
            </IconButton>
          )}
          {role === "GM" && (
            <IconButton
              size="small"
              aria-label={t(showHidden ? "distances.hideHidden" : "distances.showHidden")}
              title={t(showHidden ? "distances.hideHidden" : "distances.showHidden")}
              aria-pressed={showHidden}
              onClick={() => {
                setShowHidden(!showHidden);
                writeShowHidden(!showHidden);
              }}
            >
              {showHidden ? <VisibilityOutlined fontSize="small" /> : <VisibilityOffOutlined fontSize="small" />}
            </IconButton>
          )}
          <IconButton
            size="small"
            aria-label={t("distances.close")}
            title={t("distances.close")}
            onClick={closeDistancesPanel}
          >
            <CloseRounded fontSize="small" />
          </IconButton>
        </Stack>
        {origin && rows.length === 0 && (
          <Typography sx={{ p: 1 }} variant="body2" color="text.secondary">
            {t("distances.noOtherTokens")}
          </Typography>
        )}
        {/* The head that's seen: its columns as wide as the rows' (see the sizer row); moved
            sideways with them when they scroll that way. Screen readers get the rows' own. */}
        {showTable && (
          <div ref={headRef} aria-hidden style={{ overflow: "hidden" }}>
            <Table
              size="small"
              sx={{ tableLayout: "fixed", width: headWidths.reduce((sum, width) => sum + width, 0) || "max-content" }}
            >
              <colgroup>
                {headWidths.map((width, i) => (
                  <col key={i} style={{ width }} />
                ))}
              </colgroup>
              <TableHead>
                <TableRow>
                  {heads.map((head, i) => (
                    <TableCell key={i} sx={headSx} align={head.right ? "right" : "left"}>
                      {head.tooltip ? (
                        <Tooltip title={head.tooltip}>
                          <span>{head.label}</span>
                        </Tooltip>
                      ) : (
                        head.label
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
            </Table>
          </div>
        )}
      </Stack>
      <ResizeHandle
        min={{ width: PANEL_MIN_WIDTH + FRAME, height: PANEL_MIN_HEIGHT }}
        onResize={setManualSize}
        onDone={savePanelSize}
        onReset={() => {
          setManualSize(null);
          savePanelSize(null);
        }}
      />
      {showTable && origin && (
        <div
          ref={scrollRef}
          style={{ flex: "1 1 auto", minHeight: 0, overflowY: "hidden" }}
          onScroll={(event) => {
            if (headRef.current) {
              headRef.current.scrollLeft = event.currentTarget.scrollLeft;
            }
          }}
        >
          <Box ref={bodyRef} sx={{ px: 1, pb: 1 }}>
            <div ref={tableRef} style={{ width: "max-content" }}>
              <Table size="small" aria-label={t("distances.tableLabel", { name: tokenName(origin) })}>
                <TableHead>
                  <TableRow ref={sizerRef}>
                    {heads.map((head, i) => (
                      <TableCell key={i} sx={sizerSx} align={head.right ? "right" : "left"}>
                        {head.label}
                      </TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                  <TableBody>
                    {rows.map((row) => {
                      const band = row.bandIndex === null ? null : measuredBands(bandSet)[row.bandIndex];
                      const height = distanceText(Math.abs(row.heightDifference));
                      // Up or down only if it shows as more than 0 (a hair's difference reads as level):
                      // "0 ft" then, with no arrow (nor a dash: it would read as a minus).
                      const level = height === distanceText(0);
                      return (
                        <TableRow key={row.token.id}>
                          <TableCell sx={cellSx}>
                            {/* Clicking another token measures from it instead. */}
                            <ButtonBase
                              onClick={() => setOriginId(row.token.id)}
                              aria-label={t("distances.measureFrom", { name: tokenName(row.token) })}
                              title={t("distances.measureFrom", { name: tokenName(row.token) })}
                              sx={{ borderRadius: 999, pr: 0.75, textAlign: "left", font: "inherit", "&:hover": { bgcolor: "action.hover" } }}
                            >
                              <TokenLabel token={row.token} />
                            </ButtonBase>
                            {hidden(row.token) && (
                              <span title={t("distances.noSight")} aria-label={t("distances.noSight")} style={{ display: "inline-flex", verticalAlign: "middle", opacity: 0.75 }}>
                                <VisibilityOffOutlined sx={{ fontSize: 16 }} />
                              </span>
                            )}
                          </TableCell>
                          <TableCell sx={{ ...cellSx, whiteSpace: "nowrap" }}>
                            <Stack direction="row" alignItems="center" gap={0.75}>
                              {band && row.bandIndex !== null && (
                                <span
                                  aria-hidden
                                  style={{
                                    flexShrink: 0,
                                    width: 10,
                                    height: 10,
                                    borderRadius: "50%",
                                    background: getColorString(
                                      theme.colors[row.bandIndex % theme.colors.length]
                                    ),
                                  }}
                                />
                              )}
                              {band ? band.name : t("onMap.outOfRange")}
                            </Stack>
                          </TableCell>
                          {/* The legs of the Total: useful, but secondary, so in a lighter gray. */}
                          {altitude && (
                            <>
                              <TableCell sx={{ ...cellSx, whiteSpace: "nowrap", color: "text.secondary" }} align="right">
                                {distanceText(row.horizontal)}
                              </TableCell>
                              <TableCell sx={{ ...cellSx, whiteSpace: "nowrap", color: "text.secondary" }} align="right">
                                {level ? (
                                  <span aria-label={t("distances.sameHeight")}>{height}</span>
                                ) : (
                                  <span
                                    aria-label={t(
                                      row.heightDifference > 0 ? "distances.above" : "distances.below",
                                      { distance: height }
                                    )}
                                  >
                                    {row.heightDifference > 0 ? "↑" : "↓"} {height}
                                  </span>
                                )}
                              </TableCell>
                            </>
                          )}
                          <TableCell sx={{ ...cellSx, whiteSpace: "nowrap", fontWeight: 600 }} align="right">
                            {/* Same arrow as the Vert. column, so it reads on its own too (and with no height columns). */}
                            {level ? "" : row.heightDifference > 0 ? "↑ " : "↓ "}
                            {distanceText(row.distance)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
            </div>
          </Box>
        </div>
      )}
    </div>
  );
}
