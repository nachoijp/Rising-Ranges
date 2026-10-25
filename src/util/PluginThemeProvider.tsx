import {
  Theme as MuiTheme,
  ThemeProvider,
  alpha,
  createTheme,
} from "@mui/material/styles";
import OBR, { Theme } from "@owlbear-rodeo/sdk";
import { useEffect, useState } from "react";

import "@fontsource/roboto/300.css";
import "@fontsource/roboto/400.css";
import "@fontsource/roboto/500.css";
import "@fontsource/roboto/600.css";
import "@fontsource/roboto/700.css";

/**
 * Create a MUI theme based off of the current OBR theme
 */
function getTheme(theme?: Theme) {
  return createTheme({
    palette: theme
      ? {
          mode: theme.mode === "LIGHT" ? "light" : "dark",
          text: theme.text,
          primary: theme.primary,
          secondary: theme.secondary,
          background: theme.background,
        }
      : undefined,
    // Rounded and sized as the Vistazo's and the relief editor's controls (vistazo.css): 12px corners,
    // and small fields, dropdowns and button groups 32px tall with 13px text.
    shape: {
      borderRadius: 12,
    },
    components: {
      MuiButtonBase: {
        defaultProps: {
          disableRipple: true,
        },
        // Without the ripple, MUI shows no keyboard focus on its buttons: a ring in the accent, as the
        // Vistazo's controls have (vistazo.css).
        styleOverrides: {
          root: ({ theme }) => ({
            "&.Mui-focusVisible": {
              outline: `2px solid ${theme.palette.primary.main}`,
              outlineOffset: 2,
            },
          }),
        },
      },
      // Inside their scrolling strip (it would cut the ring off). On the pointer, the text lights up:
      // nothing else in the extension stays still under it.
      MuiTab: {
        styleOverrides: {
          root: ({ theme }) => ({
            "&.Mui-focusVisible": { outlineOffset: -2 },
            "&:hover:not(.Mui-selected)": { color: theme.palette.text.primary },
          }),
        },
      },
      // Outlined as the fields are, its text the text's: as the Vistazo's outlined buttons (vistazo.css).
      MuiButton: {
        styleOverrides: {
          outlined: ({ theme }) => ({
            color: theme.palette.text.primary,
            borderColor: alpha(theme.palette.text.primary, 0.23),
            "&:hover": {
              borderColor: alpha(theme.palette.text.primary, 0.23),
              backgroundColor: theme.palette.action.hover,
            },
          }),
        },
      },
      // Menus (a dropdown's list) as the Vistazo's own (.dd-menu in vistazo.css): the panels' glass, not
      // MUI's paper, rows of 14px text 6px above and below.
      MuiMenu: {
        styleOverrides: {
          paper: ({ theme }) => ({
            backgroundColor: theme.palette.mode === "dark" ? "rgba(48, 52, 63, 0.62)" : alpha(theme.palette.background.paper, 0.62),
            backgroundImage: "none",
            backdropFilter: "blur(18px) saturate(1.3)",
            WebkitBackdropFilter: "blur(18px) saturate(1.3)",
            border: `1px solid ${theme.palette.mode === "dark" ? "rgba(255,255,255,.09)" : "rgba(20,18,30,.10)"}`,
            boxShadow: "0 10px 34px -10px rgba(0,0,0,.55)",
          }),
          list: {
            paddingTop: 6,
            paddingBottom: 6,
          },
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            minHeight: "auto",
            paddingTop: 6,
            paddingBottom: 6,
            fontSize: 14,
            "&.Mui-focusVisible": { outline: "none" },
          },
        },
      },
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundColor: "initial",
          },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          input: {
            "&:-webkit-autofill": {
              WebkitBoxShadow: "0 0 0 100px #222639 inset",
            },
            borderRadius: 12,
            "&::-webkit-search-cancel-button": {
              appearance: "none",
              display: "inline-block",
              width: "11px",
              height: "12px",
              marginLeft: "10px",
              background:
                theme?.mode === "LIGHT"
                  ? "linear-gradient(45deg, rgba(0,0,0,0) 0%,rgba(0,0,0,0) 43%,#000 45%,#000 55%,rgba(0,0,0,0) 57%,rgba(0,0,0,0) 100%),linear-gradient(135deg, transparent 0%,transparent 43%,#000 45%,#000 55%,transparent 57%,transparent 100%)"
                  : "linear-gradient(45deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0) 43%, rgb(255, 255, 255) 45%, rgb(255, 255, 255) 55%, rgba(0, 0, 0, 0) 57%, rgba(0, 0, 0, 0) 100%), linear-gradient(135deg, transparent 0%, transparent 43%, rgb(255, 255, 255) 45%, rgb(255, 255, 255) 55%, transparent 57%, transparent 100%)",
            },
          },
          // Small ones 32px tall, 13px text (on the outlined input: its own small padding would win over the base's).
          inputSizeSmall: {
            fontSize: 13,
            lineHeight: "18px",
            height: 18,
            paddingTop: 6,
            paddingBottom: 6,
            // A dropdown's: its own least height, MUI's, is taller.
            "&.MuiSelect-select": { minHeight: 18 },
          },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          sizeSmall: {
            minHeight: 32,
            paddingTop: 4,
            paddingBottom: 4,
            lineHeight: "18px",
          },
        },
      },
      MuiSwitch: {
        styleOverrides: {
          root: {
            width: 42,
            height: 26,
            padding: 0,
            margin: 8,
          },
          switchBase: {
            padding: 1,
            // The checked thumb's travel, sized for this theme's 42×26
            // switch (MUI's own default is sized for 58×38).
            "&.Mui-checked": {
              transform: "translateX(16px)",
              color: "#fff",
              "& + .MuiSwitch-track": {
                opacity: 1,
                border: "none",
              },
            },
          },
          thumb: {
            width: 24,
            height: 24,
          },
          track: {
            borderRadius: 13,
            border: "1px solid #bdbdbd",
            backgroundColor:
              theme?.mode === "LIGHT" ? "hsl(10, 10%, 95%)" : "#222639",
            opacity: 1,
            transition:
              "background-color 300ms cubic-bezier(0.4, 0, 0.2, 1) 0ms,border 300ms cubic-bezier(0.4, 0, 0.2, 1) 0ms",
          },
        },
      },
    },
  });
}

/**
 * Provide a MUI theme with the same palette as the parent OBR window
 */
export function PluginThemeProvider({
  children,
}: {
  children?: React.ReactNode;
}) {
  const [theme, setTheme] = useState<MuiTheme>(() => getTheme());
  useEffect(() => {
    const updateTheme = (theme: Theme) => {
      setTheme(getTheme(theme));
    };
    OBR.theme.getTheme().then(updateTheme);
    return OBR.theme.onChange(updateTheme);
  }, []);

  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}
