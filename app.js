'use strict';
/* FunCam — everything happens on this device. No server, no uploads, no analytics. */

const $ = (s, r = document) => r.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nextFrame = () => new Promise(r => requestAnimationFrame(r));
function h(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids) e.append(kid);
  return e;
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const fmtTime = ms => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

/* ---------------------------------------------------------------- settings */
const DEFAULTS = { quality: 'standard', fit: true, autoSave: true, micId: 'auto', cleanup: false, facing: 'user', filter: 'none', voice: 'original', mode: 'photo' };
let settings = Object.assign({}, DEFAULTS);
try { Object.assign(settings, JSON.parse(localStorage.getItem('fc_settings2') || '{}')); } catch (e) {}
const saveSettings = () => { try { localStorage.setItem('fc_settings2', JSON.stringify(settings)); } catch (e) {} };

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function askConfirm(text, yes = 'OK') {
  return new Promise(res => {
    $('#confirmText').textContent = text;
    $('#confirmYes').textContent = yes;
    $('#confirm').hidden = false;
    const done = v => { $('#confirm').hidden = true; $('#confirmYes').onclick = $('#confirmNo').onclick = null; res(v); };
    $('#confirmYes').onclick = () => done(true);
    $('#confirmNo').onclick = () => done(false);
  });
}

/* ---------------------------------------------------------------- storage (IndexedDB, private to this app) */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('funcam', 1);
      r.onupgradeneeded = () => { r.result.createObjectStore('items', { keyPath: 'id' }); r.result.createObjectStore('media'); };
      r.onsuccess = () => { this.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(stores, mode, fn) {
    return new Promise((res, rej) => {
      const t = this.db.transaction(stores, mode);
      let out;
      t.oncomplete = () => res(out && out.result);
      t.onerror = t.onabort = () => rej(t.error);
      out = fn(t);
    });
  },
  putItem(item) { return this.tx(['items'], 'readwrite', t => t.objectStore('items').put(item)); },
  allItems() { return this.tx(['items'], 'readonly', t => t.objectStore('items').getAll()); },
  getItem(id) { return this.tx(['items'], 'readonly', t => t.objectStore('items').get(id)); },
  putMedia(key, blob) { return this.tx(['media'], 'readwrite', t => t.objectStore('media').put(blob, key)); },
  getMedia(key) { return this.tx(['media'], 'readonly', t => t.objectStore('media').get(key)); },
  delMedia(key) { return this.tx(['media'], 'readwrite', t => t.objectStore('media').delete(key)); },
  deleteItem(id) {
    return this.tx(['items', 'media'], 'readwrite', t => {
      t.objectStore('items').delete(id);
      t.objectStore('media').delete(id + ':blob');
      t.objectStore('media').delete(id + ':raw');
    });
  },
  wipe() {
    return this.tx(['items', 'media'], 'readwrite', t => { t.objectStore('items').clear(); return t.objectStore('media').clear(); });
  }
};

/* ---------------------------------------------------------------- face filters */
/* Every filter is a list of "warp ops" placed on the face. Ops are evaluated in the shader.
   t:0 scale (k>0 magnifies, k<0 shrinks, per-axis)  t:1 swirl  t:2/3 wave (x-shift by y / y-shift by x) */
const S = (c, rx, ry, kx, ky, a = 0) => ({ t: 0, c, r: [rx, ry], k: [kx, ky], a });
const B = (c, r, k) => S(c, r, r, k, k, 0);
const SW = (c, r, ang) => ({ t: 1, c, r: [r, r], k: [ang, 0], a: 0 });
const WV = (c, rx, ry, amp, freq, a = 0, t = 2) => ({ t, c, r: [rx, ry], k: [amp, freq], a });
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

const FILTERS = [
  { id: 'none', name: 'Normal', emoji: '🙂', ops: () => [] },
  { id: 'wide', name: 'Wide Face', emoji: '🐸', face: true, ops: g => [S(g.C, 1.2 * g.W, 0.95 * g.H, 0.52, -0.14, g.roll)] },
  { id: 'superwide', name: 'Pancake', emoji: '🥞', face: true, ops: g => [S(g.C, 1.4 * g.W, 1.0 * g.H, 0.68, -0.22, g.roll)] },
  { id: 'wideeyes', name: 'Wide Eyes', emoji: '🦉', face: true, ops: g => [
    S(g.C, 1.2 * g.W, 0.95 * g.H, 0.44, -0.1, g.roll), B(g.eyeL, 0.36 * g.W, 0.5), B(g.eyeR, 0.36 * g.W, 0.5)] },
  { id: 'tall', name: 'Skinny', emoji: '🦒', face: true, ops: g => [S(g.C, 0.9 * g.W, 1.15 * g.H, -0.3, 0.4, g.roll)] },
  { id: 'bigeyes', name: 'Big Eyes', emoji: '👀', face: true, ops: g => [B(g.eyeL, 0.36 * g.W, 0.62), B(g.eyeR, 0.36 * g.W, 0.62)] },
  { id: 'bugeyes', name: 'Bug Eyes', emoji: '🐞', face: true, ops: g => [
    B(g.eyeL, 0.5 * g.W, 0.82), B(g.eyeR, 0.5 * g.W, 0.82), B(g.mouth, 0.4 * g.W, -0.5)] },
  { id: 'bigmouth', name: 'Big Mouth', emoji: '👄', face: true, ops: g => [
    S(g.mouth, 0.62 * g.W, 0.5 * g.W, 0.7, 0.85, g.roll), B(g.eyeL, 0.3 * g.W, -0.45), B(g.eyeR, 0.3 * g.W, -0.45)] },
  { id: 'bignose', name: 'Big Nose', emoji: '👃', face: true, ops: g => [B(g.nose, 0.4 * g.W, 0.85)] },
  { id: 'forehead', name: 'Big Brain', emoji: '🧠', face: true, ops: g => [
    B(lerp2(g.eyeMid, g.fore, 0.7), 0.75 * g.W, 0.7), B(g.chin, 0.5 * g.W, -0.5)] },
  { id: 'longchin', name: 'Long Chin', emoji: '🗿', face: true, ops: g => [
    S(lerp2(g.mouth, g.chin, 0.55), 0.7 * g.W, 0.65 * g.H, -0.15, 0.6, g.roll)] },
  { id: 'tiny', name: 'Tiny Face', emoji: '🤏', face: true, ops: g => [B(g.C, 1.45 * g.W, -0.8)] },
  { id: 'puffer', name: 'Puffer', emoji: '🐡', face: true, ops: g => [B(g.C, 1.2 * g.W, 0.74)] },
  { id: 'swirl', name: 'Swirl', emoji: '🌀', face: true, ops: g => [SW(g.nose, 1.0 * g.W, 2.7)] },
  { id: 'alien', name: 'Alien', emoji: '👽', face: true, ops: g => [
    B(lerp2(g.eyeMid, g.fore, 0.6), 0.85 * g.W, 0.6), B(g.chin, 0.55 * g.W, -0.75),
    B(g.eyeL, 0.34 * g.W, 0.5), B(g.eyeR, 0.34 * g.W, 0.5)] },
  { id: 'cheeks', name: 'Cheeks', emoji: '🐹', face: true, ops: g => [
    B(lerp2(g.cL, g.mouth, 0.4), 0.45 * g.W, 0.72), B(lerp2(g.cR, g.mouth, 0.4), 0.45 * g.W, 0.72)] },
  { id: 'wideset', name: 'Eye Gap', emoji: '👁️', face: true, ops: g => [
    S(g.eyeMid, 0.95 * g.W, 0.34 * g.W, 0.6, 0.0, g.roll), B(g.eyeL, 0.26 * g.W, 0.35), B(g.eyeR, 0.26 * g.W, 0.35)] },
  { id: 'cone', name: 'Conehead', emoji: '🥕', face: true, ops: g => [
    B(g.C, 0.62 * g.W, -0.7), B(lerp2(g.eyeMid, g.fore, 0.6), 0.8 * g.W, 0.55), B(g.chin, 0.55 * g.W, 0.5)] },
  { id: 'pillow', name: 'Pillow Face', emoji: '🧸', face: true, ops: g => [
    B(lerp2(g.cL, g.mouth, 0.45), 0.5 * g.W, 0.6), B(lerp2(g.cR, g.mouth, 0.45), 0.5 * g.W, 0.6),
    B(lerp2(g.mouth, g.chin, 0.6), 0.5 * g.W, 0.55), B(g.eyeL, 0.25 * g.W, -0.3), B(g.eyeR, 0.25 * g.W, -0.3)] },
  { id: 'tycoon', name: 'Trump-ish', emoji: '🎩', face: true, ops: g => [
    B(lerp2(g.eyeMid, g.fore, 1.05), 0.95 * g.W, 0.5),             // big swoopy-hair forehead area
    B(g.eyeL, 0.28 * g.W, -0.38), B(g.eyeR, 0.28 * g.W, -0.38),    // squinty eyes
    B(g.mouth, 0.3 * g.W, -0.6),                                   // tiny pursed mouth
    B(lerp2(g.cL, g.chin, 0.5), 0.42 * g.W, 0.5), B(lerp2(g.cR, g.chin, 0.5), 0.42 * g.W, 0.5)] }, // puffy jowls
  { id: 'melty', name: 'Melty', emoji: '🫠', face: true, animated: true, ops: g => [
    WV(g.C, 1.4 * g.W, 1.2 * g.H, 0.07 * g.W, 6.28 / (0.45 * g.H), g.roll)] },
  { id: 'funhouse', name: 'Funhouse', emoji: '🎪', animated: true, ops: g => [
    WV(g.C, 3, 3, 0.035, 6.28 / 0.5, 0, 2), WV(g.C, 3, 3, 0.02, 6.28 / 0.35, 0, 3)] },
];
const filterById = id => FILTERS.find(f => f.id === id) || FILTERS[0];

