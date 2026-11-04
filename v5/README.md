# ie2 v5 · artifact lab

A from-scratch GPU editor for the marks cameras, codecs, tapes and screens leave on an image. Everything runs as WebGL2 shaders in the browser; nothing is uploaded.

Live: **https://sunnq3.github.io/ie2/v5/**

## How it works

- **Scene light.** Lens and sensor effects work in linear light, with blown highlights rebuilt as real light (*Highlight recovery*). Glow, flare, fringing and smear therefore appear only around genuinely bright things, and ordinary detail stays sharp. The conversion is exactly invertible, so it changes nothing on its own.
- **A simulated camera.** *Camera* records the scene through an RGGB Bayer sensor with photon (shot) noise, read noise, pixel-gain spread, row banding and hot pixels, counted in electrons and set by **ISO**. It then demosaics (edge-directed, Malvar-He-Cutler or bilinear) and applies white balance, saturation, tone, luma and chroma noise reduction, and sharpening. Profiles: neutral, modern phone, 2012 phone, 2005 CCD compact, DSLR / mirrorless, webcam. Noise comes out clumped and colour-blotched like real camera noise, so it survives JPEG instead of being averaged away.
- **Built for the saved file.** **As saved** (on by default) shows the image exactly as the export will store it: a real JPEG encode and decode at your settings, at the export size. You can optionally add what an app (Instagram, WhatsApp, Facebook, X, Messages; approximate) does after upload.
- **Survival badges.** Each effect that is on is measured before and after that export:
  - **Natural:** survives, within the range real cameras / devices produce.
  - **Lost:** won't really show in the file.
  - **Too strong:** a setting is beyond anything real.

  Sliders shade the real-world range, and **Overall intensity** scales every effect together.

## Effects

- **Lens:** highlight recovery, chromatic aberration (lateral, with spectral spread), out-of-focus colour fringes (purple in front, green behind, detected from the image), purple fringing, coma, veiling glare & ghost reflections, film halation, vignetting, colour shading, corner softness, distortion (auto-filled frame), camera shake, missed focus.
- **Sensor & camera:** sensor dust, rolling shutter, CCD smear & blooming, Camera.
- **Processing:** HDR ghosting, lens-profile correction, noise-reduction smear, chroma blotches, tone-mapping halos, over-sharpening.
- **Compression & sharing:**
  - **Re-share:** shrink to a real sharing size (with a choice of real-world scalers), platform sharpening, 8-bit rounding, JPEG at the small size, then enlarge as a viewer does. Optional generations, half-pixel offset errors and gamma-incorrect resizing. *Keep detail* stops it turning into blur.
  - Also: JPEG compression (real 8×8 DCT, chroma subsampling, generations), banding, datamosh.
- **Analog video:** VHS colour, composite rainbowing, tape damage.
- **Display:** CRT misconvergence, DLP rainbow, LCD smear & overdrive, phosphor mask & scanlines.

Presets cover a modern phone (day / night), a 2012 phone, a 2005 compact, a DSLR at high ISO, a webcam call, a film scan, Instagram, five re-shares, a VHS dub and a CRT arcade.

## Merge versions

Pick or drop 2–8 images at once (or use **Merge…**) to blend versions of the same picture into one. Each version has a weight slider, and clicking a thumbnail shows that version alone. Modes:

- **Mix:** a weighted blend; every version's edits show in proportion to its weight
- **Median:** keeps what most versions agree on, so an edit only one version has fades out
- **Lighten / Darken:** the brightest or darkest version at each pixel
- **Sharpest:** whichever version has the most fine detail at each spot
- **Patchwork:** each area comes from a different version, with adjustable patch size and seam softness
- **Channels:** red, green and blue each from a chosen version
- **Detail + colour:** brightness from one version, colour from another

Versions should share the same size and crop; any that differ are stretched to match the first. The blend then goes through crop & rotate and the effect rack like any other image.

## Export

**Export…** opens the file settings:

- **Format:** JPEG (quality; colour 4:4:4 / 4:2:2 / 4:2:0), PNG, or 16-bit PNG.
- **Size:** full size or a long-edge size.
- **Check on:** none, or a sharing app.

Files are written by v5's own encoders: JPEG with Huffman tables optimised per image and an upright EXIF orientation, PNG with an sRGB tag. Pixels are read straight from the GPU, so files can't come out flipped.

## Use

Open, drop or paste an image, or start from the built-in test scene. **Crop & rotate** (or **C**) opens a crop box with aspect presets, 90° turns, flips and a straighten slider; straightening zooms in just enough that no empty corners ever show. Compare with **Split** (drag the divider), or hold **Space** for the original. Scroll to zoom, drag to pan, **F** fits, **1** is actual pixels.

Requires WebGL2 with float render targets (any current desktop or mobile browser). Images larger than 24 MP are worked on as a scaled copy.

## Files

- `core.js`: WebGL2 pipeline, scene-light conversion, resampling, GPU JPEG (encode half + decoder), as-saved simulation, survival measurement
- `rack.js`: every effect's shaders, parameters, camera profiles, sharing destinations and presets
- `export.js`: JPEG entropy coder and PNG writer
- `main.js`: interface
