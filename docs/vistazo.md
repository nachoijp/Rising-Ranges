# 3D Glance

The 3D Glance shows the scene as a small diorama: the map's terrain raised to its heights, tokens standing at their elevation, range rings, distance lines and readings in 3D. The GM also builds the terrain here, with the relief editor.

![The 3D Glance, full screen](screenshots/glance/fullscreen.jpg)

- [Opening it](#opening-it)
- [Moving around](#moving-around)
- [The panel](#the-panel)
- [Editing the relief](#editing-the-relief)
- [Shapes](#shapes)
- [Vertices and height points](#vertices-and-height-points)
- [Slabs](#slabs)
- [Groups](#groups)
- [Doors](#doors)
- [Turning fog into relief](#turning-fog-into-relief)
- [Keyboard shortcuts](#keyboard-shortcuts)

## Opening it

The Glance has its own button in the toolbar. Who gets it is chosen in **Settings → General → 3D Glance**:

- **Hidden** — no button for anyone. The GM can still edit the relief from a map image's right-click menu.
- **GM only** — only the GM gets the button.
- **Everyone** — the default: players open it too, and see the scene as their fog lets them.

![Who gets the 3D Glance](screenshots/glance/settings-general.png)

The window can be moved by its grip, minimised (the toolbar button brings it back), or taken full screen. The panel on the right opens and closes with the button at its top.

**Open in a tab** (the button beside full screen) moves the Glance to a browser tab of its own: drag it to another screen and keep Owlbear in view. It works as the panel does (the relief editor stays in Owlbear), and follows the scene as it changes. If Owlbear is reloaded, the tab links to it again by itself; if Owlbear is closed, open the Glance from Owlbear and press the same button. The tab keeps its own options.

The **camera** button beside it opens a list of camera moves — a full orbit round the terrain, a sweep, pushing in and out, a crane down from above, a pendulum — played once with the panel and buttons out of the way: a quick way to show the terrain. With **Sync view** on, the players see it too. Those marked ↻ end where they start, so they loop seamlessly if you record them. Esc or a click on the scene stops a move.

## Moving around

| Do | To |
| --- | --- |
| Drag | orbit around the middle |
| Hold the wheel, or Shift + drag | pan |
| Wheel | zoom |
| Double-click a token or the terrain | turn around that spot |
| Click the compass | reset the view |
| Click a token | select it |
| Drag a token | move it (Z / X change its height while dragging) |
| Click empty ground | measure from there (Z / X raise and lower the point) |
| Click a door's button | open or shut it (see [Doors](#doors)) |
| Esc | remove the point, or close |

The **?** in the corner lists these too.

A token you drag, or a point you measure from, shows its Measurement on everyone's map too (its rings, the Readings and its height), as a Measurement on the map does; a hidden token's doesn't. Owlbear keeps it there for 15 seconds at most; a point moved or raised after that shows again.

## The panel

![The Glance's panel](screenshots/glance/overview.jpg)

At the top:

- **Top-down view** — the camera straight down, as the map.
- **Sync view** (GM) — players with the Glance see what your camera sees (it opens for them if it's set to Everyone). Each still sees through their own fog.
- **Edit relief** (GM) — the relief editor (see below).
- **Show tokens** and **View as a player** — the scene as a player sees it: with the fog (Owlbear's or Smoke & Spectre's), without hidden tokens or what's under the fog. The fog is as on Owlbear's map: fog shapes, rooms you've cut open, and what the lights reveal, with their soft edges. A secondary light (a campfire) shows only once a character's light sees it. The fog opens around a token as it's dragged, and a token with a light dragged in the Glance stops at the fog's walls and slides along them, as on the map (one without a light goes through, as there). Under the fog the terrain isn't shown: a flat floor of fog, with a curtain of it along its edge, stands in for it, and heights read 0 there.
- **Quality** — High as designed, always as sharp; Medium is a little less sharp on dense screens, with less weather, and on a slow device it's drawn less sharp while the camera moves; Low for slower devices, the same, more so. Dragging a token never makes it less sharp.

The rest is folded into sections:

**Templates.** Spell areas in 3D: a sphere, cube, cylinder, cone or line, with a texture (fire, ice, poison, lightning, darkness, arcane, force, necrotic, acid, thunder, psychic, radiant) and a size. **Place**, then click where it goes; a cone or a line then points where you click. Drag its handle to move it, or a cone's or a line's tip to turn it; the elevation hotkeys raise and lower the one you last placed or grabbed (a cone's or a line's tip: tilts it).

Templates are part of the scene, so everyone sees them, on the map too: there, each one is an animated area in its texture (each texture moves its own way; in a cone or a line it flows away from its point), under the tokens, that can be moved and turned like any drawing (the Glance follows). Players can place their own if the room lets them create drawings (Owlbear's player permissions); if not, the Glance tells them. They're listed under the buttons to remove one by one; **Remove all** removes everyone's. A template the GM hides isn't shown to players.

![Templates](screenshots/glance/templates.jpg)

**Tokens and distances.** The point of a token that's measured (its center or its base), distance lines, range rings on the terrain, the ground tinted by range, and how much the labels say.

![Tokens and distances](screenshots/glance/tokens.jpg)

**Camera.** Tilt, turn, and perspective (from flat to strong), and a reset.

![Camera](screenshots/glance/camera.jpg)

**Relief.** The height scale (to make heights read better), walls at the map's edge, the grid on the ground, and under **Look**: wall shading, shading by height, coloring the terrain by height, see-through terrain, animated water, animated maps (video maps, animated GIFs and WebPs played on the ground), and level lines on the walls.

**Props.** Items on the Prop layer, on the ground or standing, with shadows, lines to the ground, labels and distances.

![Relief and props](screenshots/glance/relief-props.png)

**Weather.** Rain, snow, sand, fire, petals or clouds from the Weather extension, if the scene has any; clouds as mist or as shadows on the ground.

![Weather](screenshots/glance/weather.jpg)

## Editing the relief

**Edit relief** (or **Edit relief** in a map image's right-click menu) opens the editor full screen: the map on the left, the 3D on the right. The line between them can be dragged; past a point, either side folds away.

![The relief editor](screenshots/glance/editor.jpg)

The relief follows the map image: move or resize the map, and it goes with it. If the scene has several maps, the one being edited is picked at the top left. **Done** saves; the **X** leaves without saving (a second click if there are changes). Under **⋮**: turn the room's fog walls into a relief (see [Turning fog into relief](#turning-fog-into-relief)), export the relief to a file, import one, bring in the zones from the old terrain tool, or clear it.

The tools, on the left:

- **Select** — pick shapes and move, resize or turn them; or, in **Vertices** mode, their corners and height points (see [Vertices and height points](#vertices-and-height-points)).
- **Cut** — drag a line across a shape to split it in two.
- **Draw** — the shape tools, in one button:

  ![The shape tools](screenshots/glance/draw-menu.png)

  - **Rectangle** and **Ellipse** — drag from corner to corner (Shift: a square or circle; Alt: from the middle).
  - **Lasso** — draw the outline freehand (its smoothing in the bar).
  - **Pen** — click each corner; click the first one (or Enter) to close it.
  - **Roller** — paint over what you want to trace; let go, and it's a shape. Touching the picked shape, it grows it; with Alt, it cuts from it.
  - **Ready shapes** — a column, a pit, stairs, a platform with a ramp, a wall or a mound, put down with a click.

  ![Rectangle, Lasso, Pen and Roller bars](screenshots/glance/bar-rect.png)

  The **Edge** in the bar is the edge new shapes get: a wall (0), or a soft slope that fades into what's round it.

- **Door** — drag from a door's hinge to its other end, on a wall (see [Doors](#doors)).
- **Terrain brush** — raises, lowers, smooths or flattens what's on top (the ground, or the shape over it), or only the ground. Its size and strength are in the bar; [ and ] change its size while painting.

  ![The terrain brush](screenshots/glance/bar-brush.png)

The **magnet** snaps to the grid (on unless you turn it off); the **palette** colors the map by height.

## Shapes

Shapes are stacked: each one sits on what's under it. Picking one shows its panel:

![A shape's panel](screenshots/glance/shape-panel.png)

- **Height** — a level over what's under it (**relative**), or a height of its own (**fixed**, the pin under **Measured**).
- **Type** — **Terrain** (ground you can stand on), **Slab** (a bridge, balcony or platform floating over the terrain: see [Slabs](#slabs)), or **Standing** (the map's picture of it stood upright, as a statue or a tree).
- **Surface** — **Flat**, a **Ramp** (an arrow from one height to another, in steps if you want stairs), or **Inclined** (each corner at its own height).
  - A ramp's arrow goes from its start to its end height: drag its two ends — with any tool, while the ramp is picked — to turn it or to set where the slope starts and ends. The arrow buttons point it up, right, down or left across the whole shape, keeping its heights; **Flip** swaps its start and end heights, so it rises the other way; **Reset** lays it along the shape's longer side again.
- **3D look** — its walls' look: **Blend** (the default: the map's colors along the wall, the top's running into the foot's, with a subtle grain), **Flat color**, **Stretched edge** and **Folded edge** (the map's edge pulled down the wall), **Brick**, **Stone**, **Earth** or **Wood**; a texture taken from a rectangle of the map; water in it; its edge (a wall, or a soft slope); and **Not covered by slabs** (see [Slabs](#slabs)).

Right-click a shape for duplicate, rename, layer up or down, convert, combine (union, subtract, intersect, exclude), group, take a texture, or delete.

With several shapes picked (Ctrl + click), the panel raises or lowers them all together, each from its own height (a ramp both its ends, an inclined one its corners), and combines them.

## Vertices and height points

In **Vertices** mode (the second button in Select's bar, or double-click a shape), the picked shape's corners and height points can be moved:

- **Click a side** — adds a corner there (a "+" shows where), ready to drag into place.
- **Double-click inside an inclined shape** — adds a height point: a spot of its surface at its own height. The hint at the bottom of the map says how, wherever the pointer is.
- **Alt + click** a corner or point — removes it.
- **Drag on empty space** — picks several corners and points with a box; **Shift + click** adds one or takes it out.
- **Z / X**, or − / + in the panel, raise and lower what's picked by a quarter level; arrow keys nudge it; Delete removes it.

An inclined shape's surface goes through every corner and height point, in triangles between the nearest ones. A point lower than the ones round it makes a dip; two high points with a lower one between them, a channel.

![Vertices mode](screenshots/glance/vertices.png)

## Slabs

A slab floats over the terrain at its height, as thick as its **Thickness**. Inclined or ramped, it follows its surface. Tokens can stand on it, and it blocks sight.

The map usually shows the slab from above, so under it the 3D would repeat its drawing on the ground. **Under it** picks what's shown there instead:

- **Cover the drawing** (the default) — the map's colors round it, blended, with a grain.
- **Mirror the sides** — the map by its long sides, mirrored: for a bridge over a river or a road.
- **Keep the map** — nothing: for a slab that isn't drawn on the map.

A shape under a slab that should keep its own look — a pillar under a statue — gets **Not covered by slabs** in its 3D look.

![A slab's Under it](screenshots/glance/slab-under.png)

## Groups

Shapes can be grouped, as folders in the shapes list: **Ctrl + G** (or the right-click menu) groups the picked ones; **Ctrl + Shift + G** undoes a group. Groups can hold groups.

- A group's shapes always stay together in the stacking order, so their order inside it stays as it is.
- Click a group to pick all its shapes; drag it to move it whole; drop something on its lower half to put it in.
- Its eye and lock hide or lock all its shapes at once (in the editor only).
- Groups start folded when the editor opens; one you make while editing starts open.
- A new shape drawn while a grouped shape is picked goes into that group.

![Groups in the shapes list](screenshots/glance/groups.png)

## Doors

A door is drawn on a wall, with the **Door** tool: drag from its hinge to its other end. The wall stays as it is on the map; in the Glance, and when measuring, the doorway is cut through it, as tall as its **Opening**, the rest of the wall over it as its lintel. A token in a doorway stands on its floor.

Drawn on one of the fog's doors (Owlbear's own fog, or Smoke & Spectre's), it's **linked** to it: it opens and shuts with that door, and the fog with it. **Find** links a door drawn near one, and puts it right on it; **Unlink** lets it go. A door that isn't linked stays shut.

Its panel:

![A door's panel](screenshots/glance/door-panel.png)

- **Look** — the leaf in the walls' styles (wood, brick, stone, earth, plain color, blend, the map stretched up), the **Map picture** (a rectangle of the map over it), or its own (metal, bars, glass).
- **Opens** — it **swings** (by its **Angle**, to either side: **Other way**), **slides**, **lifts** or **vanishes**. **Hinge on the other end** moves the hinge.
- **Opening** and **Thickness** — how tall the doorway is, and how thick the leaf.
- **Secret** — to players, while it's shut, there's no door: it's the wall.

![A door open in the Glance, with its button](screenshots/glance/door-button.png)

In the Glance, a button over each linked door opens or shuts it, shown as you get near it (and with the keyboard, Tab). The GM can always use them; players only where the fog extension lets them (Owlbear's fog permission, or Smoke & Spectre's player doors). In **View as a player**, a door hidden by the fog on both sides isn't shown, and a shut one with fog on one side shows only from the clear side.

## Turning fog into relief

**Turn fog into relief…** (under **⋮**) builds walls and rooms from the walls the room already has for its fog, their thickness measured on the map's picture:

![Turn fog into relief](screenshots/glance/fog-to-relief.png)


- **Smoke & Spectre walls** — rooms, walls, round towers, objects and hedges; its doors become doors, linked to them.
- **Owlbear's fog** — each fog shape is a room, with a wall along its edges where the picture shows one. Its doors become doors, linked to them; a door drawn shut on the map without a fog door often comes out as wall: cut it open.
- **A .uvtt plan** — the map's .uvtt or .dd2vtt file (many map packs include one for Foundry). Its doors become doors, not linked (shut until you link them).

What's closed in and dark on the picture (rock, void) is made solid. It can also look for stairs in the picture (they climb from 0 to 1: check their direction and heights), and replace what's there or add on top, with the wall height you choose. Ctrl + Z undoes it.

## Keyboard shortcuts

| Key | Does |
| --- | --- |
| V | Select (again: shapes / vertices) |
| D | Door |
| Ctrl + Z / Ctrl + Y | undo / redo |
| Ctrl + D | duplicate |
| Ctrl + G / Ctrl + Shift + G | group / ungroup |
| F2 | rename the shape |
| [ and ] | a layer down or up (with the brush: its size) |
| Z / X | raise / lower what's picked |
| Arrow keys | nudge |
| Delete | delete |
| Esc | let go |

Each tool's own keys are in its tooltip and in the **?** at the top.
