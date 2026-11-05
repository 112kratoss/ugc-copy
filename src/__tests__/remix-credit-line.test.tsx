import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ session: { access_token: 'token-1' }, user: { id: 'viewer-1' } }),
}));

import RemixCreditLine from '@/app/showcase/RemixCreditLine';
import PostRemixes from '@/app/showcase/[id]/PostRemixes';

const cora = { id: 'user-cora', username: 'cora' };
const maya = { id: 'user-maya', username: 'maya' };

describe('the remix credit line', () => {
  it('links the post remixed and each creator it names', () => {
    render(<RemixCreditLine credit={{ parent: { postId: 'post-b', title: 'Sunset, again', creator: maya }, original: cora }} />);

    const line = screen.getByTestId('remix-credit');
    expect(line).toHaveTextContent('Remix of “Sunset, again” by @maya · Original by @cora');
    expect(within(line).getByRole('link', { name: '“Sunset, again”' })).toHaveAttribute('href', '/showcase/post-b');
    expect(within(line).getByRole('link', { name: '@maya' })).toHaveAttribute('href', '/creators/maya');
    expect(within(line).getByRole('link', { name: '@cora' })).toHaveAttribute('href', '/creators/cora');
  });

  it('keeps the whole line in its title where a card cuts it short', () => {
    render(<RemixCreditLine compact credit={{ parent: null, original: cora }} />);
    expect(screen.getByTestId('remix-credit')).toHaveAttribute('title', 'Original by @cora');
  });

  it('draws nothing for a post that is no remix', () => {
    const { container } = render(<RemixCreditLine credit={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('the remixes a post\'s count opens', () => {
  // jsdom draws <dialog> but does not open it: these open and close it as the browser does.
  const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
  const close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); });

  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = showModal;
    HTMLDialogElement.prototype.close = close;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function answer(body: unknown, ok = true) {
    const fetchMock = vi.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => body }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('opens on the count, lists the remixes posted, as this viewer may see them, and says some were not posted', async () => {
    const fetchMock = answer({
      success: true,
      items: [{
        id: 'post-b',
        title: 'Sunset, again',
        mediaKind: 'image',
        mediaUrl: 'https://cdn.example.test/b.png',
        mediaItems: [{ previewUrl: 'https://cdn.example.test/b-preview.webp' }],
        creator: { id: maya.id, username: 'maya', name: 'Maya', avatar: null },
      }],
      pageInfo: { hasMore: false, nextOffset: null, limit: 24, offset: 0 },
    });
    render(<PostRemixes postId="post-a" remixCount={3} />);

    fireEvent.click(screen.getByRole('button', { name: '3 remixes' }));

    expect(showModal).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/showcase/posts/post-a/remixes?offset=0&limit=24', {
      headers: { Authorization: 'Bearer token-1' },
    });
    const remix = await screen.findByRole('link', { name: /Sunset, again/ });
    expect(remix).toHaveAttribute('href', '/showcase/post-b');
    expect(remix).toHaveTextContent('@maya');
    expect(remix.querySelector('img')).toHaveAttribute('src', 'https://cdn.example.test/b-preview.webp');
    expect(screen.getByText('Some remixes haven’t been posted.')).toBeInTheDocument();
  });

  it('says none are posted yet, and offers another try when the list cannot be read', async () => {
    answer({ success: true, items: [], pageInfo: { hasMore: false, nextOffset: null } });
    const view = render(<PostRemixes postId="post-a" remixCount={1} />);
    fireEvent.click(screen.getByRole('button', { name: '1 remix' }));
    expect(await screen.findByText(/No remixes are posted yet/)).toBeInTheDocument();
    view.unmount();

    answer({ error: 'Failed to load remixes.' }, false);
    render(<PostRemixes postId="post-a" remixCount={1} />);
    fireEvent.click(screen.getByRole('button', { name: '1 remix' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Couldn’t load remixes.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
