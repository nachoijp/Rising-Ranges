import type { Image, Item } from "@owlbear-rodeo/sdk";
import { emptyRelief } from "../codec";
import { fogPlans, type FogPlan } from "../trace/fogPlan";
import { readUvtt, type Picture } from "../trace/uvtt";
import type { Pt } from "../types";
import type { ReliefEditor } from "./editor";
import type { GenReply, GenRequest, GenStage, GenTemplates } from "./generate.worker";
import type { T } from "./panel";

// "Convertir niebla en relieve": the walls the room's fog already has —
// Smoke & Spectre!'s lines, Owlbear's own fog (its rooms' outlines), or a
// .uvtt plan — made the relief's walls and rooms, measured on the map's
// picture (see trace/fogPlan.ts and trace/uvtt.ts). A panel asking only what
// can't be read (which of them, stairs or not, the walls' height, whether
// what's there stays), the work in a worker with its steps shown, then the
// relief in place of (or over) what was there: one step to undo.

/** Pixels a square of the scene the map's picture is read at, and the most pixels it may take. */
const PX = 24;
const MAX_PIXELS = 6e6;

/** Pixels a cell the map's picture is read at: PX a square of the scene (`unit` squares a cell), fewer on a map too big for MAX_PIXELS. */
export function picturePx(w: number, h: number, unit: number): number {
  return Math.max(8, Math.min(Math.round(PX * unit), Math.floor(Math.sqrt(MAX_PIXELS / (w * h)))));
}

type Source = "smoke" | "obr" | "uvtt";

/** The worker's steps, in order (see generate.worker.ts). */
const GEN_STAGES: GenStage[] = ["walls", "stairs", "shapes"];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The map's picture, PX a square of the scene (`unit` squares a cell), as big as the relief. */
async function mapPicture(url: string, w: number, h: number, unit: number): Promise<Picture | null> {
  try {
    const img = document.createElement("img");
    img.crossOrigin = "anonymous";
    img.src = url;
    await img.decode();
    const px = picturePx(w, h, unit);
    const cw = Math.round(w * px), ch = Math.round(h * px);
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const g = canvas.getContext("2d", { willReadFrequently: true })!;
    g.imageSmoothingQuality = "high";
    g.drawImage(img, 0, 0, cw, ch);
    return { w: cw, h: ch, px, data: g.getImageData(0, 0, cw, ch).data };
  } catch {
    return null;
  }
}