/* ---------------------------------------------------------------- voices */
const VOICES = [
  { id: 'original', name: 'Normal', emoji: '🙂' },
  { id: 'chipmunk', name: 'Chipmunk', emoji: '🐿️', pitch: 1.75 },
  { id: 'mouse', name: 'Tiny Mouse', emoji: '🐭', pitch: 2.4, hp: 350 },
  { id: 'giant', name: 'Giant', emoji: '🦍', pitch: 0.6, shelf: 7 },
  { id: 'monster', name: 'Monster', emoji: '👹', pitch: 0.47, drive: 25, shelf: 6, echo: { t: 0.09, fb: 0.3, wet: 0.35 } },
  { id: 'demon', name: 'Demon', emoji: '😈', layers: [{ pitch: 0.55, gain: 0.9 }, { pitch: 0.8, gain: 0.5 }, { pitch: 1.5, gain: 0.18 }], drive: 12, echo: { t: 0.13, fb: 0.35, wet: 0.3 } },
  { id: 'robot', name: 'Robot', emoji: '🤖', ring: 55, pitch: 0.95 },
  { id: 'alien', name: 'Alien', emoji: '👽', pitch: 1.3, vibrato: { rate: 9, depth: 0.1 }, ring: 38 },
  { id: 'grandpa', name: 'Grandpa', emoji: '👴', pitch: 0.83, vibrato: { rate: 5, depth: 0.04 }, lp: 4500 },
  { id: 'wobbly', name: 'Wobbly', emoji: '🥴', pitch: 1.0, vibrato: { rate: 5.5, depth: 0.32 } },
  { id: 'phone', name: 'Telephone', emoji: '📞', band: 1500, drive: 8 },
  { id: 'cave', name: 'Cave', emoji: '🕳️', pitch: 0.9, echo: { t: 0.26, fb: 0.5, wet: 0.6 }, lp: 5000 },
  { id: 'tycoon', name: 'Trump-ish', emoji: '🎙️', pitch: 0.9, peaks: [{ f: 1100, q: 1.2, g: 7 }, { f: 2600, q: 1, g: 4 }, { f: 200, q: 1, g: -3 }], lp: 6500, drive: 4 },
  { id: 'announcer', name: 'Deep Announcer', emoji: '📢', pitch: 0.72, shelf: 6, echo: { t: 0.07, fb: 0.2, wet: 0.25 } },
  { id: 'megaphone', name: 'Megaphone', emoji: '📣', band: 1800, drive: 18 },
  { id: 'ghost', name: 'Ghost', emoji: '👻', pitch: 1.05, vibrato: { rate: 3, depth: 0.08 }, hp: 300, echo: { t: 0.3, fb: 0.55, wet: 0.7 } },
  { id: 'underwater', name: 'Underwater', emoji: '🫧', pitch: 0.95, vibrato: { rate: 4, depth: 0.05 }, lp: 700 },
];
const voiceById = id => VOICES.find(v => v.id === id) || VOICES[0];

