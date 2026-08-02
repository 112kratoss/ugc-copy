import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('immersive viewer swipe hints', () => {
  it('does not render directional hint labels over media or details', () => {
    const source = readFileSync('app/viewer.tsx', 'utf8');

    expect(source).not.toContain('getImmersiveSlideHint');
    expect(source).not.toContain('Swipe left for details');
    expect(source).not.toContain('Swipe right for media');
  });
});
