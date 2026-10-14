import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import OBR from "@owlbear-rodeo/sdk";

import Stack from "@mui/material/Stack";
import Alert from "@mui/material/Alert";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";

import {
  getDefaultBandSets,
  resolveBandSet,
  setCustomBandSets as storeCustomBandSets,
} from "../bandSets/bandSets";
import { BandSet } from "../engine/types";
import { BandSetSelector } from "./BandSetSelector";
import { BandasTab } from "./BandasTab";
import { MapaTab } from "./MapaTab";
import { AlturaTab } from "./AlturaTab";
import { TerrenoTab } from "./TerrenoTab";
import { GeneralTab } from "./GeneralTab";
import { getPluginId } from "../util/getPluginId";
import { useOBRContext } from "./OBRContext";
import { useTranslation } from "../i18n/useTranslation";
import { deepEqual } from "../util/deepEqual";
import { getGlobalSettings, setGlobalSettings, type GlobalSettings } from "./globalSettings";
import { resolveDisplay, type DisplaySettings } from "./display";
import { GLASS_FRAME } from "../util/glass";
import { roomBelow } from "../util/roomBelow";
import { MenuRoomContext, viewportReaches, type MenuRoom } from "../util/menuRoom";
import {
  SETTINGS_INITIAL_HEIGHT,
  SETTINGS_MAX_HEIGHT,
  SETTINGS_TOP,
  SETTINGS_MIN_HEIGHT,
  SETTINGS_POPOVER_ID,
} from "./settingsPopover";

// The tab body's own bottom padding (pb: 1), part of its natural height.
const BODY_PADDING_BOTTOM = 8;

// MUI's tabs keep a 90px minimum and wide side padding each, so four of
// them overflowed the panel; let them share its width instead.
// Five tabs in uppercase: a little smaller and tighter than MUI's default (14px), so "MEASURES"/"TERRENO" fit beside the rest.
const tabSx = { minWidth: 0, px: 0.5, fontSize: 12.5, letterSpacing: "0.02em" };