function distCurve(k) {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = i * 2 / n - 1; c[i] = (3 + k) * x * 20 * (Math.PI / 180) / (Math.PI + k * Math.abs(x)); }
  return c;
}
const workletLoaded = new WeakSet();
async function ensureWorklet(ctx) {
  if (workletLoaded.has(ctx)) return;
  await ctx.audioWorklet.addModule('pitch-worklet.js');
  workletLoaded.add(ctx);
}
/* builds an audio effect chain; returns {out, stop} */
function makeVoice(ctx, v, input) {
  const stops = [], made = [];
  const keep = n => { made.push(n); return n; };
  const pitchNode = (ratio, vib) => {
    const ps = keep(new AudioWorkletNode(ctx, 'pitch-shifter', { channelCount: 1, channelCountMode: 'explicit', outputChannelCount: [1] }));
    const p = ps.parameters.get('pitch');
    p.value = ratio;
    if (vib) {
      const lfo = ctx.createOscillator(); lfo.frequency.value = vib.rate;
      const g = keep(ctx.createGain()); g.gain.value = ratio * vib.depth;
      lfo.connect(g); g.connect(p); lfo.start();
      stops.push(() => { try { lfo.stop(); } catch (e) {} });
    }
    return ps;
  };
  let cur = input;
  if (v.layers) {
    const sum = keep(ctx.createGain());
    for (const L of v.layers) {
      const ps = pitchNode(L.pitch);
      const g = keep(ctx.createGain()); g.gain.value = L.gain;
      cur.connect(ps); ps.connect(g); g.connect(sum);
    }
    cur = sum;
  } else if (v.pitch || v.vibrato) {
    const ps = pitchNode(v.pitch || 1, v.vibrato);
    cur.connect(ps); cur = ps;
  }
  if (v.ring) {
    const g = keep(ctx.createGain()); g.gain.value = 0;
    const o = ctx.createOscillator(); o.frequency.value = v.ring; o.connect(g.gain); o.start();
    stops.push(() => { try { o.stop(); } catch (e) {} });
    cur.connect(g); cur = g;
  }
  const bq = (type, freq, q = 0.7, gain = 0) => {
    const f = keep(ctx.createBiquadFilter()); f.type = type; f.frequency.value = freq; f.Q.value = q; f.gain.value = gain;
    cur.connect(f); cur = f;
  };
  if (v.hp) bq('highpass', v.hp);
  if (v.lp) bq('lowpass', v.lp);
  if (v.band) bq('bandpass', v.band, 0.9);
  if (v.shelf) bq('lowshelf', 220, 0.7, v.shelf);
  if (v.peaks) v.peaks.forEach(p => bq('peaking', p.f, p.q, p.g));
  if (v.drive) {
    const ws = keep(ctx.createWaveShaper()); ws.curve = distCurve(v.drive); ws.oversample = '2x';
    cur.connect(ws); cur = ws;
  }
  if (v.echo) {
    const sum = keep(ctx.createGain());
    const d = keep(ctx.createDelay(1)); d.delayTime.value = v.echo.t;
    const fb = keep(ctx.createGain()); fb.gain.value = v.echo.fb;
    const wet = keep(ctx.createGain()); wet.gain.value = v.echo.wet;
    cur.connect(sum); cur.connect(d); d.connect(fb); fb.connect(d); d.connect(wet); wet.connect(sum);
    cur = sum;
  }
  const comp = keep(ctx.createDynamicsCompressor());
  comp.threshold.value = -14; comp.ratio.value = 6; comp.knee.value = 10; comp.attack.value = 0.005; comp.release.value = 0.15;
  const out = keep(ctx.createGain()); out.gain.value = v.band ? 1.6 : 1.1;
  cur.connect(comp); comp.connect(out);
  return { out, stop() { stops.forEach(f => f()); made.forEach(n => { try { n.disconnect(); } catch (e) {} }); } };
}

/* ---------------------------------------------------------------- WebGL face warp */
const VERT = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = vec2(aPos.x*0.5+0.5, 0.5-aPos.y*0.5); gl_Position = vec4(aPos,0.0,1.0); }`;
const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uAspect, uMirror, uTime;
uniform int uCount;
uniform vec4 uA[10];
uniform vec4 uB[10];
in vec2 vUv; out vec4 o;
void main(){
  vec2 uv = vUv;
  if(uMirror > 0.5) uv.x = 1.0 - uv.x;
  vec2 s = vec2(uv.x*uAspect, uv.y);
  for(int i=0;i<10;i++){
    if(i>=uCount) break;
    vec4 a = uA[i]; vec4 b = uB[i];
    vec2 d = s - a.xy;
    float ca = cos(b.w), sa = sin(b.w);
    vec2 r = vec2(ca*d.x + sa*d.y, -sa*d.x + ca*d.y);
    float t = length(r / a.zw);
    if(t < 1.0){
      float f = 1.0 - t*t; f = f*f;
      if(b.z < 0.5){ r = r * (1.0 - vec2(b.x, b.y) * f); }
      else if(b.z < 1.5){ float ang = b.x*f; float c = cos(ang), n = sin(ang); r = vec2(c*r.x - n*r.y, n*r.x + c*r.y); }
      else if(b.z < 2.5){ r.x += b.x*f*sin(b.y*r.y + uTime*2.5); }
      else { r.y += b.x*f*sin(b.y*r.x + uTime*2.0); }
      d = vec2(ca*r.x - sa*r.y, sa*r.x + ca*r.y);
      s = a.xy + d;
    }
  }
  o = texture(uTex, vec2(s.x/uAspect, s.y));
}`;

const canvas = $('#out'), cam = $('#cam');
let gl, prog, loc = {}, tex;
const arrA = new Float32Array(40), arrB = new Float32Array(40);
let camReady = false, stream = null, aspect = 9 / 16, needUpload = true;

function initGL() {
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  if (!gl) throw new Error('This phone browser has no WebGL2 — please use the latest Chrome.');
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  for (const n of ['uTex', 'uAspect', 'uMirror', 'uTime', 'uCount', 'uA', 'uB']) loc[n] = gl.getUniformLocation(prog, n);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const ap = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(ap);
  gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 0, 0);
  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.uniform1i(loc.uTex, 0);
}

/* --- face geometry (all in "aspect space": x scaled by width/height so circles stay round) */
let geom = null, targetGeom = null, lastFaceT = 0, faceStrength = 0, faceCount = 0;
function computeGeom(lm, asp) {
  const P = i => [lm[i].x * asp, lm[i].y];
  const avg = (...ids) => { let x = 0, y = 0; for (const i of ids) { x += lm[i].x; y += lm[i].y; } return [x / ids.length * asp, y / ids.length]; };
  const eyeR = avg(33, 133, 159, 145), eyeL = avg(362, 263, 386, 374), mouth = avg(61, 291, 13, 14);
  const nose = P(1), chin = P(152), fore = P(10), cL = P(234), cR = P(454);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const eyeMid = lerp2(eyeR, eyeL, 0.5);
  return { eyeR, eyeL, mouth, nose, chin, fore, cL, cR, eyeMid, C: lerp2(eyeMid, mouth, 0.45),
    W: dist(cL, cR), H: dist(fore, chin), roll: Math.atan2(eyeL[1] - eyeR[1], eyeL[0] - eyeR[0]) };
}
function mixGeom(a, b, t) {
  const o = {};
  for (const k in b) o[k] = Array.isArray(b[k]) ? [a[k][0] + (b[k][0] - a[k][0]) * t, a[k][1] + (b[k][1] - a[k][1]) * t] : a[k] + (b[k] - a[k]) * t;
  return o;
}

let faceMesh = null, faceReady = false;
async function initFace() {
  if (typeof FaceMesh === 'undefined') throw new Error('face tracker script missing');
  faceMesh = new FaceMesh({ locateFile: f => f });
  faceMesh.setOptions({ maxNumFaces: 1, refineLandmarks: false, minDetectionConfidence: 0.5, minTrackingConfidence: 0.5 });
  faceMesh.onResults(r => {
    const l = r.multiFaceLandmarks && r.multiFaceLandmarks[0];
    if (l) { targetGeom = computeGeom(l, aspect); lastFaceT = performance.now(); faceCount++; }
  });
  await faceMesh.initialize();
  faceReady = true;
  updateHint();
}
const det = document.createElement('canvas');
const detCtx = det.getContext('2d');
function overlayOpen() { return !$('#viewer').hidden || !$('#lib').hidden || !$('#settings').hidden; }
async function detectLoop() {
  for (;;) {
    const f = filterById(settings.filter);
    if (!(faceMesh && faceReady && camReady && cam.readyState >= 2 && !document.hidden && f.face) || overlayOpen()) { await sleep(120); continue; }
    try {
      const dw = 384, dh = Math.max(2, Math.round(dw * cam.videoHeight / cam.videoWidth));
      if (det.width !== dw || det.height !== dh) { det.width = dw; det.height = dh; }
      detCtx.drawImage(cam, 0, 0, dw, dh);
      await faceMesh.send({ image: det });
    } catch (e) { console.warn('face', e); await sleep(250); }
    await nextFrame();
  }
}

