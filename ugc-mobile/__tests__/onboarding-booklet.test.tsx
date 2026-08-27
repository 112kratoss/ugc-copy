import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; style?: unknown } & Record<string, unknown>;

function resolvePressableStyle(style: unknown) {
  return typeof style === 'function'
    ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
    : style;
}

vi.mock('react-native', () => ({
  Pressable: ({ children, style, ...props }: MockProps) => React.createElement(
    'pressable',
    { ...props, style: resolvePressableStyle(style) },
    children
  ),
  Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('expo-image', () => ({
  Image: (props: MockProps) => React.createElement('image', props),
}));

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children, ...props }: MockProps) => React.createElement(
    'linear-gradient',
    props,
    children
  ),
}));

vi.mock('lucide-react-native', () => ({
  Check: (props: MockProps) => React.createElement('check-icon', props),
  Sparkles: (props: MockProps) => React.createElement('sparkles-icon', props),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  BrandLockup: (props: MockProps) =>
    React.createElement('view', { accessibilityRole: 'header', accessibilityLabel: 'Magicbooklet', ...props }),
  Kicker: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
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

import {
  OnboardingBookletGoal,
  type BookletGoal,
} from '../components/onboarding-booklet';
import { OnboardingHeader } from '../components/onboarding-header';

function collectText(node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | string | null): string {
  if (node === null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join('');
  return (node.children ?? []).map((child) => collectText(child)).join('');
}

const GoalIcon = (props: MockProps) => React.createElement('goal-icon', props);

const goals: BookletGoal[] = [
  {
    id: 'image',
    label: 'Image',
    body: 'Campaign visuals and product shots',
    color: '#73bff2',
    image: 1,
    imageLabel: 'A cinematic mountain landscape',
    icon: GoalIcon,
  },
  {
    id: 'video',
    label: 'Video',
    body: 'Ads, reels, and story-driven clips',
    color: '#ff8e72',
    image: 2,
    imageLabel: 'A cinematic creator portrait',
    icon: GoalIcon,
  },
  {
    id: 'motion',
    label: 'Motion',
    body: 'Animate a character or reference video',
    color: '#b7a0f5',
    image: 3,
    imageLabel: 'An energetic purple motion scene',
    icon: GoalIcon,
  },
];

describe('Onboarding booklet components', () => {
  it('gives Skip explicit guest semantics and invokes the callback', () => {
    const onSkip = vi.fn();
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(<OnboardingHeader onSkip={onSkip} />);
    });

    expect(tree!.root.findByProps({ accessibilityLabel: 'Magicbooklet' }).props.accessibilityRole).toBe('header');
    const skip = tree!.root.findByProps({ accessibilityLabel: 'Skip onboarding and explore as guest' });
    expect(skip.props.accessibilityRole).toBe('button');

    renderer.act(() => skip.props.onPress());
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('exposes goal selection state and connects every goal action', () => {
    const onSelect = vi.fn();
    const onContinue = vi.fn();
    const onBack = vi.fn();
    let tree: renderer.ReactTestRenderer | undefined;

    renderer.act(() => {
      tree = renderer.create(
        <OnboardingBookletGoal
          goals={goals}
          selectedGoal="video"
          availableWidth={358}
          onSelect={onSelect}
          onContinue={onContinue}
          onBack={onBack}
        />
      );
    });

    const text = collectText(tree!.toJSON());
    expect(text).toContain('Make your first page');
    expect(text).toContain('What will you create first?');
    expect(text).toContain('Pick a starting point. You can use every format whenever you like.');
    expect(text).toContain('Ads, reels, and story-driven clips');

    const artwork = tree!.root.findByProps({ accessibilityLabel: 'A cinematic creator portrait' });
    expect(artwork.props.cachePolicy).toBe('memory');
    expect(artwork.props.transition).toBeUndefined();

    const imageChoice = tree!.root.findByProps({ accessibilityLabel: 'Image. Campaign visuals and product shots' });
    const videoChoice = tree!.root.findByProps({ accessibilityLabel: 'Video. Ads, reels, and story-driven clips' });
    const motionChoice = tree!.root.findByProps({ accessibilityLabel: 'Motion. Animate a character or reference video' });
    expect(imageChoice.props.accessibilityRole).toBe('radio');
    expect(imageChoice.props.accessibilityState).toEqual({ checked: false });
    expect(videoChoice.props.accessibilityState).toEqual({ checked: true });
    expect(motionChoice.props.accessibilityState).toEqual({ checked: false });

    const continueButton = tree!.root.findByProps({ accessibilityLabel: 'Continue to account setup' });
    const backButton = tree!.root.findByProps({ accessibilityLabel: 'Back' });
    expect(continueButton.props.accessibilityHint).toBe('Continue with video as your first format');
    // The escape lives in the header (`OnboardingSkip`), once. This footer used
    // to carry a second control calling the same function under another name.
    expect(tree!.root.findAllByProps({ accessibilityLabel: 'Explore as guest' })).toHaveLength(0);

    renderer.act(() => {
      motionChoice.props.onPress();
      continueButton.props.onPress();
      backButton.props.onPress();
    });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('motion');
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);

    renderer.act(() => {
      tree!.update(
        <OnboardingBookletGoal
          goals={goals}
          selectedGoal="motion"
          availableWidth={358}
          onSelect={onSelect}
          onContinue={onContinue}
          onBack={onBack}
        />
      );
    });

    const updatedArtwork = tree!.root.findByProps({ accessibilityLabel: 'An energetic purple motion scene' });
    expect(updatedArtwork).toBe(artwork);
    expect(updatedArtwork.props.source).toBe(3);
  });
});
