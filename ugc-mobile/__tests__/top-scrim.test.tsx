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
import { appTheme } from '../lib/theme';
import { viewerTopScrim } from '../lib/viewer-chrome';

describe('the reel\'s top shade', () => {
  // React Native's gradient takes its stops as a CSS string, with positions in
  // percent of the shade's height; viewerTopScrim places them in points.
  it.each([47, 59, 62])('draws viewerTopScrim\'s stops where it places them, at inset %i', (inset) => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(<TopScrim topInset={inset} over="media" />);
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
      expect(stop.color.slice(0, 7)).toBe(appTheme.colors.background);
      expect(Number.parseInt(stop.color.slice(7), 16) / 255).toBeCloseTo(stops[index].alpha, 2);
      expect(stop.offset).toBeCloseTo(stops[index].offset, 2);
    });
  });
});
