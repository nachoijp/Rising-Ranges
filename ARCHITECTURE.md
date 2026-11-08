# Rising Ranges — code map

A guide to the source for reviewers and contributors. For what the extension does and how to use it, see the [README](README.md).

## Glossary

The code keeps the Spanish names the features were designed with; the interface shows the English ones (see `src/i18n/strings/en.ts`).

| In the code | In the interface | What it is |
|---|---|---|
| Medición | Measurement | Dragging from an Origin to measure ranges |
| Medición fija | Fixed Measurement | A Measurement left on the map for everyone |
| Origen | Origin | Where a Measurement measures from (a point or a token) |
| Banda | Range band | One range of a set (Melee, Close, Far…) |
| BandSet | Range set | A preset or custom list of Bandas |
| Lectura | Reading | The label a Measurement puts on each token |
| Altura / elevation | Elevation | How high a token is (its height marker) |
| Relieve / relief | Relief | A map's terrain heights, made in the relief editor |
| Vistazo | 3D Glance | The 3D view of the scene |
| Distancias | Distances panel | The list of distances from a token |
| Tolerancia | Tolerance | How much of a big token must be in range |

## Pages and entry points

Each HTML file at the root is one page Owlbear loads (built by Vite, `vite.config.js`):

| Page | Entry | What it is |
|---|---|---|
| `background.html` | `src/background/main.ts` | Always loaded: registers the tool, actions and menus; draws what every client draws for itself (rings, Readings, height overlays); keeps reliefs and settings in sync |
| `vistazo.html` | `src/vistazo/main.ts` | The 3D Glance (a popover, or full screen as a modal) and the relief editor (full screen) |
| `vistazo-tab.html` | `src/vistazo/tabHost.ts` | The 3D Glance in a browser tab of its own (see below) |
| `settings.html` | `src/settings/main.tsx` | Settings (React) |
| `token-height.html` | `src/tokenHeight/main.tsx` | A token's elevation, footprint and base (context menu) |
| `distances.html` | `src/distances/main.tsx` | The Distances panel |
| `theme.html` | `src/theme/main.tsx` | The color theme picker |
| `terrain-visibility.html` | `src/terrainVisibility/main.tsx` | Who sees the relief on the map |

Web workers (off the main thread): `src/vistazo/terrainWorker.ts` (the 3D terrain's meshes), `src/vistazo/fillWorker.ts` (what's painted under bridges), `src/relief/editor/generate.worker.ts` (turning fog walls into a relief).

## Folders

| Folder | What's in it |
|---|---|
| `src/engine` | Pure math, no Owlbear: distances in 3D (`distance.ts`), which Banda a distance falls in (`bands.ts`), hex cells, axonometric grids |
| `src/background` | One module per job of the background page: the Measurement tool (`createMeasureTool.ts`), the Fixed Measurement, height overlays, the toolbar and menus, settings sync |
| `src/render` | What the map shows of a Measurement: rings, icon stacks, Readings (Owlbear items built from the engine's numbers) |
| `src/tokenHeight` | Elevation markers on tokens (`markers.ts`) and their context-menu page |
| `src/bandSets` | The built-in range presets and the room's custom ones |
| `src/settings` | The settings page and the settings model (`globalSettings.ts`) |
| `src/terrain` | Terrain from shapes drawn on the map (the older way), and the heights it gives |
| `src/relief` | Reliefs: their data (`types.ts`, `codec.ts`), heights at a point (`relief.ts`), storage in the scene (`store.ts`, `sceneItems.ts`), doors (`doorCut.ts`) |
| `src/relief/editor` | The relief editor: tools, panel, 2D view, the "Generate relief" dialog |
| `src/relief/trace` | Turning a map's fog walls (Owlbear's, Smoke & Spectre's, a `.uvtt` file) into a relief |
| `src/vistazo` | The 3D Glance: the page (`main.ts`), the scene it draws (`scene.ts`), fog, doors, weather, templates, other players' drags (`remote.ts`) |
| `src/vistazo/render.ts` | The WebGL view (three.js): builds and draws the terrain, tokens' bases, walls, water, fog |
| `src/vistazo/view` | The view's parts as plain functions and arrays (so the worker can run them too): surfaces, walls, water, shader layers (`layers.ts`) |
| `src/i18n` | Spanish and English strings |
| `src/util` | Small shared helpers |
| `src/obr.ts` | The SDK as every page imports it (see below) |

## What the extension stores

All keys are under `com.ignaciopedraza.risingranges/` (`src/util/getPluginId.ts`).

- **Scene metadata**: the settings (`globalSettings.ts`), the language, the chosen range set.
- **Room metadata**: the custom range sets (`bandSets/library.ts`) and the Fixed Measurement while there is one.
- **Item metadata**: a token's footprint, height and base in the 3D Glance; on shapes drawn on the map, whether they're terrain and how.
- **Scene items**: each token's elevation marker, a path attached to it that stores its elevation and is never drawn (`tokenHeight/markers.ts`); each map's relief, in hidden items of its own (`relief/sceneItems.ts`; reliefs can be large, more than scene metadata holds).
- **Local items only** (never shared): rings, Readings and height overlays. Every client draws its own from the shared data, in its own color theme.
- **Player metadata**: whether this player's 3D Glance is open (others send their token drags only then).
- **On the device**: panel sizes and options (localStorage), relief backups and the 3D terrain cache (IndexedDB).

## The 3D Glance in its own tab

Owlbear's SDK only works inside the frame Owlbear gives an extension. In a browser tab, the 3D Glance reaches Owlbear through the background page:

- `src/obr.ts` is what every page gets for `@owlbear-rodeo/sdk` (an alias in `vite.config.js`): the real SDK, except in the tab, where a stand-in sends each call to the background.
- `src/vistazo/tabHost.ts` is the tab's page. The Glance that opens it tells it where Owlbear's window is; it finds the background among Owlbear's frames and passes messages both ways.
- `src/background/tabRelay.ts` makes each call with the real SDK and sends the answer back. Messages are only accepted from the extension's own origin and session.

## Building and checking

- `npm run dev`: the dev server (the extension at `http://localhost:5173/manifest.json`).
- `npm run build`: type-checks (`tsc -p tsconfig.app.json`), builds to `dist/` and checks the manifest.
