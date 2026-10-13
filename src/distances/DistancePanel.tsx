import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import OBR, { isImage, type GridScale, type Image, type Item } from "@owlbear-rodeo/sdk";

import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import Select from "@mui/material/Select";
import MenuItem from "@mui/material/MenuItem";
import IconButton from "@mui/material/IconButton";
import ButtonBase from "@mui/material/ButtonBase";
import Table from "@mui/material/Table";
import TableBody from "@mui/material/TableBody";
import TableCell from "@mui/material/TableCell";
import TableHead from "@mui/material/TableHead";
import TableRow from "@mui/material/TableRow";
import Tooltip from "@mui/material/Tooltip";
import Close from "@mui/icons-material/Close";

import { useTranslation } from "../i18n/useTranslation";
import { GLASS_FRAME } from "../util/glass";
import { roomBelow, roomBeside } from "../util/roomBelow";
import { DragHandle } from "./DragHandle";
import { measuredBands } from "../engine/bands";
import VisibilityRounded from "@mui/icons-material/VisibilityRounded";
import VisibilityOffRounded from "@mui/icons-material/VisibilityOffRounded";
import { viewportReaches } from "../util/menuRoom";
import { getColorString } from "../util/color";
import { formatDistance } from "../util/flattenGridScale";
import { getStoredTheme } from "../theme/themes";
import { bandSetFromMetadata } from "../bandSets/bandSets";
import { globalSettingsFromMetadata } from "../settings/globalSettings";
import { isTokenHeightMarker, tokenHeightsFromMarkers } from "../tokenHeight/markers";
import { terrainAt, terrainZones } from "../terrain/terrain";
import { computeDistanceRows, tokenName } from "./rows";
import {
  DISTANCES_POPOVER_ID,
  PANEL_MAX_HEIGHT,
  getPanelPosition,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  closeDistancesPanel,
} from "./panelPopover";

type Grid = { dpi: number; scale: GridScale };

// Five columns in a narrow popover: tighter than MUI's small-table padding.
const cellSx = { px: 0.75, py: 0.5 };
// The header row is a pill, like the rest of the extension's controls:
// rounded ends, no rule underneath, a solid tint (it stays stuck on top
// while rows scroll under it, so it can't be see-through).
const headSx = {
  ...cellSx,
  borderBottom: "none",
  bgcolor: "background.default",
  "&:first-of-type": { borderTopLeftRadius: 999, borderBottomLeftRadius: 999, pl: 1.5 },
  "&:last-of-type": { borderTopRightRadius: 999, borderBottomRightRadius: 999, pr: 1.5 },
};
// The page's own side padding (p: 1), added to the table's natural width
// when sizing the popover to fit it — plus room for a vertical scrollbar,
// only when the content is too tall to fit and the page has to scroll.
const PANEL_PADDING_WIDTH = 16;
const SCROLLBAR_WIDTH = 14;
// The glass frames around the content (see GlassFrame): the popover is
// this much bigger than the content it fits.
const FRAME = GLASS_FRAME;
// Rough room the open dropdown list needs: where it starts (just under the
// select) plus one row per option, the "pick a token" one included.
const MENU_TOP = 64;
const MENU_ITEM_HEIGHT = 40;
const menuHeight = (options: number) => MENU_TOP + (options + 1) * MENU_ITEM_HEIGHT;

const THUMB_SIZE = 24;

