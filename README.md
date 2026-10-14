# Rising Ranges

A relative, 3D-aware range and altitude measuring tool for [Owlbear Rodeo](https://www.owlbear.rodeo/). Drag from an Origin — a point or a token — and see live range rings, a Reading on every other token, and optional persistent height markers.

![Demo](docs/screenshots/demo.gif)

## Features

- **Relative range measuring** — click and drag from any point or token to reveal concentric range bands (Melee, Very Close, Close, Far, Very Far — or your own).
- **Fixed Measurement** — hold Shift as you let go of a Measurement and it stays on the map, for everyone, while you move tokens around it. Shift+click again (or the ✕ in the toolbar) to remove it.
- **Height / altitude tracking** — right-click a token to set a persistent height marker, or nudge height live with hotkeys while measuring, range by range or one grid cell at a time. Readings account for height in 3D, with a choice of spherical, cubic, or cylindrical distance, and big creatures take up height too (a size 2 creature is a 2×2×2 block).
- **Three built-in presets** — Dagger, Steel (Draw Steel's distances, measured square by square), and Dragons — or build your own set of ranges from scratch.
- **Multiple visualization styles** — icon stacks, rings, or filled circles, independently sized and colored.
- **Exact numbers when you want them** — optionally add each token's exact distance to its Reading ("Close · 15ft"), and show height markers as icons, as a "⬆️ 30ft" label, or both.
- **Terrain with height** — tag a shape on the Map layer with a height (a roof, a cliff, a pit) and tokens standing in it are measured from up there. For maps seen from above.
- **Distances panel** — a list of every token's Range, horizontal and vertical distance, and total distance from any token you pick, live as tokens move. For the GM only or for everyone; players never see hidden tokens.
- **Color-blind friendly themes** — Base, Deuteranopia, Tritanopia, Protanopia, or your own colors. Each player picks their own, and sees everything in it — rings, Readings and height markers, whoever made them.
- **Bilingual** — Español / English, switchable per room.
- **Configurable hotkeys and feature toggles** — strip it back to plain range-rings with no per-token readings or height tracking at all, if that's all you need.

## In action

![Measuring with rings and readings](docs/screenshots/in-action.png)

Drag from a token or an empty point to set your Origin. Every other token gets a live Reading showing which range band it's in, with an arrow if it's above or below you.

Readings follow tokens that someone else moves while you measure. If several people measure at once, each screen shows one Measurement: your own while you're measuring, otherwise the most recent one.

## Fixed Measurement

Hold **Shift** as you release a Measurement — a quick Shift+click works too — and it stays where its Origin was: on the point, or where the token you dragged landed, at that height. Everyone in the room sees it.

While it's up, the Measurement tool just moves tokens: each one's Reading follows it as you drag, measured from the fixed point, and the height hotkeys raise or lower the token you're dragging. Tokens moved any other way update too. **Shift+click** anywhere, or the ✕ that appears in the toolbar, removes it — whoever placed it. There's only one at a time, and it goes away if whoever placed it leaves or reloads.

## Height markers

![Height markers on several tokens](docs/screenshots/height-markers.png)

Right-click any token to set a persistent height marker that sticks around outside of a Measurement. Heights go range by range, or one grid cell at a time (5 ft, 1 sq, or whatever the grid is set to) — each set of ranges picks which. A token's height is where its feet are, so a big creature standing on the ground still reads as right next to a small one.

![Height context menu, range by range](docs/screenshots/height-menu.png)

![Height context menu, one cell at a time](docs/screenshots/height-menu-cells.png)

## Build your own ranges

![A built-in preset, ready to duplicate](docs/screenshots/presets.png)

![Editing a custom set of ranges](docs/screenshots/custom-ranges.png)

Start from Dagger, Steel, or Dragons — duplicate one to edit it — or build your own: name each range, set its radius and icon, add or delete ranges, and pick the rings' shape, the calculation mode (spherical / cubic / cylindrical), whether heights step by range or by cell, and how forgiving Tolerance is. Turn on a Final Range to give everything past the farthest range a name and color of its own, instead of "Out of range".

## What shows on the map

![Map settings](docs/screenshots/map-tab.png)

How each measured token is marked (an icon, a ring, a circle, or nothing), with its size and opacity under Advanced; what its label says (the Range, the exact distance, or both) and how big; what the rings around the Origin say, and how big; and an optional filter that highlights the tokens within a chosen Range. These are room settings, so they work with any set of ranges, presets included.

## Height

![Height settings](docs/screenshots/height-tab.png)

Turn the whole height feature on or off, show markers as icons, as a "⬆️ 30ft" label, or both, pick the icon shape, fine-tune the marker's position, size, opacity and distance under Advanced, and set the hotkeys that raise, lower or ground the Origin while measuring.

## Terrain

Give parts of the map a height: draw a rectangle, circle or polygon on the **Map** layer, right-click it and set its **Terrain height** (GM only). A token standing inside it — at its anchor, its feet once aligned — adds that height to its own when measuring, so an archer on a 30 ft tower is measured from 30 ft up without touching its marker. Where zones overlap, the smallest one wins, so a pit or a courtyard inside a plateau is the ground there.

Zones are outlined in the color of their height. A toolbar button (GM only) picks who sees them: nobody, only the GM, or everyone. In the Height tab, **Ground level** chooses what heights are shown from: above the terrain each token stands on (*Variable*), or above one fixed ground for the whole map, like sea level (*Fixed*). Distances are the same either way. Terrain can be turned off there too.

> **Meant for maps seen from above.** Terrain isn't used on isometric or dimetric grids: the art already shows the relief there, and a token drawn on a roof stands up the screen from where it really is on the floor. On hex maps drawn in perspective, the art's relief and the measured distances may not match.

## Distances panel

![Distances panel](docs/screenshots/distances-panel.png)

Pick or select a token to list every other one with its Range and its horizontal, vertical and total distance, live as tokens move. It stays open while you work on the map, and you can drag it anywhere on screen by its handle (double-click the handle to send it back to the corner). The GM decides whether it's for the GM only or for everyone; players never see hidden tokens, and the GM can hide them from their own list too (handy when sharing your screen).

## General

![General settings](docs/screenshots/general-tab.png)

The room's language, the key that activates Measurement, who gets the Distances panel, and a Help button that opens this manual. Every setting applies right away — no reload needed — and their defaults keep the extension looking the way it always has until you change them.

## Color-blind themes

![Theme picker](docs/screenshots/themes.png)

Pick Base or one of the three color-blind themes, or make a Custom one with up to 12 colors of your own. The theme is yours alone: everyone in the room sees the rings, Readings and height markers in the theme they picked, whoever is measuring.

## Installation

In Owlbear Rodeo, open the Extensions panel and add this manifest URL:

```
https://risingranges.ijpedraza.com/manifest.json
```

## About this fork

This project is a modified version of [Ranges](https://github.com/owlbear-rodeo/ranges) by Owlbear Rodeo, licensed under the GNU GPLv3. It merges Ranges' range-ring rendering with a relative altitude/height mechanic and a configurable 3D distance engine.

## License

GNU GPLv3 — see [`LICENSE`](./LICENSE).

## Support

Found a bug or have a feature request? Open an issue on [GitHub](https://github.com/nachoijp/Rising-Ranges/issues).

## Contributing

Not currently accepting outside contributions.

Copyright (C) 2024 Owlbear Rodeo
Copyright (C) 2026 Ignacio Pedraza (modifications)
