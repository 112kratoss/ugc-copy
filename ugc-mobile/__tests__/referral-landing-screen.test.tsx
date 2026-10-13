import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const routerState = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
const paramsState = vi.hoisted(() => ({ params: {} as { code?: string; next?: string } }));
const authState = vi.hoisted(() => ({ api: {}, user: null, isLoading: false }));

vi.mock('expo-router', () => ({
  router: routerState,
  useLocalSearchParams: () => paramsState.params,
}));

vi.mock('react-native', () => ({
  View: ({ children, ...props }: MockProps) => React.createElement('view', props, children),
}));

vi.mock('lucide-react-native', () => {
  const icon = (name: string) => (props: MockProps) => React.createElement(name, props);
  return {
    CheckCircle2: icon('check-icon'),
    Gift: icon('gift-icon'),
    Link2: icon('link-icon'),
    ShieldCheck: icon('shield-icon'),
    UserPlus: icon('user-plus-icon'),
  };
});

vi.mock('@/components/ui', () => {
  const text = ({ children }: MockProps) => React.createElement('text', null, children);
  const box = ({ children }: MockProps) => React.createElement('view', null, children);
  return {
    AppText: text,
    Card: box,
    Screen: box,
    PrimaryButton: ({ label }: { label: string }) => React.createElement('button', { label }),
    SecondaryButton: ({ label }: { label: string }) => React.createElement('button', { label }),
    SectionTitle: ({ title, body }: { title: string; body?: string }) => React.createElement('view', null,
      React.createElement('text', null, title),
      body ? React.createElement('text', null, body) : null),
    StatusBlock: ({ title, body }: { title: string; body?: string }) => React.createElement('view', null,
      React.createElement('text', null, title),
      body ? React.createElement('text', null, body) : null),
  };
});

vi.mock('@/lib/auth', () => ({ useAuth: () => authState }));

vi.mock('@/lib/referral-attribution', () => ({
  capturePendingReferral: vi.fn(),
  claimPendingReferral: vi.fn(),
  getPendingReferral: vi.fn(async () => null),
  getRecentReferralClaim: vi.fn(async () => null),
  normalizeReferralCode: (value: string | null | undefined) => value?.trim() || null,
}));

import ReferralLandingScreen from '../app/r/[code]';

function texts(tree: renderer.ReactTestRenderer) {
  return tree.root
    .findAll((node) => String(node.type) === 'text' && typeof node.props.children === 'string')
    .map((node) => node.props.children as string);
}

describe('the invite landing screen', () => {
  // The app creates images, videos and motion; audio and workflows exist only
  // in the web's workflow builder, so the bonus line promised what it cannot do.
  it('promises only what the app creates', async () => {
    paramsState.params = {};
    let tree: renderer.ReactTestRenderer | undefined;
    await renderer.act(async () => {
      tree = renderer.create(<ReferralLandingScreen />);
      await Promise.resolve();
    });

    const values = texts(tree!);
    expect(values).toContain('Create images, videos and motion with your bonus credits.');
    expect(values.some((value) => /workflow|audio|prompts/i.test(value))).toBe(false);
    renderer.act(() => tree!.unmount());
  });
});
