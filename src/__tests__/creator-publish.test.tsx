import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import {
  CreatorPostedNext,
  CreatorPublishPanel,
  describePublishSummary,
  describeSharedRecipe,
  ownUploadsWords,
  useCreationPublishDetails,
  useRemixOriginal,
  type CreatorPublishPanelProps,
  type RemixOriginal,
  type RemixOriginalRead,
} from '@/components/CreatorPublish';
import type { CreationPublishDetails } from '@/lib/creation-publish-details';
import { TITLE_MAX_LENGTH } from '@/lib/post-limits';

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
  title: 'Harbour at dusk',
  paywallPrefill: { resourceKinds: ['prompt'], promptText: PROMPT, notesMarkdown: null, allowRemix: false },
  creation: { prompt: PROMPT, model: 'seedance-2-mini', category: 'video' },
};
const ORIGINAL: RemixOriginal = {
  postId: 'post-cats',
  title: 'Kung fu cats',
  creator: { id: 'creator-fluffy', username: 'fluffy', name: 'Fluffy', avatar: null },
};
/** Not a remix of a post: nothing to credit, and the recipe may start shared. */
const NO_REMIX: RemixOriginalRead = { original: null, recipeStartsShared: true };
/** A remix of someone else's post whose recipe is free. */
const FREE_REMIX: RemixOriginalRead = { original: ORIGINAL, recipeStartsShared: true };
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

/** Says whether an observed element is in view: the form's Publish by default. */
function setInView(inView: boolean, matches: (target: Element) => boolean = (target) => !target.hasAttribute('data-creator-bar')) {
  const live = observers.filter((observer) => observer.target && matches(observer.target));
  act(() => {
    for (const observer of live) {
      observer.callback([{ isIntersecting: inView, target: observer.target } as IntersectionObserverEntry], {} as IntersectionObserver);
    }
  });
}

