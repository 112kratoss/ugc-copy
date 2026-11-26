// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const routerState = vi.hoisted(() => ({ push: vi.fn() }));
const openUrl = vi.hoisted(() => vi.fn());
const appVersion = vi.hoisted(() => ({
  label: null as string | null,
  runtime: { runtimeVersion: null as string | null, channel: null as string | null },
}));
const actionSheet = vi.hoisted(() => ({ show: vi.fn() }));
const confirmDialog = vi.hoisted(() => ({ show: vi.fn(async () => true) }));
const clipboard = vi.hoisted(() => ({ copy: vi.fn(async () => undefined) }));
const picker = vi.hoisted(() => ({ launch: vi.fn() }));
const upload = vi.hoisted(() => ({ picked: vi.fn() }));
// The documents-folder copy a picked photo waits in (`lib/support-photo-file.ts`, tested on its own),
// over a set of the copies that exist, so a copy let go too early fails the send that needed it.
const photoFiles = vi.hoisted(() => {
  const live = new Set<string>();
  const isCopy = (uri: string | null | undefined) => typeof uri === 'string' && uri.startsWith('file:///documents/support-photos/');
  return {
    live,
    isCopy,
    keep: vi.fn(async (_uri: string, name: string) => {
      const copy = `file:///documents/support-photos/${name}`;
      live.add(copy);
      return copy;
    }),
    letGo: vi.fn(async (uri: string | null | undefined) => {
      if (isCopy(uri)) live.delete(uri as string);
    }),
    isThere: vi.fn(async (uri: string) => !isCopy(uri) || live.has(uri)),
    sweep: vi.fn(async () => undefined),
  };
});
const authState = vi.hoisted(() => ({
  api: {
    getSupportConversation: vi.fn(),
    sendSupportMessage: vi.fn(),
    markSupportConversationRead: vi.fn(async () => ({ success: true, userLastReadAt: '2026-11-21T10:05:00.000Z', staffLastReadAt: null })),
    setSupportTyping: vi.fn(async () => ({ success: true })),
    editSupportMessage: vi.fn(),
    deleteSupportMessage: vi.fn(),
    reactToSupportMessage: vi.fn(),
  },
  user: { id: 'account-1' } as { id: string } | null,
}));
const query = vi.hoisted(() => ({
  data: undefined as unknown,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));
// What the chat asked of its query on each render: whether it reads the thread again, and how often.
const queryOptions = vi.hoisted(() => [] as Array<{ queryKey: readonly unknown[]; refetchInterval?: unknown }>);
const queryClient = vi.hoisted(() => ({
  setQueryData: vi.fn(),
  getQueryState: vi.fn(() => undefined),
  invalidateQueries: vi.fn(async () => undefined),
  cancelQueries: vi.fn(async () => undefined),
}));
// The route's `tab`, and the unread dot's answer (`lib/support-updates-seen.ts`, tested on its own).
const route = vi.hoisted(() => ({ params: {} as Record<string, string | undefined> }));
const unseen = vi.hoisted(() => ({ value: false, asked: [] as Array<{ enabled: boolean }> }));
const keyboard = vi.hoisted(() => ({ dismiss: vi.fn() }));

vi.mock('@react-navigation/native', () => ({ useFocusEffect: () => undefined, useIsFocused: () => true }));
vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: readonly unknown[]; refetchInterval?: unknown }) => {
    queryOptions.push(options);
    return query;
  },
  useQueryClient: () => queryClient,
}));
vi.mock('expo-router', () => ({
  router: routerState,
  Stack: { Screen: (props: MockProps) => React.createElement('stack-screen', props) },
  useLocalSearchParams: () => route.params,
}));
// The Updates and Roadmap tabs have suites of their own (support-hub-tabs.test.tsx): here they are host
// elements whose props say what the hub gave them.
vi.mock('@/components/support-hub-updates', () => ({
  SupportUpdatesTab: (props: MockProps) => React.createElement('support-updates-tab', props),
}));
vi.mock('@/components/support-hub-roadmap', () => ({
  SupportRoadmapTab: (props: MockProps) => React.createElement('support-roadmap-tab', props),
}));
vi.mock('@/lib/support-updates-seen', () => ({
  useSupportUpdatesUnseen: (options: { enabled: boolean }) => {
    unseen.asked.push(options);
    return unseen.value;
  },
}));
vi.mock('lucide-react-native', () => Object.fromEntries(
  ['AlertCircle', 'ArrowDown', 'Ban', 'Check', 'CheckCheck', 'Clock3', 'ImageOff', 'ImagePlus', 'LifeBuoy', 'Lock', 'Pencil', 'Reply', 'Send', 'X']
    .map((name) => [name, (props: MockProps) => React.createElement('icon', { ...props, name })]),
));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));
vi.mock('expo-image', () => ({ Image: (props: MockProps) => React.createElement('expo-image', props) }));
vi.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: picker.launch,
  UIImagePickerPreferredAssetRepresentationMode: { Automatic: 'automatic', Compatible: 'compatible', Current: 'current' },
}));
vi.mock('@/components/media-lightbox', () => ({ MediaLightbox: (props: MockProps) => React.createElement('media-lightbox', props) }));
vi.mock('@/lib/media', () => ({ uploadPickedMedia: upload.picked }));
vi.mock('@/lib/support-photo-file', async () => ({
  ...await vi.importActual<typeof import('@/lib/support-photo-file')>('@/lib/support-photo-file'),
  keepSupportPhoto: photoFiles.keep,
  letGoSupportPhoto: photoFiles.letGo,
  supportPhotoIsThere: photoFiles.isThere,
  sweepSupportPhotos: photoFiles.sweep,
}));
vi.mock('react-native', () => {
  class AnimatedValue {
    setValue() {}
    interpolate() { return this; }
  }
  return {
    Animated: {
      Value: AnimatedValue,
      View: ({ children, ...props }: MockProps) => React.createElement('animated-view', props, children),
      spring: () => ({ start: () => undefined }),
    },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    FlatList: ({
      data,
      renderItem,
      ListHeaderComponent,
      ListFooterComponent,
    }: {
      data: Array<{ key: string }>;
      renderItem: (info: { item: { key: string } }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    }) => React.createElement(
      'flat-list',
      null,
      ListHeaderComponent,
      data.map((item) => React.createElement(React.Fragment, { key: item.key }, renderItem({ item }))),
      ListFooterComponent,
    ),
    Keyboard: keyboard,
    Linking: { openURL: openUrl },
    Pressable: ({ children, style, ...props }: MockProps) => React.createElement(
      'pressable',
      { ...props, style: typeof style === 'function' ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false }) : style },
      children,
    ),
    Text: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
    TextInput: (props: MockProps) => React.createElement('text-input', props),
    View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
    useWindowDimensions: () => ({ width: 390, height: 844 }),
  };
});
vi.mock('@/components/keyboard-aware', () => ({
  KeyboardAvoidingArea: ({ children }: MockProps) => React.createElement('keyboard-area', null, children),
}));
vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('app-text', props, children),
  IconButton: (props: MockProps) => React.createElement('icon-button', props),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
  SegmentedControl: (props: MockProps) => React.createElement('segmented-control', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));
