import 'server-only';

import { after, NextResponse } from 'next/server';

import { authenticateAdminRequest } from '@/lib/admin-auth';
import {
  announceSupportUpdate,
  createRoadmapItem,
  editSupportUpdate,
  isSupportUpdateAnnounce,
  listAdminSupportHub,
  moveRoadmapItem,
  publishSupportUpdate,
  runSupportUpdateBroadcastQuietly,
  setRoadmapItemArchived,
  setSupportUpdateCommentsLocked,
  setSupportUpdatePublished,
  shipRoadmapItem,
  updateRoadmapItem,
  type AdminSupportHubResult,
} from '@/lib/admin-support-hub-service';
import { API_CACHE_CONTROL, createApiResponseHeaders, getApiRequestId } from '@/lib/api-cache';
import { logBackendRouteError } from '@/lib/backend-logger';
import { readBoundedJsonBody } from '@/lib/bounded-json-request';
import { createServiceClient } from '@/lib/server-helpers';
import { isSupportHubId } from '@/lib/support-hub-service';

/**
 * `/api/admin/support-hub`: the console's Updates and Roadmap
 * (`/admin/updates`), behind both admin gates (the proxy's edge check and
 * `authenticateAdminRequest` here).
 *
 * - `GET`: every update and the whole roadmap.
 * - `POST { action, … }`: `publish`, `edit`, `lock`, `publishState`,
 *   `announce` (a quietly published update), `continueBroadcast` for updates; `roadmapCreate`, `roadmapUpdate`,
 *   `roadmapArchive`, `roadmapMove`, `roadmapShip` for the roadmap.
 */

const ACTION_BODY_MAX_BYTES = 32 * 1024;

const ACTIONS = [
  'publish',
  'edit',
  'lock',
  'publishState',
  'announce',
  'continueBroadcast',
  'roadmapCreate',
  'roadmapUpdate',
  'roadmapArchive',
  'roadmapMove',
  'roadmapShip',
] as const;
type Action = (typeof ACTIONS)[number];

function isAction(value: unknown): value is Action {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);
}

type Headers = ReturnType<typeof createApiResponseHeaders>;

export type AdminSupportHubRouteDependencies = {
  authenticateAdminRequest?: typeof authenticateAdminRequest;
  createServiceClient?: typeof createServiceClient;
  runAfter?: (task: () => Promise<void>) => void;
};

async function admit(request: Request, dependencies: AdminSupportHubRouteDependencies, headers: Headers) {
  const auth = await (dependencies.authenticateAdminRequest ?? authenticateAdminRequest)(request);
  if (auth.authenticated) return null;
  return NextResponse.json(
    { error: auth.reason === 'unconfigured' ? 'Admin access is not configured.' : 'Unauthorized' },
    { status: auth.reason === 'unconfigured' ? 503 : 401, headers },
  );
}

function logFailure(request: Request, msg: string, action: unknown, error: unknown) {
  logBackendRouteError(JSON.stringify({
    level: 'error',
    msg,
    requestId: getApiRequestId(request),
    action,
    error: error instanceof Error ? error.message : String(error),
  }));
}

function answer<T>(result: AdminSupportHubResult<T>, headers: Headers) {
  return result.ok
    ? NextResponse.json({ success: true, ...(result.value && typeof result.value === 'object' ? result.value : {}) }, { headers })
    : NextResponse.json({ error: result.error }, { status: result.status, headers });
}

export async function getAdminSupportHub(request: Request, dependencies: AdminSupportHubRouteDependencies = {}) {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);
  const refused = await admit(request, dependencies, headers);
  if (refused) return refused;
  try {
    const hub = await listAdminSupportHub({ adminSupabase: (dependencies.createServiceClient ?? createServiceClient)() });
    return NextResponse.json({ success: true, ...hub }, { headers });
  } catch (error) {
    logFailure(request, 'admin_support_hub_read_failed', 'read', error);
    return NextResponse.json({ error: 'Updates and the roadmap could not be loaded. Try again.' }, { status: 500, headers });
  }
}

