'use strict';
/*
 * ie2 v5 — the effect rack.
 * Each effect: id, group, name, info, params, run(ctx, src, p) -> texture, and the light domain it works
 * in (domain: 'scene' = linear light with rebuilt highlights; default 'display' = the photo's own values).
 * Effects run in the order listed here, the order light takes through a camera and on to a screen.
 *
 * Param fields: k, l (label), min, max, step, d (default), u (unit), real: [lo, hi] (range real cameras /
 * devices produce; shaded on the slider), amt (scaled by the overall intensity), adv (under "More"),
 * o: [[value, label]] for a choice, b: true for a switch, show: (v) => text for the number box.
 * Sizes given in "‰" are thousandths of the image diagonal, so effects keep their look at any size.
 */

const GROUPS = [
  ['lens', 'Lens'],
  ['sensor', 'Sensor & camera'],
  ['proc', 'Processing'],
  ['comp', 'Compression & sharing'],
  ['analog', 'Analog video'],
  ['display', 'Display'],
];

/* ------------------------------------------------------------------ shaders */
// sharp Catmull-Rom sampling at a pixel-space position (pixel i's centre is at i + .5)
const BIC = `
vec4 crw(float t) { float t2 = t * t, t3 = t2 * t; return vec4(-.5 * t3 + t2 - .5 * t, 1.5 * t3 - 2.5 * t2 + 1., -1.5 * t3 + 2. * t2 + .5 * t, .5 * t3 - .5 * t2); }
vec3 bic(vec2 q) {
  q -= .5; vec2 f = fract(q); ivec2 i = ivec2(floor(q)); vec4 wx = crw(f.x), wy = crw(f.y); vec3 c = vec3(0.);
  for (int y = 0; y < 4; y++) { vec3 r = vec3(0.); for (int x = 0; x < 4; x++) r += wx[x] * px(i + ivec2(x - 1, y - 1)); c += wy[y] * r; }
  return c;
}
`;

