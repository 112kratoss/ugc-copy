import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BackendRateLimitError } from '@/lib/backend-rate-limit';
import {
  createMobileNotificationPreferencesRouteHandlers,
  getMobileNotificationPreferencesRouteResponse,
  patchMobileNotificationPreferencesRouteResponse,
} from '@/lib/mobile-notification-preferences-route-adapter-service';

describe('mobile notification preferences route adapter service', () => {
  it('delegates preference reads with a user client and private trace headers', async () => {
    const userSupabase = { auth: 'user' } as unknown as SupabaseClient;
    const createUserClient = vi.fn(() => userSupabase);
    const getMobileNotificationPreferencesForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        preferences: {
          pushEnabled: true,
          generationEnabled: true,
          commerceEnabled: true,
          socialEnabled: true,
        },
      },
    }));

    const request = new Request('https://app.example/api/mobile/notifications/preferences', {
      headers: { 'x-request-id': 'mobile-pref-read-1' },
    });
    const response = await getMobileNotificationPreferencesRouteResponse({
      request,
      dependencies: {
        createUserClient,
        getMobileNotificationPreferencesForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('mobile-pref-read-1');
    await expect(response.json()).resolves.toMatchObject({ success: true });
    expect(createUserClient).toHaveBeenCalledWith(request);
    expect(getMobileNotificationPreferencesForRoute).toHaveBeenCalledWith({ userSupabase });
  });

  it('delegates preference updates with lazy body and admin-client handoff', async () => {
    const userSupabase = { auth: 'user' } as unknown as SupabaseClient;
    const adminSupabase = { service: 'admin' } as unknown as SupabaseClient;
    const createServiceClient = vi.fn(() => adminSupabase);
    const createUserClient = vi.fn(() => userSupabase);
    const updateMobileNotificationPreferencesForRoute = vi.fn(async (input) => {
      await expect(input.readRequestBody()).resolves.toEqual({ pushEnabled: false });
      expect(input.getAdminSupabase()).toBe(adminSupabase);
      return {
        ok: true as const,
        body: {
          success: true as const,
          preferences: {
            pushEnabled: false,
            generationEnabled: true,
            commerceEnabled: true,
            socialEnabled: true,
          },
        },
      };
    });

    const request = new Request('https://app.example/api/mobile/notifications/preferences', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': 'mobile-pref-update-1',
      },
      body: JSON.stringify({ pushEnabled: false }),
    });
    const response = await patchMobileNotificationPreferencesRouteResponse({
      request,
      dependencies: {
        createServiceClient,
        createUserClient,
        updateMobileNotificationPreferencesForRoute,
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('mobile-pref-update-1');
    await expect(response.json()).resolves.toMatchObject({
      preferences: { pushEnabled: false },
    });
    expect(createUserClient).toHaveBeenCalledWith(request);
    expect(updateMobileNotificationPreferencesForRoute).toHaveBeenCalledWith({
      getAdminSupabase: expect.any(Function),
      readRequestBody: expect.any(Function),
      userSupabase,
    });
    expect(createServiceClient).toHaveBeenCalledTimes(1);
  });

  it('maps update rate limits into standard private no-store responses', async () => {
    const rateLimitError = new BackendRateLimitError({
      allowed: false,
      limit: 30,
      remaining: 0,
      retryAfterSeconds: 45,
      resetAt: '2026-06-23T03:00:00.000Z',
    });
    const updateMobileNotificationPreferencesForRoute = vi.fn(async () => ({
      ok: false as const,
      body: { error: rateLimitError.message },
      status: 429,
      rateLimitError,
    }));

    const response = await patchMobileNotificationPreferencesRouteResponse({
      request: new Request('https://app.example/api/mobile/notifications/preferences', {
        method: 'PATCH',
        headers: { 'x-request-id': 'mobile-pref-limit-1' },
        body: JSON.stringify({ pushEnabled: true }),
      }),
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'admin' }) as unknown as SupabaseClient),
        createUserClient: vi.fn(() => ({ auth: 'user' }) as unknown as SupabaseClient),
        updateMobileNotificationPreferencesForRoute,
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('45');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('30');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(response.headers.get('x-request-id')).toBe('mobile-pref-limit-1');
    await expect(response.json()).resolves.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 45,
      limit: 30,
    });
  });

  it('creates route handlers that forward GET and PATCH preference requests through the adapter', async () => {
    const userSupabase = { auth: 'user' } as unknown as SupabaseClient;
    const getMobileNotificationPreferencesForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        preferences: {
          pushEnabled: true,
          generationEnabled: true,
          commerceEnabled: true,
          socialEnabled: true,
        },
      },
    }));
    const updateMobileNotificationPreferencesForRoute = vi.fn(async () => ({
      ok: true as const,
      body: {
        success: true as const,
        preferences: {
          pushEnabled: false,
          generationEnabled: true,
          commerceEnabled: true,
          socialEnabled: true,
        },
      },
    }));
    const { GET, PATCH } = createMobileNotificationPreferencesRouteHandlers({
      dependencies: {
        createServiceClient: vi.fn(() => ({ service: 'admin' }) as unknown as SupabaseClient),
        createUserClient: vi.fn(() => userSupabase),
        getMobileNotificationPreferencesForRoute,
        updateMobileNotificationPreferencesForRoute,
      },
    });

    const getResponse = await GET(new Request(
      'https://app.example/api/mobile/notifications/preferences',
      { headers: { 'x-request-id': 'mobile-pref-factory-get-1' } },
    ));
    const patchResponse = await PATCH(new Request(
      'https://app.example/api/mobile/notifications/preferences',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': 'mobile-pref-factory-patch-1',
        },
        body: JSON.stringify({ pushEnabled: false }),
      },
    ));

    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get('x-request-id')).toBe('mobile-pref-factory-get-1');
    expect(patchResponse.status).toBe(200);
    expect(patchResponse.headers.get('x-request-id')).toBe('mobile-pref-factory-patch-1');
    await expect(getResponse.json()).resolves.toMatchObject({
      preferences: { pushEnabled: true },
    });
    await expect(patchResponse.json()).resolves.toMatchObject({
      preferences: { pushEnabled: false },
    });
    expect(getMobileNotificationPreferencesForRoute).toHaveBeenCalledWith({ userSupabase });
    expect(updateMobileNotificationPreferencesForRoute).toHaveBeenCalledWith({
      getAdminSupabase: expect.any(Function),
      readRequestBody: expect.any(Function),
      userSupabase,
    });
  });
});