export async function postAdminSupportHubAction(request: Request, dependencies: AdminSupportHubRouteDependencies = {}) {
  const headers = createApiResponseHeaders(request, API_CACHE_CONTROL.privateNoStore);
  const refused = await admit(request, dependencies, headers);
  if (refused) return refused;

  const parsed = await readBoundedJsonBody(request, ACTION_BODY_MAX_BYTES);
  const body = (parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
    ? parsed.value
    : null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400, headers });
  if (!isAction(body.action)) return NextResponse.json({ error: 'Unsupported action.' }, { status: 400, headers });

  const action = body.action;
  const adminSupabase = (dependencies.createServiceClient ?? createServiceClient)();
  const runAfter = dependencies.runAfter ?? ((task: () => Promise<void>) => after(task));
  const needsPost = action === 'edit' || action === 'lock' || action === 'publishState' || action === 'announce' || action === 'continueBroadcast';
  const needsItem = action === 'roadmapUpdate' || action === 'roadmapArchive' || action === 'roadmapMove' || action === 'roadmapShip';
  if (needsPost && !isSupportHubId(body.postId)) {
    return NextResponse.json({ error: 'An update id is required.' }, { status: 400, headers });
  }
  if (needsItem && !isSupportHubId(body.itemId)) {
    return NextResponse.json({ error: 'A roadmap item id is required.' }, { status: 400, headers });
  }
  const postId = body.postId as string;
  const itemId = body.itemId as string;

  try {
    switch (action) {
      case 'publish': {
        if (!isSupportUpdateAnnounce(body.announce)) {
          return NextResponse.json({ error: 'Choose who hears about it.' }, { status: 400, headers });
        }
        const result = await publishSupportUpdate({
          adminSupabase,
          kind: body.kind,
          title: body.title,
          body: body.body,
          commentsLocked: body.commentsLocked === true,
          announce: body.announce,
        });
        if (result.ok && result.value.announced) {
          const announced = result.value.postId;
          runAfter(() => runSupportUpdateBroadcastQuietly({ adminSupabase, postId: announced }));
        }
        return answer(result, headers);
      }
      case 'edit':
        return answer(await editSupportUpdate({ adminSupabase, postId, title: body.title, body: body.body }), headers);
      case 'lock':
        return answer(await setSupportUpdateCommentsLocked({ adminSupabase, postId, locked: body.locked === true }), headers);
      case 'publishState':
        return answer(await setSupportUpdatePublished({ adminSupabase, postId, published: body.published === true }), headers);
      case 'announce': {
        const result = await announceSupportUpdate({ adminSupabase, postId, push: body.push === true });
        if (result.ok) runAfter(() => runSupportUpdateBroadcastQuietly({ adminSupabase, postId }));
        return answer(result, headers);
      }
      case 'continueBroadcast':
        runAfter(() => runSupportUpdateBroadcastQuietly({ adminSupabase, postId }));
        return NextResponse.json({ success: true }, { headers });
      case 'roadmapCreate':
        return answer(await createRoadmapItem({ adminSupabase, title: body.title, summary: body.summary, status: body.status }), headers);
      case 'roadmapUpdate':
        return answer(await updateRoadmapItem({ adminSupabase, itemId, title: body.title, summary: body.summary, status: body.status }), headers);
      case 'roadmapArchive':
        return answer(await setRoadmapItemArchived({ adminSupabase, itemId, archived: body.archived === true }), headers);
      case 'roadmapMove':
        if (body.direction !== 'up' && body.direction !== 'down') {
          return NextResponse.json({ error: 'Move an item up or down.' }, { status: 400, headers });
        }
        return answer(await moveRoadmapItem({ adminSupabase, itemId, direction: body.direction }), headers);
      case 'roadmapShip':
        if (!isSupportHubId(body.updatePostId)) {
          return NextResponse.json({ error: 'Choose the update that announced it.' }, { status: 400, headers });
        }
        return answer(await shipRoadmapItem({ adminSupabase, itemId, updatePostId: body.updatePostId }), headers);
    }
  } catch (error) {
    logFailure(request, 'admin_support_hub_action_failed', action, error);
    return NextResponse.json({ error: 'That did not go through. Try again.' }, { status: 500, headers });
  }
}

export function createAdminSupportHubRouteHandlers() {
  return {
    GET(request: Request) {
      return getAdminSupportHub(request);
    },
    POST(request: Request) {
      return postAdminSupportHubAction(request);
    },
  };
}
