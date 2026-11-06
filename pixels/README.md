# ie2 pixels

Select, drag and delete the individual pixels of an image, without the browser falling over on big photos. Runs entirely in your browser; nothing is uploaded.

Live: **https://sunnq3.github.io/ie2/pixels/**

## Use

- **Click** a pixel to select it. Hold **A** (or turn on **Add**) to add, hold **X** (or **Remove**) to remove. Shift / Alt work too where the browser allows.
- **Drag on empty space** to box-select (Shift / Alt work here too).
- **Drag a selection** to move it. It leaves transparent holes behind and covers whatever it lands on.
- **Pick** (I): click the image to take a colour into the swatches. **From area** fills the swatches with the main colours of the selection (or the whole image); click a swatch to use it, right-click to remove it.
- **Randomize…**: in the selection (or the whole image), a random share of pixels (*Amount*) is changed; of those, *Deleted* become empty and the rest take a colour from a random pixel within *Reach*, from the swatches, or both. **Re-roll** replaces the last result with new dice; Undo restores the original.
- **Arrow keys** nudge the selection by 1 px (Shift: 10 px).
- **Delete** removes the selected pixels, leaving holes.
- **Fill** (F): click or paint over empty pixels to fill them from the surrounding colours, the current colour, or random swatches; existing pixels are never painted over. **Fill holes** fills every empty pixel in the selection, or the whole image, from the outside in.
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
