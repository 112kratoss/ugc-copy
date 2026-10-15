import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Product decision D4 (2026-10-15): a guest may start a run of a published
 * template. The registry admits the guest's token (route-identity-policy.ts;
 * route-identity-policy.test.ts keeps authoring, testing and publishing an
 * account's); these tests follow one guest request from the proxy's
 * admission into the route that creates the run, and check that the run is
 * the guest's own. Its steps then execute under the run's owner, so they spend
 * the guest's balance as every other guest creation does.
 */

const state = vi.hoisted(() => ({
  admin: null as unknown,
  rateLimitKeys: [] as string[],
}));

// The route builds its clients from the request. The user client carries
// whatever admission the proxy attached, and asking Auth instead fails: the
// identity must come from the proxy's word, as it does in production.
vi.mock('@/lib/server-helpers', async (importOriginal) => {
  const { registerIdentityAdmissionContext } = await import('@/lib/identity-admission-assertion');
  return {
    ...(await importOriginal<typeof import('@/lib/server-helpers')>()),
    createUserClient: (request: Request) => {
      const client = {
        auth: {
          getUser: async () => ({ data: { user: null }, error: new Error('Auth was asked instead of the admission') }),
        },
      };
      registerIdentityAdmissionContext(client, request);
      return client;
    },
    createServiceClient: () => state.admin,
  };
});

const templates = vi.hoisted(() => ({
  createTemplateRun: vi.fn(),
  loadMediaTemplateRow: vi.fn(),
}));
vi.mock('@/lib/template-run-service', () => ({
  approveTemplateRunStep: vi.fn(),
  cancelTemplateRun: vi.fn(),
  createTemplateInputUploadIntent: vi.fn(),
  createTemplateRun: templates.createTemplateRun,
  finalizeTemplateRunInputs: vi.fn(),
  getTemplateRun: vi.fn(),
  retryTemplateRunStep: vi.fn(),
  startTemplateRun: vi.fn(),
}));
vi.mock('@/lib/template-run-jobs-processor', () => ({
  TEMPLATE_RUN_JOB_BATCH_LIMIT: 1,
  processTemplateRunJobs: vi.fn(),
}));
vi.mock('@/lib/media-template-service', () => ({
  createMediaTemplate: vi.fn(),
  disableMediaTemplate: vi.fn(),
  getMediaTemplate: vi.fn(),
  listActiveMediaTemplatesPage: vi.fn(),
  listOwnedMediaTemplates: vi.fn(),
  loadMediaTemplateRow: templates.loadMediaTemplateRow,
  publishMediaTemplate: vi.fn(),
  updateMediaTemplate: vi.fn(),
  validateMediaTemplateGraph: vi.fn(),
}));

import { createMediaTemplateRunsRouteHandlers } from '@/lib/media-template-route-adapter-service';
import { MediaTemplateError } from '@/lib/media-template-types';
import {
  createAdmittedIdentityHeaders,
  evaluateUserFacingRouteIdentity,
} from '@/lib/route-identity-admission';

const ADMISSION_SECRET = 'test-identity-admission-secret-at-least-32-bytes';
const GUEST_ID = '0a0a0a0a-0000-4000-8000-00000000000a';
const CREATOR_ID = '10000000-0000-4000-8000-000000000001';
const TEMPLATE_ID = '30000000-0000-4000-8000-000000000003';
const RUN_PATH = `/api/templates/${TEMPLATE_ID}/runs`;

/** What the proxy's identity check reads for an active guest's token. */
function guestIdentityClient() {
  return {
    auth: {
      getClaims: vi.fn(async () => ({
        data: { claims: { sub: GUEST_ID, aud: 'authenticated', role: 'authenticated', is_anonymous: true } },
        error: null,
      })),
    },
    rpc: vi.fn(async () => ({
      data: { state: 'active', created_at: '2026-10-15T00:00:00+00:00', banned: false, session_valid: true },
      error: null,
    })),
  };
}

/** The service client: only the mutation rate limit is asked of it here. */
function serviceClient() {
  return {
    rpc: vi.fn(async (name: string, args: { p_scope?: string; p_subject_key?: string }) => {
      if (name !== 'check_backend_rate_limit') throw new Error(`Unexpected rpc: ${name}`);
      state.rateLimitKeys.push(`${args.p_scope}:${args.p_subject_key}`);
      return {
        data: { allowed: true, limit: 120, remaining: 119, retryAfterSeconds: 0, resetAt: '2026-10-15T09:10:00.000Z' },
        error: null,
      };
    }),
  };
}

/**
 * The run request the app sends, as the proxy hands it on to the route: the
 * guest's token and, once admitted, the proxy's signed word for who it is.
 */
async function guestRunRequestThroughProxy() {
  const init = {
    method: 'POST',
    headers: {
      Authorization: 'Bearer guest-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'template-run-key-1',
    },
    body: JSON.stringify({}),
  };
  const incoming = new NextRequest(`https://magicbooklet.test${RUN_PATH}`, init);
  const admission = await evaluateUserFacingRouteIdentity(incoming, {
    createUserClient: () => guestIdentityClient(),
  });
  expect(admission.rejection).toBeNull();
  expect(admission.assertion).toBeTruthy();
  return new Request(`https://magicbooklet.test${RUN_PATH}`, {
    ...init,
    headers: createAdmittedIdentityHeaders(incoming, admission),
  });
}

function runContext() {
  return { params: Promise.resolve({ id: TEMPLATE_ID }) };
}

beforeEach(() => {
  vi.stubEnv('IDENTITY_ADMISSION_SECRET', ADMISSION_SECRET);
  state.admin = serviceClient();
  state.rateLimitKeys = [];
  templates.createTemplateRun.mockReset();
  templates.loadMediaTemplateRow.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/templates/[id]/runs for an app guest', () => {
  it('creates the run for the guest the proxy admitted, keyed and limited as that guest', async () => {
    templates.createTemplateRun.mockImplementation(async ({ userId }: { userId: string }) => ({
      id: 'run-1',
      templateId: TEMPLATE_ID,
      userId,
      status: 'collecting_inputs',
    }));

    const response = await createMediaTemplateRunsRouteHandlers().POST(await guestRunRequestThroughProxy(), runContext());

    expect(response.status).toBe(201);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toEqual({
      run: { id: 'run-1', templateId: TEMPLATE_ID, userId: GUEST_ID, status: 'collecting_inputs' },
    });
    expect(templates.createTemplateRun).toHaveBeenCalledOnce();
    expect(templates.createTemplateRun).toHaveBeenCalledWith(expect.objectContaining({
      client: state.admin,
      templateId: TEMPLATE_ID,
      userId: GUEST_ID,
      isTest: false,
      body: {},
      idempotencyKey: 'template-run-key-1',
    }));
    expect(state.rateLimitKeys).toEqual([`media-template:mutate:${GUEST_ID}`]);
  });

  // A guest is never a template's creator, so it is told what everyone but
  // the creator is told about a template that is not live.
  it("answers a guest's run of a template that is not live as for anyone but its creator", async () => {
    templates.createTemplateRun.mockRejectedValue(
      new MediaTemplateError('Template not found.', 404, 'TEMPLATE_NOT_FOUND'),
    );
    templates.loadMediaTemplateRow.mockResolvedValue({
      id: TEMPLATE_ID,
      creator_user_id: CREATOR_ID,
      status: 'draft',
      is_active: false,
      active_version_id: null,
    });

    const response = await createMediaTemplateRunsRouteHandlers().POST(await guestRunRequestThroughProxy(), runContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Template not found.', code: 'TEMPLATE_NOT_FOUND' });
  });
});
