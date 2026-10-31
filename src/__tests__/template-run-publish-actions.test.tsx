import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import TemplateRunClient from '@/components/templates/TemplateRunClient';

const testState = vi.hoisted(() => ({
  isTest: false,
}));

// One object for every render: an effect that depends on a value the hook
// returns would otherwise run again on each one.
const auth = vi.hoisted(() => ({
  session: { access_token: 'session-token' },
  credits: 92,
  isLoading: false,
  refreshSessionState: vi.fn(),
}));
const getTemplateRunMock = vi.hoisted(() => vi.fn());
const getTemplateMock = vi.hoisted(() => vi.fn());

vi.mock('@/components/AuthProvider', () => ({ useAuth: () => auth }));

vi.mock('@/components/templates/api', async (importOriginal) => ({
  TemplateApiError: (await importOriginal<typeof import('@/components/templates/api')>()).TemplateApiError,
  approveTemplateRunStep: vi.fn(),
  cancelTemplateRun: vi.fn(),
  createClientIdempotencyKey: vi.fn(() => 'idempotency-key'),
  finalizeTemplateInputs: vi.fn(),
  getTemplate: getTemplateMock,
  getTemplateRun: getTemplateRunMock,
  retryTemplateRunStep: vi.fn(),
  signTemplateInput: vi.fn(),
  startTemplateRun: vi.fn(),
}));

type LinkedPost = { id: string; visibility: 'public' | 'unlisted' | 'private' } | null;

function createRun(overrides: { linkedPost?: LinkedPost; url?: string } = {}) {
  return {
    id: 'run-1',
    templateId: 'template-1',
    templateTitle: 'Rider transformation',
    userId: 'user-1',
    status: 'succeeded',
    inputSlots: [],
    inputs: {},
    steps: [],
    result: {
      kind: 'image',
      url: overrides.url ?? 'https://cdn.example.com/result.jpg',
      generationId: 'template-result-1',
      linkedPost: overrides.linkedPost ?? null,
    },
    estimatedTotalCredits: 8,
    estimatedRemainingCredits: 0,
    creditsUsed: 8,
    errorMessage: null,
    isTest: testState.isTest,
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:01:00.000Z',
  };
}

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A Storage address signed the way Supabase signs one; `exp` is in seconds. */
function signedUrl(path: string, expiresInMs: number, nonce: string): string {
  const token = [
    base64Url({ alg: 'HS256', typ: 'JWT' }),
    base64Url({ url: path, exp: Math.floor((Date.now() + expiresInMs) / 1000), nonce }),
    'signature',
  ].join('.');
  return `https://project.supabase.co/storage/v1/object/sign/${path}?token=${token}`;
}

/** A link's address, read as the composer reads it. */
function readComposerLink(name: string): { pathname: string; params: Record<string, string> } {
  const url = new URL(screen.getByRole('link', { name }).getAttribute('href') ?? '', 'https://magicbooklet.test');
  return { pathname: url.pathname, params: Object.fromEntries(url.searchParams) };
}

