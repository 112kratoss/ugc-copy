import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import PublishToShowcaseModal from '@/app/components/PublishToShowcaseModal';

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
  }),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
    },
  },
}));

describe('PublishToShowcaseModal', () => {
  it('keeps the publish dialog scrollable within the viewport', () => {
    render(
      <PublishToShowcaseModal
        isOpen
        onClose={vi.fn()}
        generationId="gen-1"
        defaultTitle="Broadcast"
      />
    );

    const dialog = screen.getByRole('dialog', { name: /add this creation to your portfolio/i });
    const overlay = dialog.parentElement;

    expect(overlay).toHaveClass('overflow-y-auto');
    expect(dialog).toHaveClass('max-h-[calc(100vh-3rem)]');
    expect(dialog).toHaveClass('overflow-y-auto');
  });
});
