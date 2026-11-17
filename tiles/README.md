# Tile Signal

A browser tool that makes a **real, measurable change to an image's signature**
while staying close to visually identical — and shows you both numbers side by
side. It replaces an earlier version that only did a smooth brightness/contrast
edit, which looks invisible precisely because it changes nothing a detector
reads. This one moves the quantities detectors actually key on.

**Live:** https://sunnq3.github.io/ie2/tiles/

Everything runs in the page. Nothing is uploaded. No Python, no build step — four
static files served by GitHub Pages.

## Why luma gain/offset was pointless, and what changed

A smooth gain/offset on luma is a point operation on the one channel most
detectors normalise away, at low frequency where you must keep it tiny to stay
invisible. The tell: it keeps SSIM pinned at ~1, which is the definition of *not
changing structure*. "Invisible" and "real signal change" only coexist if you
put the change where the eye is blind and a detector is not — **high spatial
frequencies, phase/resampling, and noise structure**. These three transforms do
that. The tile grid is kept as a smooth 0–1 strength map, so each transform can
be strong in some regions and weak in others with no seam.

## The three transforms

All operate on luma (JFIF full-range YCbCr; chroma recombined untouched). Each
reports the quantity it actually moved, not just how different it looks.

### 1. Resample warp
`Y'(x,y)` = bilinear sample of `Y` at `(x + ax·fx, y + ay·fy)`, with `fx,fy`
smooth signed sub-pixel fields. Rewrites every pixel's provenance through
interpolation. This **moves perceptual hashes** and **leaves a resampling trace**
(the periodic correlation in the resampled signal's second difference that
Popescu–Farid-style detectors look for) while disturbing any trace already
present. *Readout:* mean displacement in px. *Limit:* it is not a geometric hide
and does not remove content.

### 2. DCT mid-band
Blockwise 8×8 orthonormal DCT-II; coefficients with radial index `u+v` inside a
band get a seeded additive perturbation scaled by the strength field; inverse
DCT. This **shifts the block-DCT coefficient statistics** that JPEG-domain and
double-compression forensics inspect. The perturbation energy stays in the
chosen band (verified: >20× the energy outside it). *Readout:* mean |Δcoef| over
the band. *Limits:* a very high band is quantised away by the JPEG you export; a
low band becomes visible. Block-aligned, like JPEG itself.

### 3. PRNU-model noise
`Y' = Y·(1 + k·N)`, `N` zero-mean unit white noise — the multiplicative
photo-response model. **Changes the noise residual** a denoise-and-subtract
extractor recovers. *Readout:* residual std (matches `k·Y` to measurement). *Hard
limit:* this perturbs the residual; it does **not** forge any specific camera's
PRNU fingerprint — that requires the reference fingerprint, which this tool does
not have and does not use.

## Measurements

- **Y-SSIM** — appearance guard (keep near 1).
- **PSNR, mean / max |ΔY|** — overall change magnitude.
- **DCT Δcoef / warp disp / noise residual** — the actual signal each enabled
  transform moved. This is the point: these move while SSIM stays high.
- **Delivered SSIM** — re-decodes the JPEG you export and measures *that*, since
  JPEG re-quantises and 4:2:0-subsamples; it's the number that's really in the
  file.

Verify the signal independently with your own detectors — the tool reports what
it did, it does not grade itself.

## Correctness

All math is in `pipeline.js` (colour, SSIM, grid) and `signal.js` (the three
transforms) as pure, DOM-free functions, validated in Node (34 checks total):

- 8×8 DCT matrix orthonormal to 1e-6; DCT→IDCT round-trip identity; Parseval
  energy preserved; zero-amount is identity; residual energy concentrated in the
  target band (>20× outside).
- warp zero-amplitude is identity; displacement is sub-pixel as set.
- noise zero is identity; residual std matches the `k·Y` model (2.555 vs 2.56
  predicted).
- RGB↔YCbCr round trip ≤1 LSB; separable-Gaussian SSIM matches a brute-force 2-D
  reference to 1e-4.

## Files

| File | Purpose |
|---|---|
| `index.html` | Shell and layout |
| `style.css` | Dark, panel-based UI |
| `pipeline.js` | Colour, SSIM, tile grid, luma stats — pure, no DOM |
| `signal.js` | DCT-band, warp, PRNU-model noise, strength field — pure, no DOM |
| `app.js` | Canvas, controls, preview, export |

## Notes

- Working images are capped at 3000 px on the longest side; export is at that
  resolution.
- Transforms apply in order warp → DCT → noise; each is an independent toggle.
- Load via Open, drag-and-drop, or paste. `Ctrl`/`Cmd` + scroll to zoom;
  **Hold: original** shows the unedited image.
