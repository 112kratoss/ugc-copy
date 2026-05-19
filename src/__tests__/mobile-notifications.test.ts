import { describe, expect, it, vi } from 'vitest';

import {
  MobileNotificationError,
  buildMobileNotificationDeepLink,
  normalizeMobilePushTokenPayload,
  sendExpoPushNotification,
} from '@/lib/mobile-notifications';

describe('mobile notifications', () => {
  it('normalizes Expo push token registration payloads', () => {
    expect(normalizeMobilePushTokenPayload({
      expoPushToken: ' ExponentPushToken[abc123] ',
      platform: 'ios',
      deviceId: 'device-1',
      appVersion: '1.0.0',
    })).toEqual({
      expoPushToken: 'ExponentPushToken[abc123]',
      platform: 'ios',
      deviceId: 'device-1',
      appVersion: '1.0.0',
    });
  });

  it('rejects invalid Expo push token registration payloads', () => {
    expect(() => normalizeMobilePushTokenPayload({
      expoPushToken: 'not-a-token',
      platform: 'web',
    })).toThrow(MobileNotificationError);
  });

  it('sends push payloads through the Expo push API', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        data: {
          status: 'ok',
          id: 'ticket-1',
        },
      }), {
        headers: { 'content-type': 'application/json' },
        status: 200,
      })
    );

    await expect(sendExpoPushNotification({
      expoPushToken: 'ExponentPushToken[abc123]',
      title: 'Render ready',
      body: 'Your image finished.',
      data: {
        deepLink: '/viewer?source=studio-creations&initialId=gen-1',
        notificationId: 'notification-1',
        type: 'generation_succeeded',
        category: 'generation',
      },
      fetcher: fetcher as unknown as typeof fetch,
    })).resolves.toEqual({
      status: 'ok',
      id: 'ticket-1',
    });

    expect(fetcher).toHaveBeenCalledWith('https://exp.host/--/api/v2/push/send', expect.objectContaining({
      method: 'POST',
    }));
    const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      to: 'ExponentPushToken[abc123]',
      title: 'Render ready',
      body: 'Your image finished.',
      data: {
        notificationId: 'notification-1',
        type: 'generation_succeeded',
        category: 'generation',
      },
    });
  });

  it('builds mobile deep links for notification targets', () => {
    expect(buildMobileNotificationDeepLink({ kind: 'generation', generationId: 'gen-1' }))
      .toBe('/viewer?source=studio-creations&initialId=gen-1');
    expect(buildMobileNotificationDeepLink({ kind: 'showcasePost', postId: 'post-1' }))
      .toBe('/viewer?source=showcase-feed&initialId=post-1');
    expect(buildMobileNotificationDeepLink({ kind: 'notifications' }))
      .toBe('/studio');
  });
});
