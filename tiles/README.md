# Tile Luma

A browser tool that splits an image into a grid of tiles, applies a per-tile
luma (brightness/contrast) edit, blends the tiles back together seamlessly, and
measures in real time how far the result has moved from the original. Export is
a JPEG.

**Live:** https://sunnq3.github.io/ie2/tiles/

Everything runs in the page. Nothing is uploaded. No Python, no build step — it
is three static files served by GitHub Pages.

## What it does

- Cuts the image into a grid you set (by **Grid X / Grid Y**, or by a target
  **piece count**).
- Edits **luma only** — the image is taken to JFIF full-range YCbCr and only Y
  is touched, so colour (Cb/Cr) is left exactly as it was.
- Each tile gets its own **gain** (contrast about mid-grey) and **offset**
  (brightness lift), either **randomized** per tile within a ± range or
  **uniform** (one shared value everywhere). Randomization is seeded, so a seed
  reproduces a run exactly.
- Blends tile edges so the stitched image has **no visible seam** — see the math
  below. A **Hard tiles** mode is included so you can see the seams a naive cut
  would leave (and what the metrics think of them).
- Shows four live measurements against the original, and the real SSIM of the
  JPEG you actually export.

## The math

### Colour — edit luma, keep colour exact

RGB is converted to YCbCr with the JFIF / full-range BT.601 transform (the one
JPEG itself uses):

```
Y  = 0.299 R + 0.587 G + 0.114 B
Cb = 128 − 0.168736 R − 0.331264 G + 0.5 B
Cr = 128 + 0.5 R − 0.418688 G − 0.081312 B
```

Only Y is edited; Cb/Cr are recombined untouched and converted back with the
matching inverse. The whole pipeline is Float32 and quantises to 8-bit once, at
the final write, so a zero edit is an identity round trip (verified: ≤1 LSB).

### Seamless blending — the core result

A naive "cut, edit each tile, paste back" leaves a visible grid, and the eye is
especially sensitive to those step edges. Instead of pasting hard tiles, the
per-tile gain/offset values live on a coarse control lattice and are
interpolated to a smooth per-pixel field `g(x,y)`, `b(x,y)`:

```
Y'(x,y) = g(x,y) · (Y(x,y) − 128) + 128 + b(x,y)
```

With smooth interpolation the fields vary slowly, so there is no seam anywhere.

Why this is the *right* way and not a shortcut: the honest alternative is
overlapping tiles blended with a partition-of-unity window (`Σ w_i = 1`, e.g. a
Hann window at 50% overlap). For a **linear** per-tile edit `g_i·Y + b_i`,

```
Σ_i w_i (g_i Y + b_i) = Y · (Σ_i w_i g_i) + (Σ_i w_i b_i) = g(x,y)·Y + b(x,y)
```

— the overlap-add of linear tiles *is* the interpolated field. So the field form
is the exact closed form, with fewer passes and no border bookkeeping. (CLAHE
solves the identical seam problem the same way, bilinearly interpolating its
per-tile maps between tile centres.)

Blend modes: **Smooth** (smoothstep bilinear, continuous slope), **Bilinear**
(continuous value), **Hard tiles** (nearest node — visible seams, for
comparison).

### SSIM — and the metric that actually matters here

SSIM is the standard Wang et al. 2004 index on luma: 11×11 Gaussian window
(σ = 1.5), `k1 = 0.01`, `k2 = 0.03`, dynamic range `L = 255`, averaged over the
valid region (5-px border cropped). It is computed with a separable Gaussian and
matches a brute-force 2-D reference to 1e-4.

The catch, and the point worth understanding: **SSIM is built to be insensitive
to a luminance shift.** A pure offset leaves the variance and covariance terms
unchanged, so SSIM stays near 1 even for a clearly different brightness — e.g. a
flat +10 offset measures SSIM ≈ 0.996 while every pixel moved by 10. So SSIM
answers *"does it still look like the same photo?"* but not *"how much did the
brightness pattern move?"* — which is the actual goal. The panel therefore shows
both:

- **Y-SSIM** — structure/appearance preserved (keep high).
- **PSNR** and **mean / max |ΔY|** — the magnitude of the luma-pattern change
  (push these up while SSIM stays high).

The live SSIM is computed on a small proxy while you drag (shown with `≈`) and
replaced by the exact full-resolution value a moment after you stop. **Delivered
SSIM** re-decodes the JPEG you export and measures *that*, since the JPEG
re-quantises and 4:2:0-subsamples — so the number you report is the one actually
in the file.

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell and layout |
| `style.css` | Dark, panel-based UI |
| `pipeline.js` | All image math; pure functions, no DOM (runs in Node too) |
| `app.js` | Canvas, controls, preview, export |

`pipeline.js` has no DOM dependencies on purpose, so the colour transforms,
field interpolation and SSIM can be unit-tested directly in Node.

## Notes

- Working images are capped at 3000 px on the longest side to keep memory and
  interaction responsive; export is at that working resolution.
- Loads via Open, drag-and-drop, or paste. Any format the browser can decode.
- `Ctrl`/`Cmd` + scroll to zoom; **Hold: original** shows the unedited image.
