'use strict';
/*
 * ie2 v5 — GPU core.
 * The image lives on the GPU as half-float RGBA textures. Every effect is a short chain of
 * full-screen fragment passes; intermediate textures come from a pool and go straight back to it.
 * Coordinates inside shaders: gl_FragCoord.y = 0 is the TOP row of the image (we never flip until
 * the final on-screen pass), so "top / bottom" in effects mean what they say.
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
vec3 toYcc(vec3 c) { return vec3(dot(c, vec3(.299, .587, .114)), dot(c, vec3(-.168736, -.331264, .5)), dot(c, vec3(.5, -.418688, -.081312))); }
vec3 fromYcc(vec3 y) { return vec3(y.x + 1.402 * y.z, y.x - .344136 * y.y - .714136 * y.z, y.x + 1.772 * y.y); }
vec3 yiq(vec3 c) { return vec3(dot(c, vec3(.299, .587, .114)), dot(c, vec3(.596, -.274, -.322)), dot(c, vec3(.211, -.523, .312))); }
vec3 unyiq(vec3 y) { return vec3(y.x + .956 * y.y + .621 * y.z, y.x - .272 * y.y - .647 * y.z, y.x - 1.106 * y.y + 1.703 * y.z); }
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
    show: `uniform sampler2D u_b; uniform float u_split, u_mode, u_dither;
void main() {
  vec2 uv = vec2(gl_FragCoord.x / u_res.x, 1. - gl_FragCoord.y / u_res.y);
  vec3 r = texture(u_src, uv).rgb, a = texture(u_b, uv).rgb;
  vec3 c = u_mode < .5 ? r : u_mode < 1.5 ? a : (uv.x < u_split ? a : r);
  c += u_dither * vec3(rnd(P(), 1.) + rnd(P(), 2.) - 1., rnd(P(), 3.) + rnd(P(), 4.) - 1., rnd(P(), 5.) + rnd(P(), 6.) - 1.) / 255.;
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
    out8: `uniform float u_dither;
void main() {
  vec2 p = P(); vec3 c = clamp(texelFetch(u_src, ivec2(p), 0).rgb, 0., 1.);
  vec3 n = vec3(rnd(p, 1.) + rnd(p, 2.) - 1., rnd(p, 3.) + rnd(p, 4.) - 1., rnd(p, 5.) + rnd(p, 6.) - 1.);
  o = vec4(clamp(c + u_dither * n / 255., 0., 1.), 1.);
}`,
  };

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
      return s;
    }

    /* ---------- image state ---------- */
    // src: the opened image. base: src after crop / rotate (what effects and comparisons start from).
    let src = null, base = null, result = null, W = 0, H = 0;
    function load(source, w, h) {
      if (result && result !== base) put(result);
      if (base && base !== src) destroy(base);
      if (src) destroy(src);
      drain();
      W = w; H = h;
      canvas.width = w; canvas.height = h;
      const up = makeTex(w, h, 'u8');
      gl.bindTexture(gl.TEXTURE_2D, up.tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
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
      canvas.width = W; canvas.height = H;
    }

    // chain: [{ fx, p }] in pipeline order
    function process(chain, seedValue) {
      if (!base) return 0;
      const t0 = performance.now();
      seed = seedValue | 0;
      if (result !== base) put(result);
      let cur = base;
      const ctx = { W, H, diag: Math.hypot(W, H), short: Math.min(W, H), pass, blur, get, put };
      for (const { fx, p } of chain) {
        made = [];
        let out;
        try { out = fx.run(ctx, cur, p) || cur; }
        catch (e) { made.forEach(put); made = null; throw new Error(fx.name + ': ' + e.message); }
        for (const t of made) if (t !== out) put(t);
        made = null;
        if (cur !== base && cur !== out) put(cur);
        cur = out;
      }
      result = cur;
      gl.finish();
      return performance.now() - t0;
    }

    function show(mode, split, dither) {
      if (!base) return;
      made = null;
      pass(SH.show, result, { u_mode: mode, u_split: split, u_dither: dither ? 1 : 0 }, { target: null, w: W, h: H, tex: { u_b: base } });
    }

    function exportPixels(dither) {
      made = null;
      const t = pass(SH.out8, result, { u_dither: dither ? 1 : 0 }, { fmt: 'u8' });
      const buf = new Uint8ClampedArray(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      put(t);
      return new ImageData(buf, W, H);
    }

    return { gl, maxTex, load, setGeometry, frameOf, process, show, exportPixels, get size() { return [W, H]; }, get source() { return src ? [src.w, src.h] : [0, 0]; } };
  }

  return { create, LIB, SH };
})();

if (typeof module !== 'undefined') module.exports = GPU;
