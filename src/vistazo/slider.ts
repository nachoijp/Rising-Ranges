// The page's sliders (the Vistazo's controls, the relief editor's) drawn as the settings' (see the
// range inputs in vistazo.css). Chrome has no part of its own for the track up to the thumb, so it's a
// gradient up to --fill (0–1): kept in step here with the value, whether it's dragged or set by code.

/** A slider's --fill, from its value. */
function fill(input: HTMLInputElement) {
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  input.style.setProperty("--fill", String(max > min ? (Number(input.value) - min) / (max - min) : 0));
}

/** From then on, every slider on the page keeps its fill: dragged, or its value set by code. Once. */
export function fillSliders() {
  const value = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!;
  Object.defineProperty(HTMLInputElement.prototype, "value", {
    ...value,
    set(this: HTMLInputElement, next: string) {
      value.set!.call(this, next);
      if (this.type === "range") {
        fill(this);
      }
    },
  });
  document.addEventListener("input", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.type === "range") {
      fill(event.target);
    }
  });
}
