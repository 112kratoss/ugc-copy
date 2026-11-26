import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ConfirmationRequest } from '@/components/feedback-state';

const confirmMock = vi.hoisted(() => vi.fn<(request: ConfirmationRequest) => Promise<boolean>>(async () => true));
vi.mock('@/components/useConfirmation', () => ({ useConfirmation: () => confirmMock }));

import { AdminUpdatesConsole } from '@/app/admin/(console)/updates/AdminUpdatesConsole';

const LIVE = '10000000-0000-4000-8000-000000000001';
const DOWN = '10000000-0000-4000-8000-000000000002';
const FLAGGED = '10000000-0000-4000-8000-000000000003';
const QUIET = '10000000-0000-4000-8000-000000000004';
const BUILDING = '20000000-0000-4000-8000-000000000001';
const SHIPPED = '20000000-0000-4000-8000-000000000002';
const ARCHIVED = '20000000-0000-4000-8000-000000000003';

/** `GET /api/admin/support-hub` as the server answers it. */
function hub(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    officialAccountReady: true,
    updates: [
      {
        id: LIVE,
        kind: 'shipped',
        title: 'Remix any post',
        body: 'Open a post and press Remix.',
        createdAt: '2026-11-25T10:00:00.000Z',
        published: true,
        hiddenByReview: false,
        commentCount: 4,
        commentsLocked: false,
        reactionPeople: 9,
        broadcast: { push: false, sentCount: 120, finished: false },
      },
      {
        id: DOWN,
        kind: 'announcement',
        title: 'Old news',
        body: 'This went out by mistake.',
        createdAt: '2026-11-20T10:00:00.000Z',
        published: false,
        hiddenByReview: false,
        commentCount: 1,
        commentsLocked: false,
        reactionPeople: 1,
        broadcast: null,
      },
      {
        id: FLAGGED,
        kind: 'announcement',
        title: 'Reported note',
        body: 'Something people reported.',
        createdAt: '2026-11-18T10:00:00.000Z',
        published: true,
        hiddenByReview: true,
        commentCount: 0,
        commentsLocked: true,
        reactionPeople: 0,
        broadcast: { push: true, sentCount: 5000, finished: true },
      },
      {
        id: QUIET,
        kind: 'announcement',
        title: 'Quiet note',
        body: 'Published without an alert.',
        createdAt: '2026-11-15T10:00:00.000Z',
        published: true,
        hiddenByReview: false,
        commentCount: 2,
        commentsLocked: false,
        reactionPeople: 3,
        broadcast: null,
      },
    ],
    roadmap: [
      { id: BUILDING, title: 'Folders for creations', summary: 'Group your work.', status: 'building', position: 0, shippedAt: null, shippedUpdateId: null, archived: false, people: 3 },
      { id: SHIPPED, title: 'Remix', summary: '', status: 'shipped', position: 1, shippedAt: '2026-11-25T11:00:00.000Z', shippedUpdateId: LIVE, archived: false, people: 12 },
      { id: ARCHIVED, title: 'Dark mode on the web', summary: '', status: 'exploring', position: 2, shippedAt: null, shippedUpdateId: null, archived: true, people: 0 },
    ],
    ...overrides,
  };
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** The console's API as the page asks it: everything with a GET, each action with a POST. */
function consoleApi({
  read = () => json(hub()),
  answer = () => json({ success: true }),
}: {
  read?: () => Response;
  answer?: (body: Record<string, unknown>) => Response;
} = {}) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') return read();
    return answer(JSON.parse(String(init.body)) as Record<string, unknown>);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

type ConsoleFetch = ReturnType<typeof consoleApi>;

const posted = (fetchMock: ConsoleFetch) => fetchMock.mock.calls
  .filter(([, init]) => init?.method === 'POST')
  .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);

const readCount = (fetchMock: ConsoleFetch) => fetchMock.mock.calls
  .filter(([, init]) => !init?.method || init.method === 'GET')
  .length;

