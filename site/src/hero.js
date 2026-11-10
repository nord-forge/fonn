// Hero effect: code glyphs stream left to right as noisy lanes. At the filter
// gate the noise drifts away as snow, and the few signal glyphs settle into
// tidy context rows. Plain WebGL 1, no libraries. Decorative only.
const canvas = document.getElementById('hero-canvas');
const figure = canvas?.closest('.hero-visual');
const motion = window.matchMedia('(prefers-reduced-motion: reduce)');

const NOISE = ['.', '.', ':', '=', '-', '0', '1', '%'];
const SIGNAL = ['{', '}', '(', ')', 'f', '>', '/'];
const ATLAS_CELLS = 4; // 4 x 4 cells: 8 noise glyphs, 7 signal glyphs, 1 soft dot.

const particleVertex = `
attribute vec4 aSeed;
attribute float aGlyph;
attribute float aSignal;
uniform float uTime;
uniform float uGate;
uniform vec2 uPointer;
uniform float uScale;
varying float vAlpha;
varying float vGlyph;
varying float vSignal;
varying float vHeat;

void main() {
  float speed = 0.028 + aSeed.y * 0.03;
  float t = fract(aSeed.x + uTime * speed);
  float x = mix(-1.12, 1.12, t);

  float lanes = 26.0;
  float lane = floor(aSeed.z * lanes);
  float yIn = (lane / (lanes - 1.0)) * 1.64 - 0.82;
  yIn += 0.03 * sin(x * 6.0 + aSeed.w * 31.0 + uTime * 0.8);

  // The pointer parts the incoming stream a little.
  vec2 d = vec2(x, yIn) - uPointer;
  float push = exp(-dot(d, d) * 26.0) * step(x, uGate);
  yIn += sign(d.y) * push * 0.09;

  float k = smoothstep(uGate - 0.03, uGate + 0.16, x);
  float y;
  float size;
  float alpha;
  float glyph = aGlyph;

  if (aSignal > 0.5) {
    float rows = 6.0;
    float row = floor(fract(aSeed.z * 7.13) * rows);
    float yOut = (row - (rows - 1.0) * 0.5) * 0.12;
    y = mix(yIn, yOut, k);
    size = mix(13.0, 16.0, k);
    alpha = mix(0.55, 1.0, k);
  } else {
    float past = max(x - uGate, 0.0);
    y = yIn - past * past * (1.4 + aSeed.w * 2.0) - past * 0.12 * aSeed.y;
    size = mix(12.0, 3.5 + aSeed.w * 2.5, k);
    alpha = mix(0.42, 0.0, smoothstep(uGate + 0.05, uGate + 0.75, x));
    glyph = mix(aGlyph, 15.0, step(0.5, k));
  }

  alpha *= smoothstep(-1.12, -0.92, x) * (1.0 - smoothstep(0.92, 1.12, x));
  vAlpha = alpha;
  vGlyph = glyph;
  vSignal = aSignal;
  vHeat = exp(-abs(x - uGate) * 16.0);
  gl_Position = vec4(x, y, 0.0, 1.0);
  gl_PointSize = size * uScale;
}`;

const particleFragment = `
precision mediump float;
uniform sampler2D uAtlas;
uniform vec3 uNoise;
uniform vec3 uSignal;
uniform vec3 uHeat;
varying float vAlpha;
varying float vGlyph;
varying float vSignal;
varying float vHeat;

void main() {
  vec2 cell = vec2(mod(vGlyph, 4.0), floor(vGlyph / 4.0));
  float a = texture2D(uAtlas, (cell + gl_PointCoord) / 4.0).a * vAlpha;
  if (a < 0.01) discard;
  vec3 color = mix(uNoise, uSignal, vSignal);
  color = mix(color, uHeat, vHeat * 0.85);
  gl_FragColor = vec4(color * a, a);
}`;

const backgroundVertex = `
attribute vec2 aPos;
varying vec2 vPos;
void main() { vPos = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const backgroundFragment = `
precision mediump float;
uniform float uTime;
uniform float uGate;
uniform vec3 uTop;
uniform vec3 uBottom;
uniform vec3 uHeat;
varying vec2 vPos;

float hash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

void main() {
  vec3 color = mix(uBottom, uTop, vPos.y * 0.5 + 0.5);
  float dx = vPos.x - uGate;
  // Gate glow with a slow scan moving up the line.
  float line = exp(-abs(dx) * 90.0) * 0.9 + exp(-abs(dx) * 9.0) * 0.12;
  float scan = 0.55 + 0.45 * sin(vPos.y * 18.0 - uTime * 2.2);
  color += uHeat * line * scan;
  // Faint context rows on the far side of the gate.
  float rows = 6.0;
  float r = (vPos.y / 0.12) + (rows - 1.0) * 0.5;
  float rowLine = exp(-pow(fract(r + 0.5) - 0.5, 2.0) * 900.0) * step(abs(vPos.y), 0.34);
  color += uHeat * rowLine * 0.05 * smoothstep(uGate, uGate + 0.2, vPos.x);
  // Fine grain on the noisy side.
  color += (hash(floor(gl_FragCoord.xy / 2.0) + floor(uTime * 8.0)) - 0.5) * 0.025 * (1.0 - smoothstep(uGate - 0.2, uGate, vPos.x));
  gl_FragColor = vec4(color, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader error');
  return shader;
}

function program(gl, vertex, fragment) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
  return p;
}

