(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  setItem: vi.fn(async (key: string, value: string) => {
    storage.values.set(key, value);
  }),
}));

const select = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Pressable: ({ children, style: _style, ...props }: MockProps & { style?: unknown }) =>
    React.createElement('pressable', props, typeof children === 'function' ? (children as (s: { pressed: boolean }) => React.ReactNode)({ pressed: false }) : children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => storage.values.get(key) ?? null,
    setItem: (key: string, value: string) => storage.setItem(key, value),
  },
}));

vi.mock('@/lib/haptics', () => ({ haptic: { select } }));

import { AutoplaySetting } from '../components/autoplay-setting';
import { resetAutoplayPreferenceForTests } from '../lib/autoplay-preference';

async function renderSetting() {
  let tree!: renderer.ReactTestRenderer;
  await renderer.act(async () => {
    tree = renderer.create(<AutoplaySetting />);
    // The stored choice is read when the row first subscribes.
    for (let tick = 0; tick < 5; tick += 1) await Promise.resolve();
  });
  return tree;
}

function choices(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'pressable' && node.props.accessibilityRole === 'radio');
}

function checked(tree: renderer.ReactTestRenderer) {
  return choices(tree).filter((node) => node.props.accessibilityState.checked).map((node) => node.props.accessibilityLabel);
}

function body(tree: renderer.ReactTestRenderer) {
  return tree.root.find((node) => String(node.type) === 'text' && node.props.variant === 'bodySm').props.children;
}

beforeEach(() => {
  storage.values.clear();
  storage.setItem.mockClear();
  select.mockClear();
  resetAutoplayPreferenceForTests();
});

describe('Autoplay previews (Settings → Playback)', () => {
  it('offers Wi-Fi only, Always and Never as one radio group, Wi-Fi only by default', async () => {
    const tree = await renderSetting();
    const group = tree.root.find((node) => String(node.type) === 'view' && node.props.accessibilityRole === 'radiogroup');
    expect(group.props.accessibilityLabel).toBe('Autoplay previews');
    expect(choices(tree).map((node) => node.props.accessibilityLabel)).toEqual(['Wi-Fi only', 'Always', 'Never']);
    expect(checked(tree)).toEqual(['Wi-Fi only']);
    expect(tree.root.find((node) => String(node.type) === 'text' && node.props.variant === 'cardTitle').props.children)
      .toBe('Autoplay previews');
    expect(body(tree)).toBe('On mobile data, only the video you stop on plays.');
    renderer.act(() => tree.unmount());
  });

  it('says what each choice does', async () => {
    const tree = await renderSetting();
    const [, always, never] = choices(tree);

    await renderer.act(async () => { (always.props.onPress as () => void)(); });
    expect(body(tree)).toBe('Videos play and load ahead on any network.');
    await renderer.act(async () => { (never.props.onPress as () => void)(); });
    expect(body(tree)).toBe('Videos show a still frame until you open them.');
    renderer.act(() => tree.unmount());
  });

  it('switches on a tap, stores the choice, and keeps it across a remount', async () => {
    const tree = await renderSetting();
    const never = choices(tree)[2];
    await renderer.act(async () => { (never.props.onPress as () => void)(); });

    expect(checked(tree)).toEqual(['Never']);
    expect(select).toHaveBeenCalledTimes(1);
    expect(storage.setItem).toHaveBeenCalledWith('autoplay-preference-v1', 'never');
    renderer.act(() => tree.unmount());

    // A fresh launch: nothing in memory, the choice only on disk.
    resetAutoplayPreferenceForTests();
    const again = await renderSetting();
    expect(checked(again)).toEqual(['Never']);
    renderer.act(() => again.unmount());
  });

  it('does nothing for the choice already made', async () => {
    const tree = await renderSetting();
    const wifi = choices(tree)[0];
    await renderer.act(async () => { (wifi.props.onPress as () => void)(); });

    expect(select).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
    renderer.act(() => tree.unmount());
  });
});
