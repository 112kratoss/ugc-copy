import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

vi.mock('react-native', () => {
  class MockAnimatedValue {
    constructor(private value: number) {}

    setValue(nextValue: number) {
      this.value = nextValue;
    }

    interpolate() {
      return this.value;
    }
  }

  const View = ({ children, ...props }: MockProps) => React.createElement('view', props, children);

  return {
    Animated: {
      Value: MockAnimatedValue,
      View,
      timing: () => ({ start: vi.fn() }),
    },
    Pressable: ({ children, style, ...props }: MockProps) => React.createElement(
      'pressable',
      { ...props, style: resolvePressableStyle(style) },
      children
    ),
    Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
    View,
  };
});

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('image', props),
}));

vi.mock('lucide-react-native', () => ({
  Sparkles: (props: MockProps) => React.createElement('sparkles-icon', props),
}));

vi.mock('@/lib/motion', () => ({
  useReducedMotion: () => true,
}));

vi.mock('@/components/ui', () => ({
  BrandLockup: (props: MockProps) =>
    React.createElement('view', { accessibilityRole: 'header', accessibilityLabel: 'Magicbooklet', ...props }),
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  PrimaryButton: ({ label, onPress, ...props }: MockProps) => React.createElement(
    'pressable',
    {
      ...props,
      accessibilityRole: 'button',
      accessibilityLabel: label,
      onPress,
    },
    React.createElement('text', null, label as React.ReactNode)
  ),
}));

import { OnboardingWelcome } from '../components/onboarding-welcome';

function collectText(node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | string | null): string {
  if (node === null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join('');
  return (node.children ?? []).map((child) => collectText(child)).join('');
}

describe('OnboardingWelcome', () => {
  it('renders the booklet welcome message and accessible actions', () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(
        <OnboardingWelcome
          availableHeight={844}
          availableWidth={358}
          onGetStarted={vi.fn()}
          onSignIn={vi.fn()}
          onSkip={vi.fn()}
        />
      );
    });

    const text = collectText(tree!.toJSON());
    expect(text).not.toContain('Welcome to Magicbooklet');
    expect(text).toContain('Create. Share. Earn.');
    expect(text).toContain('Turn ideas into polished images, video, and motion—then share what you create.');
    // The headline is the `pageTitle` token now, not a hand-set 32pt/900 in
    // the system font — so it carries the display face the rest of the app's
    // titles use, and cannot re-weight it (hig-type-and-contrast).
    expect(tree!.root.findAllByProps({ variant: 'pageTitle', heading: true })).not.toHaveLength(0);
    expect(tree!.root.findByProps({ accessibilityLabel: 'Get started' }).props.accessibilityRole).toBe('button');
    expect(
      tree!.root.findByProps({ accessibilityLabel: 'Already have an account? Sign in' }).props.accessibilityRole
    ).toBe('button');
  });

  it('calls the supplied callbacks from Get started, Sign in and Skip', () => {
    const onGetStarted = vi.fn();
    const onSignIn = vi.fn();
    const onSkip = vi.fn();
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <OnboardingWelcome
          availableHeight={844}
          availableWidth={358}
          onGetStarted={onGetStarted}
          onSignIn={onSignIn}
        onSkip={onSkip}
        />
      );
    });

    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Get started' }).props.onPress();
      tree!.root.findByProps({ accessibilityLabel: 'Already have an account? Sign in' }).props.onPress();
      // Onboarding asks for an optional flow; the first screen had no way past it.
      tree!.root.findByProps({ accessibilityLabel: 'Skip onboarding and explore as guest' }).props.onPress();
    });

    expect(onGetStarted).toHaveBeenCalledTimes(1);
    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
