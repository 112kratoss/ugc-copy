import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { GenerationListItem } from '@/lib/types';

/**
 * The card feed draws a creation's first file, which is all the library sends;
 * a run that made several says how many on its media (audit 01-2). The card's
 * chrome and media are doubles: under test are the badge and the label the
 * card's open control reads out.
 */

type Props = { children?: React.ReactNode } & Record<string, unknown>;

vi.mock('react-native', () => ({
  Text: ({ children, ...props }: Props) => React.createElement('text', props, children),
  View: ({ children, ...props }: Props) => React.createElement('view', props, children),
}));
vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: Props) => React.createElement(`${name}-icon`, props);
  return {
    ArchiveRestore: icon('archive-restore'),
    FileText: icon('file'),
    Globe: icon('globe'),
    ImageOff: icon('image-off'),
    Images: icon('images'),
    LockKeyhole: icon('lock'),
    MessageCircle: icon('message'),
    Repeat2: icon('repeat'),
    Wand2: icon('wand'),
  };
});
vi.mock('@/components/audio-creation-player', () => ({ AudioCreationPlayer: () => null }));
vi.mock('@/components/feed-card-shell', () => ({
  FeedCardAction: () => null,
  FeedCardShell: ({ media, openAccessibilityLabel }: Props) => (
    React.createElement('card-shell', { openAccessibilityLabel }, media as React.ReactNode)
  ),
}));
vi.mock('@/components/viewer-actions-menu', () => ({ ViewerActionsMenu: () => null }));
vi.mock('@/components/media-zoom', () => ({
  MediaZoomSourceView: ({ children }: Props) => React.createElement('zoom-source', null, children),
  useMediaZoomSource: () => ({ appleZoomId: null, capture: vi.fn(), prepare: vi.fn() }),
}));
vi.mock('@/components/post-text-block', () => ({ PostReadMore: () => null, PostTextBlock: () => null }));
vi.mock('@/components/showcase-media-preview', () => ({
  ShowcaseMediaPreview: (props: Props) => React.createElement('media-preview', props),
}));
vi.mock('@/lib/platform-glyphs', () => ({ ShareGlyph: () => null }));

import { ProfileFeedCardView } from '@/components/profile-feed-card';
import { buildImmersiveGenerationItems } from '@/lib/immersive-preview-view-model';
import { toProfileFeedCard } from '@/lib/profile-feed-card-view-model';

function creation(overrides: Partial<GenerationListItem>): GenerationListItem {
  return {
    id: 'takes',
    output_url: 'https://cdn.example.com/takes-0.jpg',
    status: 'succeeded',
    created_at: '2026-10-14T10:00:00.000Z',
    model: 'nano-banana-2',
    category: 'image',
    title: 'Four takes',
    prompt: 'A lighthouse at dusk',
    ...overrides,
  };
}

function render(item: GenerationListItem) {
  const [preview] = buildImmersiveGenerationItems('profile-creations', [item], { creatorLabel: '@luna' });
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(
      <ProfileFeedCardView
        card={toProfileFeedCard(preview)}
        contentWidth={390}
        showActiveVideo={false}
        screenFocused
        pendingAction={null}
        onOpen={vi.fn()}
        onReadMore={vi.fn()}
        onActionsOpen={vi.fn()}
        onAction={vi.fn()}
      />,
    );
  });
  return tree;
}

function outputsBadges(tree: renderer.ReactTestRenderer) {
  return tree.root.findAll((node) => String(node.type) === 'view' && node.props.testID === 'profile-feed-outputs-badge');
}

describe('a creation that made several files, on the card feed', () => {
  it('says how many on its media, and in the label the card reads out', () => {
    const tree = render(creation({ output_count: 4 }));

    const badges = outputsBadges(tree);
    expect(badges).toHaveLength(1);
    expect(badges[0].findAllByType('text' as never).map((node) => node.props.children)).toEqual(['4 outputs']);
    // Over the media the card opens, not beside it.
    expect(tree.root.findByType('zoom-source' as never).findAll((node) => node === badges[0])).toHaveLength(1);
    expect(tree.root.findByType('card-shell' as never).props.openAccessibilityLabel).toBe('Open Four takes, 4 outputs');
  });

  it('draws no badge for a run of one', () => {
    const tree = render(creation({ output_count: 1 }));

    expect(outputsBadges(tree)).toHaveLength(0);
    expect(tree.root.findByType('card-shell' as never).props.openAccessibilityLabel).toBe('Open Four takes');
  });
});
