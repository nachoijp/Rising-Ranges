import type { Image } from "@owlbear-rodeo/sdk";
import { emptyRelief } from "../codec";
import { GEN_STAGES, type GenStage } from "../trace/gen/generate";
import { readUvtt, type Picture, type Uvtt } from "../trace/uvtt";
import type { Pt, ReliefData } from "../types";
import type { ReliefEditor } from "./editor";
import type { GenReply, GenRequest, GenTemplates } from "./generate.worker";
import type { T } from "./panel";

// "Generar relieve": a panel asking only what can't be read from the map (its
// plan of walls, if there's one; how heights are to be had; whether what's
// there stays), then the work (in a worker, see generate.worker.ts) with its
// steps shown, then the relief in place of (or over) what was there: one step
// to undo.

/** Pixels a cell the map's picture is read at, and the most pixels it may take. */
const PX = 16;
const MAX_PIXELS = 8e6;

type Heights = "seeds" | "flat" | "guess";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** The map's picture, `px` a cell, as big as the relief. */
async function mapPicture(url: string, w: number, h: number): Promise<Picture | null> {
  try {
    const img = document.createElement("img");
    img.crossOrigin = "anonymous";
    img.src = url;
    await img.decode();
    const px = Math.max(6, Math.min(PX, Math.floor(Math.sqrt(MAX_PIXELS / (w * h)))));
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

/** The shapes already drawn as guides: flat ones, with their outline and height (not the generator's own). */
function guidesOf(data: ReliefData, generated: string): { rings: Pt[][]; h: number }[] {
  const mine = new Set((data.groups ?? []).filter((g) => g.name === generated).map((g) => g.id));
  // A group inside a generated one is the generator's too.
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of data.groups ?? []) if (g.parent && mine.has(g.parent) && !mine.has(g.id)) (mine.add(g.id), (grew = true));
  }
  const at = (i: number): Pt => [data.verts[i].x, data.verts[i].y];
  return data.shapes
    .filter((s) => s.kind === "flat" && !s.slab && !s.stand && !s.soft && !(s.group && mine.has(s.group)))
    .map((s) => ({ rings: [s.ring.map(at), ...(s.holes ?? []).map((h) => h.map(at))], h: s.h }));
}

export function openGenerate(o: { root: HTMLElement; t: T; editor: ReliefEditor; image: Image; notice: (text: string) => void }) {
  const { root, t, editor, image, notice } = o;
  root.querySelector(".re-gen")?.remove();
  const guides = guidesOf(editor.data, t("relief.gen.top"));
  let uvtt: Uvtt | null = null;
  let heights: Heights = guides.length ? "seeds" : "flat";
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
        <h4>${esc(t("relief.gen.plan"))}</h4>
        <div class="re-gen-file"><button type="button" class="re-gen-btn" data-k="pick">${esc(t("relief.gen.planPick"))}</button><span data-k="planName">${esc(t("relief.gen.planNone"))}</span></div>
        <small>${esc(t("relief.gen.planHint"))}</small>
        <input type="file" data-k="file" accept=".uvtt,.dd2vtt,.df2vtt,.json" hidden />
      </section>
      <section>
        <h4>${esc(t("relief.gen.heights"))}</h4>
        ${radio("h", "seeds", heights === "seeds", guides.length ? t("relief.gen.hSeeds", { n: guides.length }) : t("relief.gen.hSeedsNone"), t("relief.gen.hSeedsHint"), !guides.length)}
        ${radio("h", "flat", heights === "flat", t("relief.gen.hFlat"), t("relief.gen.hFlatHint"))}
        ${radio("h", "guess", false, t("relief.gen.hGuess"), t("relief.gen.hGuessHint"))}
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
    let read: Uvtt | null = null;
    try {
      read = readUvtt(JSON.parse(await chosen.text()));
    } catch {
      read = null;
    }
    uvtt = read && read.walls.length ? { ...read, image: undefined } : null;
    $("planName").textContent = uvtt ? chosen.name : t("relief.gen.planBad");
  };
  panel.querySelectorAll<HTMLInputElement>('input[name="h"]').forEach((el) => (el.onchange = () => (heights = el.value as Heights)));
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
    panel.querySelectorAll<HTMLInputElement | HTMLButtonElement>(".re-gen-form input, .re-gen-form button, [data-k='run']").forEach((el) => (el.disabled = true));
    show("loading");
    const { w, h } = editor.data;
    const pic = await mapPicture(image.image.url, w, h);
    if (!pic) {
      notice(t("relief.gen.noPicture"));
      close();
      return;
    }
    const base = replace ? emptyRelief(w, h) : editor.data;
    const names: GenTemplates = {
      top: t("relief.gen.top"),
      levels: t("relief.gen.levels"),
      water: t("relief.gen.water"),
      plants: t("relief.gen.plants"),
      cliffs: t("relief.gen.cliffs"),
      group: t("relief.uvtt.group"),
      rooms: t("relief.uvtt.rooms"),
      walls: t("relief.uvtt.walls"),
      hedges: t("relief.uvtt.hedges"),
      objects: t("relief.uvtt.objects"),
      stairs: t("relief.uvtt.stairs"),
      room: t("relief.uvtt.room", { n: "{n}" }),
      wall: t("relief.uvtt.wall", { n: "{n}" }),
      hedge: t("relief.uvtt.hedge", { n: "{n}" }),
      object: t("relief.uvtt.object", { n: "{n}" }),
      stair: t("relief.uvtt.stair", { n: "{n}" }),
      level: t("relief.gen.level", { h: "{h}" }),
      pond: t("relief.gen.pond", { n: "{n}" }),
      tree: t("relief.gen.tree", { n: "{n}" }),
      bush: t("relief.gen.bush", { n: "{n}" }),
      cliff: t("relief.gen.cliff", { n: "{n}" }),
    };
    const request: GenRequest = {
      pic,
      uvtt,
      base,
      names,
      options: { wallH, seeds: heights === "seeds" ? guides : [], guess: heights === "guess" },
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
          ["levels", c.levels],
          ["cliffs", c.cliffs],
          ["water", c.water],
          ["trees", c.trees],
          ["bushes", c.bushes],
          ["stairs", c.stairs],
        ] as const
      )
        .filter(([, n]) => n > 0)
        .map(([k, n]) => t(`relief.gen.sum.${k}`, { n }));
      notice(t("relief.gen.done", { summary: parts.join(", ") || "—" }));
      close();
    };
    worker.onerror = (e) => {
      notice(t("relief.gen.failed", { error: e.message || "worker" }));
      close();
    };
    worker.postMessage(request, [pic.data.buffer]);
  };
}
