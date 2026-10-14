// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;
type PayoutState = {
  availableTokenSubunits: number;
  availableUsd: string;
  minimumTokenSubunits: number;
  minimumUsd: string;
  canRequest: boolean;
};

const authState = vi.hoisted(() => ({
  accountReauthenticationMethods: ['apple'] as Array<'password' | 'google' | 'apple'>,
  api: { getCreatorPayoutState: vi.fn() },
  deleteAccount: vi.fn(),
  user: { id: 'user-1', email: 'creator@example.com' } as { id: string; email: string } | null,
}));

const payout = vi.hoisted(() => ({
  query: { data: undefined as PayoutState | undefined, isError: false, isPending: false },
  options: null as null | { queryKey: unknown; enabled: boolean; queryFn: unknown },
}));

const showMessageDialog = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { queryKey: unknown; enabled: boolean; queryFn: unknown }) => {
    payout.options = options;
    return payout.query;
  },
}));

vi.mock('expo-router', () => ({
  router: { back: vi.fn() },
}));

vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationButton: (props: MockProps) => React.createElement('apple-button', props),
  AppleAuthenticationButtonStyle: { BLACK: 'BLACK' },
  AppleAuthenticationButtonType: { CONTINUE: 'CONTINUE' },
}));

vi.mock('react-native', () => ({
  Alert: { alert: vi.fn() },
  Platform: { OS: 'ios' },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/components/ui', () => ({
  AppText: ({ children, ...props }: MockProps) => React.createElement('text', props, children),
  AppTextInput: (props: MockProps) => React.createElement('text-input', props),
  Card: ({ children, ...props }: MockProps) => React.createElement('card', props, children),
  PrimaryButton: (props: MockProps) => React.createElement('primary-button', props),
  Screen: ({ children, ...props }: MockProps) => React.createElement('screen', props, children),
  SecondaryButton: (props: MockProps) => React.createElement('secondary-button', props),
  SectionTitle: (props: MockProps) => React.createElement('section-title', props),
  StatusBlock: (props: MockProps) => React.createElement('status-block', props),
  WebLinkButton: (props: MockProps) => React.createElement('web-link-button', props),
}));

vi.mock('@/lib/auth', () => ({
  ACCOUNT_DELETION_SCHEDULED_NOTICE: {
    title: 'Your account is being deleted',
    message: 'You have been signed out.',
  },
  isAccountReauthenticationRequired: (error: unknown) => Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error.code === 'RECENT_AUTH_REQUIRED' || error.code === 'APPLE_REAUTH_REQUIRED')
  ),
  useAuth: () => authState,
}));

vi.mock('@/lib/dialog', () => ({ showMessageDialog }));

vi.mock('@/lib/env', () => ({
  env: { siteUrl: 'https://site.example' },
}));

import DeleteAccountScreen from '../app/delete-account';

function renderScreen() {
  let tree!: renderer.ReactTestRenderer;
  renderer.act(() => {
    tree = renderer.create(<DeleteAccountScreen />);
  });
  return tree;
}

async function requestInitialDeletion(tree: renderer.ReactTestRenderer) {
  renderer.act(() => {
    tree.root.findByProps({ accessibilityLabel: 'Type DELETE to confirm' }).props.onChangeText('DELETE');
  });
  await renderer.act(async () => {
    tree.root.findByProps({ label: 'Permanently delete account' }).props.onPress();
  });
}

const byType = (tree: renderer.ReactTestRenderer, type: string) => tree.root.findAll((node) => String(node.type) === type);
const texts = (tree: renderer.ReactTestRenderer) => byType(tree, 'text').map((node) => [node.props.children].flat().join(''));

beforeEach(() => {
  authState.accountReauthenticationMethods = ['apple'];
  authState.user = { id: 'user-1', email: 'creator@example.com' };
  authState.deleteAccount.mockReset();
  payout.query = { data: undefined, isError: false, isPending: false };
  payout.options = null;
  showMessageDialog.mockReset();
});

