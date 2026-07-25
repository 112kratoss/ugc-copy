import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  CONTACT_SUBMISSION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';

type ContactSubmissionBody = {
  name?: unknown;
  email?: unknown;
  subject?: unknown;
  message?: unknown;
};

export type ContactSubmissionRouteResult =
  | {
      ok: true;
      body: { success: true };
    }
  | {
      ok: false;
      status: 400 | 429 | 500;
      body: {
        error: string;
        code?: 'RATE_LIMITED';
        retryAfterSeconds?: number;
        limit?: number;
        resetAt?: string;
      };
      rateLimitError?: BackendRateLimitError;
    };

function normalizeBody(value: unknown): ContactSubmissionBody {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as ContactSubmissionBody
    : {};
}

function normalizeRequiredText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSubject(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'general';
}

function createRateLimitResult(error: BackendRateLimitError): ContactSubmissionRouteResult {
  return {
    ok: false,
    status: 429,
    rateLimitError: error,
    body: {
      error: error.message,
      code: 'RATE_LIMITED',
      retryAfterSeconds: error.retryAfterSeconds,
      limit: error.state.limit,
      resetAt: error.state.resetAt,
    },
  };
}

function createInternalErrorResult(): ContactSubmissionRouteResult {
  return {
    ok: false,
    status: 500,
    body: { error: 'Internal server error' },
  };
}

export function getContactRateLimitKey(headers: Headers) {
  const forwardedFor = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = headers.get('x-real-ip')?.trim();

  return forwardedFor || realIp || '127.0.0.1';
}

export async function submitContactMessageForRoute({
  readBody,
  rateLimitKey,
  createAdminSupabase,
}: {
  readBody: () => Promise<unknown>;
  rateLimitKey: string;
  createAdminSupabase: () => SupabaseClient;
}): Promise<ContactSubmissionRouteResult> {
  let body: ContactSubmissionBody;
  try {
    body = normalizeBody(await readBody());
  } catch (error) {
    logBackendError('contact_api_error', { error: error });
    return createInternalErrorResult();
  }

  const name = normalizeRequiredText(body.name);
  const email = normalizeRequiredText(body.email);
  const message = normalizeRequiredText(body.message);

  if (!name || !email || !message) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Name, email, and message are required' },
    };
  }

  if (!email.includes('@') || !email.includes('.')) {
    return {
      ok: false,
      status: 400,
      body: { error: 'Invalid email address' },
    };
  }

  let adminSupabase: SupabaseClient;
  try {
    adminSupabase = createAdminSupabase();
  } catch (error) {
    logBackendError('contact_api_error', { error: error });
    return createInternalErrorResult();
  }

  try {
    await enforceBackendRateLimit(adminSupabase, {
      ...CONTACT_SUBMISSION_RATE_LIMIT,
      key: rateLimitKey,
    });
  } catch (error) {
    if (error instanceof BackendRateLimitError) {
      return createRateLimitResult(error);
    }

    logBackendError('contact_rate_limit_check_failed', { error: error });
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to check contact submission limits.' },
    };
  }

  const { error } = await adminSupabase
    .from('contact_messages')
    .insert({
      name,
      email: email.toLowerCase(),
      subject: normalizeSubject(body.subject),
      message,
    });

  if (error) {
    logBackendError('error_saving_contact_message', { error: error });
    return {
      ok: false,
      status: 500,
      body: { error: 'Failed to send message. Please try again.' },
    };
  }

  return { ok: true, body: { success: true } };
}