vi.mock('@/lib/app-foreground', () => ({ useAppForeground: () => true }));
vi.mock('@/lib/action-sheet', () => ({ showActionSheet: actionSheet.show }));
vi.mock('@/lib/dialog', () => ({ showConfirmDialog: confirmDialog.show }));
vi.mock('@/lib/copy-to-clipboard', () => ({ copyToClipboard: clipboard.copy }));
vi.mock('@/lib/haptics', () => ({ haptic: { light: vi.fn(), medium: vi.fn(), select: vi.fn() } }));
vi.mock('@/lib/theme-context', () => ({
  useAppTheme: () => ({
    colors: new Proxy({}, { get: () => 'colour' }),
    state: { pressed: { background: 'pressed' } },
    shadow: { floating: { boxShadow: 'shadow' } },
  }),
}));
vi.mock('@/lib/theme', () => ({
  mediaColors: { onMedia: '#ffffff', mediaScrimStrong: 'rgba(0,0,0,0.70)' },
  appTheme: {
    radii: { xs: 8, sm: 12, md: 16, lg: 20, xl: 24, pill: 999 },
    opacity: { disabled: 0.5 },
    touch: { default: 48 },
    icon: { xs: 14, sm: 16, compact: 18, default: 20 },
    spacing: { screen: 16, gap: 12, compact: 8, section: 32 },
    type: { body: { fontSize: 16, lineHeight: 22 } },
  },
}));

// The build lines the guest's mail carries, as the foot of Settings shows them.
vi.mock('@/lib/app-version-label', () => ({
  formatAppVersionLabel: () => appVersion.label,
  readAppVersionParts: () => ({ version: null, build: null, update: null }),
  readUpdateRuntime: () => appVersion.runtime,
}));

import { ApiError } from '../lib/api-client';
import { recordCreatorSession, resetCreatorSessionForTests } from '../lib/creator-session-diagnostics';
import SupportScreen from '../app/support';

// The thread's clock, pinned to a local midday. The fixtures are dated minutes
// before it and drawn under "Today"; dated from the real clock, they all fell on
// the day before for the first minutes after midnight, wherever the suite ran.
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

