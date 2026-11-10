// Hero effect on the docs page. Code glyphs stream left to right as noisy
// lanes. At the filter gate the noise drifts away as snow, and the few signal
// glyphs settle into tidy context rows. Plain WebGL 1, decorative only.
//
// Performance notes:
// - Nothing in the frame loop writes CSS or reads layout. The gate label moves
//   with a transform, and the canvas position is cached.
// - Pixel density is capped at 1.5x, and the resolution steps down when frames
//   stay slow, because fill rate dominates the cost.
// - The loop pauses when the canvas is off screen or the tab is hidden.
import { createGlyphAtlas } from './atlas.js';
import { createBuffer, createProgram, createTexture, uniformLocations } from './gl.js';
import { createParticleData, FLOATS_PER_PARTICLE, particleCountFor } from './particles.js';
import { backgroundFragment, backgroundVertex, particleFragment, particleVertex } from './shaders.js';

const canvas = document.getElementById('hero-canvas');
const figure = canvas?.closest('.hero-visual');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const MAX_PIXEL_RATIO = 1.5;
const QUALITY_STEPS = [1, 0.8, 0.65];
const SLOW_FRAME_MS = 22;
const SLOW_FRAMES_BEFORE_STEP = 120;
const GATE_REST = 0.02;
const GATE_SWING = 0.14;
const STILL_FRAME_TIME = 12;

// Reads a six-digit hex colour token from the CSS as a WebGL colour.
function cssColor(name) {
  const hex = getComputedStyle(figure).getPropertyValue(name).trim().replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return [0.5, 0.7, 0.9];
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
}

function readColors() {
  return {
    top: cssColor('--viz-top'),
    bottom: cssColor('--viz-bottom'),
    noise: cssColor('--viz-noise'),
    signal: cssColor('--viz-signal'),
    heat: cssColor('--viz-heat'),
  };
}

