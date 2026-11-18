import OBR from "@owlbear-rodeo/sdk";
import type { Theme } from "@owlbear-rodeo/sdk";

// The Altura picker uses plain CSS (tokenHeight.css), not MUI like the
// other pages, so Owlbear's theme reaches it as CSS custom properties.
function applyTheme(theme: Theme) {
  const root = document.documentElement.style;
  root.setProperty("--obr-text-primary", theme.text.primary);
  root.setProperty("--obr-text-secondary", theme.text.secondary);
  root.setProperty("--obr-primary-main", theme.primary.main);
  root.setProperty("--obr-primary-contrast", theme.primary.contrastText);
  root.setProperty("--obr-background-paper", theme.background.paper);

  const isDark = theme.mode === "DARK";
  root.setProperty("--obr-overlay", isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)");
  root.setProperty("--obr-overlay-hover", isDark ? "rgba(255,255,255,0.16)" : "rgba(0,0,0,0.12)");
  root.setProperty("--obr-overlay-selected", isDark ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.16)");
  root.setProperty("--obr-border-selected", isDark ? "rgba(255,255,255,0.8)" : "rgba(0,0,0,0.65)");
  // The extension's glass (see .glass in tokenHeight.css: opened from the Vistazo), as its menus have it.
  root.setProperty("--glass-outer", isDark ? "rgba(48, 52, 63, 0.62)" : `color-mix(in srgb, ${theme.background.paper} 62%, transparent)`);
  root.setProperty("--divider", isDark ? "rgba(255,255,255,.09)" : "rgba(20,18,30,.10)");
}

/** Keep the page's CSS variables in sync with Owlbear Rodeo's light/dark theme */
export function watchTheme(): void {
  OBR.theme.getTheme().then(applyTheme);
  OBR.theme.onChange(applyTheme);
}