function buildOps() {
  const f = filterById(settings.filter);
  let ops = [], s = 1;
  if (f.id === 'none') return { ops, s };
  if (f.face) {
    if (!geom || faceStrength < 0.01) return { ops, s };
    ops = f.ops(geom); s = faceStrength;
  } else {
    ops = f.ops({ C: [aspect / 2, 0.5], W: aspect, H: 1, roll: 0 });
  }
  return { ops: ops.slice(0, 10), s };
}

function render(now = performance.now()) {
  if (!camReady || !cam.videoWidth) return false;
  if (canvas.width !== cam.videoWidth || canvas.height !== cam.videoHeight) {
    canvas.width = cam.videoWidth; canvas.height = cam.videoHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
    needUpload = true;
  }
  aspect = canvas.width / canvas.height;
  const alive = now - lastFaceT < 350;
  faceStrength += ((alive ? 1 : 0) - faceStrength) * 0.25;
  if (targetGeom) geom = (!geom || (faceStrength < 0.08 && alive)) ? targetGeom : mixGeom(geom, targetGeom, 0.45);

  if (needUpload) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cam);
    if (hasRVFC) needUpload = false;
  }
  const { ops, s } = buildOps();
  arrA.fill(0); arrB.fill(0);
  ops.forEach((op, i) => {
    arrA.set([op.c[0], op.c[1], op.r[0], op.r[1]], i * 4);
    const k0 = op.t === 1 ? op.k[0] * s : op.t >= 2 ? op.k[0] * s : op.k[0] * s;
    const k1 = op.t === 0 ? op.k[1] * s : op.k[1];
    arrB.set([k0, k1, op.t, op.a], i * 4);
  });
  gl.uniform1i(loc.uCount, ops.length);
  gl.uniform4fv(loc.uA, arrA);
  gl.uniform4fv(loc.uB, arrB);
  gl.uniform1f(loc.uAspect, aspect);
  gl.uniform1f(loc.uMirror, settings.facing === 'user' ? 1 : 0);
  gl.uniform1f(loc.uTime, now / 1000);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  return true;
}
const hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
function rvfcLoop() { needUpload = true; cam.requestVideoFrameCallback(rvfcLoop); }
function frameLoop(now) { requestAnimationFrame(frameLoop); if (!document.hidden && !overlayOpen()) render(now); }

/* ---------------------------------------------------------------- camera */
async function startCamera() {
  stopCamera();
  camReady = false;
  $('#loading').hidden = false; $('#btnRetry').hidden = true;
  $('#loadingText').textContent = 'Starting camera…';
  const hi = settings.quality === 'high';
  const attempts = [
    { facingMode: { ideal: settings.facing }, width: { ideal: hi ? 1080 : 720 }, height: { ideal: hi ? 1440 : 960 }, aspectRatio: { ideal: 3 / 4 }, frameRate: { ideal: 30 } },
    { facingMode: { ideal: settings.facing }, width: { ideal: 720 }, height: { ideal: 960 }, aspectRatio: { ideal: 3 / 4 } },
    { facingMode: { ideal: settings.facing } },
    true,
  ];
  let err;
  for (const video of attempts) {
    try { stream = await navigator.mediaDevices.getUserMedia({ video, audio: false }); err = null; break; } catch (e) { err = e; if (e.name === 'NotAllowedError') break; }
  }
  if (err) {
    $('#loadingText').textContent = err.name === 'NotAllowedError'
      ? 'Camera permission is blocked. Allow the camera for this site in Chrome settings, then try again.'
      : 'Could not start the camera (' + err.name + ').';
    $('#btnRetry').hidden = false;
    return;
  }
  cam.srcObject = stream;
  try { await cam.play(); } catch (e) {}
  await new Promise(r => { if (cam.videoWidth) r(); else cam.onloadedmetadata = () => r(); });
  camReady = true;
  needUpload = true;
  await zoomOutCamera();
  $('#loading').hidden = true;
  requestWake();
}
let camCaps = {};
async function zoomOutCamera() {
  camCaps = {};
  try {
    const tr = stream.getVideoTracks()[0];
    camCaps = tr.getCapabilities ? tr.getCapabilities() : {};
    if (camCaps.zoom && camCaps.zoom.min !== undefined) await tr.applyConstraints({ advanced: [{ zoom: camCaps.zoom.min }] });
  } catch (e) { console.warn('zoom', e); }
}
function camInfoText() {
  if (!stream) return 'Camera not running.';
  const tr = stream.getVideoTracks()[0], st = tr ? tr.getSettings() : {};
  return `The camera is giving the app ${cam.videoWidth}×${cam.videoHeight}` + (st.zoom ? ` at ${(+st.zoom).toFixed(1)}× zoom.` : '. This phone doesn’t offer a camera zoom control.');
}
function stopCamera() {
  camReady = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  stream = null; cam.srcObject = null;
}
let wakeLock = null;
async function requestWake() { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }

/* ---------------------------------------------------------------- UI: filters, modes, sheets */
let recording = false;
function buildFilterRow() {
  const row = $('#filterRow');
  row.replaceChildren();
  for (const f of FILTERS) {
    const c = h('button', { class: 'chip', 'data-id': f.id }, h('b', { text: f.emoji }), h('span', { text: f.name }));
    c.onclick = () => selectFilter(f.id, true);
    row.append(c);
  }
  selectFilter(settings.filter, false);
}
function selectFilter(id, scroll) {
  settings.filter = id; saveSettings();
  document.querySelectorAll('#filterRow .chip').forEach(c => {
    const on = c.dataset.id === id;
    c.classList.toggle('on', on);
    if (on && scroll) c.scrollIntoView({ inline: 'center', behavior: 'smooth', block: 'nearest' });
  });
  geom = null; targetGeom = null; faceStrength = 0;
  updateHint();
}
function updateHint() {
  const f = filterById(settings.filter);
  const hint = $('#hint');
  if (!f.face) { hint.hidden = true; return; }
  if (!faceReady) { hint.textContent = 'Loading face tracker…'; hint.hidden = false; return; }
  hint.hidden = true;
}
setInterval(() => {
  const f = filterById(settings.filter);
  const hint = $('#hint');
  if (!f.face || !camReady || !faceReady || recording) { if (faceReady) hint.hidden = true; return; }
  const lost = performance.now() - lastFaceT > 1500;
  hint.textContent = 'Show your face to the camera 🙂';
  hint.hidden = !lost;
}, 400);

