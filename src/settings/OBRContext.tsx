import OBR, { type GridScale, type GridType } from "@owlbear-rodeo/sdk";
import { createContext, useContext, useState, useEffect } from "react";
import { bandSetFromMetadata, resolveBandSet } from "../bandSets/bandSets";
import { adoptSceneRanges, loadRanges } from "../bandSets/library";
import { BandSet } from "../engine/types";
import { Language, languageFromMetadata, setLanguage as persistLanguage } from "../i18n/language";
import { displayFromMetadata, type DisplaySettings } from "./display";

type OBRContextValue = {
  gridScale: GridScale;
  /** The scene's grid type, live (Elevación's perspective options only work on some). */
  gridType: GridType;
  bandSet: BandSet;
  /** The room's custom sets (see bandSets/library.ts), as the page loaded. */
  customBandSets: BandSet[];
  /** Sets an earlier version kept in this scene that didn't fit in the room's list. */
  leftBehind: BandSet[];
  // Live (not just the initial fetch) and shared via context — most of the
  // settings tree needs to read the current language for useTranslation(),
  // far more call sites than bandSet's own "fetch once, prop-drill from
  // Settings.tsx" pattern would be worth threading through.
  language: Language;
  onChangeLanguage: (language: Language) => void;
  /** The room's display settings as of when this page loaded (the settings tabs keep their own live copy). */
  display: DisplaySettings;
};

const OBRContext = createContext<OBRContextValue | null>(null);

export function OBRContextProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [gridScale, setGridScale] = useState<GridScale | null>(null);
  useEffect(() => {
    let mounted = true;
    OBR.scene.grid.getScale().then((scale) => {
      if (mounted) {
        setGridScale(scale);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const [gridType, setGridType] = useState<GridType | null>(null);
  useEffect(() => {
    let mounted = true;
    OBR.scene.grid.getType().then((type) => {
      if (mounted) {
        setGridType(type);
      }
    });
    const stop = OBR.scene.grid.onChange((grid) => setGridType(grid.type));
    return () => {
      mounted = false;
      stop();
    };
  }, []);

  const [bandSet, setBandSet] = useState<BandSet | null>(null);
  const [customBandSets, setCustomBandSets] = useState<BandSet[] | null>(
    null
  );
  const [leftBehind, setLeftBehind] = useState<BandSet[]>([]);
  const [language, setLanguageState] = useState<Language | null>(null);
  const [display, setDisplay] = useState<DisplaySettings | null>(null);
  useEffect(() => {
    let mounted = true;
    Promise.all([OBR.scene.getMetadata(), loadRanges(), OBR.player.getRole()]).then(async ([metadata, room, role]) => {
      // A GM moves an earlier version's scene-kept sets up to the room (a player doesn't write).
      const { ranges, left } = role === "GM" ? await adoptSceneRanges(metadata, room) : { ranges: room, left: [] };
      if (mounted) {
        const language = languageFromMetadata(metadata);
        setBandSet(bandSetFromMetadata(metadata));
        setCustomBandSets(ranges);
        setLeftBehind(left);
        setLanguageState(language);
        setDisplay(displayFromMetadata(metadata));
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  function onChangeLanguage(next: Language) {
    setLanguageState(next);
    // A default preset's Bandas need to switch names right away too, not
    // just on the next reload — a custom BandSet (no matching default id)
    // passes through resolveBandSet unchanged.
    setBandSet((current) => (current ? resolveBandSet(current, next) : current));
    persistLanguage(next);
  }

  if (!gridScale || !gridType || !bandSet || !customBandSets || !language || !display) {
    return null;
  }

  return (
    <OBRContext.Provider
      value={{ gridScale, gridType, bandSet, customBandSets, leftBehind, language, onChangeLanguage, display }}
    >
      {children}
    </OBRContext.Provider>
  );
}

export function useOBRContext() {
  const context = useContext(OBRContext);
  if (!context) {
    throw new Error("useOBRContext must be used within an OBRContextProvider");
  }
  return context;
}
