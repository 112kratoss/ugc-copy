import { describe, expect, it } from 'vitest';

import { appTheme, mediaColors, themes, type ColorScheme } from '../lib/theme';

const HEX = /^#[0-9a-fA-F]{6}$/;
const RGBA = /^rgba\(\d{1,3},\d{1,3},\d{1,3},(?:0|1|0?\.\d+)\)$/;

/**
 * The two palettes are swapped wholesale at runtime, so any asymmetry is a
 * screen that breaks in one scheme only. These rules keep them swappable.
 */
describe('theme palettes', () => {
  it('carry exactly the same colour names', () => {
    expect(Object.keys(themes.light.colors).sort()).toEqual(Object.keys(themes.dark.colors).sort());
    expect(Object.keys(themes.light.semantic).sort()).toEqual(Object.keys(themes.dark.semantic).sort());
    expect(Object.keys(themes.light.shadow).sort()).toEqual(Object.keys(themes.dark.shadow).sort());
  });

  it('keep each colour in the same notation in both schemes', () => {
    // Call sites suffix an alpha byte onto solid colours (`${colors.primary}22`,
    // `hexWithAlpha`), and relativeLuminance only reads #rrggbb — so a solid
    // colour that became rgba() in one palette would render as garbage there.
    const mismatches = (Object.keys(themes.dark.colors) as Array<keyof typeof themes.dark.colors>).flatMap((name) => {
      const dark = themes.dark.colors[name];
      const light = themes.light.colors[name];
      const notation = (value: string) => (HEX.test(value) ? 'hex' : RGBA.test(value) ? 'rgba' : 'other');
      return notation(dark) === notation(light) && notation(dark) !== 'other' ? [] : [`${name}: ${dark} / ${light}`];
    });
    expect(mismatches).toEqual([]);
  });

  it.each(['dark', 'light'] as ColorScheme[])('names its own scheme (%s)', (scheme) => {
    expect(themes[scheme].scheme).toBe(scheme);
  });

  it('shares every scheme-independent token between the two themes', () => {
    for (const token of ['radii', 'spacing', 'type', 'typeScale', 'icon', 'touch', 'opacity', 'motion'] as const) {
      expect(themes.light[token]).toBe(themes.dark[token]);
      expect(appTheme[token]).toBe(themes.dark[token]);
    }
  });

  it('keeps colours off the static tokens, and the dark palette the one the app shipped with', () => {
    // A colour read from a module constant never redraws on a scheme switch,
    // so `appTheme` carries none; `useAppTheme()` is the only way to a colour.
    expect(Object.keys(appTheme)).not.toEqual(expect.arrayContaining(['colors']));
    for (const key of ['colors', 'semantic', 'state', 'shadow', 'dim', 'tabBar'] as const) {
      expect(appTheme).not.toHaveProperty(key);
    }
    expect(themes.dark.colors.background).toBe('#070708');
    expect(themes.dark.colors.primary).toBe('#ff7a59');
    expect(themes.dark.colors.primaryFill).toBe(themes.dark.colors.primary);
  });

  it('draws over pictures in the same colours whatever the scheme', () => {
    expect(mediaColors.onMedia).toBe('#ffffff');
    expect(mediaColors.mediaGround).toBe('#000000');
  });
});
