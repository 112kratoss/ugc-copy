import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import {
  CreatorPostedNext,
  CreatorPublishPanel,
  describePublishSummary,
  describeSharedRecipe,
  ownUploadsWords,
  type CreatorPublishPanelProps,
  type RemixOriginal,
} from '@/components/CreatorPublish';
import type { CreationPublishDetails } from '@/lib/creation-publish-details';

vi.mock('@/components/AuthProvider', () => ({
  useAuth: () => ({ user: { email: 'athul@example.com', user_metadata: { full_name: 'Athul S' } } }),
}));

vi.mock('@/components/PublicShareButton', () => ({
  default: ({ label }: { label?: string }) => <button type="button">{label}</button>,
}));

vi.mock('@/components/useHandleAvailability', () => ({
  useHandleAvailability: () => ({ state: 'idle' }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));

const PROMPT = 'A harbour at dusk, lanterns on the water, slow push-in.';
const DETAILS: CreationPublishDetails = {
  generationId: 'gen-1',
  title: 'Harbour at dusk',
  paywallPrefill: { resourceKinds: ['prompt'], promptText: PROMPT, notesMarkdown: null, allowRemix: false },
  creation: { prompt: PROMPT, model: 'seedance-2-mini', category: 'video' },
};
const ORIGINAL: RemixOriginal = {
  postId: 'post-cats',
  title: 'Kung fu cats',
  creator: { id: 'creator-fluffy', username: 'fluffy', name: 'Fluffy', avatar: null },
  recipe: 'free',
};
/** A remix with the original's reference and two photos of the creator's own. */
const WITH_UPLOADS: CreationPublishDetails = {
  ...DETAILS,
  paywallPrefill: {
    resourceKinds: ['prompt', 'remix'],
    promptText: PROMPT,
    notesMarkdown: null,
    allowRemix: true,
    referenceCount: 3,
    referenceKindCounts: { image: 3 },
    ownReferenceCount: 2,
    ownReferenceKindCounts: { image: 2 },
  },
};
const FIRST_POST_PROFILE = { id: 'user-1', username: 'creator-a1b2c3d4', displayName: null, avatarUrl: null };
const READY_PROFILE = { id: 'user-1', username: 'athul-s', displayName: 'Athul S', avatarUrl: null };

/** Each IntersectionObserver the panel makes, so a test can say whether its Publish is in view. */
const observers: Array<{ callback: IntersectionObserverCallback; target: Element | null }> = [];
class FakeIntersectionObserver {
  callback: IntersectionObserverCallback;
  record: { callback: IntersectionObserverCallback; target: Element | null };
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    this.record = { callback, target: null };
    observers.push(this.record);
  }
  observe(target: Element) { this.record.target = target; }
  disconnect() { this.record.target = null; }
  unobserve() {}
  takeRecords() { return []; }
}

function setSubmitInView(inView: boolean) {
  const live = observers.filter((observer) => observer.target);
  act(() => {
    for (const observer of live) {
      observer.callback([{ isIntersecting: inView, target: observer.target } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let profile: Record<string, unknown> = READY_PROFILE;
let publishReply: { status: number; body: unknown } = {
  status: 200,
  body: { success: true, visibility: 'public', postId: 'post-new', showcasePath: '/showcase/gen-1', resourceBundleStatus: 'published' },
};

function installFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/profile' && method === 'PATCH') {
      profile = { ...profile, ...JSON.parse(String(init?.body)) };
      return json(profile);
    }
    if (url === '/api/profile') return json(profile);
    if (url.startsWith('/api/profile/follow')) return json({ following: method === 'POST' });
    if (url === '/api/showcase/publish') return json(publishReply.body, publishReply.status);
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function publishBody(fetchMock: ReturnType<typeof installFetch>) {
  const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/showcase/publish');
  return call ? JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown> : null;
}

function renderPanel(props: Partial<CreatorPublishPanelProps> = {}) {
  const onPublished = vi.fn();
  const view = render(
    <CreatorPublishPanel
      generationId="gen-1"
      accessToken="token-1"
      details={DETAILS}
      original={null}
      sourceSurface="create-video"
      published={null}
      onPublished={onPublished}
      download={{ href: 'https://cdn.example.test/clip.mp4', fileName: 'generated-video.mp4', label: 'Download video' }}
      {...props}
    />,
  );
  return { ...view, onPublished };
}

function form() {
  return screen.getByRole('form', { name: 'Post it to the feed' });
}

beforeEach(() => {
  observers.length = 0;
  profile = READY_PROFILE;
  publishReply = {
    status: 200,
    body: { success: true, visibility: 'public', postId: 'post-new', showcasePath: '/showcase/gen-1', resourceBundleStatus: 'published' },
  };
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CreatorPublishPanel: the form on the canvas', () => {
  it('waits for the creation’s details, then starts from its title with the recipe shared', async () => {
    installFetch();
    const view = renderPanel({ details: undefined });
    const publish = within(form()).getByRole('button', { name: 'Publish to the feed' });
    // A press before the details would publish the media alone.
    expect(publish).toBeDisabled();

    view.rerender(
      <CreatorPublishPanel
        generationId="gen-1"
        accessToken="token-1"
        details={DETAILS}
        original={null}
        sourceSurface="create-video"
        published={null}
        onPublished={view.onPublished}
        download={{ href: 'https://cdn.example.test/clip.mp4', fileName: 'generated-video.mp4', label: 'Download video' }}
      />,
    );
    expect(within(form()).getByRole('textbox', { name: 'Title' })).toHaveValue('Harbour at dusk');
    // On by default where the creation has a recipe to share (owner, 2026-10-28).
    expect(within(form()).getByRole('switch', { name: 'Share the recipe' })).toHaveAttribute('aria-checked', 'true');
    expect(publish).toBeEnabled();
  });

  it('suggests a title from the prompt for an untitled creation, a free recipe or none', async () => {
    installFetch();
    renderPanel({ details: { ...DETAILS, title: '' } });
    const title = within(form()).getByRole('textbox', { name: 'Title' });
    // A free recipe hands its prompt to anyone, so it may name the post (owner, 2026-10-29).
    expect(title).toHaveValue('Harbour at dusk, lanterns on the water');
    expect(within(form()).getByText('Suggested from your prompt. Edit it if you like.')).toBeInTheDocument();
    fireEvent.click(within(form()).getByRole('switch', { name: 'Share the recipe' }));
    expect(title).toHaveValue('Harbour at dusk, lanterns on the water');
  });

  it('starts an untitled remix from its original’s title, as the artboard has it', async () => {
    installFetch();
    renderPanel({ details: { ...DETAILS, title: '' }, original: ORIGINAL });
    expect(within(form()).getByRole('textbox', { name: 'Title' })).toHaveValue('Kung fu cats (remix)');
    expect(within(form()).getByText('Suggested from the original. Edit it if you like.')).toBeInTheDocument();
    // Not cut from the prompt, so the recipe does not swap it.
    fireEvent.click(within(form()).getByRole('switch', { name: 'Share the recipe' }));
    expect(within(form()).getByRole('textbox', { name: 'Title' })).toHaveValue('Kung fu cats (remix)');
  });

  it('says whom a ready profile posts as', async () => {
    installFetch();
    renderPanel();
    expect(await within(form()).findByText(/Posting as/)).toHaveTextContent('Posting as Athul S · @athul-s');
    expect(within(form()).queryByRole('button', { name: 'Change your name or handle' })).toBeNull();
  });

  it('fills a first post’s name and handle from the sign-in, with Change to edit both in place', async () => {
    profile = FIRST_POST_PROFILE;
    installFetch();
    renderPanel();
    expect(await within(form()).findByText('Posting as Athul S')).toBeInTheDocument();
    expect(within(form()).getByText('@athul-s · your first post sets these')).toBeInTheDocument();
    expect(within(form()).queryByRole('textbox', { name: 'Display name' })).toBeNull();

    fireEvent.click(within(form()).getByRole('button', { name: 'Change your name or handle' }));
    expect(within(form()).getByRole('textbox', { name: 'Display name' })).toHaveValue('Athul S');
    expect(within(form()).getByRole('textbox', { name: 'Handle' })).toHaveValue('athul-s');
  });

  it('saves a first post’s name and handle, then publishes the free recipe, in one press', async () => {
    profile = FIRST_POST_PROFILE;
    const fetchMock = installFetch();
    const { onPublished } = renderPanel();
    await within(form()).findByText('Posting as Athul S');

    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));

    await waitFor(() => expect(onPublished).toHaveBeenCalledWith(expect.objectContaining({ postId: 'post-new', showcasePath: '/showcase/gen-1' })));
    const saved = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/profile' && init?.method === 'PATCH');
    expect(JSON.parse(String((saved?.[1] as RequestInit).body))).toEqual({ username: 'athul-s', displayName: 'Athul S' });
    expect(publishBody(fetchMock)).toMatchObject({
      generationId: 'gen-1',
      visibility: 'public',
      title: 'Harbour at dusk',
      resourceBundle: { accessMode: 'free', priceUsdCents: 0, resources: { promptText: PROMPT, allowRemix: false } },
    });
  });

  it('publishes the media alone with the recipe off', async () => {
    const fetchMock = installFetch();
    const { onPublished } = renderPanel();
    fireEvent.click(within(form()).getByRole('switch', { name: 'Share the recipe' }));
    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));

    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    expect(publishBody(fetchMock)).toMatchObject({ resourceBundle: { accessMode: 'none' } });
    expect(publishBody(fetchMock)).not.toHaveProperty('includeGenerationReferences');
  });

  it('says why a publish was refused, beside the form', async () => {
    publishReply = { status: 400, body: { error: 'Replace the placeholder title with something specific to this post.' } };
    installFetch();
    const { onPublished } = renderPanel();
    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));

    expect(await within(form()).findByRole('alert')).toHaveTextContent('Replace the placeholder title');
    expect(onPublished).not.toHaveBeenCalled();
    expect(within(form()).getByRole('button', { name: 'Publish to the feed' })).toBeEnabled();
  });

  it('credits the original with Follow, and never promises an alert at publish', async () => {
    const fetchMock = installFetch();
    renderPanel({ original: ORIGINAL });
    expect(within(form()).getByText(/Remix of “Kung fu cats” by/)).toBeInTheDocument();
    // Its creator was told when the remix finished (`notifyCompletedRemix`), not now.
    expect(within(form()).getByText('@fluffy was told when your remix finished.')).toBeInTheDocument();
    expect(within(form()).getByRole('link', { name: '@fluffy' })).toHaveAttribute('href', '/creators/fluffy');

    const follow = await within(form()).findByRole('button', { name: 'Follow @fluffy' });
    expect(follow).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(follow);
    expect(await within(form()).findByRole('button', { name: 'Following @fluffy' })).toHaveAttribute('aria-pressed', 'true');
    const followed = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/profile/follow' && init?.method === 'POST');
    expect(JSON.parse(String((followed?.[1] as RequestInit).body))).toEqual({ followingId: 'creator-fluffy', following: true });
  });
});