function applyFit() {
  $('#out').style.objectFit = settings.fit ? 'contain' : 'cover';
  $('#btnFit').textContent = settings.fit ? '⤢' : '⤡';
}
function setMode(m) {
  settings.mode = m; saveSettings();
  document.querySelectorAll('#modeRow button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  $('#btnShutter').classList.toggle('video', m === 'video');
}
function setVoice(id) {
  settings.voice = id; saveSettings();
  $('#voiceEmoji').textContent = voiceById(id).emoji;
}
function openSheet(title, items, current, onPick) {
  $('#sheetTitle').textContent = title;
  const grid = h('div', { class: 'sheetGrid' });
  for (const it of items) {
    const b = h('button', { class: 'sheetItem' + (it.id === current ? ' on' : '') }, h('b', { text: it.emoji }), h('span', { text: it.name }));
    if (it.sub) b.append(h('small', { text: it.sub }));
    b.onclick = () => { onPick(it); closeSheet(); };
    grid.append(b);
  }
  $('#sheetContent').replaceChildren(grid);
  $('#sheet').hidden = false;
}
const closeSheet = () => { $('#sheet').hidden = true; };

const COMBOS = [
  { id: 'c1', name: 'Chipmunk Cheeks', emoji: '🐹', filter: 'cheeks', voice: 'chipmunk' },
  { id: 'c2', name: 'Giant Baby', emoji: '👶', filter: 'puffer', voice: 'giant' },
  { id: 'c3', name: 'Alien Dude', emoji: '👽', filter: 'alien', voice: 'alien' },
  { id: 'c4', name: 'Pancake Robot', emoji: '🤖', filter: 'superwide', voice: 'robot' },
  { id: 'c5', name: 'Big Mouth Mouse', emoji: '🐭', filter: 'bigmouth', voice: 'mouse' },
  { id: 'c6', name: 'Grandpa Frog', emoji: '🐸', filter: 'wide', voice: 'grandpa' },
  { id: 'c7', name: 'Bug-Eyed Monster', emoji: '👹', filter: 'bugeyes', voice: 'monster' },
  { id: 'c8', name: 'Melty Wobble', emoji: '🫠', filter: 'melty', voice: 'wobbly' },
  { id: 'c9', name: 'Big Brain Phone', emoji: '🧠', filter: 'forehead', voice: 'phone' },
  { id: 'c10', name: 'Big League Boss', emoji: '🎩', filter: 'tycoon', voice: 'tycoon' },
  { id: 'c11', name: 'Eye Gap Ghost', emoji: '👁️', filter: 'wideset', voice: 'ghost' },
  { id: 'c12', name: 'Pillow Announcer', emoji: '🧸', filter: 'pillow', voice: 'announcer' },
];

/* ---------------------------------------------------------------- capture */
const pickMime = () => {
  const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return list.find(m => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
};
const videoBps = () => (settings.quality === 'high' ? 14_000_000 : 8_000_000);
const baseType = t => (t || '').split(';')[0];
const extFor = type => ({ 'image/jpeg': 'jpg', 'video/mp4': 'mp4', 'video/webm': 'webm' }[baseType(type)] || 'bin');
function fileName(item, blob) {
  const d = new Date(item.created), p = n => String(n).padStart(2, '0');
  return `FunCam-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${extFor(blob.type || item.mime)}`;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
function makeThumb(src, w, h2) {
  const c = document.createElement('canvas');
  const sc = Math.min(1, 360 / Math.max(w, h2));
  c.width = Math.max(1, Math.round(w * sc)); c.height = Math.max(1, Math.round(h2 * sc));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.7));
}

async function takePhoto() {
  if (!camReady) return;
  $('#flash').classList.remove('go'); void $('#flash').offsetWidth; $('#flash').classList.add('go');
  needUpload = true;
  render();
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.96));
  const thumb = await makeThumb(canvas, canvas.width, canvas.height);
  const item = { id: uid(), type: 'photo', created: Date.now(), mime: 'image/jpeg', thumb, filter: settings.filter, voice: null, hasRaw: false };
  await DB.putItem(item);
  await DB.putMedia(item.id + ':blob', blob);
  if (settings.autoSave) downloadBlob(blob, fileName(item, blob));
  refreshLibBtn();
  openViewer(item.id, { fresh: true });
}

let rec = null, chunks = [], micStream = null, recStart = 0, recTimer = null, recMime = '';
async function startRecording() {
  if (recording || !camReady) return;
  if (!window.MediaRecorder) { toast('Video recording needs Chrome'); return; }
  recMime = pickMime();
  const tracks = [...canvas.captureStream(30).getVideoTracks()];
  micStream = null;
  if (settings.micId !== 'none') {
    try { micStream = await getMic(); tracks.push(...micStream.getAudioTracks()); }
    catch (e) { toast('No microphone access — recording without sound'); }
  }
  try {
    rec = new MediaRecorder(new MediaStream(tracks), { mimeType: recMime || undefined, videoBitsPerSecond: videoBps(), audioBitsPerSecond: 192000 });
  } catch (e) { toast('Could not start recording: ' + e.name); releaseMic(); return; }
  chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = onRecStop;
  rec.start(500);
  recording = true; recStart = performance.now();
  $('#btnShutter').classList.add('rec');
  $('#recBadge').hidden = false; $('#recTime').textContent = '0:00';
  $('#hint').hidden = true;
  recTimer = setInterval(() => {
    const ms = performance.now() - recStart;
    $('#recTime').textContent = fmtTime(ms);
    if (ms > 10 * 60 * 1000) stopRecording();
  }, 250);
}
function stopRecording() {
  if (!recording) return;
  recording = false;
  clearInterval(recTimer);
  $('#btnShutter').classList.remove('rec');
  $('#recBadge').hidden = true;
  try { rec.stop(); } catch (e) {}
}
function releaseMic() { if (micStream) micStream.getTracks().forEach(t => t.stop()); micStream = null; }
async function getMic() {
  const effects = settings.cleanup;
  const audio = { echoCancellation: effects, noiseSuppression: effects, autoGainControl: effects, channelCount: 1 };
  if (settings.micId && settings.micId !== 'auto') audio.deviceId = { exact: settings.micId };
  try { return await navigator.mediaDevices.getUserMedia({ audio }); }
  catch (e) { if (audio.deviceId) { delete audio.deviceId; return await navigator.mediaDevices.getUserMedia({ audio }); } throw e; }
}
async function onRecStop() {
  const dur = performance.now() - recStart;
  releaseMic();
  const type = baseType(rec.mimeType || recMime) || 'video/webm';
  const blob = new Blob(chunks, { type });
  chunks = [];
  if (!blob.size) { toast('Nothing was recorded'); return; }
  const thumb = await makeThumb(canvas, canvas.width, canvas.height);
  const wantVoice = settings.voice !== 'original';
  const item = { id: uid(), type: 'video', created: Date.now(), mime: type, thumb, duration: dur, filter: settings.filter, voice: 'original', hasRaw: false };
  await DB.putItem(item);
  await DB.putMedia(item.id + ':blob', blob);
  if (settings.autoSave && !wantVoice) downloadBlob(blob, fileName(item, blob));
  refreshLibBtn();
  openViewer(item.id, { fresh: true, preselect: settings.voice });
}

