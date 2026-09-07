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