function start() {
  const gl = canvas.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: true, powerPreference: 'low-power' });
  if (!gl) return;

  // Programs, buffers and the glyph texture.
  const particles = createProgram(gl, particleVertex, particleFragment);
  const background = createProgram(gl, backgroundVertex, backgroundFragment);
  const count = particleCountFor(window.innerWidth);
  const particleBuffer = createBuffer(gl, createParticleData(count));
  const quadBuffer = createBuffer(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
  const atlas = createTexture(gl, createGlyphAtlas());

  const backgroundUniforms = uniformLocations(gl, background, ['uTime', 'uGate', 'uTop', 'uBottom', 'uHeat']);
  const particleUniforms = uniformLocations(gl, particles, ['uAtlas', 'uTime', 'uGate', 'uPointer', 'uScale', 'uNoise', 'uSignal', 'uHeat']);
  const attributes = {
    position: gl.getAttribLocation(background, 'aPos'),
    seed: gl.getAttribLocation(particles, 'aSeed'),
    glyph: gl.getAttribLocation(particles, 'aGlyph'),
    signal: gl.getAttribLocation(particles, 'aSignal'),
  };

  let colors = readColors();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { colors = readColors(); });

  // Size and resolution.
  const label = figure.querySelector('.hero-gate');
  let quality = 0;
  let glyphScale = 1;
  let rect = canvas.getBoundingClientRect();
  let labelX = NaN;

  function resize() {
    rect = canvas.getBoundingClientRect();
    const pixelRatio = Math.max(1, Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO) * QUALITY_STEPS[quality]);
    canvas.width = Math.max(1, Math.round(rect.width * pixelRatio));
    canvas.height = Math.max(1, Math.round(rect.height * pixelRatio));
    glyphScale = pixelRatio * Math.min(1.25, Math.max(0.7, rect.width / 640));
    gl.viewport(0, 0, canvas.width, canvas.height);
    labelX = NaN;
  }

  new ResizeObserver(resize).observe(canvas);
  // Cache the canvas position so pointer events never force a layout.
  window.addEventListener('scroll', () => { rect = canvas.getBoundingClientRect(); }, { passive: true });
  resize();

  // Pointer: parts the incoming stream and nudges the gate.
  const pointer = { x: -2, y: -2, targetX: -2, targetY: -2 };
  let gate = GATE_REST;
  let gateTarget = GATE_REST;

  figure.addEventListener('pointermove', (event) => {
    pointer.targetX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.targetY = 1 - ((event.clientY - rect.top) / rect.height) * 2;
    gateTarget = GATE_REST + pointer.targetX * GATE_SWING;
  }, { passive: true });

  figure.addEventListener('pointerleave', () => {
    pointer.targetX = -2;
    pointer.targetY = -2;
    gateTarget = GATE_REST;
  });

  function moveGateLabel() {
    // Compositor-only transform, and only when it moved at least half a pixel.
    const x = ((gate + 1) / 2) * rect.width;
    if (Math.abs(x - labelX) < 0.5) return;
    labelX = x;
    label.style.transform = `translate3d(${x.toFixed(1)}px, 0, 0) translateX(-50%)`;
  }

  function drawBackground(time) {
    gl.disable(gl.BLEND);
    gl.useProgram(background);
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(attributes.position);
    gl.vertexAttribPointer(attributes.position, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1f(backgroundUniforms.uTime, time);
    gl.uniform1f(backgroundUniforms.uGate, gate);
    gl.uniform3fv(backgroundUniforms.uTop, colors.top);
    gl.uniform3fv(backgroundUniforms.uBottom, colors.bottom);
    gl.uniform3fv(backgroundUniforms.uHeat, colors.heat);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(attributes.position);
  }

  function drawParticles(time) {
    const stride = FLOATS_PER_PARTICLE * 4;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(particles);
    gl.bindBuffer(gl.ARRAY_BUFFER, particleBuffer);
    gl.enableVertexAttribArray(attributes.seed);
    gl.vertexAttribPointer(attributes.seed, 4, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(attributes.glyph);
    gl.vertexAttribPointer(attributes.glyph, 1, gl.FLOAT, false, stride, 16);
    gl.enableVertexAttribArray(attributes.signal);
    gl.vertexAttribPointer(attributes.signal, 1, gl.FLOAT, false, stride, 20);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.uniform1i(particleUniforms.uAtlas, 0);
    gl.uniform1f(particleUniforms.uTime, time);
    gl.uniform1f(particleUniforms.uGate, gate);
    gl.uniform2f(particleUniforms.uPointer, pointer.x, pointer.y);
    gl.uniform1f(particleUniforms.uScale, glyphScale);
    gl.uniform3fv(particleUniforms.uNoise, colors.noise);
    gl.uniform3fv(particleUniforms.uSignal, colors.signal);
    gl.uniform3fv(particleUniforms.uHeat, colors.heat);
    gl.drawArrays(gl.POINTS, 0, count);
  }

  function draw(time) {
    pointer.x += (pointer.targetX - pointer.x) * 0.08;
    pointer.y += (pointer.targetY - pointer.y) * 0.08;
    gate += (gateTarget - gate) * 0.05;
    moveGateLabel();
    drawBackground(time);
    drawParticles(time);
  }

  // Frame loop.
  const startTime = performance.now();
  let frame = 0;
  let onScreen = true;
  let contextLost = false;
  let lastFrame = 0;
  let slowFrames = 0;

  // About two seconds of slow frames lowers the resolution one step.
  function adaptQuality(now) {
    if (lastFrame && now - lastFrame < 250) {
      slowFrames = now - lastFrame > SLOW_FRAME_MS ? slowFrames + 1 : Math.max(0, slowFrames - 2);
      if (slowFrames > SLOW_FRAMES_BEFORE_STEP && quality < QUALITY_STEPS.length - 1) {
        quality++;
        slowFrames = 0;
        resize();
      }
    }
    lastFrame = now;
  }

  function loop(now) {
    frame = 0;
    if (contextLost) return;
    adaptQuality(now);
    draw((now - startTime) / 1000);
    if (!reducedMotion.matches && onScreen && !document.hidden) frame = requestAnimationFrame(loop);
  }

  function resume() {
    if (!frame && !contextLost) frame = requestAnimationFrame(loop);
  }

  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    if (onScreen) resume();
  }).observe(canvas);
  document.addEventListener('visibilitychange', resume);
  reducedMotion.addEventListener('change', resume);

  // With reduced motion, draw one still frame mid-flow and redraw on resize.
  new ResizeObserver(() => {
    if (reducedMotion.matches) requestAnimationFrame(() => draw(STILL_FRAME_TIME));
  }).observe(canvas);

  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
    figure.classList.remove('gl-ready');
  });

  figure.classList.add('gl-ready');
  if (reducedMotion.matches) draw(STILL_FRAME_TIME);
  else resume();
}

if (canvas && figure) {
  try {
    start();
  } catch (error) {
    console.warn('Hero effect disabled:', error);
  }
}
