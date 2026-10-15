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

const platformState = vi.hoisted(() => ({ os: 'ios' }));

// The provider's own class, as the screen imports it from the mocked module.
const ReauthenticationFailed = vi.hoisted(() => class AccountReauthenticationFailedError extends Error {
  constructor(
    readonly method: 'password' | 'google' | 'apple',
    readonly failure: unknown,
  ) {
    super(failure instanceof Error ? failure.message : 'Sign-in verification failed.');
  }
});

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
  Platform: {
    get OS() {
      return platformState.os;
    },
  },
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('@/lib/apple-auth', () => ({
  isAppleAuthCanceled: (error: unknown) => (error as { code?: unknown } | null)?.code === 'ERR_REQUEST_CANCELED',
}));
vi.mock('@/lib/google-auth', () => ({
  isGoogleAuthCanceled: (error: unknown) => (error as { code?: unknown } | null)?.code === 'ERR_GOOGLE_AUTH_CANCELED',
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
  AccountReauthenticationFailedError: ReauthenticationFailed,
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
  platformState.os = 'ios';
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

  // Decision D1: Google is a way in on both phones, so an account with a
  // Google identity confirms its deletion with Google on either.
  it.each(['ios', 'android'])('offers Google, and nothing it does not have, to a Google account on %s', async (os) => {
    platformState.os = os;
    authState.accountReauthenticationMethods = ['google'];
    const tree = renderScreen();

    await requestInitialDeletion(tree);

    const secondaryLabels = byType(tree, 'secondary-button').map((node) => node.props.label);
    expect(secondaryLabels).toContain('Continue with Google and delete');
    expect(byType(tree, 'apple-button')).toHaveLength(0);
    expect(tree.root.findAllByProps({ accessibilityLabel: 'Current password for account deletion' })).toHaveLength(0);
    expect(byType(tree, 'status-block').map((node) => node.props.title)).not.toContain('Use the original sign-in device');

    await renderer.act(async () => {
      byType(tree, 'secondary-button')
        .find((node) => node.props.label === 'Continue with Google and delete')!
        .props.onPress();
    });

    expect(authState.deleteAccount.mock.calls).toEqual([[undefined], [{ method: 'google' }]]);
    expect(showMessageDialog).toHaveBeenCalledWith({
      title: 'Your account is being deleted',
      message: 'You have been signed out.',
    });
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
      {
        status: 500,
        code: 'ACCOUNT_DELETION_NOT_STARTED',
        details: {
          error: 'Account deletion could not be completed. Please try again.',
          code: 'ACCOUNT_DELETION_NOT_STARTED',
          deletionScheduled: false,
        },
      },
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

// Audit 04-3: a lost answer that Supabase could not settle either way.
describe('DeleteAccountScreen when the deletion cannot be confirmed', () => {
  it('says so, in the web\'s words, without claiming the account survived, and offers the button again', async () => {
    authState.deleteAccount.mockResolvedValue('unconfirmed');
    const tree = renderScreen();

    await requestInitialDeletion(tree);

    const status = tree.root.findByProps({ title: 'Deletion not confirmed' });
    expect(status.props).toMatchObject({
      tone: 'warning',
      body: 'We could not confirm the deletion. Check the connection and try again.',
    });
    expect(JSON.stringify(tree.toJSON())).not.toContain('still active');
    expect(showMessageDialog).not.toHaveBeenCalled();
    expect(tree.root.findByProps({ label: 'Permanently delete account' }).props).toMatchObject({ loading: false });
  });

  it('names no server text for a refused session that Supabase says is still alive', async () => {
    authState.deleteAccount.mockRejectedValue(Object.assign(new Error('Unauthorized'), {
      status: 401,
      details: { error: 'Unauthorized', code: 'UNAUTHORIZED' },
    }));
    const tree = renderScreen();

    await requestInitialDeletion(tree);

    expect(tree.root.findByProps({ title: 'Account was not deleted' }).props.body).toBe(
      'The deletion did not go through. Your account is still active. You can retry below.',
    );
  });

  it('names no bare status for a platform failure with no JSON', async () => {
    authState.deleteAccount.mockRejectedValue(Object.assign(new Error('Request failed with status 502'), {
      status: 502,
      details: '<html>Bad Gateway</html>',
    }));
    const tree = renderScreen();

    await requestInitialDeletion(tree);

    expect(tree.root.findByProps({ title: 'Account was not deleted' }).props.body).not.toContain('status 502');
  });
});

// Audit 01-7 / 01-8: the sign-in that confirms the deletion fails in the
// sign-in screen's words, naming only the ways in this screen draws.
describe('DeleteAccountScreen sign-in failures', () => {
  async function failReauthentication(
    tree: renderer.ReactTestRenderer,
    method: 'password' | 'google' | 'apple',
    failure: unknown,
  ) {
    authState.deleteAccount.mockReset();
    authState.deleteAccount
      .mockRejectedValueOnce(Object.assign(new Error('Sign in again.'), { code: 'RECENT_AUTH_REQUIRED' }))
      .mockRejectedValueOnce(new ReauthenticationFailed(method, failure));
    await requestInitialDeletion(tree);
    await renderer.act(async () => {
      if (method === 'password') {
        tree.root.findByProps({ accessibilityLabel: 'Current password for account deletion' })
          .props.onChangeText('wrong-Horse-1');
      }
    });
    await renderer.act(async () => {
      if (method === 'password') tree.root.findByProps({ label: 'Verify password and delete' }).props.onPress();
      if (method === 'google') tree.root.findByProps({ label: 'Continue with Google and delete' }).props.onPress();
      if (method === 'apple') tree.root.findByProps({ accessibilityLabel: 'Continue with Apple and delete' }).props.onPress();
    });
  }

  const statusBlocks = (tree: renderer.ReactTestRenderer) => byType(tree, 'status-block').map((node) => node.props);

  it('says a wrong password in words, never Supabase\'s "Invalid login credentials"', async () => {
    authState.accountReauthenticationMethods = ['password'];
    const tree = renderScreen();

    await failReauthentication(tree, 'password', new Error('Invalid login credentials'));

    expect(statusBlocks(tree)).toContainEqual(expect.objectContaining({
      tone: 'danger',
      title: 'That password does not match this account',
      body: 'Check it and try again. Your account is still active.',
    }));
    expect(JSON.stringify(tree.toJSON())).not.toContain('Invalid login credentials');
  });

  it('points at the Google button on Android only when the account has one', async () => {
    platformState.os = 'android';
    authState.accountReauthenticationMethods = ['password', 'google'];
    const tree = renderScreen();

    await failReauthentication(tree, 'password', new Error('Invalid login credentials'));

    expect(statusBlocks(tree)).toContainEqual(expect.objectContaining({
      body: 'Check it and try again. If you created the account with Google, use that button instead. Your account is still active.',
    }));
  });

  it('points at the Google button on iOS too, where the screen now draws it for such an account', async () => {
    platformState.os = 'ios';
    authState.accountReauthenticationMethods = ['password', 'google'];
    const tree = renderScreen();

    await failReauthentication(tree, 'password', new Error('Invalid login credentials'));

    expect(statusBlocks(tree)).toContainEqual(expect.objectContaining({
      body: 'Check it and try again. If you created the account with Google, use that button instead. Your account is still active.',
    }));
    expect(byType(tree, 'secondary-button').map((node) => node.props.label)).toContain('Continue with Google and delete');
  });

  it('says nothing when the person closes the Google sheet on iOS', async () => {
    platformState.os = 'ios';
    authState.accountReauthenticationMethods = ['google'];
    const tree = renderScreen();

    await failReauthentication(tree, 'google', Object.assign(new Error('Google sign-in was canceled.'), {
      code: 'ERR_GOOGLE_AUTH_CANCELED',
    }));

    expect(statusBlocks(tree)).toEqual([]);
    expect(byType(tree, 'secondary-button').map((node) => node.props.label)).toContain('Continue with Google and delete');
  });

  it('says offline, and never names a build setting, when the sign-in could not reach Supabase', async () => {
    authState.accountReauthenticationMethods = ['password'];
    const tree = renderScreen();

    // What the provider throws once it has normalised a network failure.
    await failReauthentication(tree, 'password', Object.assign(
      new Error('Could not reach Supabase auth. Check your connection and EXPO_PUBLIC_SUPABASE_URL.'),
      { code: 'network', cause: 'Network request failed' },
    ));

    expect(statusBlocks(tree)).toContainEqual(expect.objectContaining({ title: 'You appear to be offline' }));
    expect(JSON.stringify(tree.toJSON())).not.toContain('EXPO_PUBLIC');
  });

  it('offers the password after a failed Google sign-in only for an account that has one', async () => {
    authState.accountReauthenticationMethods = ['google'];
    const googleOnly = renderScreen();
    await failReauthentication(googleOnly, 'google', new Error('access_denied'));
    expect(statusBlocks(googleOnly)).toContainEqual(expect.objectContaining({
      title: 'Could not finish with Google',
      body: 'Try again. Your account is still active.',
    }));

    authState.accountReauthenticationMethods = ['password', 'google'];
    const withPassword = renderScreen();
    await failReauthentication(withPassword, 'google', new Error('access_denied'));
    expect(statusBlocks(withPassword)).toContainEqual(expect.objectContaining({
      body: 'Try again, or sign in with your email and password. Your account is still active.',
    }));
  });

  it('says nothing when the person cancels the Apple sheet', async () => {
    authState.accountReauthenticationMethods = ['apple'];
    const tree = renderScreen();

    await failReauthentication(tree, 'apple', Object.assign(new Error('The operation couldn’t be completed.'), {
      code: 'ERR_REQUEST_CANCELED',
    }));

    expect(statusBlocks(tree)).toEqual([]);
    expect(tree.root.findByProps({ accessibilityLabel: 'Continue with Apple and delete' })).toBeTruthy();
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
