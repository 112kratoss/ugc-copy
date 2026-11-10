(global as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type MockProps = { children?: React.ReactNode } & Record<string, unknown>;

const state = vi.hoisted(() => ({
  params: {} as Record<string, string | string[] | undefined>,
  inviteShareCapture: vi.fn(),
}));

vi.mock('expo-router', () => ({
  Redirect: (props: MockProps) => React.createElement('redirect', props),
  useLocalSearchParams: () => state.params,
}));
vi.mock('@/components/creator-profile-screen', () => ({
  CreatorProfileScreen: (props: MockProps) => React.createElement('creator-profile-screen', props),
}));
// The hook's own rules are in use-invite-share-capture.test.tsx. Here: what
// the creator page asks of it.
vi.mock('@/lib/use-invite-share-capture', () => ({ useInviteShareCapture: state.inviteShareCapture }));

import CreatorProfileRoute from '../app/creators/[username]';

const CODE = '30b5f916c7aa';

function open(params: Record<string, string | string[] | undefined>) {
  state.params = params;
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(React.createElement(CreatorProfileRoute));
  });
  return tree;
}

beforeEach(() => {
  state.inviteShareCapture.mockReset();
});

describe('a shared profile link opened in the app', () => {
  it("hands the link's invite to the capture with the profile's own web path", () => {
    const tree = open({ username: 'luna', s: 'profile', r: CODE });

    expect(state.inviteShareCapture).toHaveBeenLastCalledWith(CODE, '/creators/luna');
    expect(tree.root.findByType('creator-profile-screen' as never).props.username).toBe('luna');
  });

  it('names the path as the web serves it for a handle that needs encoding', () => {
    open({ username: 'a b', r: CODE });
    expect(state.inviteShareCapture).toHaveBeenLastCalledWith(CODE, '/creators/a%20b');

    open({ username: ['nova', 'other'], r: [CODE] });
    expect(state.inviteShareCapture).toHaveBeenLastCalledWith([CODE], '/creators/nova');
  });

  it('tells the capture there is no invite on an in-app open', () => {
    open({ username: 'luna' });
    expect(state.inviteShareCapture).toHaveBeenLastCalledWith(undefined, '/creators/luna');
  });

  it('gives the capture no path when the link names no creator', () => {
    const tree = open({ r: CODE });

    expect(state.inviteShareCapture).toHaveBeenLastCalledWith(CODE, null);
    expect(tree.root.findByType('redirect' as never).props.href).toBe('/(tabs)/showcase');
  });
});
