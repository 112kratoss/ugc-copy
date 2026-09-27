import { describe, expect, it } from 'vitest';

import { toAndroidColor } from '../lib/android-color';
import { themes } from '../lib/theme';

/** What `Color.parseColor` accepts, which is how Expo UI's Compose views read a colour prop. */
const ANDROID_PARSEABLE = /^#(?:[0-9a-f]{6}|[0-9a-f]{8})$/i;

describe('palette colours handed to Android', () => {
  it('keeps six-digit hex as it is', () => {
    expect(toAndroidColor('#f2ede6')).toBe('#f2ede6');
  });

  it('writes a translucent rgba() with its alpha first', () => {
    expect(toAndroidColor('rgba(28,20,15,0.12)')).toBe('#1f1c140f');
    expect(toAndroidColor('rgba(255, 248, 237, 0.12)')).toBe('#1ffff8ed');
  });

  it('writes an opaque one as plain hex', () => {
    expect(toAndroidColor('rgba(180,35,60,1)')).toBe('#b4233c');
    expect(toAndroidColor('rgb(180, 35, 60)')).toBe('#b4233c');
  });

  it('moves the alpha of CSS eight-digit hex to the front, where Android reads it', () => {
    expect(toAndroidColor('#1c140f1f')).toBe('#1f1c140f');
  });

  it('leaves a colour it cannot read unchanged', () => {
    expect(toAndroidColor('hsl(20, 30%, 40%)')).toBe('hsl(20, 30%, 40%)');
  });

  it.each(Object.entries(themes))('turns every %s palette colour into one Android can parse', (_scheme, theme) => {
    for (const [token, colour] of Object.entries(theme.colors)) {
      expect(toAndroidColor(colour), token).toMatch(ANDROID_PARSEABLE);
    }
  });
});
