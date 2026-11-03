import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ session: { access_token: 'first-session', expires_at: 10, user: { id: 'owner' } } }));
vi.mock('@/lib/auth', () => ({ useAuth: () => auth }));
vi.mock('@/lib/env', () => ({ env: { apiBaseUrl: 'https://magicbooklet.com', supabaseUrl: 'https://project.supabase.co' } }));
const appState = vi.hoisted(() => ({ current: 'active', listeners: new Set<(state: string) => void>() }));
vi.mock('react-native', () => ({
  AppState: {
    get currentState() { return appState.current; },
    addEventListener: (_type: string, listener: (state: string) => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));
import { useMediaSource } from '../lib/use-media-source';

function setAppState(state: string) {
  appState.current = state;
  appState.listeners.forEach((listener) => listener(state));
}

describe('media source session renewal', () => {
  afterEach(() => vi.useRealTimers());

  it('reschedules long-lived URLs after the native timer maximum instead of losing expiry recovery', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const expiresAt = 30 * 24 * 60 * 60 * 1000;
    const token = `head.${Buffer.from(JSON.stringify({ exp: expiresAt / 1000 })).toString('base64url')}.signature`;
    const url = `https://project.supabase.co/storage/v1/object/sign/generated_images/owner/preview.webp?token=${token}`;
    let result: ReturnType<typeof useMediaSource>;
    function Probe() { result = useMediaSource(url); return null; }
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Probe />); });
    renderer.act(() => { vi.advanceTimersByTime(2_147_483_647); });
    expect(result!.source.uri).toBe(url);
    renderer.act(() => { vi.advanceTimersByTime(expiresAt - 30_000 - 2_147_483_647); });
    expect(new URL(result!.source.uri).pathname).toBe('/api/media');
    renderer.act(() => tree.unmount());
  });

  // Android times a wait by a clock that stops while the phone sleeps
  // (`JavaTimerManager`): back from a sleep past the address's end, no timer has
  // fired yet, and the wall clock is all that says the address has ended.
  it('moves to the route as the app comes back after a sleep that outlasted the address', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const token = `head.${Buffer.from(JSON.stringify({ exp: 3600 })).toString('base64url')}.signature`;
    const url = `https://project.supabase.co/storage/v1/object/sign/generated_images/owner/slept.webp?token=${token}`;
    let result: ReturnType<typeof useMediaSource>;
    function Probe() { result = useMediaSource(url); return null; }
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Probe />); });
    expect(result!.source.uri).toBe(url);

    renderer.act(() => setAppState('background'));
    // The phone sleeps for two hours: the wall clock moves, the timers do not.
    vi.setSystemTime(2 * 60 * 60 * 1000);
    renderer.act(() => setAppState('active'));
    renderer.act(() => { vi.advanceTimersByTime(0); });

    expect(new URL(result!.source.uri).pathname).toBe('/api/media');
    renderer.act(() => tree.unmount());
    expect(appState.listeners.size).toBe(0);
  });

  it('recovers a mounted signed URL at expiry without a library refetch', () => {
    vi.useFakeTimers();
    vi.setSystemTime(900_000);
    const token = `head.${Buffer.from(JSON.stringify({ exp: 1000 })).toString('base64url')}.signature`;
    const url = `https://project.supabase.co/storage/v1/object/sign/generated_images/owner/preview.webp?token=${token}`;
    let result: ReturnType<typeof useMediaSource>;
    function Probe() { result = useMediaSource(url); return null; }
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Probe />); });
    expect(result!.source.uri).toBe(url);
    renderer.act(() => { vi.advanceTimersByTime(70_000); });
    expect(new URL(result!.source.uri).pathname).toBe('/api/media');
    expect(result!.source.headers?.Authorization).toBeTruthy();
    renderer.act(() => tree.unmount());
  });

  // Every image on screen re-renders with its list. Dating its address, building
  // the route and asking whether it is one used to happen on each of those
  // renders: on Android 15–25% of the JS a tab switch ran (2026-11-03).
  it('works an address out once, so a render that changes nothing parses no URL and decodes no token', () => {
    vi.useFakeTimers();
    vi.setSystemTime(900_000);
    const signedUntil = (exp: number, file = 'preview') =>
      `https://project.supabase.co/storage/v1/object/sign/generated_images/owner/${file}.webp?token=head.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.signature`;
    const url = signedUntil(1000);
    let result: ReturnType<typeof useMediaSource>;
    function Probe({ url: address }: { url: string; render: number }) { result = useMediaSource(address); return null; }
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Probe url={url} render={0} />); });

    const RealURL = globalThis.URL;
    const decode = vi.spyOn(globalThis, 'atob');
    let parsed = 0;
    globalThis.URL = class extends RealURL {
      constructor(...args: ConstructorParameters<typeof URL>) {
        super(...args);
        parsed += 1;
      }
    } as typeof URL;
    const rerender = (address: string, times: number) => {
      for (let render = 1; render <= times; render += 1) {
        renderer.act(() => { tree.update(<Probe url={address} render={render} />); });
      }
    };
    try {
      rerender(url, 20);
      expect(parsed).toBe(0);
      expect(decode).not.toHaveBeenCalled();
      expect(result!.source.uri).toBe(url);

      // At its end it moves to the route, and stays as cheap there.
      renderer.act(() => { vi.advanceTimersByTime(70_000); });
      expect(new URL(result!.source.uri).pathname).toBe('/api/media');
      parsed = 0;
      decode.mockClear();
      rerender(url, 20);
      expect(parsed).toBe(0);
      expect(decode).not.toHaveBeenCalled();

      // A new address is worked out, once.
      const next = signedUntil(5000, 'next');
      rerender(next, 1);
      expect(parsed).toBeGreaterThan(0);
      expect(decode).toHaveBeenCalledTimes(1);
      expect(result!.source.uri).toBe(next);
      parsed = 0;
      rerender(next, 20);
      expect(parsed).toBe(0);
      expect(decode).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.URL = RealURL;
      decode.mockRestore();
    }
    renderer.act(() => tree.unmount());
  });

  it('sends an address that arrives within 30 s of its end to the route from its first render', () => {
    vi.useFakeTimers();
    vi.setSystemTime(975_000);
    const token = `head.${Buffer.from(JSON.stringify({ exp: 1000 })).toString('base64url')}.signature`;
    const url = `https://project.supabase.co/storage/v1/object/sign/generated_images/owner/late.webp?token=${token}`;
    const seen: string[] = [];
    function Probe() { seen.push(useMediaSource(url).source.uri); return null; }
    let tree: renderer.ReactTestRenderer;
    renderer.act(() => { tree = renderer.create(<Probe />); });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((uri) => new URL(uri).pathname === '/api/media')).toBe(true);
    renderer.act(() => tree.unmount());
  });

  it('updates private credentials and retry identity while leaving public sources stable', () => {
    const seen: ReturnType<typeof useMediaSource>[] = [];
    function Probe({ url }: { url: string }) {
      seen.push(useMediaSource(url));
      return null;
    }
    let tree: renderer.ReactTestRenderer;
    const proxy = 'https://magicbooklet.com/api/media?path=preview.webp';
    renderer.act(() => { tree = renderer.create(<Probe url={proxy} />); });
    const before = seen.at(-1)!;
    auth.session = { ...auth.session, access_token: 'renewed-session', expires_at: 20 };
    renderer.act(() => { tree.update(<Probe url={proxy} />); });
    const after = seen.at(-1)!;
    expect(after.source.headers).toEqual({ Authorization: 'Bearer renewed-session' });
    expect(after.requestKey).not.toBe(before.requestKey);
    expect(after.requestKey).not.toContain('session');
    renderer.act(() => { tree.update(<Probe url="https://cdn.example.com/image.webp" />); });
    const publicBefore = seen.at(-1)!;
    auth.session = { ...auth.session, access_token: 'third-session', expires_at: 30 };
    renderer.act(() => { tree.update(<Probe url="https://cdn.example.com/image.webp" />); });
    expect(seen.at(-1)!.source).toBe(publicBefore.source);
    expect(seen.at(-1)!.source.headers).toBeUndefined();
    renderer.act(() => tree.unmount());
  });
});
