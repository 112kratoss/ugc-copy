// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
type BlockedUser = { id: string; username: string | null; name: string; avatar: string | null; blockedAt: string };
type BlockedList = { success: true; blockedUsers: BlockedUser[]; hasMore: boolean };

const first: BlockedUser = {
  id: 'creator-1',
  username: 'first-creator',
  name: 'First Creator',
  avatar: 'https://example.com/first.jpg',
  blockedAt: '2026-10-10T12:00:00.000Z',
};
const second: BlockedUser = { id: 'creator-2', username: null, name: 'No Handle', avatar: null, blockedAt: 'not a date' };

const state = vi.hoisted(() => ({
  user: { id: 'user-1' } as { id: string } | null,
  query: { isPending: false, isError: false, error: null as unknown, data: undefined as unknown, refetch: vi.fn() },
  queryOptions: null as null | { queryKey: unknown; enabled: boolean; queryFn: unknown },
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn(async (_filter: { queryKey: unknown }) => undefined),
  listBlockedUsers: vi.fn(),
  unblockUser: vi.fn(async (_userId: string) => ({ success: true as const, blocked: false })),
  routerPush: vi.fn(),
  showConfirmDialog: vi.fn(async (_request: { title: string; message: string; confirmLabel: string }) => true),
  showErrorDialog: vi.fn(),
  hapticSuccess: vi.fn(),
  hapticError: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown; enabled: boolean; queryFn: unknown }) => {
    state.queryOptions = options;
    return state.query;
  },
  useQueryClient: () => ({ setQueryData: state.setQueryData, invalidateQueries: state.invalidateQueries }),
}));

vi.mock('expo-router', () => ({ router: { push: state.routerPush } }));

vi.mock('react-native', () => ({
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/skeleton', () => ({
  CardListSkeleton: (props: MockProps) => React.createElement('card-list-skeleton', props),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  CreatorAvatar: (props: MockProps) => React.createElement('creator-avatar', props),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
}));

vi.mock('@/lib/auth', () => ({
  useAuth: () => ({
    user: state.user,
    api: { listBlockedUsers: state.listBlockedUsers, unblockUser: state.unblockUser },
  }),
}));

vi.mock('@/lib/dialog', () => ({
  showConfirmDialog: state.showConfirmDialog,
  showErrorDialog: state.showErrorDialog,
}));

vi.mock('@/lib/haptics', () => ({
  haptic: { success: state.hapticSuccess, error: state.hapticError },
}));

import BlockedUsersScreen from '../app/blocked-users';

function renderScreen() {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(React.createElement(BlockedUsersScreen));
  });
  return tree;
}

const listOf = (blockedUsers: BlockedUser[], hasMore = false): BlockedList => ({ success: true, blockedUsers, hasMore });
const byType = (tree: renderer.ReactTestRenderer, type: string) => tree.root.findAll((node) => String(node.type) === type);
/** The rows drawn, in order, each by the name on it. */
const rowNames = (tree: renderer.ReactTestRenderer) => byType(tree, 'card').map((row) => textOf(row)[0]);
/** An unblock the test answers when it chooses to. */
function heldUnblocks() {
  const held = new Map<string, { agree: () => void; refuse: (error: Error) => void }>();
  state.unblockUser.mockImplementation((userId: string) => new Promise((resolve, reject) => {
    held.set(userId, { agree: () => resolve({ success: true as const, blocked: false }), refuse: reject });
  }));
  return held;
}
async function settle(answer: () => void) {
  await renderer.act(async () => {
    answer();
    await Promise.resolve();
    await Promise.resolve();
  });
}
const textOf = (node: renderer.ReactTestInstance) => node.findAll((child) => String(child.type) === 'text')
  .map((child) => [child.props.children].flat().join(''));

