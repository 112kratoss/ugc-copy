import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { CreatorToolCard } from '@/components/CreatorStudio';
import { CREATOR_TOOLS } from '@/lib/creator-tools';

// /create's tool cards (web sweep, 2026-11-17): each card's launch link held an <article>, and
// Chrome takes no link's name from inside one, so a screen reader met four unnamed links. The card
// is the article now, and the link is named by the tool's title and its call to action.
describe('CreatorToolCard', () => {
  it("names each tool's launch link by its title and its call to action, with nothing in it a link takes no name from", () => {
    for (const tool of CREATOR_TOOLS) {
      const { container, unmount } = render(
        <CreatorToolCard tool={tool} starter={{ title: 'Launch a premium product visual', href: `${tool.href}?prompt=x` }} />,
      );
      const card = screen.getByRole('article');
      const launch = within(card).getByRole('link', { name: `${tool.label} ${tool.launchLabel}` });
      expect(launch).toHaveAttribute('href', tool.href);
      expect(launch.querySelector('article, section, table')).toBeNull();
      // The ready-made setup stays a link of its own, beside the launch link, not inside it.
      expect(within(card).getByRole('link', { name: /Launch a premium product visual/ })).not.toBe(launch);
      expect(container.querySelectorAll('[id]').length).toBe(2);
      unmount();
    }
  });
});
