'use strict';
/*
 * ie2 v5 — GPU core.
 * The image lives on the GPU as float RGBA textures. Every effect is a short chain of full-screen
 * fragment passes; intermediate textures come from a pool and go straight back to it.
 * Coordinates inside shaders: gl_FragCoord.y = 0 is the TOP row of the image (nothing is ever flipped),
 * so "top / bottom" in effects mean what they say and read-backs come out top row first.
 *
 * Two light domains:
 *   display — what the photo file holds: sRGB-encoded 0..1.
 *   scene   — linear light, with blown highlights rebuilt as bright light (values above 1), so lens
 *             and sensor effects respond to real light the way they do in a camera.
 * The pipeline converts between them automatically, exactly invertibly.
 */
const GPU = (() => {
  const VERT = `#version 300 es
layout(location = 0) in float a_pad;
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2. - 1., a_pad, 1.); }`;

  // Shared GLSL prepended to every fragment shader.
  const LIB = `#version 300 es
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D u_src; uniform vec2 u_res; uniform vec2 u_srcRes; uniform float u_seed;
out vec4 o;
#define PI 3.14159265358979
vec2 P() { return gl_FragCoord.xy; }
vec2 UV() { return gl_FragCoord.xy / u_res; }
vec3 at(vec2 p) { return texture(u_src, p / u_srcRes).rgb; }
vec3 px(ivec2 i) { return texelFetch(u_src, clamp(i, ivec2(0), ivec2(u_srcRes) - 1), 0).rgb; }
float luma(vec3 c) { return dot(c, vec3(.299, .587, .114)); }
float lumaL(vec3 c) { return dot(c, vec3(.2126, .7152, .0722)); }
vec3 lin(vec3 c) { c = max(c, 0.); return mix(c / 12.92, pow((c + .055) / 1.055, vec3(2.4)), step(.04045, c)); }
vec3 srgb(vec3 c) { c = max(c, 0.); return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }
vec3 srgbS(vec3 c) { return sign(c) * srgb(abs(c)); }
float lin1(float v) { v = max(v, 0.); return v <= .04045 ? v / 12.92 : pow((v + .055) / 1.055, 2.4); }
float srgb1(float v) { v = max(v, 0.); return v <= .0031308 ? v * 12.92 : 1.055 * pow(v, 1. / 2.4) - .055; }
vec3 toYcc(vec3 c) { return vec3(dot(c, vec3(.299, .587, .114)), dot(c, vec3(-.168736, -.331264, .5)), dot(c, vec3(.5, -.418688, -.081312))); }
vec3 fromYcc(vec3 y) { return vec3(y.x + 1.402 * y.z, y.x - .344136 * y.y - .714136 * y.z, y.x + 1.772 * y.y); }
vec3 yiq(vec3 c) { return vec3(dot(c, vec3(.299, .587, .114)), dot(c, vec3(.596, -.274, -.322)), dot(c, vec3(.211, -.523, .312))); }
vec3 unyiq(vec3 y) { return vec3(y.x + .956 * y.y + .621 * y.z, y.x - .272 * y.y - .647 * y.z, y.x - 1.106 * y.y + 1.703 * y.z); }
// display <-> scene light. Above the knee, values are expanded toward hr (the brightest rebuilt light),
// driven by the brightest channel so hue is kept. toDisp is the exact inverse; light beyond hr clips.
float hrF(float m, float hr, float knee) { float t = clamp((m - knee) / max(1. - knee, 1e-4), 0., 1.); return 1. + (hr - 1.) * t * t * t * (3. - 2. * t); }
vec3 toScene(vec3 c, float hr, float knee) { c = clamp(c, 0., 1.); float m = max(c.r, max(c.g, c.b)); return lin(c) * hrF(m, hr, knee); }
vec3 toDisp(vec3 x, float hr, float knee) {
  x = max(x, 0.); float M = max(x.r, max(x.g, x.b));
  if (M <= 0.) return vec3(0.);
  float m;
  if (hr <= 1.0001 || M <= lin1(knee)) m = srgb1(min(M, 1.));
  else if (M >= hr) m = 1.;
  else {
    float lo = knee, hi = 1.;
    for (int i = 0; i < 20; i++) { float mid = .5 * (lo + hi); if (lin1(mid) * hrF(mid, hr, knee) < M) lo = mid; else hi = mid; }
    m = .5 * (lo + hi);
  }
  return srgb(min(x / hrF(m, hr, knee), vec3(1.)));
}
uint pcg(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v.x ^ v.y ^ v.z;
}
float rnd(vec2 p, float k) {
  ivec2 i = ivec2(floor(p)) + 65536;
  return float(pcg(uvec3(uint(i.x), uint(i.y), uint(int(k) + int(u_seed) * 7919 + 17)))) / 4294967296.;
}
float gss(vec2 p, float k) { float a = max(rnd(p, k), 1e-7), b = rnd(p, k + 101.); return sqrt(-2. * log(a)) * cos(2. * PI * b); }
float vnoise(vec2 p, float k) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(rnd(i, k), rnd(i + vec2(1, 0), k), f.x), mix(rnd(i + vec2(0, 1), k), rnd(i + vec2(1, 1), k), f.x), f.y);
}
float rad() { return length(gl_FragCoord.xy - u_res * .5) / (.5 * length(u_res)); }
`;

  const SH = {
    ingest: `void main() { vec4 c = texelFetch(u_src, ivec2(P()), 0); o = vec4(mix(vec3(1.), c.rgb, c.a), 1.); }`,
    copy: `void main() { o = vec4(texelFetch(u_src, ivec2(P()), 0).rgb, 1.); }`,
    clamp01: `void main() { o = vec4(clamp(texelFetch(u_src, ivec2(P()), 0).rgb, 0., 1.), 1.); }`,
    toScene: `uniform float u_hr, u_knee; void main() { o = vec4(toScene(texelFetch(u_src, ivec2(P()), 0).rgb, u_hr, u_knee), 1.); }`,
    toDisp: `uniform float u_hr, u_knee; void main() { o = vec4(toDisp(texelFetch(u_src, ivec2(P()), 0).rgb, u_hr, u_knee), 1.); }`,
    // round to 8 bits (optionally dithered) exactly as a file stores it
    q8: `uniform float u_dither;
void main() {
  vec2 p = P(); vec3 c = clamp(texelFetch(u_src, ivec2(p), 0).rgb, 0., 1.);
  vec3 n = u_dither * vec3(rnd(p, 1.) + rnd(p, 2.) - 1., rnd(p, 3.) + rnd(p, 4.) - 1., rnd(p, 5.) + rnd(p, 6.) - 1.);
  o = vec4(clamp(floor(c * 255. + n + .5), 0., 255.) / 255., 1.);
}`,
    down: `uniform ivec2 u_f;
void main() {
  ivec2 b = ivec2(P()) * u_f, mx = ivec2(u_srcRes) - 1; vec4 s = vec4(0);
  for (int y = 0; y < u_f.y; y++) for (int x = 0; x < u_f.x; x++) s += texelFetch(u_src, min(b + ivec2(x, y), mx), 0);
  o = s / float(u_f.x * u_f.y);
}`,
    gauss: `uniform ivec2 u_dir; uniform float u_sig;
void main() {
  ivec2 i = ivec2(P()), mx = ivec2(u_srcRes) - 1; int R = min(int(ceil(u_sig * 3.)), 96);
  vec4 s = vec4(0); float ws = 0., k2 = 1. / (2. * u_sig * u_sig);
  for (int k = -R; k <= R; k++) { float w = exp(-float(k * k) * k2); s += w * texelFetch(u_src, clamp(i + u_dir * k, ivec2(0), mx), 0); ws += w; }
  o = s / ws;
}`,
    // One axis of a resize. Kernels: 0 nearest, 1 triangle, 2 Catmull-Rom, 3 Lanczos-3, 4 exact area,
    // 5 triangle without anti-aliasing (what cheap GPU / browser scalers do), 6 Mitchell.
    // u_off shifts the sampling grid (half-pixel offset bugs in real software).
    rs: `uniform int u_axis, u_kern; uniform float u_scale, u_off;
float K(float x) {
  x = abs(x);
  if (u_kern == 1 || u_kern == 5) return max(0., 1. - x);
  if (u_kern == 2) return x < 1. ? (1.5 * x - 2.5) * x * x + 1. : x < 2. ? ((-.5 * x + 2.5) * x - 4.) * x + 2. : 0.;
  if (u_kern == 6) return x < 1. ? (7. * x * x * x - 12. * x * x + 16. / 3.) / 6. : x < 2. ? (-7. / 3. * x * x * x + 12. * x * x - 20. * x + 32. / 3.) / 6. : 0.;
  if (x < 1e-5) return 1.; if (x >= 3.) return 0.;
  float a = PI * x; return 3. * sin(a) * sin(a / 3.) / (a * a);
}
vec3 S(int j, ivec2 q) { return px(u_axis == 0 ? ivec2(j, q.y) : ivec2(q.x, j)); }
void main() {
  ivec2 q = ivec2(P()); float i = u_axis == 0 ? P().x : P().y, n = u_axis == 0 ? u_srcRes.x : u_srcRes.y;
  float c = i / u_scale + u_off;
  if (u_kern == 0) { o = vec4(S(int(floor(c)), q), 1.); return; }
  vec3 s = vec3(0.); float ws = 0.;
  if (u_kern == 4) {
    float a = (i - .5) / u_scale + u_off, b = (i + .5) / u_scale + u_off;
    if (u_scale >= 1.) { a = c - .5; b = c + .5; }
    for (int j = int(floor(a)); j <= int(ceil(b)); j++) { float w = max(0., min(float(j + 1), b) - max(float(j), a)); s += w * S(j, q); ws += w; }
    o = vec4(s / max(ws, 1e-6), 1.); return;
  }
  float fs = (u_scale < 1. && u_kern != 5) ? 1. / u_scale : 1., sup = (u_kern == 1 || u_kern == 5 ? 1. : u_kern == 3 ? 3. : 2.) * fs;
  int lo = int(floor(c - sup)), hi = int(ceil(c + sup));
  for (int j = lo; j <= hi; j++) { float w = K((float(j) + .5 - c) / fs); s += w * S(j, q); ws += w; }
  o = vec4(s / ws, 1.);
}`,
    unsharp: `uniform sampler2D u_b; uniform float u_k; void main() { vec3 c = px(ivec2(P())); o = vec4(c + u_k * (luma(c) - luma(texture(u_b, UV()).rgb)), 1.); }`,

    /* ---- JPEG, done the way an encoder and decoder do it, so the preview is the file ---- */
    // RGB (rounded to 8 bits, optional dither) -> Y-128, Cb, Cr, padded to whole MCUs by edge copy
    jpYcc: `uniform float u_dither;
void main() {
  ivec2 p = min(ivec2(P()), ivec2(u_srcRes) - 1); vec2 f = vec2(p);
  vec3 n = u_dither * vec3(rnd(f, 1.) + rnd(f, 2.) - 1., rnd(f, 3.) + rnd(f, 4.) - 1., rnd(f, 5.) + rnd(f, 6.) - 1.);
  vec3 c = clamp(floor(clamp(texelFetch(u_src, p, 0).rgb, 0., 1.) * 255. + n + .5), 0., 255.);
  vec3 y = floor(toYcc(c) + vec3(0., 128., 128.) + .5);
  o = vec4(y.x - 128., y.y - 128., y.z - 128., 1.);
}`,
    jpDown: `uniform ivec2 u_s;
void main() {
  ivec2 b = ivec2(P()) * u_s, mx = ivec2(u_srcRes) - 1; vec2 s = vec2(0.);
  for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) if (x < u_s.x && y < u_s.y) s += texelFetch(u_src, min(b + ivec2(x, y), mx), 0).gb;
  o = vec4(0., floor(s / float(u_s.x * u_s.y) + .5), 1.);
}`,
    jpRow: `uniform float u_B[64];
void main() { ivec2 p = ivec2(P()); int u = p.x & 7, bx = p.x - u; vec3 s = vec3(0.);
  for (int i = 0; i < 8; i++) s += u_B[u * 8 + i] * texelFetch(u_src, ivec2(bx + i, p.y), 0).rgb;
  o = vec4(s, 1.); }`,
    jpColQ: `uniform float u_B[64], u_QY[64], u_QC[64];
void main() { ivec2 p = ivec2(P()); int v = p.y & 7, by = p.y - v, k = v * 8 + (p.x & 7); vec3 s = vec3(0.);
  for (int j = 0; j < 8; j++) s += u_B[v * 8 + j] * texelFetch(u_src, ivec2(p.x, by + j), 0).rgb;
  o = vec4(clamp(round(s / vec3(u_QY[k], u_QC[k], u_QC[k])), -1023., 1023.), 1.); }`,
    jpColI: `uniform float u_B[64], u_QY[64], u_QC[64];
void main() { ivec2 p = ivec2(P()); int j = p.y & 7, by = p.y - j, u = p.x & 7; vec3 s = vec3(0.);
  for (int v = 0; v < 8; v++) { int k = v * 8 + u; s += u_B[v * 8 + j] * texelFetch(u_src, ivec2(p.x, by + v), 0).rgb * vec3(u_QY[k], u_QC[k], u_QC[k]); }
  o = vec4(s, 1.); }`,
    jpRowI: `uniform float u_B[64];
void main() { ivec2 p = ivec2(P()); int i = p.x & 7, bx = p.x - i; vec3 s = vec3(0.);
  for (int u = 0; u < 8; u++) s += u_B[u * 8 + i] * texelFetch(u_src, ivec2(bx + u, p.y), 0).rgb;
  o = vec4(clamp(round(s + 128.), 0., 255.) - vec3(0., 128., 128.), 1.); }`,
    // decoder output: chroma upsampled the way libjpeg's "fancy" upsampling does (centred linear)
    jpOut: `uniform sampler2D u_c; uniform vec2 u_cs, u_cres;
void main() { ivec2 p = ivec2(P()); float Y = texelFetch(u_src, p, 0).r;
  vec2 C = texture(u_c, ((vec2(p) + .5) / u_cs) / u_cres).gb;
  o = vec4(clamp(floor(fromYcc(vec3(Y, C)) + .5), 0., 255.) / 255., 1.); }`,

    // per-pixel colour difference (CIE76 dE) for the survival meter: visible?, dE, dE where visible
    dE: `uniform sampler2D u_b;
vec3 lab(vec3 c) {
  vec3 x = mat3(.4124, .2126, .0193, .3576, .7152, .1192, .1805, .0722, .9505) * lin(clamp(c, 0., 1.)) / vec3(.95047, 1., 1.08883);
  vec3 f = mix(pow(max(x, 1e-6), vec3(1. / 3.)), 7.787 * x + 16. / 116., step(x, vec3(.008856)));
  return vec3(116. * f.y - 16., 500. * (f.x - f.y), 200. * (f.y - f.z));
}
void main() { float d = min(length(lab(px(ivec2(P()))) - lab(texture(u_b, UV()).rgb)), 60.); float v = d > 1. ? 1. : 0.; o = vec4(v, d, v * d, 1.); }`,

    show: `uniform sampler2D u_b; uniform float u_split, u_mode;
void main() {
  vec2 uv = vec2(gl_FragCoord.x / u_res.x, 1. - gl_FragCoord.y / u_res.y);
  vec3 r = texture(u_src, uv).rgb, a = texture(u_b, uv).rgb;
  vec3 c = u_mode < .5 ? r : u_mode < 1.5 ? a : (uv.x < u_split ? a : r);
  o = vec4(clamp(c, 0., 1.), 1.);
}`,
    // crop / rotate / flip in one resample. Output pixel -> frame -> undo fine rotation -> undo flip
    // -> undo quarter turns -> source; Catmull-Rom, so unrotated crops and 90° turns copy pixels exactly.
    geo: `uniform vec2 u_frame, u_cs, u_flip; uniform vec4 u_crop; uniform int u_turns;
vec4 cr(float t) { float t2 = t * t, t3 = t2 * t; return vec4(-.5 * t3 + t2 - .5 * t, 1.5 * t3 - 2.5 * t2 + 1., -1.5 * t3 + 2. * t2 + .5 * t, .5 * t3 - .5 * t2); }
void main() {
  vec2 f = u_crop.xy + P() - u_frame * .5;
  vec2 a = vec2(f.x * u_cs.x + f.y * u_cs.y, -f.x * u_cs.y + f.y * u_cs.x) * u_flip;
  for (int k = 0; k < 3; k++) { if (k >= u_turns) break; a = vec2(a.y, -a.x); }
  vec2 t = a + u_srcRes * .5 - .5, fr = fract(t); ivec2 i = ivec2(floor(t));
  vec4 wx = cr(fr.x), wy = cr(fr.y); vec3 c = vec3(0.);
  for (int y = 0; y < 4; y++) { vec3 row = vec3(0.); for (int x = 0; x < 4; x++) row += wx[x] * px(i + ivec2(x - 1, y - 1)); c += wy[y] * row; }
  o = vec4(clamp(c, 0., 1.), 1.);
}`,
    // Merge 2-8 versions (u_src = version 1, u_l1..u_l7 = the rest). Weight 0 = version off.
    // modes: 0 mix, 1 weighted median, 2 lighten, 3 darken, 4 sharpest, 5 patchwork, 6 channels, 7 detail + colour
    merge: `uniform sampler2D u_l1, u_l2, u_l3, u_l4, u_l5, u_l6, u_l7;
uniform int u_mode, u_n; uniform float u_w[8]; uniform float u_scale, u_soft, u_pow, u_pseed; uniform ivec3 u_ch;
vec3 L(int i, ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(u_srcRes) - 1); vec4 t;
  if (i == 0) t = texelFetch(u_src, p, 0); else if (i == 1) t = texelFetch(u_l1, p, 0); else if (i == 2) t = texelFetch(u_l2, p, 0);
  else if (i == 3) t = texelFetch(u_l3, p, 0); else if (i == 4) t = texelFetch(u_l4, p, 0); else if (i == 5) t = texelFetch(u_l5, p, 0);
  else if (i == 6) t = texelFetch(u_l6, p, 0); else t = texelFetch(u_l7, p, 0);
  return mix(vec3(1.), t.rgb, t.a);
}
float detail(int i, ivec2 p) {
  float e = 0.;
  for (int y = -2; y <= 2; y += 2) for (int x = -2; x <= 2; x += 2) {
    ivec2 q = p + ivec2(x, y); float c = luma(L(i, q));
    e += abs(c - luma(L(i, q + ivec2(1, 0)))) + abs(c - luma(L(i, q + ivec2(0, 1))));
  }
  return e / 9.;
}
void main() {
  ivec2 p = ivec2(P()); int n = clamp(u_n, 1, 8);
  if (u_mode == 6) { o = vec4(L(clamp(u_ch.x, 0, n - 1), p).r, L(clamp(u_ch.y, 0, n - 1), p).g, L(clamp(u_ch.z, 0, n - 1), p).b, 1.); return; }
  if (u_mode == 7) { vec3 a = toYcc(L(clamp(u_ch.x, 0, n - 1), p)), b = toYcc(L(clamp(u_ch.y, 0, n - 1), p)); o = vec4(fromYcc(vec3(a.x, b.yz)), 1.); return; }
  if (u_mode == 1) {
    vec3 r = vec3(0.);
    for (int c = 0; c < 3; c++) {
      float va[8] = float[8](0., 0., 0., 0., 0., 0., 0., 0.), wa[8] = float[8](0., 0., 0., 0., 0., 0., 0., 0.);
      int k = 0; float tot = 0.;
      for (int i = 0; i < 8; i++) {
        if (i >= n) break; float w = u_w[i]; if (w <= 0.) continue;
        float v = L(i, p)[c]; int j = k;
        while (j > 0 && va[j - 1] > v) { va[j] = va[j - 1]; wa[j] = wa[j - 1]; j--; }
        va[j] = v; wa[j] = w; k++; tot += w;
      }
      float cum = 0., m = va[0], hw = tot * .5;
      for (int j = 0; j < 8; j++) {
        if (j >= k) break; cum += wa[j];
        if (cum >= hw - 1e-5) { m = (abs(cum - hw) < 1e-5 && j + 1 < k) ? .5 * (va[j] + va[j + 1]) : va[j]; break; }
      }
      r[c] = m;
    }
    o = vec4(r, 1.); return;
  }
  if (u_mode == 2 || u_mode == 3) {
    float wm = 0.; for (int i = 0; i < 8; i++) { if (i >= n) break; wm = max(wm, u_w[i]); }
    vec3 r = vec3(0.); bool first = true;
    for (int i = 0; i < 8; i++) {
      if (i >= n) break; float w = u_w[i]; if (w <= 0.) continue;
      vec3 c = L(i, p);
      if (first) { r = c; first = false; } else r = mix(r, u_mode == 2 ? max(r, c) : min(r, c), w / wm);
    }
    o = vec4(r, 1.); return;
  }
  vec3 s = vec3(0.); float ws = 0., K = 4. + 60. * (1. - u_soft);
  for (int i = 0; i < 8; i++) {
    if (i >= n) break; float w = u_w[i]; if (w <= 0.) continue;
    if (u_mode == 4) w *= pow(detail(i, p) * 40. + .15, u_pow);
    else if (u_mode == 5) {
      vec2 q = P() / max(u_scale, 1.); float k = 300. + float(i) * 17. + u_pseed * 31.;
      w *= exp(K * (.62 * vnoise(q, k) + .38 * vnoise(q * 2.3 + 11.7, k + 7.) - .5));
    }
    s += w * L(i, p); ws += w;
  }
  o = vec4(ws > 0. ? s / ws : L(0, p), 1.);
}`,
  };

  // JPEG basics: Annex K tables, IJG quality scaling, the DCT basis, chroma sampling factors
  const QBASE_Y = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
  const QBASE_C = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
  function qtable(base, q) {
    q = Math.min(100, Math.max(1, Math.round(q)));
    const s = q < 50 ? 5000 / q : 200 - 2 * q;
    return base.map(v => Math.min(255, Math.max(1, Math.floor((v * s + 50) / 100))));
  }
  const DCTB = new Float32Array(64);
  for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) DCTB[u * 8 + x] = (u ? 1 : Math.SQRT1_2) * 0.5 * Math.cos((2 * x + 1) * u * Math.PI / 16);
  const SAMP = { 444: [1, 1], 422: [2, 1], 420: [2, 2] };
  const KERN = { nearest: 0, bilinear: 1, bicubic: 2, lanczos3: 3, area: 4, cheap: 5, mitchell: 6 };

  function create(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('This browser has no WebGL2, which v5 needs.');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This GPU cannot render to float textures (EXT_color_buffer_float).');
    const f32Linear = !!gl.getExtension('OES_texture_float_linear');
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    // The triangle is generated from gl_VertexID; attribute 0 still gets a tiny buffer because some
    // drivers (and desktop-GL emulation) take a slow path when it is disabled.
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(3), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);

    /* ---------- programs ---------- */
    const progs = new Map();
    function compile(type, src) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { const log = gl.getShaderInfoLog(s); gl.deleteShader(s); throw new Error('Shader: ' + log); }
      return s;
    }
    const vs = compile(gl.VERTEX_SHADER, VERT);
    function program(src) {
      let p = progs.get(src);
      if (p) return p;
      const prog = gl.createProgram();
      gl.attachShader(prog, vs); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, LIB + src));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Link: ' + gl.getProgramInfoLog(prog));
      const locs = new Map();
      p = { prog, loc: (n) => { if (!locs.has(n)) locs.set(n, gl.getUniformLocation(prog, n)); return locs.get(n); } };
      progs.set(src, p);
      return p;
    }
    function setUniform(p, name, v) {
      const l = p.loc(name); if (l === null) return;
      if (typeof v === 'number') gl.uniform1f(l, v);
      else if (typeof v === 'boolean') gl.uniform1f(l, v ? 1 : 0);
      else if (v && v.i !== undefined) {
        const a = Array.isArray(v.i) ? v.i : [v.i];
        if (a.length === 1) gl.uniform1i(l, a[0]); else if (a.length === 2) gl.uniform2i(l, a[0], a[1]); else gl.uniform3i(l, a[0], a[1], a[2]);
      } else if (v.length === 2 && !(v instanceof Float32Array)) gl.uniform2f(l, v[0], v[1]);
      else if (v.length === 3 && !(v instanceof Float32Array)) gl.uniform3f(l, v[0], v[1], v[2]);
      else if (v.length === 4 && !(v instanceof Float32Array)) gl.uniform4f(l, v[0], v[1], v[2], v[3]);
      else if (v.v2) gl.uniform2fv(l, v.v2);
      else if (v.v3) gl.uniform3fv(l, v.v3);
      else gl.uniform1fv(l, v);
    }

    /* ---------- textures ---------- */
    const FMT = {
      f16: [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR],
      f32: [gl.RGBA32F, gl.RGBA, gl.FLOAT, f32Linear ? gl.LINEAR : gl.NEAREST],
      u8: [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR],
    };
    function makeTex(w, h, fmt) {
      const [ifmt, f, t, filt] = FMT[fmt];
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filt);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, f, t, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb, w, h, fmt, key: w + 'x' + h + fmt };
    }
    const pool = new Map();
    function get(w, h, fmt = 'f16') {
      const k = w + 'x' + h + fmt, l = pool.get(k);
      return l && l.length ? l.pop() : makeTex(w, h, fmt);
    }
    function put(t) {
      if (!t || t.pinned) return;
      let l = pool.get(t.key); if (!l) pool.set(t.key, l = []);
      if (!l.includes(t)) l.push(t);
    }
    function release(t) { if (t) { t.pinned = false; put(t); } }
    function destroy(t) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb); }
    function drain() { for (const l of pool.values()) l.forEach(destroy); pool.clear(); }

    /* ---------- passes ---------- */
    let seed = 1, made = null;
    // Run fragment shader `src` reading `input` (bound as u_src), writing a new pooled texture.
    function pass(src, input, uniforms = {}, opts = {}) {
      const w = opts.w || input.w, h = opts.h || input.h;
      const target = opts.target !== undefined ? opts.target : get(w, h, opts.fmt || 'f16');
      const p = program(src);
      gl.useProgram(p.prog);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, input.tex);
      gl.uniform1i(p.loc('u_src'), 0);
      let unit = 1;
      for (const name in (opts.tex || {})) {
        gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, opts.tex[name].tex);
        gl.uniform1i(p.loc(name), unit); unit++;
      }
      setUniform(p, 'u_res', [w, h]); setUniform(p, 'u_srcRes', [input.w, input.h]); setUniform(p, 'u_seed', seed);
      for (const k in uniforms) setUniform(p, k, uniforms[k]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (target && made) made.push(target);
      return target;
    }
    // Run fn with its own texture bookkeeping; every texture it makes is returned to the pool except
    // the ones `fn` returns (a texture or an array / object of textures).
    function scoped(fn) {
      const outer = made; made = [];
      let r;
      try { r = fn(); }
      finally {
        const mine = made; made = outer;
        const keep = new Set(r && r.tex ? [r] : r && typeof r === 'object' ? Object.values(r).filter(x => x && x.tex) : []);
        for (const t of mine) if (!keep.has(t)) put(t);
        if (made) for (const t of keep) made.push(t);
      }
      return r;
    }
    // Gaussian blur. Wide radii run on a box-downsampled copy (sampled back with bilinear filtering),
    // so the cost stays flat whatever the radius. axis: 'xy' | 'x' | 'y'.
    function blur(t, sigma, axis = 'xy') {
      if (!(sigma > 0.25)) return t;
      const f = sigma > 5 ? Math.min(32, Math.floor(sigma / 2.5)) : 1;
      const fx = axis === 'y' ? 1 : f, fy = axis === 'x' ? 1 : f;
      let s = t;
      if (f > 1) s = pass(SH.down, t, { u_f: { i: [fx, fy] } }, { w: Math.ceil(t.w / fx), h: Math.ceil(t.h / fy) });
      const sg = (k) => Math.sqrt(Math.max(0.04, (sigma / k) ** 2 - (k > 1 ? 1 / 12 : 0)));
      if (axis !== 'y') s = pass(SH.gauss, s, { u_dir: { i: [1, 0] }, u_sig: sg(fx) });
      if (axis !== 'x') s = pass(SH.gauss, s, { u_dir: { i: [0, 1] }, u_sig: sg(fy) });
      if (s.w !== t.w || s.h !== t.h) s = pass(SH.rs, pass(SH.rs, s, { u_axis: { i: 0 }, u_kern: { i: 1 }, u_scale: t.w / s.w, u_off: 0 }, { w: t.w, h: s.h }),
        { u_axis: { i: 1 }, u_kern: { i: 1 }, u_scale: t.h / s.h, u_off: 0 }, { w: t.w, h: t.h });
      return s;
    }
    // Resize with a named kernel (see KERN). 'halve' = repeated 2x box then a cheap final step.
    // opts.off: grid offset in source pixels.
    function resize(t, w, h, method = 'lanczos3', opts = {}) {
      w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
      if (w === t.w && h === t.h && !opts.off) return t;
      if (method === 'halve') {
        let s = t;
        while (s.w >= 2 * w && s.h >= 2 * h) s = pass(SH.down, s, { u_f: { i: [2, 2] } }, { w: Math.ceil(s.w / 2), h: Math.ceil(s.h / 2) });
        return resize(s, w, h, 'cheap', opts);
      }
      const k = KERN[method] !== undefined ? KERN[method] : 3, off = +opts.off || 0;
      const a = pass(SH.rs, t, { u_axis: { i: 0 }, u_kern: { i: k }, u_scale: w / t.w, u_off: off }, { w, h: t.h });
      return pass(SH.rs, a, { u_axis: { i: 1 }, u_kern: { i: k }, u_scale: h / t.h, u_off: off }, { w, h });
    }
    function unsharp(t, amount, radius) { return amount > 0 ? pass(SH.unsharp, t, { u_k: amount }, { tex: { u_b: blur(t, radius) } }) : t; }

    /* ---------- JPEG ---------- */
    // Forward half of a real JPEG encode: 8-bit RGB -> YCbCr -> chroma subsampling -> DCT -> quantise.
    // Returns integer coefficient textures laid out like the image (each 8x8 block holds its 64 coefs).
    function jpegCoefs(t, q, sub, dither) {
      const [hs, vs] = SAMP[sub] || SAMP[444], qY = qtable(QBASE_Y, q), qC = qtable(QBASE_C, q);
      const Wp = Math.ceil(t.w / (8 * hs)) * 8 * hs, Hp = Math.ceil(t.h / (8 * vs)) * 8 * vs;
      const U = { u_B: DCTB, u_QY: new Float32Array(qY), u_QC: new Float32Array(qC) };
      const ycc = pass(SH.jpYcc, t, { u_dither: dither ? 1 : 0 }, { w: Wp, h: Hp, fmt: 'f32' });
      const Y = pass(SH.jpColQ, pass(SH.jpRow, ycc, U, { fmt: 'f32' }), U, { fmt: 'f32' });
      let C = Y;
      if (hs * vs > 1) {
        const cs = pass(SH.jpDown, ycc, { u_s: { i: [hs, vs] } }, { w: Wp / hs, h: Hp / vs, fmt: 'f32' });
        C = pass(SH.jpColQ, pass(SH.jpRow, cs, U, { fmt: 'f32' }), U, { fmt: 'f32' });
      }
      return { Y, C, W: t.w, H: t.h, Wp, Hp, hs, vs, qY, qC };
    }
    // Decoder: dequantise -> inverse DCT -> 8-bit samples -> fancy chroma upsampling -> 8-bit RGB
    function jpegDecode(co) {
      const U = { u_B: DCTB, u_QY: new Float32Array(co.qY), u_QC: new Float32Array(co.qC) };
      const Yd = pass(SH.jpRowI, pass(SH.jpColI, co.Y, U, { fmt: 'f32' }), U, { fmt: 'f16' });
      const Cd = co.C === co.Y ? Yd : pass(SH.jpRowI, pass(SH.jpColI, co.C, U, { fmt: 'f32' }), U, { fmt: 'f16' });
      return pass(SH.jpOut, Yd, { u_cs: [co.hs, co.vs], u_cres: [Cd.w, Cd.h] }, { w: co.W, h: co.H, tex: { u_c: Cd } });
    }
    function jpegSim(t, q, sub, dither) { return scoped(() => jpegDecode(jpegCoefs(t, q, sub, dither))); }

    /* ---------- export simulation ---------- */
    // S = { format: 'jpeg' | 'png' | 'png16', q, sub, long (0 = full size), check: platform or null }
    // platform = { long, q, sub, sharpen }. Returns what the file holds (and what the platform makes of it).
    function asSaved(t, S) {
      return scoped(() => {
        let x = t;
        const fit = (img, L, how) => { const m = Math.max(img.w, img.h); return L && m > L ? resize(img, img.w * L / m, img.h * L / m, how) : img; };
        x = fit(x, S.long, 'lanczos3');
        if (S.format === 'jpeg') x = jpegSim(x, S.q, S.sub, true);
        else if (S.format === 'png') x = pass(SH.q8, x, { u_dither: 1 });
        else x = pass(SH.clamp01, x);
        const P = S.check;
        if (P) {
          x = fit(x, P.long, 'bicubic');
          if (P.sharpen) x = unsharp(x, P.sharpen, 0.8);
          x = jpegSim(x, P.q, P.sub, false);
        }
        return x;
      });
    }

    /* ---------- measurement (survival meter) ---------- */
    function readFloat(t, x, y, w, h) {
      const buf = new Float32Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.FLOAT, buf);
      return buf;
    }
    function readU8(t, x, y, w, h) {
      const buf = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    }
    // { vis: share of pixels visibly changed (dE > 1), mean: mean dE, visMean: mean dE of the changed ones }
    function diffStats(a, b) {
      return scoped(() => {
        if (b.w !== a.w || b.h !== a.h) b = resize(b, a.w, a.h, 'bicubic');
        let d = pass(SH.dE, a, {}, { fmt: 'f32', tex: { u_b: b } });
        while (d.w > 32 || d.h > 32) d = pass(SH.down, d, { u_f: { i: [d.w > 32 ? 8 : 1, d.h > 32 ? 8 : 1] } }, { w: d.w > 32 ? Math.ceil(d.w / 8) : d.w, h: d.h > 32 ? Math.ceil(d.h / 8) : d.h, fmt: 'f32' });
        const r = readFloat(d, 0, 0, d.w, d.h); let v = 0, m = 0, vm = 0;
        for (let i = 0; i < r.length; i += 4) { v += r[i]; m += r[i + 1]; vm += r[i + 2]; }
        const n = r.length / 4;
        return { vis: v / n, mean: m / n, visMean: v > 0 ? vm / v : 0 };
      });
    }

    /* ---------- image state ---------- */
    // src: the opened image. base: src after crop / rotate (what effects and comparisons start from).
    let src = null, base = null, result = null, saved = null, savedKey = '', W = 0, H = 0;
    let layers = [];   // the versions of a merge, as 8-bit textures
    function dropSaved() { if (saved) { release(saved); saved = null; savedKey = ''; } }
    function clearImage() {
      dropSaved();
      if (result && result !== base) put(result);
      if (base && base !== src) destroy(base);
      if (src) destroy(src);
      layers.forEach(destroy); layers = [];
      src = base = result = null;
      drain();
    }
    function upload(source, w, h) {
      const t = makeTex(w, h, 'u8');
      gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
      return t;
    }
    // Several versions of one picture, all w x h. merge() then writes their blend into src.
    function loadStack(sources, w, h) {
      clearImage();
      W = w; H = h; canvas.width = w; canvas.height = h;
      layers = sources.slice(0, 8).map(s => { const t = upload(s, w, h); t.pinned = true; return t; });
      src = makeTex(w, h, 'f16'); src.pinned = true;
      base = result = src;
    }
    // m = { mode, n, w: [8 weights], scale, soft, pow, seed, ch: [r, g, b] }
    function merge(m) {
      if (!layers.length) return;
      made = null;
      const tex = {};
      for (let i = 1; i < 8; i++) tex['u_l' + i] = layers[Math.min(i, layers.length - 1)];
      pass(SH.merge, layers[0], { u_mode: { i: m.mode }, u_n: { i: layers.length }, u_w: new Float32Array(m.w), u_scale: m.scale,
        u_soft: m.soft, u_pow: m.pow, u_pseed: m.seed, u_ch: { i: m.ch } }, { target: src, w: src.w, h: src.h, tex });
    }
    function load(source, w, h) {
      clearImage();
      W = w; H = h;
      canvas.width = w; canvas.height = h;
      const up = upload(source, w, h);
      made = null;
      src = pass(SH.ingest, up, {}, {});
      src.pinned = true;
      destroy(up);
      base = result = src;
    }

    /* Geometry: g = { turns: 0-3 (90° clockwise), angle: degrees (clockwise), flipH, flipV,
       crop: [x, y, w, h] normalised to the frame }. The frame is the largest rectangle with the
       turned image's aspect that fits inside the rotated image, at the source's own pixel scale,
       so rotating never leaves empty corners and never enlarges pixels. */
    function frameOf(g) {
      const t = (g.turns | 0) & 3, W1 = t & 1 ? src.h : src.w, H1 = t & 1 ? src.w : src.h;
      const th = Math.abs(+g.angle || 0) * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
      const k = Math.max(c + (H1 / W1) * s, (W1 / H1) * s + c);
      // when tilted, stay a couple of pixels clear of the rotated edge so no corner touches it
      const f = s > 0 ? Math.max(0.5, 1 - 4 * k / Math.min(W1, H1)) : 1;
      return { W1, H1, Fw: W1 / k * f, Fh: H1 / k * f };
    }
    function cropBox(g, fr, crop) {
      const c = crop || g.crop || [0, 0, 1, 1];
      const x = Math.max(0, Math.round(c[0] * fr.Fw)), y = Math.max(0, Math.round(c[1] * fr.Fh));
      const w = Math.max(1, Math.min(Math.round(c[2] * fr.Fw), Math.floor(fr.Fw + 1e-6) - x));
      const h = Math.max(1, Math.min(Math.round(c[3] * fr.Fh), Math.floor(fr.Fh + 1e-6) - y));
      return { x, y, w, h };
    }
    function setGeometry(g, crop) {
      if (!src) return;
      const fr = frameOf(g), b = cropBox(g, fr, crop), t = (g.turns | 0) & 3, ang = +g.angle || 0;
      const identity = !t && !ang && !g.flipH && !g.flipV && !b.x && !b.y && b.w === src.w && b.h === src.h;
      dropSaved();
      if (result !== base) put(result);
      if (base !== src) destroy(base);
      if (b.w !== W || b.h !== H) drain();
      made = null;
      if (identity) base = src;
      else {
        const r = ang * Math.PI / 180;
        base = pass(SH.geo, src, { u_frame: [fr.Fw, fr.Fh], u_crop: [b.x, b.y, b.w, b.h], u_cs: [Math.cos(r), Math.sin(r)],
          u_flip: [g.flipH ? -1 : 1, g.flipV ? -1 : 1], u_turns: { i: t } }, { w: b.w, h: b.h });
        base.pinned = true;
      }
      result = base; W = b.w; H = b.h;
    }

    /* ---------- the effect chain ---------- */
    // opts = { hr: brightest rebuilt light (linear), knee, k: overall intensity }
    function makeCtx(opts) {
      const hr = Math.max(1, +opts.hr || 1), knee = Math.min(0.99, Math.max(0.5, +opts.knee || 0.9));
      return {
        W, H, diag: Math.hypot(W, H), short: Math.min(W, H), hr, knee, k: opts.k == null ? 1 : +opts.k, seed,
        pass, blur, get, put, resize, unsharp, jpegSim, scoped,
        q8: (t, dither) => pass(SH.q8, t, { u_dither: dither ? 1 : 0 }),
        toScene: (t) => pass(SH.toScene, t, { u_hr: hr, u_knee: knee }),
        toDisp: (t) => pass(SH.toDisp, t, { u_hr: hr, u_knee: knee }),
      };
    }
    // Effects declare the light domain they work in (fx.domain, default display) and may hand over
    // in another one (fx.out). Conversions are inserted where the domain changes.
    function runChain(chain, opts, onStep) {
      const ctx = makeCtx(opts);
      let cur = base, dom = 'display';
      const swap = (next) => { if (cur !== base && cur !== next) put(cur); cur = next; };
      const conv = (to) => { made = null; swap(to === 'scene' ? ctx.toScene(cur) : ctx.toDisp(cur)); dom = to; };
      for (let i = 0; i < chain.length; i++) {
        const { fx, p } = chain[i], need = fx.domain || 'display';
        if (need !== dom) conv(need);
        made = [];
        let out;
        try { out = fx.run(ctx, cur, p) || cur; }
        catch (e) { const m = made; made = null; m.forEach(t => { if (t !== cur) put(t); }); throw new Error(fx.name + ': ' + e.message); }
        const mine = made; made = null;
        for (const t of mine) if (t !== out) put(t);
        const domOut = fx.out || need;
        if (onStep) onStep(i, cur, dom, out, domOut, ctx);
        swap(out); dom = domOut;
      }
      if (dom !== 'display') conv('display');
      made = null;
      return cur;
    }
    function process(chain, seedValue, opts = {}) {
      if (!base) return 0;
      const t0 = performance.now();
      seed = seedValue | 0;
      dropSaved();
      if (result !== base) put(result);
      result = base;
      result = runChain(chain, opts);
      gl.finish();
      return performance.now() - t0;
    }
    // For every effect in the chain: how visible its change is before and after export (S).
    function measure(chain, seedValue, opts, S) {
      if (!base) return [];
      seed = seedValue | 0;
      const out = [];
      const fin = runChain(chain, opts, (i, a, da, b, db, ctx) => {
        out[i] = scoped(() => {
          const A = da === 'scene' ? ctx.toDisp(a) : a, B = db === 'scene' ? ctx.toDisp(b) : b;
          const pre = diffStats(A, B), post = diffStats(asSaved(A, S), asSaved(B, S));
          return { pre, post };
        });
      });
      if (fin !== base && fin !== result) put(fin);
      return out;
    }
    // Cached "as saved" view of the current result.
    function savedView(S) {
      if (!result) return null;
      const key = JSON.stringify(S);
      if (saved && savedKey === key) return saved;
      dropSaved();
      made = null;
      saved = asSaved(result, S); saved.pinned = true; savedKey = key;
      return saved;
    }

    // Draw a texture (result, saved view or base) on the visible canvas; base fills the split / original side.
    function show(mode, split, tex) {
      if (!base) return;
      const t = tex || result;
      if (canvas.width !== t.w || canvas.height !== t.h) { canvas.width = t.w; canvas.height = t.h; }
      made = null;
      pass(SH.show, t, { u_mode: mode, u_split: split }, { target: null, w: t.w, h: t.h, tex: { u_b: base } });
    }

    /* ---------- reading pixels for files ---------- */
    // Everything below reads with readPixels from our own framebuffers: rows come out top row first in
    // every browser, so files can't end up flipped.
    function fileSource(S) {
      // the image the file holds, before encoding: result resized to the export size
      made = null;
      return scoped(() => {
        const m = Math.max(result.w, result.h);
        return S.long && m > S.long ? resize(result, result.w * S.long / m, result.h * S.long / m, 'lanczos3') : pass(SH.copy, result);
      });
    }
    function prepareJpeg(S) {
      const t = fileSource(S); t.pinned = true;
      made = null;
      const co = scoped(() => jpegCoefs(t, S.q, S.sub, true));
      release(t);
      co.Y.pinned = co.C.pinned = true;
      return {
        info: co,
        readY: (y, rows) => readFloat(co.Y, 0, y, co.Wp, rows),
        readC: (y, rows) => readFloat(co.C, 0, y, co.C.w, rows),
        done: () => { release(co.Y); release(co.C); },
      };
    }
    function preparePng(S) {
      const t = fileSource(S); t.pinned = true;
      made = null;
      const deep = S.format === 'png16';
      const r = scoped(() => deep ? pass(SH.clamp01, t, {}, { fmt: 'f32' }) : pass(SH.q8, t, { u_dither: 1 }, { fmt: 'u8' }));
      release(t); r.pinned = true;
      return {
        w: r.w, h: r.h, deep,
        read: (y, rows) => deep ? readFloat(r, 0, y, r.w, rows) : readU8(r, 0, y, r.w, rows),
        done: () => release(r),
      };
    }

    function exportPixels() {
      made = null;
      const t = scoped(() => pass(SH.q8, result, { u_dither: 0 }, { fmt: 'u8' }));
      const buf = readU8(t, 0, 0, t.w, t.h);
      put(t);
      return new ImageData(new Uint8ClampedArray(buf.buffer), t.w, t.h);
    }

    return {
      gl, maxTex, load, loadStack, merge, setGeometry, frameOf, process, measure, savedView, show, exportPixels, prepareJpeg, preparePng,
      get size() { return [W, H]; }, get outSize() { return result ? [result.w, result.h] : [W, H]; },
      get source() { return src ? [src.w, src.h] : [0, 0]; }, get base() { return base; },
    };
  }

  return { create, LIB, SH, qtable, QBASE_Y, QBASE_C, DCTB };
})();

if (typeof module !== 'undefined') module.exports = GPU;
