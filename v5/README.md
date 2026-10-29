# ie2 v5 · artifact lab

A from-scratch GPU editor for the artifacts that cameras, codecs, tapes and screens leave on an image. Everything runs as WebGL2 shaders in the browser; nothing is uploaded.

Live: **https://sunnq3.github.io/ie2/v5/**

## Effects (run in this order)

**Optics & film:** halation, colour shading, field curvature, sagittal coma

**Sensor:** rolling shutter (skew, wobble, flicker bands), per-channel clipping, pixel crosstalk, CCD smear & blooming, fixed-pattern noise (row/column banding, hot pixels, amp glow, PDAF stripes), sensor noise, Bayer demosaic artifacts

**Processing:** HDR ghosting, lens-profile correction, noise-reduction smear, chroma blotches, tone-mapping halos, over-sharpening

**Compression & encoding:** resize round-trip (incl. gamma-incorrect), chroma subsampling, JPEG (real 8×8 DCT, multi-generation), banding / posterize, datamosh

**Analog video:** VHS colour, composite artifacts (rainbowing, dot crawl), tape damage

**Display:** subpixel rendering, PenTile fringing, CRT misconvergence, DLP rainbow, LCD smear & overdrive, phosphor mask & scanlines

Ten presets combine them (early-2000s digicam, phone night mode, re-shared ten times, VHS dub, CRT arcade, and others).

## Use

Open, drop or paste an image, or start from the built-in test scene. **Crop & rotate** (or **C**) opens a crop box with aspect presets, 90° turns, flips and a straighten slider; straightening zooms in just enough that no empty corners ever show, and crops / turns without tilt copy pixels exactly. Switch effects on in the rack, compare with **Split** (drag the divider) or hold **Space** for the original. Scroll to zoom, drag to pan, **F** fits, **1** is actual pixels. Export as PNG, JPEG or WebP.

Requires WebGL2 with float render targets (any current desktop or mobile browser). Images larger than 24 MP are worked on as a scaled copy.

## Files

- `core.js`: WebGL2 pipeline, texture pool, blur, display and export
- `rack.js`: every effect's shaders, parameters and the presets
- `main.js`: interface
