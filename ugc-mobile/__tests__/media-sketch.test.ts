import { describe, expect, it } from 'vitest';

import {
  MEDIA_SKETCH_STROKE_LENGTHS,
  MEDIA_SKETCH_STROKES,
  MEDIA_SKETCH_TOTAL_LENGTH,
  MEDIA_SKETCH_VIEWBOX,
  mediaSketchDrawnLength,
  mediaSketchOpacity,
  mediaSketchScale,
  mediaSketchStrokeDrawn,
  mediaSketchTip,
  sketchStrokePath,
} from '../lib/media-sketch';

describe('loading sketch drawing', () => {
  it('keeps every stroke inside its drawing box', () => {
    for (const stroke of MEDIA_SKETCH_STROKES) {
      for (const point of stroke) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(MEDIA_SKETCH_VIEWBOX.width);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(MEDIA_SKETCH_VIEWBOX.height);
      }
    }
  });

  it('writes each stroke as one path', () => {
    expect(sketchStrokePath(MEDIA_SKETCH_STROKES[0])).toBe('M4 31 L15 16 L22 24 L31 11 L44 31');
  });

  it('draws nothing at the start of a cycle and the whole sketch before it holds', () => {
    expect(mediaSketchDrawnLength(0)).toBe(0);
    expect(mediaSketchDrawnLength(0.7)).toBeCloseTo(MEDIA_SKETCH_TOTAL_LENGTH, 6);
    expect(mediaSketchDrawnLength(0.95)).toBeCloseTo(MEDIA_SKETCH_TOTAL_LENGTH, 6);
  });

  it('draws the strokes one after another', () => {
    const firstLength = MEDIA_SKETCH_STROKE_LENGTHS[0];
    expect(mediaSketchStrokeDrawn(firstLength / 2, 0)).toBeCloseTo(firstLength / 2, 6);
    expect(mediaSketchStrokeDrawn(firstLength / 2, 1)).toBe(0);
    expect(mediaSketchStrokeDrawn(firstLength + 3, 0)).toBe(firstLength);
    expect(mediaSketchStrokeDrawn(firstLength + 3, 1)).toBeCloseTo(3, 6);
    expect(mediaSketchStrokeDrawn(MEDIA_SKETCH_TOTAL_LENGTH, 1)).toBeCloseTo(MEDIA_SKETCH_STROKE_LENGTHS[1], 6);
  });

  it('keeps the pencil on the end of the line', () => {
    expect(mediaSketchTip(0)).toEqual(MEDIA_SKETCH_STROKES[0][0]);
    const lastStroke = MEDIA_SKETCH_STROKES[MEDIA_SKETCH_STROKES.length - 1];
    const end = mediaSketchTip(MEDIA_SKETCH_TOTAL_LENGTH);
    expect(end.x).toBeCloseTo(lastStroke[lastStroke.length - 1].x, 6);
    expect(end.y).toBeCloseTo(lastStroke[lastStroke.length - 1].y, 6);
    // The first corner of the mountains.
    const corner = Math.hypot(15 - 4, 16 - 31);
    const tip = mediaSketchTip(corner);
    expect(tip.x).toBeCloseTo(15, 6);
    expect(tip.y).toBeCloseTo(16, 6);
  });

  it('holds the finished sketch, then fades it before the next one begins', () => {
    expect(mediaSketchOpacity(0.5)).toBe(1);
    expect(mediaSketchOpacity(0.86)).toBe(1);
    expect(mediaSketchOpacity(0.93)).toBeLessThan(1);
    expect(mediaSketchOpacity(1)).toBeGreaterThan(0);
  });
});

describe('loading sketch size', () => {
  it('draws at full size in a feed tile', () => {
    expect(mediaSketchScale(180, 240)).toBe(1);
  });

  it('shrinks to fit a creator reference thumbnail', () => {
    const scale = mediaSketchScale(72, 72);
    expect(scale).not.toBeNull();
    expect(scale!).toBeLessThan(1);
    expect(scale!).toBeGreaterThanOrEqual(0.6);
  });

  it('leaves an avatar-sized thumbnail to its placeholder', () => {
    expect(mediaSketchScale(34, 34)).toBeNull();
    expect(mediaSketchScale(400, 40)).toBeNull();
  });
});
