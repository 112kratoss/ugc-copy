import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

import {
  CreatorPostedNext,
  CreatorPublishPanel,
  describeCreationRecipe,
  describePublishSummary,
  ownUploadsWords,
  useCreationPublishDetails,
  useRemixOriginal,
  type CreatorPublishPanelProps,
  type RemixOriginal,
  type RemixOriginalRead,
} from '@/components/CreatorPublish';
import { readGenerationPaywallPrefill, type CreationPublishDetails } from '@/lib/creation-publish-details';
import { TITLE_MAX_LENGTH } from '@/lib/post-limits';
import { onCreditTopUpOpen } from '@/lib/credit-top-up';
import {
  CREATION_RECIPE_FILES_LINE,
  PAID_RECIPE_RESALE_LINE,
  REMIX_RECIPE_MUST_BE_PAID,
  REMIX_RECIPE_STAYS_FREE,
  type GenerationReference,
} from '../../ugc-mobile/lib/creation-recipe/creation-recipe';

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
  paywallPrefill: { resourceKinds: ['prompt'], promptText: PROMPT, allowRemix: false },
  creation: { prompt: PROMPT, model: 'seedance-2-mini', category: 'video' },
  inputs: [],
  remixRecipeMode: null,
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
const input = (id: string, label: string): GenerationReference => ({
  id, url: `https://cdn.example.test/${id}.png`, storagePath: null, mediaKind: 'image', label, caption: 'Reference image',
});
/** A remix with the original's reference and two photos of the creator's own, all three taken by the recipe. */
const WITH_FILES: CreationPublishDetails = {
  ...DETAILS,
  paywallPrefill: {
    resourceKinds: ['prompt', 'remix'],
    promptText: PROMPT,
    allowRemix: true,
    referenceCount: 3,
    referenceKindCounts: { image: 3 },
    ownReferenceCount: 2,
    ownReferenceKindCounts: { image: 2 },
  },
  inputs: [input('input-1', 'Dojo'), input('input-2', 'My face'), input('input-3', 'My cat')],
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
    // A creation's post always carries its recipe, free, with remixes allowed (owner, 2026-11-05).
    expect(within(form()).getByRole('heading', { name: 'Free recipe' })).toBeInTheDocument();
    expect(within(form()).queryByRole('switch', { name: 'Share the recipe' })).not.toBeInTheDocument();
    expect(within(form()).getByRole('switch', { name: 'Allow remixes' })).toHaveAttribute('aria-checked', 'true');
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
  });

  // A paid recipe sells the prompt, so its title is never cut from it (owner, 2026-10-29).
  it('names a remix of a paid recipe by what it is, never by its prompt', () => {
    installFetch();
    renderPanel({ details: { ...DETAILS, title: '', remixRecipeMode: 'paid' } });
    expect(within(form()).getByRole('textbox', { name: 'Title' })).not.toHaveValue('Harbour at dusk, lanterns on the water');
  });

  it('starts an untitled remix from its original’s title, as the artboard has it', async () => {
    installFetch();
    renderPanel({ details: { ...DETAILS, title: '' }, remix: FREE_REMIX });
    expect(within(form()).getByRole('textbox', { name: 'Title' })).toHaveValue('Kung fu cats (remix)');
    expect(within(form()).getByText('Suggested from the original. Edit it if you like.')).toBeInTheDocument();
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

  // Owner, 2026-11-03: the creation's settings show on its post for everyone, so the recipe
  // takes in no "Saved generation setup", even from an answer that still carried one: the
  // prefill's one reader, which the composer shares, leaves its notes out.
  it('shares no settings with the recipe, which the post shows everyone', async () => {
    const fetchMock = installFetch();
    const olderAnswer = {
      resourceKinds: ['prompt', 'notes'],
      promptText: PROMPT,
      notesMarkdown: 'Saved generation setup\nAspect ratio: 9:16\nDuration: 5s',
      allowRemix: false,
    };
    const paywallPrefill = readGenerationPaywallPrefill(olderAnswer);
    expect(paywallPrefill).toEqual({ resourceKinds: ['prompt'], promptText: PROMPT, allowRemix: false });
    const { onPublished } = renderPanel({ details: { ...DETAILS, paywallPrefill } });
    expect(within(form()).getByText('The exact prompt, free, so others can remix it.')).toBeInTheDocument();
    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));

    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    const body = publishBody(fetchMock);
    expect(body).toMatchObject({
      resourceBundle: {
        accessMode: 'free',
        // Its remix goes with it while remixes are allowed (owner, 2026-11-05).
        summary: 'Prompt and remix from this creation',
        resources: { promptText: PROMPT },
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/saved generation setup|aspect ratio|9:16|notes/i);
  });

  // An answer of notes alone (the settings) offers no recipe on either surface: the composer reads
  // it through the same reader, which leaves it no kind.
  it('offers no recipe from an older answer that held only the settings', () => {
    installFetch();
    const paywallPrefill = readGenerationPaywallPrefill({
      resourceKinds: ['notes'],
      promptText: null,
      notesMarkdown: 'Saved generation setup\nAspect ratio: 9:16',
      allowRemix: false,
    });
    expect(paywallPrefill).toEqual({ resourceKinds: [], promptText: null, allowRemix: false });
    renderPanel({ details: { ...DETAILS, paywallPrefill } });
    expect(within(form()).queryByRole('heading', { name: 'Free recipe' })).not.toBeInTheDocument();
    expect(readGenerationPaywallPrefill({ resourceKinds: ['settings'], allowRemix: false })).toBeNull();
    expect(readGenerationPaywallPrefill(null)).toBeNull();
  });

  // A motion run saved no prompt: its recipe is the original's references, or the creator's own
  // uploads once added, and the switch says so rather than promising a prompt (#675's review).
  it('describes a prompt-less creation’s recipe by what it holds', () => {
    installFetch();
    const motion: CreationPublishDetails = {
      ...DETAILS,
      paywallPrefill: {
        resourceKinds: ['remix', 'files'],
        promptText: null,
        allowRemix: true,
        referenceCount: 2,
        referenceKindCounts: { image: 1, video: 1 },
        ownReferenceCount: 0,
        ownReferenceKindCounts: {},
      },
      creation: { prompt: '', model: 'kling-2.6', category: 'video' },
      inputs: [input('input-1', 'Character'), input('input-2', 'Clip')],
    };
    renderPanel({ details: motion });
    expect(within(form()).getByText('2 files, free, so others can remix it.')).toBeInTheDocument();
    expect(within(form()).queryByText(/the exact prompt/i)).not.toBeInTheDocument();
  });

  // Owner, 2026-11-05: no "without recipe" for a creation; one with nothing to share posts alone.
  it('publishes the media alone only for a creation with nothing to share, saying so', async () => {
    const fetchMock = installFetch();
    const { onPublished } = renderPanel({ details: { ...DETAILS, paywallPrefill: null } });
    expect(within(form()).getByText('Publish the media now; you can add a recipe from the post later.')).toBeInTheDocument();
    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));

    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    expect(publishBody(fetchMock)).toMatchObject({ resourceBundle: { accessMode: 'none' } });
    expect(publishBody(fetchMock)).not.toHaveProperty('includeGenerationReferences');
    // No switch with the media alone: the server reads one as a form that offers no post without a
    // recipe, and this one just did (the review of phase 2).
    expect(publishBody(fetchMock)).not.toHaveProperty('allowRemixes');
  });

  // The review of phase 2: details that could not be read leave the media alone to publish, and
  // that publish is not refused for its missing recipe.
  it('publishes the media alone when the creation’s details could not be read, without the switch', async () => {
    const fetchMock = installFetch();
    const { onPublished } = renderPanel({ details: null });
    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));

    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    expect(publishBody(fetchMock)).toMatchObject({ resourceBundle: { accessMode: 'none' } });
    expect(publishBody(fetchMock)).not.toHaveProperty('allowRemixes');
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

