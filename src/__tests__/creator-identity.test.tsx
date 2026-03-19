import { render, screen } from '@testing-library/react';
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
});
