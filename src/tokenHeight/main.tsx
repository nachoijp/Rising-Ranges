import React from "react";
import ReactDOM from "react-dom/client";
// Roboto, as the extension's other pages (PluginThemeProvider): not every computer has it.
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";

import { TokenHeightPicker } from "./TokenHeightPicker";
import { ElevationPanel } from "./ElevationPanel";
import { PluginGate } from "../util/PluginGate";
import { OBRContextProvider } from "../settings/OBRContext";

// watchTheme() calls OBR.theme.* — it lives inside TokenHeightPicker's own
// effect (only mounts once PluginGate below has already confirmed OBR is
// ready), not called here at module load: calling it before the SDK's ready
// handshake risks a synchronous throw that would abort this whole render
// call and leave the embed showing nothing at all.

function View({ name }: { name: string | null }) {
  if (name === "elevation") {
    return <ElevationPanel />;
  }
  if (name === "footprint") {
    return <ElevationPanel elevation={false} />;
  }
  return <TokenHeightPicker />;
}

// No browser menu on it (it's a menu itself), but in a text field (copy, paste): as the Vistazo's.
document.addEventListener("contextmenu", (event) => {
  if (!(event.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]")) {
    event.preventDefault();
  }
});

// Opened from the Vistazo's token menu (its submenu, out of Owlbear's paper): in the extension's glass.
if (new URLSearchParams(window.location.search).has("glass")) {
  document.documentElement.classList.add("glass");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PluginGate>
      <OBRContextProvider>
        {/* One page for the context-menu embeds. */}
        <View name={new URLSearchParams(window.location.search).get("view")} />
      </OBRContextProvider>
    </PluginGate>
  </React.StrictMode>
);
