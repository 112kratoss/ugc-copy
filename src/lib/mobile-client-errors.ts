import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * The mobile app's error reports (audit 2026-11-27): what its error boundary, its global JS error
 * handler and its unhandled-rejection tracker caught, sent by `ugc-mobile/lib/client-error-report.ts`
 * and kept 30 days in `mobile_client_errors` (migration 20261127060127). The app truncates before it
 * sends; the server truncates again, so a modified client cannot store more. No form field is sent,
 * but an error's text can quote what it was handed, so a row is treated as possibly personal.
 */
export const MOBILE_CLIENT_ERROR_LIMITS = {
  message: 500,
  stack: 4_000,
  componentStack: 2_000,
  route: 200,
} as const;

const APP_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const UPDATE_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const PLATFORMS = new Set(['ios', 'android']);

export type MobileClientErrorReport = {
  message: string;
  stack: string | null;
  componentStack: string | null;
  fatal: boolean;
  route: string | null;
  appVersion: string | null;
  updateId: string | null;
  platform: 'ios' | 'android';
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  return value.length > 0 ? value.slice(0, max) : null;
}

function optionalField(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

/** A route's path alone: what follows `?` or `#` is never kept, and anything not a path is dropped. */
function readRoute(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const path = value.split(/[?#]/u, 1)[0] ?? '';
  if (!path.startsWith('/') || /\s/u.test(path)) return null;
  return path.slice(0, MOBILE_CLIENT_ERROR_LIMITS.route);
}

export function parseMobileClientErrorReport(value: unknown): MobileClientErrorReport | null {
  if (!isRecord(value)) return null;
  const { message, stack, componentStack, fatal, route, appVersion, updateId, platform } = value;
  if (typeof message !== 'string' || message.trim().length === 0) return null;
  if (typeof fatal !== 'boolean') return null;
  if (typeof platform !== 'string' || !PLATFORMS.has(platform)) return null;
  const parsedStack = optionalText(stack, MOBILE_CLIENT_ERROR_LIMITS.stack);
  const parsedComponentStack = optionalText(componentStack, MOBILE_CLIENT_ERROR_LIMITS.componentStack);
  if (parsedStack === undefined || parsedComponentStack === undefined) return null;

  return {
    message: message.slice(0, MOBILE_CLIENT_ERROR_LIMITS.message),
    stack: parsedStack,
    componentStack: parsedComponentStack,
    fatal,
    route: readRoute(route),
    appVersion: optionalField(appVersion, APP_VERSION_PATTERN),
    updateId: optionalField(updateId, UPDATE_ID_PATTERN),
    platform: platform as 'ios' | 'android',
  };
}

export async function recordMobileClientError(
  admin: SupabaseClient,
  report: MobileClientErrorReport,
  userId: string | null,
): Promise<void> {
  const { error } = await admin.from('mobile_client_errors').insert({
    user_id: userId,
    platform: report.platform,
    app_version: report.appVersion,
    update_id: report.updateId,
    route: report.route,
    fatal: report.fatal,
    message: report.message,
    stack: report.stack,
    component_stack: report.componentStack,
  });
  if (error) throw error;
}