// Owner, 2026-11-05 (remix plan, phase 2): the recipe takes every saved input, the creator's own
// uploads included, each with a remove button and the line that says where they go; and it allows
// remixes unless the creator turns that off.
describe('CreatorPublishPanel: the recipe’s files and remixes', () => {
  it('takes every saved input, the creator’s own included, as copies, and hands no live input over', async () => {
    const fetchMock = installFetch();
    const { onPublished } = renderPanel({ details: WITH_FILES });
    const files = within(form()).getByRole('list', { name: 'Files in the recipe' });
    expect(within(files).getAllByRole('img').map((image) => image.getAttribute('alt'))).toEqual(['Dojo', 'My face', 'My cat']);
    expect(within(form()).getByText(CREATION_RECIPE_FILES_LINE)).toBeInTheDocument();
    expect(within(form()).getByText('The exact prompt and 3 files, free, so others can remix it.')).toBeInTheDocument();

    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    const body = publishBody(fetchMock);
    expect(body).toMatchObject({
      includeGenerationReferences: true,
      allowRemixes: true,
      // The review of phase 2: a live hand-over would give back a file removed on a later edit; a
      // remix restores the recipe's copies instead.
      resourceBundle: { accessMode: 'free', resources: { allowRemix: false } },
    });
    expect(body).not.toHaveProperty('leaveOutOwnGenerationReferences');
    expect(body).not.toHaveProperty('leaveOutGenerationReferenceIds');
  });

  it('leaves a removed file out, hands no input over, and puts it back on asking', async () => {
    const fetchMock = installFetch();
    const { onPublished } = renderPanel({ details: WITH_FILES });
    fireEvent.click(within(form()).getByRole('button', { name: 'Remove My face from the recipe' }));
    expect(within(form()).queryByRole('img', { name: 'My face' })).not.toBeInTheDocument();
    expect(within(form()).getByText('The exact prompt and 2 files, free, so others can remix it.')).toBeInTheDocument();
    fireEvent.click(within(form()).getByRole('button', { name: 'Remove My cat from the recipe' }));
    fireEvent.click(within(form()).getByRole('button', { name: 'Put the 2 removed files back' }));
    expect(within(form()).getAllByRole('img')).toHaveLength(3);
    fireEvent.click(within(form()).getByRole('button', { name: 'Remove My face from the recipe' }));

    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    expect(publishBody(fetchMock)).toMatchObject({
      includeGenerationReferences: true,
      leaveOutGenerationReferenceIds: ['input-2'],
      // The hand-over would give the removed file to a remix too: the copies go instead.
      resourceBundle: { accessMode: 'free', resources: { allowRemix: false } },
    });
  });

  it('sends remixes off where the creator turns them off', async () => {
    const fetchMock = installFetch();
    const { onPublished } = renderPanel({ details: WITH_FILES });
    fireEvent.click(within(form()).getByRole('switch', { name: 'Allow remixes' }));
    expect(within(form()).getByText('The exact prompt and 3 files, free.')).toBeInTheDocument();

    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    expect(publishBody(fetchMock)).toMatchObject({ allowRemixes: false, resourceBundle: { accessMode: 'free' } });
  });
});

