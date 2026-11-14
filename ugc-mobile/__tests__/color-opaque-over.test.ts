import { describe, expect, it } from 'vitest';

import { opaqueOver } from '@/lib/color-contrast';
import { themes } from '@/lib/theme';

describe('opaqueOver', () => {
  it('composites an rgba tint onto a solid surface by its alpha', () => {
    expect(opaqueOver('rgba(255,248,237,0.22)', '#151518')).toBe('#484747');
    expect(opaqueOver('rgba(0, 0, 0, 0.5)', '#ffffff')).toBe('#808080');
    expect(opaqueOver('rgba(10,20,30,1)', '#ffffff')).toBe('#0a141e');
    expect(opaqueOver('rgba(10,20,30,0)', '#abcdef')).toBe('#abcdef');
  });

  it('leaves a solid colour as it is', () => {
    expect(opaqueOver('#ff7a59', '#000000')).toBe('#ff7a59');
  });

  it("gives the comment thread's line a solid colour on every surface it is drawn on", () => {
    for (const { colors } of [themes.dark, themes.light]) {
      for (const surface of [colors.panel, colors.app]) {
        expect(opaqueOver(colors.borderStrong, surface)).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});
