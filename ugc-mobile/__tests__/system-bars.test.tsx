(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('expo', () => ({ requireOptionalNativeModule: () => null }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

import type { ColorScheme } from '../lib/theme';
import {
  navigationBarButtonStyle,
  resetNavigationBarSurfacesForTests,
  useNavigationBarSurface,
} from '../lib/system-bars';

const setButtonStyle = vi.fn();

function Surface({ surface }: { surface: ColorScheme | null }) {
  useNavigationBarSurface(surface, setButtonStyle);
  return null;
}

function App({ scheme, reel }: { scheme: ColorScheme; reel: 'focused' | 'blurred' | 'closed' }) {
  return (
    <>
      <Surface surface={scheme} />
      {reel === 'closed' ? null : <Surface surface={reel === 'focused' ? 'dark' : null} />}
    </>
  );
}

function render(props: { scheme: ColorScheme; reel: 'focused' | 'blurred' | 'closed' }) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(<App {...props} />);
  });
  return {
    update: (next: typeof props) => renderer.act(() => tree.update(<App {...next} />)),
    unmount: () => renderer.act(() => tree.unmount()),
  };
}

beforeEach(() => {
  resetNavigationBarSurfacesForTests();
  setButtonStyle.mockClear();
});

describe('Android navigation bar surfaces', () => {
  it('puts light icons on a dark surface and dark icons on a light one', () => {
    expect(navigationBarButtonStyle('dark')).toBe('light');
    expect(navigationBarButtonStyle('light')).toBe('dark');
  });

  it('follows the app scheme, live', () => {
    const app = render({ scheme: 'light', reel: 'closed' });
    expect(setButtonStyle).toHaveBeenLastCalledWith('dark');

    app.update({ scheme: 'dark', reel: 'closed' });
    expect(setButtonStyle).toHaveBeenLastCalledWith('light');
    app.unmount();
  });

  it('keeps the reel dark while it is in front, even when the phone switches underneath', () => {
    const app = render({ scheme: 'light', reel: 'focused' });
    expect(setButtonStyle).toHaveBeenLastCalledWith('light');

    setButtonStyle.mockClear();
    app.update({ scheme: 'dark', reel: 'focused' });
    app.update({ scheme: 'light', reel: 'focused' });
    expect(setButtonStyle).not.toHaveBeenCalled();

    app.update({ scheme: 'light', reel: 'closed' });
    expect(setButtonStyle).toHaveBeenLastCalledWith('dark');
    app.unmount();
  });

  it('hands back to the app scheme when a screen covers the reel', () => {
    const app = render({ scheme: 'light', reel: 'focused' });
    app.update({ scheme: 'light', reel: 'blurred' });
    expect(setButtonStyle).toHaveBeenLastCalledWith('dark');
    app.unmount();
  });

  it('does not resend a style the bar already has', () => {
    const app = render({ scheme: 'dark', reel: 'closed' });
    app.update({ scheme: 'dark', reel: 'focused' });
    expect(setButtonStyle).toHaveBeenCalledTimes(1);
    app.unmount();
  });
});