// Owner, 2026-11-05: a remix keeps its original recipe's terms, which the server holds too
// (REMIX_RECIPE_MUST_BE_PAID, REMIX_RECIPE_STAYS_FREE): the form draws them locked, with why.
describe('CreatorPublishPanel: a remix’s recipe terms', () => {
  it('posts a remix of a paid recipe paid, at the starting price, and says why and what buyers may do', async () => {
    const fetchMock = installFetch();
    const { onPublished } = renderPanel({ remix: { original: ORIGINAL, recipeStartsShared: false }, details: { ...DETAILS, remixRecipeMode: 'paid' } });
    expect(within(form()).getByRole('heading', { name: 'Paid recipe' })).toBeInTheDocument();
    expect(within(form()).getByText(REMIX_RECIPE_MUST_BE_PAID)).toBeInTheDocument();
    expect(within(form()).getByText(`${PAID_RECIPE_RESALE_LINE} Another price is in More options.`)).toBeInTheDocument();

    fireEvent.click(within(form()).getByRole('button', { name: 'Publish to the feed' }));
    await waitFor(() => expect(onPublished).toHaveBeenCalled());
    expect(publishBody(fetchMock)).toMatchObject({ resourceBundle: { accessMode: 'paid', priceUsdCents: 10 } });
  });

  it('keeps a remix of a free recipe free, and says why', () => {
    installFetch();
    renderPanel({ remix: FREE_REMIX, details: { ...DETAILS, remixRecipeMode: 'free' } });
    expect(within(form()).getByRole('heading', { name: 'Free recipe' })).toBeInTheDocument();
    expect(within(form()).getByText(REMIX_RECIPE_STAYS_FREE)).toBeInTheDocument();
  });

  it('waits with Publish while the original is read', () => {
    installFetch();
    const view = renderPanel({ remix: { original: null, recipeStartsShared: undefined } });
    expect(within(form()).getByRole('button', { name: 'Publish to the feed' })).toBeDisabled();

    view.rerenderPanel({ remix: FREE_REMIX });
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
  it('offers another run where the balance covers it, or a top-up', () => {
    const onMakeAnother = vi.fn();
    render(<CreatorPostedNext balance={22} runCost={19} onMakeAnother={onMakeAnother} />);
    fireEvent.click(screen.getByRole('button', { name: 'make another' }));
    expect(onMakeAnother).toHaveBeenCalled();
    expect(screen.getByText('22 credits left:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'top up' })).toBeInTheDocument();
  });

  // Owner, 2026-11-02: a balance short of another run is sold credits on the page, not a picture instead.
  it('offers only a top-up where it does not, which opens the packs with the run\'s need', () => {
    const opened: unknown[] = [];
    const stop = onCreditTopUpOpen((request) => opened.push(request));
    render(<CreatorPostedNext balance={3} runCost={19} onMakeAnother={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'make another' })).toBeNull();
    expect(screen.queryByText('or')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'top up' }));
    expect(opened).toEqual([{ need: { cost: 19, balance: 3 }, pricingHref: '/pricing' }]);
    stop();
  });

  // A remix keeps no draft, so the pricing page its packs offer after Posted is told the way back too, as the bar's is.
  it('tells the packs the pricing page the page says', () => {
    const toRemix = `/pricing?returnTo=${encodeURIComponent('/create-video?remix=gen-1&remixPost=post-1')}`;
    const opened: unknown[] = [];
    const stop = onCreditTopUpOpen((request) => opened.push(request));
    render(<CreatorPostedNext balance={3} runCost={19} onMakeAnother={vi.fn()} topUpHref={toRemix} />);
    fireEvent.click(screen.getByRole('button', { name: 'top up' }));
    stop();
    expect(opened).toEqual([{ need: { cost: 19, balance: 3 }, pricingHref: toRemix }]);
  });
});

describe('the recipe’s words', () => {
  it('names the creator’s own uploads by what they are', () => {
    expect(ownUploadsWords(2, { image: 2 })).toBe('2 photos');
    expect(ownUploadsWords(1, { video: 1 })).toBe('1 clip');
    expect(ownUploadsWords(3, { image: 2, video: 1 })).toBe('3 files');
    expect(ownUploadsWords(1, null)).toBe('1 file');
  });

  it('says what the recipe holds, at what price, and whether others may remix it', () => {
    expect(describeCreationRecipe({ accessMode: 'free', priceCredits: 10, fileCount: 0, allowRemixes: true }))
      .toBe('The exact prompt, free, so others can remix it.');
    expect(describeCreationRecipe({ accessMode: 'free', priceCredits: 10, fileCount: 1, allowRemixes: true }))
      .toBe('The exact prompt and 1 file, free, so others can remix it.');
    expect(describeCreationRecipe({ accessMode: 'paid', priceCredits: 10, fileCount: 2, allowRemixes: false }))
      .toBe('The exact prompt and 2 files, for 10 credits.');
  });

  // A creation that saved no prompt (a motion run) is never told it shares one.
  it('names no prompt for a creation that saved none', () => {
    expect(describeCreationRecipe({ accessMode: 'free', priceCredits: 10, hasPrompt: false, fileCount: 2, allowRemixes: true }))
      .toBe('2 files, free, so others can remix it.');
    expect(describeCreationRecipe({ accessMode: 'free', priceCredits: 10, hasPrompt: false, fileCount: 0, allowRemixes: true }))
      .toBe('Its remix, free, so others can remix it.');
  });
});

describe('describePublishSummary', () => {
  it('says what the bar’s Publish will send', () => {
    expect(describePublishSummary({ name: 'Athul S', title: 'Harbour at dusk', recipeShared: true })).toBe('As Athul S · “Harbour at dusk” · recipe shared');
    expect(describePublishSummary({ name: '', title: '  ', recipeShared: false })).toBe('');
  });
});