const S = {
  /* ---------------- lens (scene light) ---------------- */
  // lateral CA: each colour channel magnified differently, growing toward the corners; spread smears each
  // channel over a small range of positions the way a band of wavelengths does — the image stays sharp.
  ca: BIC + `uniform float u_amt, u_sp; uniform vec2 u_ctr; uniform vec3 u_ch;
void main() {
  vec2 p = P(), v = p - (u_res * .5 + u_ctr); float R = .5 * length(u_res), r = length(v) / R;
  vec2 n = r > 1e-6 ? v / length(v) : vec2(0.);
  float f = r * r * (.55 + .45 * r * r); vec3 c = px(ivec2(p)), out3 = c;
  for (int k = 0; k < 3; k++) {
    float d = u_amt * f * u_ch[k];
    if (abs(d) < 1e-3) continue;
    float a = bic(p + n * d * (1. - .5 * u_sp))[k], b = bic(p + n * d)[k], e = bic(p + n * d * (1. + .5 * u_sp))[k];
    out3[k] = max(.25 * a + .5 * b + .25 * e, 0.);
  }
  o = vec4(out3, 1.);
}`,
  sq: `void main() { o = vec4(vec3(sqrt(max(lumaL(texelFetch(u_src, ivec2(P()), 0).rgb), 0.))), 1.); }`,
  // longitudinal CA: on out-of-focus edges one end of the spectrum is blurrier than the other.
  // Defocus is read from the picture: an edge whose fine gradient is no steeper than its coarse one is soft.
  grad: `void main() { ivec2 i = ivec2(P()); o = vec4(vec3(.5 * length(vec2(px(i + ivec2(1, 0)).r - px(i - ivec2(1, 0)).r, px(i + ivec2(0, 1)).r - px(i - ivec2(0, 1)).r))), 1.); }`,
  maxf: `uniform ivec2 u_dir; uniform int u_r; void main() { ivec2 i = ivec2(P()); float m = 0.; for (int k = -u_r; k <= u_r; k++) m = max(m, px(i + u_dir * k).r); o = vec4(vec3(m), 1.); }`,
  loca: `uniform sampler2D u_g, u_b, u_f; uniform float u_amt, u_w, u_mode, u_sharp;
void main() {
  vec2 p = P(); ivec2 i = ivec2(p);
  // steepest fine gradient within reach of the fringe: a sharp edge has one close by, a defocused edge does not
  float fine = texelFetch(u_g, i, 0).r;
  vec2 ex = vec2(u_w, 0.) / u_res, ey = vec2(0., u_w) / u_res, uv = UV();
  float cx = texture(u_b, uv + ex).r - texture(u_b, uv - ex).r, cy = texture(u_b, uv + ey).r - texture(u_b, uv - ey).r;
  float coarse = length(vec2(cx, cy)) / (2. * u_w);
  float edge = smoothstep(.004, .025, coarse * u_w);
  float soft = smoothstep(1.9, 1.15, fine / max(coarse, 1e-6));
  float k = u_amt * edge * max(soft, u_sharp);
  vec3 c = texelFetch(u_src, i, 0).rgb, bl = texture(u_f, uv).rgb;
  float near = u_mode < .5 ? smoothstep(.35, .75, p.y / u_res.y) : u_mode < 1.5 ? 1. : 0.;
  vec3 r = mix(c, mix(vec3(c.r, bl.g, c.b), vec3(bl.r, c.g, bl.b), near), k);
  float y0 = lumaL(c), y1 = lumaL(r);
  o = vec4(max(r * (y1 > 1e-5 ? clamp(y0 / y1, .5, 2.) : 1.), 0.), 1.);
}`,
  pfMask: `uniform float u_t; void main() { vec3 c = texelFetch(u_src, ivec2(P()), 0).rgb; o = vec4(vec3(smoothstep(u_t * .8, u_t * 1.3, max(c.r, max(c.g, c.b)))), 1.); }`,
  // purple fringing: a violet haze on the dark side next to blown highlights, wider toward the corners
  pf: `uniform sampler2D u_m, u_b1, u_b2; uniform float u_amt;
void main() {
  vec2 uv = UV(); vec3 c = texelFetch(u_src, ivec2(P()), 0).rgb;
  float s = mix(texture(u_b1, uv).r, texture(u_b2, uv).r, smoothstep(.2, 1., rad()));
  float k = u_amt * smoothstep(0., .45, s) * (1. - texture(u_m, uv).r);
  float Y = lumaL(c), dark = 1. - smoothstep(.04, .8, Y);
  vec3 tint = vec3(.6, .12, 1.);
  o = vec4(mix(c, max(Y, .012) * tint * 1.7, .75 * k * dark) + .05 * k * tint, 1.);
}`,
  // coma: light from bright points spreads outward into comet tails near the corners (only light above
  // u_t is spread, so ordinary detail is not blurred)
  coma: `uniform float u_k, u_len, u_w, u_t;
void main() {
  vec2 p = P(), d = p - u_res * .5; float r = length(d) / (.5 * length(u_res));
  vec2 dir = length(d) > 0. ? normalize(d) : vec2(0.), per = vec2(-dir.y, dir.x);
  float L = u_len * r * r; vec3 acc = vec3(0.); float ws = 0.;
  for (int i = 1; i <= 24; i++) {
    float t = float(i) / 24., w = (1. - t) * (1. - t), side = (i % 2 == 0) ? 1. : -1.;
    acc += w * max(at(p - dir * L * t + per * side * u_w * .5 * L * t * t) - u_t, 0.); ws += w;
  }
  o = vec4(px(ivec2(p)) + u_k * 1.6 * smoothstep(.15, .95, r) * acc / ws, 1.);
}`,
  over: `uniform float u_t; void main() { o = vec4(max(texelFetch(u_src, ivec2(P()), 0).rgb - u_t, 0.), 1.); }`,
  // veiling glare (scattered light lifting the shadows) and ghost reflections of bright lights,
  // mirrored through the centre of the frame
  glare: `uniform sampler2D u_v, u_g1, u_g2; uniform float u_gl, u_gh; uniform int u_n;
void main() {
  vec2 p = P(), c0 = u_res * .5; vec3 c = px(ivec2(p));
  vec3 add = u_gl * texture(u_v, UV()).rgb * vec3(1., .97, .92);
  float S[6] = float[6](-.38, .55, -.82, 1.3, -1.55, .28);
  vec3 T[6] = vec3[6](vec3(.35, 1., .55), vec3(.85, .4, 1.), vec3(1., .72, .3), vec3(.4, .8, 1.), vec3(.95, .5, .8), vec3(1., .92, .55));
  for (int j = 0; j < 6; j++) {
    if (j >= u_n) break;
    vec2 x = c0 - (p - c0) / S[j];
    if (any(lessThan(x, vec2(0.))) || any(greaterThan(x, u_res))) continue;
    vec3 g = mix(texture(u_g1, x / u_res).rgb, texture(u_g2, x / u_res).rgb, smoothstep(.4, 1.4, abs(S[j])));
    add += u_gh * .06 * T[j] * lumaL(g) / (S[j] * S[j] + .25);
  }
  o = vec4(c + add, 1.);
}`,
  halaMask: `uniform float u_t, u_n; void main() { o = vec4(vec3(max(lumaL(texelFetch(u_src, ivec2(P()), 0).rgb) - u_t, 0.) / u_n), 1.); }`,
  halaAdd: `uniform sampler2D u_b; uniform float u_k;
void main() { o = vec4(px(ivec2(P())) + u_k * .8 * texture(u_b, UV()).r * vec3(1., .3, .06), 1.); }`,
  vig: `uniform float u_st, u_a; void main() { float f = exp2(-u_st * pow(smoothstep(u_a, 1.04, rad()), 1.7)); o = vec4(px(ivec2(P())) * f, 1.); }`,
  cast: `uniform float u_k, u_t, u_off;
void main() {
  vec2 d = (P() - u_res * vec2(.5 + .22 * u_off, .5)) / (.5 * length(u_res));
  float f = u_k * pow(smoothstep(.12, 1.15, length(d)), 1.6);
  o = vec4(px(ivec2(P())) * max(vec3(1.) + f * u_t * vec3(.24, -.32, .28), 0.), 1.);
}`,
  soft: `uniform sampler2D u_b, u_c; uniform float u_k, u_s;
void main() {
  float t = 2. * u_k * pow(smoothstep(u_s, 1., rad()), 1.4);
  vec3 c = px(ivec2(P())), a = texture(u_b, UV()).rgb, b = texture(u_c, UV()).rgb;
  o = vec4(t < 1. ? mix(c, a, t) : mix(a, b, min(t - 1., 1.)), 1.);
}`,
  // radial distortion; u_z zooms so the frame stays filled (no empty edges)
  distort: BIC + `uniform float u_k1, u_k2, u_z;
void main() {
  vec2 c0 = u_res * .5, v = P() - c0; float R = .5 * length(u_res), rd = length(v) / R;
  float rt = (1. + u_k1 * rd * rd + u_k2 * rd * rd * rd * rd) * u_z;
  o = vec4(max(bic(c0 + v * rt), 0.), 1.);
}`,
  path: `uniform vec2 u_path[24]; void main() { vec2 p = P(); vec3 s = vec3(0.); for (int i = 0; i < 24; i++) s += at(p + u_path[i]); o = vec4(s / 24., 1.); }`,
  disc: `uniform float u_r;
void main() { vec2 p = P(); vec3 s = vec3(0.);
  for (int i = 0; i < 96; i++) { float r = u_r * sqrt((float(i) + .5) / 96.), a = float(i) * 2.39996323; s += at(p + r * vec2(cos(a), sin(a))); }
  o = vec4(s / 96., 1.); }`,
  dust: `uniform vec3 u_d[20]; uniform float u_s[20]; uniform int u_n;
void main() { vec2 p = P(); vec3 c = px(ivec2(p)); float a = 1.;
  for (int i = 0; i < 20; i++) { if (i >= u_n) break; float d = length(p - u_d[i].xy) / u_d[i].z;
    a *= 1. - u_s[i] * (1. - smoothstep(.5, 1., d)) * (.8 + .2 * smoothstep(.3, .85, d)); }
  o = vec4(c * a, 1.); }`,

  /* ---------------- sensor (scene light) ---------------- */
  rolling: `uniform float u_skew, u_wob, u_wf, u_fl, u_fp;
void main() {
  vec2 p = P(); float ny = p.y / u_res.y;
  float dx = u_skew * (ny - .5) + u_wob * sin(2. * PI * u_wf * ny + 1.3) * (.7 + .3 * sin(2. * PI * u_wf * .37 * ny + 4.1));
  float band = 1. - u_fl * .6 * (.5 + .5 * cos(2. * PI * p.y / u_fp + float(int(u_seed) % 97)));
  o = vec4(at(vec2(p.x - dx, p.y)) * band, 1.);
}`,
  ccdCols: `void main() { int x = int(P().x), H = int(u_srcRes.y); float s = 0.; for (int y = 0; y < H; y++) s += texelFetch(u_src, ivec2(x, y), 0).r; o = vec4(vec3(s / float(H)), 1.); }`,
  ccdAdd: `uniform sampler2D u_cs, u_bl; uniform float u_sm, u_bo;
void main() { float cs = texture(u_cs, vec2(UV().x, .5)).r, bl = texture(u_bl, UV()).r;
  o = vec4(px(ivec2(P())) + (u_sm * 4. * cs + u_bo * bl) * vec3(1., .985, .96), 1.); }`,

  // the camera: Bayer mosaic with photon (shot) noise, read noise, per-pixel gain (PRNU), row banding and
  // hot pixels, counted in electrons; full-well capacity clips each photosite on its own
  camMosaic: `uniform float u_gain, u_S, u_read, u_prnu, u_hot, u_band, u_k;
int cfa(ivec2 i) { return (i.y & 1) == 0 ? ((i.x & 1) == 0 ? 0 : 1) : ((i.x & 1) == 0 ? 1 : 2); }
void main() {
  ivec2 i = ivec2(P()); vec3 c = max(texelFetch(u_src, i, 0).rgb * u_gain, 0.); int ch = cfa(i); vec2 f = vec2(i);
  float e = min(ch == 0 ? c.r : ch == 1 ? c.g : c.b, 1.) * u_S;
  float g = 1. + u_prnu * gss(f, 7.);
  float n = u_k * (sqrt(e) * gss(f, 11.) + u_read * gss(f, 13.) + u_read * u_band * 2. * gss(vec2(0., f.y), 17.));
  float raw = (e * g + n) / u_S;
  if (rnd(f, 19.) < u_hot) raw += .25 + .75 * rnd(f, 23.);
  o = vec4(min(raw, 1.), 0., 0., 1.);
}`,
  // demosaic step 1: green everywhere. 0 bilinear, 1 Malvar-He-Cutler, 2 edge-directed (Hamilton-Adams)
  camGreen: `uniform int u_alg;
int cfa(ivec2 i) { return (i.y & 1) == 0 ? ((i.x & 1) == 0 ? 0 : 1) : ((i.x & 1) == 0 ? 1 : 2); }
float R(ivec2 i) { return texelFetch(u_src, clamp(i, ivec2(0), ivec2(u_srcRes) - 1), 0).r; }
void main() {
  ivec2 i = ivec2(P()); float C = R(i);
  if (cfa(i) == 1) { o = vec4(C, C, 0., 1.); return; }
  float N = R(i + ivec2(0, -1)), Sx = R(i + ivec2(0, 1)), Wx = R(i + ivec2(-1, 0)), E = R(i + ivec2(1, 0));
  float NN = R(i + ivec2(0, -2)), SS = R(i + ivec2(0, 2)), WW = R(i + ivec2(-2, 0)), EE = R(i + ivec2(2, 0));
  float g;
  if (u_alg == 0) g = .25 * (N + Sx + Wx + E);
  else if (u_alg == 1) g = (4. * C + 2. * (N + Sx + Wx + E) - (NN + SS + WW + EE)) / 8.;
  else {
    float dh = abs(Wx - E) + abs(2. * C - WW - EE), dv = abs(N - Sx) + abs(2. * C - NN - SS);
    float gh = .5 * (Wx + E) + .25 * (2. * C - WW - EE), gv = .5 * (N + Sx) + .25 * (2. * C - NN - SS);
    g = dh < dv * .8 ? gh : dv < dh * .8 ? gv : .5 * (gh + gv);
  }
  o = vec4(C, g, 0., 1.);
}`,
  // demosaic step 2: red and blue
  camRB: `uniform int u_alg;
int cfa(ivec2 i) { return (i.y & 1) == 0 ? ((i.x & 1) == 0 ? 0 : 1) : ((i.x & 1) == 0 ? 1 : 2); }
vec2 T(ivec2 i) { return texelFetch(u_src, clamp(i, ivec2(0), ivec2(u_srcRes) - 1), 0).rg; }
float R(ivec2 i) { return T(i).x; }
float D(ivec2 i) { vec2 t = T(i); return t.x - t.y; }
void main() {
  ivec2 i = ivec2(P()); int c = cfa(i); vec2 t = T(i); float C = t.x, G = t.y, rr, bb;
  float N = R(i + ivec2(0, -1)), Sx = R(i + ivec2(0, 1)), Wx = R(i + ivec2(-1, 0)), E = R(i + ivec2(1, 0));
  float NN = R(i + ivec2(0, -2)), SS = R(i + ivec2(0, 2)), WW = R(i + ivec2(-2, 0)), EE = R(i + ivec2(2, 0));
  float dg = R(i + ivec2(-1, -1)) + R(i + ivec2(1, -1)) + R(i + ivec2(-1, 1)) + R(i + ivec2(1, 1));
  bool redRow = (i.y & 1) == 0;
  if (c == 1) {
    float hz, vt;
    if (u_alg == 0) { hz = .5 * (Wx + E); vt = .5 * (N + Sx); }
    else if (u_alg == 1) { hz = (5. * C + 4. * (Wx + E) - (WW + EE) - dg + .5 * (NN + SS)) / 8.; vt = (5. * C + 4. * (N + Sx) - (NN + SS) - dg + .5 * (WW + EE)) / 8.; }
    else { hz = G + .5 * (D(i + ivec2(-1, 0)) + D(i + ivec2(1, 0))); vt = G + .5 * (D(i + ivec2(0, -1)) + D(i + ivec2(0, 1))); }
    rr = redRow ? hz : vt; bb = redRow ? vt : hz;
  } else {
    float other;
    if (u_alg == 0) other = .25 * dg;
    else if (u_alg == 1) other = (6. * C + 2. * dg - 1.5 * (NN + SS + WW + EE)) / 8.;
    else other = G + .25 * (D(i + ivec2(-1, -1)) + D(i + ivec2(1, -1)) + D(i + ivec2(-1, 1)) + D(i + ivec2(1, 1)));
    rr = c == 0 ? C : other; bb = c == 2 ? C : other;
  }
  o = vec4(rr, G, bb, 1.);
}`,
  // in-camera colour: white balance, saturation, tone (highlights roll off to white at saturation), contrast
  camISP: `uniform float u_back, u_hrT, u_knee, u_wb, u_tint, u_sat, u_con;
void main() {
  vec3 c = texelFetch(u_src, ivec2(P()), 0).rgb * u_back;
  c *= vec3(1. + .22 * u_wb, 1. - .12 * u_tint, 1. - .22 * u_wb);
  float Y = lumaL(c); c = max(Y + (c - Y) * u_sat, 0.);
  vec3 d = toDisp(c, u_hrT, u_knee);
  float y = luma(d), yy = clamp(y, 0., 1.);
  float yc = u_con >= 0. ? mix(yy, yy * yy * (3. - 2. * yy), u_con) : mix(yy, .5 + (yy - .5) * .6, -u_con);
  o = vec4(d * (y > 1e-4 ? yc / y : 1.), 1.);
}`,
  // luma noise reduction: edge-preserving average of brightness only
  camLNR: `uniform float u_sr, u_k;
void main() {
  ivec2 i = ivec2(P()); vec3 c = px(i); float y0 = luma(c), s = 0., ws = 0., a = 1. / (2. * u_sr * u_sr);
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++) { float v = luma(px(i + ivec2(x, y))), d = v - y0, w = exp(-float(x * x + y * y) * .22 - d * d * a); s += w * v; ws += w; }
  o = vec4(c + u_k * (s / ws - y0), 1.);
}`,
  // chroma noise reduction: colour from a blurred copy, brightness kept — leaves the soft colour blotches
  camCNR: `uniform sampler2D u_b; uniform float u_k;
void main() { vec3 a = toYcc(px(ivec2(P()))), b = toYcc(texture(u_b, UV()).rgb); o = vec4(fromYcc(vec3(a.x, mix(a.yz, b.yz, u_k))), 1.); }`,

  /* ---------------- processing (display) ---------------- */
  // Re-grain. 1) a smooth base: edge-preserving average of brightness, colour from a blurred copy
  // (a pixel with fewer than two similar neighbours — a hot pixel — is judged by its neighbours, so it is removed;
  //  colour is averaged with the same edge-aware weights from a pre-blurred copy)
  gtBase: `uniform sampler2D u_c; uniform int u_r; uniform float u_sr;
void main() {
  ivec2 i = ivec2(P()), mx = ivec2(u_srcRes) - 1; float c0 = luma(px(i)), m8 = 0.; int close = 0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    if (x == 0 && y == 0) continue;
    float v = luma(px(i + ivec2(x, y))); m8 += v; if (abs(v - c0) < 2. * u_sr) close++;
  }
  float g = close >= 2 ? c0 : m8 / 8.;
  float s = 0., ws = 0., a = 1. / (2. * u_sr * u_sr), sd = max(.6 * float(u_r), .7), ss = 1. / (2. * sd * sd); vec2 cs = vec2(0.);
  for (int y = -5; y <= 5; y++) for (int x = -5; x <= 5; x++) {
    if (abs(x) > u_r || abs(y) > u_r) continue;
    ivec2 j = i + ivec2(x, y);
    float v = luma(px(j)), d = v - g, w = exp(-float(x * x + y * y) * ss - d * d * a);
    s += w * v; cs += w * toYcc(texelFetch(u_c, clamp(j, ivec2(0), mx), 0).rgb).yz; ws += w;
  }
  o = vec4(fromYcc(vec3(s / ws, cs / ws)), 1.);
}`,
  // 2) what the smoothing took away (YCbCr), optionally without the 8x8 block steps of a JPEG
  gtRes: `uniform sampler2D u_b; uniform float u_db;
vec3 R(ivec2 i) { ivec2 j = clamp(i, ivec2(0), ivec2(u_srcRes) - 1); return toYcc(texelFetch(u_src, j, 0).rgb) - toYcc(texelFetch(u_b, j, 0).rgb); }
void main() {
  ivec2 i = ivec2(P()); vec3 r = R(i);
  if (u_db > .5) { ivec2 b = i - (i & 7); vec3 m = vec3(0.); for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) m += R(b + ivec2(x, y)); r -= m / 64.; }
  o = vec4(r, 1.);
}`,
  gtSq: `void main() { vec3 r = texelFetch(u_src, ivec2(P()), 0).rgb; o = vec4(r.x * r.x, .5 * (r.y * r.y + r.z * r.z), 0., 1.); }`,
  gtNoise: `void main() { vec2 p = P(); o = vec4(gss(p, 131.), gss(p, 137.), gss(p, 139.), 1.); }`,
  // per-cell residual level and brightness, read back to build the image's noise-vs-brightness curve
  cellStats: `uniform sampler2D u_b; uniform int u_f;
void main() { ivec2 b = ivec2(P()) * u_f, mx = ivec2(u_srcRes) - 1; vec2 v = vec2(0.); float l = 0., n = 0.;
  for (int y = 0; y < 16; y++) for (int x = 0; x < 16; x++) if (x < u_f && y < u_f) { ivec2 j = min(b + ivec2(x, y), mx); v += texelFetch(u_src, j, 0).rg; l += luma(texelFetch(u_b, j, 0).rgb); n += 1.; }
  o = vec4(v / n, l / n, 1.); }`,
  // 3) put back: detail where there are edges / texture, grain (own, reshaped, or a matched fresh pattern) elsewhere
  gtMix: `uniform sampler2D u_r, u_v, u_g, u_vg, u_n, u_vn;
uniform float u_det, u_gr, u_luma, u_sh, u_fresh, u_floor, u_es, u_ny[16], u_nc[16];
float curve(float y, float a[16]) { float f = clamp(y, 0., 1.) * 15.; int k = min(int(f), 14); return mix(a[k], a[k + 1], f - float(k)); }
void main() {
  ivec2 i = ivec2(P()), mx = ivec2(u_res) - 1; vec2 uv = UV();
  vec3 b = toYcc(px(i)), R = texelFetch(u_r, i, 0).rgb;
  vec2 V = max(texture(u_v, uv).rg, 1e-10), Vg = max(texture(u_vg, uv).rg, 1e-10);
  vec2 NF = max(vec2(curve(b.x, u_ny), curve(b.x, u_nc)), 1e-10);       // noise expected at this brightness
  float sn = sqrt(NF.x), snc = sqrt(NF.y);                                // the image's noise level here
  // a lone spike with quiet neighbours is a hot pixel, not detail
  int loud = 0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) if ((x != 0 || y != 0) && abs(texelFetch(u_r, clamp(i + ivec2(x, y), ivec2(0), mx), 0).r) > 2. * sn) loud++;
  if (abs(R.x) > 4. * sn && loud == 0) R = vec3(0.);
  // detail = edges in the smooth base, or residual well above the noise level (texture, fine type)
  float gx = luma(px(i + ivec2(1, 0))) - luma(px(i - ivec2(1, 0))), gy = luma(px(i + ivec2(0, 1))) - luma(px(i - ivec2(0, 1)));
  float t0 = mix(.05, .008, u_es), eg = smoothstep(t0, t0 * 3., .5 * length(vec2(gx, gy)));
  float lo = mix(4., 1.6, u_es), et = smoothstep(lo, 2. * lo, V.x / NF.x), ep = smoothstep(mix(5., 2.5, u_es), mix(7., 3.5, u_es), abs(R.x) / sn);
  float e = max(eg, max(et, ep));
  // grain: the residual reshaped (size) and held to the noise level; or a fresh pattern at that level
  float sg = min(sqrt(V.x), 1.5 * sn), sgc = min(sqrt(V.y), 1.5 * snc);
  vec3 G = texelFetch(u_g, i, 0).rgb * vec3(sqrt(V.x / Vg.x), sqrt(V.y / Vg.y), sqrt(V.y / Vg.y));
  G = clamp(G, -2.5 * vec3(sg, sgc, sgc), 2.5 * vec3(sg, sgc, sgc));
  vec3 N = texelFetch(u_n, i, 0).rgb / sqrt(max(texture(u_vn, uv).rgr, 1e-9));
  float fl = u_floor * .03;
  vec3 grain = u_fresh > .5 ? N * vec3(max(sn, fl), max(snc, .5 * fl), max(snc, .5 * fl))
                            : G + N * vec3(sqrt(max(fl * fl - NF.x, 0.)), sqrt(max(.25 * fl * fl - NF.y, 0.)), sqrt(max(.25 * fl * fl - NF.y, 0.)));
  float y = clamp(b.x, 0., 1.), shade = mix(1., .3 + 1.5 * (1. - smoothstep(.08, .95, y)) * smoothstep(0., .12, y + .02), u_sh);
  vec3 add = u_det * e * R + u_gr * (1. - e) * shade * grain * vec3(1., 1. - u_luma, 1. - u_luma);
  o = vec4(fromYcc(b + add), 1.);
}`,
  ghost: `uniform float u_k, u_dx, u_dy, u_patch;
void main() {
  vec2 p = P(); vec3 a = lin(at(p)), b = lin(at(p - vec2(u_dx, u_dy)));
  float m = 1.;
  if (u_patch > .5) { float n = .65 * vnoise(p / 90., 31.) + .35 * vnoise(p / 23., 32.); m = smoothstep(.44, .6, n); }
  o = vec4(srgb(mix(a, b, u_k * m)), 1.);
}`,
  lensIn: `uniform float u_k;
void main() {
  vec2 c0 = u_res * .5, v = P() - c0; float R = .5 * length(u_res), rd = length(v) / R, ru = rd;
  for (int i = 0; i < 5; i++) ru -= (ru - u_k * ru * ru * ru - rd * (1. - u_k)) / (1. - 3. * u_k * ru * ru);
  float sc = rd > 1e-5 ? ru / rd : 1. - u_k;
  float sp = (1. - u_k) / max(1. - 3. * u_k * ru * ru, .05);
  vec3 s = vec3(0.);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) s += at(c0 + v * sc + vec2(x, y) * sp / 3.);
  o = vec4(s / 9., 1.);
}`,
  lensOut: `uniform float u_k, u_near, u_ca;
vec3 sm(vec2 q) { return u_near > .5 ? px(ivec2(floor(q))) : at(q); }
void main() {
  vec2 c0 = u_res * .5, v = P() - c0; float R = .5 * length(u_res), ru = length(v) / R;
  float s = (1. - u_k * ru * ru) / (1. - u_k), e = u_ca * .0012 * ru * ru;
  o = vec4(sm(c0 + v * s * (1. + e)).r, sm(c0 + v * s).g, sm(c0 + v * s * (1. - e)).b, 1.);
}`,
  bilateral: `uniform int u_r; uniform float u_sr;
void main() {
  ivec2 i = ivec2(P()); vec3 c = px(i), s = vec3(0.); float ws = 0., ss = max(.6 * float(u_r), .5);
  float a = 1. / (2. * ss * ss), b = 1. / (2. * u_sr * u_sr);
  for (int y = -u_r; y <= u_r; y++) for (int x = -u_r; x <= u_r; x++) {
    vec3 v = px(i + ivec2(x, y)), d = v - c;
    float w = exp(-float(x * x + y * y) * a - dot(d, d) * b); s += w * v; ws += w;
  }
  o = vec4(s / ws, 1.);
}`,
  blotch: `uniform float u_k, u_sz, u_sh;
void main() {
  vec2 p = P(); vec3 y = toYcc(at(p)); vec2 q = p / u_sz;
  vec2 n = vec2(vnoise(q, 41.) + .5 * vnoise(q * 2.1 + 7.3, 42.), vnoise(q, 43.) + .5 * vnoise(q * 2.1 + 3.7, 44.)) / 1.5 - .5;
  float w = mix(1., 2.2 * (1. - smoothstep(0., .7, y.x)), u_sh);
  y.yz += n * u_k * .1 * w;
  o = vec4(fromYcc(y), 1.);
}`,
  local: `uniform sampler2D u_b; uniform float u_k, u_fl;
void main() {
  vec3 c = at(P()), b = texture(u_b, UV()).rgb; float Y = luma(c), Yb = luma(b);
  o = vec4(c + u_k * (Y - Yb) - u_fl * (Yb - .45), 1.);
}`,

  /* ---------------- compression (display) ---------------- */
  shift: `uniform ivec2 u_d; void main() { o = vec4(px(ivec2(P()) + u_d), 1.); }`,
  toLin: `void main() { o = vec4(lin(px(ivec2(P()))), 1.); }`,
  toSrgb: `void main() { o = vec4(srgb(px(ivec2(P()))), 1.); }`,
  detail: `uniform sampler2D u_o, u_ob; uniform float u_k;
void main() { vec3 c = px(ivec2(P())); vec2 uv = UV(); float hp = luma(texture(u_o, uv).rgb) - luma(texture(u_ob, uv).rgb); o = vec4(c + u_k * hp, 1.); }`,
  posterize: `uniform float u_L, u_lin, u_d;
float bayer(ivec2 i) {
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[(i.y & 3) * 4 + (i.x & 3)]) + .5) / 16. - .5;
}
void main() {
  vec3 c = clamp(at(P()), 0., 1.); if (u_lin > .5) c = lin(c);
  float n = u_d > 1.5 ? rnd(P(), 51.) + rnd(P(), 52.) - 1. : u_d > .5 ? bayer(ivec2(P())) : 0.;
  vec3 q = clamp(floor(c * (u_L - 1.) + .5 + n) / (u_L - 1.), 0., 1.);
  o = vec4(u_lin > .5 ? srgb(q) : q, 1.);
}`,
  mosh: `uniform float u_k, u_mv, u_bs, u_st;
void main() {
  vec2 p = P(), bi = floor(p / u_bs);
  if (vnoise(bi * .18, 61.) > u_k) { o = vec4(at(p), 1.); return; }
  vec2 mv = (vec2(vnoise(bi * .11, 62.), vnoise(bi * .11 + 5.1, 63.)) - .5) * 2. * u_mv * u_st;
  vec2 bc = (bi + .5) * u_bs;
  o = vec4(at(p - mv) + .3 * (at(bc) - at(bc - mv)), 1.);
}`,

  /* ---------------- analog (display) ---------------- */
  vhs: `uniform float u_ls, u_cb, u_cd, u_ring, u_cn;
void main() {
  vec2 p = P(); float sl = max(u_ls, .05), Y = 0., ws = 0.;
  for (int i = -12; i <= 12; i++) { float w = exp(-float(i * i) / (2. * sl * sl)); Y += w * luma(at(p + vec2(float(i), 0.))); ws += w; }
  Y /= ws;
  float Yw = 0.; ws = 0.;
  for (int i = -9; i <= 9; i++) { float w = exp(-float(i * i) / 18.); Yw += w * luma(at(p + vec2(float(i), 0.))); ws += w; }
  Y += u_ring * .8 * (Y - Yw / ws);
  float sc = max(u_cb, .3), st = max(.5, sc * 3. / 20.); vec2 C = vec2(0.); ws = 0.;
  for (int i = -20; i <= 20; i++) {
    float d = float(i) * st, w = exp(-d * d / (2. * sc * sc)); vec2 q = vec2(p.x - u_cd + d, p.y);
    C += w * .5 * (yiq(at(q)).yz + yiq(at(q - vec2(0., 1.))).yz); ws += w;
  }
  C /= ws;
  C += u_cn * .05 * (vec2(vnoise(vec2(p.x / 40., p.y), 71.), vnoise(vec2(p.x / 40., p.y) + 9.1, 72.)) - .5);
  o = vec4(unyiq(vec3(Y, C)), 1.);
}`,
  composite: `uniform float u_rb;
void main() {
  vec2 p = P(); float x = p.x - .5, y = p.y - .5;
  float l0 = luma(at(p - vec2(2., 0.))), l1 = luma(at(p - vec2(1., 0.))), l2 = luma(at(p)), l3 = luma(at(p + vec2(1., 0.))), l4 = luma(at(p + vec2(2., 0.)));
  float hp = l2 - (l0 + l1 + l2 + l3 + l4) / 5., ph = PI * .5 * x + PI * y;
  vec3 q = yiq(at(p));
  q.yz += u_rb * 1.4 * hp * vec2(cos(ph), sin(ph));
  o = vec4(unyiq(q), 1.);
}`,
  tape: `uniform float u_hs, u_tr, u_tp, u_do, u_j;
void main() {
  vec2 p = P(); float H = u_res.y, sc = H / 720., dx = 0.;
  dx += u_j * (vnoise(vec2(3., p.y * .15), 81.) - .5) * 6. * sc;
  float hz = .035 * H, t = (p.y - (H - hz)) / hz;
  if (u_hs > 0. && t > 0.) dx += u_hs * (40. * t * t + 12. * (rnd(vec2(0., p.y), 82.) - .5)) * sc;
  float inb = u_tr * max(0., 1. - abs(p.y - u_tp * H) / (.07 * H));
  dx += inb * (rnd(vec2(0., floor(p.y / 2.)), 83.) - .5) * 60. * sc;
  vec3 c = at(vec2(p.x - dx, p.y));
  float seg = 6. + 20. * rnd(vec2(0., p.y), 84.);
  if (rnd(vec2(floor(p.x / (seg * sc)), p.y), 85.) > 1. - .25 * inb) c = mix(c, vec3(.92), .8);
  if (u_hs > 0. && t > 0.) c = mix(c, vec3(luma(c)), .5 * u_hs * t) + u_hs * t * .1 * (rnd(p, 86.) - .5);
  float sw = 48. * sc;
  if (rnd(vec2(floor(p.x / sw), p.y), 87.) < u_do * .0015) c = mix(c, vec3(1.), .85 * (1. - fract(p.x / sw)));
  o = vec4(c, 1.);
}`,

  /* ---------------- display ---------------- */
  converge: `uniform vec2 u_d; uniform float u_e;
void main() {
  vec2 p = P(), v = p - u_res * .5; float r = length(v) / (.5 * length(u_res));
  vec2 d = u_d + u_e * r * (length(v) > 0. ? normalize(v) : vec2(0.)) * 1.2;
  o = vec4(at(p - d).r, at(p).g, at(p + d).b, 1.);
}`,
  dlp: `uniform float u_k, u_len, u_ang, u_t;
void main() {
  vec2 p = P(), dir = vec2(cos(radians(u_ang)), sin(radians(u_ang))); vec3 add = vec3(0.);
  for (int i = 1; i <= 18; i++) {
    float t = float(i) / 18., h = max(lumaL(lin(at(p - dir * u_len * t))) - u_t, 0.) / (1. - u_t + 1e-3);
    int ch = (i - 1) / 6;
    add += (ch == 0 ? vec3(1., 0., 0.) : ch == 1 ? vec3(0., 1., 0.) : vec3(0., 0., 1.)) * h * (1. - .6 * t);
  }
  o = vec4(srgb(lin(at(p)) + u_k * add / 6.), 1.);
}`,
  smear: `uniform float u_k, u_len, u_od, u_dir;
void main() {
  vec2 p = P(), d = vec2(u_dir, 0.); vec3 c = at(p), s = c; float st = max(1., u_len / 24.);
  for (int i = 1; i <= 36; i++) {
    float o2 = float(i) * st; if (o2 > u_len * 1.5) break;
    s = min(s, mix(c, at(p - d * o2), u_k * exp(-o2 / u_len)));
  }
  vec3 pr = (at(p - d) + at(p - d * 2.) + at(p - d * 3.)) / 3.;
  o = vec4(s + u_od * .8 * (c - pr), 1.);
}`,
  crt: `uniform float u_m, u_type, u_pitch, u_s, u_lh, u_bw;
vec3 triad(float f) { return f < 1. / 3. ? vec3(1., 0., 0.) : f < 2. / 3. ? vec3(0., 1., 0.) : vec3(0., 0., 1.); }
vec3 mask(vec2 p) {
  float x = p.x - .5, y = p.y - .5, pt = u_pitch;
  if (u_type < .5) return triad(fract(x / pt));
  if (u_type < 1.5) { float col = floor(x / pt), yy = y + mod(col, 2.) * pt * 1.5; return mod(yy, pt * 3.) < 1. ? vec3(0.) : triad(fract(x / pt)); }
  if (u_type < 2.5) { float row = floor(y / pt); vec3 m = triad(fract((x + row * pt * .5) / pt)); return fract(y / pt) > .72 ? vec3(0.) : m; }
  vec2 f = fract(vec2(x, y) / pt); return (f.x >= 1. - 1. / pt || f.y >= 1. - 1. / pt) ? vec3(0.) : vec3(1.);
}
void main() {
  vec2 p = P(); vec3 c = lin(at(p));
  float comp = u_type < 2.5 ? 2.7 : 1. / ((1. - 1. / u_pitch) * (1. - 1. / u_pitch));
  vec3 m = mix(vec3(1.), mask(p) * comp, u_m);
  float sg = .22 + .22 * u_bw * sqrt(clamp(lumaL(c), 0., 1.)), f = fract((p.y - .5) / u_lh + .5) - .5;
  float beam = exp(-f * f / (2. * sg * sg)) / (sg * 2.5066);
  o = vec4(srgb(c * m * mix(1., beam, u_s)), 1.);
}`,
};