// Owner, 2026-10-29: the recipe shares the prompt, the settings and the original's references;
// the creator's own uploads stay out unless they add them, and with any in the creation the
// remix's hand-over, which would give them all away, is off.
describe('CreatorPublishPanel: the creator’s own uploads', () => {
  it('leaves them out by default: the original’s references only, and no hand-over', async () => {
    const fetchMock = installFetch();
    const { onPublished } = renderPanel({ details: WITH_UPLOADS });
    expect(within(form()).getByText('The prompt, settings and the original’s references, free, so others can remix it. Your 2 photos stay out unless you add them.')).toBeInTheDocument();
    expect(within(form()).getByRole('checkbox', { name: 'Add my 2 photos' })).not.toBeChecked();

    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    expect(publishBody(fetchMock)).toMatchObject({
      includeGenerationReferences: true,
      leaveOutOwnGenerationReferences: true,
      resourceBundle: { accessMode: 'free', resources: { allowRemix: false } },
    });
  });

  it('puts them in, hand-over and all, once the creator adds them', async () => {
    const fetchMock = installFetch();
    const { onPublished } = renderPanel({ details: WITH_UPLOADS });
    fireEvent.click(within(form()).getByRole('checkbox', { name: 'Add my 2 photos' }));
    expect(within(form()).getByText(/Your 2 photos go with it, and remixes get them\./)).toBeInTheDocument();

    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    const body = publishBody(fetchMock);
    expect(body).toMatchObject({ includeGenerationReferences: true, resourceBundle: { resources: { allowRemix: true } } });
    expect(body).not.toHaveProperty('leaveOutOwnGenerationReferences');
  });

  it('shares the prompt and settings alone where every reference is the creator’s own', async () => {
    const fetchMock = installFetch();
    const own: CreationPublishDetails = {
      ...WITH_UPLOADS,
      paywallPrefill: { ...WITH_UPLOADS.paywallPrefill!, referenceCount: 2, ownReferenceCount: 2 },
    };
    const { onPublished } = renderPanel({ details: own });
    expect(within(form()).getByText('The prompt and settings, free, so others can remix it. Your 2 photos stay out unless you add them.')).toBeInTheDocument();

    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    const body = publishBody(fetchMock);
    expect(body).not.toHaveProperty('includeGenerationReferences');
    expect(body).toMatchObject({ leaveOutOwnGenerationReferences: true, resourceBundle: { resources: { allowRemix: false } } });
  });

  it('counts every reference as the creator’s own where the answer did not say', () => {
    installFetch();
    const unknown: CreationPublishDetails = {
      ...WITH_UPLOADS,
      paywallPrefill: { ...WITH_UPLOADS.paywallPrefill!, ownReferenceCount: undefined, ownReferenceKindCounts: undefined },
    };
    renderPanel({ details: unknown });
    expect(within(form()).getByRole('checkbox', { name: 'Add my 3 photos' })).toBeInTheDocument();
  });

  it('starts off where the recipe would hold nothing without them', () => {
    installFetch();
    const onlyOwn: CreationPublishDetails = {
      ...DETAILS,
      paywallPrefill: { resourceKinds: ['remix'], promptText: null, notesMarkdown: null, allowRemix: true, referenceCount: 2, ownReferenceCount: 2 },
    };
    renderPanel({ details: onlyOwn });
    expect(within(form()).getByRole('switch', { name: 'Share the recipe' })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('CreatorPublishPanel: a remix of a paid recipe', () => {
  // The creator bought it to remix it: sharing it free is their call (owner, 2026-10-29).
  it('starts with the recipe off, and lets the creator share it', async () => {
    installFetch();
    renderPanel({ original: { ...ORIGINAL, recipe: 'paid' } });
    const recipe = within(form()).getByRole('switch', { name: 'Share the recipe' });
    expect(recipe).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(recipe);
    expect(recipe).toHaveAttribute('aria-checked', 'true');
  });

  it('starts with it on for a free original', () => {
    installFetch();
    renderPanel({ original: ORIGINAL });
    expect(within(form()).getByRole('switch', { name: 'Share the recipe' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('CreatorPublishPanel: the phone’s Publish bar', () => {
  it('shows only while the form’s own Publish is out of view, and sends the same post', async () => {
    const fetchMock = installFetch();
    const { onPublished } = renderPanel();
    await within(form()).findByText(/Posting as/);
    expect(screen.queryByTestId('creator-publish-bar')).toBeNull();

    setSubmitInView(false);
    const bar = screen.getByTestId('creator-publish-bar');
    expect(within(bar).getByText('As Athul S · “Harbour at dusk” · recipe shared ·', { exact: false })).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: 'Download video' })).toHaveAttribute('href', 'https://cdn.example.test/clip.mp4');

    fireEvent.click(within(bar).getByRole('button', { name: 'Publish as @athul-s' }));
    await waitFor(() => expect(onPublished).toHaveBeenCalledTimes(1));
    expect(publishBody(fetchMock)).toMatchObject({ title: 'Harbour at dusk', resourceBundle: { accessMode: 'free' } });
  });

  it('goes again once the form’s Publish is back in view', async () => {
    installFetch();
    renderPanel();
    setSubmitInView(false);
    expect(screen.getByTestId('creator-publish-bar')).toBeInTheDocument();
    setSubmitInView(true);
    expect(screen.queryByTestId('creator-publish-bar')).toBeNull();
  });

  it('brings the form into view when its press is refused', async () => {
    publishReply = { status: 400, body: { error: 'Something is off with this post.' } };
    installFetch();
    renderPanel();
    await within(form()).findByText(/Posting as/);
    setSubmitInView(false);
    fireEvent.click(within(screen.getByTestId('creator-publish-bar')).getByRole('button', { name: /^Publish as @/ }));

    expect(await within(form()).findByRole('alert')).toHaveTextContent('Something is off with this post.');
    expect(form().scrollIntoView).toHaveBeenCalled();
  });
});

describe('CreatorPublishPanel: Posted', () => {
  it('says the post is live and where, with the way to it and to share it', () => {
    installFetch();
    renderPanel({
      original: ORIGINAL,
      published: { title: 'Harbour at dusk', description: '', visibility: 'public', postId: 'post-new', showcasePath: '/showcase/gen-1', resourceBundleStatus: 'published' },
      next: <span>6 credits left</span>,
    });
    expect(screen.queryByRole('form', { name: 'Post it to the feed' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Posted to the feed' })).toHaveFocus();
    expect(screen.getByText(/“Harbour at dusk” is live on your profile and in Explore\. You’ll get an alert when someone remixes yours\./)).toBeInTheDocument();
    expect(screen.getByText(/@fluffy was told when your remix finished\. Your recipe is free, so others can remix yours too\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View your post' })).toHaveAttribute('href', '/showcase/gen-1');
    expect(screen.getByRole('button', { name: 'Share the link' })).toBeInTheDocument();
    expect(screen.getByText('6 credits left')).toBeInTheDocument();
    expect(screen.queryByTestId('creator-publish-bar')).toBeNull();
  });
});

describe('CreatorPostedNext', () => {
  it('offers another run where the balance covers it', () => {
    const onMakeAnother = vi.fn();
    render(<CreatorPostedNext balance={22} runCost={19} imageHref="/create-image" onMakeAnother={onMakeAnother} />);
    fireEvent.click(screen.getByRole('button', { name: 'make another' }));
    expect(onMakeAnother).toHaveBeenCalled();
    expect(screen.getByText('22 credits left:')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'top up' })).toHaveAttribute('href', '/pricing');
  });

  it('offers an image where it does not, or only a top-up', () => {
    const { unmount } = render(<CreatorPostedNext balance={3} runCost={19} imageHref="/create-image?model=z-image" onMakeAnother={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'make an image' })).toHaveAttribute('href', '/create-image?model=z-image');
    unmount();

    render(<CreatorPostedNext balance={0} runCost={19} imageHref={null} onMakeAnother={vi.fn()} />);
    expect(screen.queryByRole('link', { name: 'make an image' })).toBeNull();
    expect(screen.queryByText('or')).toBeNull();
    expect(screen.getByRole('link', { name: 'top up' })).toBeInTheDocument();
  });
});

describe('the recipe’s words', () => {
  it('names the creator’s own uploads by what they are', () => {
    expect(ownUploadsWords(2, { image: 2 })).toBe('2 photos');
    expect(ownUploadsWords(1, { video: 1 })).toBe('1 clip');
    expect(ownUploadsWords(3, { image: 2, video: 1 })).toBe('3 files');
    expect(ownUploadsWords(1, null)).toBe('1 file');
  });

  it('says what goes with the recipe and what stays out', () => {
    expect(describeSharedRecipe({ otherReferenceCount: 0, ownUploads: null, addsOwnUploads: false }))
      .toBe('The prompt and settings, free, so others can remix it.');
    expect(describeSharedRecipe({ otherReferenceCount: 1, ownUploads: '1 photo', addsOwnUploads: false }))
      .toBe('The prompt, settings and the original’s references, free, so others can remix it. Your 1 photo stays out unless you add it.');
    expect(describeSharedRecipe({ otherReferenceCount: 1, ownUploads: '1 photo', addsOwnUploads: true }))
      .toBe('The prompt, settings and the original’s references, free, so others can remix it. Your 1 photo goes with it, and remixes get it.');
  });
});

describe('describePublishSummary', () => {
  it('says what the bar’s Publish will send', () => {
    expect(describePublishSummary({ name: 'Athul S', title: 'Harbour at dusk', recipeShared: true })).toBe('As Athul S · “Harbour at dusk” · recipe shared');
    expect(describePublishSummary({ name: '', title: '  ', recipeShared: false })).toBe('');
  });
});
