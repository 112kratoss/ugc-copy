import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StudioMediaPreviewModal } from '@/components/StudioMediaPreviewModal';

afterEach(() => {
  cleanup();
});

function preview(props: Partial<Parameters<typeof StudioMediaPreviewModal>[0]> = {}) {
  return (
    <StudioMediaPreviewModal
      isOpen
      onClose={() => undefined}
      mediaType="image"
      src="https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/a.png?token=old"
      alt="Original creation"
      title="Original Creation"
      {...props}
    />
  );
}

const drawn = () => screen.getByRole('dialog', { name: 'Original Creation' }).querySelector('img, video');

describe('StudioMediaPreviewModal', () => {
  it('draws its link at once where nothing renews it', () => {
    render(preview());
    expect(drawn()).toHaveAttribute('src', 'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/a.png?token=old');
  });

  // A remix's links are signed for an hour: a new player on a lapsed one stayed blank.
  it('draws the link renewed for it, and nothing from the old one meanwhile', async () => {
    let answer: (link: string) => void = () => undefined;
    const renewSrc = vi.fn(() => new Promise<string>((resolve) => { answer = resolve; }));
    render(preview({ mediaType: 'video', renewSrc }));

    expect(renewSrc).toHaveBeenCalledWith('https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/a.png?token=old');
    expect(drawn()).toBeNull();
    expect(screen.getByLabelText('Loading preview')).toBeInTheDocument();

    answer('https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/a.png?token=new');
    await waitFor(() => expect(drawn()).toHaveAttribute('src', 'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/a.png?token=new'));
    expect(drawn()?.tagName).toBe('VIDEO');
  });

  it('draws its own link where renewing it fails', async () => {
    render(preview({ renewSrc: vi.fn(async () => { throw new Error('offline'); }) }));
    await waitFor(() => expect(drawn()).toHaveAttribute('src', 'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/a.png?token=old'));
  });

  it('asks again each time it opens', async () => {
    const renewSrc = vi.fn(async (link: string) => link);
    const view = render(preview({ renewSrc }));
    await waitFor(() => expect(drawn()).not.toBeNull());

    view.rerender(preview({ renewSrc, isOpen: false }));
    view.rerender(preview({ renewSrc }));
    await waitFor(() => expect(drawn()).not.toBeNull());
    expect(renewSrc).toHaveBeenCalledTimes(2);
  });
});