/* ------------------------------------------------------------------ helpers */
const range = (k, l, min, max, step, d, u, x) => Object.assign({ k, l, min, max, step, d, u: u || '' }, x || {});
const pick = (k, l, o, d, x) => Object.assign({ k, l, o, d }, x || {});
const toggle = (k, l, d, x) => Object.assign({ k, l, b: true, d }, x || {});
const pm = (c, s, v) => v * Math.hypot(s.w, s.h) / 1000;        // ‰ of the diagonal -> pixels
// deterministic random numbers for paths and spot positions
function rng(seed) { let a = (seed * 2654435761) >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const ISO = (v) => String(Math.round(100 * Math.pow(2, v) / 10) * 10 >= 1000 ? Math.round(100 * Math.pow(2, v) / 100) * 100 : Math.round(100 * Math.pow(2, v) / 10) * 10);

/* ------------------------------------------------------------------ camera profiles */
const CAMERAS = {
  neutral: { fwc: 20, read: 2, prnu: 0.5, hot: 0.05, band: 0.05, clip: 1, aa: 0.3, alg: 'edge', wb: 0, tint: 0, sat: 1, con: 0, lnr: 0.3, cnr: 0.6, sharp: 0.5, sharpR: 1.2 },
  phone: { fwc: 5, read: 1.6, prnu: 0.6, hot: 0.03, band: 0.03, clip: 0.7, aa: 0, alg: 'edge', wb: 0, tint: 0, sat: 1.15, con: 0.15, lnr: 0.75, cnr: 0.9, sharp: 1.3, sharpR: 1 },
  phone2012: { fwc: 4, read: 3.5, prnu: 0.9, hot: 0.15, band: 0.12, clip: 0.5, aa: 0, alg: 'mhc', wb: 0.1, tint: 0, sat: 1.05, con: 0.2, lnr: 0.5, cnr: 0.75, sharp: 1.1, sharpR: 1.4 },
  compact: { fwc: 9, read: 7, prnu: 1, hot: 0.3, band: 0.2, clip: 0.3, aa: 0.4, alg: 'bilinear', wb: 0.05, tint: 0, sat: 1.3, con: 0.35, lnr: 0.35, cnr: 0.55, sharp: 1, sharpR: 1.6 },
  dslr: { fwc: 45, read: 3, prnu: 0.4, hot: 0.05, band: 0.05, clip: 1, aa: 0.5, alg: 'edge', wb: 0, tint: 0, sat: 1.05, con: 0.1, lnr: 0.2, cnr: 0.5, sharp: 0.6, sharpR: 1 },
  webcam: { fwc: 3, read: 6, prnu: 1.5, hot: 0.4, band: 0.4, clip: 0.3, aa: 0, alg: 'bilinear', wb: -0.15, tint: 0.1, sat: 0.9, con: 0.25, lnr: 0.55, cnr: 0.8, sharp: 1.6, sharpR: 1.6 },
};
// sharing destinations (approximate: platforms change their processing)
const PLATFORMS = {
  instagram: { long: 1080, q: 78, sub: '420', psharp: 0.35 },
  whatsapp: { long: 1600, q: 70, sub: '420', psharp: 0.2 },
  facebook: { long: 2048, q: 80, sub: '420', psharp: 0.3 },
  x: { long: 4096, q: 85, sub: '420', psharp: 0 },
  messages: { long: 1280, q: 75, sub: '420', psharp: 0.2 },
};

/* ------------------------------------------------------------------ effects */
const EFFECTS = [
  /* ---------------- lens */
  { id: 'light', group: 'lens', name: 'Highlight recovery', domain: 'scene', defOn: true, meter: false,
    info: 'Rebuilds blown highlights as real light, so glow, flare, fringing and halation appear only around genuinely bright things. Changes nothing on its own.',
    params: [range('stops', 'Headroom', 0, 6, 0.1, 3, 'EV', { real: [1, 4] }), range('knee', 'Starts at', 0.75, 0.98, 0.01, 0.9, '', { adv: true })],
    run: (c, s) => s },
  { id: 'ca', group: 'lens', name: 'Chromatic aberration', domain: 'scene',
    info: 'Colour channels land at slightly different sizes, so fringes appear toward the corners. Detail stays sharp.',
    params: [range('amount', 'Corner shift', 0, 2, 0.01, 0.3, '‰', { real: [0.05, 0.8], amt: true }),
      pick('type', 'Lens type', [['typical', 'Typical (blue-led)'], ['simple', 'Simple lens (red / blue)'], ['apo', 'Corrected (green / magenta)']], 'typical'),
      range('spread', 'Colour spread', 0, 1, 0.01, 0.5, '', { adv: true }), range('off', 'Decentring', 0, 1, 0.01, 0.15, '', { adv: true })],
    run(c, s, p) {
      const ch = { typical: [0.35, 0, -1], simple: [1, 0, -1], apo: [0.7, 0, 0.7] }[p.type];
      return c.pass(S.ca, s, { u_amt: pm(c, s, p.amount), u_sp: p.spread, u_ch: ch, u_ctr: [0.03 * p.off * s.w, -0.02 * p.off * s.h] });
    } },
  { id: 'loca', group: 'lens', name: 'Out-of-focus fringes', domain: 'scene',
    info: 'Purple edges in front of the focus point, green behind it, on blurry edges. Shows mainly where a photo has out-of-focus areas.',
    params: [range('amount', 'Amount', 0, 1, 0.01, 0.55, '', { real: [0, 0.7], amt: true }), range('width', 'Width', 0.3, 4, 0.05, 1.2, '‰', { real: [0.3, 2.5] }),
      pick('side', 'Colour', [['depth', 'By depth (top far, bottom near)'], ['front', 'Purple (in front)'], ['behind', 'Green (behind)']], 'depth'),
      range('sharp', 'On sharp edges too', 0, 1, 0.01, 0.04, '', { adv: true, real: [0, 0.2] })],
    run(c, s, p) {
      const w = Math.max(1, pm(c, s, p.width)), a = c.pass(S.sq, s), r = Math.ceil(1.5 * w) + 1;
      const g = c.pass(S.maxf, c.pass(S.maxf, c.pass(S.grad, a), { u_dir: { i: [1, 0] }, u_r: { i: r } }), { u_dir: { i: [0, 1] }, u_r: { i: r } });
      return c.pass(S.loca, s, { u_amt: p.amount, u_w: w, u_mode: { depth: 0, front: 1, behind: 2 }[p.side], u_sharp: p.sharp },
        { tex: { u_g: g, u_b: c.blur(a, w), u_f: c.blur(s, w) } });
    } },
  { id: 'pf', group: 'lens', name: 'Purple fringing', domain: 'scene',
    info: 'A violet haze on the dark side of blown highlights (branches against sky, window frames), wider toward the corners.',
    params: [range('amount', 'Amount', 0, 1, 0.01, 0.4, '', { real: [0, 0.65], amt: true }), range('width', 'Width', 0.3, 5, 0.05, 1.3, '‰', { real: [0.3, 2.5] }),
      range('thr', 'Highlight level', 0.5, 4, 0.05, 1, '', { adv: true })],
    run(c, s, p) {
      const w = Math.max(0.8, pm(c, s, p.width)), m = c.pass(S.pfMask, s, { u_t: p.thr });
      return c.pass(S.pf, s, { u_amt: p.amount }, { tex: { u_m: m, u_b1: c.blur(m, w), u_b2: c.blur(m, w * 2.2) } });
    } },
  { id: 'coma', group: 'lens', name: 'Coma', domain: 'scene',
    info: 'Points of light near the corners spread outward into comet / seagull shapes. Only bright light spreads, so detail stays sharp.',
    params: [range('amount', 'Amount', 0, 1, 0.01, 0.5, '', { real: [0, 0.6], amt: true }), range('len', 'Tail length', 0.5, 15, 0.1, 5.5, '‰', { real: [1, 8] }),
      range('wing', 'Wing spread', 0, 1, 0.01, 0.5, '', { adv: true }), range('thr', 'Light level', 0.3, 3, 0.05, 0.85, '', { adv: true })],
    run(c, s, p) { return c.pass(S.coma, s, { u_k: p.amount, u_len: pm(c, s, p.len), u_w: p.wing, u_t: p.thr }); } },
  { id: 'glare', group: 'lens', name: 'Glare & ghosts', domain: 'scene',
    info: 'Scattered light lifts the shadows (veiling glare) and bright lights leave coloured ghost reflections mirrored across the frame.',
    params: [range('veil', 'Veiling glare', 0, 0.12, 0.001, 0.012, '', { real: [0, 0.04], amt: true }), range('ghosts', 'Ghosts', 0, 1, 0.01, 0.25, '', { real: [0, 0.5], amt: true }),
      range('count', 'Ghost count', 0, 6, 1, 4, '', { adv: true })],
    run(c, s, p) {
      const dg = Math.hypot(s.w, s.h), m = c.pass(S.over, s, { u_t: Math.max(1, 0.6 * c.hr) });
      const v = c.blur(s, 0.12 * dg);
      return c.pass(S.glare, s, { u_gl: p.veil, u_gh: p.ghosts, u_n: { i: Math.round(p.count) } }, { tex: { u_v: v, u_g1: c.blur(m, 0.006 * dg), u_g2: c.blur(m, 0.02 * dg) } });
    } },
  { id: 'halation', group: 'lens', name: 'Halation', domain: 'scene',
    info: 'Film: light bounces off the film base back into the red layer, leaving a red-orange glow around bright light only.',
    params: [range('amount', 'Amount', 0, 2, 0.01, 0.6, '', { real: [0, 1.2], amt: true }), range('radius', 'Radius', 0.5, 10, 0.1, 2, '‰', { real: [0.8, 5] }),
      range('thr', 'Light level', 0.4, 4, 0.05, 0.9, '', { adv: true })],
    run(c, s, p) { const m = c.pass(S.halaMask, s, { u_t: p.thr, u_n: 1 }); return c.pass(S.halaAdd, s, { u_k: p.amount }, { tex: { u_b: c.blur(m, pm(c, s, p.radius)) } }); } },
  { id: 'vignette', group: 'lens', name: 'Vignetting', domain: 'scene',
    info: 'Light falls off toward the corners, measured in stops at the corner.',
    params: [range('stops', 'Corner falloff', 0, 3, 0.05, 0.6, 'EV', { real: [0, 1.5], amt: true }), range('falloff', 'Starts early', 0, 1, 0.01, 0.5)],
    run(c, s, p) { return c.pass(S.vig, s, { u_st: p.stops, u_a: 0.55 - 0.5 * p.falloff }); } },
  { id: 'cast', group: 'lens', name: 'Colour shading', domain: 'scene',
    info: 'A magenta or green tint creeping in from the edges, from light hitting the sensor at steep angles (wide-angle lenses).',
    params: [range('amount', 'Amount', 0, 1, 0.01, 0.4, '', { real: [0, 0.5], amt: true }), range('tint', 'Green ↔ magenta', -1, 1, 0.01, 0.6), range('off', 'Off-centre', -1, 1, 0.01, 0.2, '', { adv: true })],
    run(c, s, p) { return c.pass(S.cast, s, { u_k: p.amount, u_t: p.tint, u_off: p.off }); } },
  { id: 'soft', group: 'lens', name: 'Corner softness', domain: 'scene',
    info: 'The plane of focus is curved, so the corners drift slightly out of focus while the centre stays sharp.',
    params: [range('amount', 'Amount', 0, 1, 0.01, 0.5, '', { real: [0, 0.6], amt: true }), range('blur', 'Blur', 0.1, 3, 0.05, 0.6, '‰', { real: [0.1, 1.2] }),
      range('start', 'Sharp zone', 0, 0.9, 0.01, 0.4, '', { adv: true })],
    run(c, s, p) { const b = pm(c, s, p.blur); return c.pass(S.soft, s, { u_k: p.amount, u_s: p.start }, { tex: { u_b: c.blur(s, b * 0.45), u_c: c.blur(s, b) } }); } },
  { id: 'distort', group: 'lens', name: 'Distortion', domain: 'scene',
    info: 'Barrel (negative) or pincushion (positive) bowing of straight lines. The frame is zoomed just enough to stay filled.',
    params: [range('amount', 'Amount', -8, 8, 0.1, -1.5, '%', { real: [-4, 3], amt: true }), range('wave', 'Wave (mustache)', 0, 1, 0.01, 0, '', { adv: true })],
    run(c, s, p) {
      const k1 = -p.amount / 100, k2 = -p.wave * 1.6 * k1, Rh = Math.hypot(s.w, s.h) / 2;
      let z = Infinity;
      for (let i = 0; i <= 64; i++) {              // keep every border point inside the frame
        const t = i / 64;
        for (const [x, y] of [[t * s.w, 0], [t * s.w, s.h], [0, t * s.h], [s.w, t * s.h]]) {
          const rd = Math.hypot(x - s.w / 2, y - s.h / 2) / Rh, f = 1 + k1 * rd * rd + k2 * rd ** 4;
          if (f > 0) z = Math.min(z, 1 / f);
        }
      }
      return c.pass(S.distort, s, { u_k1: k1, u_k2: k2, u_z: Number.isFinite(z) ? z : 1 });
    } },
  { id: 'shake', group: 'lens', name: 'Camera shake', domain: 'scene',
    info: 'A hand-held shake path during the exposure: lights become short squiggles, detail doubles slightly.',
    params: [range('len', 'Length', 0, 15, 0.1, 2, '‰', { real: [0, 6], amt: true }), range('angle', 'Direction', 0, 180, 1, 20, '°'),
      range('wobble', 'Wobble', 0, 1, 0.01, 0.5, '', { adv: true })],
    run(c, s, p) {
      const L = pm(c, s, p.len); if (L < 0.3) return s;
      const r = rng(c.seed * 31 + 7), pts = []; let x = 0, y = 0, a = p.angle * Math.PI / 180;
      for (let i = 0; i < 24; i++) { pts.push([x, y]); a += p.wobble * 1.2 * (r() - 0.5); x += Math.cos(a); y += Math.sin(a); }
      const mx = pts.reduce((q, v) => q + v[0], 0) / 24, my = pts.reduce((q, v) => q + v[1], 0) / 24;
      const span = Math.max(1e-6, Math.hypot(pts[23][0] - pts[0][0], pts[23][1] - pts[0][1]));
      return c.pass(S.path, s, { u_path: { v2: new Float32Array(pts.flatMap(([u, v]) => [(u - mx) * L / span, (v - my) * L / span])) } });
    } },
  { id: 'focus', group: 'lens', name: 'Missed focus', domain: 'scene',
    info: 'The whole frame slightly out of focus, through a round aperture: lights turn into soft discs.',
    params: [range('amount', 'Blur', 0, 8, 0.05, 0.8, '‰', { real: [0, 3], amt: true })],
    run(c, s, p) { const R = pm(c, s, p.amount); return R < 0.5 ? s : c.pass(S.disc, c.blur(s, R * 0.08), { u_r: R }); } },

  /* ---------------- sensor & camera */
  { id: 'dust', group: 'sensor', name: 'Sensor dust', domain: 'scene',
    info: 'Soft dark spots from dust on the sensor, most visible on plain bright areas like sky.',
    params: [range('count', 'Spots', 0, 20, 1, 5, '', { real: [0, 8] }), range('size', 'Size', 2, 20, 0.5, 6, '‰'), range('strength', 'Strength', 0, 1, 0.01, 0.2, '', { real: [0, 0.35], amt: true })],
    run(c, s, p) {
      const r = rng(c.seed * 17 + 3), n = Math.round(p.count), d = new Float32Array(60), st = new Float32Array(20);
      for (let i = 0; i < n; i++) { d[i * 3] = r() * s.w; d[i * 3 + 1] = r() * s.h; d[i * 3 + 2] = pm(c, s, p.size) * (0.5 + r()); st[i] = p.strength * (0.4 + 0.6 * r()); }
      return c.pass(S.dust, s, { u_d: { v3: d }, u_s: st, u_n: { i: n } });
    } },
  { id: 'rolling', group: 'sensor', name: 'Rolling shutter', domain: 'scene',
    info: 'Rows are read top to bottom: skew and jello wobble from movement, and dark bands under flickering LED / fluorescent light.',
    params: [range('skew', 'Skew', -80, 80, 0.5, 12, '‰', { real: [-30, 30], amt: true }), range('wobble', 'Wobble', 0, 10, 0.05, 0, '‰', { real: [0, 3], amt: true }),
      range('wfreq', 'Wobble rate', 0.5, 30, 0.1, 6, '', { adv: true }), range('flicker', 'Flicker bands', 0, 1, 0.01, 0, '', { real: [0, 0.4], amt: true }),
      range('period', 'Band spacing', 5, 200, 1, 40, '‰', { adv: true })],
    run(c, s, p) { return c.pass(S.rolling, s, { u_skew: pm(c, s, p.skew), u_wob: pm(c, s, p.wobble), u_wf: p.wfreq, u_fl: p.flicker, u_fp: Math.max(3, pm(c, s, p.period)) }); } },
  { id: 'ccd', group: 'sensor', name: 'CCD smear & blooming', domain: 'scene',
    info: 'Older CCD sensors: very bright light bleeds a vertical streak through the whole frame and spills up and down.',
    params: [range('smear', 'Smear', 0, 1, 0.01, 0.2, '', { real: [0, 0.5], amt: true }), range('bloom', 'Blooming', 0, 1, 0.01, 0.4, '', { real: [0, 0.6], amt: true }),
      range('len', 'Bloom length', 1, 40, 0.5, 5, '‰', { adv: true }), range('thr', 'Only the brightest', 0.3, 0.95, 0.01, 0.7, '', { adv: true })],
    run(c, s, p) {
      // only light near the top of the rebuilt range (real over-exposure, not white paper) smears
      const m = c.pass(S.halaMask, s, { u_t: Math.max(1, p.thr * c.hr), u_n: c.hr }), cols = c.pass(S.ccdCols, m, {}, { w: m.w, h: 1 });
      return c.pass(S.ccdAdd, s, { u_sm: p.smear, u_bo: p.bloom }, { tex: { u_cs: cols, u_bl: c.blur(m, pm(c, s, p.len), 'y') } });
    } },
  { id: 'camera', group: 'sensor', name: 'Camera', domain: 'scene', out: 'display',
    info: 'A simulated camera: Bayer sensor with real photon and read noise set by ISO, then demosaicing, colour, tone, noise reduction and sharpening.',
    sets: { k: 'profile', from: CAMERAS },
    params: [
      pick('profile', 'Camera', [['neutral', 'Neutral'], ['phone', 'Modern phone'], ['phone2012', '2012 phone'], ['compact', '2005 compact (CCD)'], ['dslr', 'DSLR / mirrorless'], ['webcam', 'Webcam']], 'neutral'),
      range('iso', 'ISO', -1, 9, 1 / 3, 2, '', { real: [-1, 6], show: ISO, parse: (t) => Math.log2(t / 100) }),
      range('ev', 'Exposure', -3, 3, 0.05, 0, 'EV', { real: [-1.5, 1.5] }),
      range('fwc', 'Full-well', 1, 80, 0.5, 20, 'ke⁻', { adv: true, real: [1.5, 60] }),
      range('read', 'Read noise', 0.5, 20, 0.1, 2, 'e⁻', { adv: true, real: [1, 8] }),
      range('prnu', 'Pixel gain spread', 0, 3, 0.05, 0.5, '%', { adv: true, real: [0, 1.5] }),
      range('hot', 'Hot pixels', 0, 1, 0.01, 0.05, '', { adv: true, real: [0, 0.4] }),
      range('band', 'Row banding', 0, 1, 0.01, 0.05, '', { adv: true, real: [0, 0.4] }),
      range('clip', 'Highlight capacity', 0, 4, 0.05, 1, 'EV', { adv: true }),
      range('aa', 'Anti-alias filter', 0, 1, 0.01, 0.3, '', { adv: true }),
      pick('alg', 'Demosaic', [['edge', 'Edge-directed'], ['mhc', 'Malvar-He-Cutler'], ['bilinear', 'Bilinear (old / cheap)']], 'edge', { adv: true }),
      range('wb', 'White balance', -1, 1, 0.01, 0, '', { adv: true, real: [-0.4, 0.4] }),
      range('tint', 'Tint', -1, 1, 0.01, 0, '', { adv: true, real: [-0.3, 0.3] }),
      range('sat', 'Saturation', 0, 2, 0.01, 1, '×', { adv: true, real: [0.8, 1.4] }),
      range('con', 'Contrast', -1, 1, 0.01, 0, '', { adv: true, real: [-0.4, 0.6] }),
      range('lnr', 'Luma NR', 0, 1, 0.01, 0.3, '', { adv: true }),
      range('cnr', 'Chroma NR', 0, 1, 0.01, 0.6, '', { adv: true }),
      range('sharp', 'Sharpening', 0, 3, 0.01, 0.5, '', { adv: true, real: [0, 1.6] }),
      range('sharpR', 'Sharpen radius', 0.5, 3, 0.05, 1.2, 'px', { adv: true }),
    ],
    run(c, s, p) {
      const isoF = Math.pow(2, p.iso), Se = p.fwc * 1000 / isoF, clip = Math.pow(2, p.clip);
      let x = p.aa > 0.02 ? c.blur(s, 0.25 + 0.45 * p.aa) : s;
      x = c.pass(S.camMosaic, x, { u_gain: Math.pow(2, p.ev) / clip, u_S: Se, u_read: p.read, u_prnu: p.prnu / 100,
        u_hot: p.hot * 2e-4 * Math.sqrt(isoF), u_band: p.band, u_k: c.k });
      const alg = { bilinear: 0, mhc: 1, edge: 2 }[p.alg];
      x = c.pass(S.camRB, c.pass(S.camGreen, x, { u_alg: { i: alg } }), { u_alg: { i: alg } });
      x = c.pass(S.camISP, x, { u_back: clip, u_hrT: Math.max(1, Math.min(c.hr, clip)), u_knee: c.knee, u_wb: p.wb, u_tint: p.tint, u_sat: p.sat, u_con: p.con });
      // noise reduction tuned to the noise this sensor makes at mid grey
      const e = 0.11 * Se, nl = c.k * Math.sqrt(e + p.read * p.read) / e;
      if (p.lnr > 0) x = c.pass(S.camLNR, x, { u_sr: 0.003 + 0.22 * nl * (0.8 + 1.4 * p.lnr), u_k: p.lnr });
      if (p.cnr > 0) x = c.pass(S.camCNR, x, { u_k: p.cnr }, { tex: { u_b: c.blur(x, 0.6 + 3 * p.cnr) } });
      return c.unsharp(x, p.sharp * Math.min(1.5, c.k), p.sharpR);
    } },

  /* ---------------- processing */
  { id: 'regrain', group: 'proc', name: 'Re-grain',
    info: 'Strong noise reduction, then the photo’s own grain and detail added back in measured amounts: crisp and clean, with grain that looks like the camera’s. Clean photos get a matched grain.',
    params: [range('smooth', 'Smoothing', 0, 1, 0.01, 0.6, '', { real: [0.2, 0.9] }),
      range('detail', 'Detail back', 0, 1.5, 0.01, 1, '', { real: [0.6, 1.2] }),
      range('grain', 'Grain back', 0, 1.5, 0.01, 0.45, '', { real: [0, 1], amt: true }),
      pick('colour', 'Grain colour', [['luma', 'Brightness only (film-like)'], ['full', 'With colour']], 'luma'),
      range('size', 'Grain size', 1, 3, 0.05, 1.3, '×', { real: [1, 2] }),
      range('shadows', 'Shadow bias', 0, 1, 0.01, 0.5),
      pick('pattern', 'Pattern', [['own', 'The photo’s own'], ['fresh', 'Fresh, matched to it']], 'own'),
      range('floor', 'Grain if clean', 0, 1, 0.01, 0.2, '', { adv: true, real: [0, 0.6] }),
      range('edge', 'Edge sensitivity', 0, 1, 0.01, 0.3, '', { adv: true }),
      toggle('deblock', 'Leave JPEG blocks out of the grain', true, { adv: true })],
    run(c, s, p) {
      const r = Math.min(5, 2 + Math.round(4 * p.smooth)), sr = 0.012 + 0.13 * p.smooth;
      let base = c.pass(S.gtBase, s, { u_r: { i: r }, u_sr: sr }, { tex: { u_c: c.blur(s, 1 + 3 * p.smooth) } });
      for (const k of [0.8, 0.65]) base = c.pass(S.gtBase, base, { u_r: { i: r }, u_sr: sr * k }, { tex: { u_c: base } });
      const R = c.pass(S.gtRes, s, { u_db: p.deblock }, { tex: { u_b: base }, fmt: 'f32' });
      const Q = c.pass(S.gtSq, R, {}, { fmt: 'f32' });
      const V = c.blur(Q, 3);
      // noise-vs-brightness curve: in 16 brightness bins, the quieter quarter of cells is taken as pure noise
      const cell = Math.min(16, Math.max(4, Math.round(Math.min(s.w, s.h) / 150)));
      const cs = c.read(c.pass(S.cellStats, V, { u_f: { i: cell } }, { w: Math.ceil(s.w / cell), h: Math.ceil(s.h / cell), fmt: 'f32', tex: { u_b: base } }));
      const bins = Array.from({ length: 16 }, () => [[], []]);
      for (let k = 0; k < cs.length; k += 4) { const b = bins[Math.min(15, Math.max(0, Math.round(cs[k + 2] * 15)))]; b[0].push(cs[k]); b[1].push(cs[k + 1]); }
      const pct = (a) => { a.sort((x, y) => x - y); return a[Math.floor(a.length * 0.25)]; };
      const ny = new Float32Array(16).fill(-1), nc = new Float32Array(16).fill(-1);
      bins.forEach((b, k) => { if (b[0].length >= 6) { ny[k] = pct(b[0]); nc[k] = pct(b[1]); } });
      for (const a of [ny, nc]) {                 // fill brightness levels the photo doesn't have from their neighbours
        const have = [...a.keys()].filter(k => a[k] >= 0);
        for (let k = 0; k < 16; k++) if (a[k] < 0) {
          if (!have.length) { a[k] = 0; continue; }
          const lo = have.filter(h => h < k).pop(), hi = have.find(h => h > k);
          a[k] = lo === undefined ? a[hi] : hi === undefined ? a[lo] : a[lo] + (a[hi] - a[lo]) * (k - lo) / (hi - lo);
        }
      }
      let G = R, Vg = V;
      if (p.size > 1.02) { G = c.blur(R, 0.6 * (p.size - 1)); Vg = c.blur(c.pass(S.gtSq, G, {}, { fmt: 'f32' }), 3); }
      let N = c.pass(S.gtNoise, s, {}, { fmt: 'f32' });
      N = c.blur(N, 0.45 + 0.35 * (p.size - 1));
      const Vn = c.blur(c.pass(S.gtSq, N, {}, { fmt: 'f32' }), 3);
      return c.pass(S.gtMix, base, { u_det: p.detail, u_gr: p.grain, u_luma: p.colour === 'luma', u_sh: p.shadows, u_fresh: p.pattern === 'fresh',
        u_floor: p.floor, u_es: p.edge, u_ny: ny, u_nc: nc }, { tex: { u_r: R, u_v: V, u_g: G, u_vg: Vg, u_n: N, u_vn: Vn } });
    } },
  { id: 'ghost', group: 'proc', name: 'HDR ghosting',
    info: 'A multi-frame merge leaves a semi-transparent duplicate, whole or in patchy de-ghosting seams.',
    params: [range('opacity', 'Opacity', 0, 1, 0.01, 0.3, '', { real: [0, 0.5], amt: true }), range('dx', 'Offset X', -40, 40, 0.1, 5, '‰'), range('dy', 'Offset Y', -40, 40, 0.1, 1, '‰'),
      pick('mode', 'Shape', [['patchy', 'Patchy seams'], ['whole', 'Whole frame']], 'patchy')],
    run(c, s, p) { return c.pass(S.ghost, s, { u_k: p.opacity, u_dx: pm(c, s, p.dx), u_dy: pm(c, s, p.dy), u_patch: p.mode === 'patchy' }); } },
  { id: 'profile', group: 'proc', name: 'Lens-profile correction',
    info: 'Barrel distortion corrected in software: lines stay straight, but stretched corners go soft and a colour fringe can remain.',
    params: [range('amount', 'Correction', 0, 0.3, 0.005, 0.12, '', { real: [0, 0.2], amt: true }), pick('interp', 'Resampling', [['linear', 'Bilinear'], ['nearest', 'Nearest']], 'linear'),
      range('resid', 'Residual CA', -1, 1, 0.01, 0)],
    run(c, s, p) {
      if (!(p.amount > 0) && !p.resid) return s;
      return c.pass(S.lensOut, c.pass(S.lensIn, s, { u_k: p.amount }), { u_k: p.amount, u_near: p.interp === 'nearest', u_ca: p.resid });
    } },
  { id: 'nr', group: 'proc', name: 'Noise-reduction smear',
    info: 'Heavy edge-preserving noise reduction wipes fine texture into flat, waxy "watercolour" patches.',
    params: [range('strength', 'Strength', 0, 1, 0.01, 0.5, '', { real: [0, 0.8], amt: true }), range('radius', 'Radius', 1, 6, 1, 3, 'px'), range('passes', 'Passes', 1, 4, 1, 2)],
    run(c, s, p) { let t = s; for (let i = 0; i < p.passes; i++) t = c.pass(S.bilateral, t, { u_r: { i: Math.round(p.radius) }, u_sr: 0.015 + 0.2 * p.strength }); return t; } },
  { id: 'blotch', group: 'proc', name: 'Chroma blotches',
    info: 'Colour noise averaged by chroma NR into soft colour stains, worst in the shadows.',
    params: [range('amount', 'Amount', 0, 1, 0.01, 0.4, '', { real: [0, 0.6], amt: true }), range('size', 'Blotch size', 4, 80, 1, 18, 'px'), range('shadows', 'Shadow bias', 0, 1, 0.01, 0.7)],
    run(c, s, p) { return c.pass(S.blotch, s, { u_k: p.amount, u_sz: p.size, u_sh: p.shadows }); } },
  { id: 'local', group: 'proc', name: 'Tone-mapping halos',
    info: 'HDR-style local contrast: glowing borders around dark objects against bright skies.',
    params: [range('amount', 'Local contrast', 0, 2, 0.01, 0.6, '', { real: [0, 1.2], amt: true }), range('radius', 'Radius', 1, 20, 0.1, 6, '%'), range('flatten', 'Flatten', 0, 1, 0.01, 0.3)],
    run(c, s, p) { return c.pass(S.local, s, { u_k: p.amount, u_fl: p.flatten }, { tex: { u_b: c.blur(s, p.radius / 100 * Math.min(s.w, s.h)) } }); } },
  { id: 'sharpen', group: 'proc', name: 'Over-sharpening',
    info: 'Unsharp mask pushed too far: bright and dark outlines along every edge.',
    params: [range('amount', 'Amount', 0, 4, 0.01, 1.2, '', { real: [0, 2], amt: true }), range('radius', 'Radius', 0.4, 4, 0.05, 1.4, 'px')],
    run(c, s, p) { return c.unsharp(s, p.amount, p.radius); } },

  /* ---------------- compression & sharing */
  { id: 'reshare', group: 'comp', name: 'Re-share',
    info: 'What happens when a photo is posted and passed on: shrunk, sharpened, rounded to 8 bits, JPEG-compressed at the small size, then enlarged by the viewer.',
    sets: { k: 'dest', from: PLATFORMS },
    params: [
      pick('dest', 'Like', [['custom', 'Custom'], ['instagram', 'Instagram ≈'], ['whatsapp', 'WhatsApp ≈'], ['facebook', 'Facebook ≈'], ['x', 'X ≈'], ['messages', 'Messages ≈']], 'custom'),
      range('long', 'Shared size', 240, 4096, 8, 1600, 'px', { real: [720, 2048] }),
      pick('down', 'Shrink with', [['bicubic', 'Bicubic'], ['sharper', 'Bicubic sharper'], ['lanczos3', 'Lanczos (ringing)'], ['area', 'Area average (clean)'],
        ['cheap', 'Cheap, no anti-alias (jaggies)'], ['halve', 'Repeated halving'], ['nearest', 'Nearest']], 'bicubic'),
      range('psharp', 'Platform sharpening', 0, 1.5, 0.01, 0.3, '', { real: [0, 0.8] }),
      range('q', 'JPEG quality', 30, 100, 1, 80, '', { real: [60, 92] }),
      pick('sub', 'Colour', [['420', '4:2:0'], ['422', '4:2:2'], ['444', '4:4:4']], '420'),
      pick('up', 'Viewed', [['bicubic', 'Enlarged, bicubic'], ['lanczos3', 'Enlarged, Lanczos'], ['bilinear', 'Enlarged, bilinear (soft)'], ['zoom', 'Phone digital zoom'],
        ['nearest', 'Enlarged, nearest'], ['keep', 'At shared size (smaller file)']], 'bicubic'),
      range('detail', 'Keep detail', 0, 1, 0.01, 0.35, '', { real: [0, 0.6] }),
      range('gens', 'Times re-shared', 1, 6, 1, 1),
      range('vsharp', 'Viewer sharpening', 0, 1.5, 0.01, 0.15, '', { adv: true }),
      toggle('offset', 'Half-pixel offset errors', false, { adv: true }),
      toggle('linear', 'Resize in linear light (correct)', false, { adv: true }),
    ],
    run(c, s, p) {
      const r = rng(c.seed * 13 + 5), L0 = Math.max(s.w, s.h);
      let x = s;
      for (let g = 0; g < p.gens; g++) {
        const L = Math.min(Math.max(x.w, x.h), Math.round(p.long * (g === p.gens - 1 ? 1 : 0.85 + 0.3 * r())));
        const k = L / Math.max(x.w, x.h), sw = Math.max(1, Math.round(x.w * k)), sh = Math.max(1, Math.round(x.h * k));
        let t = p.linear ? c.pass(S.toLin, x) : x;
        const m = p.down === 'sharper' ? 'bicubic' : p.down;
        t = c.resize(t, sw, sh, m, { off: p.offset ? 0.5 : 0 });
        if (p.linear) t = c.pass(S.toSrgb, t);
        if (p.down === 'sharper') t = c.unsharp(t, 0.5, 0.7);
        t = c.unsharp(t, p.psharp, 0.7);
        t = c.jpegSim(c.q8(t), p.q, p.sub, false);
        const last = g === p.gens - 1;
        if (p.up === 'keep') { x = t; continue; }
        if (!last) { x = c.resize(t, s.w, s.h, 'bicubic', { off: p.offset ? -0.25 : 0 }); continue; }
        const um = p.up === 'zoom' ? 'bicubic' : p.up;
        x = c.resize(t, s.w, s.h, um, { off: p.offset ? -0.25 : 0 });
        const f = L0 / Math.max(sw, sh);
        if (p.up === 'zoom') { x = c.unsharp(c.pass(S.bilateral, x, { u_r: { i: 2 }, u_sr: 0.05 }), 1.4, 0.6 * f); }
        if (p.detail > 0 && f > 1.05) x = c.pass(S.detail, x, { u_k: p.detail }, { tex: { u_o: s, u_ob: c.blur(s, 0.45 * f) } });
        x = c.unsharp(x, p.vsharp, 1);
      }
      return x;
    } },
  { id: 'jpeg', group: 'comp', name: 'JPEG compression',
    info: 'A real JPEG encode and decode (8×8 DCT, quantisation, chroma subsampling). Generations re-save it again and again.',
    params: [range('q', 'Quality', 1, 100, 1, 55, '', { real: [50, 95] }), pick('sub', 'Colour', [['420', '4:2:0'], ['422', '4:2:2'], ['444', '4:4:4']], '420'),
      range('gens', 'Generations', 1, 20, 1, 1), toggle('shift', 'Re-crop between saves', true, { adv: true })],
    run(c, s, p) {
      let t = s;
      for (let g = 0; g < p.gens; g++) {
        const d = p.shift && g > 0 ? [(g * 3) % 8, (g * 5) % 8] : [0, 0];
        if (d[0] || d[1]) t = c.pass(S.shift, t, { u_d: { i: d } });
        t = c.jpegSim(t, p.q, p.sub, false);
        if (d[0] || d[1]) t = c.pass(S.shift, t, { u_d: { i: [-d[0], -d[1]] } });
      }
      return t;
    } },
  { id: 'posterize', group: 'comp', name: 'Banding / posterize',
    info: 'Too few bits per channel: smooth gradients break into visible steps. Dithering trades steps for pattern.',
    params: [range('bits', 'Bits per channel', 1, 8, 1, 5, 'bit', { real: [4, 8] }), pick('space', 'Quantise in', [['gamma', 'Gamma (sRGB)'], ['linear', 'Linear (crushed shadows)']], 'gamma'),
      pick('dither', 'Dither', [['none', 'None'], ['ordered', 'Ordered (Bayer 4×4)'], ['noise', 'Noise']], 'none')],
    run(c, s, p) { return c.pass(S.posterize, s, { u_L: Math.pow(2, p.bits), u_lin: p.space === 'linear', u_d: { none: 0, ordered: 1, noise: 2 }[p.dither] }); } },
  { id: 'mosh', group: 'comp', name: 'Datamosh',
    info: 'Motion vectors applied to the wrong picture: macroblocks slide and drag old colour with them.',
    params: [range('amount', 'Coverage', 0, 1, 0.01, 0.3, '', { real: [0, 0.5], amt: true }), range('motion', 'Motion', 0, 120, 0.5, 30, 'px'),
      pick('block', 'Macroblock', [['8', '8 px'], ['16', '16 px'], ['32', '32 px']], '16'), range('steps', 'Frames carried', 1, 8, 1, 3)],
    run(c, s, p) { return c.pass(S.mosh, s, { u_k: p.amount, u_mv: p.motion, u_bs: +p.block, u_st: p.steps }); } },

  /* ---------------- analog video */
  { id: 'vhs', group: 'analog', name: 'VHS colour',
    info: 'Soft luma, colour smeared sideways and arriving late, an edge-enhancer ring and streaky chroma noise.',
    params: [range('luma', 'Luma softness', 0, 4, 0.05, 1.2, 'px', { real: [0.6, 2] }), range('bleed', 'Chroma bleed', 0, 30, 0.1, 10, 'px', { real: [4, 16], amt: true }),
      range('delay', 'Chroma delay', -10, 20, 0.1, 4, 'px', { real: [1, 8] }), range('ring', 'Edge ring', 0, 2, 0.01, 0.5, '', { real: [0, 1] }), range('cnoise', 'Chroma noise', 0, 1, 0.01, 0.3, '', { real: [0, 0.5] })],
    run(c, s, p) { return c.pass(S.vhs, s, { u_ls: p.luma, u_cb: p.bleed, u_cd: p.delay, u_ring: p.ring, u_cn: p.cnoise }); } },
  { id: 'composite', group: 'analog', name: 'Composite rainbowing',
    info: 'Fine stripes and textures decoded as false rainbow colour, as on composite video.',
    params: [range('rainbow', 'Rainbowing', 0, 2, 0.01, 0.8, '', { real: [0, 1.2], amt: true })],
    run(c, s, p) { return c.pass(S.composite, s, { u_rb: p.rainbow }); } },
  { id: 'tape', group: 'analog', name: 'Tape damage',
    info: 'Head-switching tear at the bottom, a tracking-noise band, timebase jitter and oxide dropouts.',
    params: [range('head', 'Head switching', 0, 1, 0.01, 0.5, '', { real: [0, 1] }), range('tracking', 'Tracking noise', 0, 1, 0.01, 0, '', { real: [0, 0.6] }),
      range('pos', 'Tracking position', 0, 1, 0.01, 0.35), range('jitter', 'Line jitter', 0, 1, 0.01, 0.2, '', { real: [0, 0.5] }), range('dropouts', 'Dropouts', 0, 1, 0.01, 0.2, '', { real: [0, 0.5] })],
    run(c, s, p) { return c.pass(S.tape, s, { u_hs: p.head, u_tr: p.tracking, u_tp: p.pos, u_j: p.jitter, u_do: p.dropouts }); } },

  /* ---------------- display */
  { id: 'converge', group: 'display', name: 'CRT misconvergence',
    info: 'The three electron beams miss each other: real RGB offsets that grow toward the screen edges.',
    params: [range('x', 'Horizontal', -4, 4, 0.05, 1.2, 'px', { real: [-2, 2] }), range('y', 'Vertical', -4, 4, 0.05, 0.4, 'px', { real: [-2, 2] }), range('edge', 'Edge growth', 0, 4, 0.05, 1.5, 'px', { real: [0, 2.5] })],
    run(c, s, p) { return c.pass(S.converge, s, { u_d: [p.x, p.y], u_e: p.edge }); } },
  { id: 'dlp', group: 'display', name: 'DLP rainbow',
    info: 'Colour-sequential break-up: highlights leave red, green and blue trails as the eye moves.',
    params: [range('amount', 'Amount', 0, 2, 0.01, 0.6, '', { real: [0, 1], amt: true }), range('len', 'Trail length', 2, 60, 0.5, 14, 'px', { real: [4, 30] }), range('angle', 'Direction', 0, 360, 1, 0, '°'),
      range('thr', 'Threshold', 0.2, 0.98, 0.01, 0.6, '', { adv: true })],
    run(c, s, p) { return c.pass(S.dlp, s, { u_k: p.amount, u_len: p.len, u_ang: p.angle, u_t: p.thr }); } },
  { id: 'smear', group: 'display', name: 'LCD smear & overdrive',
    info: 'Slow pixel transitions: dark trails behind moving edges, and bright overdrive overshoot.',
    params: [range('smear', 'Black smear', 0, 1, 0.01, 0.5, '', { real: [0, 0.8], amt: true }), range('len', 'Trail length', 2, 60, 0.5, 14, 'px', { real: [4, 30] }), range('od', 'Overdrive', 0, 1, 0.01, 0.3, '', { real: [0, 0.6] }),
      pick('dir', 'Motion', [['1', 'Trail to the right'], ['-1', 'Trail to the left']], '1')],
    run(c, s, p) { return c.pass(S.smear, s, { u_k: p.smear, u_len: p.len, u_od: p.od, u_dir: +p.dir }); } },
  { id: 'crt', group: 'display', name: 'Phosphor mask & scanlines',
    info: 'Aperture grille, slot or shadow mask (or an LCD screen-door grid) and scanlines that thicken in bright areas.',
    params: [range('mask', 'Mask', 0, 1, 0.01, 0.55, '', { real: [0, 0.8], amt: true }), pick('type', 'Mask type', [['0', 'Aperture grille'], ['1', 'Slot mask'], ['2', 'Shadow mask'], ['3', 'Screen door']], '0'),
      range('pitch', 'Pitch', 3, 12, 1, 4, 'px'), range('scan', 'Scanlines', 0, 1, 0.01, 0.5, '', { real: [0, 0.8], amt: true }), range('line', 'Line height', 3, 16, 0.5, 5, 'px'), range('bloom', 'Beam bloom', 0, 1, 0.01, 0.5)],
    run(c, s, p) { return c.pass(S.crt, s, { u_m: p.mask, u_type: +p.type, u_pitch: p.pitch, u_s: p.scan, u_lh: p.line, u_bw: p.bloom }); } },
];

/* ------------------------------------------------------------------ presets */
// Each preset switches on the listed effects (others off); unlisted params keep their defaults.
// 'light' (highlight recovery) stays on in all of them.
const PRESETS = [
  ['Modern phone, daylight', { light: {}, ca: { amount: 0.18 }, vignette: { stops: 0.4 }, camera: { profile: 'phone', iso: 0 } }],
  ['Modern phone, night', { light: {}, glare: { veil: 0.02, ghosts: 0.3 }, pf: { amount: 0.35 }, camera: { profile: 'phone', iso: 3.33, lnr: 0.9, cnr: 0.95 }, local: { amount: 0.45, radius: 5, flatten: 0.3 } }],
  ['2012 phone', { light: {}, ca: { amount: 0.35, type: 'simple' }, pf: { amount: 0.45 }, vignette: { stops: 0.8 }, soft: { amount: 0.5 }, camera: { profile: 'phone2012', iso: 2 }, jpeg: { q: 82 } }],
  ['2005 compact camera', { light: {}, ca: { amount: 0.5 }, pf: { amount: 0.55, width: 1.6 }, vignette: { stops: 0.7 }, ccd: { smear: 0.25, bloom: 0.3 }, camera: { profile: 'compact', iso: 1.33 }, jpeg: { q: 85 } }],
  ['DSLR at high ISO', { light: {}, ca: { amount: 0.12, type: 'apo' }, loca: { amount: 0.4 }, vignette: { stops: 0.9, falloff: 0.3 }, camera: { profile: 'dslr', iso: 6 } }],
  ['Webcam call', { light: {}, vignette: { stops: 1, falloff: 0.6 }, rolling: { skew: 0, flicker: 0.25 }, camera: { profile: 'webcam', iso: 2 }, jpeg: { q: 60 } }],
  ['Film scan', { light: {}, halation: { amount: 0.7, radius: 2.5 }, soft: { amount: 0.45 }, coma: { amount: 0.35 }, vignette: { stops: 0.7 }, glare: { veil: 0.02, ghosts: 0.2 } }],
  ['Posted to Instagram', { light: {}, reshare: { dest: 'instagram', long: 1080, q: 78, psharp: 0.35 } }],
  ['Re-shared five times', { light: {}, reshare: { dest: 'whatsapp', long: 1600, q: 70, psharp: 0.2, gens: 5, offset: true } }],
  ['VHS dub', { light: {}, vhs: { luma: 1.4, bleed: 11, delay: 5, ring: 0.6, cnoise: 0.35 }, composite: { rainbow: 0.7 }, tape: { head: 0.7, tracking: 0.25, pos: 0.2, jitter: 0.3, dropouts: 0.3 } }],
  ['CRT arcade', { light: {}, halation: { amount: 0.3, radius: 1.5 }, converge: { x: 1.2, y: 0.3, edge: 1.2 }, crt: { mask: 0.55, scan: 0.55, line: 5, bloom: 0.6 } }],
];

if (typeof module !== 'undefined') module.exports = { GROUPS, EFFECTS, PRESETS, S, CAMERAS, PLATFORMS };