function setSubmitInView(inView: boolean) {
  setInView(inView);
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let profile: Record<string, unknown> = READY_PROFILE;
/** What saving a first post's name and handle answers, where not the saved profile. */
let profileSaveReply: { status: number; body: unknown } | null = null;
let publishReply: { status: number; body: unknown } = {
  status: 200,
  body: { success: true, visibility: 'public', postId: 'post-new', showcasePath: '/showcase/gen-1', resourceBundleStatus: 'published' },
};

function installFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/profile' && method === 'PATCH') {
      if (profileSaveReply) return json(profileSaveReply.body, profileSaveReply.status);
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

function panel(props: Partial<CreatorPublishPanelProps> & { onPublished: CreatorPublishPanelProps['onPublished'] }) {
  return (
    <CreatorPublishPanel
      generationId="gen-1"
      accessToken="token-1"
      viewerUserId="user-1"
      details={DETAILS}
      remix={NO_REMIX}
      sourceSurface="create-video"
      published={null}
      download={{ href: 'https://cdn.example.test/clip.mp4', fileName: 'generated-video.mp4', label: 'Download video' }}
      {...props}
    />
  );
}

function renderPanel(props: Partial<CreatorPublishPanelProps> = {}) {
  const onPublished = vi.fn();
  const view = render(panel({ onPublished, ...props }));
  return {
    ...view,
    onPublished,
    rerenderPanel: (next: Partial<CreatorPublishPanelProps>) => view.rerender(panel({ onPublished, ...props, ...next })),
  };
}

function form() {
  return screen.getByRole('form', { name: 'Post it to the feed' });
}

beforeEach(() => {
  observers.length = 0;
  profile = READY_PROFILE;
  profileSaveReply = null;
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

    view.rerenderPanel({ details: DETAILS });
    expect(within(form()).getByRole('textbox', { name: 'Title' })).toHaveValue('Harbour at dusk');
    // On by default where the creation has a recipe to share (owner, 2026-10-28).
    expect(within(form()).getByRole('switch', { name: 'Share the recipe' })).toHaveAttribute('aria-checked', 'true');
    expect(publish).toBeEnabled();
  });

  // Copied into state by an effect, the recipe was off for the frame in which the details had
  // arrived and Publish was live: a press then sent the post without it.
  it('draws the starting recipe and title in the render the details arrive in, before any effect', () => {
    const markup = renderToStaticMarkup(panel({ onPublished: vi.fn(), details: { ...DETAILS, title: '' } }));
    expect(markup).toMatch(/role="switch" aria-checked="true"/);
    expect(markup).toContain('value="Harbour at dusk, lanterns on the water"');
  });

  // Chrome's implicit submission presses Publish for Enter on a checkbox: a keyboard user
  // ticking "Mark as mature" would post it unmarked (the composer's guard, #565).
  it('never publishes on Enter in one of its checkboxes', () => {
    installFetch();
    renderPanel();
    const mature = within(form()).getByRole('checkbox', { name: 'Mark as mature (NSFW)' });
    expect(fireEvent.keyDown(mature, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(within(form()).getByRole('textbox', { name: 'Title' }), { key: 'Enter' })).toBe(true);
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
    renderPanel({ details: { ...DETAILS, title: '' }, remix: FREE_REMIX });
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

  // The three below came over from the Publish window's tests when Studio's Publish moved to
  // the composer (2026-10-31): the form is the one face of `usePublishCreation` left.
  it('shows a taken handle on its field and publishes nothing', async () => {
    profile = FIRST_POST_PROFILE;
    profileSaveReply = {
      status: 409,
      body: { error: 'That username is already taken.', fieldErrors: { username: 'That username is already taken.' } },
    };
    const fetchMock = installFetch();
    const { onPublished } = renderPanel();
    await within(form()).findByText('Posting as Athul S');

    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));

    await waitFor(() => expect(within(form()).getByRole('textbox', { name: 'Handle' })).toHaveAttribute('aria-invalid', 'true'));
    expect(within(form()).getAllByText('That username is already taken.').length).toBeGreaterThanOrEqual(1);
    expect(publishBody(fetchMock)).toBeNull();
    expect(onPublished).not.toHaveBeenCalled();
    expect(within(form()).getByRole('button', { name: 'Publish to the feed' })).toBeEnabled();
  });

  it('keeps a long creation title within the post limit, so the publish is not refused', async () => {
    const longTitle = `${'Golden hour rooftop portrait '.repeat(5)}with city lights`;
    expect(longTitle.length).toBeGreaterThan(TITLE_MAX_LENGTH);
    const fetchMock = installFetch();
    const { onPublished } = renderPanel({ details: { ...DETAILS, title: longTitle } });
    // The field's maxlength does not trim a value it is handed.
    expect(within(form()).getByRole('textbox', { name: 'Title' })).toHaveValue(longTitle.slice(0, TITLE_MAX_LENGTH));

    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));

    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    expect(publishBody(fetchMock)).toMatchObject({ title: longTitle.slice(0, TITLE_MAX_LENGTH) });
  });

  it('publishes with the page’s own access token', async () => {
    const fetchMock = installFetch();
    const { onPublished } = renderPanel();
    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));

    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/showcase/publish');
    expect((call?.[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer token-1' });
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
    renderPanel({ remix: FREE_REMIX });
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
    renderPanel({ remix: { original: ORIGINAL, recipeStartsShared: false } });
    const recipe = within(form()).getByRole('switch', { name: 'Share the recipe' });
    expect(recipe).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(recipe);
    expect(recipe).toHaveAttribute('aria-checked', 'true');
  });

  it('starts with it on for a free original', () => {
    installFetch();
    renderPanel({ remix: FREE_REMIX });
    expect(within(form()).getByRole('switch', { name: 'Share the recipe' })).toHaveAttribute('aria-checked', 'true');
  });

  // Unread, the original could be a recipe someone sells: a press would publish it free.
  it('waits with Publish while the original is read, the recipe off', () => {
    installFetch();
    const view = renderPanel({ remix: { original: null, recipeStartsShared: undefined } });
    expect(within(form()).getByRole('switch', { name: 'Share the recipe' })).toHaveAttribute('aria-checked', 'false');
    expect(within(form()).getByRole('button', { name: 'Publish to the feed' })).toBeDisabled();

    view.rerenderPanel({ remix: FREE_REMIX });
    expect(within(form()).getByRole('switch', { name: 'Share the recipe' })).toHaveAttribute('aria-checked', 'true');
    expect(within(form()).getByRole('button', { name: 'Publish to the feed' })).toBeEnabled();
  });
});

