import React from "react";
import ReactDOM from "react-dom/client";

import { TokenHeightPicker } from "./TokenHeightPicker";
import { ElevationPanel } from "./ElevationPanel";
import { TerrainPicker } from "./TerrainPicker";
import { PluginGate } from "../util/PluginGate";
import { OBRContextProvider } from "../settings/OBRContext";

// watchTheme() calls OBR.theme.* — it lives inside TokenHeightPicker's own
// effect (only mounts once PluginGate below has already confirmed OBR is
// ready), not called here at module load: calling it before the SDK's ready
// handshake risks a synchronous throw that would abort this whole render
// call and leave the embed showing nothing at all.

function View({ name }: { name: string | null }) {
  if (name === "terrain") {
    return <TerrainPicker />;
  }
  if (name === "elevation") {
    return <ElevationPanel />;
  }
  if (name === "footprint") {
    return <ElevationPanel elevation={false} />;
  }
  return <TokenHeightPicker />;
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