/** Whether the page kept the browser from following the link. Stops jsdom from navigating either way. */
function clickAndReadDefault(element: HTMLElement): boolean {
  let prevented = false;
  const observe = (event: Event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener('click', observe);
  fireEvent.click(element);
  document.removeEventListener('click', observe);
  return prevented;
}

describe('template run publish actions', () => {
  const originalShare = navigator.share;

  beforeEach(() => {
    testState.isTest = false;
    auth.refreshSessionState.mockClear();
    getTemplateRunMock.mockReset();
    getTemplateRunMock.mockImplementation(async () => createRun());
    getTemplateMock.mockResolvedValue({
      id: 'template-1',
      slug: 'rider-transformation',
      name: 'Rider transformation',
      description: 'Create a cinematic transformation.',
      category: 'Transformation',
      videoUrl: null,
      thumbnailUrl: null,
      creatorUserId: 'creator-1',
      creator: null,
      inputSlots: [],
      outputKind: 'image',
      status: 'active',
      useCount: 1,
      estimatedTotalCredits: 8,
      createdAt: '2026-07-12T00:00:00.000Z',
      updatedAt: '2026-07-12T00:00:00.000Z',
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'share', { configurable: true, value: originalShare });
    vi.restoreAllMocks();
  });

  // As the app's: publishing the result opens the full composer for it, with a Back to this
  // run, and Publish & share has the composer share the post once it is public.
  it('opens the full composer for the result, to publish it or to publish and share it', async () => {
    render(<TemplateRunClient runId="run-1" />);

    await screen.findByRole('link', { name: 'Publish to Explore' });
    expect(readComposerLink('Publish to Explore')).toEqual({
      pathname: '/post/new',
      params: { generationId: 'template-result-1', from: 'template-run', returnTo: '/template-runs/run-1' },
    });
    expect(readComposerLink('Publish & share')).toEqual({
      pathname: '/post/new',
      params: {
        generationId: 'template-result-1',
        from: 'template-run',
        returnTo: '/template-runs/run-1',
        shareAfterPublish: '1',
      },
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    ['public', 'Published to Explore'],
    ['unlisted', 'Saved as an unlisted post'],
  ] as const)('opens and shares the %s post a result already has instead of publishing it again', async (visibility, title) => {
    const share = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'share', { configurable: true, value: share });
    getTemplateRunMock.mockImplementation(async () => createRun({ linkedPost: { id: 'post-linked-1', visibility } }));
    render(<TemplateRunClient runId="run-1" />);

    expect(await screen.findByRole('link', { name: 'View post' })).toHaveAttribute('href', '/showcase/post-linked-1');
    expect(screen.getByText(title)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Publish to Explore' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Publish & share' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Share Explore post' }));
    await waitFor(() => expect(share).toHaveBeenCalledWith(expect.objectContaining({
      url: new URL('/showcase/post-linked-1', window.location.origin).toString(),
    })));
  });

  it('opens a private post a result already has in its editor, with nothing to publish or share', async () => {
    getTemplateRunMock.mockImplementation(async () => createRun({ linkedPost: { id: 'post-linked-1', visibility: 'private' } }));
    render(<TemplateRunClient runId="run-1" />);

    expect(await screen.findByRole('link', { name: 'Open private post' })).toHaveAttribute('href', '/post/post-linked-1/edit');
    expect(screen.getByText('Saved as a private post')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'View post' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share Explore post' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Publish to Explore' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Publish & share' })).not.toBeInTheDocument();
  });

  it('keeps creator test results canvas-only', async () => {
    testState.isTest = true;
    render(<TemplateRunClient runId="test-run-1" />);

    expect((await screen.findAllByRole('link', { name: 'Back to workflow canvas' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('link', { name: 'Publish to Explore' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Publish & share' })).not.toBeInTheDocument();
  });

  it('downloads the result in a new tab under the template name, and leaves a link with time left to the browser', async () => {
    const url = signedUrl('generated_images/user-1/run-1/result.png', 50 * 60_000, 'first');
    getTemplateRunMock.mockImplementation(async () => createRun({ url }));
    const open = vi.spyOn(window, 'open');
    render(<TemplateRunClient runId="run-1" />);

    const download = await screen.findByRole('link', { name: 'Download image' });
    expect(download).toHaveAttribute('href', url);
    expect(download).toHaveAttribute('target', '_blank');
    expect(download).toHaveAttribute('rel', 'noopener noreferrer');
    expect(download).toHaveAttribute('download', 'rider-transformation-image.png');

    expect(clickAndReadDefault(download)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(getTemplateRunMock).toHaveBeenCalledTimes(1);
  });

  it('reads the run again before downloading a result whose address is about to stop working', async () => {
    const expiring = signedUrl('generated_images/user-1/run-1/result.png', 2 * 60_000, 'first');
    const renewed = signedUrl('generated_images/user-1/run-1/result.png', 60 * 60_000, 'second');
    getTemplateRunMock
      .mockResolvedValueOnce(createRun({ url: expiring }))
      .mockResolvedValueOnce(createRun({ url: renewed }));
    const tab = { opener: window as unknown, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    render(<TemplateRunClient runId="run-1" />);

    const download = await screen.findByRole('link', { name: 'Download image' });
    expect(clickAndReadDefault(download)).toBe(true);
    // The tab is reserved during the click, so a popup blocker lets it open.
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();

    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith(renewed));
    expect(getTemplateRunMock).toHaveBeenCalledTimes(2);
    expect(getTemplateRunMock.mock.calls[1].slice(0, 2)).toEqual(['run-1', 'session-token']);
    expect(tab.close).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('link', { name: 'Download image' })).toHaveAttribute('href', renewed));
  });

  it('closes the reserved tab and says so when the download address cannot be renewed', async () => {
    getTemplateRunMock
      .mockResolvedValueOnce(createRun({ url: signedUrl('generated_images/user-1/run-1/result.png', 60_000, 'first') }))
      .mockRejectedValueOnce(new Error('Network request failed.'));
    const tab = { opener: window as unknown, closed: false, close: vi.fn(), location: { replace: vi.fn() } };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    render(<TemplateRunClient runId="run-1" />);

    clickAndReadDefault(await screen.findByRole('link', { name: 'Download image' }));

    expect(await screen.findByText('Could not prepare the download. Try again.')).toBeInTheDocument();
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
  });
});
