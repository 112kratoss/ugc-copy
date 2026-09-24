import { beforeEach, describe, expect, it, vi } from 'vitest';

type Scheme = 'light' | 'dark';

const native = vi.hoisted(() => ({
  scheme: 'dark' as Scheme | null,
  appState: 'active' as string,
  appearanceListeners: new Set<() => void>(),
  appStateListeners: new Set<(state: string) => void>(),
  setColorScheme: vi.fn(),
}));

const storage = vi.hoisted(() => ({
  getItem: vi.fn(async (_key: string): Promise<string | null> => null),
  setItem: vi.fn(async (_key: string, _value: string) => undefined),
}));

vi.mock('react-native', () => ({
  Appearance: {
    getColorScheme: () => native.scheme,
    setColorScheme: native.setColorScheme,
    addChangeListener: (listener: () => void) => {
      native.appearanceListeners.add(listener);
      return { remove: () => native.appearanceListeners.delete(listener) };
    },
  },
  AppState: {
    get currentState() {
      return native.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.appStateListeners.add(listener);
      return { remove: () => native.appStateListeners.delete(listener) };
    },
  },
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: (key: string) => storage.getItem(key),
    setItem: (key: string, value: string) => storage.setItem(key, value),
  },
}));

// The store reads this once, at import: a binary built with the switch on.
vi.mock('expo-constants', () => ({ default: { expoConfig: { userInterfaceStyle: 'automatic' } } }));

import {
  getAppearancePreference,
  getResolvedColorScheme,
  hydrateAppearancePreference,
  isAppearanceChoiceAvailable,
  resetAppearanceForTests,
  resolveColorScheme,
  setAppearancePreference,
  subscribeColorScheme,
} from '../lib/appearance';

function phoneSwitchesTo(scheme: Scheme) {
  native.scheme = scheme;
  for (const listener of [...native.appearanceListeners]) listener();
}

function appBecomes(state: string) {
  native.appState = state;
  for (const listener of [...native.appStateListeners]) listener(state);
}

beforeEach(() => {
  native.scheme = 'dark';
  native.appState = 'active';
  native.setColorScheme.mockClear();
  storage.getItem.mockReset();
  storage.getItem.mockResolvedValue(null);
  storage.setItem.mockClear();
  resetAppearanceForTests();
});

describe('appearance availability', () => {
  it('keeps a binary still pinned dark on the dark scheme, whatever the phone says', () => {
    expect(isAppearanceChoiceAvailable({ userInterfaceStyle: 'dark' }, false)).toBe(false);
    expect(resolveColorScheme('light', 'light', false)).toBe('dark');
    expect(resolveColorScheme('system', 'light', false)).toBe('dark');
  });

  it('opens once the binary follows the system, and always in development', () => {
    expect(isAppearanceChoiceAvailable({ userInterfaceStyle: 'automatic' }, false)).toBe(true);
    expect(isAppearanceChoiceAvailable({ userInterfaceStyle: 'dark' }, true)).toBe(true);
    expect(isAppearanceChoiceAvailable(null, false)).toBe(false);
  });

  it('resolves System to the phone and an explicit choice to itself', () => {
    expect(resolveColorScheme('system', 'light', true)).toBe('light');
    expect(resolveColorScheme('system', 'dark', true)).toBe('dark');
    expect(resolveColorScheme('light', 'dark', true)).toBe('light');
    expect(resolveColorScheme('dark', 'light', true)).toBe('dark');
  });
});

describe('appearance store', () => {
  it('follows the phone by default, live', () => {
    native.scheme = 'light';
    resetAppearanceForTests();
    const listener = vi.fn();
    const unsubscribe = subscribeColorScheme(listener);

    expect(getAppearancePreference()).toBe('system');
    expect(getResolvedColorScheme()).toBe('light');

    phoneSwitchesTo('dark');
    expect(getResolvedColorScheme()).toBe('dark');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('applies a choice in the same call, tells the native layer, and remembers it', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeColorScheme(listener);

    setAppearancePreference('light');

    expect(getResolvedColorScheme()).toBe('light');
    expect(native.setColorScheme).toHaveBeenCalledWith('light');
    expect(storage.setItem).toHaveBeenCalledWith('appearance-preference-v1', 'light');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('holds an explicit choice when the phone changes', () => {
    const unsubscribe = subscribeColorScheme(() => undefined);
    setAppearancePreference('light');

    phoneSwitchesTo('dark');
    expect(getResolvedColorScheme()).toBe('light');
    unsubscribe();
  });

  it('hands the decision back to the phone on System, then takes the phone\'s answer', () => {
    const unsubscribe = subscribeColorScheme(() => undefined);
    setAppearancePreference('light');
    // While the override is on, the native layer reports the override.
    phoneSwitchesTo('light');

    setAppearancePreference('system');
    expect(native.setColorScheme).toHaveBeenLastCalledWith('unspecified');
    // Nothing moves until the phone reports its own scheme...
    expect(getResolvedColorScheme()).toBe('light');
    // ...which it does a moment later.
    phoneSwitchesTo('dark');
    expect(getResolvedColorScheme()).toBe('dark');
    unsubscribe();
  });

  it('notifies the Settings control when the choice changes but the scheme does not', () => {
    native.scheme = 'light';
    resetAppearanceForTests();
    const listener = vi.fn();
    const unsubscribe = subscribeColorScheme(listener);

    setAppearancePreference('light');
    expect(getResolvedColorScheme()).toBe('light');
    expect(getAppearancePreference()).toBe('light');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('ignores the trait flips iOS makes while snapshotting a backgrounded app, and re-reads on return', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeColorScheme(listener);

    appBecomes('background');
    phoneSwitchesTo('light');
    phoneSwitchesTo('dark');
    phoneSwitchesTo('light');
    expect(listener).not.toHaveBeenCalled();
    expect(getResolvedColorScheme()).toBe('dark');

    appBecomes('active');
    expect(getResolvedColorScheme()).toBe('light');
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('does nothing when the same choice is made twice', () => {
    setAppearancePreference('dark');
    native.setColorScheme.mockClear();
    storage.setItem.mockClear();

    setAppearancePreference('dark');
    expect(native.setColorScheme).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });
});

describe('appearance hydration', () => {
  it('restores a stored choice and applies it natively before the splash lifts', async () => {
    storage.getItem.mockResolvedValue('light');

    await hydrateAppearancePreference();

    expect(storage.getItem).toHaveBeenCalledWith('appearance-preference-v1');
    expect(getAppearancePreference()).toBe('light');
    expect(getResolvedColorScheme()).toBe('light');
    expect(native.setColorScheme).toHaveBeenCalledWith('light');
  });

  it('leaves a stored System alone: the native layer already follows the phone', async () => {
    storage.getItem.mockResolvedValue('system');

    await hydrateAppearancePreference();

    expect(getAppearancePreference()).toBe('system');
    expect(native.setColorScheme).not.toHaveBeenCalled();
  });

  it('keeps following the phone when the stored value is unreadable', async () => {
    storage.getItem.mockResolvedValue('sepia');
    await hydrateAppearancePreference();
    expect(getAppearancePreference()).toBe('system');

    resetAppearanceForTests();
    storage.getItem.mockRejectedValue(new Error('storage unavailable'));
    await hydrateAppearancePreference();
    expect(getAppearancePreference()).toBe('system');
    expect(native.setColorScheme).not.toHaveBeenCalled();
  });

  it('reads storage once however many times it is asked', async () => {
    await Promise.all([hydrateAppearancePreference(), hydrateAppearancePreference()]);
    expect(storage.getItem).toHaveBeenCalledTimes(1);
  });
});
