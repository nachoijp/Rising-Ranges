import React from "react";
import ReactDOM from "react-dom/client";

import CssBaseline from "@mui/material/CssBaseline";

import { TerrainVisibilityPicker } from "./TerrainVisibilityPicker";
import { PluginGate } from "../util/PluginGate";
import { PluginThemeProvider } from "../util/PluginThemeProvider";
import { GlassFrame } from "../util/GlassFrame";
import { OBRContextProvider } from "../settings/OBRContext";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PluginGate>
      <PluginThemeProvider>
        <CssBaseline />
        <OBRContextProvider>
          <GlassFrame>
            <TerrainVisibilityPicker />
          </GlassFrame>
        </OBRContextProvider>
      </PluginThemeProvider>
    </PluginGate>
  </React.StrictMode>
);
