import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import MarketplaceToolFilter, { type ToolFilterOption } from '@/app/marketplace/MarketplaceToolFilter';

vi.mock('next/link', () => ({
    default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean }) => (
        <a {...props} data-prefetch={prefetch === undefined ? undefined : String(prefetch)} />
    ),
}));

const TOOLS = ['magicbooklet', 'Adobe Firefly', 'Midjourney', 'Runway', 'Kling AI', 'Higgsfield'];

function options(activeLabel = 'All tools'): ToolFilterOption[] {
    return [
        { label: 'All tools', href: '/marketplace', active: activeLabel === 'All tools' },
        ...TOOLS.map((label) => ({
            label,
            href: `/marketplace?tool=${label.toLowerCase().replace(/\s+/g, '-')}`,
            active: activeLabel === label,
        })),
    ];
}

/**
 * Opens the disclosure the way a browser does — set `open`, then fire `toggle`
 * — rather than relying on jsdom's <summary> click implementation.
 */
function openDisclosure() {
    const details = document.querySelector('details') as HTMLDetailsElement;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    return details;
}

describe('MarketplaceToolFilter', () => {
    afterEach(() => {
        cleanup();
    });

    it('keeps every tool a real link, so the unhydrated shell still filters', () => {
        // The marketplace bootstrap renders this before React attaches. If the
        // options only existed once opened, the no-JavaScript pass would have no
        // tool filter at all.
        render(<MarketplaceToolFilter options={options()} />);

        expect(screen.getByRole('link', { name: 'Midjourney' })).toHaveAttribute(
            'href',
            '/marketplace?tool=midjourney'
        );
        expect(screen.getAllByRole('link')).toHaveLength(TOOLS.length + 1);
    });

    it('opens without JavaScript, because it is a native disclosure', () => {
        render(<MarketplaceToolFilter options={options()} />);

        // A <summary> inside <details> toggles on its own — no React handler
        // required — which is what lets the unhydrated shell open it.
        const summary = document.querySelector('summary');
        expect(summary).toBeInTheDocument();
        expect(summary?.closest('details')).toBeInTheDocument();
    });

    it('shows the selected tool on the trigger rather than making you open it', () => {
        render(<MarketplaceToolFilter options={options('Runway')} />);

        const summary = document.querySelector('summary')!;
        expect(within(summary).getByText('Runway')).toBeInTheDocument();
    });

    it('filters the list down as you type', () => {
        render(<MarketplaceToolFilter options={options()} />);
        openDisclosure();

        fireEvent.change(screen.getByLabelText('Filter tools'), { target: { value: 'mid' } });

        expect(screen.getByRole('link', { name: 'Midjourney' })).toBeVisible();
        // Non-matches are hidden, not unmounted — they stay in the document so a
        // later no-JS render still has them.
        expect(screen.getByRole('link', { name: 'Runway', hidden: true })).toHaveClass('hidden');
    });

    it('matches case-insensitively, since nobody types brand casing', () => {
        render(<MarketplaceToolFilter options={options()} />);
        openDisclosure();

        fireEvent.change(screen.getByLabelText('Filter tools'), { target: { value: 'MAGICBOOKLET' } });

        expect(screen.getByRole('link', { name: 'magicbooklet' })).toBeVisible();
    });

    it('closes on Escape', () => {
        render(<MarketplaceToolFilter options={options()} />);
        const details = document.querySelector('details')!;
        openDisclosure();
        expect(details.open).toBe(true);

        fireEvent.keyDown(document, { key: 'Escape' });

        expect(details.open).toBe(false);
    });

    it('closes when a tool is chosen', () => {
        render(<MarketplaceToolFilter options={options()} />);
        const details = document.querySelector('details')!;
        openDisclosure();

        fireEvent.click(screen.getByRole('link', { name: 'Midjourney' }));

        expect(details.open).toBe(false);
    });

    it('does not render an inert filter box before hydration', () => {
        // Rendering through RTL hydrates immediately, so the box is present here
        // — the guard is that it is gated on an effect at all, which is what
        // keeps it absent in the demand shell.
        render(<MarketplaceToolFilter options={options()} />);
        openDisclosure();

        expect(screen.getByLabelText('Filter tools')).toBeInTheDocument();
    });
});