describe('DeleteAccountScreen reauthentication', () => {
  beforeEach(() => {
    authState.deleteAccount
      .mockRejectedValueOnce(Object.assign(new Error('Sign in again.'), {
        code: 'RECENT_AUTH_REQUIRED',
      }))
      .mockResolvedValue('scheduled');
  });

  it('continues deletion with a fresh Apple authorization', async () => {
    const tree = renderScreen();

    await requestInitialDeletion(tree);
    expect(tree.root.findAllByProps({ label: 'Permanently delete account' })).toHaveLength(0);

    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Continue with Apple and delete' }).props.onPress();
    });

    expect(authState.deleteAccount.mock.calls).toEqual([
      [undefined],
      [{ method: 'apple' }],
    ]);
  });

  it('shows a recoverable error instead of silently looping after repeated reauthentication', async () => {
    authState.deleteAccount.mockReset();
    authState.deleteAccount
      .mockRejectedValueOnce(Object.assign(new Error('Sign in again.'), {
        code: 'RECENT_AUTH_REQUIRED',
      }))
      .mockRejectedValueOnce(Object.assign(new Error('Apple verification did not complete.'), {
        code: 'APPLE_REAUTH_REQUIRED',
      }));
    const tree = renderScreen();

    await requestInitialDeletion(tree);
    await renderer.act(async () => {
      tree.root.findByProps({ accessibilityLabel: 'Continue with Apple and delete' }).props.onPress();
    });

    const status = tree.root.findByProps({ title: 'Account was not deleted' });
    expect(status.props).toMatchObject({
      tone: 'danger',
      title: 'Account was not deleted',
    });
    expect(status.props.body).toContain(
      'Apple verification did not complete.',
    );
    expect(tree.root.findByProps({ accessibilityLabel: 'Continue with Apple and delete' })).toBeTruthy();
  });

  it('collects the current password inline and continues deletion', async () => {
    authState.accountReauthenticationMethods = ['password'];
    const tree = renderScreen();

    await requestInitialDeletion(tree);
    renderer.act(() => {
      tree.root.findByProps({ accessibilityLabel: 'Current password for account deletion' })
        .props.onChangeText('current-password');
    });
    await renderer.act(async () => {
      tree.root.findByProps({ label: 'Verify password and delete' }).props.onPress();
    });

    expect(authState.deleteAccount.mock.calls[1]).toEqual([
      { method: 'password', password: 'current-password' },
    ]);
  });

  it('continues deletion through Google OAuth when that identity owns the account', async () => {
    authState.accountReauthenticationMethods = ['google'];
    const tree = renderScreen();

    await requestInitialDeletion(tree);
    await renderer.act(async () => {
      tree.root.findByProps({ label: 'Continue with Google and delete' }).props.onPress();
    });

    expect(authState.deleteAccount.mock.calls[1]).toEqual([{ method: 'google' }]);
  });
});

// The server answers 202 once the account is locked and signed out everywhere;
// a 409 ACCOUNT_DELETING, a 500 after the lock and a timeout mean the same, and
// the auth provider resolves all of them as `scheduled` (account-deletion-session
// test). The screen used to say "Your account is still active" for most of them
// (audit 04-2).
describe('DeleteAccountScreen answers', () => {
  it('says the account is being deleted and the person signed out, once the server has scheduled it', async () => {
    authState.deleteAccount.mockResolvedValue('scheduled');
    const tree = renderScreen();

    await requestInitialDeletion(tree);

    expect(showMessageDialog).toHaveBeenCalledOnce();
    expect(showMessageDialog).toHaveBeenCalledWith({
      title: 'Your account is being deleted',
      message: 'You have been signed out.',
    });
    expect(tree.root.findAllByProps({ title: 'Account was not deleted' })).toHaveLength(0);
  });

  it('says deleted when the server had already finished', async () => {
    authState.deleteAccount.mockResolvedValue('deleted');
    const tree = renderScreen();

    await requestInitialDeletion(tree);

    // No navigation of its own: the provider has moved the phone to Home once.
    expect(showMessageDialog).toHaveBeenCalledWith({
      title: 'Account deleted',
      message: 'Your Magicbooklet account and personal data were permanently deleted.',
    });
  });

  it('says "not deleted", and offers the button again, only for an answer that left the account untouched', async () => {
    authState.deleteAccount.mockRejectedValue(Object.assign(
      new Error('Account deletion could not be completed. Please try again.'),
      { status: 500, code: 'ACCOUNT_DELETION_NOT_STARTED' },
    ));
    const tree = renderScreen();

    await requestInitialDeletion(tree);

    const status = tree.root.findByProps({ title: 'Account was not deleted' });
    expect(status.props.body).toBe(
      'Account deletion could not be completed. Please try again. Your account is still active. You can retry below.',
    );
    expect(showMessageDialog).not.toHaveBeenCalled();
    expect(tree.root.findByProps({ label: 'Permanently delete account' }).props).toMatchObject({ loading: false });
  });
});

