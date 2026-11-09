import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createIntroStage } from '@/components/onboarding/first-sign-up-intro-stage';
import { APPEAR_TOTAL, INTRO_PIECES, TILE } from '@/lib/first-sign-up-intro-timeline';

// The canvas stage of the first sign-up intro, on a 2D context that records
// what it is asked to draw (jsdom has no canvas). The pixels themselves were
// checked on the page (archive/web-onboarding-parity-2026-11-09/pr4-intro/).

type Draw = { args: number[]; transform: number[]; alpha: number };

/** The atlas's width as the stage read its pixels, for the ink test. */
let atlasWidth = 0;

function recordingContext(canvas: HTMLCanvasElement, draws: Draw[]) {
  let transform = [1, 0, 0, 1, 0, 0];
  const size = (font: string) => Number(/([\d.]+)px/.exec(font)?.[1] ?? 10);
  const context = {
    font: '10px sans-serif',
    fillStyle: '#000',
    textBaseline: 'alphabetic',
    textAlign: 'left',
    letterSpacing: '0px',
    globalAlpha: 1,
    measureText(text: string) {
      const px = size(this.font);
      const width = text.length * px * 0.5;
      return {
        width,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
        actualBoundingBoxAscent: px * 0.72,
        actualBoundingBoxDescent: px * 0.2,
        fontBoundingBoxAscent: px * 0.92,
        fontBoundingBoxDescent: px * 0.26,
      };
    },
    fillText: vi.fn(),
    setTransform(...values: number[]) {
      transform = values;
    },
    clearRect: vi.fn(),
    // Ink in the left three quarters of the atlas only.
    getImageData(_x: number, _y: number, width: number, height: number) {
      atlasWidth = width;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let row = 0; row < height; row += 1) {
        for (let col = 0; col < Math.floor(width * 0.75); col += 1) data[(row * width + col) * 4 + 3] = 255;
      }
      return { data, width, height };
    },
    drawImage(_source: unknown, ...args: number[]) {
      if (canvas.dataset.main) draws.push({ args, transform, alpha: context.globalAlpha });
    },
  };
  return context;
}

describe('the intro\'s canvas stage', () => {
  let draws: Draw[];
  let main: HTMLCanvasElement;

  beforeEach(() => {
    draws = [];
    main = document.createElement('canvas');
    main.dataset.main = '1';
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      return recordingContext(this, draws) as unknown as CanvasRenderingContext2D;
    } as unknown as HTMLCanvasElement['getContext']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stage(calm = false) {
    const created = createIntroStage(main, {
      faces: { display: "'Display'", handwriting: "'Hand'" },
      ink: { primary: '#ff7a59', image: '#73bff2', motion: '#b7a0f5', note: '#ddd6cc' },
      calm,
    })!;
    created.layout({ width: 390, height: 844 }, 2);
    return created;
  }

  it('sizes the canvas to the window at the screen\'s density', () => {
    stage();
    expect([main.width, main.height]).toEqual([780, 1688]);
  });

  it('turns the words to dust where they stand: each tile at rest sits on whole device pixels, on its word', () => {
    const intro = stage();
    intro.drawWords(APPEAR_TOTAL);
    // Every word and note, whole, opaque, on whole device pixels.
    const words = draws.map(({ args, alpha }) => ({ x: args[4], y: args[5], width: args[6], alpha }));
    expect(words).toHaveLength(INTRO_PIECES.length);
    for (const word of words) {
      expect(word.alpha).toBe(1);
      expect(Number.isInteger(word.x)).toBe(true);
      expect(Number.isInteger(word.y)).toBe(true);
    }

    draws.length = 0;
    intro.drawDust(0);
    // At the first instant of the dust nothing has moved, turned or shrunk.
    for (const { transform, alpha } of draws) {
      // (+ 0: a turn of 0 gives -0 for the sine.)
      expect(transform.slice(0, 4).map((value) => value + 0)).toEqual([1, 0, 0, 1]);
      expect(alpha).toBe(1);
    }
    // The first word's top-left tile (the atlas's own top-left) starts exactly where the word was drawn.
    const tile = Math.round(TILE * 1 * 2);
    const corner = draws.find(({ args }) => args[0] === 0 && args[1] === 0)!;
    // Its centre, less half a tile (where drawImage puts its corner), is the word's own corner.
    expect(corner.transform[4] + corner.args[4]).toBe(words[0].x);
    expect(corner.transform[5] + corner.args[5]).toBe(words[0].y);
    for (const { transform, args } of draws) {
      expect(Number.isInteger(transform[4] + args[4])).toBe(true);
      expect(Number.isInteger(transform[5] + args[5])).toBe(true);
      expect(args[2]).toBeLessThanOrEqual(tile);
    }
  });

  it('leaves out the tiles that hold no ink', () => {
    const intro = stage();
    intro.drawDust(0);
    // Ink only in the left three quarters of the atlas: no tile is cut from past that edge,
    // though the widest picture reaches it.
    const inkEdge = Math.floor(atlasWidth * 0.75);
    expect(atlasWidth).toBeGreaterThan(inkEdge);
    expect(draws.length).toBeGreaterThan(0);
    expect(draws.filter(({ args }) => args[0] >= inkEdge)).toEqual([]);
    expect(Math.max(...draws.map(({ args }) => args[0]))).toBeGreaterThan(inkEdge - TILE * 2 * 2);
  });

  it('carries every grain away by the end of the dust', () => {
    const intro = stage();
    intro.drawDust(0.5);
    expect(draws.some(({ transform }) => transform[1] !== 0)).toBe(true);
    draws.length = 0;
    intro.drawDust(1);
    expect(draws).toHaveLength(0);
  });

  it('draws the words with no dust at all under reduced motion', () => {
    const intro = stage(true);
    intro.drawDust(0);
    expect(draws).toHaveLength(0);
  });

  it('lets go of every pixel when the dust has gone', () => {
    const intro = stage();
    intro.release();
    expect([main.width, main.height]).toEqual([0, 0]);
  });
});
