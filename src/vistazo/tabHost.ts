import type { TabMessage } from "../obr";

// The Vistazo's own tab (vistazo-tab.html): the Vistazo in a frame (vistazo.html?tab), and this page in
// between it and Owlbear. The Vistazo in Owlbear that opens it says where Owlbear is ("here": its
// window), which this page keeps (a new scene loads the frame again; this page, and that, stay). The
// frame's messages go to the extension's background among Owlbear's frames (found by asking them all),
// and the background's back to the frame.

const origin = window.origin;
const frame = document.getElementById("vistazo") as HTMLIFrameElement;
const note = document.getElementById("note") as HTMLElement;
const spanish = navigator.language.toLowerCase().startsWith("es");
note.textContent = spanish ? "Abrí el Vistazo en pestaña desde Owlbear para conectar esta pestaña." : "Open the Glance in a tab from Owlbear to link this tab.";

let owlbear: Window | null = null;
let relay: Window | null = null;
/** The frame's session (its last "find"): what's told to it about Owlbear goes under it. */
let session = "";

const toFrame = (message: TabMessage) => frame.contentWindow?.postMessage(message, origin);

/** The frame's "find" to each of Owlbear's frames (the background answers it). */
function find(message: TabMessage) {
  if (!owlbear || owlbear.closed) {
    toFrame({ rrTab: "closed", session });
    return;
  }
  const walk = (w: Window, depth: number) => {
    let n = 0;
    try {
      n = w.frames.length;
    } catch {
      return;
    }
    for (let i = 0; i < n && depth < 4; i++) {
      try {
        const child = w.frames[i];
        child.postMessage(message, "*");
        walk(child, depth + 1);
      } catch {
        // Not reachable: the next.
      }
    }
  };
  walk(owlbear, 0);
}

window.addEventListener("message", (event) => {
  const data = event.data as TabMessage | { rrTab: "here" } | null;
  if (event.origin !== origin || !data?.rrTab || !event.source) {
    return;
  }
  const source = event.source as Window;
  if (data.rrTab === "here") {
    // From the Vistazo in Owlbear: where Owlbear is. The frame (re)started with it.
    try {
      owlbear = source.top;
    } catch {
      owlbear = null;
    }
    source.postMessage({ rrTab: "heard" }, origin);
    if (owlbear) {
      relay = null;
      note.hidden = true;
      frame.hidden = false;
      const url = new URL("/vistazo.html?tab", location.href).href;
      if (frame.src !== url) {
        frame.src = url;
      } else {
        frame.contentWindow?.location.reload();
      }
    }
    return;
  }
  if (source === frame.contentWindow) {
    if (data.rrTab === "find") {
      session = data.session;
      find(data);
    } else {
      relay?.postMessage(data, origin);
    }
    return;
  }
  // The background's (among Owlbear's frames): to the frame.
  if (data.rrTab === "found") {
    relay = source;
  }
  if (source === relay || data.rrTab === "taken") {
    toFrame(data);
  }
});

// The tab closed: the background told (the frame's own bye may not get out in time).
window.addEventListener("pagehide", () => {
  if (session) {
    relay?.postMessage({ rrTab: "bye", session } satisfies TabMessage, origin);
  }
});

// Owlbear closed or reloaded (its window gone): the frame's told.
window.setInterval(() => {
  if (owlbear?.closed && session) {
    relay = null;
    toFrame({ rrTab: "closed", session });
  }
}, 1000);
