import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/components/useConfirmation', () => ({ useConfirmation: () => async () => true }));
// The transports stage the account's photos with the upload client, which builds the browser's Supabase client when it loads.
vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { AdminSupportThread } from '@/app/admin/(console)/support/AdminSupportThread';

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const message = (id: string, author: 'user' | 'staff', body: string, createdAt: string) => ({
  id,
  author,
  clientMessageId: null,
  body,
  createdAt,
  editedAt: null,
  deletedAt: null,
  replyTo: null,
  reactions: [],
  attachment: null,
});

/** The console's API as the thread asks it: the thread, then its actions. */
function consoleApi(thread: () => Response) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') return thread();
    const body = JSON.parse(String(init.body)) as { action?: string };
    if (body.action === 'read') return json({ success: true, userLastReadAt: null, staffLastReadAt: new Date().toISOString() });
    return json({ success: true });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const posted = (fetchMock: ReturnType<typeof consoleApi>, action: string) => fetchMock.mock.calls
  .map(([, init]) => (init?.method === 'POST' ? JSON.parse(String(init.body)) as Record<string, unknown> : null))
  .filter((body): body is Record<string, unknown> => body?.action === action);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the console\'s support thread', () => {
  it('holds a resolve to the account\'s latest message it showed', async () => {
    const latestQuestion = iso(3);
    const fetchMock = consoleApi(() => json({
      success: true,
      conversation: { id: 'conversation-1', status: 'open', userLastReadAt: iso(10), staffLastReadAt: iso(1), userTyping: false, staffTyping: false },
      messages: [
        message('m1', 'user', 'My credits did not come back.', iso(20)),
        message('m2', 'staff', 'Looking now.', iso(15)),
        message('m3', 'user', 'Any news?', latestQuestion),
        message('m4', 'staff', 'They are back.', iso(2)),
      ],
    }));
    render(<AdminSupportThread conversationId="conversation-1" accountName="Asha Rao" accountHandle="asha" userId="account-1" />);
    await screen.findByText('Any news?');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Mark resolved/ })); });

    // The exact time the server answered, so the server can compare it with its own.
    expect(posted(fetchMock, 'resolve')).toEqual([{ action: 'resolve', conversationId: 'conversation-1', seenLastUserMessageAt: latestQuestion }]);
  });

  it('says an ended session is ended, above the chat, and reads again on Try again', async () => {
    let signedIn = false;
    const fetchMock = consoleApi(() => (signedIn
      ? json({
        success: true,
        conversation: { id: 'conversation-1', status: 'open', userLastReadAt: null, staffLastReadAt: iso(1), userTyping: false, staffTyping: false },
        messages: [message('m1', 'user', 'Hello?', iso(5))],
      })
      : json({ error: 'Unauthorized' }, 401)));
    render(<AdminSupportThread conversationId="conversation-1" accountName="Asha Rao" accountHandle="asha" userId="account-1" />);

    expect(await screen.findByText('Your console session has ended')).toBeInTheDocument();
    // Never drawn as an empty conversation a reply could be lost in.
    expect(screen.queryByText('This conversation has no messages yet.')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/admin/login');

    signedIn = true;
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Try again/ })); });
    await waitFor(() => expect(screen.getByText('Hello?')).toBeInTheDocument());
    expect(screen.queryByText('Your console session has ended')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === 'GET').length).toBeGreaterThanOrEqual(2);
  });

  it('says a thread that could not be loaded was not loaded', async () => {
    consoleApi(() => json({ error: 'The conversation could not be loaded. Try again.' }, 500));
    render(<AdminSupportThread conversationId="conversation-1" accountName="Asha Rao" accountHandle={null} userId="account-1" />);
    expect(await screen.findByText('This conversation could not be loaded')).toBeInTheDocument();
    expect(screen.queryByText('This conversation has no messages yet.')).not.toBeInTheDocument();
  });
});