function atlas() {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size * ATLAS_CELLS;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${size * 0.78}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;
  [...NOISE, ...SIGNAL].forEach((glyph, i) => {
    ctx.fillText(glyph, (i % 4) * size + size / 2, Math.floor(i / 4) * size + size / 2 + 2);
  });
  const gradient = ctx.createRadialGradient(3.5 * size, 3.5 * size, 0, 3.5 * size, 3.5 * size, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(3 * size, 3 * size, size, size);
  return c;
}

function rgb(name) {
  const value = getComputedStyle(figure).getPropertyValue(name).trim();
  const hex = value.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return [0.5, 0.7, 0.9];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
}

function start() {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: true, powerPreference: 'low-power' });
  if (!gl) return;

  const particles = program(gl, particleVertex, particleFragment);
  const background = program(gl, backgroundVertex, backgroundFragment);

  const count = window.innerWidth < 720 ? 700 : 1500;
  const data = new Float32Array(count * 6);
  for (let i = 0; i < count; i++) {
    const signal = Math.random() < 0.13 ? 1 : 0;
    const glyph = signal ? 8 + Math.floor(Math.random() * SIGNAL.length) : Math.floor(Math.random() * NOISE.length);
    data.set([Math.random(), Math.random(), Math.random(), Math.random(), glyph, signal], i * 6);
  }
  const particleBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas());
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const u = (p, name) => gl.getUniformLocation(p, name);
  const pa = { seed: gl.getAttribLocation(particles, 'aSeed'), glyph: gl.getAttribLocation(particles, 'aGlyph'), signal: gl.getAttribLocation(particles, 'aSignal') };
  const ba = gl.getAttribLocation(background, 'aPos');

  let colors;
  const readColors = () => {
    colors = { top: rgb('--viz-top'), bottom: rgb('--viz-bottom'), noise: rgb('--viz-noise'), signal: rgb('--viz-signal'), heat: rgb('--viz-heat') };
  };
  readColors();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readColors);

  let scale = 1;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    scale = dpr * Math.min(1.25, Math.max(0.7, rect.width / 640));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  const pointer = { x: -2, y: -2, tx: -2, ty: -2 };
  let gate = 0.02;
  let gateTarget = 0.02;
  figure.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    pointer.tx = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.ty = 1 - ((event.clientY - rect.top) / rect.height) * 2;
    gateTarget = 0.02 + pointer.tx * 0.14;
  });
  figure.addEventListener('pointerleave', () => { pointer.tx = pointer.ty = -2; gateTarget = 0.02; });

  function draw(time) {
    pointer.x += (pointer.tx - pointer.x) * 0.08;
    pointer.y += (pointer.ty - pointer.y) * 0.08;
    gate += (gateTarget - gate) * 0.05;
    figure.style.setProperty('--gate', `${((gate + 1) / 2) * 100}%`);

    gl.disable(gl.BLEND);
    gl.useProgram(background);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(ba);
    gl.vertexAttribPointer(ba, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(u(background, 'uTime'), time);
    gl.uniform1f(u(background, 'uGate'), gate);
    gl.uniform3fv(u(background, 'uTop'), colors.top);
    gl.uniform3fv(u(background, 'uBottom'), colors.bottom);
    gl.uniform3fv(u(background, 'uHeat'), colors.heat);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(ba);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(particles);
    gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
    gl.enableVertexAttribArray(pa.seed);
    gl.vertexAttribPointer(pa.seed, 4, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(pa.glyph);
    gl.vertexAttribPointer(pa.glyph, 1, gl.FLOAT, false, 24, 16);
    gl.enableVertexAttribArray(pa.signal);
    gl.vertexAttribPointer(pa.signal, 1, gl.FLOAT, false, 24, 20);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(u(particles, 'uAtlas'), 0);
    gl.uniform1f(u(particles, 'uTime'), time);
    gl.uniform1f(u(particles, 'uGate'), gate);
    gl.uniform2f(u(particles, 'uPointer'), pointer.x, pointer.y);
    gl.uniform1f(u(particles, 'uScale'), scale);
    gl.uniform3fv(u(particles, 'uNoise'), colors.noise);
    gl.uniform3fv(u(particles, 'uSignal'), colors.signal);
    gl.uniform3fv(u(particles, 'uHeat'), colors.heat);
    gl.drawArrays(gl.POINTS, 0, count);
  }

  let frame = 0;
  let onScreen = true;
  let lost = false;
  const startTime = performance.now();
  const loop = (now) => {
    frame = 0;
    if (lost) return;
    draw((now - startTime) / 1000);
    if (!motion.matches && onScreen && !document.hidden) frame = requestAnimationFrame(loop);
  };
  const kick = () => { if (!frame && !lost) frame = requestAnimationFrame(loop); };

  new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; if (onScreen) kick(); }).observe(canvas);
  document.addEventListener('visibilitychange', kick);
  motion.addEventListener('change', kick);
  // With reduced motion, draw one still frame mid-flow and redraw on resize.
  new ResizeObserver(() => { if (motion.matches) requestAnimationFrame(() => draw(12)); }).observe(canvas);
  canvas.addEventListener('webglcontextlost', (event) => { event.preventDefault(); lost = true; figure.classList.remove('gl-ready'); });

  figure.classList.add('gl-ready');
  if (motion.matches) draw(12); else kick();
}

if (canvas && figure) {
  try { start(); } catch (error) { console.warn('Hero effect disabled:', error); }
}
