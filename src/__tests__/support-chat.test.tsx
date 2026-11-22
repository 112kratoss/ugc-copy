import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const confirmation = vi.hoisted(() => ({ answer: true }));
vi.mock('@/components/useConfirmation', () => ({
  useConfirmation: () => async () => confirmation.answer,
}));

import { SupportChat } from '@/components/support-chat/SupportChat';
import { useSupportChat, type SupportChatTransport } from '@/components/support-chat/use-support-chat';

import {
  SUPPORT_REFUSAL_WORDS,
  type SupportConversationSummary,
  type SupportMessage,
  type SupportPhoto,
} from '../../ugc-mobile/lib/support-conversation-policy/support-conversation-policy';

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

function message(overrides: Partial<SupportMessage> & Pick<SupportMessage, 'id'>): SupportMessage {
  return {
    author: 'user',
    body: 'Hello',
    createdAt: iso(60),
    editedAt: null,
    deletedAt: null,
    replyTo: null,
    reactions: [],
    attachment: null,
    ...overrides,
  };
}

const summary: SupportConversationSummary = {
  id: 'conversation-1',
  status: 'open',
  userLastReadAt: iso(30),
  staffLastReadAt: iso(55),
  userTyping: false,
  staffTyping: false,
};

const thread = [
  message({ id: 'm1', body: 'My video failed.', createdAt: iso(58), reactions: [{ author: 'staff', emoji: '👍' }] }),
  message({
    id: 'm2',
    author: 'staff',
    body: 'The credits are back. See https://magicbooklet.com/help',
    createdAt: iso(40),
    replyTo: { id: 'm1', author: 'user', body: 'My video failed.', deleted: false, hasPhoto: false },
  }),
  message({ id: 'm3', body: null, deletedAt: iso(5), createdAt: iso(10) }),
  message({ id: 'm4', body: 'Thanks!', createdAt: iso(5) }),
];

function fakeTransport(conversation: SupportConversationSummary | null = summary, messages: SupportMessage[] = thread) {
  return {
    load: vi.fn(async () => ({ kind: 'ok' as const, conversation, messages })),
    send: vi.fn(async ({ body }: { body: string; clientMessageId: string; replyToMessageId: string | null; photo: File | null }) => ({
      ok: true as const,
      value: {
        message: message({ id: 'm5', body, createdAt: new Date().toISOString() }),
        conversation: { id: 'conversation-1', status: 'open' as const },
      },
    })),
    edit: vi.fn(async (_id: string, body: string) => ({ ok: true as const, value: { message: message({ id: 'm4', body, createdAt: iso(5), editedAt: new Date().toISOString() }) } })),
    remove: vi.fn(async () => ({ ok: true as const, value: { message: message({ id: 'm4', body: null, deletedAt: new Date().toISOString(), createdAt: iso(5) }) } })),
    react: vi.fn(async (id: string, emoji: string | null) => ({
      ok: true as const,
      value: { message: { ...(thread.find((item) => item.id === id) as SupportMessage), reactions: emoji ? [{ author: 'user' as const, emoji: emoji as '👍' }] : [] } },
    })),
    markRead: vi.fn(async () => ({ ok: true as const, value: { userLastReadAt: new Date().toISOString(), staffLastReadAt: summary.staffLastReadAt } })),
    typing: vi.fn(async () => undefined),
  } satisfies SupportChatTransport;
}

function Harness({ transport }: { transport: SupportChatTransport }) {
  const chat = useSupportChat({ viewer: 'user', transport });
  return (
    <SupportChat
      chat={chat}
      viewer="user"
      title="Magicbooklet support"
      statusLine="Usually replies within a day"
      otherName="Magicbooklet support"
      privacyNote="Only you and the Magicbooklet team can read this conversation."
      emptyTitle="How can we help?"
      emptyBody="Tell us what happened."
      avatar={null}
    />
  );
}

async function renderChat(transport = fakeTransport()) {
  const view = render(<Harness transport={transport} />);
  await screen.findByText('Thanks!');
  return { ...view, transport };
}

/** The row of the message whose own text this is (a quote of it elsewhere is not its row). */
function bubbleRow(text: string | RegExp) {
  const row = screen.getAllByText(text)
    .filter((node) => !node.closest('button'))
    .map((node) => node.closest('li'))
    .find(Boolean);
  if (!row) throw new Error(`No row for ${String(text)}`);
  return row;
}