/* ---------------------------------------------------------------- navigation (so Android's back button works) */
let navFromLib = false;
function show(name, extra) {
  history.pushState({ s: name }, '');
  renderNav(name);
}
function renderNav(name) {
  const leavingViewer = !$('#viewer').hidden && name !== 'viewer';
  if (leavingViewer) cleanupViewer();
  $('#lib').hidden = !(name === 'lib' || (name === 'viewer' && navFromLib));
  $('#viewer').hidden = name !== 'viewer';
  $('#settings').hidden = name !== 'settings';
  if (name === 'lib') renderLibrary();
  if (name === 'settings') renderSettings();
  if (name === 'cam') navFromLib = false;
}
window.addEventListener('popstate', e => {
  if (V.busy) { history.pushState({ s: 'viewer' }, ''); toast('Applying voice — one moment…'); return; }
  renderNav((e.state && e.state.s) || 'cam');
});

/* ---------------------------------------------------------------- library */
let gridUrls = [];
async function refreshLibBtn() {
  const items = await DB.allItems();
  const b = $('#btnLib');
  b.replaceChildren();
  if (items.length) {
    const last = items.sort((a, c) => c.created - a.created)[0];
    const url = URL.createObjectURL(last.thumb);
    const img = h('img', { src: url, alt: '' });
    img.onload = () => URL.revokeObjectURL(url);
    b.append(img);
  } else b.textContent = '🖼️';
}
async function renderLibrary() {
  gridUrls.forEach(u => URL.revokeObjectURL(u)); gridUrls = [];
  const items = (await DB.allItems()).sort((a, b) => b.created - a.created);
  $('#libCount').textContent = items.length ? items.length + ' item' + (items.length > 1 ? 's' : '') : '';
  $('#libEmpty').hidden = items.length > 0;
  const grid = $('#grid');
  grid.replaceChildren();
  for (const it of items) {
    const url = URL.createObjectURL(it.thumb); gridUrls.push(url);
    const cell = h('button', { class: 'cell' }, h('img', { src: url, alt: '' }));
    if (it.type === 'video') cell.append(h('span', { class: 'tag', text: '▶ ' + fmtTime(it.duration || 0) }));
    if (it.type === 'video' && it.voice && it.voice !== 'original') cell.append(h('span', { class: 'tag2', text: voiceById(it.voice).emoji }));
    cell.onclick = () => { navFromLib = true; openViewer(it.id, {}); };
    grid.append(cell);
  }
}

/* ---------------------------------------------------------------- viewer / voice editor */
const V = { item: null, final: null, raw: null, url: null, ctx: null, tap: null, chain: null, sel: 'original', busy: false, fresh: false };
async function openViewer(id, opts = {}) {
  const item = await DB.getItem(id);
  if (!item) return;
  V.item = item; V.fresh = !!opts.fresh; V.busy = false;
  V.final = await DB.getMedia(id + ':blob');
  V.raw = item.hasRaw ? await DB.getMedia(id + ':raw') : null;
  const isVideo = item.type === 'video';
  $('#vTitle').textContent = isVideo ? 'Video' : 'Photo';
  $('#vVideo').hidden = !isVideo; $('#vImg').hidden = isVideo;
  $('#vVoice').hidden = !isVideo;
  $('#vProgress').hidden = true;
  $('#vNote').textContent = '';
  if (isVideo) {
    V.sel = opts.preselect || item.voice || 'original';
    buildChips();
    await attachVideo();
  } else {
    V.url = URL.createObjectURL(V.final);
    $('#vImg').src = V.url;
  }
  updateViewerButtons();
  history.pushState({ s: 'viewer' }, '');
  renderNav('viewer');
}
function buildChips() {
  const box = $('#vChips');
  box.replaceChildren();
  for (const v of VOICES) {
    const c = h('button', { class: 'vchip' + (v.id === V.sel ? ' on' : '') + (v.id === V.item.voice ? ' applied' : ''), 'data-id': v.id }, document.createTextNode(v.emoji + ' ' + v.name));
    c.onclick = async () => {
      if (V.busy) return;
      V.sel = v.id; buildChips();
      if (v.id !== 'original' && !V.ctx && !(await ensureAudio())) toast('Could not start the voice engine — tap the voice again');
      connectVoice(); updateViewerButtons();
    };
    box.append(c);
  }
}
async function ensureAudio() {
  if (V.ctx) return true;
  let ctx;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    try { await ctx.resume(); } catch (e) {}
    if (ctx.state !== 'running') { ctx.close().catch(() => {}); return false; }
    await ensureWorklet(ctx);
    const msrc = ctx.createMediaElementSource($('#vVideo'));
    V.tap = ctx.createGain();
    msrc.connect(V.tap);
    V.ctx = ctx;
    return true;
  } catch (e) { console.warn('audio engine', e); return false; }
}
async function attachVideo() {
  const vid = $('#vVideo');
  V.url = URL.createObjectURL(V.raw || V.final);
  vid.loop = true; vid.controls = true; vid.muted = false;
  vid.onerror = () => { $('#vNote').textContent = 'This phone could not play this video inside the app. You can still Save or Share it.'; };
  vid.src = V.url;
  await Promise.race([new Promise(r => { vid.onloadedmetadata = r; }), sleep(4000)]);
  if (vid.duration === Infinity) { // MediaRecorder files often lack a duration
    vid.currentTime = 1e101;
    await new Promise(r => { vid.ontimeupdate = () => { vid.ontimeupdate = null; r(); }; setTimeout(r, 1500); });
    vid.currentTime = 0;
  }
  vid.play().catch(() => {});
  if (V.sel !== 'original') {
    if (await ensureAudio()) connectVoice(); else $('#vNote').textContent = 'Tap a voice below to hear it.';
  }
}
function connectVoice() {
  if (!V.ctx) return;
  if (V.chain) { V.chain.stop(); V.chain = null; }
  V.tap.disconnect();
  const v = voiceById(V.sel);
  if (v.id === 'original') { V.tap.connect(V.ctx.destination); return; }
  V.chain = makeVoice(V.ctx, v, V.tap);
  V.chain.out.connect(V.ctx.destination);
}
function updateViewerButtons() {
  const isVideo = V.item.type === 'video';
  const pending = isVideo && V.sel !== V.item.voice;
  $('#vApply').hidden = !pending;
  if (pending) $('#vApply').textContent = V.sel === 'original' ? 'Go back to my normal voice' : 'Apply ' + voiceById(V.sel).emoji + ' ' + voiceById(V.sel).name + ' voice';
  $('#vShare').disabled = $('#vSave').disabled = pending;
  $('#vNote').textContent = pending ? 'Plays with the new voice now. Tap the button above to save it into the video.' :
    (isVideo && V.item.voice !== 'original' ? 'Saved with the ' + voiceById(V.item.voice).name + ' voice. Your original voice is kept so you can change it any time.' : '');
}
function cleanupViewer() {
  const vid = $('#vVideo');
  try { vid.pause(); } catch (e) {}
  vid.removeAttribute('src'); vid.load();
  if (V.chain) { V.chain.stop(); V.chain = null; }
  if (V.ctx) { V.ctx.close().catch(() => {}); V.ctx = null; V.tap = null; }
  if (V.url) { URL.revokeObjectURL(V.url); V.url = null; }
  $('#vImg').removeAttribute('src');
  if (!$('#lib').hidden) renderLibrary();
  refreshLibBtn();
}

