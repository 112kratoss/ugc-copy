import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode; label?: string } & Record<string, unknown>;

const platform = vi.hoisted(() => ({ OS: 'ios' }));

vi.mock('react-native', () => ({
  Platform: platform,
  Pressable: ({ children, style: _style, ...props }: MockProps) => React.createElement('pressable', props, children),
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => ({
  EyeOff: (props: MockProps) => React.createElement('icon', { name: 'EyeOff', ...props }),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  SecondaryButton: ({ label, ...props }: MockProps) => React.createElement('button', props, label),
}));

import { MatureCover } from '../components/mature-cover';

function render(variant: 'tile' | 'card', onShow = vi.fn()) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(<MatureCover variant={variant} onShow={onShow} />);
  });
  return tree;
}

function texts(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);
}

beforeEach(() => {
  platform.OS = 'ios';
});

describe('MatureCover', () => {
  it('makes the whole tile the Show control on iOS', () => {
    const onShow = vi.fn();
    const tree = render('tile', onShow);
    const show = tree.root.find((node) => String(node.type) === 'pressable');

    expect(show.props.accessibilityRole).toBe('button');
    expect(show.props.accessibilityLabel).toBe('Show mature content');
    expect(texts(tree)).toEqual(['Show']);
    renderer.act(() => { show.props.onPress(); });
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it('names what the card covers and shows it on iOS', () => {
    const onShow = vi.fn();
    const tree = render('card', onShow);

    expect(texts(tree)).toEqual([
      'Mature content',
      'The creator marked this post NSFW. It stays covered until you choose to see it.',
    ]);
    const show = tree.root.find((node) => String(node.type) === 'button' && node.props.children === 'Show');
    renderer.act(() => { show.props.onPress(); });
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it('offers nothing to press on Android, which shows no mature media', () => {
    platform.OS = 'android';

    const tile = render('tile');
    expect(tile.root.findAll((node) => String(node.type) === 'pressable')).toHaveLength(0);
    expect(tile.root.findAll((node) => String(node.type) === 'icon' && node.props.name === 'EyeOff')).toHaveLength(1);

    const card = render('card');
    expect(card.root.findAll((node) => String(node.type) === 'button')).toHaveLength(0);
    expect(texts(card)).toContain('The creator marked this post NSFW. Mature posts stay covered in this app.');
  });
});