export function Settings() {
  const {
    bandSet: initialBandSet,
    customBandSets: initialCustomBandSets,
    language,
  } = useOBRContext();
  const t = useTranslation();
  const [selectedBandSet, setSelectedBandSet] =
    useState<BandSet>(initialBandSet);
  const [editing, setEditing] = useState(false);
  const [customBandSets, setCustomBandSets] = useState<BandSet[]>(
    initialCustomBandSets
  );
  const [tab, setTab] = useState(0);
  const defaultBandSets = useMemo(() => getDefaultBandSets(language), [language]);
  // The room settings every tab but Bandas edits. One copy for all of them,
  // so a change on one tab can't be overwritten by another's stale copy.
  const [settings, setSettings] = useState<GlobalSettings | null>(null);

  // The popover's height follows the content: the set selector and tab
  // strip, plus whatever the open tab holds (an open Avanzado included),
  // within fixed bounds — past the max, the tab body scrolls. While a
  // dropdown is open it's held at the max, so the list gets room (see
  // util/menuRoom.ts).
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const popoverHeight = useRef(SETTINGS_INITIAL_HEIGHT + GLASS_FRAME);
  const openMenus = useRef(0);
  const maxHeight = useRef(SETTINGS_MAX_HEIGHT);
  const fit = useCallback(() => {
    const body = bodyRef.current;
    const content = contentRef.current;
    if (!body || !content) {
      return;
    }
    const natural = body.offsetTop + content.offsetHeight + BODY_PADDING_BOTTOM;
    // Only scrolls when the content really is taller than the popover can
    // get. Otherwise the popover is about to grow to fit, but Owlbear
    // resizes it a moment later — meanwhile the scrollbar flashed on every
    // tab switch. Set here, before the browser paints.
    body.style.overflowY = natural > maxHeight.current ? "auto" : "hidden";
    const height =
      (openMenus.current > 0
        ? maxHeight.current
        : Math.min(maxHeight.current, Math.max(SETTINGS_MIN_HEIGHT, Math.ceil(natural)))) + GLASS_FRAME;
    if (Math.abs(height - popoverHeight.current) > 2) {
      popoverHeight.current = height;
      OBR.popover.setHeight(SETTINGS_POPOVER_ID, height);
    }
  }, []);
  const menuRoom = useMemo<MenuRoom>(
    () => ({
      async request() {
        openMenus.current++;
        const height = maxHeight.current + GLASS_FRAME;
        if (popoverHeight.current < height - 2) {
          popoverHeight.current = height;
          await OBR.popover.setHeight(SETTINGS_POPOVER_ID, height);
          await viewportReaches(height);
        }
      },
      release() {
        openMenus.current = Math.max(0, openMenus.current - 1);
        fit();
      },
    }),
    [fit]
  );
  // As tall as the screen allows below the toolbar, rather than a fixed max.
  useEffect(() => {
    roomBelow(SETTINGS_TOP).then((room) => {
      if (room !== null) {
        maxHeight.current = Math.max(SETTINGS_MIN_HEIGHT, room);
        fit();
      }
    });
  }, [fit]);
  // Re-fit after every render (tab switches, new content) and whenever the
  // content changes size on its own (an Avanzado folding open or shut).
  useLayoutEffect(fit);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) {
      return;
    }
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(content);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fit, settings !== null]);

  useEffect(() => {
    let mounted = true;
    getGlobalSettings().then((stored) => {
      if (mounted) {
        setSettings(stored);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    storeCustomBandSets(customBandSets);
  }, [customBandSets]);

  // selectedBandSet is this component's own local copy (seeded once from
  // context) — it doesn't pick up OBRContext's already-relocalized bandSet
  // on a language change by itself, so a default preset's Bandas names are
  // re-resolved here too whenever the language actually changes.
  useEffect(() => {
    setSelectedBandSet((current) => resolveBandSet(current, language));
  }, [language]);

  function updateSettings(patch: Partial<GlobalSettings>) {
    if (!settings) {
      return;
    }
    const next = { ...settings, ...patch };
    setSettings(next);
    setGlobalSettings(next);
  }

  // Stores the whole display as it looks right now, not just the changed
  // field: a field left unstored keeps falling back to the active BandSet
  // (see resolveDisplay), so picking another set changed the look, and a
  // Filtro Banda cleared in an older room came back from the set.
  function updateDisplay(patch: Partial<DisplaySettings>) {
    if (!settings) {
      return;
    }
    const current = resolveDisplay(settings.display, selectedBandSet, settings);
    updateSettings({ display: { ...current, ...patch } });
  }

  function onSelectBandSet(bandSet: BandSet, edit: boolean = false) {
    setSelectedBandSet(bandSet);
    OBR.scene.setMetadata({ [getPluginId("bandSet")]: bandSet });
    setEditing(edit);
  }

  function onDeleteBandSet(bandSet: BandSet) {
    setCustomBandSets(customBandSets.filter((b) => b.id !== bandSet.id));
    if (bandSet.id === selectedBandSet.id) {
      onSelectBandSet(defaultBandSets[0]);
    }
    setEditing(false);
  }

  function onAddBandSet(bandSet: BandSet) {
    setCustomBandSets([...customBandSets, bandSet]);
    onSelectBandSet(bandSet, true);
  }

  /** A preset's editable copy, selected and opened for editing. */
  function onDuplicateBandSet() {
    onAddBandSet({
      ...selectedBandSet,
      id: crypto.randomUUID(),
      name: t("settings.bandas.copyName", { name: selectedBandSet.name }),
      bands: selectedBandSet.bands.map((band) => ({ ...band, id: crypto.randomUUID() })),
    });
  }

  function onChangeBandSet(bandSet: BandSet) {
    setCustomBandSets(
      customBandSets.map((b) => (b.id === bandSet.id ? bandSet : b))
    );
    if (bandSet.id === selectedBandSet.id) {
      setSelectedBandSet(bandSet);
      OBR.scene.setMetadata({ [getPluginId("bandSet")]: bandSet });
    }
  }

  const unavailableBandSet = useMemo(() => {
    const bandSets = [...customBandSets, ...defaultBandSets];
    return !bandSets.find((b) => b.id === selectedBandSet.id);
  }, [customBandSets, selectedBandSet, defaultBandSets]);

  const outdatedBandSet = useMemo(() => {
    const customBandSet = customBandSets.find(
      (b) => b.id === selectedBandSet.id
    );
    if (!customBandSet) {
      return false;
    }
    return !deepEqual(customBandSet, selectedBandSet);
  }, [customBandSets, selectedBandSet]);

  // A preset's Bandas, calculation mode and tolerance can't be edited —
  // resolveBandSet() always re-resolves a stored default-preset id back to
  // its canonical, un-edited definition (that's what keeps presets
  // correctly re-localized on a language change), so any edit would just be
  // discarded the next time the BandSet is read. Bandas offers a copy
  // instead. Everything on the other tabs is a room setting, editable with
  // any set.
  const isPreset = defaultBandSets.some((b) => b.id === selectedBandSet.id);

  if (!settings) {
    return null;
  }
  const display = resolveDisplay(settings.display, selectedBandSet, settings);

  return (
    <MenuRoomContext.Provider value={menuRoom}>
    <Stack sx={{ height: "100%", p: 1, pb: 0, gap: 1, position: "relative" }}>
      <BandSetSelector
        selectedBandSet={selectedBandSet}
        onSelect={(bandSet) => onSelectBandSet(bandSet)}
        customBandSets={customBandSets}
        defaultBandSets={defaultBandSets}
        onAdd={onAddBandSet}
        onEdit={() => {
          setEditing((prev) => !prev);
        }}
        isEditing={editing}
        isCustom={
          !outdatedBandSet &&
          customBandSets.some((b) => b.id === selectedBandSet.id)
        }
        outdatedBandSet={outdatedBandSet}
        showEditButton={tab === 0}
      />
      {unavailableBandSet && (
        <Alert severity="warning">
          {t("settings.bandSet.notFound", { name: selectedBandSet.name })}
        </Alert>
      )}
      {outdatedBandSet && (
        <Alert severity="warning">
          {t("settings.bandSet.outOfSync", { name: selectedBandSet.name })}
        </Alert>
      )}
      <Tabs
        value={tab}
        onChange={(_, value) => setTab(value)}
        variant="fullWidth"
      >
        <Tab label={t("settings.tab.bandas")} sx={tabSx} />
        <Tab label={t("settings.tab.mapa")} sx={tabSx} />
        <Tab label={t("settings.tab.altura")} sx={tabSx} />
        <Tab label={t("settings.tab.terreno")} sx={tabSx} />
        <Tab label={t("settings.tab.general")} sx={tabSx} />
      </Tabs>
      {/* Never scrolls sideways: a slider's thumb and value label poke a few
          pixels past its track at the ends. */}
      <Stack ref={bodyRef} sx={{ overflowY: "auto", overflowX: "hidden", flexGrow: 1, pb: 1 }}>
        <div ref={contentRef}>
        {tab === 0 && (
          <BandasTab
            bandSet={selectedBandSet}
            defaultIconShape={display.iconShape}
            isPreset={isPreset}
            altitudeEnabled={settings.enableAltitude ?? true}
            editing={editing}
            onChange={onChangeBandSet}
            onDelete={onDeleteBandSet}
            onDuplicate={onDuplicateBandSet}
          />
        )}
        {tab === 1 && (
          <MapaTab display={display} onChange={updateDisplay} bandSet={selectedBandSet} />
        )}
        {tab === 2 && (
          <AlturaTab
            settings={settings}
            onChangeSettings={updateSettings}
            display={display}
            onChangeDisplay={updateDisplay}
          />
        )}
        {tab === 3 && <TerrenoTab settings={settings} onChangeSettings={updateSettings} />}
        {tab === 4 && <GeneralTab settings={settings} onChangeSettings={updateSettings} />}
        </div>
      </Stack>
    </Stack>
    </MenuRoomContext.Provider>
  );
}
