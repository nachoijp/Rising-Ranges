import type { T } from "./panel";

// The line between the 2D map and the 3D, dragged to give either more room.
// No limit: let go with one of them narrower than MIN and it's hidden (a thin
// bar left at its edge to bring it back, by a click or a drag). A double
// click: half and half again. Kept for the next time.

const KEY = "rising-ranges/relief-editor/split";
/** Narrower than this (of the width) when it's let go: hidden. */
const MIN = 0.15;

type State = { ratio: number; hidden: "" | "map" | "stage" };

function load(): State {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<State>;
    return { ratio: typeof s.ratio === "number" && s.ratio > 0 && s.ratio < 1 ? s.ratio : 0.5, hidden: s.hidden === "map" || s.hidden === "stage" ? s.hidden : "" };
  } catch {
    return { ratio: 0.5, hidden: "" };
  }
}

function keep(state: State) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Only a convenience.
  }
}

/** The line in `box` (the grid with the map and the 3D side by side); taken away by what it returns. */
export function installSplit(box: HTMLElement, t: T): () => void {
  const state = load();
  const line = document.createElement("div");
  line.className = "re-split";
  line.setAttribute("role", "separator");
  line.setAttribute("aria-orientation", "vertical");
  line.tabIndex = 0;
  box.append(line);
  const apply = (ratio = state.ratio, hidden = state.hidden) => {
    box.style.setProperty(
      "--re-cols",
      hidden === "map" ? "0px minmax(0, 1fr)" : hidden === "stage" ? "minmax(0, 1fr) 0px" : `minmax(0, ${ratio}fr) minmax(0, ${1 - ratio}fr)`
    );
    box.classList.toggle("re-map-hidden", hidden === "map");
    box.classList.toggle("re-stage-hidden", hidden === "stage");
    line.classList.toggle("edge", hidden !== "");
    line.style.left = hidden === "map" ? "0px" : hidden === "stage" ? "100%" : `${ratio * 100}%`;
    const text = hidden === "map" ? t("relief.split.showMap") : hidden === "stage" ? t("relief.split.show3d") : t("relief.split.drag");
    line.innerHTML = hidden ? `<span class="grip">${hidden === "map" ? "›" : "‹"}</span>` : "";
    // Outside the map, where the editor's own tooltips are: the browser's.
    line.title = hidden ? text : `${text}. ${t("relief.split.dragHint")}`;
    line.setAttribute("aria-label", text);
  };
  apply();

  let drag: { moved: boolean; ratio: number } | null = null;
  const ratioAt = (clientX: number) => {
    const r = box.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1)));
  };
  line.onpointerdown = (event) => {
    if (event.button !== 0) {
      return;
    }
    line.setPointerCapture(event.pointerId);
    drag = { moved: false, ratio: state.ratio };
    event.preventDefault();
  };
  line.onpointermove = (event) => {
    if (!drag) {
      return;
    }
    drag.moved = true;
    drag.ratio = ratioAt(event.clientX);
    box.classList.add("re-splitting");
    apply(drag.ratio, "");
  };
  line.onpointerup = () => {
    if (!drag) {
      return;
    }
    const { moved, ratio } = drag;
    drag = null;
    box.classList.remove("re-splitting");
    if (!moved) {
      // A click: a hidden view back as it was.
      if (state.hidden) {
        state.hidden = "";
        apply();
        keep(state);
      }
      return;
    }
    if (ratio < MIN) {
      state.hidden = "map";
    } else if (ratio > 1 - MIN) {
      state.hidden = "stage";
    } else {
      state.hidden = "";
      state.ratio = ratio;
    }
    apply();
    keep(state);
  };
  line.ondblclick = () => {
    state.ratio = 0.5;
    state.hidden = "";
    apply();
    keep(state);
  };
  // From the keyboard: arrows move it, Enter brings a hidden view back.
  line.onkeydown = (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      state.hidden = "";
      state.ratio = Math.min(1 - MIN, Math.max(MIN, state.ratio + (event.key === "ArrowLeft" ? -0.05 : 0.05)));
    } else if (event.key === "Enter" && state.hidden) {
      state.hidden = "";
    } else {
      return;
    }
    event.preventDefault();
    apply();
    keep(state);
  };
  return () => {
    line.remove();
    box.style.removeProperty("--re-cols");
    box.classList.remove("re-map-hidden", "re-stage-hidden", "re-splitting");
  };
}
