# ie2

Browser-based image editor for a clean, camera-like look. Live: **https://sunnq3.github.io/ie2/**

Everything runs locally in the browser; images are never uploaded. Every edit is baked into the pixels of the exported JPEG.

Previous, full-featured versions: **v3** https://sunnq3.github.io/ie2/v3/ · **v2** https://sunnq3.github.io/ie2/v2/ (branches `v3`, `v2`).

## Controls (one panel)

- **Clean-up** — *Fix JPEG blocks & banding*: smooths 8×8 compression blocks and stepped gradients already in the photo.
- **Lens fringing** — *Amount* and *Type* (green/magenta like most lenses, or blue/yellow like a simple lens). Modelled on measured lenses; only colour changes, brightness detail is never resampled:
  - *lateral CA*: blue vs green dominates, red vs green is small; lensfun-style radial polynomial, ~0 in the middle third and growing toward the corners; slightly decentred axis so the two sides differ
  - *longitudinal CA*: purple rims in front of the focal plane, green behind, only on out-of-focus edges (anywhere in the frame); focus is estimated from the image (gradient-ratio defocus map)
  - *purple fringing*: violet halo on the dark side of blown highlights, wider toward the corners
  - fringes are softened the way a Bayer sensor and demosaic record them, never crisp 1-px coloured lines
- **Grain** — real camera sensor noise added last: *Amount*, *Shadow grain* (how much it builds up in dark areas), *Colour noise*, and *Fill smoothed patches* (puts matching noise back only where an earlier edit removed it).
- **Size** — *Final size*: resizes first, before any other edit (area averaging when shrinking), so nothing added later is resampled.
- **Export** — *Quality*, *Protect grain* (keeps fine grain from being rounded away by compression), filename. Colour is always full resolution (4:4:4).

Views: Result, Original, JPEG (the decoded export file with its size and how much fine detail survived), hold to compare (or Space), zoom.

Pixels stay in floating point and are rounded to 8-bit once, at the end. With every control at its default the output is identical to the input.
