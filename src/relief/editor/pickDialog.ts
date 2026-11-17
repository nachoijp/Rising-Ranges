// A small window over the map to pick one of a list (the map image, an earlier version): what a submenu
// was, roomier for a finger and nowhere for it to land on what it didn't mean. Its look is "Generar
// relieve"'s (generateDialog.ts); a click outside it, ✕ or Esc close it.

import { icon } from "./icons";
import { esc, type T } from "./panel";

export type PickRow = { label: string; on?: boolean; run: () => void };

export function openPick(o: { root: HTMLElement; t: T; title: string; rows: PickRow[]; empty?: string; foot?: string }) {
  o.root.querySelector(".re-pick-back")?.remove();
  const back = document.createElement("div");
  back.className = "re-pick-back";
  const rows = o.rows
    .map((row, i) => `<button type="button" class="re-pick-row${row.on ? " on" : ""}" data-i="${i}"${row.on ? ' aria-current="true"' : ""}>${esc(row.label)}</button>`)
    .join("");
  back.innerHTML = `<div class="re-gen re-pick" role="dialog" aria-label="${esc(o.title)}">
      <div class="re-pick-head"><p class="ptitle">${esc(o.title)}</p><button type="button" class="ib sm" data-k="close" aria-label="${esc(o.t("relief.close"))}">${icon("close")}</button></div>
      <div class="re-pick-rows">${rows || `<p class="re-pick-empty">${esc(o.empty ?? "")}</p>`}</div>
      ${o.foot && o.rows.length ? `<p class="re-pick-foot">${esc(o.foot)}</p>` : ""}
    </div>`;
  o.root.append(back);
  const close = () => {
    back.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  back.onclick = (event) => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLButtonElement>(".re-pick-row");
    if (row) {
      close();
      o.rows[Number(row.dataset.i)].run();
    } else if (target === back || target.closest('[data-k="close"]')) {
      close();
    }
  };
  (back.querySelector<HTMLElement>(".re-pick-row.on") ?? back.querySelector<HTMLElement>(".re-pick-row") ?? back.querySelector<HTMLElement>('[data-k="close"]'))?.focus({ preventScroll: true });
}
