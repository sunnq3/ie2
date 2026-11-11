# ie2 pixels

Select, drag and delete the individual pixels of an image, without the browser falling over on big photos. Runs entirely in your browser; nothing is uploaded.

Live: **https://sunnq3.github.io/ie2/pixels/**

## Use

- **Click** a pixel to select it. Hold **A** (or turn on **Add**) to add, hold **X** (or **Remove**) to remove. Shift / Alt work too where the browser allows.
- **Drag on empty space** to box-select (Shift / Alt work here too).
- **Drag a selection** to move it. It leaves transparent holes behind and covers whatever it lands on.
- **Pick** (I): click the image to take a colour into the swatches. **From area** fills the swatches with the main colours of the selection (or the whole image); click a swatch to use it, right-click to remove it.
- **Randomize…**: in the selection (or the whole image), a random share of pixels (*Amount*) is changed; of those, *Deleted* become empty and the rest take a colour from a random pixel within *Reach*, from the swatches, or both. With **Photo grain** on, a new colour is the smooth colour around the source plus grain matched to the photo, so it doesn't leave stray dots. **Re-roll** replaces the last result with new dice; Undo restores the original.
- **Photo grain** (on by default): the app measures how much grain the photo has at each brightness and how coarse it is, once per image. Fill, Fill holes and Randomize give the pixels they make that same grain, so new pixels sit in the photo like the rest of it instead of looking smooth or speckled. Big filled areas get the full grain; scattered pin-holes get only a little pixel noise, since the real pixels around them already carry the grain. Turn it off for plain colours.
- **De-grid…** (D): removes the JPEG 8×8 grid look and evens out the noise. On walls and flat colours the grid you see is mostly texture: every 8×8 cell carries its own stamped pattern (bars, checkers or nothing), so the texture changes at every cell border. De-grid measures where the grid is (inside a JPEG cell neighbouring pixels are strongly related, across a cell border they aren't), keeps the image's light, shading, colour, lines and edges, evens out tone steps that sit exactly on cell borders, and replaces the stamped texture with continuous grain at the photo's own level for that brightness. Real texture (above the photo's noise level) is kept, areas that are already fine are left alone, and areas JPEG left too quiet get grain added, so the noise ends up even across the photo instead of piled on in some places and wiped in others. Nothing is blurred and no pixels are copied. **Preview** first (nothing changes until **Apply**); **Map** shows where it re-textures (orange), where it only adds grain (yellow) and what it keeps (blue); hold **C** to flip to the original. *Strength*, *Grain amount*, *Grain size*, *Even out noise* and *Keep detail* tune it, *New grain* re-rolls the grain, *Only inside the selection* limits it with a soft edge, *Select grid areas* turns the map into a selection. Runs in background workers (`degrid.js`), one per CPU core.
- **Arrow keys** nudge the selection by 1 px (Shift: 10 px).
- **Delete** removes the selected pixels, leaving holes.
- **Fill** (F): click or paint over empty pixels to fill them from the surrounding colours, the current colour, or random swatches; existing pixels are never painted over. **Fill holes** fills every empty pixel in the selection, or the whole image: each hole pixel is bridged along its row and its column between the nearest real pixels, so lines and edges that cross a hole carry straight through instead of being smeared; then Photo grain adds the grain.
- **Undo / redo** with Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z.
- **Zoom and pan:** the wheel zooms, Space or the Hand tool pans, 0 fits. The pixel grid appears from 800%.
- **Export:**
  - **PNG** keeps holes transparent.
  - **JPG** fills holes with a colour you choose. You also set the quality and colour resolution (4:4:4 by default).

## How it stays fast

- **No per-pixel objects.** The image is one flat pixel array mirrored on a single canvas.
- **The selection is a byte mask.** Selecting millions of pixels just writes bytes.
- **Dragging moves one floating picture of the selection.** Pixels are written once, on drop.
- **Edits and undo touch only the changed rectangle.** History stays within a fixed memory budget.
- **Size cap:** images over 24 MP are worked on as a scaled copy.

It shares v5's file encoders (`../v5/export.js`) and JPEG tables (`../v5/core.js`).