async function applyVoice() {
  if (V.busy) return;
  if (V.sel !== 'original' && !V.ctx && !(await ensureAudio())) { toast('Could not start the voice engine — tap Apply again'); return; }
  const item = V.item, sel = V.sel;
  const source = V.raw || V.final;
  V.busy = true;
  $('#vApply').disabled = true;
  try {
    let result;
    if (sel === 'original') {
      result = V.raw || V.final;                         // back to untouched recording
    } else {
      result = await renderWithVoice(sel);
    }
    if (!item.hasRaw && sel !== 'original') {            // keep the untouched recording for later re-edits
      await DB.putMedia(item.id + ':raw', source); item.hasRaw = true; V.raw = source;
    }
    await DB.putMedia(item.id + ':blob', result);
    if (sel === 'original' && item.hasRaw) { await DB.delMedia(item.id + ':raw'); item.hasRaw = false; V.raw = null; }
    item.voice = sel; item.mime = baseType(result.type) || item.mime;
    await DB.putItem(item);
    V.final = result;
    if (settings.autoSave) downloadBlob(result, fileName(item, result));
    toast(settings.autoSave ? 'Saved ✓ (also copied to your phone)' : 'Saved ✓');
  } catch (e) {
    console.error(e);
    toast('Could not apply the voice: ' + (e.message || e.name));
  } finally {
    V.busy = false;
    $('#vApply').disabled = false;
    $('#vProgress').hidden = true;
    const vid = $('#vVideo'); vid.controls = true; vid.loop = true;
    buildChips(); connectVoice(); updateViewerButtons();
    vid.currentTime = 0; vid.play().catch(() => {});
  }
}
/* Plays the video with the voice effect (silently) and records the result in real time. */
async function renderWithVoice(voiceId) {
  const vid = $('#vVideo');
  if (!vid.captureStream) throw new Error('this browser cannot re-record video (use Chrome)');
  const ctx = V.ctx;
  await ctx.resume();
  vid.pause(); vid.currentTime = 0; vid.loop = false; vid.controls = false;
  $('#vProgress').hidden = false;
  const bar = $('#vProgress .bar i'); bar.style.width = '0%';
  if (V.chain) { V.chain.stop(); V.chain = null; }
  V.tap.disconnect();
  const dest = ctx.createMediaStreamDestination();
  const v = voiceById(voiceId);
  const chain = makeVoice(ctx, v, V.tap);
  chain.out.connect(dest);
  const vt = vid.captureStream().getVideoTracks();
  const mime = pickMime();
  const mr = new MediaRecorder(new MediaStream([...vt, ...dest.stream.getAudioTracks()]), { mimeType: mime || undefined, videoBitsPerSecond: videoBps(), audioBitsPerSecond: 192000 });
  const parts = [];
  mr.ondataavailable = e => { if (e.data && e.data.size) parts.push(e.data); };
  const stopped = new Promise(r => { mr.onstop = r; });
  const dur = vid.duration && isFinite(vid.duration) ? vid.duration : (V.item.duration || 0) / 1000;
  let finished = false;
  const finish = () => { if (!finished) { finished = true; try { mr.stop(); } catch (e) {} } };
  vid.onended = () => setTimeout(finish, 250);
  const guard = setTimeout(finish, (dur * 1.6 + 8) * 1000);
  const prog = setInterval(() => { if (dur) bar.style.width = Math.min(100, vid.currentTime / dur * 100) + '%'; }, 200);
  mr.start(500);
  await vid.play();
  await stopped;
  clearTimeout(guard); clearInterval(prog); vid.onended = null;
  chain.stop();
  const blob = new Blob(parts, { type: baseType(mr.mimeType || mime) || 'video/webm' });
  if (!blob.size) throw new Error('nothing was recorded');
  return blob;
}

async function shareCurrent() {
  const blob = V.final;
  if (!blob) return;
  const file = new File([blob], fileName(V.item, blob), { type: baseType(blob.type) || V.item.mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); } catch (e) { if (e.name !== 'AbortError') toast('Sharing failed: ' + e.name); }
  } else { downloadBlob(blob, file.name); toast('Sharing isn’t available here — saved to your phone instead'); }
}

/* ---------------------------------------------------------------- settings screen */
async function renderSettings() {
  $('#setAutoSave').checked = settings.autoSave;
  $('#setCleanup').checked = settings.cleanup;
  $('#setQuality').value = settings.quality;
  $('#camInfo').textContent = camInfoText();
  const z = camCaps.zoom, zs = $('#setZoom');
  zs.hidden = !(z && z.max > z.min);
  if (!zs.hidden) { zs.min = z.min; zs.max = z.max; zs.step = z.step || 0.1; zs.value = (stream.getVideoTracks()[0].getSettings().zoom) || z.min; }
  $('#pinState').textContent = Lock.has ? 'A PIN is required when you open the app.' : 'Off — anyone who opens the app can see your stuff.';
  $('#pinSet').textContent = Lock.has ? 'Change PIN' : 'Set PIN';
  $('#pinRemove').hidden = !Lock.has;
  $('#btnInstall').hidden = !deferredInstall;
  const sel = $('#setMic');
  sel.replaceChildren(h('option', { value: 'auto', text: 'Automatic' }), h('option', { value: 'none', text: 'No sound (silent videos)' }));
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
    devs.forEach((d, i) => sel.append(h('option', { value: d.deviceId, text: d.label || ('Microphone ' + (i + 1)) })));
  } catch (e) {}
  sel.value = [...sel.options].some(o => o.value === settings.micId) ? settings.micId : 'auto';
  try {
    const est = await navigator.storage.estimate();
    const items = await DB.allItems();
    $('#storageInfo').textContent = `${items.length} item${items.length === 1 ? '' : 's'} stored · ${(est.usage / 1048576).toFixed(0)} MB used`;
  } catch (e) { $('#storageInfo').textContent = ''; }
}
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; });

