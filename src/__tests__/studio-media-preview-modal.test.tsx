import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { StudioMediaPreviewModal } from '@/components/StudioMediaPreviewModal';
import { SIGNED_LINK_SECONDS, signedStorageLink } from './fixtures/signed-storage-links';

afterEach(() => {
  cleanup();
});

const PICTURE = 'generated_images/user-1/a.png';
/** Signed two hours ago: storage refuses it by now. */
const lapsedLink = () => signedStorageLink(PICTURE, Date.now() - 2 * SIGNED_LINK_SECONDS * 1000);
const renewedLink = 'https://project.supabase.co/storage/v1/object/sign/generated_images/user-1/a.png?token=new';

function preview(props: Partial<Parameters<typeof StudioMediaPreviewModal>[0]> = {}) {
  return (
    <StudioMediaPreviewModal
      isOpen
      onClose={() => undefined}
      mediaType="image"
      src={lapsedLink()}
      alt="Original creation"
      title="Original Creation"
      {...props}
    />
  );
}

const drawn = () => screen.getByRole('dialog', { name: 'Original Creation' }).querySelector('img, video');

describe('StudioMediaPreviewModal', () => {
  it('draws its link at once where nothing renews it', () => {
    const src = lapsedLink();
    render(preview({ src }));
    expect(drawn()).toHaveAttribute('src', src);
  });

  // Only a link about to lapse waits for its renewal: every other preview of a remix page drew a
  // spinner first while its renewal answered with the link it was given.
  it.each([
    ['a link signed a moment ago', () => signedStorageLink(PICTURE)],
    ['a public link', () => 'https://project.supabase.co/storage/v1/object/public/showcase_media/showcase/gen-1/a.png'],
    ['a picked file', () => 'blob:https://magicbooklet.com/5d1c'],
  ])('draws %s at once, renewing nothing', (_name, link) => {
    const src = link();
    const renewSrc = vi.fn(async (value: string) => value);
    render(preview({ src, renewSrc }));

    expect(drawn()).toHaveAttribute('src', src);
    expect(screen.queryByLabelText('Loading preview')).toBeNull();
    expect(renewSrc).not.toHaveBeenCalled();
  });

  // A remix's links are signed for an hour: a new player on a lapsed one stayed blank.
  it('draws the link renewed for a lapsed one, and nothing from the old one meanwhile', async () => {
    const src = lapsedLink();
    let answer: (link: string) => void = () => undefined;
    const renewSrc = vi.fn(() => new Promise<string>((resolve) => { answer = resolve; }));
    render(preview({ src, mediaType: 'video', renewSrc }));

    expect(renewSrc).toHaveBeenCalledWith(src);
    expect(drawn()).toBeNull();
    expect(screen.getByLabelText('Loading preview')).toBeInTheDocument();

    answer(renewedLink);
    await waitFor(() => expect(drawn()).toHaveAttribute('src', renewedLink));
    expect(drawn()?.tagName).toBe('VIDEO');
  });

  it('draws its own link where renewing it fails', async () => {
    const src = lapsedLink();
    render(preview({ src, renewSrc: vi.fn(async () => { throw new Error('offline'); }) }));
    await waitFor(() => expect(drawn()).toHaveAttribute('src', src));
  });

  it('asks again each time it opens on a lapsed link', async () => {
    const src = lapsedLink();
    const renewSrc = vi.fn(async () => renewedLink);
    const view = render(preview({ src, renewSrc }));
    await waitFor(() => expect(drawn()).not.toBeNull());

    view.rerender(preview({ src, renewSrc, isOpen: false }));
    view.rerender(preview({ src, renewSrc }));
    await waitFor(() => expect(drawn()).not.toBeNull());
    expect(renewSrc).toHaveBeenCalledTimes(2);
  });
});
