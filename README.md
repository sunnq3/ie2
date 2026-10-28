# ie2

Browser-based micro image editor. Live: **https://sunnq3.github.io/ie2/**

Everything runs locally in the browser (Web Workers); images are never uploaded. Every edit is baked into the pixels of the exported JPEG — no layers, no metadata tricks.

## Layout

The right-hand panel has a **stage list** (in processing order) and the controls for **one stage at a time**. Each stage has an on/off switch in its header; switching a stage off bypasses it completely. Inside a stage, related controls sit in collapsible cards; cards with a switch are optional effects. A dot in the stage list marks stages that are currently changing the image; a struck-through name means the stage is switched off. Stages that interpolate pixels are tagged **resamples**.

## Pipeline

Pixels stay in floating point between stages and are rounded to 8-bit **once**, at the end (with an optional invisible anti-banding dither). With every stage neutral, the output is byte-identical to the input.

1. **Clean-up** — deblock JPEG 8×8 edges, remove repeating patterns (FFT peak suppression: moiré, halftone, grids, scan lines), deband gradients. Runs first or late.
2. **Seams** — content-aware resize: remove or insert low-energy seams (forward or gradient energy).
3. **Lens & CA** — one resample for everything; interpolation is your choice: Lanczos 3, bicubic, bilinear or **nearest (no interpolation)**. Switch the stage off to skip resampling entirely.
   - Distortion: `r·(1 + k1·r² + k2·r⁴)`, movable centre, scale, auto-fill.
   - Lateral CA: per-channel sub-pixel X/Y shift and radial scale, optionally mixed in linear light.
   - Radial falloff: power / S-curve / ring, start radius, ring width, aspect.
   - Spectral dispersion (achromat green/magenta, simple lens blue/yellow, prism), axial CA, purple fringing, irregular CA field.
   - Stylised: chroma-vs-luma shift, directional smear, echo.
4. **Colour** — roundtrip through linear, Display P3, Lab, HSV, HSL, YCbCr at adjustable intermediate precision (4–16 bits), 1–10 passes.
5. **Resample** — optional: upscale (up to 6×) → downscale to a final size; optional luminance-only unsharp mask with threshold.
6. **Grain** — added after all resampling, with one shared placement mask (whole image / painted / everything except painted; brush, erase, undo).
   - *Camera sensor grain*: photosite shot + read noise in linear light → edge-directed demosaic steered by the image's own edges → in-camera luma NR, sharpening and chroma NR. Grain-only mode never touches the image's own pixels. Mid-frequency grain with soft colour blotches, strongest in shadows; at equal strength it survives JPEG 4:2:0 2–4× better than 1-px noise.
   - *Synthetic noise*: Gaussian / uniform / Laplacian / impulse / brightness-dependent, density, colour, grain size, irregularity.
7. **Output** — 8-bit conversion with anti-banding dither, and the built-in JPEG encoder: quality, 4:4:4 / 4:2:2 / 4:2:0, *grain keep* (flatter high-frequency quantisation), *grain-safe rounding* (stochastic rounding of AC coefficients), optimized Huffman tables.

## Viewer

- Result / Original / Diff (×1–×128) / Seams (when seam carving is active) / JPEG (the decoded export file, its size and how much fine detail survived)
- Hold to compare (or hold Space); zoom fit … 1600 %
- Open via button, drag-and-drop or paste; HEIC and TIFF fall back to in-browser decoders
- Double-click a control's label to reset it; each stage has Reset; settings persist between visits
