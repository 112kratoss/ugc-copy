// Define React Native development globals for react-test-renderer.
(global as typeof globalThis & { __DEV__: boolean }).__DEV__ = true;
(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const authState = vi.hoisted(() => ({
  accountReauthenticationMethods: ['apple'] as Array<'password' | 'google' | 'apple'>,
  deleteAccount: vi.fn(),
  user: { id: 'user-1', email: 'creator@example.com' },
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
}));

vi.mock('@/lib/auth', () => ({
  isAccountReauthenticationRequired: (error: unknown) => Boolean(
    error
    && typeof error === 'object'
    && 'code' in error
    && (error.code === 'RECENT_AUTH_REQUIRED' || error.code === 'APPLE_REAUTH_REQUIRED')
  ),
  useAuth: () => authState,
}));

import DeleteAccountScreen from '../app/delete-account';

async function requestInitialDeletion(tree: renderer.ReactTestRenderer) {
  renderer.act(() => {
    tree.root.findByProps({ accessibilityLabel: 'Type DELETE to confirm' }).props.onChangeText('DELETE');
  });
  await renderer.act(async () => {
    tree.root.findByProps({ label: 'Permanently delete account' }).props.onPress();
  });
}

describe('DeleteAccountScreen reauthentication', () => {
  beforeEach(() => {
    authState.accountReauthenticationMethods = ['apple'];
    authState.deleteAccount.mockReset();
    authState.deleteAccount
      .mockRejectedValueOnce(Object.assign(new Error('Sign in again.'), {
        code: 'RECENT_AUTH_REQUIRED',
      }))
      .mockResolvedValue(undefined);
  });

  it('continues deletion with a fresh Apple authorization', async () => {
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<DeleteAccountScreen />);
    });

    await requestInitialDeletion(tree!);
    expect(tree!.root.findAllByProps({ label: 'Permanently delete account' })).toHaveLength(0);

    await renderer.act(async () => {
      tree!.root.findByProps({ accessibilityLabel: 'Continue with Apple and delete' }).props.onPress();
    });

    expect(authState.deleteAccount.mock.calls).toEqual([
      [undefined],
      [{ method: 'apple' }],
    ]);
  });

  it('collects the current password inline and continues deletion', async () => {
    authState.accountReauthenticationMethods = ['password'];
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<DeleteAccountScreen />);
    });

    await requestInitialDeletion(tree!);
    renderer.act(() => {
      tree!.root.findByProps({ accessibilityLabel: 'Current password for account deletion' })
        .props.onChangeText('current-password');
    });
    await renderer.act(async () => {
      tree!.root.findByProps({ label: 'Verify password and delete' }).props.onPress();
    });

    expect(authState.deleteAccount.mock.calls[1]).toEqual([
      { method: 'password', password: 'current-password' },
    ]);
  });

  it('continues deletion through Google OAuth when that identity owns the account', async () => {
    authState.accountReauthenticationMethods = ['google'];
    let tree: renderer.ReactTestRenderer | undefined;
    renderer.act(() => {
      tree = renderer.create(<DeleteAccountScreen />);
    });

    await requestInitialDeletion(tree!);
    await renderer.act(async () => {
      tree!.root.findByProps({ label: 'Continue with Google and delete' }).props.onPress();
    });

    expect(authState.deleteAccount.mock.calls[1]).toEqual([{ method: 'google' }]);
  });
});
