// Glyph atlas for the hero particles: a 4 by 4 grid of white glyphs on a
// transparent canvas. Cells 0 to 7 hold noise glyphs, 8 to 14 signal glyphs,
// and cell 15 a soft round dot used for the falling "snow".

export const NOISE_GLYPHS = ['.', '.', ':', '=', '-', '0', '1', '%'];
export const SIGNAL_GLYPHS = ['{', '}', '(', ')', 'f', '>', '/'];
export const SIGNAL_OFFSET = NOISE_GLYPHS.length;

const CELLS = 4;
const CELL_SIZE = 64;

export function createGlyphAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = CELLS * CELL_SIZE;
  canvas.height = CELLS * CELL_SIZE;
  const context = canvas.getContext('2d');

  context.fillStyle = '#fff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.font = `600 ${CELL_SIZE * 0.78}px ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

  [...NOISE_GLYPHS, ...SIGNAL_GLYPHS].forEach((glyph, index) => {
    const x = (index % CELLS) * CELL_SIZE + CELL_SIZE / 2;
    const y = Math.floor(index / CELLS) * CELL_SIZE + CELL_SIZE / 2 + 2;
    context.fillText(glyph, x, y);
  });

  // The last cell is a soft dot.
  const centre = 3.5 * CELL_SIZE;
  const dot = context.createRadialGradient(centre, centre, 0, centre, centre, CELL_SIZE / 2);
  dot.addColorStop(0, 'rgba(255,255,255,1)');
  dot.addColorStop(0.35, 'rgba(255,255,255,0.7)');
  dot.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = dot;
  context.fillRect(3 * CELL_SIZE, 3 * CELL_SIZE, CELL_SIZE, CELL_SIZE);

  return canvas;
}
