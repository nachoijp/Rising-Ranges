import { tabState } from "../obr";

// The Vistazo in a tab of its own (vistazo-tab.html, see tabHost.ts; the Vistazo in it, see src/obr.ts):
// opened from the Vistazo in Owlbear, which tells it where Owlbear is; and a note over it while its link
// to Owlbear isn't there (looking for it, gone quiet, Owlbear closed or reloaded), gone once it is.

export const TAB_NAME = "rising-ranges-vistazo";

/**
 * Opens the Vistazo's tab (the same one again if it's open: it's named) and tells it where Owlbear is
 * (its window: this page's top), till it says it's heard (it may take a moment to load). "blocked": the
 * browser stopped it; "unheard": it never answered.
 */
export function openVistazoTab(): Promise<"ok" | "blocked" | "unheard"> {
  const tab = window.open(new URL("/vistazo-tab.html", location.href).href, TAB_NAME);
  if (!tab) {
    return Promise.resolve("blocked");
  }
  return tellTab(tab);
}

/** Tells the Vistazo's tab where Owlbear is (this page's top), till it says it's heard, a few seconds at most. */
export function tellTab(tab: Window): Promise<"ok" | "unheard"> {
  return new Promise((resolve) => {
    const started = Date.now();
    const done = (how: "ok" | "unheard") => {
      clearInterval(timer);
      window.removeEventListener("message", heard);
      resolve(how);
    };
    const heard = (event: MessageEvent) => {
      if (event.source === tab && event.origin === window.origin && (event.data as { rrTab?: string } | null)?.rrTab === "heard") {
        done("ok");
      }
    };
    window.addEventListener("message", heard);
    const timer = window.setInterval(() => {
      if (Date.now() - started > 6000) {
        done("unheard");
        return;
      }
      try {
        tab.postMessage({ rrTab: "here" }, window.origin);
      } catch {
        // Not loaded yet: again.
      }
    }, 150);
  });
}

/** The note, its text by the link's state (`text`: the page's language). */
export function showTabLink(text: (state: "searching" | "lost" | "closed" | "taken") => string) {
  const note = document.createElement("div");
  note.className = "tab-link";
  note.setAttribute("role", "status");
  document.body.append(note);
  const update = () => {
    const state = tabState();
    note.hidden = state === "connected";
    if (state !== "connected") {
      note.textContent = text(state);
    }
  };
  update();
  window.setInterval(update, 1000);
}
