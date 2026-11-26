import { render, screen } from '@testing-library/react';
import type { ComponentPropsWithoutRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ prefetch, ...props }: ComponentPropsWithoutRef<'a'> & { prefetch?: boolean }) => (
    <a {...props} data-prefetch={prefetch === undefined ? undefined : String(prefetch)} />
  ),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } },
}));
vi.mock('@/components/support-chat/use-support-chat', () => ({
  useSupportChat: () => ({ state: { kind: 'registration-required' }, reload: vi.fn(async () => undefined) }),
}));
vi.mock('@/components/support-chat/SupportChat', () => ({ SupportChat: () => null }));

import SupportConversationClient from '@/app/support/SupportConversationClient';

describe('the support page', () => {
  // The shell's "Help & feedback" opens this page for a browser with a session (owner,
  // 2026-11-26), and the contact page holds the only links such a visitor sees to child safety
  // and account deletion, so this page leads there.
  it('links the contact page beside the support email', () => {
    render(<SupportConversationClient />);

    expect(screen.getByRole('link', { name: 'info@magicbooklet.com' })).toHaveAttribute('href', expect.stringMatching(/^mailto:info@magicbooklet\.com\?/));
    expect(screen.getByRole('link', { name: 'contact page' })).toHaveAttribute('href', '/contact');
  });
});
