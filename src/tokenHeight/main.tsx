import React from "react";
import ReactDOM from "react-dom/client";

import { TokenHeightPicker } from "./TokenHeightPicker";
import { FootprintPicker } from "./FootprintPicker";
import { PluginGate } from "../util/PluginGate";
import { OBRContextProvider } from "../settings/OBRContext";

// watchTheme() calls OBR.theme.* — it lives inside TokenHeightPicker's own
// effect (only mounts once PluginGate below has already confirmed OBR is
// ready), not called here at module load: calling it before the SDK's ready
// handshake risks a synchronous throw that would abort this whole render
// call and leave the embed showing nothing at all.

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PluginGate>
      <OBRContextProvider>
        {/* One page for both context-menu embeds (see createTokenHeightMenu.ts). */}
        {new URLSearchParams(window.location.search).get("view") === "footprint" ? (
          <FootprintPicker />
        ) : (
          <TokenHeightPicker />
        )}
      </OBRContextProvider>
    </PluginGate>
  </React.StrictMode>
);