/* ---------------------------------------------------------------- PIN lock */
const Lock = {
  get has() { return !!localStorage.getItem('fc_pin'); },
  async hash(pin, saltHex) {
    const salt = Uint8Array.from(saltHex.match(/../g).map(x => parseInt(x, 16)));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 150000, hash: 'SHA-256' }, key, 256);
    return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  },
  async set(pin) {
    const salt = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('fc_pin', JSON.stringify({ salt, hash: await this.hash(pin, salt) }));
  },
  async check(pin) {
    const p = JSON.parse(localStorage.getItem('fc_pin') || 'null');
    return !!p && (await this.hash(pin, p.salt)) === p.hash;
  },
  clear() { localStorage.removeItem('fc_pin'); },
  fails: 0, until: 0, locked: false,
};
function askPin(title, cancelable, msg = '') {
  return new Promise(res => {
    $('#lockTitle').textContent = title; $('#lockMsg').textContent = msg;
    $('#lockCancel').hidden = !cancelable;
    $('#lock').hidden = false;
    let buf = '';
    const dots = [...document.querySelectorAll('#dots i')];
    const paint = () => dots.forEach((d, i) => d.classList.toggle('f', i < buf.length));
    paint();
    const done = v => { $('#lock').hidden = true; $('#lockCancel').onclick = null; window.__pinPress = null; res(v); };
    window.__pinPress = k => {
      if (k === 'del') buf = buf.slice(0, -1); else if (buf.length < 4) buf += k;
      paint();
      if (buf.length === 4) { const v = buf; buf = ''; setTimeout(() => { paint(); done(v); }, 120); }
    };
    $('#lockCancel').onclick = () => done(null);
  });
}
function buildKeypad() {
  const kp = $('#keypad');
  for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del']) {
    const b = h('button', { class: k === '' ? 'ghost' : '', text: k === 'del' ? '⌫' : k });
    if (k === '') b.disabled = true; else b.onclick = () => window.__pinPress && window.__pinPress(k);
    kp.append(b);
  }
}
async function unlockFlow() {
  Lock.locked = true;
  let msg = '';
  for (;;) {
    const wait = Lock.until - Date.now();
    if (wait > 0) { $('#lock').hidden = false; $('#lockMsg').textContent = 'Too many tries. Wait ' + Math.ceil(wait / 1000) + 's'; await sleep(wait); msg = ''; }
    const pin = await askPin('Enter PIN', false, msg);
    if (await Lock.check(pin)) { Lock.fails = 0; break; }
    Lock.fails++;
    msg = 'Wrong PIN';
    if (Lock.fails >= 5) { Lock.until = Date.now() + 30000; Lock.fails = 0; }
  }
  Lock.locked = false;
}
async function lockNow() {
  if (!Lock.has || Lock.locked) return;
  if (recording) stopRecording();
  stopCamera();
  $('#viewer').hidden = true; cleanupViewer(); $('#lib').hidden = true; $('#settings').hidden = true;
  history.replaceState({ s: 'cam' }, '');
  await unlockFlow();
  await startCamera();
}
let hiddenAt = 0;
document.addEventListener('visibilitychange', async () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    if (recording) stopRecording();
  } else {
    if (Lock.has && Date.now() - hiddenAt > 15000) { await lockNow(); return; }
    if (!Lock.locked && (!stream || stream.getVideoTracks().every(t => t.readyState !== 'live'))) startCamera();
    else requestWake();
  }
});

/* ---------------------------------------------------------------- wiring */
function wire() {
  buildKeypad();
  buildFilterRow();
  setMode(settings.mode);
  setVoice(settings.voice);
  applyFit();
  $('#btnFit').onclick = () => { settings.fit = !settings.fit; saveSettings(); applyFit(); toast(settings.fit ? 'Showing the whole camera view' : 'Filling the screen (zoomed in)'); };
  document.querySelectorAll('#modeRow button').forEach(b => b.onclick = () => { if (!recording) setMode(b.dataset.mode); });
  $('#btnShutter').onclick = () => {
    if (settings.mode === 'photo') takePhoto();
    else if (recording) stopRecording(); else startRecording();
  };
  $('#btnFlip').onclick = async () => {
    if (recording) return;
    settings.facing = settings.facing === 'user' ? 'environment' : 'user'; saveSettings();
    geom = null; targetGeom = null; faceStrength = 0;
    await startCamera();
  };
  $('#btnRetry').onclick = () => startCamera();
  $('#btnLib').onclick = () => { if (!recording) { navFromLib = true; show('lib'); } };
  $('#btnSettings').onclick = () => { if (!recording) show('settings'); };
  $('#libBack').onclick = () => history.back();
  $('#setBack').onclick = () => history.back();
  $('#vClose').onclick = () => { if (!V.busy) history.back(); };
  $('#btnVoice').onclick = () => openSheet('Voice for your next video', VOICES, settings.voice, v => { setVoice(v.id); toast(v.id === 'original' ? 'Normal voice' : v.emoji + ' ' + v.name + ' voice — you can still change it after recording'); });
  $('#btnCombos').onclick = () => openSheet('Face + voice combos', COMBOS.map(c => ({ ...c, sub: filterById(c.filter).name + ' + ' + voiceById(c.voice).name })), null, c => {
    selectFilter(c.filter, true); setVoice(c.voice); toast(c.emoji + ' ' + c.name);
  });
  $('#sheetClose').onclick = closeSheet;
  document.querySelector('.sheetBack').onclick = closeSheet;

  $('#vApply').onclick = applyVoice;
  $('#vShare').onclick = shareCurrent;
  $('#vSave').onclick = () => { downloadBlob(V.final, fileName(V.item, V.final)); toast('Saved to your phone’s Downloads'); };
  $('#vDelete').onclick = async () => {
    if (V.busy) return;
    if (!(await askConfirm('Delete this ' + V.item.type + ' from the app? (Copies already in your Downloads folder stay there.)', 'Delete'))) return;
    await DB.deleteItem(V.item.id);
    history.back();
  };

  $('#setAutoSave').onchange = e => { settings.autoSave = e.target.checked; saveSettings(); };
  $('#setCleanup').onchange = e => { settings.cleanup = e.target.checked; saveSettings(); };
  $('#setQuality').onchange = async e => { settings.quality = e.target.value; saveSettings(); if (!recording) { await startCamera(); toast('Camera restarted at ' + (settings.quality === 'high' ? 'high' : 'standard') + ' quality'); } };
  $('#setZoom').oninput = async e => { try { await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ zoom: +e.target.value }] }); $('#camInfo').textContent = camInfoText(); } catch (err) {} };
  $('#setMic').onchange = e => { settings.micId = e.target.value; saveSettings(); };
  $('#pinSet').onclick = async () => {
    if (Lock.has && !(await Lock.check(await askPin('Enter current PIN', true) || ''))) { toast('That PIN is not right'); return; }
    const p1 = await askPin('Choose a 4-digit PIN', true); if (!p1) return;
    const p2 = await askPin('Type it again', true); if (!p2) return;
    if (p1 !== p2) { toast('The PINs did not match'); return; }
    await Lock.set(p1); toast('PIN set 🔒'); renderSettings();
  };
  $('#pinRemove').onclick = async () => {
    const p = await askPin('Enter PIN to remove it', true); if (!p) return;
    if (await Lock.check(p)) { Lock.clear(); toast('PIN removed'); renderSettings(); } else toast('That PIN is not right');
  };
  $('#btnInstall').onclick = async () => { if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; $('#btnInstall').hidden = true; } };
  $('#btnWipe').onclick = async () => {
    if (!(await askConfirm('Delete ALL photos and videos stored in this app? This cannot be undone.', 'Delete all'))) return;
    await DB.wipe(); toast('Everything deleted'); renderSettings(); refreshLibBtn();
  };
}

async function boot() {
  history.replaceState({ s: 'cam' }, '');
  try { await DB.open(); } catch (e) { toast('Storage is unavailable: ' + e.name); }
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  wire();
  refreshLibBtn();
  if (Lock.has) await unlockFlow();
  try { initGL(); } catch (e) { $('#loadingText').textContent = e.message; return; }
  requestAnimationFrame(frameLoop);
  if (hasRVFC) cam.requestVideoFrameCallback(rvfcLoop);
  detectLoop();
  startCamera();
  initFace().catch(e => { console.error(e); toast('Face tracker failed to load — only non-face filters will work'); });
}
window.__fc = { settings, selectFilter, setVoice, DB, V, get faceCount() { return faceCount; }, get faceStrength() { return faceStrength; }, FILTERS, VOICES, render, takePhoto, startRecording, stopRecording, applyVoice };
boot();
