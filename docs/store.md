---
title: Rising Ranges
description: A relative, 3D-aware range and altitude measuring tool — drag to see live range rings, per-token readings, and optional persistent height markers
author: Ignacio Pedraza
image: https://raw.githubusercontent.com/nachoijp/Rising-Ranges/main/docs/screenshots/in-action.png
icon: https://raw.githubusercontent.com/nachoijp/Rising-Ranges/main/public/logo.png
tags:
  - tool
  - combat
manifest: https://risingranges.ijpedraza.com/manifest.json
learn-more: https://github.com/nachoijp/Rising-Ranges#readme
---

# Rising Ranges

A relative, 3D-aware range and altitude measuring tool. Drag from an Origin — a
point or a token — and see live range rings, a Reading on every other token,
and optional persistent height markers.

![Measuring with rings and readings](https://raw.githubusercontent.com/nachoijp/Rising-Ranges/main/docs/screenshots/in-action.png)

## Features

- **Relative range measuring** — click and drag from any point or token to
  reveal concentric range bands (Melee, Very Close, Close, Far, Very Far — or
  your own).
- **Fixed Measurement** — hold Shift as you let go of a Measurement and it
  stays on the map, for everyone, while you move tokens around it.
- **Height / altitude tracking** — right-click a token to set a persistent
  height marker, or nudge height live with hotkeys while measuring, range by
  range or one grid cell at a time. Readings account for height in 3D, with a
  choice of spherical, cubic, or cylindrical distance, and big creatures take
  up height too.
- **Three built-in presets** — Dagger, Steel (Draw Steel's distances,
  measured square by square), and Dragons — or build your own set of ranges
  from scratch.
- **Multiple visualization styles** — icon stacks, rings, or filled circles,
  independently sized and colored.
- **Color-blind friendly themes** — Base, Deuteranopia, Tritanopia,
  Protanopia, or your own colors; each player sees everything in their own.
- **Bilingual** — Español / English, switchable per room.
- **Configurable hotkeys and feature toggles** — strip it back to plain
  range-rings with no per-token readings or height tracking at all, if that's
  all you need.

## How to use

1. Select the Rising Ranges tool from the toolbar and drag from a token
   or an empty point to set your Origin.
2. Every other token gets a live Reading showing which range band it's in,
   with an arrow if it's above or below you.
3. While measuring, use the configurable hotkeys to raise or lower the
   Origin's height, or put it back on the ground.
4. Right-click any token to set a persistent height marker that sticks around
   outside of a measurement.

![Height markers on several tokens](https://raw.githubusercontent.com/nachoijp/Rising-Ranges/main/docs/screenshots/height-markers.png)

## Build your own ranges

Start from Dagger, Steel, or Dragons — duplicate one to edit it — or build
your own: name each range, set its radius and icon, and choose how distance
is calculated (spherical / cubic / cylindrical), whether heights step by range
or by grid cell, and how forgiving Tolerance is. An optional Final Range
names everything past the farthest one.

![Editing a custom set of ranges](https://raw.githubusercontent.com/nachoijp/Rising-Ranges/main/docs/screenshots/custom-ranges.png)

## What shows on the map

How each measured token is marked (an icon, a ring, a circle, or nothing),
what its label says (the Range, the exact distance, or both), and what the
rings around the Origin say, with the size of both labels — with any set of
ranges, presets included.

![Map settings](https://raw.githubusercontent.com/nachoijp/Rising-Ranges/main/docs/screenshots/map-tab.png)

## Distances panel

Pick a token to list every other one with its Range and its horizontal,
vertical and total distance, live as tokens move — for the GM only or for
everyone; players never see hidden tokens. Drag it anywhere on screen by its
handle.

![Distances panel](https://raw.githubusercontent.com/nachoijp/Rising-Ranges/main/docs/screenshots/distances-panel.png)

## Settings

Set the room's language and hotkeys, and toggle whole feature groups on or
off — including stripping the extension back to plain range-rings with no
readings or height tracking. Every setting applies right away, and a Help
button in the General tab brings you back to the full manual.

![General settings](https://raw.githubusercontent.com/nachoijp/Rising-Ranges/main/docs/screenshots/general-tab.png)

## Color-blind themes

Base, three color-blind themes, or a Custom one with up to 12 colors of your
own. Each player picks their own and sees everything in it — rings, Readings
and height markers — whoever is measuring.

![Theme picker](https://raw.githubusercontent.com/nachoijp/Rising-Ranges/main/docs/screenshots/themes.png)

## About this fork

This project is a modified version of [Ranges](https://github.com/owlbear-rodeo/ranges)
by Owlbear Rodeo, licensed under the GNU GPLv3. It merges Ranges' range-ring
rendering with a relative altitude/height mechanic and a configurable 3D
distance engine.

## Support

Found a bug or have a feature request? Open an issue on
[GitHub](https://github.com/nachoijp/Rising-Ranges/issues).