beforeAll(() => {
  // Without fake timers this mocks Date alone; the screen's timers stay real.
  vi.setSystemTime(NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

function message(overrides: Record<string, unknown>) {
  return { author: 'user', body: 'Hello', createdAt: iso(60), editedAt: null, deletedAt: null, replyTo: null, reactions: [], attachment: null, ...overrides };
}

const conversation = {
  success: true,
  conversation: {
    id: 'conversation-1',
    status: 'open',
    userLastReadAt: iso(30),
    staffLastReadAt: iso(55),
    userTyping: false,
    staffTyping: false,
  },
  messages: [
    message({ id: 'm1', body: 'My video failed.', createdAt: iso(58), reactions: [{ author: 'staff', emoji: '👍' }] }),
    message({ id: 'm2', author: 'staff', body: 'The credits are back. See https://magicbooklet.com/help', createdAt: iso(40), replyTo: { id: 'm1', author: 'user', body: 'My video failed.', deleted: false, hasPhoto: false } }),
    message({ id: 'm3', body: null, deletedAt: iso(5), createdAt: iso(10) }),
    message({ id: 'm4', body: 'Thanks!', createdAt: iso(5) }),
  ],
};

function render() {
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(React.createElement(SupportScreen));
  });
  return tree;
}

function secondaryButton(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root.find((node) => String(node.type) === 'secondary-button' && node.props.label === label);
}

/** Every string drawn, nested text included. */
function drawnText(tree: renderer.ReactTestRenderer): string[] {
  const out: string[] = [];
  const visit = (node: renderer.ReactTestRendererJSON | string | null) => {
    if (node === null) return;
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    for (const child of node.children ?? []) visit(child as renderer.ReactTestRendererJSON | string);
  };
  const json = tree.toJSON();
  for (const node of Array.isArray(json) ? json : [json]) visit(node);
  return out;
}

function typeDraft(tree: renderer.ReactTestRenderer, text: string) {
  act(() => {
    (tree.root.findByType('text-input' as never).props.onChangeText as (value: string) => void)(text);
  });
}

function sendButton(tree: renderer.ReactTestRenderer) {
  return tree.root.find((node) => String(node.type) === 'icon-button' && ['Send', 'Save'].includes(String(node.props.label)));
}

function attachButton(tree: renderer.ReactTestRenderer) {
  return tree.root.find((node) => String(node.type) === 'icon-button' && node.props.label === 'Attach a photo');
}

function bubbleOf(tree: renderer.ReactTestRenderer, hintIncludes = 'Hold for reactions') {
  return tree.root.findAll((node) => String(node.type) === 'pressable' && String(node.props.accessibilityHint ?? '').includes(hintIncludes));
}

/** Presses a message's "Not sent" mark and picks one of the two things it offers. */
async function chooseOnNotSent(tree: renderer.ReactTestRenderer, label: 'Try again' | 'Delete') {
  const mark = tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityHint === 'Try it again, or delete it.');
  act(() => { (mark.props.onPress as () => void)(); });
  const request = actionSheet.show.mock.calls.at(-1)?.[0] as { title: string; actions: Array<{ label: string; onPress: () => void }> };
  expect(request.title).toBe('Your message was not sent');
  expect(request.actions.map((action) => action.label)).toEqual(['Try again', 'Delete']);
  await act(async () => { request.actions.find((action) => action.label === label)?.onPress(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  // A value queued for one test must not reach the next.
  for (const call of [authState.api.sendSupportMessage, authState.api.editSupportMessage, authState.api.deleteSupportMessage, authState.api.reactToSupportMessage, picker.launch, upload.picked]) {
    call.mockReset();
  }
  authState.user = { id: 'account-1' };
  query.data = conversation;
  query.isError = false;
  queryOptions.length = 0;
  route.params = {};
  unseen.value = false;
  unseen.asked.length = 0;
  photoFiles.live.clear();
  appVersion.label = null;
  appVersion.runtime = { runtimeVersion: null, channel: null };
  resetCreatorSessionForTests();
});

/** An upload that reads its file, as `uploadPickedMedia` does: a copy no longer there fails it. */
function uploadsFromLiveCopy(storagePath: string) {
  return async (uri: string) => {
    if (photoFiles.isCopy(uri) && !photoFiles.live.has(uri)) throw new Error('The selected file is no longer available. Choose it again.');
    return { storagePath };
  };
}

/** A promise held open by the test, settled when it says. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe('Message support', () => {
  it('asks a guest to sign in, and offers the mail instead', () => {
    authState.user = null;
    const tree = render();

    expect(tree.root.findByType('section-title' as never).props.title).toBe('Sign in to message support');
    act(() => { (tree.root.findByType('primary-button' as never).props.onPress as () => void)(); });
    expect(routerState.push).toHaveBeenCalledWith({ pathname: '/auth', params: { returnTo: '/support' } });

    act(() => { (tree.root.findByType('secondary-button' as never).props.onPress as () => void)(); });
    expect(openUrl).toHaveBeenCalledWith('mailto:info@magicbooklet.com?subject=Magicbooklet%20app%20support');
  });

  // Help & Support opens this screen itself (owner, 2026-11-26), so the guest's mail carries what
  // the Help screen's did: the build lines Settings shows, below room for the message.
  it("puts this phone's build and runtime lines in the guest's mail, below room for the message", () => {
    authState.user = null;
    appVersion.label = 'Version 0.1.9 (64) · update a17f193a';
    appVersion.runtime = { runtimeVersion: '0.1.9', channel: 'production' };
    recordCreatorSession({ tool: 'video', outcome: 'recovered', referenceCount: 2, catalogRevision: 'rev-1', draftFormat: 'v1 per identity, remix 4' });
    const tree = render();

    act(() => { (tree.root.findByType('secondary-button' as never).props.onPress as () => void)(); });

    const url = new URL(openUrl.mock.calls[0][0] as string);
    expect(`${url.protocol}${url.pathname}`).toBe('mailto:info@magicbooklet.com');
    expect(url.searchParams.get('subject')).toBe('Magicbooklet app support');
    expect(url.searchParams.get('body')).toBe([
      '',
      '',
      'Version 0.1.9 (64) · update a17f193a',
      'Runtime 0.1.9 · channel production · video draft repaired from its source, 2 references · catalog rev-1 · drafts v1 per identity, remix 4',
    ].join('\n'));
  });

  it('draws the thread as a chat app does: a day, quotes, links, reactions, ticks and deleted messages', () => {
    const tree = render();
    const drawn = drawnText(tree);

    expect(drawn).toContain('Today');
    expect(drawn).toContain('My video failed.');
    expect(drawn).toContain('https://magicbooklet.com/help');
    expect(drawn).toContain('You deleted this message');
    expect(drawn).toContain('👍');
    expect(drawn).toContain('Only you and the Magicbooklet team can read this conversation.');
    // Support read past the first message, not the last. The list is drawn
    // upside down, newest first.
    const ticks = tree.root.findAll((node) => String(node.type) === 'icon' && ['CheckCheck', 'Check'].includes(String(node.props.name)));
    expect(ticks.map((node) => node.props.accessibilityLabel)).toEqual(['Sent', 'Read']);
    // The quote of the reply opens its message.
    const quote = tree.root.findAll((node) => String(node.type) === 'pressable' && String(node.props.accessibilityLabel ?? '').startsWith('Reply to You'));
    expect(quote).toHaveLength(1);
  });

  it('says "typing…" in the header while support writes', () => {
    query.data = { ...conversation, conversation: { ...conversation.conversation, staffTyping: true } };
    const tree = render();
    const header = tree.root.findByType('stack-screen' as never).props.options as { headerTitle: () => React.ReactElement };
    let headerTree!: renderer.ReactTestRenderer;
    act(() => { headerTree = renderer.create(header.headerTitle()); });
    expect(drawnText(headerTree)).toEqual(['Magicbooklet support', 'typing…']);
  });

  it('marks support\'s new replies read while the screen is in front', async () => {
    query.data = { ...conversation, conversation: { ...conversation.conversation, userLastReadAt: iso(59) } };
    await act(async () => { render(); });
    expect(authState.api.markSupportConversationRead).toHaveBeenCalledTimes(1);
  });

  it('holds Send until there is something to send, and says typing while the text changes', () => {
    const tree = render();
    expect(sendButton(tree).props.disabled).toBe(true);
    typeDraft(tree, '   ');
    expect(sendButton(tree).props.disabled).toBe(true);
    typeDraft(tree, 'Hello');
    expect(sendButton(tree).props.disabled).toBe(false);
    expect(authState.api.setSupportTyping).toHaveBeenCalledWith(true);
  });

  it('sends the trimmed text with an id of its own, and keeps what the server kept', async () => {
    const kept = {
      success: true,
      message: message({ id: 'm5', body: 'One more thing', createdAt: new Date(NOW).toISOString() }),
      conversation: { id: 'conversation-1', status: 'open' },
    };
    authState.api.sendSupportMessage.mockResolvedValueOnce(kept);
    const tree = render();

    typeDraft(tree, '  One more thing  ');
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });

    expect(authState.api.sendSupportMessage).toHaveBeenCalledWith({
      body: 'One more thing',
      clientMessageId: expect.stringMatching(/^msg:/),
      replyToMessageId: null,
    });
    expect(tree.root.findByType('text-input' as never).props.value).toBe('');
    const [key, update] = queryClient.setQueryData.mock.calls.at(-1) as unknown as [unknown, (current: unknown) => { messages: Array<{ id: string }> }];
    expect(key).toEqual(['support-conversation', 'account-1']);
    expect(update(conversation).messages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  it('opens reactions and actions on a long press, and replies quoting the message', async () => {
    authState.api.sendSupportMessage.mockResolvedValueOnce({
      success: true,
      message: message({ id: 'm5', body: 'Which video?', createdAt: new Date(NOW).toISOString() }),
      conversation: { id: 'conversation-1', status: 'open' },
    });
    const tree = render();
    // Newest first: the account's first message is the last bubble.
    const first = bubbleOf(tree).at(-1);
    if (!first) throw new Error('No bubble');
    act(() => { (first.props.onLongPress as () => void)(); });

    const request = actionSheet.show.mock.calls[0][0] as {
      title: string;
      actions: Array<{ label: string; onPress: () => void; destructive?: boolean }>;
      reactions: { options: string[]; selected: string | null };
    };
    expect(request.title).toBe('My video failed.');
    expect(request.reactions.options).toEqual(['👍', '❤️', '😂', '😮', '😢', '🙏']);
    // The account's own message, an hour old: Reply, Copy and Delete, no longer Edit.
    expect(request.actions.map((action) => action.label)).toEqual(['Reply', 'Copy', 'Delete']);

    act(() => { request.actions[0].onPress(); });
    expect(drawnText(tree)).toContain('You');
    typeDraft(tree, 'Which video?');
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });
    expect(authState.api.sendSupportMessage).toHaveBeenCalledWith(expect.objectContaining({ replyToMessageId: 'm1' }));
  });

  it('reacts from the long press, drawn at once and put back if refused', async () => {
    authState.api.reactToSupportMessage.mockRejectedValueOnce(new ApiError('That message was deleted.', 409));
    const tree = render();
    const support = bubbleOf(tree)[1];
    act(() => { (support.props.onLongPress as () => void)(); });
    const request = actionSheet.show.mock.calls[0][0] as { reactions: { onSelect: (emoji: string) => void } };

    await act(async () => { request.reactions.onSelect('🙏'); });

    expect(authState.api.reactToSupportMessage).toHaveBeenCalledWith('m2', '🙏');
    const updates = queryClient.setQueryData.mock.calls.map(([, update]) => (update as (current: unknown) => { messages: Array<{ id: string; reactions: unknown[] }> })(conversation));
    expect(updates[0].messages.find((item) => item.id === 'm2')?.reactions).toEqual([{ author: 'user', emoji: '🙏' }]);
    expect(updates.at(-1)?.messages.find((item) => item.id === 'm2')?.reactions).toEqual([]);
    expect(drawnText(tree)).toContain('That message was deleted.');
  });

  it('offers Edit within 15 minutes, and saves the new text', async () => {
    authState.api.editSupportMessage.mockResolvedValueOnce({ success: true, message: message({ id: 'm4', body: 'Thanks a lot!', editedAt: new Date(NOW).toISOString(), createdAt: iso(5) }) });
    const tree = render();
    // Newest first: the latest message is the first bubble.
    const [last] = bubbleOf(tree);
    act(() => { (last.props.onLongPress as () => void)(); });
    const request = actionSheet.show.mock.calls[0][0] as { actions: Array<{ label: string; onPress: () => void }> };
    expect(request.actions.map((action) => action.label)).toEqual(['Reply', 'Copy', 'Edit', 'Delete']);

    act(() => { request.actions[2].onPress(); });
    expect(tree.root.findByType('text-input' as never).props.value).toBe('Thanks!');
    typeDraft(tree, 'Thanks a lot!');
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });
    expect(authState.api.editSupportMessage).toHaveBeenCalledWith('m4', 'Thanks a lot!');
  });

  it('keeps the unsent draft aside while a message is edited, and a refused edit\'s new text', async () => {
    authState.api.editSupportMessage
      .mockRejectedValueOnce(new ApiError('A message can be edited for 15 minutes after it is sent.', 409, undefined, undefined, 'EDIT_TOO_LATE'))
      .mockResolvedValueOnce({ success: true, message: message({ id: 'm4', body: 'Thanks so much!', editedAt: new Date(NOW).toISOString(), createdAt: iso(5) }) });
    const tree = render();
    const field = () => tree.root.findByType('text-input' as never);
    typeDraft(tree, 'A question I was writing');

    const [last] = bubbleOf(tree);
    act(() => { (last.props.onLongPress as () => void)(); });
    const request = actionSheet.show.mock.calls[0][0] as { actions: Array<{ label: string; onPress: () => void }> };
    act(() => { request.actions[2].onPress(); });
    expect(field().props.value).toBe('Thanks!');

    typeDraft(tree, 'Thanks so much!');
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });
    // Refused: the new text stays in the composer, still editing.
    expect(field().props.value).toBe('Thanks so much!');
    expect(sendButton(tree).props.label).toBe('Save');

    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });
    expect(authState.api.editSupportMessage).toHaveBeenLastCalledWith('m4', 'Thanks so much!');
    // Saved: the draft written before the edit comes back.
    expect(field().props.value).toBe('A question I was writing');
    expect(sendButton(tree).props.label).toBe('Send');
  });

  it('deletes for everyone only after the confirmation', async () => {
    authState.api.deleteSupportMessage.mockResolvedValueOnce({ success: true, message: message({ id: 'm4', body: null, deletedAt: new Date(NOW).toISOString(), createdAt: iso(5) }) });
    const tree = render();
    const [last] = bubbleOf(tree);
    act(() => { (last.props.onLongPress as () => void)(); });
    const request = actionSheet.show.mock.calls[0][0] as { actions: Array<{ label: string; onPress: () => void }> };

    await act(async () => { request.actions[3].onPress(); });

    expect(confirmDialog.show).toHaveBeenCalledWith(expect.objectContaining({ title: 'Delete for everyone?', destructive: true }));
    expect(authState.api.deleteSupportMessage).toHaveBeenCalledWith('m4');
  });

  it('keeps a message that was not sent, says why, and sends it again with the same id', async () => {
    authState.api.sendSupportMessage
      .mockRejectedValueOnce(new ApiError('Failed to send your message.', 500))
      .mockResolvedValueOnce({
        success: true,
        message: message({ id: 'm5', body: 'Hello', createdAt: new Date(NOW).toISOString() }),
        conversation: { id: 'conversation-1', status: 'open' },
      });
    const tree = render();

    typeDraft(tree, 'Hello');
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });

    expect(drawnText(tree)).toContain('Not sent. Tap to try again.');
    expect(drawnText(tree)).toContain('Your message was not sent. Check your connection, then try again.');

    await chooseOnNotSent(tree, 'Try again');

    const [first, second] = authState.api.sendSupportMessage.mock.calls as unknown as Array<[{ clientMessageId: string }]>;
    expect(second[0].clientMessageId).toBe(first[0].clientMessageId);
    expect(drawnText(tree)).not.toContain('Not sent. Tap to try again.');
  });

  it('lets a message that was not sent go', async () => {
    authState.api.sendSupportMessage.mockRejectedValueOnce(new ApiError('Failed to send your message.', 500));
    const tree = render();
    typeDraft(tree, 'Never mind');
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });
    expect(drawnText(tree)).toContain('Never mind');

    await chooseOnNotSent(tree, 'Delete');
    expect(drawnText(tree)).not.toContain('Never mind');
    expect(drawnText(tree)).not.toContain('Not sent. Tap to try again.');
    expect(authState.api.sendSupportMessage).toHaveBeenCalledTimes(1);
  });

  it('settles a message whose answer was lost once a read shows it kept', async () => {
    authState.api.sendSupportMessage.mockRejectedValueOnce(new TypeError('Network request failed'));
    const tree = render();
    typeDraft(tree, 'Did it go?');
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });
    expect(drawnText(tree)).toContain('Not sent. Tap to try again.');

    const [[sent]] = authState.api.sendSupportMessage.mock.calls as unknown as Array<[{ clientMessageId: string }]>;
    query.data = {
      ...conversation,
      messages: [...conversation.messages, message({ id: 'm5', body: 'Did it go?', createdAt: iso(0), clientMessageId: sent.clientMessageId })],
    };
    act(() => { tree.update(React.createElement(SupportScreen)); });
    expect(drawnText(tree)).not.toContain('Not sent. Tap to try again.');
    expect(drawnText(tree).filter((text) => text === 'Did it go?')).toHaveLength(1);
  });

  it('says nothing of a send a read already showed kept when its failed answer comes late', async () => {
    let failLate: () => void = () => undefined;
    authState.api.sendSupportMessage.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      failLate = () => reject(new TypeError('Network request failed'));
    }));
    const tree = render();
    typeDraft(tree, 'Did it go?');
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });

    const [[sent]] = authState.api.sendSupportMessage.mock.calls as unknown as Array<[{ clientMessageId: string }]>;
    query.data = {
      ...conversation,
      messages: [...conversation.messages, message({ id: 'm5', body: 'Did it go?', createdAt: iso(0), clientMessageId: sent.clientMessageId })],
    };
    act(() => { tree.update(React.createElement(SupportScreen)); });

    await act(async () => { failLate(); });
    expect(drawnText(tree)).not.toContain('Not sent. Tap to try again.');
    expect(drawnText(tree)).not.toContain('Your message was not sent. Check your connection, then try again.');
    expect(drawnText(tree).filter((text) => text === 'Did it go?')).toHaveLength(1);
  });

  it('sends one message at a time, in the order written', async () => {
    let releaseFirst: () => void = () => undefined;
    authState.api.sendSupportMessage
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseFirst = () => resolve({ success: true, message: message({ id: 'm5', body: 'First', createdAt: iso(0) }), conversation: { id: 'conversation-1', status: 'open' } });
      }))
      .mockResolvedValueOnce({ success: true, message: message({ id: 'm6', body: 'Second', createdAt: iso(0) }), conversation: { id: 'conversation-1', status: 'open' } });
    const tree = render();

    typeDraft(tree, 'First');
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });
    typeDraft(tree, 'Second');
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });
    expect(authState.api.sendSupportMessage).toHaveBeenCalledTimes(1);

    await act(async () => { releaseFirst(); });
    const bodies = (authState.api.sendSupportMessage.mock.calls as unknown as Array<[{ body: string }]>).map(([request]) => request.body);
    expect(bodies).toEqual(['First', 'Second']);
  });

  it('says the conversation is resolved, and that writing again reopens it', () => {
    query.data = { ...conversation, conversation: { ...conversation.conversation, status: 'resolved' } };
    const tree = render();
    expect(drawnText(tree)).toContain('We marked this as resolved. Write again any time and the conversation reopens.');
  });

  it('offers a retry when the conversation could not be read', () => {
    query.data = undefined;
    query.isError = true;
    const tree = render();

    expect(tree.root.findByType('status-block' as never).props.title).toBe('Your messages could not be loaded');
    act(() => { (secondaryButton(tree, 'Try again').props.onPress as () => void)(); });
    expect(query.refetch).toHaveBeenCalled();
  });

  // Help & Support opens this screen itself (owner, 2026-11-26), the only place the app gives the
  // support address, so a thread that will not load still leaves the mail.
  it('offers the mail beside the retry when the conversation could not be read', () => {
    query.data = undefined;
    query.isError = true;
    appVersion.label = 'Version 0.1.9 (64) · update a17f193a';
    const tree = render();

    act(() => { (secondaryButton(tree, 'Email us instead').props.onPress as () => void)(); });

    const url = new URL(openUrl.mock.calls[0][0] as string);
    expect(`${url.protocol}${url.pathname}`).toBe('mailto:info@magicbooklet.com');
    expect(url.searchParams.get('body')).toBe('\n\nVersion 0.1.9 (64) · update a17f193a');
  });

  it('gives a signed-in account the mail under the privacy note, with the build lines', () => {
    appVersion.label = 'Version 0.1.9 (64) · update a17f193a';
    for (const data of [conversation, { ...conversation, messages: [] }]) {
      openUrl.mockClear();
      query.data = data;
      const tree = render();
      const mail = tree.root.find((node) => String(node.type) === 'pressable'
        && node.props.accessibilityLabel === 'Prefer email? Write to info@magicbooklet.com');

      expect(mail.props.accessibilityRole).toBe('link');
      act(() => { (mail.props.onPress as () => void)(); });
      const url = new URL(openUrl.mock.calls[0][0] as string);
      expect(`${url.protocol}${url.pathname}`, `${data.messages.length} messages`).toBe('mailto:info@magicbooklet.com');
      expect(url.searchParams.get('body')).toBe('\n\nVersion 0.1.9 (64) · update a17f193a');
      act(() => tree.unmount());
    }
  });
});

describe('photos in Message support', () => {
  const photo = {
    kind: 'image',
    previewUrl: 'https://storage.example/p1.preview.webp?token=a',
    url: 'https://storage.example/p1.webp?token=a',
    width: 1080,
    height: 1920,
    thumbhash: 'hash=',
    expiresAt: new Date(NOW + 3 * 3_600_000).toISOString(),
  };
  const picked = {
    uri: 'file:///cache/ImagePicker/IMG_0001.jpg',
    fileName: 'IMG_0001.jpg',
    mimeType: 'image/jpeg',
    fileSize: 840_000,
    width: 1170,
    height: 2532,
    type: 'image',
  };
  const keptPhoto = (id = 'm5') => ({
    success: true,
    message: message({ id, body: null, createdAt: new Date(NOW).toISOString(), attachment: photo }),
    conversation: { id: 'conversation-1', status: 'open' },
  });

  async function pick(tree: renderer.ReactTestRenderer, asset: Record<string, unknown> = picked) {
    picker.launch.mockResolvedValueOnce({ canceled: false, assets: [asset] });
    await act(async () => { (attachButton(tree).props.onPress as () => void)(); });
  }

  it('draws a photo from its preview, cached under its message, and opens the thread\'s photos full screen', () => {
    query.data = { ...conversation, messages: [...conversation.messages, message({ id: 'p1', author: 'staff', body: 'Here', createdAt: iso(2), attachment: photo })] };
    const tree = render();
    const image = tree.root.find((node) => String(node.type) === 'expo-image' && (node.props.source as { uri?: string }).uri === photo.previewUrl);
    expect(image.props.source).toEqual({ uri: photo.previewUrl, cacheKey: 'support-photo-p1' });
    expect(image.props.placeholder).toEqual({ thumbhash: 'hash=' });

    const opener = tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Open photo');
    act(() => { (opener.props.onPress as () => void)(); });
    const lightbox = tree.root.findByType('media-lightbox' as never);
    expect(lightbox.props.activeIndex).toBe(0);
    expect(lightbox.props.items).toEqual([{ id: 'p1', url: photo.url, mediaKind: 'image', label: 'Magicbooklet support', caption: 'Here' }]);
  });

  it('titles a photo\'s long press "📷 Photo" and offers no Copy or Edit without a caption', () => {
    query.data = { ...conversation, messages: [...conversation.messages, message({ id: 'p2', body: null, createdAt: iso(1), attachment: photo })] };
    const tree = render();
    const opener = tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Open photo');
    act(() => { (opener.props.onLongPress as () => void)(); });
    const request = actionSheet.show.mock.calls[0][0] as { title: string; actions: Array<{ label: string }> };
    expect(request.title).toBe('📷 Photo');
    expect(request.actions.map((action) => action.label)).toEqual(['Reply', 'Delete']);
  });

  it('attaches a photo from the library, stages it, and sends it with an empty caption', async () => {
    upload.picked.mockImplementationOnce(uploadsFromLiveCopy('uploads/account-1/u1-IMG_0001.jpg'));
    authState.api.sendSupportMessage.mockResolvedValueOnce(keptPhoto());
    const tree = render();

    await pick(tree);
    // An iPhone's HEIC comes as a JPEG: the compatible representation, whatever the quality.
    expect(picker.launch).toHaveBeenCalledWith(expect.objectContaining({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      preferredAssetRepresentationMode: 'compatible',
    }));
    expect(drawnText(tree)).toContain('IMG_0001.jpg');
    expect(tree.root.findByType('text-input' as never).props.placeholder).toBe('Add a caption');
    expect(sendButton(tree).props.disabled).toBe(false);

    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });
    // Read from its own copy in the documents folder, never the picker's cache file.
    const copy = await photoFiles.keep.mock.results[0].value;
    expect(photoFiles.keep).toHaveBeenCalledWith(picked.uri, expect.stringMatching(/\.jpg$/));
    expect(upload.picked).toHaveBeenCalledWith(copy, expect.objectContaining({
      api: authState.api,
      fileName: 'IMG_0001.jpg',
      mimeType: 'image/jpeg',
      kind: 'image',
      sizeBytes: 840_000,
    }));
    expect(authState.api.sendSupportMessage).toHaveBeenCalledWith({
      body: '',
      clientMessageId: expect.stringMatching(/^msg:/),
      replyToMessageId: null,
      photo: { storagePath: 'uploads/account-1/u1-IMG_0001.jpg' },
    });
    // Sent: the copy goes.
    expect(photoFiles.letGo).toHaveBeenCalledWith(copy);
    expect(photoFiles.live.size).toBe(0);
  });

  it('tries a photo whose upload failed again from the same copy, still there', async () => {
    upload.picked
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockImplementationOnce(uploadsFromLiveCopy('uploads/account-1/u1-IMG_0001.jpg'));
    authState.api.sendSupportMessage.mockResolvedValueOnce(keptPhoto());
    const tree = render();
    await pick(tree);
    const copy = await photoFiles.keep.mock.results[0].value;
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });
    expect(drawnText(tree)).toContain('Not sent. Tap to try again.');
    // Not sent, it keeps its copy for the next try.
    expect(photoFiles.live.has(copy)).toBe(true);

    await chooseOnNotSent(tree, 'Try again');
    expect(upload.picked).toHaveBeenCalledTimes(2);
    expect(upload.picked.mock.calls[1][0]).toBe(copy);
    expect(authState.api.sendSupportMessage).toHaveBeenCalledTimes(1);
    expect(photoFiles.live.size).toBe(0);
  });

  it('lets a copy go once a read shows its message was kept, though its answer was lost', async () => {
    upload.picked.mockImplementationOnce(uploadsFromLiveCopy('uploads/account-1/u1-IMG_0001.jpg'));
    authState.api.sendSupportMessage.mockRejectedValueOnce(new TypeError('Network request failed'));
    const tree = render();
    await pick(tree);
    const copy = await photoFiles.keep.mock.results[0].value;
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });
    expect(photoFiles.live.has(copy)).toBe(true);

    const [[sent]] = authState.api.sendSupportMessage.mock.calls as unknown as Array<[{ clientMessageId: string }]>;
    query.data = {
      ...conversation,
      messages: [...conversation.messages, message({ id: 'm5', body: null, clientMessageId: sent.clientMessageId, createdAt: new Date(NOW).toISOString(), attachment: photo })],
    };
    act(() => { tree.update(React.createElement(SupportScreen)); });
    expect(photoFiles.live.has(copy)).toBe(false);
    expect(drawnText(tree)).not.toContain('Not sent. Tap to try again.');
  });

  it('lets the copy of a message not sent go as the screen closes, and keeps a send\'s copy until it settles', async () => {
    // One photo not sent.
    upload.picked.mockRejectedValueOnce(new TypeError('Network request failed'));
    const tree = render();
    await pick(tree);
    const notSent = await photoFiles.keep.mock.results[0].value;
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });
    expect(drawnText(tree)).toContain('Not sent. Tap to try again.');

    // A second still on its way.
    const onItsWay = deferred<{ storagePath: string }>();
    upload.picked.mockImplementationOnce(() => onItsWay.promise);
    await pick(tree, { ...picked, uri: 'file:///cache/ImagePicker/IMG_0004.jpg', fileName: 'IMG_0004.jpg' });
    const sending = await photoFiles.keep.mock.results[1].value;
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });

    act(() => { tree.unmount(); });
    expect(photoFiles.live.has(notSent)).toBe(false);
    expect(photoFiles.live.has(sending)).toBe(true);

    // It fails after the screen closed: nothing can try it again, so its copy goes too.
    await act(async () => { onItsWay.reject(new TypeError('Network request failed')); });
    expect(photoFiles.live.has(sending)).toBe(false);
  });

  it('lets a copy go when the picker answers after the screen closed', async () => {
    const answer = deferred<{ canceled: boolean; assets: Array<Record<string, unknown>> }>();
    picker.launch.mockImplementationOnce(() => answer.promise);
    const tree = render();
    await act(async () => { (attachButton(tree).props.onPress as () => void)(); });
    act(() => { tree.unmount(); });

    await act(async () => { answer.resolve({ canceled: false, assets: [picked] }); });
    expect(photoFiles.keep).toHaveBeenCalledTimes(1);
    expect(photoFiles.live.size).toBe(0);
  });

  it('keeps a picked photo in a copy of its own until it is sent, taken off or replaced', async () => {
    const tree = render();
    expect(photoFiles.sweep).toHaveBeenCalledTimes(1);

    await pick(tree);
    const first = await photoFiles.keep.mock.results[0].value;
    expect(photoFiles.letGo).not.toHaveBeenCalledWith(first);

    // Another photo in its place lets the first copy go.
    await pick(tree, { ...picked, uri: 'file:///cache/ImagePicker/IMG_0003.png', fileName: 'IMG_0003.png', mimeType: 'image/png' });
    const second = await photoFiles.keep.mock.results[1].value;
    expect(second).toMatch(/\.png$/);
    expect(photoFiles.letGo).toHaveBeenCalledWith(first);

    // Taken off the composer, its copy goes with it.
    const remove = tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityLabel === 'Remove photo');
    act(() => { (remove.props.onPress as () => void)(); });
    expect(photoFiles.letGo).toHaveBeenCalledWith(second);
    expect(drawnText(tree)).not.toContain('IMG_0003.png');
  });

  it('lets the draft\'s copy go when the screen closes with it still there', async () => {
    const tree = render();
    await pick(tree);
    const copy = await photoFiles.keep.mock.results[0].value;
    act(() => { tree.unmount(); });
    expect(photoFiles.letGo).toHaveBeenCalledWith(copy);
  });

  it('says a photo no longer on the phone is gone, rather than to check the connection', async () => {
    const tree = render();
    await pick(tree);
    const copy = await photoFiles.keep.mock.results[0].value;
    photoFiles.isThere.mockResolvedValueOnce(false);
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });

    expect(photoFiles.isThere).toHaveBeenCalledWith(copy);
    expect(upload.picked).not.toHaveBeenCalled();
    expect(authState.api.sendSupportMessage).not.toHaveBeenCalled();
    expect(drawnText(tree)).toContain('This photo is no longer on your phone. Delete the message and choose the photo again.');
    expect(drawnText(tree)).not.toContain('Your message was not sent. Check your connection, then try again.');

    // No try can send it: the only choice is to let it go, and its copy with it.
    const mark = tree.root.find((node) => String(node.type) === 'pressable' && node.props.accessibilityHint === 'Try it again, or delete it.');
    act(() => { (mark.props.onPress as () => void)(); });
    const request = actionSheet.show.mock.calls.at(-1)?.[0] as { title: string; actions: Array<{ label: string; onPress: () => void }> };
    expect(request.title).toBe('Your message was not sent');
    expect(request.actions.map((action) => action.label)).toEqual(['Delete']);
    await act(async () => { request.actions[0].onPress(); });
    expect(photoFiles.letGo).toHaveBeenCalledWith(copy);
    expect(drawnText(tree)).not.toContain('Not sent. Tap to try again.');
  });

  it('tries a photo that was not sent again from where it was staged, without uploading it twice', async () => {
    upload.picked.mockResolvedValueOnce({ storagePath: 'uploads/account-1/u1-IMG_0001.jpg' });
    authState.api.sendSupportMessage
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockResolvedValueOnce(keptPhoto());
    const tree = render();
    await pick(tree);
    await act(async () => { (sendButton(tree).props.onPress as () => void)(); });
    expect(drawnText(tree)).toContain('Not sent. Tap to try again.');

    await chooseOnNotSent(tree, 'Try again');
    expect(upload.picked).toHaveBeenCalledTimes(1);
    const [first, second] = authState.api.sendSupportMessage.mock.calls as unknown as Array<[{ clientMessageId: string; photo: unknown }]>;
    expect(second[0].clientMessageId).toBe(first[0].clientMessageId);
    expect(second[0].photo).toEqual({ storagePath: 'uploads/account-1/u1-IMG_0001.jpg' });
  });

  it('refuses a picture the server cannot read before anything goes', async () => {
    const tree = render();
    await pick(tree, { ...picked, fileName: 'IMG_0002.HEIC', mimeType: 'image/heic' });
    expect(drawnText(tree)).toContain('That file could not be read as a photo. Send a JPEG, PNG, WebP or GIF.');
    expect(drawnText(tree)).not.toContain('IMG_0002.HEIC');
    expect(upload.picked).not.toHaveBeenCalled();
  });
});

/** The segmented control under the header. */
function tabControl(tree: renderer.ReactTestRenderer) {
  return tree.root.findByType('segmented-control' as never);
}

function chooseTab(tree: renderer.ReactTestRenderer, tab: 'chat' | 'updates' | 'roadmap') {
  act(() => { (tabControl(tree).props.onChange as (value: string) => void)(tab); });
}

/** Whether the tab page holding a node is laid out (`flex`) or hidden (`none`). */
function paneDisplay(node: renderer.ReactTestInstance): string | undefined {
  for (let current = node.parent; current; current = current.parent) {
    const style = current.props?.style as { display?: string } | undefined;
    if (String(current.type) === 'view' && style && 'display' in style) return style.display;
  }
  return undefined;
}

/** What the chat last asked of its thread's query. */
function chatQueryOptions() {
  return queryOptions.filter((options) => options.queryKey[0] === 'support-conversation').at(-1);
}

// Owner, 2026-11-26: Help & Support has three tabs, Chat, Updates and Roadmap, and still opens on Chat.
describe('Help & Support tabs', () => {
  it('opens on the chat, with Chat, Updates and Roadmap as tabs under the header', () => {
    const tree = render();
    const control = tabControl(tree);

    expect(control.props.role).toBe('tab');
    expect(control.props.accessibilityLabel).toBe('Help & Support sections');
    expect(control.props.value).toBe('chat');
    expect((control.props.options as Array<{ value: string; label: string }>).map((option) => [option.value, option.label]))
      .toEqual([['chat', 'Chat'], ['updates', 'Updates'], ['roadmap', 'Roadmap']]);
    // The chat as it was, its composer included; the other tabs are built when first opened.
    expect(paneDisplay(tree.root.findByType('text-input' as never))).toBe('flex');
    expect(tree.root.findAllByType('support-updates-tab' as never)).toHaveLength(0);
    expect(tree.root.findAllByType('support-roadmap-tab' as never)).toHaveLength(0);
  });

  it('opens on the tab its link names, and reads anything else as the chat', () => {
    route.params = { tab: 'updates' };
    const tree = render();
    expect(tabControl(tree).props.value).toBe('updates');
    expect(tree.root.findByType('support-updates-tab' as never).props.active).toBe(true);
    // The chat is not built (no thread read, no composer) until it is opened.
    expect(tree.root.findAllByType('text-input' as never)).toHaveLength(0);
    expect(chatQueryOptions()).toBeUndefined();
    act(() => tree.unmount());

    route.params = { tab: 'settings' };
    expect(tabControl(render()).props.value).toBe('chat');
  });

  it('keeps the chat and its draft behind another tab, the composer hidden, and puts the keyboard away', () => {
    const tree = render();
    typeDraft(tree, 'Half a question');

    chooseTab(tree, 'updates');
    expect(keyboard.dismiss).toHaveBeenCalledTimes(1);
    expect(paneDisplay(tree.root.findByType('text-input' as never))).toBe('none');
    expect(paneDisplay(tree.root.findByType('support-updates-tab' as never))).toBe('flex');
    expect(tree.root.findByType('support-updates-tab' as never).props.active).toBe(true);

    chooseTab(tree, 'chat');
    expect(paneDisplay(tree.root.findByType('text-input' as never))).toBe('flex');
    expect(tree.root.findByType('text-input' as never).props.value).toBe('Half a question');
    // Updates stays built, hidden and no longer in front.
    expect(paneDisplay(tree.root.findByType('support-updates-tab' as never))).toBe('none');
    expect(tree.root.findByType('support-updates-tab' as never).props.active).toBe(false);
  });

  it('reads the thread again and marks it read only while the chat is in front', async () => {
    const tree = render();
    expect(typeof chatQueryOptions()?.refetchInterval).toBe('function');

    chooseTab(tree, 'updates');
    expect(chatQueryOptions()?.refetchInterval).toBe(false);

    // A reply that arrives while Updates is in front is not marked read unseen.
    query.data = {
      ...conversation,
      messages: [...conversation.messages, message({ id: 'm5', author: 'staff', body: 'Any luck?', createdAt: iso(1) })],
    };
    await act(async () => { tree.update(React.createElement(SupportScreen)); });
    expect(authState.api.markSupportConversationRead).not.toHaveBeenCalled();

    chooseTab(tree, 'chat');
    await act(async () => undefined);
    expect(authState.api.markSupportConversationRead).toHaveBeenCalledTimes(1);
  });

  it("draws the chat's header on Chat and Help & Support's on the other tabs", () => {
    const tree = render();
    const headers = () => tree.root.findAllByType('stack-screen' as never);
    expect(headers()).toHaveLength(1);
    expect(typeof (headers()[0].props.options as { headerTitle: unknown }).headerTitle).toBe('function');

    chooseTab(tree, 'roadmap');
    expect(headers()).toHaveLength(1);
    expect(headers()[0].props.options).toEqual({ headerTitle: 'Help & Support' });
  });

  it("starts the chat's composer with the idea's words from the roadmap's Suggest a feature", () => {
    route.params = { tab: 'roadmap' };
    const tree = render();

    act(() => { (tree.root.findByType('support-roadmap-tab' as never).props.onSuggestFeature as () => void)(); });

    expect(tabControl(tree).props.value).toBe('chat');
    expect(keyboard.dismiss).toHaveBeenCalled();
    expect(tree.root.findByType('text-input' as never).props.value).toBe('Feature idea: ');
    expect(sendButton(tree).props.disabled).toBe(false);
  });

  it('never puts the idea\'s words over a draft being written', () => {
    const tree = render();
    typeDraft(tree, 'My video failed again');
    chooseTab(tree, 'roadmap');

    act(() => { (tree.root.findByType('support-roadmap-tab' as never).props.onSuggestFeature as () => void)(); });

    expect(tabControl(tree).props.value).toBe('chat');
    expect(tree.root.findByType('text-input' as never).props.value).toBe('My video failed again');
  });

  it('puts the unread dot on Updates, and asks for it only while another tab is in front', () => {
    unseen.value = true;
    const tree = render();
    const updates = (tabControl(tree).props.options as Array<{ value: string; dot?: boolean; accessibilityLabel?: string }>)
      .find((option) => option.value === 'updates');
    expect(updates).toMatchObject({ dot: true, accessibilityLabel: 'Updates, New updates' });
    expect(unseen.asked.at(-1)).toEqual(expect.objectContaining({ api: authState.api, enabled: true }));

    chooseTab(tree, 'updates');
    expect(unseen.asked.at(-1)).toEqual(expect.objectContaining({ enabled: false }));
  });

  it('lets a guest read Updates and Roadmap, the chat keeping its sign-in', () => {
    authState.user = null;
    const tree = render();
    expect(tree.root.findByType('section-title' as never).props.title).toBe('Sign in to message support');
    expect(tree.root.findByType('stack-screen' as never).props.options).toEqual({ headerTitle: 'Help & Support' });

    chooseTab(tree, 'roadmap');
    expect(tree.root.findByType('support-roadmap-tab' as never)).toBeTruthy();
    chooseTab(tree, 'updates');
    expect(tree.root.findByType('support-updates-tab' as never).props.active).toBe(true);
    expect(tree.root.findByType('stack-screen' as never).props.options).toEqual({ headerTitle: 'Help & Support' });
  });
});
