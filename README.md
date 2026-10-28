# ie2

Browser-based image editor for a clean, camera-like look. Live: **https://sunnq3.github.io/ie2/**

Everything runs locally in the browser; images are never uploaded. Every edit is baked into the pixels of the exported JPEG.

Previous version: **v2** is kept at https://sunnq3.github.io/ie2/v2/ (branch `v2`).

## How to use

1. Open an image (button, drag-and-drop or paste).
2. Pick a **Look** at the top — *Natural camera*, *Phone camera*, *Vintage lens*, or *Clean*.
3. Fine-tune the stages on the right, top to bottom. Each shows only its key controls; switch on **Advanced** (bottom of the stage list) for every fine-tuning slider.
4. Check the **JPEG** view (the decoded export file, its size and how much fine detail survived), then **Export JPG**.

## Stages

Pixels stay in floating point between stages and are rounded to 8-bit once, at the end, with an invisible anti-banding dither. With every stage neutral the output is byte-identical to the input. Each stage has an on/off switch; off skips it entirely. Stages that interpolate pixels are tagged **resamples**.

1. **Clean-up** — deblock JPEG 8×8 edges, deband gradients, remove moiré/halftone/grids. Always runs first.
2. **Seams** — content-aware resize (remove or insert low-detail seams).
3. **Lens** — distortion and chromatic aberration in a single resample, with your choice of interpolation (Lanczos 3 by default, bicubic, bilinear, nearest = no blending). **Keep detail sharp** (on by default) takes brightness from a plain geometric resample, so colour fringing changes colour only and never softens detail; only distortion itself moves pixels. Colour fringing (red/blue radial scale with corner bias), lens dispersion (achromat green/magenta, simple lens blue/yellow), soft blue focus (axial CA), purple fringing. Advanced: per-channel shifts, falloff shape, irregular field, and stylised effects (chroma/luma shift, smear, echo).
4. **Resample** — optional upscale (up to 6×) → downscale to a final size; optional luminance-only sharpening.
5. **Grain** — camera sensor noise, added last so nothing softens it, and only the noise goes through the pipeline (your pixels are not resampled): photosite shot + read noise in linear light → edge-directed demosaic steered by the image's own edges → in-camera luma NR, sharpening and chroma NR. Read noise is a constant floor that the sRGB curve amplifies in dark tones, so grain accumulates in the shadows (≈2.6× the highlights at the defaults). Simple controls: **Amount**, **Shadow grain**, **Colour noise**.
6. **Export** — built-in JPEG encoder: quality, full-resolution colour (4:4:4) by default, and **Protect grain** (flatter high-frequency quantisation + stochastic rounding so fine grain is not rounded away).
