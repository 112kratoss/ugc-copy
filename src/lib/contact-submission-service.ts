import 'server-only';
import { logBackendError } from '@/lib/backend-logger';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  BackendRateLimitError,
  CONTACT_SUBMISSION_RATE_LIMIT,
  enforceBackendRateLimit,
} from '@/lib/backend-rate-limit';
import type { BoundedJsonBodyResult } from '@/lib/bounded-json-request';
import { getClientNetworkKey } from '@/lib/client-network-key';

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
      status: 400 | 413 | 429 | 500;
      body: {
        error: string;
        code?: 'RATE_LIMITED';
        retryAfterSeconds?: number;
        limit?: number;
        resetAt?: string;
      };
      rateLimitError?: BackendRateLimitError;
    };

export const CONTACT_FIELD_MAX_LENGTH = 200;
export const CONTACT_MESSAGE_MAX_LENGTH = 5000;

// Deliberately simple: one non-space local part, an @, a domain with a dot,
// and no whitespace anywhere. Deliverability is not validated here.
const CONTACT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function createValidationErrorResult(message: string): ContactSubmissionRouteResult {
  return {
    ok: false,
    status: 400,
    body: { error: message },
  };
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
  return getClientNetworkKey(headers);
}

export async function submitContactMessageForRoute({
  readBody,
  rateLimitKey,
  createAdminSupabase,
}: {
  readBody: () => Promise<BoundedJsonBodyResult>;
  rateLimitKey: string;
  createAdminSupabase: () => SupabaseClient;
}): Promise<ContactSubmissionRouteResult> {
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

  let boundedBody: BoundedJsonBodyResult;
  try {
    boundedBody = await readBody();
  } catch (error) {
    logBackendError('contact_api_error', { error: error });
    return createInternalErrorResult();
  }

  if (!boundedBody.ok) {
    return boundedBody.reason === 'too_large'
      ? {
          ok: false,
          status: 413,
          body: { error: 'Contact submission is too large.' },
        }
      : createValidationErrorResult('Invalid JSON payload.');
  }

  const body = normalizeBody(boundedBody.value);
  const name = normalizeRequiredText(body.name);
  const email = normalizeRequiredText(body.email);
  const message = normalizeRequiredText(body.message);
  const subject = normalizeSubject(body.subject);

  if (!name || !email || !message) {
    return createValidationErrorResult('Name, email, and message are required');
  }

  if (name.length > CONTACT_FIELD_MAX_LENGTH) {
    return createValidationErrorResult(`Name must be ${CONTACT_FIELD_MAX_LENGTH} characters or fewer.`);
  }

  if (email.length > CONTACT_FIELD_MAX_LENGTH || !CONTACT_EMAIL_PATTERN.test(email)) {
    return createValidationErrorResult('Invalid email address');
  }

  if (subject.length > CONTACT_FIELD_MAX_LENGTH) {
    return createValidationErrorResult(`Subject must be ${CONTACT_FIELD_MAX_LENGTH} characters or fewer.`);
  }

  if (message.length > CONTACT_MESSAGE_MAX_LENGTH) {
    return createValidationErrorResult(`Message must be ${CONTACT_MESSAGE_MAX_LENGTH} characters or fewer.`);
  }

  const { error } = await adminSupabase
    .from('contact_messages')
    .insert({
      name,
      email: email.toLowerCase(),
      subject,
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
