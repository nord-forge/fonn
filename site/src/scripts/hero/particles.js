// Per-particle data for the hero, packed as six floats per particle:
// four random seeds (speed, lane, phase and drift), the atlas glyph index,
// and whether the particle is signal (1) or noise (0).
import { NOISE_GLYPHS, SIGNAL_GLYPHS, SIGNAL_OFFSET } from './atlas.js';

export const FLOATS_PER_PARTICLE = 6;
const SIGNAL_SHARE = 0.13;

export function particleCountFor(width) {
  return width < 720 ? 700 : 1500;
}

export function createParticleData(count) {
  const data = new Float32Array(count * FLOATS_PER_PARTICLE);

  for (let index = 0; index < count; index++) {
    const isSignal = Math.random() < SIGNAL_SHARE;
    const glyph = isSignal
      ? SIGNAL_OFFSET + Math.floor(Math.random() * SIGNAL_GLYPHS.length)
      : Math.floor(Math.random() * NOISE_GLYPHS.length);

    data.set(
      [Math.random(), Math.random(), Math.random(), Math.random(), glyph, isSignal ? 1 : 0],
      index * FLOATS_PER_PARTICLE,
    );
  }
  return data;
}
