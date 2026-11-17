import type { T } from "./panel";

// The line between the 2D map and the 3D, dragged to give either more room.
// No limit: let go with one of them narrower than MIN and it's hidden (a thin
// bar left at its edge to bring it back, by a click or a drag). A double
// click: half and half again. Kept for the next time.
//
// On a small screen (a phone, a tablet upright), or in touch mode (asked for
// in the "⋯" menu: a tablet with neither mouse nor keyboard), one view at a
// time instead, the whole of it: a 2D | 3D switch, no line.

const KEY = "rising-ranges/relief-editor/split";
/** Narrower than this (of the width) when it's let go: hidden. */
const MIN = 0.15;
/** Smaller than this, one view at a time (side by side, each would be too narrow to work in). */
const SINGLE_W = 900;
const SINGLE_H = 500;

type View = "map" | "stage";
type State = { ratio: number; hidden: "" | View; touch: boolean; single: View };

function load(): State {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<State>;
    return {
      ratio: typeof s.ratio === "number" && s.ratio > 0 && s.ratio < 1 ? s.ratio : 0.5,
      hidden: s.hidden === "map" || s.hidden === "stage" ? s.hidden : "",
      touch: s.touch === true,
      single: s.single === "stage" ? "stage" : "map",
    };
  } catch {
    return { ratio: 0.5, hidden: "", touch: false, single: "map" };
  }
}

function keep(state: State) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Only a convenience.
  }
}

export type Split = {
  stop(): void;
  /** Its names again (the language changed). */
  retext(): void;
  /** One view at a time now (a small screen, or touch mode). */
  single(): boolean;
  /** One view at a time because the screen is small (touch mode can't be turned off then). */
  small(): boolean;
  /** Touch mode, as asked for in the menu. */
  touch(): boolean;
  setTouch(on: boolean): void;
};

/**
 * The line in `box` (the grid with the map and the 3D side by side), or the 2D | 3D switch.
 * `onStage`: the 3D shown or hidden (not worth drawing then), and at the start.
 * `onSingle`: one view at a time or not, and at the start.
 */
export function installSplit(box: HTMLElement, t: T, onStage: (shown: boolean) => void = () => {}, onSingle: (single: boolean) => void = () => {}): Split {
  const state = load();
  const line = document.createElement("div");
  line.className = "re-split";
  line.setAttribute("role", "separator");
  line.setAttribute("aria-orientation", "vertical");
  line.tabIndex = 0;
  // The switch: always in the same corner, over whichever view shows.
  const views = document.createElement("div");
  views.className = "re-views";
  views.setAttribute("role", "group");
  views.innerHTML = `<button type="button" data-v="map">2D</button><button type="button" data-v="stage">3D</button>`;
  box.append(line, views);

  let small = false;
  let stageShown: boolean | null = null;
  let wasSingle: boolean | null = null;
  const single = () => small || state.touch;
  const apply = (ratio = state.ratio, hidden = state.hidden) => {
    const one = single();
    // One at a time: the other one hidden, the same way the line hides it.
    const off: "" | View = one ? (state.single === "map" ? "stage" : "map") : hidden;
    box.style.setProperty("--re-cols", off === "map" ? "0px minmax(0, 1fr)" : off === "stage" ? "minmax(0, 1fr) 0px" : `minmax(0, ${ratio}fr) minmax(0, ${1 - ratio}fr)`);
    box.classList.toggle("re-single", one);
    box.classList.toggle("re-map-hidden", off === "map");
    box.classList.toggle("re-stage-hidden", off === "stage");
    line.hidden = one;
    views.hidden = !one;
    for (const button of views.querySelectorAll<HTMLButtonElement>("button")) {
      const on = button.dataset.v === state.single;
      button.classList.toggle("on", on);
      button.setAttribute("aria-pressed", String(on));
      button.title = t(button.dataset.v === "map" ? "relief.split.showMap" : "relief.split.show3d");
    }
    views.setAttribute("aria-label", t("relief.split.views"));
    line.classList.toggle("edge", hidden !== "");
    line.style.left = hidden === "map" ? "0px" : hidden === "stage" ? "100%" : `${ratio * 100}%`;
    const text = hidden === "map" ? t("relief.split.showMap") : hidden === "stage" ? t("relief.split.show3d") : t("relief.split.drag");
    line.innerHTML = hidden ? `<span class="grip">${hidden === "map" ? "›" : "‹"}</span>` : "";
    // Outside the map, where the editor's own tooltips are: the browser's.
    line.title = hidden ? text : `${text}. ${t("relief.split.dragHint")}`;
    line.setAttribute("aria-label", text);
    // While the line's dragged, the 3D stays as it is (drawn, or not) till it's let go.
    if (!box.classList.contains("re-splitting")) {
      const shown = off !== "stage";
      if (shown !== stageShown) {
        stageShown = shown;
        onStage(shown);
      }
    }
    if (one !== wasSingle) {
      wasSingle = one;
      onSingle(one);
    }
  };

  views.onclick = (event) => {
    const v = (event.target as HTMLElement).closest<HTMLButtonElement>("button")?.dataset.v;
    if ((v === "map" || v === "stage") && v !== state.single) {
      state.single = v;
      apply();
      keep(state);
    }
  };
  // The screen's size: one view at a time when it's small.
  const sizer = new ResizeObserver(() => {
    const r = box.getBoundingClientRect();
    const now = r.width > 0 && (r.width < SINGLE_W || r.height < SINGLE_H);
    if (now !== small) {
      small = now;
      apply();
    }
  });
  const r = box.getBoundingClientRect();
  small = r.width > 0 && (r.width < SINGLE_W || r.height < SINGLE_H);
  apply();
  sizer.observe(box);

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
  return {
    stop() {
      sizer.disconnect();
      line.remove();
      views.remove();
      box.style.removeProperty("--re-cols");
      box.classList.remove("re-map-hidden", "re-stage-hidden", "re-splitting", "re-single");
      // Out of the editor: the 3D shown again, whatever it was here.
      if (stageShown === false) {
        onStage(true);
      }
    },
    retext: () => apply(),
    single,
    small: () => small,
    touch: () => state.touch,
    setTouch(on) {
      state.touch = on;
      apply();
      keep(state);
    },
  };
}
