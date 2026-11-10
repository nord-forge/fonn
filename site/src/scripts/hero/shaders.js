// GLSL shaders for the hero effect.
//
// Particles: each glyph moves left to right along a lane. Past the filter
// gate, noise glyphs fall away as snow and turn into soft dots, while signal
// glyphs settle into six ordered "context" rows.
//
// Background: a dark gradient, the glowing gate line with a slow upward scan,
// faint context rows on the right and fine grain on the noisy left side.

export const particleVertex = `
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

export const particleFragment = `
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

export const backgroundVertex = `
attribute vec2 aPos;
varying vec2 vPos;
void main() { vPos = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const backgroundFragment = `
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
