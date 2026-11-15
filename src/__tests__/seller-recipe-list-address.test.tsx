import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import SellerRecipeList from '@/app/marketplace/sell/SellerRecipeList';
import type { SellerRecipe } from '@/app/marketplace/sell/seller-recipes';

// A filter or order left by Back from a recipe or a refresh came back as All and Most unlocked
// (owner's report, 2026-11-15): Recipe sales keeps both in its address.

vi.mock('next/link', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  default: ({ children, href, prefetch, ...props }: { children: React.ReactNode; href: string; prefetch?: boolean }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

vi.mock('@/app/marketplace/sell/SellerRecipeCover', () => ({
  default: () => null,
}));

const recipe = (id: string, title: string, overrides: Partial<SellerRecipe> = {}): SellerRecipe => ({
  id,
  postId: `post-${id}`,
  title,
  summary: '',
  previewText: '',
  accessMode: 'paid',
  status: 'published',
  priceUsdCents: 900,
  salesCount: 0,
  freeUnlockCount: 0,
  earningsUsdCents: 0,
  resourceKinds: ['prompt'],
  createdAt: '2026-10-01T00:00:00.000Z',
  quality: { eligible: true, issues: [] },
  post: { id: `post-${id}`, title, visibility: 'public', archivedAt: null, reviewStatus: 'visible' },
  ...overrides,
});

const recipes = [
  recipe('live', 'Live recipe', { salesCount: 5 }),
  recipe('draft', 'Draft recipe', { status: 'draft', createdAt: '2026-10-05T00:00:00.000Z' }),
];

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

const chip = (name: string) => within(screen.getByRole('group', { name: 'Show recipes' })).getByRole('button', { name: new RegExp(`^${name}`) });

describe('Recipe sales in the address', () => {
  it('opens on the filter and the order the address names', () => {
    window.history.replaceState(null, '', '/marketplace/sell?recipes=not-live&sort=newest');
    render(<SellerRecipeList recipes={recipes} />);

    expect(chip('Not live')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('combobox', { name: 'Sort recipes' })).toHaveValue('newest');
    expect(screen.getByText('Draft recipe')).toBeInTheDocument();
    expect(screen.queryByText('Live recipe')).not.toBeInTheDocument();
  });

  it('writes the filter and the order chosen into the address, and the defaults out of it', () => {
    window.history.replaceState(null, '', '/marketplace/sell');
    render(<SellerRecipeList recipes={recipes} />);

    fireEvent.click(chip('Live'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort recipes' }), { target: { value: 'saves' } });
    expect(window.location.search).toBe('?recipes=live&sort=saves');

    fireEvent.click(chip('All'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Sort recipes' }), { target: { value: 'unlocks' } });
    expect(window.location.search).toBe('');
  });
});