afterEach(() => {
  confirmation.answer = true;
});

describe('the support chat on the web', () => {
  it('draws the thread as a chat app does: a day, quotes, links, reactions, ticks and deleted messages', async () => {
    const { unmount } = await renderChat();

    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://magicbooklet.com/help' })).toHaveAttribute('href', 'https://magicbooklet.com/help');
    expect(screen.getByText('You deleted this message')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Magicbooklet support reacted 👍' })).toBeDisabled();
    // Support read past the first message, not the last.
    expect(within(bubbleRow('My video failed.')).getByLabelText('Read')).toBeInTheDocument();
    expect(within(bubbleRow('Thanks!')).getByLabelText('Sent')).toBeInTheDocument();
    // The reply's quote opens its message.
    expect(within(bubbleRow(/The credits are back/)).getByRole('button', { name: /You.*My video failed\./ })).toBeInTheDocument();
    unmount();
  });

  it('says "typing…" while support writes', async () => {
    const { unmount } = await renderChat(fakeTransport({ ...summary, staffTyping: true }));
    expect(screen.getByText('typing…')).toBeInTheDocument();
    unmount();
  });

  it('marks support\'s new replies read while the page is visible', async () => {
    const transport = fakeTransport({ ...summary, userLastReadAt: iso(59) });
    const { unmount } = await renderChat(transport);
    await waitFor(() => expect(transport.markRead).toHaveBeenCalledTimes(1));
    unmount();
  });

  it('sends on Enter, keeps Shift+Enter for a new line, and says typing as the text changes', async () => {
    const { transport, unmount } = await renderChat();
    const field = screen.getByLabelText('Message');

    fireEvent.change(field, { target: { value: 'One more thing' } });
    expect(transport.typing).toHaveBeenCalledWith(true);
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(transport.send).not.toHaveBeenCalled();

    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); });
    expect(transport.send).toHaveBeenCalledWith({
      body: 'One more thing',
      clientMessageId: expect.stringMatching(/^msg:/),
      replyToMessageId: null,
      photo: null,
    });
    expect(await screen.findByText('One more thing')).toBeInTheDocument();
    expect(field).toHaveValue('');
    unmount();
  });

  it('replies quoting a message', async () => {
    const { transport, unmount } = await renderChat();
    fireEvent.click(within(bubbleRow(/The credits are back/)).getByRole('button', { name: 'Reply' }));
    expect(screen.getByRole('button', { name: 'Cancel reply' })).toBeInTheDocument();

    const field = screen.getByLabelText('Message');
    fireEvent.change(field, { target: { value: 'Which video?' } });
    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); });
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ replyToMessageId: 'm2' }));
    unmount();
  });

  it('offers Edit and Delete only on one\'s own messages, within their windows', async () => {
    const { unmount } = await renderChat();

    fireEvent.click(within(bubbleRow('Thanks!')).getByRole('button', { name: 'Message actions' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Reply', 'React', 'Copy', 'Edit', 'Delete']);
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(within(bubbleRow('My video failed.')).getByRole('button', { name: 'Message actions' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Reply', 'React', 'Copy', 'Delete']);
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(within(bubbleRow(/The credits are back/)).getByRole('button', { name: 'Message actions' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Reply', 'React', 'Copy']);
    unmount();
  });

  it('edits a message and deletes one after the confirmation', async () => {
    const { transport, unmount } = await renderChat();

    fireEvent.click(within(bubbleRow('Thanks!')).getByRole('button', { name: 'Message actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit' }));
    const field = screen.getByLabelText('Message');
    expect(field).toHaveValue('Thanks!');
    fireEvent.change(field, { target: { value: 'Thanks a lot!' } });
    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); });
    expect(transport.edit).toHaveBeenCalledWith('m4', 'Thanks a lot!');
    expect(await screen.findByText('Edited')).toBeInTheDocument();

    fireEvent.click(within(bubbleRow('Thanks a lot!')).getByRole('button', { name: 'Message actions' }));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' })); });
    expect(transport.remove).toHaveBeenCalledWith('m4');
    unmount();
  });

  it('reacts from the reaction bar, drawn at once', async () => {
    const { transport, unmount } = await renderChat();
    fireEvent.click(within(bubbleRow(/The credits are back/)).getByRole('button', { name: 'React' }));
    await act(async () => { fireEvent.click(screen.getByRole('menuitemradio', { name: 'React 🙏' })); });
    expect(transport.react).toHaveBeenCalledWith('m2', '🙏');
    expect(screen.getByRole('button', { name: 'Your reaction 🙏. Remove it' })).toBeInTheDocument();
    unmount();
  });
});

describe('photos in the web chat', () => {
  const photo: SupportPhoto = {
    kind: 'image',
    previewUrl: 'https://storage.example/p1.preview.webp?token=a',
    url: 'https://storage.example/p1.webp?token=a',
    width: 1080,
    height: 1920,
    thumbhash: null,
    expiresAt: new Date(NOW + 3 * 3_600_000).toISOString(),
  };
  const withPhoto = [...thread, message({ id: 'p1', author: 'staff', body: 'Here is where they show', createdAt: iso(2), attachment: photo })];

  beforeEach(() => {
    // jsdom has no object URLs: a picked file is drawn from a stand-in.
    URL.createObjectURL = vi.fn(() => 'blob:picked-1');
    URL.revokeObjectURL = vi.fn();
  });

  it('draws a photo from its preview with its caption, and opens the picture full screen', async () => {
    const { unmount } = await renderChat(fakeTransport(summary, withPhoto));
    const row = bubbleRow('Here is where they show');
    const opener = within(row).getByRole('button', { name: 'Open photo' });
    expect(within(opener).getByRole('img', { name: 'Photo' })).toHaveAttribute('src', photo.previewUrl);
    // A tall picture is cut to the thread's height.
    expect(opener).toHaveStyle({ width: '288px', height: '360px' });

    fireEvent.click(opener);
    const viewer = await screen.findByRole('dialog', { name: 'Photo' });
    expect(within(viewer).getByRole('img', { name: 'Photo' })).toHaveAttribute('src', photo.url);
    fireEvent.click(within(viewer).getByRole('button', { name: 'Close photo' }));
    expect(screen.queryByRole('dialog', { name: 'Photo' })).not.toBeInTheDocument();
    unmount();
  });

  it('says a photo could not be loaded where its link was not signed', async () => {
    const unsigned = [...thread, message({ id: 'p2', author: 'staff', body: null, createdAt: iso(2), attachment: { ...photo, previewUrl: null, url: null } })];
    const { unmount } = await renderChat(fakeTransport(summary, unsigned));
    expect(screen.getByText('The photo could not be loaded.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open photo' })).not.toBeInTheDocument();
    unmount();
  });

  it('attaches a picked photo, which goes with the text as its caption, or none', async () => {
    const { transport, unmount } = await renderChat();
    const file = new File([new Uint8Array([1, 2, 3])], 'screenshot.png', { type: 'image/png' });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp,image/gif');

    fireEvent.change(input, { target: { files: [file] } });
    expect(screen.getByText('screenshot.png')).toBeInTheDocument();
    const field = screen.getByLabelText('Message');
    expect(field).toHaveAttribute('placeholder', 'Add a caption');

    await act(async () => { fireEvent.keyDown(field, { key: 'Enter' }); });
    expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ body: '', photo: file }));
    // The bar is gone with the send; the picture is drawn from the device until the server's comes.
    expect(screen.queryByRole('button', { name: 'Remove photo' })).not.toBeInTheDocument();
    unmount();
  });

  it('refuses a picture the server cannot read, before anything is sent', async () => {
    const { transport, unmount } = await renderChat();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'IMG_0001.HEIC', { type: 'image/heic' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent(SUPPORT_REFUSAL_WORDS.PHOTO_UNREADABLE);
    expect(screen.queryByRole('button', { name: 'Remove photo' })).not.toBeInTheDocument();
    expect(transport.send).not.toHaveBeenCalled();
    unmount();
  });

  it('takes a pasted screenshot as the photo, and Escape takes it away', async () => {
    const { unmount } = await renderChat();
    const field = screen.getByLabelText('Message');
    const file = new File([new Uint8Array([4, 5])], 'image.png', { type: 'image/png' });
    fireEvent.paste(field, { clipboardData: { files: [file] } });
    expect(screen.getByRole('button', { name: 'Remove photo' })).toBeInTheDocument();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Remove photo' })).not.toBeInTheDocument();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:picked-1');
    unmount();
  });
});
