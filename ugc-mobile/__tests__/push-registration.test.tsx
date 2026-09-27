import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import renderer from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const notifications = vi.hoisted(() => ({ registerForMobilePushNotifications: vi.fn() }));
vi.mock('@/lib/notifications', () => notifications);

import type { MagicbookletApiClient } from '@/lib/api-client';
import { devicePushQueryKey, useDevicePushRegistration, type DevicePushRegistration } from '@/lib/push-registration';

const api = {} as MagicbookletApiClient;
const trees: renderer.ReactTestRenderer[] = [];

function renderRegistration(userId: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const latest: { current: DevicePushRegistration | null } = { current: null };
  function Probe() {
    latest.current = useDevicePushRegistration({ api, userId });
    return null;
  }
  renderer.act(() => {
    trees.push(renderer.create(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    ));
  });
  return { client, latest };
}

async function settle() {
  for (let pass = 0; pass < 3; pass += 1) {
    await renderer.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function askFirstThen(outcome: () => Promise<unknown>) {
  notifications.registerForMobilePushNotifications.mockImplementation(
    (_api: unknown, options?: { requestPermission?: boolean }) => (
      options?.requestPermission ? outcome() : Promise.resolve({ status: 'permission-required' })
    ),
  );
}

describe('useDevicePushRegistration', () => {
  beforeEach(() => {
    notifications.registerForMobilePushNotifications.mockReset();
  });

  afterEach(() => {
    renderer.act(() => {
      trees.splice(0).forEach((tree) => tree.unmount());
    });
  });

  it('checks without asking, and enabling writes the answer where every reader looks', async () => {
    askFirstThen(() => Promise.resolve({ status: 'registered', expoPushToken: 'ExponentPushToken[1]' }));
    const { client, latest } = renderRegistration('user-1');
    await settle();

    expect(notifications.registerForMobilePushNotifications).toHaveBeenCalledWith(api, { requestPermission: false });
    expect(latest.current?.result).toEqual({ status: 'permission-required' });

    renderer.act(() => {
      latest.current?.enable();
    });
    await settle();

    expect(notifications.registerForMobilePushNotifications).toHaveBeenCalledWith(api, { requestPermission: true });
    expect(client.getQueryData(devicePushQueryKey('user-1'))).toEqual({ status: 'registered', expoPushToken: 'ExponentPushToken[1]' });
    expect(latest.current?.result?.status).toBe('registered');
  });

  it('turns a failed enable into state and a log, never an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      askFirstThen(() => Promise.reject(new Error('token upload failed')));
      const { latest } = renderRegistration('user-1');
      await settle();

      renderer.act(() => {
        latest.current?.enable();
      });
      await settle();

      expect(latest.current?.enableError?.message).toBe('token upload failed');
      expect(latest.current?.isEnabling).toBe(false);
      expect(latest.current?.result).toEqual({ status: 'permission-required' });
      expect(consoleError).toHaveBeenCalledWith('Failed to register mobile push notifications', expect.any(Error));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      consoleError.mockRestore();
    }
  });

  it('lets a later check replace an earlier enable', async () => {
    askFirstThen(() => Promise.resolve({ status: 'registered', expoPushToken: 'ExponentPushToken[2]' }));
    const { client, latest } = renderRegistration('user-1');
    await settle();
    renderer.act(() => {
      latest.current?.enable();
    });
    await settle();
    expect(latest.current?.result?.status).toBe('registered');

    // The sign-in sync re-checks on every foreground; notifications have since
    // been turned off in Settings.
    renderer.act(() => {
      client.setQueryData(devicePushQueryKey('user-1'), { status: 'denied' });
    });
    await settle();

    expect(latest.current?.result).toEqual({ status: 'denied' });
  });

  it('does not check without an account id, as for a guest', async () => {
    const { latest } = renderRegistration(null);
    await settle();

    expect(notifications.registerForMobilePushNotifications).not.toHaveBeenCalled();
    expect(latest.current?.result).toBeNull();
    expect(latest.current?.isLoading).toBe(false);
  });
});
