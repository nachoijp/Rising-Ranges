import { getPluginId } from "../util/getPluginId";

// Shared by the toolbar action that opens Opciones and the page itself
// (which resizes it to fit its content). No UI imports: the background
// script uses this too.

export const SETTINGS_POPOVER_ID = getPluginId("popover/settings");

/** The panel's content width (the popover adds the glass margin around it). */
export const SETTINGS_WIDTH = 380;
/** Bounds for the content height the page fits itself to; past the max, the tab body scrolls. The max is replaced by the room actually left on screen (see roomBelow) as soon as Owlbear reports it. */
export const SETTINGS_MIN_HEIGHT = 300;
export const SETTINGS_MAX_HEIGHT = 605;
/** Roughly where the popover's top lands: just under the toolbar button it opens from. */
export const SETTINGS_TOP = 56;
/** Only until the page has measured its content. */
export const SETTINGS_INITIAL_HEIGHT = 480;
