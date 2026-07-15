import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import CreatorIdentity from '@/app/components/CreatorIdentity';

describe('CreatorIdentity', () => {
  it('renders a public creator link when a username exists', () => {
    render(
      <CreatorIdentity
        creator={{
          id: 'user-1',
          username: 'creator-name',
          name: 'Creator Name',
          avatar: null,
        }}
      />
    );

    expect(screen.getByRole('link', { name: /creator name/i })).toHaveAttribute('href', '/creators/creator-name');
  });

  it('renders plain text when the creator does not have a username', () => {
    render(
      <CreatorIdentity
        creator={{
          id: 'user-1',
          username: null,
          name: 'Anonymous',
          avatar: null,
        }}
      />
    );

    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('Anonymous')).toBeInTheDocument();
  });

  it('requests a bounded optimized rendition for a storage avatar', () => {
    render(
      <CreatorIdentity
        compact
        creator={{
          id: 'user-1',
          username: 'creator-name',
          name: 'Creator Name',
          avatar: '/creator.png',
        }}
      />
    );

    expect(screen.getByRole('img', { name: 'Creator Name avatar' })).toHaveAttribute('sizes', '32px');
  });

  it('falls back from the optimizer to the raw avatar and then initials', () => {
    render(
      <CreatorIdentity
        creator={{
          id: 'user-1',
          username: 'creator-name',
          name: 'Creator Name',
          avatar: '/creator.png',
        }}
      />
    );

    fireEvent.error(screen.getByRole('img', { name: 'Creator Name avatar' }));
    const rawAvatar = screen.getByRole('img', { name: 'Creator Name avatar' });
    expect(rawAvatar).toHaveAttribute('src', '/creator.png');

    fireEvent.error(rawAvatar);
    expect(screen.queryByRole('img', { name: 'Creator Name avatar' })).toBeNull();
    expect(screen.getByText('CN')).toBeInTheDocument();
  });
});