describe('useRemixOriginal', () => {
  function postAnswer(item: Record<string, unknown>) {
    return json({ item: { id: 'post-cats', title: 'Kung fu cats', creator: { id: 'creator-fluffy', username: 'fluffy', name: 'Fluffy', avatar: null }, ...item } });
  }

  it('lets a creation that is no remix of a post start shared, reading nothing', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useRemixOriginal(null, 'token-1', 'user-1'));
    expect(result.current).toEqual({ original: null, recipeStartsShared: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('credits someone else’s free original and lets the recipe start shared', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => postAnswer({ asset: { accessMode: 'free' } })));
    const { result } = renderHook(() => useRemixOriginal('post-cats', 'token-1', 'user-1'));
    expect(result.current.recipeStartsShared).toBeUndefined();
    await waitFor(() => expect(result.current).toEqual({ original: ORIGINAL, recipeStartsShared: true }));
  });

  it('starts off for a recipe someone sells, one’s own included', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => postAnswer({ asset: { accessMode: 'paid' } })));
    const bought = renderHook(() => useRemixOriginal('post-cats', 'token-1', 'user-1'));
    await waitFor(() => expect(bought.result.current).toEqual({ original: ORIGINAL, recipeStartsShared: false }));

    const own = renderHook(() => useRemixOriginal('post-cats', 'token-1', 'creator-fluffy'));
    await waitFor(() => expect(own.result.current).toEqual({ original: null, recipeStartsShared: false }));
  });

  it('starts off where the original cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Not found' }, 404)));
    const { result } = renderHook(() => useRemixOriginal('post-cats', 'token-1', 'user-1'));
    await waitFor(() => expect(result.current).toEqual({ original: null, recipeStartsShared: false }));
  });

  // Publish waits for this read: one that never answers must not hold it for good.
  it('starts off where the original does not answer in time', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })));
      const { result } = renderHook(() => useRemixOriginal('post-cats', 'token-1', 'user-1'));
      expect(result.current.recipeStartsShared).toBeUndefined();

      await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
      expect(result.current).toEqual({ original: null, recipeStartsShared: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('useCreationPublishDetails', () => {
  const generationsAnswer = { generations: [{ id: 'gen-1', title: 'Harbour at dusk', paywallPrefill: DETAILS.paywallPrefill, prompt: PROMPT, model: 'seedance-2-mini', category: 'video' }] };

  // Read once, a failed answer published the creation as the media alone until the token changed.
  it('reads them again once when the first read fails, waiting meanwhile', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json({ error: 'Busy' }, 503))
        .mockResolvedValueOnce(json(generationsAnswer));
      vi.stubGlobal('fetch', fetchMock);
      const { result } = renderHook(() => useCreationPublishDetails('gen-1', 'token-1'));

      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current).toBeUndefined();

      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.current).toMatchObject({ title: 'Harbour at dusk' });
    } finally {
      vi.useRealTimers();
    }
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

  it('brings the form into view when its press is refused, with the focus on its Publish', async () => {
    publishReply = { status: 400, body: { error: 'Something is off with this post.' } };
    installFetch();
    renderPanel();
    await within(form()).findByText(/Posting as/);
    setSubmitInView(false);
    fireEvent.click(within(screen.getByTestId('creator-publish-bar')).getByRole('button', { name: /^Publish as @/ }));

    expect(await within(form()).findByRole('alert')).toHaveTextContent('Something is off with this post.');
    expect(form().scrollIntoView).toHaveBeenCalled();
    // The bar goes once the form's Publish is in view, and the focus with it unless it moves.
    await waitFor(() => expect(within(form()).getByRole('button', { name: 'Publish to the feed' })).toHaveFocus());
  });

  // The column's own bar, with Generate, waits at the page's end until the creation is posted:
  // there the Publish bar would sit over it.
  it('gives way to the column’s bar at the page’s end', () => {
    installFetch();
    const columnBar = document.createElement('div');
    columnBar.setAttribute('data-creator-bar', '');
    document.body.appendChild(columnBar);
    try {
      renderPanel();
      setSubmitInView(false);
      expect(screen.getByTestId('creator-publish-bar')).toBeInTheDocument();

      setInView(true, (target) => target === columnBar);
      expect(screen.queryByTestId('creator-publish-bar')).toBeNull();
      setInView(false, (target) => target === columnBar);
      expect(screen.getByTestId('creator-publish-bar')).toBeInTheDocument();
    } finally {
      columnBar.remove();
    }
  });
});

describe('CreatorPublishPanel: Posted', () => {
  it('leads a private post to the owner’s page of it', () => {
    installFetch();
    renderPanel({
      published: { title: 'Harbour at dusk', visibility: 'private', postId: 'post-new', showcasePath: null, ownerPath: '/post/post-new/edit', resourceBundleStatus: null },
    });
    expect(screen.getByRole('heading', { name: 'Saved as a private post' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View your post' })).toHaveAttribute('href', '/post/post-new/edit');
  });

  it('says the post is live and where, with the way to it and to share it', () => {
    installFetch();
    renderPanel({
      remix: FREE_REMIX,
      published: { title: 'Harbour at dusk', visibility: 'public', postId: 'post-new', showcasePath: '/showcase/gen-1', resourceBundleStatus: 'published' },
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