async function pressUnblock(tree: renderer.ReactTestRenderer, index = 0) {
  await renderer.act(async () => {
    await (byType(tree, 'secondary-button')[index].props.onPress as () => Promise<void> | void)();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  state.user = { id: 'user-1' };
  state.query = { isPending: false, isError: false, error: null, data: listOf([first, second]), refetch: vi.fn() };
  state.queryOptions = null;
  state.setQueryData.mockClear();
  state.invalidateQueries.mockClear();
  state.unblockUser.mockReset();
  state.unblockUser.mockResolvedValue({ success: true, blocked: false });
  state.routerPush.mockClear();
  state.showConfirmDialog.mockReset();
  state.showConfirmDialog.mockResolvedValue(true);
  state.showErrorDialog.mockClear();
  state.hapticSuccess.mockClear();
  state.hapticError.mockClear();
});

// A block could not be taken back in the app: a blocked creator is left out of
// every feed, search and profile that would show them.
describe('Settings → Blocked users', () => {
  it("reads the signed-in account's own list", () => {
    renderScreen();

    expect(state.queryOptions).toMatchObject({ queryKey: ['blocked-users', 'user-1'], enabled: true });
    expect(state.queryOptions?.queryFn).toBe(state.listBlockedUsers);
  });

  it('draws each person with their picture, name, handle and the day they were blocked', () => {
    const tree = renderScreen();
    const rows = byType(tree, 'card');

    expect(rows).toHaveLength(2);
    expect(rows[0].findByType('creator-avatar' as never).props).toMatchObject({ uri: first.avatar, name: 'First Creator', size: 44 });
    expect(textOf(rows[0])).toEqual(['First Creator', '@first-creator', 'Blocked Oct 10, 2026']);
    // No handle and no readable day: the name alone.
    expect(textOf(rows[1])).toEqual(['No Handle']);
  });

  it('gives each row a button that says whom it unblocks to a screen reader', () => {
    const buttons = byType(renderScreen(), 'secondary-button');

    expect(buttons.map((button) => button.props.label)).toEqual(['Unblock', 'Unblock']);
    expect(buttons.map((button) => button.props.accessibilityHint)).toEqual(['Unblocks @first-creator.', 'Unblocks No Handle.']);
  });

  it('asks first, then unblocks and reads the emptied lists afresh', async () => {
    const tree = renderScreen();

    await pressUnblock(tree);

    expect(state.showConfirmDialog).toHaveBeenCalledWith({
      title: 'Unblock @first-creator?',
      message: 'Their posts will return to your feeds, and you can follow each other again.',
      confirmLabel: 'Unblock',
    });
    expect(state.unblockUser).toHaveBeenCalledWith('creator-1');
    expect(state.hapticSuccess).toHaveBeenCalledTimes(1);
    expect(rowNames(tree)).toEqual(['No Handle']);
    // The saved list loses them too, for the next time the screen opens.
    expect(state.setQueryData).toHaveBeenCalledTimes(1);
    const [key, update] = state.setQueryData.mock.calls[0] as [unknown, (current: BlockedList | undefined) => BlockedList | undefined];
    expect(key).toEqual(['blocked-users', 'user-1']);
    expect(update(listOf([first, second]))?.blockedUsers).toEqual([second]);
    // The lists a block emptied, and not the list of blocks itself: it is whole, and already right.
    expect(state.invalidateQueries.mock.calls.map(([filter]) => filter.queryKey)).toEqual([
      ['showcase-feed'],
      ['immersive-preview-source'],
      ['profile-saved-media', 'user-1'],
    ]);
    expect(state.showErrorDialog).not.toHaveBeenCalled();
  });

  // A button that waits on the network reads as a tap that did not land (the
  // first version held every button and renamed the pressed one, which also
  // pushed the name beside it about on the emulator).
  it('takes the row away the moment the answer is given, before the server has replied', async () => {
    const held = heldUnblocks();
    const tree = renderScreen();

    await pressUnblock(tree);

    expect(rowNames(tree)).toEqual(['No Handle']);
    expect(state.hapticSuccess).not.toHaveBeenCalled();
    // Nothing is held meanwhile: another person can be unblocked at once.
    expect(byType(tree, 'secondary-button').map((button) => [button.props.label, button.props.disabled]))
      .toEqual([['Unblock', undefined]]);
    // The saved list waits for the server's word.
    expect(state.setQueryData).not.toHaveBeenCalled();

    await settle(() => held.get('creator-1')!.agree());
    expect(state.hapticSuccess).toHaveBeenCalledTimes(1);
    expect(state.setQueryData).toHaveBeenCalledTimes(1);
    expect(rowNames(tree)).toEqual(['No Handle']);
  });

  it('sends nothing when the question is declined', async () => {
    state.showConfirmDialog.mockResolvedValue(false);
    const tree = renderScreen();

    await pressUnblock(tree, 1);

    expect(state.showConfirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: 'Unblock No Handle?' }));
    expect(state.unblockUser).not.toHaveBeenCalled();
    expect(state.setQueryData).not.toHaveBeenCalled();
    expect(state.invalidateQueries).not.toHaveBeenCalled();
    expect(rowNames(tree)).toEqual(['First Creator', 'No Handle']);
  });

  it('draws the row again where it was, and says why, when the unblock fails', async () => {
    const failure = new Error('Failed to unblock user.');
    const held = heldUnblocks();
    const tree = renderScreen();

    await pressUnblock(tree);
    expect(rowNames(tree)).toEqual(['No Handle']);
    await settle(() => held.get('creator-1')!.refuse(failure));

    expect(rowNames(tree)).toEqual(['First Creator', 'No Handle']);
    expect(state.showErrorDialog).toHaveBeenCalledWith('Could not unblock', failure);
    expect(state.hapticError).toHaveBeenCalledTimes(1);
    expect(state.hapticSuccess).not.toHaveBeenCalled();
    // Nobody was unblocked: nothing saved is changed, and nothing is read again.
    expect(state.setQueryData).not.toHaveBeenCalled();
    expect(state.invalidateQueries).not.toHaveBeenCalled();
  });

  // Reading the list again on a failure went wrong here: the answer still held
  // the second person, whose unblock was on its way, and drew them again for good.
  it('keeps the order, and keeps the other row out, when one unblock is refused while another is with the server', async () => {
    const third: BlockedUser = { ...first, id: 'creator-3', username: 'third-creator', name: 'Third Creator' };
    state.query.data = listOf([first, second, third]);
    const held = heldUnblocks();
    const tree = renderScreen();

    await pressUnblock(tree);
    await pressUnblock(tree);
    expect(rowNames(tree)).toEqual(['Third Creator']);

    await settle(() => held.get('creator-1')!.refuse(new Error('Failed to unblock user.')));
    expect(rowNames(tree)).toEqual(['First Creator', 'Third Creator']);

    await settle(() => held.get('creator-2')!.agree());
    expect(rowNames(tree)).toEqual(['First Creator', 'Third Creator']);
    expect(state.invalidateQueries.mock.calls.map(([filter]) => filter.queryKey)).not.toContainEqual(['blocked-users', 'user-1']);
  });

  it('says so when nobody is blocked', () => {
    state.query.data = listOf([]);
    const tree = renderScreen();

    expect(byType(tree, 'card')).toHaveLength(0);
    expect(byType(tree, 'status-block')[0].props).toMatchObject({
      title: 'You have not blocked anyone',
      body: 'Block someone from the menu on their post or their profile, and they will be listed here.',
    });
  });

  it('shows a skeleton that says what is loading', () => {
    state.query = { ...state.query, isPending: true, data: undefined };
    const tree = renderScreen();

    expect(byType(tree, 'card-list-skeleton')[0].props).toMatchObject({ label: 'Loading blocked users' });
    expect(byType(tree, 'status-block')).toHaveLength(0);
  });

  // An empty list would say "you have blocked nobody".
  it('says the list could not be read, never that it is empty, and reads it again when asked', () => {
    state.query = { ...state.query, isError: true, error: new Error('Request timed out.'), data: undefined };
    const tree = renderScreen();

    expect(byType(tree, 'status-block')[0].props).toMatchObject({
      tone: 'danger',
      title: 'Could not load your blocked users',
      body: 'Request timed out.',
    });
    renderer.act(() => { (byType(tree, 'secondary-button')[0].props.onPress as () => void)(); });
    expect(byType(tree, 'secondary-button')[0].props.label).toBe('Try again');
    expect(state.query.refetch).toHaveBeenCalledTimes(1);
  });

  it('says when the list is cut at its limit', () => {
    state.query.data = listOf([first], true);
    const tree = renderScreen();

    expect(textOf(tree.root)).toContain('Showing your most recent blocks. Unblock someone to see the ones before them.');
  });

  // The note under a cut list says that unblocking someone shows the ones before them.
  it('reads a cut list again after an unblock, and never calls it empty meanwhile', async () => {
    state.query.data = listOf([first], true);
    const held = heldUnblocks();
    const tree = renderScreen();

    await pressUnblock(tree);

    // The only row shown is out, and there are earlier blocks to come.
    expect(byType(tree, 'card')).toHaveLength(0);
    expect(byType(tree, 'card-list-skeleton')[0].props).toMatchObject({ label: 'Loading blocked users' });
    expect(byType(tree, 'status-block')).toHaveLength(0);

    await settle(() => held.get('creator-1')!.agree());
    expect(state.invalidateQueries.mock.calls.map(([filter]) => filter.queryKey)).toEqual([
      ['showcase-feed'],
      ['immersive-preview-source'],
      ['profile-saved-media', 'user-1'],
      ['blocked-users', 'user-1'],
    ]);
  });

  // A screen the root stack does not name is titled by its file: "blocked-users".
  it('is given its title by the root stack', () => {
    const layout = readFileSync(join(__dirname, '..', 'app', '_layout.tsx'), 'utf8');

    expect(layout).toContain(`<Stack.Screen name="blocked-users" options={{ title: 'Blocked Users' }} />`);
  });

  it('asks a signed-out visitor to sign in, and reads nothing', () => {
    state.user = null;
    const tree = renderScreen();

    expect(state.queryOptions).toMatchObject({ queryKey: ['blocked-users', null], enabled: false });
    expect(byType(tree, 'status-block')[0].props.title).toBe('Sign in to see whom you blocked');
    renderer.act(() => { (byType(tree, 'primary-button')[0].props.onPress as () => void)(); });
    expect(state.routerPush).toHaveBeenCalledWith('/auth');
  });
});
