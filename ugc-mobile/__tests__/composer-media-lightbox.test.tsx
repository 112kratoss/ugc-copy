import React from 'react';
import renderer from 'react-test-renderer';
import { expect, it, vi } from 'vitest';

vi.mock('@/components/media-lightbox', () => ({
  MediaLightbox: (props: object) => React.createElement('lightbox', props),
}));

import { ComposerMediaLightbox } from '../components/composer-media-lightbox';

it('plays video media instead of its poster while preserving image previews', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(<ComposerMediaLightbox
      items={[
        { id: 'video', uri: 'https://media.test/movie.mp4', previewUrl: 'https://media.test/poster.jpg', mediaKind: 'video', type: 'video/mp4', name: 'Movie' },
        { id: 'image', uri: 'https://media.test/original.png', previewUrl: 'https://media.test/preview.jpg', mediaKind: 'image', type: 'image/png', name: 'Image' },
        { id: 'local', uri: 'file:///picked.mp4', mediaKind: 'video', type: 'video/mp4', name: 'Local' },
      ]}
      activeIndex={0}
      onClose={vi.fn()}
      onNavigate={vi.fn()}
    />);
  });
  try {
    expect(tree!.root.findByType('lightbox' as never).props.items).toEqual([
      { id: 'composer:video', url: 'https://media.test/movie.mp4', mediaKind: 'video', label: 'Cover', caption: 'Movie' },
      { id: 'composer:image', url: 'https://media.test/preview.jpg', mediaKind: 'image', label: 'Media 2', caption: 'Image' },
      { id: 'composer:local', url: 'file:///picked.mp4', mediaKind: 'video', label: 'Media 3', caption: 'Local' },
    ]);
  } finally {
    renderer.act(() => tree?.unmount());
  }
});

// The card's second line said "Image" where the picker named a picture after its media id, and the
// lightbox it opens still captioned it "1 of 3 · 1000333161.jpg" (review of the redundant-UI leftovers).
it('captions a slot by its file name only where the name says something', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  renderer.act(() => {
    tree = renderer.create(<ComposerMediaLightbox
      items={[
        { id: 'media-1', uri: 'file:///1000333161.jpg', mediaKind: 'image', type: 'image/jpeg', name: '1000333161.jpg' },
        { id: 'media-2', uri: 'file:///still.png', mediaKind: 'image', type: 'image/png', name: 'still.png' },
        // An edited post's items with no original name are named by their ids (app/post/new.tsx).
        { id: 'post-1:cover', uri: 'https://media.test/cover.png', mediaKind: 'image', type: 'image/png', name: 'post-1:cover', existingId: 'post-1:cover' },
        { id: 'row-1', uri: 'https://media.test/clip.mp4', mediaKind: 'video', type: 'video/mp4', name: 'row-1', existingId: 'row-1' },
      ]}
      activeIndex={0}
      onClose={vi.fn()}
      onNavigate={vi.fn()}
    />);
  });
  try {
    expect(tree!.root.findByType('lightbox' as never).props.items.map((item: { caption: string | null }) => item.caption))
      .toEqual([null, 'still.png', null, null]);
  } finally {
    renderer.act(() => tree?.unmount());
  }
});
