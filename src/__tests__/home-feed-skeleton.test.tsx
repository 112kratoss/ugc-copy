import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { feedChipClassName, HomeFeedSkeleton } from '@/components/HomeFeedSkeleton';
import { FEED_CHIPS } from '@/lib/post-feed-chips';

// Home's feed streams in behind this skeleton. It had no chip row, so the first post landed a row
// lower than the first grey card it replaced (owner's screen recording, 2026-11-14). The row is
// drawn here as the feed draws it, from the same classes, so the swap moves nothing above the
// first post.

describe('HomeFeedSkeleton', () => {
  it('holds the chip row the feed draws, in its order, For you chosen', () => {
    render(<HomeFeedSkeleton />);

    const row = screen.getByTestId('home-feed-skeleton-chips');
    expect(row).toHaveAttribute('aria-hidden', 'true');
    const chips = within(row).getAllByText(/./);
    expect(chips.map((chip) => chip.textContent)).toEqual(FEED_CHIPS.map((chip) => chip.label));
    expect(chips[0].className).toContain(feedChipClassName(true));
    expect(chips[1].className).toContain(feedChipClassName(false));
  });

  it('chooses the lane the address names, as the signed-in Home opens on it', () => {
    render(<HomeFeedSkeleton activeChipId="unlocks" />);

    const chosen = within(screen.getByTestId('home-feed-skeleton-chips')).getByText('Recipes');
    expect(chosen.className).toContain(feedChipClassName(true));
  });

  it('spaces the row from the cards as the feed does', () => {
    render(<HomeFeedSkeleton />);

    const skeleton = screen.getByLabelText('Loading feed');
    expect(skeleton.className).toBe('flex w-full flex-col gap-5');
    expect(skeleton.firstElementChild).toBe(screen.getByTestId('home-feed-skeleton-chips'));
  });
});
