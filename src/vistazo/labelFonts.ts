// The fonts Owlbear Rodeo draws an image's label in, here with the extension (see
// src/assets/fonts/README.md): a font's files are only fetched once a label is shown in it.
import "@fontsource/permanent-marker/400.css";
import "@fontsource/dancing-script/400.css";
import "@fontsource/courier-prime/400.css";
import "@fontsource/eb-garamond/400.css";
import gotica from "../assets/fonts/GoticaBastard.ttf?url";
import lemonTuesday from "../assets/fonts/LemonTuesday.otf?url";

for (const [family, url] of [
  ["GoticaBastard", gotica],
  ["Lemon Tuesday", lemonTuesday],
]) {
  document.fonts.add(new FontFace(family, `url(${url})`, { display: "swap" }));
}

/** What a label's font is called, as Owlbear reads it (its own table: a name, or a kind of font, to the one it has). */
const OWLBEAR_FONTS = new Map([
  ["Roboto", "Roboto"],
  ["sans-serif", "Roboto"],
  ["GoticaBastard", "GoticaBastard"],
  ["Gotica", "GoticaBastard"],
  ["fantasy", "GoticaBastard"],
  ["Permanent Marker", "Permanent Marker"],
  ["marker", "Permanent Marker"],
  ["Lemon Tuesday", "Lemon Tuesday"],
  ["handwriting", "Lemon Tuesday"],
  ["Dancing Script", "Dancing Script"],
  ["cursive", "Dancing Script"],
  ["Courier Prime", "Courier Prime"],
  ["Courier", "Courier Prime"],
  ["monospace", "Courier Prime"],
  ["EB Garamond", "EB Garamond"],
  ["Times New Roman", "EB Garamond"],
  ["Georgia", "EB Garamond"],
  ["serif", "EB Garamond"],
]);

/** The font a label's drawn in, as Owlbear draws it: Roboto for one it doesn't know. */
export function labelFont(family: string): string {
  return OWLBEAR_FONTS.get(family) ?? "Roboto";
}