/** The token's own image, small — many tokens show no name on the map, so this is how they're recognized here. */
function TokenThumb({ token }: { token: Image }) {
  const [broken, setBroken] = useState(false);
  const style = { width: THUMB_SIZE, height: THUMB_SIZE, flexShrink: 0, borderRadius: "50%" };
  if (broken || !token.image?.url) {
    return (
      <span aria-hidden style={{ ...style, display: "inline-block", background: "rgba(127,127,127,0.4)" }} />
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

export function DistancePanel() {
  const t = useTranslation();
  const [metadata, setMetadata] = useState<Record<string, unknown> | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [role, setRole] = useState<"GM" | "PLAYER">("PLAYER");
  const [selection, setSelection] = useState<string[]>([]);
  const [originId, setOriginId] = useState<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelSize = useRef({ width: PANEL_MIN_WIDTH, height: 0 });
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

  useEffect(() => {
    let mounted = true;
    Promise.all([
      OBR.scene.getMetadata(),
      OBR.scene.items.getItems(),
      OBR.scene.grid.getDpi(),
      OBR.scene.grid.getScale(),
      OBR.player.getRole(),
      OBR.player.getSelection(),
    ])
      .then(([metadata, items, dpi, scale, role, selection]) => {
        if (!mounted) {
          return;
        }
        setMetadata(metadata);
        setItems(items);
        setGrid({ dpi, scale });
        setRole(role);
        setSelection(selection ?? []);
      })
      .catch((error) => console.error("Rising Ranges: failed to load the Distancias panel", error));
    const unsubscribers = [
      OBR.scene.onMetadataChange(setMetadata),
      OBR.scene.items.onChange(setItems),
      OBR.scene.grid.onChange(async () => {
        const [dpi, scale] = await Promise.all([OBR.scene.grid.getDpi(), OBR.scene.grid.getScale()]);
        setGrid({ dpi, scale });
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

  // A player never gets distances to tokens the GM has hidden.
  const tokens = useMemo(
    () =>
      items
        .filter((item): item is Image => isImage(item) && item.layer === "CHARACTER")
        .filter((token) => token.visible || (role === "GM" && showHidden))
        .sort((a, b) => tokenName(a).localeCompare(tokenName(b))),
    [items, role, showHidden]
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
    const contentHeight = Math.ceil(content.getBoundingClientRect().height);
    const height =
      Math.min(
        maxHeight,
        Math.max(contentHeight, menuOpen || menuWanted.current ? menuHeight(tokens.length) : 0)
      ) + FRAME;
    const scrollbar = contentHeight > maxHeight ? SCROLLBAR_WIDTH : 0;
    // Only scrolls when the content really is taller than the panel can get;
    // otherwise the scrollbar flashed while Owlbear caught up with a resize.
    if (scrollRef.current) {
      scrollRef.current.style.overflowY = scrollbar ? "auto" : "hidden";
    }
    const natural = tableRef.current?.getBoundingClientRect().width;
    const wanted = natural ? Math.ceil(natural) + PANEL_PADDING_WIDTH + scrollbar : 0;
    const width = Math.min(maxWidth, Math.max(PANEL_MIN_WIDTH, wanted)) + FRAME;
    // A table wider than the screen allows scrolls sideways instead.
    if (scrollRef.current) {
      scrollRef.current.style.overflowX = wanted > maxWidth ? "auto" : "hidden";
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

  const bandSet = bandSetFromMetadata(metadata);
  const altitude = settings.enableAltitude ?? true;
  const heights = altitude
    ? tokenHeightsFromMarkers(items.filter(isTokenHeightMarker), bandSet)
    : new Map<string, number>();
  // Heights are kept above the ground each one stands on; the terrain there is added here.
  if (altitude) {
    const terrain = terrainZones(items);
    for (const token of tokens) {
      heights.set(token.id, (heights.get(token.id) ?? 0) + terrainAt(terrain, token.position));
    }
  }
  const origin = tokens.find((token) => token.id === originId);
  const rows = origin
    ? computeDistanceRows(
        origin,
        tokens.filter((token) => token.id !== origin.id),
        heights,
        bandSet,
        grid.dpi
      )
    : [];
  const theme = getStoredTheme();
  const distanceText = (gridUnits: number) => formatDistance(grid.scale, gridUnits);

  // Scrolls inside its own box rather than the page: the extension's
  // scrollbar style (settings/index.css) deliberately leaves the page's own
  // scrollbar alone.
  return (
    <div ref={scrollRef} style={{ height: "100%", overflowY: "hidden" }}>
      <Stack ref={contentRef} sx={{ p: 1, gap: 1 }}>
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
            sx={{ flexGrow: 1, minWidth: 0 }}
          >
            <MenuItem value="">
              <em>{t("distances.pickToken")}</em>
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
              {showHidden ? <VisibilityRounded fontSize="small" /> : <VisibilityOffRounded fontSize="small" />}
            </IconButton>
          )}
          <IconButton
            size="small"
            aria-label={t("distances.close")}
            title={t("distances.close")}
            onClick={closeDistancesPanel}
          >
            <Close fontSize="small" />
          </IconButton>
        </Stack>
        {origin && (
          <Stack>
            {rows.length === 0 ? (
              <Typography sx={{ p: 1 }} variant="body2" color="text.secondary">
                {t("distances.noOtherTokens")}
              </Typography>
            ) : (
              <div ref={tableRef} style={{ width: "max-content" }}>
                <Table
                  size="small"
                  stickyHeader
                  aria-label={t("distances.tableLabel", { name: tokenName(origin) })}
                >
                  <TableHead>
                    <TableRow>
                      <TableCell sx={headSx}>{t("distances.token")}</TableCell>
                      <TableCell sx={headSx}>{t("distances.band")}</TableCell>
                      {altitude && (
                        <>
                          <TableCell sx={headSx} align="right">
                            <Tooltip title={t("distances.horizontalTooltip")}>
                              <span>{t("distances.horizontal")}</span>
                            </Tooltip>
                          </TableCell>
                          <TableCell sx={headSx} align="right">
                            <Tooltip title={t("distances.verticalTooltip")}>
                              <span>{t("distances.vertical")}</span>
                            </Tooltip>
                          </TableCell>
                        </>
                      )}
                      <TableCell sx={headSx} align="right">
                        <Tooltip title={t("distances.totalTooltip")}>
                          <span>{t(altitude ? "distances.total" : "distances.distance")}</span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rows.map((row) => {
                      const band = row.bandIndex === null ? null : measuredBands(bandSet)[row.bandIndex];
                      const height = distanceText(Math.abs(row.heightDifference));
                      return (
                        <TableRow key={row.token.id}>
                          <TableCell sx={cellSx}>
                            {/* Clicking another token measures from it instead. */}
                            <ButtonBase
                              onClick={() => setOriginId(row.token.id)}
                              aria-label={t("distances.measureFrom", { name: tokenName(row.token) })}
                              title={t("distances.measureFrom", { name: tokenName(row.token) })}
                              sx={{ borderRadius: 999, pr: 0.75, textAlign: "left", font: "inherit" }}
                            >
                              <TokenLabel token={row.token} />
                            </ButtonBase>
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
                                {row.heightDifference === 0 ? (
                                  <span aria-label={t("distances.sameHeight")}>—</span>
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
                            {row.heightDifference > 0 ? "↑ " : row.heightDifference < 0 ? "↓ " : ""}
                            {distanceText(row.distance)}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </Stack>
        )}
      </Stack>
    </div>
  );
}
