import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import Contact from '@/app/contact/page';

describe('the contact page', () => {
    // A signed-in visitor's only help entry is "Help & feedback", which opens
    // this page; child safety and account deletion were linked nowhere they could see.
    it('links child safety and account deletion beside the policies', () => {
        render(<Contact />);

        const quickLinks = screen.getByRole('heading', { name: 'Quick Links' }).parentElement!;
        expect(within(quickLinks).getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
            '/pricing',
            '/cancellation',
            '/terms',
            '/privacy',
            '/child-safety',
            '/delete-account',
        ]);
        expect(within(quickLinks).getByRole('link', { name: '→ Child Safety Standards' })).toBeInTheDocument();
        expect(within(quickLinks).getByRole('link', { name: '→ Delete Your Account' })).toBeInTheDocument();
    });
});
