import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MatureReveal } from '@/lib/nsfw-reveal-policy';

type MockProps = { children?: React.ReactNode; label?: string } & Record<string, unknown>;

const openURL = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  Linking: { openURL },
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

const GUIDANCE = 'Mature content is off by default. Adults can enable it on the Magicbooklet website, then return here to show it.';

function render(element: React.ReactElement) {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(element);
  });
  return tree;
}

function texts(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'text').map((node) => node.props.children);
}

function buttons(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'button').map((node) => node.props.children);
}

function pressables(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'pressable');
}

beforeEach(() => {
  openURL.mockClear();
});

describe('MatureCover tile', () => {
  it('makes the whole tile the Show control once the preference allows it', () => {
    const onShow = vi.fn();
    const tree = render(<MatureCover variant="tile" reveal="show" onShow={onShow} />);
    const [show] = pressables(tree);

    expect(show?.props.accessibilityRole).toBe('button');
    expect(show?.props.accessibilityLabel).toBe('Show mature content');
    expect(texts(tree)).toEqual(['Show']);
    renderer.act(() => { show!.props.onPress(); });
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it('only covers while the preference is off or unread, on Android, or with no Show of its own', () => {
    const tiles: React.ReactElement[] = [
      ...(['website', 'pending', 'never'] as MatureReveal[]).map((reveal) => <MatureCover variant="tile" reveal={reveal} onShow={vi.fn()} />),
      <MatureCover variant="tile" reveal="show" />,
      <MatureCover variant="tile" />,
    ];
    for (const tile of tiles) {
      const tree = render(tile);
      expect(pressables(tree)).toHaveLength(0);
      expect(texts(tree)).toEqual([]);
      expect(tree.root.findAll((node) => String(node.type) === 'icon' && node.props.name === 'EyeOff')).toHaveLength(1);
    }
  });
});

describe('MatureCover card', () => {
  it('offers Show once the preference is on', () => {
    const onShow = vi.fn();
    const tree = render(<MatureCover variant="card" reveal="show" onShow={onShow} websiteUrl="https://magicbooklet.test/showcase/post-1" />);

    expect(texts(tree)).toEqual([
      'Mature content',
      'The creator marked this post NSFW. It stays covered until you choose to see it.',
    ]);
    expect(buttons(tree)).toEqual(['Show']);
    renderer.act(() => { tree.root.find((node) => String(node.type) === 'button').props.onPress(); });
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(openURL).not.toHaveBeenCalled();
  });

  it('says where to turn it on while the preference is off, and shows nothing', () => {
    const onShow = vi.fn();
    const tree = render(<MatureCover variant="card" reveal="website" onShow={onShow} websiteUrl="https://magicbooklet.test/showcase/post-1" />);

    expect(texts(tree)).toEqual(['Mature content', 'The creator marked this post NSFW.', GUIDANCE]);
    expect(buttons(tree)).toEqual(['Manage on website']);
    renderer.act(() => { tree.root.find((node) => String(node.type) === 'button').props.onPress(); });
    expect(openURL).toHaveBeenCalledWith('https://magicbooklet.test/showcase/post-1');
    expect(onShow).not.toHaveBeenCalled();
  });

  it('keeps the guidance without a button when there is no page to send the viewer to', () => {
    const tree = render(<MatureCover variant="card" reveal="website" onShow={vi.fn()} />);

    expect(texts(tree)).toContain(GUIDANCE);
    expect(buttons(tree)).toEqual([]);
  });

  it('offers nothing while the preference is still being read', () => {
    const tree = render(<MatureCover variant="card" reveal="pending" onShow={vi.fn()} websiteUrl="https://magicbooklet.test/showcase/post-1" />);

    expect(texts(tree)).toEqual(['Mature content', 'The creator marked this post NSFW.']);
    expect(buttons(tree)).toEqual([]);
  });

  it('offers nothing on Android, which shows no mature media', () => {
    const tree = render(<MatureCover variant="card" reveal="never" onShow={vi.fn()} websiteUrl="https://magicbooklet.test/showcase/post-1" />);

    expect(texts(tree)).toEqual(['Mature content', 'The creator marked this post NSFW. Mature posts stay covered in this app.']);
    expect(buttons(tree)).toEqual([]);
  });
});