describe('DeleteAccountScreen warnings', () => {
  const sellerWith = (overrides: Partial<PayoutState>): PayoutState => ({
    availableTokenSubunits: 2_500_000,
    availableUsd: '$250.00',
    minimumTokenSubunits: 1_000_000,
    minimumUsd: '$100.00',
    canRequest: true,
    ...overrides,
  });

  it("reads the signed-in account's own balance", () => {
    renderScreen();
    expect(payout.options).toMatchObject({ queryKey: ['creator-payouts', 'user-1'], enabled: true });
    expect(payout.options?.queryFn).toBe(authState.api.getCreatorPayoutState);

    authState.user = null;
    renderScreen();
    expect(payout.options).toMatchObject({ queryKey: ['creator-payouts', null], enabled: false });
  });

  it('names what goes with the account, and what buyers keep, whatever the balance', () => {
    const lines = texts(renderScreen());

    expect(lines).toContain('• Your public posts and comments');
    expect(lines).toContain('People who bought your recipes keep them.');
  });

  it('names the unpaid balance it forfeits, and the way to be paid first, when a payout can be requested', () => {
    payout.query = { data: sellerWith({}), isError: false, isPending: false };
    const tree = renderScreen();

    expect(byType(tree, 'status-block')[0].props).toMatchObject({
      tone: 'warning',
      title: 'Unpaid sales earnings of $250.00 will be forfeited',
      body: 'Request a payout on the website before you delete your account.',
    });
    const links = byType(tree, 'web-link-button').map((node) => [node.props.label, node.props.href]);
    expect(links).toContainEqual(['Request a payout first', 'https://site.example/marketplace/sell']);
  });

  it('says why a balance under the minimum cannot be paid out, with no payout link', () => {
    payout.query = {
      data: sellerWith({ availableTokenSubunits: 450_000, availableUsd: '$45.00', canRequest: false }),
      isError: false,
      isPending: false,
    };
    const tree = renderScreen();

    expect(byType(tree, 'status-block')[0].props).toMatchObject({
      title: 'Unpaid sales earnings of $45.00 will be forfeited',
      body: 'Payouts start at $100.00, so this balance cannot be paid out.',
    });
    expect(byType(tree, 'web-link-button').map((node) => node.props.label)).not.toContain('Request a payout first');
  });

  it('says nothing about earnings when there are none, or while the balance is read', () => {
    payout.query = { data: sellerWith({ availableTokenSubunits: 0, availableUsd: '$0.00', canRequest: false }), isError: false, isPending: false };
    expect(byType(renderScreen(), 'status-block')).toHaveLength(0);

    payout.query = { data: undefined, isError: false, isPending: true };
    expect(byType(renderScreen(), 'status-block')).toHaveLength(0);
  });

  it('warns in general terms, with the payout link, when the balance could not be read', () => {
    payout.query = { data: undefined, isError: true, isPending: false };
    const tree = renderScreen();

    expect(byType(tree, 'status-block')[0].props).toMatchObject({
      tone: 'warning',
      title: 'Unpaid sales earnings will be forfeited',
    });
    expect(byType(tree, 'web-link-button').map((node) => node.props.label)).toContain('Request a payout first');
  });

  // Deletion is never held up by a balance (App Store 5.1.1(v)).
  it('never holds the deletion up while the balance is read', async () => {
    payout.query = { data: undefined, isError: false, isPending: true };
    authState.deleteAccount.mockResolvedValue('scheduled');
    const tree = renderScreen();

    await requestInitialDeletion(tree);

    expect(authState.deleteAccount).toHaveBeenCalledOnce();
  });
});