export function openGenerate(o: { root: HTMLElement; t: T; editor: ReliefEditor; image: Image; scene: () => { items: Item[]; dpi: number }; notice: (text: string) => void }) {
  const { root, t, editor, image, notice } = o;
  root.querySelector(".re-gen")?.remove();
  const { items, dpi } = o.scene();
  const found = fogPlans(items, image, dpi, editor.data.w, editor.data.h);
  const smoke = found.find((p) => p.source === "smoke");
  const obr = found.find((p) => p.source === "obr");
  let uvtt: FogPlan | null = null;
  let source: Source = smoke ? "smoke" : obr ? "obr" : "uvtt";
  let stairs = true;
  let replace = true;
  let wallH = 2;
  let worker: Worker | null = null;

  const panel = document.createElement("div");
  panel.className = "re-gen glass";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("relief.gen.title"));
  const radio = (name: string, value: string, checked: boolean, label: string, hint: string, disabled = false) =>
    `<label class="re-gen-opt${disabled ? " off" : ""}"><input type="radio" name="${name}" value="${value}" ${checked ? "checked" : ""} ${disabled ? "disabled" : ""} /><span><b>${esc(label)}</b>${hint ? `<small>${esc(hint)}</small>` : ""}</span></label>`;
  panel.innerHTML = `
    <p class="ptitle">${esc(t("relief.gen.title"))}</p>
    <p class="re-gen-intro">${esc(t("relief.gen.intro"))}</p>
    <div class="re-gen-form">
      <section>
        <h4>${esc(t("relief.gen.source"))}</h4>
        ${radio("s", "smoke", source === "smoke", smoke ? t("relief.gen.smoke", { n: smoke.walls.length, d: smoke.portals.length }) : t("relief.gen.smokeNone"), t("relief.gen.smokeHint"), !smoke)}
        ${radio("s", "obr", source === "obr", obr ? t("relief.gen.obr", { n: obr.walls.length }) : t("relief.gen.obrNone"), t("relief.gen.obrHint"), !obr)}
        ${radio("s", "uvtt", source === "uvtt", t("relief.gen.uvtt"), t("relief.gen.uvttHint"))}
        <div class="re-gen-file" data-k="fileRow" ${source === "uvtt" ? "" : "hidden"}><button type="button" class="re-gen-btn" data-k="pick">${esc(t("relief.gen.planPick"))}</button><span data-k="planName">${esc(t("relief.gen.planNone"))}</span></div>
        <input type="file" data-k="file" accept=".uvtt,.dd2vtt,.df2vtt,.json" hidden />
        ${smoke || obr ? "" : `<small class="re-gen-none">${esc(t("relief.gen.noFog"))}</small>`}
      </section>
      <section>
        <h4>${esc(t("relief.gen.extras"))}</h4>
        <label class="re-gen-opt"><input type="checkbox" data-k="stairs" checked /><span><b>${esc(t("relief.gen.stairs"))}</b><small>${esc(t("relief.gen.stairsHint"))}</small></span></label>
      </section>
      <section>
        <h4>${esc(t("relief.gen.existing"))}</h4>
        ${radio("x", "replace", true, t("relief.gen.replace"), "")}
        ${radio("x", "keep", false, t("relief.gen.keep"), "")}
      </section>
      <section class="re-gen-row">
        <h4>${esc(t("relief.gen.wallH"))}</h4>
        <input type="number" class="num" data-k="wallH" min="0.5" max="10" step="0.5" value="2" />
      </section>
    </div>
    <div class="re-gen-progress" data-k="progress" hidden><div class="bar"><div data-k="fill"></div></div><span data-k="stage"></span></div>
    <div class="re-gen-actions"><button type="button" class="re-gen-btn" data-k="cancel">${esc(t("relief.gen.cancel"))}</button><button type="button" class="done" data-k="run">${esc(t("relief.gen.run"))}</button></div>`;
  root.append(panel);
  const $ = <E extends HTMLElement = HTMLElement>(k: string) => panel.querySelector<E>(`[data-k="${k}"]`)!;
  const ready = () => ($<HTMLButtonElement>("run").disabled = source === "uvtt" && !uvtt);
  ready();

  const close = () => {
    worker?.terminate();
    worker = null;
    panel.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  $("cancel").onclick = close;
  $("pick").onclick = () => $<HTMLInputElement>("file").click();
  $<HTMLInputElement>("file").onchange = async () => {
    const input = $<HTMLInputElement>("file");
    const chosen = input.files?.[0];
    input.value = "";
    if (!chosen) return;
    let read = null;
    try {
      read = readUvtt(JSON.parse(await chosen.text()));
    } catch {
      read = null;
    }
    // The plan stretched onto this map, if its size differs.
    const { w, h } = editor.data;
    const st = (p: Pt): Pt => (read ? [(p[0] * w) / read.w, (p[1] * h) / read.h] : p);
    const portals = read ? read.portals.map(([a, b]) => [st(a), st(b)] as [Pt, Pt]) : [];
    uvtt = read && read.walls.length ? { source: "smoke", walls: read.walls.map((l) => l.map(st)), portals, openings: false, rooms: [], doors: portals.map(([a, b]) => ({ a, b })) } : null;
    $("planName").textContent = uvtt ? chosen.name : t("relief.gen.planBad");
    ready();
  };
  panel.querySelectorAll<HTMLInputElement>('input[name="s"]').forEach(
    (el) =>
      (el.onchange = () => {
        source = el.value as Source;
        $("fileRow").hidden = source !== "uvtt";
        ready();
      }),
  );
  $<HTMLInputElement>("stairs").onchange = () => (stairs = $<HTMLInputElement>("stairs").checked);
  panel.querySelectorAll<HTMLInputElement>('input[name="x"]').forEach((el) => (el.onchange = () => (replace = el.value === "replace")));
  $<HTMLInputElement>("wallH").onchange = () => {
    const v = Number($<HTMLInputElement>("wallH").value);
    wallH = Number.isFinite(v) && v > 0 ? Math.min(10, v) : 2;
  };

  const show = (stage: GenStage | "loading") => {
    $("progress").hidden = false;
    $("stage").textContent = t(`relief.gen.stage.${stage}`);
    const k = stage === "loading" ? 0 : GEN_STAGES.indexOf(stage) + 1;
    $("fill").style.width = `${Math.round((k / (GEN_STAGES.length + 1)) * 100)}%`;
  };

  $("run").onclick = async () => {
    const plan = source === "smoke" ? smoke : source === "obr" ? obr : uvtt;
    if (!plan) return;
    panel.querySelectorAll<HTMLInputElement | HTMLButtonElement>(".re-gen-form input, .re-gen-form button, [data-k='run']").forEach((el) => (el.disabled = true));
    show("loading");
    const { w, h } = editor.data;
    // A cell of the relief is the image's own grid cell, drawn `unit` squares of the scene wide.
    const unit = Math.sqrt(Math.abs(image.scale.x * image.scale.y)) || 1;
    const pic = await mapPicture(image.image.url, w, h, unit);
    if (!pic) {
      notice(t("relief.gen.noPicture"));
      close();
      return;
    }
    const names: GenTemplates = {
      group: t(`relief.gen.group.${source}`),
      rooms: t("relief.uvtt.rooms"),
      walls: t("relief.uvtt.walls"),
      hedges: t("relief.uvtt.hedges"),
      objects: t("relief.uvtt.objects"),
      stairs: t("relief.uvtt.stairs"),
      solids: t("relief.gen.solids"),
      room: t("relief.uvtt.room", { n: "{n}" }),
      wall: t("relief.uvtt.wall", { n: "{n}" }),
      hedge: t("relief.uvtt.hedge", { n: "{n}" }),
      object: t("relief.uvtt.object", { n: "{n}" }),
      stair: t("relief.uvtt.stair", { n: "{n}" }),
      solid: t("relief.gen.solid", { n: "{n}" }),
    };
    const request: GenRequest = {
      pic,
      plan: { walls: plan.walls, portals: plan.portals, openings: plan.openings, rooms: plan.rooms, doors: plan.doors },
      base: replace ? emptyRelief(w, h) : editor.data,
      names,
      unit,
      options: { wallH, stairs },
    };
    worker = new Worker(new URL("./generate.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<GenReply>) => {
      const reply = event.data;
      if (reply.kind === "stage") {
        show(reply.stage);
        return;
      }
      if (reply.kind === "error") {
        notice(t("relief.gen.failed", { error: reply.message }));
        close();
        return;
      }
      editor.replace(reply.data);
      const c = reply.counts;
      const parts = (
        [
          ["rooms", c.rooms],
          ["walls", c.walls + c.hedges],
          ["objects", c.objects],
          ["solids", c.solids],
          ["doors", c.doors],
          ["stairs", c.stairs],
        ] as const
      )
        .filter(([, n]) => n > 0)
        .map(([k, n]) => t(`relief.gen.sum.${k}`, { n }));
      notice(t(source === "obr" ? "relief.gen.doneObr" : "relief.gen.done", { summary: parts.join(", ") || "—" }));
      close();
    };
    worker.onerror = (e) => {
      notice(t("relief.gen.failed", { error: e.message || "worker" }));
      close();
    };
    worker.postMessage(request, [pic.data.buffer]);
  };
}
