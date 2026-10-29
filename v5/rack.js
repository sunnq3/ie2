'use strict';
/*
 * ie2 v5 — the effect rack.
 * Each effect: id, group, name, info (one line), params, run(ctx, src, p) -> texture.
 * Effects run in the order listed here, which follows the path light takes:
 * optics -> sensor -> in-camera processing -> compression -> analog signal -> display.
 * Param types: range { min, max, step, d, u }, select { o: [[value, label]], d }, toggle { b: true, d }.
 */

const GROUPS = [
  ['optics', 'Optics & film'],
  ['sensor', 'Sensor'],
  ['proc', 'Processing'],
  ['comp', 'Compression & encoding'],
  ['analog', 'Analog video'],
  ['display', 'Display'],
];

// Standard JPEG (ITU T.81 Annex K) quantisation tables, natural order
const JPEG_QY = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const JPEG_QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99];
function jpegTable(base, q) {
  q = Math.min(100, Math.max(1, Math.round(q)));
  const s = q < 50 ? 5000 / q : 200 - 2 * q;
  return new Float32Array(base.map(v => Math.min(255, Math.max(1, Math.floor((v * s + 50) / 100)))));
}
const DCT_BASIS = new Float32Array(64);
for (let u = 0; u < 8; u++) for (let x = 0; x < 8; x++) DCT_BASIS[u * 8 + x] = (u === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos((2 * x + 1) * u * Math.PI / 16);

/* ------------------------------------------------------------------ shaders */

const S = {
  // ---- optics & film
  halaMask: `uniform float u_t;
void main() { float y = lumaL(lin(at(P()))); o = vec4(vec3(max(y - u_t, 0.) / (1. - u_t)), 1.); }`,
  halaAdd: `uniform sampler2D u_b; uniform float u_k;
void main() { vec3 c = lin(at(P())); float h = texture(u_b, UV()).r; o = vec4(srgb(c + u_k * 2.2 * h * vec3(1., .3, .08)), 1.); }`,

  cast: `uniform float u_k, u_t, u_off;
void main() {
  vec2 d = (P() - u_res * vec2(.5 + .22 * u_off, .5)) / (.5 * length(u_res));
  float f = u_k * pow(smoothstep(.12, 1.15, length(d)), 1.6);
  vec3 g = vec3(1.) + f * u_t * vec3(.24, -.32, .28);
  o = vec4(srgb(lin(at(P())) * max(g, 0.)), 1.);
}`,

  soft: `uniform sampler2D u_b, u_c; uniform float u_k, u_s;
void main() {
  float t = 2. * u_k * pow(smoothstep(u_s, 1., rad()), 1.4);
  vec3 c = at(P()), a = texture(u_b, UV()).rgb, b = texture(u_c, UV()).rgb;
  o = vec4(t < 1. ? mix(c, a, t) : mix(a, b, min(t - 1., 1.)), 1.);
}`,

  coma: `uniform float u_k, u_len, u_w;
void main() {
  vec2 p = P(), d = p - u_res * .5; float r = length(d) / (.5 * length(u_res));
  vec2 dir = length(d) > 0. ? normalize(d) : vec2(0.), per = vec2(-dir.y, dir.x);
  float L = u_len * r * r; vec3 acc = vec3(0.); float ws = 0.;
  for (int i = 1; i <= 24; i++) {
    float t = float(i) / 24., w = (1. - t) * (1. - t), side = (i % 2 == 0) ? 1. : -1.;
    acc += w * lin(at(p - dir * L * t + per * side * u_w * .5 * L * t * t)); ws += w;
  }
  float k = .9 * u_k * smoothstep(.15, .95, r);
  o = vec4(srgb(mix(lin(at(p)), acc / ws, k)), 1.);
}`,

  // ---- sensor
  rolling: `uniform float u_skew, u_wob, u_wf, u_fl, u_fp;
void main() {
  vec2 p = P(); float ny = p.y / u_res.y;
  float dx = u_skew * (ny - .5) + u_wob * sin(2. * PI * u_wf * ny + 1.3) * (.7 + .3 * sin(2. * PI * u_wf * .37 * ny + 4.1));
  vec3 c = lin(at(vec2(p.x - dx, p.y)));
  float band = 1. - u_fl * .6 * (.5 + .5 * cos(2. * PI * p.y / u_fp + float(int(u_seed) % 97)));
  o = vec4(srgb(c * band), 1.);
}`,

  clip: `uniform float u_e, u_soft;
void main() {
  vec3 x = lin(at(P())) * u_e;
  vec3 hard = min(x, vec3(1.)), x4 = x * x * x * x, soft = x / pow(1. + x4, vec3(.25));
  o = vec4(srgb(mix(hard, soft, u_soft)), 1.);
}`,

  crosstalk: `uniform float u_k;
void main() {
  ivec2 i = ivec2(P()); vec3 c = lin(px(i)), n = vec3(0.);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    if (x == 0 && y == 0) continue;
    n += ((x == 0 || y == 0) ? 1. : .5) * lin(px(i + ivec2(x, y)));
  }
  n /= 6.;
  vec3 other = .5 * vec3(n.g + n.b, n.r + n.b, n.r + n.g);
  float k = .35 * u_k;
  o = vec4(srgb(c * (1. - k) + k * other), 1.);
}`,

  ccdMask: `uniform float u_t;
void main() { o = vec4(vec3(smoothstep(u_t, 1., lumaL(lin(at(P()))))), 1.); }`,
  ccdCols: `void main() {
  int x = int(P().x), H = int(u_srcRes.y); float s = 0.;
  for (int y = 0; y < H; y++) s += texelFetch(u_src, ivec2(x, y), 0).r;
  o = vec4(vec3(s / float(H)), 1.);
}`,
  ccdAdd: `uniform sampler2D u_cs, u_bl; uniform float u_sm, u_bo;
void main() {
  vec3 c = lin(at(P()));
  float cs = texture(u_cs, vec2(UV().x, .5)).r, bl = texture(u_bl, UV()).r;
  float add = .5 * u_sm * min(1., cs * 3.) + .8 * u_bo * min(1., bl * 2.5);
  o = vec4(srgb(c + add * vec3(1., .985, .96)), 1.);
}`,

  pattern: `uniform float u_r, u_c, u_h, u_g, u_pd;
void main() {
  vec2 p = P(); vec3 c = lin(at(p));
  float row = (rnd(vec2(0., p.y), 11.) - .5) + .5 * (rnd(vec2(0., floor(p.y / 4.)), 12.) - .5);
  float col = rnd(vec2(p.x, 0.), 13.) - .5;
  vec3 add = vec3(.004 * u_r * row + .003 * u_c * col);
  add += .0015 * u_r * vec3(rnd(vec2(1., p.y), 14.) - .5, 0., rnd(vec2(2., p.y), 15.) - .5);
  if (rnd(p, 16.) < u_h * .0008) {
    float ch = rnd(p, 17.);
    add += (ch < .33 ? vec3(1., .1, .1) : ch < .66 ? vec3(.1, 1., .1) : vec3(.15, .15, 1.)) * (.25 + .75 * rnd(p, 18.)) + .1;
  }
  vec2 q = (p - vec2(u_res.x, u_res.y * .5)) / u_res.y;
  add += u_g * exp(-length(q * vec2(1., .55)) * 5.) * vec3(.06, .022, .05);
  float m = mod(p.y - .5, 6.);
  if (m < 1.) add += u_pd * (c * .08 + .002);
  o = vec4(srgb(max(c + add, 0.)), 1.);
}`,

  noise: `uniform float u_a, u_r, u_ch;
void main() {
  vec2 p = P(); vec3 c = lin(at(p));
  vec3 n = mix(vec3(gss(p, 24.)), vec3(gss(p, 21.), gss(p, 22.), gss(p, 23.)), u_ch);
  vec3 sd = sqrt(.0004 * u_a * u_a * max(c, 0.) + pow(.004 * u_a * u_r, 2.) * vec3(1.3, 1., 1.6));
  o = vec4(srgbS(c + n * sd), 1.);
}`,

  demosaic: `uniform float u_k, u_near, u_gi;
int cfa(ivec2 i) { return (i.y & 1) == 0 ? ((i.x & 1) == 0 ? 0 : 1) : ((i.x & 1) == 0 ? 1 : 2); }
void main() {
  ivec2 i = ivec2(P()), mx = ivec2(u_srcRes) - 1; int c0 = cfa(i);
  float sm[3] = float[3](0., 0., 0.), ct[3] = float[3](0., 0., 0.), nr[3] = float[3](0., 0., 0.);
  bool fd[3] = bool[3](false, false, false);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    ivec2 j = clamp(i + ivec2(x, y), ivec2(0), mx); int c = cfa(j);
    if (c == c0 && (x != 0 || y != 0)) continue;
    vec3 v = lin(texelFetch(u_src, j, 0).rgb);
    float s = c == 0 ? v.r : c == 1 ? v.g : v.b;
    if (c == 1) s *= 1. + u_gi * .04 * ((j.y & 1) == 0 ? 1. : -1.);
    sm[c] += s; ct[c] += 1.;
    if (!fd[c]) { nr[c] = s; fd[c] = true; }
  }
  vec3 bi = vec3(sm[0] / max(ct[0], 1.), sm[1] / max(ct[1], 1.), sm[2] / max(ct[2], 1.));
  vec3 r = u_near > .5 ? vec3(nr[0], nr[1], nr[2]) : bi;
  vec3 c = px(i);
  o = vec4(mix(c, srgb(r), u_k), 1.);
}`,

  // ---- processing
  ghost: `uniform float u_k, u_dx, u_dy, u_patch;
void main() {
  vec2 p = P(); vec3 a = lin(at(p)), b = lin(at(p - vec2(u_dx, u_dy)));
  float m = 1.;
  if (u_patch > .5) { float n = .65 * vnoise(p / 90., 31.) + .35 * vnoise(p / 23., 32.); m = smoothstep(.44, .6, n); }
  o = vec4(srgb(mix(a, b, u_k * m)), 1.);
}`,

  // barrel lens: distorted radius rd = ru (1 - k ru^2) / (1 - k), corners stay put.
  // pass 1 records the scene through the lens (corners squeezed onto fewer pixels, box-filtered)
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
  // pass 2: the profile correction stretches them back (geometry restored, corner detail is not)
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

  sharpen: `uniform sampler2D u_b; uniform float u_k;
void main() { vec3 c = at(P()); o = vec4(c + u_k * (luma(c) - luma(texture(u_b, UV()).rgb)), 1.); }`,

  // ---- compression
  toLin: `void main() { o = vec4(lin(at(P())), 1.); }`,
  toSrgb: `void main() { o = vec4(srgb(at(P())), 1.); }`,
  resample: `uniform int u_axis, u_kern; uniform float u_scale;
float K(float x) {
  x = abs(x);
  if (u_kern == 1) return max(0., 1. - x);
  if (u_kern == 2) return x < 1. ? (1.5 * x - 2.5) * x * x + 1. : x < 2. ? ((-.5 * x + 2.5) * x - 4.) * x + 2. : 0.;
  if (x < 1e-5) return 1.; if (x >= 3.) return 0.;
  float a = PI * x; return 3. * sin(a) * sin(a / 3.) / (a * a);
}
void main() {
  ivec2 q = ivec2(P()); float i = u_axis == 0 ? P().x : P().y, c = i / u_scale;
  if (u_kern == 0) { int j = int(floor(c)); o = vec4(px(u_axis == 0 ? ivec2(j, q.y) : ivec2(q.x, j)), 1.); return; }
  float fs = u_scale < 1. ? 1. / u_scale : 1., sup = (u_kern == 1 ? 1. : u_kern == 2 ? 2. : 3.) * fs;
  vec3 s = vec3(0.); float ws = 0.;
  for (int j = int(floor(c - sup)); j <= int(ceil(c + sup)); j++) {
    float w = K((float(j) + .5 - c) / fs);
    s += w * px(u_axis == 0 ? ivec2(j, q.y) : ivec2(q.x, j)); ws += w;
  }
  o = vec4(s / ws, 1.);
}`,

  subsample: `uniform ivec2 u_b; uniform float u_lin;
vec2 blk(ivec2 bi) {
  vec2 s = vec2(0.);
  for (int y = 0; y < 4; y++) { if (y >= u_b.y) break; for (int x = 0; x < 4; x++) { if (x >= u_b.x) break; s += toYcc(px(bi * u_b + ivec2(x, y))).yz; } }
  return s / float(u_b.x * u_b.y);
}
void main() {
  vec3 y = toYcc(at(P())); vec2 ch;
  if (u_lin < .5) ch = blk(ivec2(P()) / u_b);
  else {
    vec2 f = P() / vec2(u_b) - .5, b0 = floor(f), t = f - b0; ivec2 B = ivec2(b0);
    ch = mix(mix(blk(B), blk(B + ivec2(1, 0)), t.x), mix(blk(B + ivec2(0, 1)), blk(B + ivec2(1, 1)), t.x), t.y);
  }
  o = vec4(fromYcc(vec3(y.x, ch)), 1.);
}`,

  // forward DCT: writes the coefficient grid (grid = image shifted by 8 - offset, so every block is whole)
  jpegF: `uniform float u_T[64]; uniform ivec2 u_off;
void main() {
  ivec2 g = ivec2(P()), l = g & 7, b = g - l + u_off - 8; vec3 s = vec3(0.);
  for (int y = 0; y < 8; y++) {
    float ty = u_T[l.y * 8 + y];
    for (int x = 0; x < 8; x++) s += ty * u_T[l.x * 8 + x] * (toYcc(clamp(px(b + ivec2(x, y)), 0., 1.)) * 255. - vec3(128., 0., 0.));
  }
  o = vec4(s, 1.);
}`,
  // quantise + inverse DCT back to an image, rounded to 8 bits like a decoder
  jpegI: `uniform float u_T[64], u_QY[64], u_QC[64]; uniform ivec2 u_off;
void main() {
  ivec2 g = ivec2(P()) - u_off + 8, l = g & 7, b = g - l; vec3 s = vec3(0.);
  for (int v = 0; v < 8; v++) for (int u = 0; u < 8; u++) {
    int k = v * 8 + u;
    vec3 C = texelFetch(u_src, b + ivec2(u, v), 0).rgb, q = vec3(u_QY[k], u_QC[k], u_QC[k]);
    s += u_T[u * 8 + l.x] * u_T[v * 8 + l.y] * round(C / q) * q;
  }
  vec3 rgb = clamp(fromYcc((s + vec3(128., 0., 0.)) / 255.), 0., 1.);
  o = vec4(round(rgb * 255.) / 255., 1.);
}`,

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
  vec3 c = at(p - mv) + .3 * (at(bc) - at(bc - mv));
  o = vec4(c, 1.);
}`,

  // ---- analog
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

  composite: `uniform float u_rb, u_dc;
void main() {
  vec2 p = P(); float x = p.x - .5, y = p.y - .5;
  float l0 = luma(at(p - vec2(2., 0.))), l1 = luma(at(p - vec2(1., 0.))), l2 = luma(at(p)), l3 = luma(at(p + vec2(1., 0.))), l4 = luma(at(p + vec2(2., 0.)));
  float hp = l2 - (l0 + l1 + l2 + l3 + l4) / 5., ph = PI * .5 * x + PI * y;
  vec3 q = yiq(at(p));
  q.yz += u_rb * 1.4 * hp * vec2(cos(ph), sin(ph));
  vec3 a = yiq(at(p - vec2(1., 0.))), b = yiq(at(p + vec2(1., 0.)));
  q.x += u_dc * .5 * length(b.yz - a.yz) * cos(PI * (x + y));
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

  // ---- display
  subpixel: `uniform float u_k, u_bgr;
float tap(vec2 p, float off, int ch) {
  float w[5] = float[5](1., 2., 3., 2., 1.), s = 0.;
  for (int i = 0; i < 5; i++) s += w[i] * at(p + vec2(off + float(i - 2) / 3., 0.))[ch];
  return s / 9.;
}
void main() {
  vec2 p = P(); float d = (u_bgr > .5 ? -1. : 1.) / 3.;
  o = vec4(mix(at(p), vec3(tap(p, -d, 0), tap(p, 0., 1), tap(p, d, 2)), u_k), 1.);
}`,

  pentile: `uniform float u_k;
void main() {
  ivec2 i = ivec2(P()); vec3 c = px(i), l = px(i - ivec2(1, 0)), r = px(i + ivec2(1, 0)), pc = c;
  if (((i.x + i.y) & 1) == 0) pc.b = .5 * (l.b + r.b); else pc.r = .5 * (l.r + r.r);
  o = vec4(mix(c, pc, u_k), 1.);
}`,

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

/* ------------------------------------------------------------------ effects */

const range = (k, l, min, max, step, d, u = '') => ({ k, l, min, max, step, d, u });
const pick = (k, l, o, d) => ({ k, l, o, d });
const toggle = (k, l, d) => ({ k, l, b: true, d });

const EFFECTS = [
  /* ---------------- optics & film */
  { id: 'halation', group: 'optics', name: 'Halation',
    info: 'Red-orange glow around highlights: light bouncing off the film base back into the red layer.',
    params: [range('amount', 'Amount', 0, 2, 0.01, 0.6), range('radius', 'Radius', 0.1, 4, 0.05, 1.2, '%'), range('thr', 'Threshold', 0.3, 0.98, 0.01, 0.72)],
    run(c, s, p) {
      const m = c.pass(S.halaMask, s, { u_t: p.thr });
      return c.pass(S.halaAdd, s, { u_k: p.amount }, { tex: { u_b: c.blur(m, p.radius / 100 * c.diag) } });
    } },
  { id: 'cast', group: 'optics', name: 'Colour shading',
    info: 'Magenta or green tint creeping in from the edges, from light hitting the sensor at steep angles.',
    params: [range('amount', 'Amount', 0, 1, 0.01, 0.5), range('tint', 'Green ↔ magenta', -1, 1, 0.01, 0.6), range('off', 'Off-centre', -1, 1, 0.01, 0.2)],
    run(c, s, p) { return c.pass(S.cast, s, { u_k: p.amount, u_t: p.tint, u_off: p.off }); } },
  { id: 'soft', group: 'optics', name: 'Field curvature',
    info: 'Corners drift out of focus because the plane of sharp focus is curved.',
    params: [range('amount', 'Amount', 0, 1, 0.01, 0.6), range('px', 'Blur', 0.5, 12, 0.1, 3, 'px'), range('start', 'Sharp zone', 0, 0.9, 0.01, 0.35)],
    run(c, s, p) { return c.pass(S.soft, s, { u_k: p.amount, u_s: p.start }, { tex: { u_b: c.blur(s, p.px * 0.45), u_c: c.blur(s, p.px) } }); } },
  { id: 'coma', group: 'optics', name: 'Sagittal coma',
    info: 'Points of light near the corners flare outward into comet / seagull shapes.',
    params: [range('amount', 'Amount', 0, 1, 0.01, 0.65), range('len', 'Tail length', 2, 120, 0.5, 40, 'px'), range('wing', 'Wing spread', 0, 1, 0.01, 0.5)],
    run(c, s, p) { return c.pass(S.coma, s, { u_k: p.amount, u_len: p.len, u_w: p.wing }); } },

  /* ---------------- sensor */
  { id: 'rolling', group: 'sensor', name: 'Rolling shutter',
    info: 'Rows are read top to bottom: skew, jello wobble and flicker bands under LED / fluorescent light.',
    params: [range('skew', 'Skew', -300, 300, 1, 60, 'px'), range('wobble', 'Wobble', 0, 40, 0.1, 0, 'px'), range('wfreq', 'Wobble rate', 0.5, 30, 0.1, 6),
      range('flicker', 'Flicker bands', 0, 1, 0.01, 0), range('period', 'Band spacing', 4, 600, 1, 90, 'rows')],
    run(c, s, p) { return c.pass(S.rolling, s, { u_skew: p.skew, u_wob: p.wobble, u_wf: p.wfreq, u_fl: p.flicker, u_fp: p.period }); } },
  { id: 'clip', group: 'sensor', name: 'Channel clipping',
    info: 'Each colour channel saturates on its own, so bright colours shift hue: skies go cyan, skin yellow, red lights orange.',
    params: [range('push', 'Exposure push', 0, 4, 0.05, 1, 'EV'), range('soft', 'Per-channel roll-off', 0, 1, 0.01, 0)],
    run(c, s, p) { return c.pass(S.clip, s, { u_e: Math.pow(2, p.push), u_soft: p.soft }); } },
  { id: 'crosstalk', group: 'sensor', name: 'Pixel crosstalk',
    info: 'Light and charge leak into neighbouring photosites: duller colour and faint colour bleed at edges.',
    params: [range('amount', 'Amount', 0, 1, 0.01, 0.4)],
    run(c, s, p) { return c.pass(S.crosstalk, s, { u_k: p.amount }); } },
  { id: 'ccd', group: 'sensor', name: 'CCD smear & blooming',
    info: 'Bright sources bleed a vertical streak through the whole frame and spill charge up and down.',
    params: [range('smear', 'Smear', 0, 1, 0.01, 0.3), range('bloom', 'Blooming', 0, 1, 0.01, 0.4), range('len', 'Bloom length', 2, 200, 1, 40, 'px'), range('thr', 'Threshold', 0.5, 0.99, 0.01, 0.88)],
    run(c, s, p) {
      const m = c.pass(S.ccdMask, s, { u_t: p.thr });
      const cols = c.pass(S.ccdCols, m, {}, { w: m.w, h: 1 });
      return c.pass(S.ccdAdd, s, { u_sm: p.smear, u_bo: p.bloom }, { tex: { u_cs: cols, u_bl: c.blur(m, p.len, 'y') } });
    } },
  { id: 'pattern', group: 'sensor', name: 'Fixed-pattern noise',
    info: 'Row and column banding, hot pixels, amp glow at one edge, and PDAF striping in bright areas.',
    params: [range('rows', 'Row banding', 0, 1, 0.01, 0.3), range('cols', 'Column banding', 0, 1, 0.01, 0.2), range('hot', 'Hot pixels', 0, 1, 0.01, 0.2),
      range('glow', 'Amp glow', 0, 1, 0.01, 0), range('pdaf', 'PDAF stripes', 0, 1, 0.01, 0)],
    run(c, s, p) { return c.pass(S.pattern, s, { u_r: p.rows, u_c: p.cols, u_h: p.hot, u_g: p.glow, u_pd: p.pdaf }); } },
  { id: 'noise', group: 'sensor', name: 'Sensor noise',
    info: 'Photon shot noise plus a read-noise floor that builds up in the shadows.',
    params: [range('amount', 'Amount', 0, 3, 0.01, 0.6), range('shadows', 'Shadow noise', 0, 3, 0.01, 1), range('chroma', 'Colour noise', 0, 1, 0.01, 0.5)],
    run(c, s, p) { return c.pass(S.noise, s, { u_a: p.amount, u_r: p.shadows, u_ch: p.chroma }); } },
  { id: 'demosaic', group: 'sensor', name: 'Demosaic artifacts',
    info: 'Re-records the image through an RGGB Bayer filter and a crude demosaic: zipper edges, false colour, maze patterns.',
    params: [range('amount', 'Amount', 0, 1, 0.01, 1), pick('method', 'Demosaic', [['bilinear', 'Bilinear (zipper + false colour)'], ['nearest', 'Nearest (blocky colour)']], 'bilinear'),
      range('imbalance', 'Green imbalance', 0, 1, 0.01, 0.2)],
    run(c, s, p) { return c.pass(S.demosaic, s, { u_k: p.amount, u_near: p.method === 'nearest', u_gi: p.imbalance }); } },

  /* ---------------- processing */
  { id: 'ghost', group: 'proc', name: 'HDR ghosting',
    info: 'A multi-frame merge leaves a semi-transparent duplicate, whole or in patchy de-ghosting seams.',
    params: [range('opacity', 'Opacity', 0, 1, 0.01, 0.35), range('dx', 'Offset X', -80, 80, 0.5, 18, 'px'), range('dy', 'Offset Y', -80, 80, 0.5, 4, 'px'),
      pick('mode', 'Shape', [['patchy', 'Patchy seams'], ['whole', 'Whole frame']], 'patchy')],
    run(c, s, p) { return c.pass(S.ghost, s, { u_k: p.opacity, u_dx: p.dx, u_dy: p.dy, u_patch: p.mode === 'patchy' }); } },
  { id: 'profile', group: 'proc', name: 'Lens-profile correction',
    info: 'Barrel distortion corrected in software: lines stay straight, but stretched corners go soft and a 1-px colour fringe can remain.',
    params: [range('amount', 'Correction', 0, 0.3, 0.005, 0.15), pick('interp', 'Resampling', [['linear', 'Bilinear'], ['nearest', 'Nearest']], 'linear'),
      range('resid', 'Residual CA', -1, 1, 0.01, 0)],
    run(c, s, p) {
      if (!(p.amount > 0) && !p.resid) return s;
      const d = c.pass(S.lensIn, s, { u_k: p.amount });
      return c.pass(S.lensOut, d, { u_k: p.amount, u_near: p.interp === 'nearest', u_ca: p.resid });
    } },
  { id: 'nr', group: 'proc', name: 'Noise-reduction smear',
    info: 'Edge-preserving noise reduction wipes fine texture into flat, waxy "watercolour" patches.',
    params: [range('strength', 'Strength', 0, 1, 0.01, 0.6), range('radius', 'Radius', 1, 6, 1, 3, 'px'), range('passes', 'Passes', 1, 4, 1, 2)],
    run(c, s, p) {
      let t = s;
      for (let i = 0; i < p.passes; i++) t = c.pass(S.bilateral, t, { u_r: { i: Math.round(p.radius) }, u_sr: 0.015 + 0.2 * p.strength });
      return t;
    } },
  { id: 'blotch', group: 'proc', name: 'Chroma blotches',
    info: 'Colour noise averaged by chroma NR into large, soft colour stains, worst in the shadows.',
    params: [range('amount', 'Amount', 0, 1, 0.01, 0.5), range('size', 'Blotch size', 4, 80, 1, 18, 'px'), range('shadows', 'Shadow bias', 0, 1, 0.01, 0.7)],
    run(c, s, p) { return c.pass(S.blotch, s, { u_k: p.amount, u_sz: p.size, u_sh: p.shadows }); } },
  { id: 'local', group: 'proc', name: 'Tone-mapping halos',
    info: 'HDR-style local contrast: glowing borders around dark objects against bright skies.',
    params: [range('amount', 'Local contrast', 0, 2, 0.01, 0.8), range('radius', 'Radius', 1, 20, 0.1, 6, '%'), range('flatten', 'Flatten', 0, 1, 0.01, 0.3)],
    run(c, s, p) { return c.pass(S.local, s, { u_k: p.amount, u_fl: p.flatten }, { tex: { u_b: c.blur(s, p.radius / 100 * c.short) } }); } },
  { id: 'sharpen', group: 'proc', name: 'Over-sharpening',
    info: 'Unsharp mask pushed too far: bright and dark outlines (overshoot halos) along every edge.',
    params: [range('amount', 'Amount', 0, 4, 0.01, 1.5), range('radius', 'Radius', 0.4, 4, 0.05, 1.4, 'px')],
    run(c, s, p) { return c.pass(S.sharpen, s, { u_k: p.amount }, { tex: { u_b: c.blur(s, p.radius) } }); } },

  /* ---------------- compression & encoding */
  { id: 'resize', group: 'comp', name: 'Resize round-trip',
    info: 'Shrinks and re-enlarges the image: ringing from sharp kernels, and, in gamma space, darkened fine detail.',
    params: [range('factor', 'Shrink by', 1, 8, 0.05, 2.5, '×'), pick('kernel', 'Kernel', [['lanczos3', 'Lanczos 3 (ringing)'], ['bicubic', 'Bicubic'], ['bilinear', 'Bilinear'], ['nearest', 'Nearest (aliasing)']], 'lanczos3'),
      toggle('linear', 'Resize in linear light (correct)', false)],
    run(c, s, p) {
      const K = { nearest: 0, bilinear: 1, bicubic: 2, lanczos3: 3 }[p.kernel];
      const sw = Math.max(1, Math.round(s.w / p.factor)), sh = Math.max(1, Math.round(s.h / p.factor));
      let t = p.linear ? c.pass(S.toLin, s) : s;
      t = c.pass(S.resample, t, { u_axis: { i: 0 }, u_kern: { i: K }, u_scale: sw / s.w }, { w: sw, h: s.h });
      t = c.pass(S.resample, t, { u_axis: { i: 1 }, u_kern: { i: K }, u_scale: sh / s.h }, { w: sw, h: sh });
      t = c.pass(S.resample, t, { u_axis: { i: 0 }, u_kern: { i: K }, u_scale: s.w / sw }, { w: s.w, h: sh });
      t = c.pass(S.resample, t, { u_axis: { i: 1 }, u_kern: { i: K }, u_scale: s.h / sh }, { w: s.w, h: s.h });
      return p.linear ? c.pass(S.toSrgb, t) : t;
    } },
  { id: 'subsample', group: 'comp', name: 'Chroma subsampling',
    info: 'Colour stored at reduced resolution: saturated red and blue bleed past edges (red text on black).',
    params: [pick('mode', 'Scheme', [['420', '4:2:0'], ['422', '4:2:2'], ['411', '4:1:1'], ['410', '4:1:0']], '420'),
      pick('up', 'Upsampling', [['nearest', 'Nearest (blocky)'], ['linear', 'Bilinear (smeared)']], 'nearest')],
    run(c, s, p) {
      const b = { 420: [2, 2], 422: [2, 1], 411: [4, 1], 410: [4, 2] }[p.mode];
      return c.pass(S.subsample, s, { u_b: { i: b }, u_lin: p.up === 'linear' });
    } },
  { id: 'jpeg', group: 'comp', name: 'JPEG compression',
    info: 'Real 8×8 DCT quantisation: blocking, mosquito noise and ringing. Generations re-save it again and again.',
    params: [range('quality', 'Quality', 1, 100, 1, 30), range('gens', 'Generations', 1, 20, 1, 1), toggle('shift', 'Re-crop between saves', true)],
    run(c, s, p) {
      const qy = jpegTable(JPEG_QY, p.quality), qc = jpegTable(JPEG_QC, p.quality);
      const gw = Math.ceil((s.w + 8) / 8) * 8, gh = Math.ceil((s.h + 8) / 8) * 8;
      let t = s;
      for (let g = 0; g < p.gens; g++) {
        const off = p.shift && g > 0 ? [(g * 3) % 8, (g * 5) % 8] : [0, 0];
        const coef = c.pass(S.jpegF, t, { u_T: DCT_BASIS, u_off: { i: off } }, { w: gw, h: gh, fmt: 'f32' });
        t = c.pass(S.jpegI, coef, { u_T: DCT_BASIS, u_QY: qy, u_QC: qc, u_off: { i: off } }, { w: s.w, h: s.h });
      }
      return t;
    } },
  { id: 'posterize', group: 'comp', name: 'Banding / posterize',
    info: 'Too few bits per channel: smooth gradients break into visible steps. Dithering trades steps for pattern.',
    params: [range('bits', 'Bits per channel', 1, 8, 1, 5, 'bit'), pick('space', 'Quantise in', [['gamma', 'Gamma (sRGB)'], ['linear', 'Linear (crushed shadows)']], 'gamma'),
      pick('dither', 'Dither', [['none', 'None'], ['ordered', 'Ordered (Bayer 4×4)'], ['noise', 'Noise']], 'none')],
    run(c, s, p) { return c.pass(S.posterize, s, { u_L: Math.pow(2, p.bits), u_lin: p.space === 'linear', u_d: { none: 0, ordered: 1, noise: 2 }[p.dither] }); } },
  { id: 'mosh', group: 'comp', name: 'Datamosh',
    info: 'Motion vectors applied to the wrong picture: macroblocks slide and drag old colour with them.',
    params: [range('amount', 'Coverage', 0, 1, 0.01, 0.35), range('motion', 'Motion', 0, 120, 0.5, 40, 'px'), pick('block', 'Macroblock', [['8', '8 px'], ['16', '16 px'], ['32', '32 px']], '16'),
      range('steps', 'Frames carried', 1, 8, 1, 3)],
    run(c, s, p) { return c.pass(S.mosh, s, { u_k: p.amount, u_mv: p.motion, u_bs: +p.block, u_st: p.steps }); } },

  /* ---------------- analog video */
  { id: 'vhs', group: 'analog', name: 'VHS colour',
    info: 'Soft luma, colour smeared sideways and arriving late, an edge-enhancer ring and streaky chroma noise.',
    params: [range('luma', 'Luma softness', 0, 4, 0.05, 1.2, 'px'), range('bleed', 'Chroma bleed', 0, 30, 0.1, 10, 'px'), range('delay', 'Chroma delay', -10, 20, 0.1, 4, 'px'),
      range('ring', 'Edge ring', 0, 2, 0.01, 0.5), range('cnoise', 'Chroma noise', 0, 1, 0.01, 0.3)],
    run(c, s, p) { return c.pass(S.vhs, s, { u_ls: p.luma, u_cb: p.bleed, u_cd: p.delay, u_ring: p.ring, u_cn: p.cnoise }); } },
  { id: 'composite', group: 'analog', name: 'Composite artifacts',
    info: 'Fine stripes decoded as rainbow colour, and crawling checkerboard dots along colour edges.',
    params: [range('rainbow', 'Rainbowing', 0, 2, 0.01, 0.8), range('crawl', 'Dot crawl', 0, 2, 0.01, 0.6)],
    run(c, s, p) { return c.pass(S.composite, s, { u_rb: p.rainbow, u_dc: p.crawl }); } },
  { id: 'tape', group: 'analog', name: 'Tape damage',
    info: 'Head-switching tear at the bottom, a tracking-noise band, timebase jitter and oxide dropouts.',
    params: [range('head', 'Head switching', 0, 1, 0.01, 0.5), range('tracking', 'Tracking noise', 0, 1, 0.01, 0), range('pos', 'Tracking position', 0, 1, 0.01, 0.35),
      range('jitter', 'Line jitter', 0, 1, 0.01, 0.2), range('dropouts', 'Dropouts', 0, 1, 0.01, 0.2)],
    run(c, s, p) { return c.pass(S.tape, s, { u_hs: p.head, u_tr: p.tracking, u_tp: p.pos, u_j: p.jitter, u_do: p.dropouts }); } },

  /* ---------------- display */
  { id: 'subpixel', group: 'display', name: 'Subpixel rendering',
    info: 'ClearType-style: each channel sampled at its own stripe position, leaving colour fringes on vertical edges.',
    params: [range('amount', 'Amount', 0, 1, 0.01, 1), pick('order', 'Stripe order', [['rgb', 'RGB'], ['bgr', 'BGR']], 'rgb')],
    run(c, s, p) { return c.pass(S.subpixel, s, { u_k: p.amount, u_bgr: p.order === 'bgr' }); } },
  { id: 'pentile', group: 'display', name: 'PenTile fringing',
    info: 'Red and blue at half resolution in a diamond layout: green / magenta edges on text and fine lines.',
    params: [range('amount', 'Amount', 0, 1, 0.01, 1)],
    run(c, s, p) { return c.pass(S.pentile, s, { u_k: p.amount }); } },
  { id: 'converge', group: 'display', name: 'CRT misconvergence',
    info: 'The three electron beams miss each other: real RGB offsets that grow toward the screen edges.',
    params: [range('x', 'Horizontal', -4, 4, 0.05, 1.2, 'px'), range('y', 'Vertical', -4, 4, 0.05, 0.4, 'px'), range('edge', 'Edge growth', 0, 4, 0.05, 1.5, 'px')],
    run(c, s, p) { return c.pass(S.converge, s, { u_d: [p.x, p.y], u_e: p.edge }); } },
  { id: 'dlp', group: 'display', name: 'DLP rainbow',
    info: 'Colour-sequential break-up: highlights leave red, green and blue trails as the eye moves.',
    params: [range('amount', 'Amount', 0, 2, 0.01, 0.8), range('len', 'Trail length', 2, 60, 0.5, 14, 'px'), range('angle', 'Direction', 0, 360, 1, 0, '°'), range('thr', 'Threshold', 0.2, 0.98, 0.01, 0.6)],
    run(c, s, p) { return c.pass(S.dlp, s, { u_k: p.amount, u_len: p.len, u_ang: p.angle, u_t: p.thr }); } },
  { id: 'smear', group: 'display', name: 'LCD smear & overdrive',
    info: 'Slow pixel transitions: dark trails behind moving edges, and bright overdrive overshoot.',
    params: [range('smear', 'Black smear', 0, 1, 0.01, 0.6), range('len', 'Trail length', 2, 60, 0.5, 16, 'px'), range('od', 'Overdrive', 0, 1, 0.01, 0.3),
      pick('dir', 'Motion', [['1', 'Trail to the right'], ['-1', 'Trail to the left']], '1')],
    run(c, s, p) { return c.pass(S.smear, s, { u_k: p.smear, u_len: p.len, u_od: p.od, u_dir: +p.dir }); } },
  { id: 'crt', group: 'display', name: 'Phosphor mask & scanlines',
    info: 'Aperture grille, slot or shadow mask (or an LCD screen-door grid) and beam scanlines that thicken in bright areas.',
    params: [range('mask', 'Mask', 0, 1, 0.01, 0.6), pick('type', 'Mask type', [['0', 'Aperture grille'], ['1', 'Slot mask'], ['2', 'Shadow mask'], ['3', 'Screen door']], '0'),
      range('pitch', 'Pitch', 2, 9, 1, 3, 'px'), range('scan', 'Scanlines', 0, 1, 0.01, 0.5), range('line', 'Line height', 2, 12, 0.5, 4, 'px'), range('bloom', 'Beam bloom', 0, 1, 0.01, 0.5)],
    run(c, s, p) { return c.pass(S.crt, s, { u_m: p.mask, u_type: +p.type, u_pitch: p.pitch, u_s: p.scan, u_lh: p.line, u_bw: p.bloom }); } },
];

/* ------------------------------------------------------------------ presets */
// Each preset switches on the listed effects (others off); unlisted params keep their defaults.
const PRESETS = [
  ['Early-2000s digicam', { crosstalk: { amount: 0.45 }, clip: { push: 0.4 }, demosaic: { imbalance: 0.4 }, noise: { amount: 0.7, shadows: 1.2, chroma: 0.7 },
    blotch: { amount: 0.6, size: 14 }, sharpen: { amount: 1.8, radius: 1.2 }, subsample: {}, jpeg: { quality: 62 } }],
  ['Phone night mode', { noise: { amount: 1.1, shadows: 1.5, chroma: 0.6 }, ghost: { opacity: 0.25, dx: 14, dy: 3 }, nr: { strength: 0.75, radius: 4, passes: 2 },
    blotch: { amount: 0.5, size: 30, shadows: 1 }, local: { amount: 0.9, radius: 5, flatten: 0.45 }, sharpen: { amount: 1.2, radius: 1.6 }, jpeg: { quality: 80 } }],
  ['Re-shared ten times', { resize: { factor: 1.6, kernel: 'bicubic' }, subsample: {}, jpeg: { quality: 58, gens: 10 }, sharpen: { amount: 0.6, radius: 1 } }],
  ['Webcam under LEDs', { rolling: { skew: 0, flicker: 0.35, period: 70 }, pattern: { rows: 0.6, cols: 0.2, hot: 0 }, noise: { amount: 0.9, shadows: 1.3 },
    nr: { strength: 0.4, radius: 2, passes: 1 }, subsample: {}, jpeg: { quality: 45 } }],
  ['CCD long exposure', { ccd: { smear: 0.7, bloom: 0.6, len: 60, thr: 0.85 }, pattern: { rows: 0.5, cols: 0.6, hot: 0.8, glow: 0.8 }, noise: { amount: 0.5, shadows: 1.8, chroma: 0.4 } }],
  ['VHS dub', { resize: { factor: 2.2, kernel: 'bilinear' }, noise: { amount: 0.4, shadows: 0.6, chroma: 0.2 }, vhs: { luma: 1.6, bleed: 12, delay: 5, ring: 0.7, cnoise: 0.5 },
    composite: { rainbow: 1, crawl: 0.7 }, tape: { head: 0.8, tracking: 0.3, pos: 0.2, jitter: 0.4, dropouts: 0.4 } }],
  ['CRT arcade', { halation: { amount: 0.35, radius: 0.6, thr: 0.6 }, converge: { x: 1.4, y: 0.3, edge: 1.5 }, crt: { mask: 0.65, scan: 0.6, line: 4, bloom: 0.6 } }],
  ['Cheap LCD, photographed', { subpixel: {}, smear: { smear: 0.5, len: 14, od: 0.4 }, crt: { mask: 0.4, type: '3', pitch: 3, scan: 0 } }],
  ['Film scan', { halation: { amount: 0.7, radius: 1, thr: 0.72 }, soft: { amount: 0.5, px: 3, start: 0.4 }, coma: { amount: 0.5, len: 30 }, cast: { amount: 0.2, tint: 0.4, off: 0.1 },
    noise: { amount: 0.5, shadows: 0.6, chroma: 0.25 } }],
  ['Wide-angle on digital', { cast: { amount: 0.6, tint: 0.7, off: 0.3 }, soft: { amount: 0.5, px: 2.5, start: 0.45 }, coma: { amount: 0.6, len: 36, wing: 0.6 },
    profile: { amount: 0.2, resid: 0.6 } }],
];

if (typeof module !== 'undefined') module.exports = { GROUPS, EFFECTS, PRESETS, S, jpegTable, DCT_BASIS };