async function updateRow(title: string) {
  const list = await screen.findByRole('list', { name: 'All updates' });
  return within(list).getByRole('heading', { name: title }).closest('li') as HTMLElement;
}

async function roadmapRow(title: string) {
  const list = await screen.findByRole('list', { name: 'Roadmap' });
  return within(list).getByRole('heading', { name: title }).closest('li') as HTMLElement;
}

const press = (button: HTMLElement) => act(async () => {
  fireEvent.click(button);
});

beforeEach(() => {
  confirmMock.mockReset();
  confirmMock.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the console’s Updates and Roadmap', () => {
  // field-hand-over-before-hydration.test.ts lets the console's fields go without a hand-over
  // because of this: text typed before the page's script ran has no field in the server's HTML
  // to go into, so hydration has none to drop.
  it('draws no field in the server’s HTML: every one waits for the client’s read', () => {
    const fetchMock = consoleApi();

    const html = renderToString(<AdminUpdatesConsole />);

    expect(html).toContain('Loading updates and the roadmap');
    expect(html).not.toMatch(/<(input|textarea|select)\b/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('draws every update and the roadmap in its order, each with what it holds', async () => {
    consoleApi();
    render(<AdminUpdatesConsole />);

    const live = await updateRow('Remix any post');
    expect(live).toHaveTextContent('New');
    expect(live).toHaveTextContent('Live');
    expect(live).toHaveTextContent('4 comments');
    expect(live).toHaveTextContent('9 people reacted');
    expect(live).toHaveTextContent('Alert sent to 120 accounts so far, not finished');
    expect(within(live).getByRole('button', { name: 'Continue sending' })).toBeEnabled();
    expect(within(live).getByRole('link', { name: 'Open post' })).toHaveAttribute('href', `/showcase/${LIVE}`);

    const down = await updateRow('Old news');
    expect(down).toHaveTextContent('Announcement');
    expect(down).toHaveTextContent('Taken down');
    expect(down).toHaveTextContent('Quiet: no alert went out');
    expect(within(down).getByRole('button', { name: 'Put back up' })).toBeInTheDocument();
    // A taken-down update has no public page to open.
    expect(within(down).queryByRole('link', { name: 'Open post' })).not.toBeInTheDocument();

    const flagged = await updateRow('Reported note');
    expect(flagged).toHaveTextContent('Hidden by review');
    expect(flagged).toHaveTextContent('Comments off');
    expect(flagged).toHaveTextContent('Alert + push sent to 5,000 accounts, finished');
    expect(within(flagged).getByRole('button', { name: 'Turn comments on' })).toBeInTheDocument();
    expect(within(flagged).queryByRole('button', { name: 'Continue sending' })).not.toBeInTheDocument();
    expect(within(flagged).queryByRole('link', { name: 'Open post' })).not.toBeInTheDocument();

    // Only a live update published quietly can still be announced.
    const quiet = await updateRow('Quiet note');
    expect(quiet).toHaveTextContent('Quiet: no alert went out');
    expect(within(quiet).getByRole('button', { name: 'Announce…' })).toBeEnabled();
    for (const announced of [live, down, flagged]) {
      expect(within(announced).queryByRole('button', { name: 'Announce…' })).not.toBeInTheDocument();
    }

    const roadmap = screen.getByRole('list', { name: 'Roadmap' });
    expect(within(roadmap).getAllByRole('heading').map((heading) => heading.textContent))
      .toEqual(['Folders for creations', 'Remix', 'Dark mode on the web']);

    const building = await roadmapRow('Folders for creations');
    expect(building).toHaveTextContent('Building');
    expect(building).toHaveTextContent('3 people want this');
    expect(within(building).getByRole('button', { name: 'Move up' })).toBeDisabled();
    expect(within(building).getByRole('button', { name: 'Mark shipped' })).toBeEnabled();

    const shipped = await roadmapRow('Remix');
    expect(shipped).toHaveTextContent('Shipped 25 Nov 2026');
    expect(within(shipped).getByRole('link', { name: 'Read “Remix any post”' })).toHaveAttribute('href', `/showcase/${LIVE}`);
    // A shipped item keeps its words, and ships once.
    expect(within(shipped).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(shipped).queryByRole('button', { name: 'Mark shipped' })).not.toBeInTheDocument();

    const archived = await roadmapRow('Dark mode on the web');
    expect(archived).toHaveTextContent('Archived');
    expect(archived).toHaveTextContent('No votes yet');
    expect(within(archived).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
    expect(within(archived).getByRole('button', { name: 'Move down' })).toBeDisabled();
    // The server will not ship an archived item.
    expect(within(archived).queryByRole('button', { name: 'Mark shipped' })).not.toBeInTheDocument();
  });

  it('keeps publishing off while no account holds the @magicbooklet handle', async () => {
    const fetchMock = consoleApi({ read: () => json(hub({ officialAccountReady: false })) });
    render(<AdminUpdatesConsole />);

    const composer = await screen.findByRole('region', { name: 'Post an update' });
    expect(within(composer).getByText('No account holds the @magicbooklet handle')).toBeInTheDocument();
    fireEvent.change(within(composer).getByLabelText('Title'), { target: { value: 'Hello' } });
    fireEvent.change(within(composer).getByLabelText('Body'), { target: { value: 'Everyone.' } });

    const publish = within(composer).getByRole('button', { name: 'Publish' });
    expect(publish).toBeDisabled();
    await press(publish);
    expect(posted(fetchMock)).toEqual([]);
  });

  it('publishes with the kind, words, comments and audience chosen, then reads the page again', async () => {
    const fetchMock = consoleApi({ answer: () => json({ success: true, postId: LIVE, announced: true }) });
    render(<AdminUpdatesConsole />);

    const composer = await screen.findByRole('region', { name: 'Post an update' });
    expect(within(composer).getByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(within(composer).getByRole('radio', { name: 'Quiet' })).toBeChecked();
    expect(within(composer).getByRole('checkbox', { name: 'Comments on' })).toBeChecked();

    fireEvent.change(within(composer).getByLabelText('Kind'), { target: { value: 'shipped' } });
    fireEvent.change(within(composer).getByLabelText('Title'), { target: { value: '  Folders are here ' } });
    fireEvent.change(within(composer).getByLabelText('Body'), {
      target: { value: 'Group your creations into folders.\nOpen Studio to start.' },
    });
    fireEvent.click(within(composer).getByRole('checkbox', { name: 'Comments on' }));
    fireEvent.click(within(composer).getByRole('radio', { name: 'Alert' }));
    await press(within(composer).getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(posted(fetchMock)).toEqual([{
      action: 'publish',
      kind: 'shipped',
      title: 'Folders are here',
      body: 'Group your creations into folders.\nOpen Studio to start.',
      commentsLocked: true,
      announce: 'alert',
    }]));
    // Only a push asks first.
    expect(confirmMock).not.toHaveBeenCalled();
    expect(await within(composer).findByText('Published. The alert is going out to every account.')).toBeInTheDocument();
    expect(readCount(fetchMock)).toBe(2);
    // Ready for the next one, back on the quiet choice.
    expect(within(composer).getByLabelText('Title')).toHaveValue('');
    expect(within(composer).getByRole('radio', { name: 'Quiet' })).toBeChecked();
    expect(within(composer).getByRole('checkbox', { name: 'Comments on' })).toBeChecked();
  });

  it('asks before an Alert + push, and sends nothing on a no', async () => {
    const fetchMock = consoleApi();
    confirmMock.mockResolvedValueOnce(false);
    render(<AdminUpdatesConsole />);

    const composer = await screen.findByRole('region', { name: 'Post an update' });
    fireEvent.change(within(composer).getByLabelText('Title'), { target: { value: 'Big news' } });
    fireEvent.change(within(composer).getByLabelText('Body'), { target: { value: 'Something big.' } });
    fireEvent.click(within(composer).getByRole('radio', { name: 'Alert + push' }));

    await press(within(composer).getByRole('button', { name: 'Publish' }));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0]).toMatchObject({
      title: 'Send a push to every phone?',
      confirmLabel: 'Publish and push',
      tone: 'danger',
    });
    expect(posted(fetchMock)).toEqual([]);
    expect(within(composer).getByLabelText('Title')).toHaveValue('Big news');

    await press(within(composer).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(posted(fetchMock)).toEqual([{
      action: 'publish',
      kind: 'announcement',
      title: 'Big news',
      body: 'Something big.',
      commentsLocked: false,
      announce: 'alert_push',
    }]));
    expect(confirmMock).toHaveBeenCalledTimes(2);
  });

  it('announces a quietly published update with an alert, then reads the page again', async () => {
    const fetchMock = consoleApi({ answer: () => json({ success: true, postId: QUIET }) });
    render(<AdminUpdatesConsole />);

    const quiet = await updateRow('Quiet note');
    fireEvent.click(within(quiet).getByRole('button', { name: 'Announce…' }));

    // Quiet is what it already had: the choices are the two that tell people.
    const alert = within(quiet).getByRole('radio', { name: 'Alert' });
    expect(alert).toBeChecked();
    expect(alert).toHaveFocus();
    expect(within(quiet).getByRole('radio', { name: 'Alert + push' })).not.toBeChecked();
    expect(within(quiet).queryByRole('radio', { name: 'Quiet' })).not.toBeInTheDocument();

    await press(within(quiet).getByRole('button', { name: 'Announce' }));

    await waitFor(() => expect(posted(fetchMock)).toEqual([{ action: 'announce', postId: QUIET, push: false }]));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(await within(quiet).findByText('Announced. The alert is going out to every account.')).toBeInTheDocument();
    expect(readCount(fetchMock)).toBe(2);
  });

  it('asks before announcing with a push, and sends nothing on a no', async () => {
    const fetchMock = consoleApi();
    confirmMock.mockResolvedValueOnce(false);
    render(<AdminUpdatesConsole />);

    const quiet = await updateRow('Quiet note');
    fireEvent.click(within(quiet).getByRole('button', { name: 'Announce…' }));
    fireEvent.click(within(quiet).getByRole('radio', { name: 'Alert + push' }));

    await press(within(quiet).getByRole('button', { name: 'Announce' }));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0]).toMatchObject({
      title: 'Send a push to every phone?',
      message: expect.stringContaining('“Quiet note”'),
      confirmLabel: 'Announce and push',
      tone: 'danger',
    });
    expect(posted(fetchMock)).toEqual([]);

    await press(within(quiet).getByRole('button', { name: 'Announce' }));
    await waitFor(() => expect(posted(fetchMock)).toEqual([{ action: 'announce', postId: QUIET, push: true }]));
    expect(await within(quiet).findByText('Announced. The alert and the push are going out to every account.')).toBeInTheDocument();
  });

  it('says why an announcement was refused, reads the page again, and closes on Cancel', async () => {
    const refusal = 'That update was already announced. Use Continue sending if it stopped short.';
    const fetchMock = consoleApi({ answer: () => json({ error: refusal }, 409) });
    render(<AdminUpdatesConsole />);

    const quiet = await updateRow('Quiet note');
    fireEvent.click(within(quiet).getByRole('button', { name: 'Announce…' }));
    await press(within(quiet).getByRole('button', { name: 'Announce' }));

    expect(await within(quiet).findByRole('alert')).toHaveTextContent(refusal);
    await waitFor(() => expect(readCount(fetchMock)).toBe(2));

    fireEvent.click(within(quiet).getByRole('button', { name: 'Cancel' }));
    expect(within(quiet).queryByRole('radio', { name: 'Alert' })).not.toBeInTheDocument();
    expect(within(quiet).getByRole('button', { name: 'Announce…' })).toHaveFocus();
  });

  it('ships a roadmap item only with a published update, after saying who is told', async () => {
    const fetchMock = consoleApi({
      answer: (body) => json(body.action === 'roadmapShip' ? { success: true, told: 3 } : { success: true }),
    });
    render(<AdminUpdatesConsole />);

    const building = await roadmapRow('Folders for creations');
    fireEvent.click(within(building).getByRole('button', { name: 'Mark shipped' }));

    const select = within(building).getByLabelText('The update that announced it');
    expect(select).toHaveFocus();
    // Taken-down and hidden updates have no page to send people to.
    expect(within(select).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['', LIVE, QUIET]);

    const markShipped = within(building).getByRole('button', { name: 'Mark shipped' });
    expect(markShipped).toBeDisabled();
    await press(markShipped);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(posted(fetchMock)).toEqual([]);

    fireEvent.change(select, { target: { value: LIVE } });
    expect(markShipped).toBeEnabled();
    await press(markShipped);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0]).toMatchObject({
      title: 'Mark “Folders for creations” shipped?',
      confirmLabel: 'Mark shipped',
      message: expect.stringContaining('Everyone who reacted (3 people) gets a “You asked, it’s live” alert that opens “Remix any post”.'),
    });
    await waitFor(() => expect(posted(fetchMock)).toEqual([{ action: 'roadmapShip', itemId: BUILDING, updatePostId: LIVE }]));
    expect(await within(building).findByText('Marked shipped. 3 people were told it’s live.')).toBeInTheDocument();
  });

  it('does not ship when the answer is no', async () => {
    const fetchMock = consoleApi();
    confirmMock.mockResolvedValueOnce(false);
    render(<AdminUpdatesConsole />);

    const building = await roadmapRow('Folders for creations');
    fireEvent.click(within(building).getByRole('button', { name: 'Mark shipped' }));
    fireEvent.change(within(building).getByLabelText('The update that announced it'), { target: { value: LIVE } });
    await press(within(building).getByRole('button', { name: 'Mark shipped' }));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(posted(fetchMock)).toEqual([]);

    // Cancel closes the panel and gives the focus back to the button that opened it.
    fireEvent.click(within(building).getByRole('button', { name: 'Cancel' }));
    expect(within(building).queryByLabelText('The update that announced it')).not.toBeInTheDocument();
    expect(within(building).getByRole('button', { name: 'Mark shipped' })).toHaveFocus();
  });

  it('says the server’s refusal where it was asked, and reads the page again', async () => {
    const fetchMock = consoleApi({ answer: () => json({ error: 'The update could not be changed. Is it still public?' }, 409) });
    render(<AdminUpdatesConsole />);

    const live = await updateRow('Remix any post');
    await press(within(live).getByRole('button', { name: 'Turn comments off' }));

    expect(await within(live).findByRole('alert')).toHaveTextContent('The update could not be changed. Is it still public?');
    await waitFor(() => expect(readCount(fetchMock)).toBe(2));
  });

  it.each([
    { row: () => updateRow('Remix any post'), name: 'Turn comments off', sent: { action: 'lock', postId: LIVE, locked: true } },
    { row: () => updateRow('Reported note'), name: 'Turn comments on', sent: { action: 'lock', postId: FLAGGED, locked: false } },
    { row: () => updateRow('Remix any post'), name: 'Take down', sent: { action: 'publishState', postId: LIVE, published: false } },
    { row: () => updateRow('Old news'), name: 'Put back up', sent: { action: 'publishState', postId: DOWN, published: true } },
    { row: () => updateRow('Remix any post'), name: 'Continue sending', sent: { action: 'continueBroadcast', postId: LIVE } },
    { row: () => roadmapRow('Folders for creations'), name: 'Move down', sent: { action: 'roadmapMove', itemId: BUILDING, direction: 'down' } },
    { row: () => roadmapRow('Remix'), name: 'Move up', sent: { action: 'roadmapMove', itemId: SHIPPED, direction: 'up' } },
    { row: () => roadmapRow('Folders for creations'), name: 'Archive', sent: { action: 'roadmapArchive', itemId: BUILDING, archived: true } },
    { row: () => roadmapRow('Dark mode on the web'), name: 'Restore', sent: { action: 'roadmapArchive', itemId: ARCHIVED, archived: false } },
  ])('$name sends its own row’s id, then reads the page again', async ({ row, name, sent }) => {
    const fetchMock = consoleApi();
    render(<AdminUpdatesConsole />);

    await press(within(await row()).getByRole('button', { name }));

    await waitFor(() => expect(posted(fetchMock)).toEqual([sent]));
    await waitFor(() => expect(readCount(fetchMock)).toBe(2));
  });

  it('rewords an update in place', async () => {
    const fetchMock = consoleApi();
    render(<AdminUpdatesConsole />);

    const live = await updateRow('Remix any post');
    fireEvent.click(within(live).getByRole('button', { name: 'Edit' }));
    const title = within(live).getByLabelText('Title');
    // The form takes the button's place, so the focus goes into it.
    expect(title).toHaveFocus();
    expect(title).toHaveValue('Remix any post');
    expect(within(live).getByLabelText('Body')).toHaveValue('Open a post and press Remix.');

    fireEvent.change(title, { target: { value: 'Remix any public post' } });
    await press(within(live).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(posted(fetchMock)).toEqual([
      { action: 'edit', postId: LIVE, title: 'Remix any public post', body: 'Open a post and press Remix.' },
    ]));
    await waitFor(() => expect(within(live).queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument());
    // And back to Edit once it closes.
    expect(within(live).getByRole('button', { name: 'Edit' })).toHaveFocus();
  });

  it('rewords a roadmap item and moves it between Exploring and Building', async () => {
    const fetchMock = consoleApi();
    render(<AdminUpdatesConsole />);

    const building = await roadmapRow('Folders for creations');
    fireEvent.click(within(building).getByRole('button', { name: 'Edit' }));
    const status = within(building).getByLabelText('Status');
    expect(within(status).getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual(['exploring', 'building']);
    expect(status).toHaveValue('building');

    fireEvent.change(within(building).getByLabelText('One line (optional)'), { target: { value: 'Group your work into folders.' } });
    fireEvent.change(status, { target: { value: 'exploring' } });
    await press(within(building).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(posted(fetchMock)).toEqual([{
      action: 'roadmapUpdate',
      itemId: BUILDING,
      title: 'Folders for creations',
      summary: 'Group your work into folders.',
      status: 'exploring',
    }]));
  });

  it('adds a roadmap item with its title, line and status', async () => {
    const fetchMock = consoleApi({ answer: () => json({ success: true, itemId: '20000000-0000-4000-8000-000000000004' }) });
    render(<AdminUpdatesConsole />);

    const form = await screen.findByRole('region', { name: 'Add an item' });
    const add = within(form).getByRole('button', { name: 'Add to roadmap' });
    expect(add).toBeDisabled();

    fireEvent.change(within(form).getByLabelText('Status'), { target: { value: 'building' } });
    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: ' Collections ' } });
    fireEvent.change(within(form).getByLabelText('One line (optional)'), { target: { value: 'Save posts into named lists.' } });
    await press(add);

    await waitFor(() => expect(posted(fetchMock)).toEqual([
      { action: 'roadmapCreate', title: 'Collections', summary: 'Save posts into named lists.', status: 'building' },
    ]));
    expect(await within(form).findByText('Added to the end of the roadmap.')).toBeInTheDocument();
    expect(within(form).getByLabelText('Title')).toHaveValue('');
  });

  it('says an ended session is ended, and reads again on Try again', async () => {
    let signedIn = false;
    consoleApi({ read: () => (signedIn ? json(hub()) : json({ error: 'Unauthorized' }, 401)) });
    render(<AdminUpdatesConsole />);

    expect(await screen.findByText('Your console session has ended')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/admin/login');
    expect(screen.queryByRole('region', { name: 'Post an update' })).not.toBeInTheDocument();

    signedIn = true;
    await press(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Post an update' })).toBeInTheDocument();
    expect(screen.queryByText('Your console session has ended')).not.toBeInTheDocument();
  });
});
