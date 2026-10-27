# ie2

Browser-based micro image editor. Live: **https://sunnq3.github.io/ie2/**

Everything runs locally in the browser (Web Worker); images are never uploaded.

## Pipeline

1. **Content-aware scale (seam carving)** — removes or inserts low-energy pixel seams horizontally and/or vertically, pixel by pixel. Forward-energy or gradient energy.
2. **Chromatic aberration** — per-channel sub-pixel X/Y shifts (0.01 px steps) plus per-channel radial scale (lateral CA, 0.001 % steps).
3. **Elastic warp / lens distortion** — radial `r·(1 + k1·r² + k2·r⁴)` model (barrel / pincushion), movable centre, scale, auto-fill, bicubic or bilinear resampling. Distortion and CA share one resampling pass to avoid double interpolation.
4. **Colour-space roundtrip** — sRGB↔linear, sRGB↔Display P3, sRGB↔CIE Lab, RGB↔HSV, RGB↔HSL, RGB↔YCbCr (BT.601/709/2020, full/limited range, 4:4:4/4:2:2/4:2:0), each with adjustable intermediate precision (4–16 bits, fractional) and 1–10 passes.

5. **Upscale → downscale** — enlarge up to 6× (0.01 steps; bicubic, Lanczos 3, Mitchell, bilinear, nearest), optionally store the enlarged image at 8-bit, then shrink to a final size (100 % = same size; 1–600 %) with Lanczos 3, bicubic, Mitchell, bilinear, box or nearest.

6. **Noise distribution** — Gaussian, uniform, Laplacian, impulse (± specks) or shot (brightness-dependent) noise. Amount in 8-bit levels (0.01 steps), density, colour vs. mono, grain size, irregularity (patchy low-frequency modulation with adjustable patch size) and a seed. Apply it to the whole image, only to painted areas, or everywhere except painted areas. Paint the mask on the image with a soft brush (size, hardness, opacity), erase with Alt-drag or the Erase tool, Undo / Clear. Shortcuts: B paint, E erase, [ ] brush size (Shift for fine), Ctrl/⌘+Z undo, Esc stop painting.

Then **Export JPG** with adjustable quality.

## Viewer

- Result / Original / Diff (amplified ×1–×128) / Seams (red = removed, green = duplicated)
- Hold-to-compare button or hold <kbd>Space</kbd>
- Zoom fit … 1600 % with pixel-exact rendering
- Open via button, drag-and-drop or paste. HEIC and TIFF fall back to in-browser decoders.
- Double-click any control label to reset it. Settings persist between visits.
