import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('react-native', () => ({
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) => React.createElement('linear-gradient', props, children),
}));

import { TopScrim } from '../components/top-scrim';
import { themes } from '../lib/theme';
import { ThemeScope } from '../lib/theme-context';
import { viewerTopScrim } from '../lib/viewer-chrome';

describe('the reel\'s top shade', () => {
  // React Native's gradient takes its stops as a CSS string, with positions in
  // percent of the shade's height; viewerTopScrim places them in points.
  it.each([47, 59, 62])('draws viewerTopScrim\'s stops where it places them, at inset %i', (inset) => {
    let tree!: renderer.ReactTestRenderer;
    // The reel draws in its dark scope whatever the phone's scheme.
    renderer.act(() => {
      tree = renderer.create(
        <ThemeScope scheme="dark">
          <TopScrim topInset={inset} over="media" />
        </ThemeScope>,
      );
    });
    const { style } = tree.root.findByType('view' as never).props;
    const { height, stops } = viewerTopScrim(inset);
    expect(style.height).toBe(height);
    const gradient = /^linear-gradient\(to bottom, (.*)\)$/.exec(style.experimental_backgroundImage);
    expect(gradient).not.toBeNull();
    const drawn = gradient![1].split(', ').map((stop) => {
      const [color, position] = stop.split(' ');
      return { color, offset: (Number.parseFloat(position) / 100) * height };
    });
    expect(drawn).toHaveLength(stops.length);
    drawn.forEach((stop, index) => {
      expect(stop.color.slice(0, 7)).toBe(themes.dark.colors.background);
      expect(Number.parseInt(stop.color.slice(7), 16) / 255).toBeCloseTo(stops[index].alpha, 2);
      expect(stop.offset).toBeCloseTo(stops[index].offset, 2);
    });
  });
});

// The tab roots' shade (Home, Explore, Alerts, Profile), whose lists scroll
// under the status bar. A straight fade from the top of the inset to its foot
// left the clock and icons, in the middle of the inset, over content still
// drawn at about half strength: the profile's @handle on the S24 and its
// credits card on the iPhone (feel audit 2026-11-27).
describe('the tab roots\' top shade', () => {
  type Gradient = { colors: string[]; locations?: number[]; style: { height: number } };
  const alphaOf = (color: string) => (color.length === 9 ? Number.parseInt(color.slice(7), 16) / 255 : 1);
  /** The shade's opacity `y` points down, as the gradient draws it between its stops. */
  function alphaAt({ colors, locations, style }: Gradient, y: number) {
    const at = locations ?? colors.map((_, index) => index / (colors.length - 1));
    const position = y / style.height;
    if (position <= at[0]) return alphaOf(colors[0]);
    for (let index = 1; index < at.length; index += 1) {
      if (position > at[index]) continue;
      const span = at[index] - at[index - 1];
      const share = span > 0 ? (position - at[index - 1]) / span : 1;
      return alphaOf(colors[index - 1]) + (alphaOf(colors[index]) - alphaOf(colors[index - 1])) * share;
    }
    return alphaOf(colors[colors.length - 1]);
  }
  function drawn(inset: number, scheme: 'dark' | 'light' = 'dark'): Gradient {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <ThemeScope scheme={scheme}>
          <TopScrim topInset={inset} />
        </ThemeScope>,
      );
    });
    const gradient = tree.root.findByType('linear-gradient' as never).props as Gradient;
    renderer.act(() => tree.unmount());
    return gradient;
  }

  it.each([24, 39, 47, 59, 62])('hides the content under the whole status bar, at inset %i', (inset) => {
    const gradient = drawn(inset);
    for (let y = 0; y <= inset; y += 1) expect(alphaAt(gradient, y), `${y}pt down`).toBeGreaterThan(0.999);
  });

  it.each([24, 39, 59])('fades out within 10pt below it, clear of every tab root\'s first row at rest, at inset %i', (inset) => {
    const gradient = drawn(inset);
    // Home's top bar starts 10pt under the inset, Explore's and Profile's 12, Alerts' 18.
    expect(gradient.style.height - inset).toBeGreaterThan(0);
    expect(gradient.style.height - inset).toBeLessThanOrEqual(10);
    expect(alphaAt(gradient, gradient.style.height)).toBe(0);
  });

  it.each(['dark', 'light'] as const)('is drawn in the screen\'s own ground, in the %s scheme', (scheme) => {
    const { colors } = drawn(47, scheme);
    for (const color of colors) expect(color.slice(0, 7)).toBe(themes[scheme].colors.background);
  });
});
