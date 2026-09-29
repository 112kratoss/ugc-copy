import 'server-only';
import { enforceBackendRateLimit, BackendRateLimitError, createBackendRateLimitResponse } from '@/lib/backend-rate-limit';
import { NextResponse } from 'next/server';
import { requireIdentity } from '@/lib/account-identity';
import { createMediaSupabaseClient } from '@/lib/media-route-shared';
import { createServiceClient } from '@/lib/server-helpers';
import { getPublicPostDetail } from '@/lib/public-posts';
import { getShowcaseFeedItemById } from '@/lib/showcase-feed';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie' };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });

async function identityFor(request: Request) {
  const admin = createServiceClient();
  const identity = await requireIdentity(await createMediaSupabaseClient(request), () => admin);
  return { admin, identity };
}

export async function contentPreferencesResponse(request: Request) {
  try {
    const { admin, identity } = await identityFor(request);
    if (!identity.ok || identity.identity.kind !== 'registered') return json({ error: 'Sign in to manage mature content.' }, 401);
    const userId = identity.identity.userId;
    await enforceBackendRateLimit(admin, { scope: 'content-preferences', key: userId, limit: 60, windowSeconds: 600 });
    if (request.method === 'GET') {
      const { data, error } = await admin.from('content_preferences').select('show_mature').eq('user_id', userId).maybeSingle();
      if (error) throw error;
      return json({ showMature: data?.show_mature === true });
    }
    // iOS opt-in is deliberately website-only. Cookie identity and same-origin
    // protection prevent a mobile bearer call from enabling the preference.
    if (request.headers.has('authorization') || request.headers.get('origin') !== new URL(request.url).origin) {
      return json({ error: 'Manage mature content on the Magicbooklet website.' }, 403);
    }
    const body = await request.json();
    if (!body || typeof body.showMature !== 'boolean' || (body.showMature && body.confirmAdult !== true)) {
      return json({ error: 'Confirm that you are 18 or older before enabling mature content.' }, 400);
    }
    const result = await admin.from('content_preferences').upsert({
      user_id: userId, show_mature: body.showMature,
      adult_confirmed_at: body.showMature ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    });
    if (result.error) throw result.error;
    const revoked = await admin.from('nsfw_post_reveals').delete().eq('user_id', userId);
    if (revoked.error) throw revoked.error;
    return json({ showMature: body.showMature });
  } catch (error) {
    if (error instanceof BackendRateLimitError) return createBackendRateLimitResponse(error);
    if (error instanceof SyntaxError) return json({ error: 'Invalid JSON.' }, 400);
    return json({ error: 'Could not update mature-content preferences. Please retry.' }, 500);
  }
}

export async function revealNsfwPostResponse(request: Request, context: { params: Promise<{ postId: string }> }) {
  try {
    const { postId } = await context.params;
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(postId)) return json({ error: 'Invalid post.' }, 400);
    if (!request.headers.has('authorization') && request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Invalid request origin.' }, 403);
    const { admin, identity } = await identityFor(request);
    if (!identity.ok || identity.identity.kind !== 'registered') return json({ error: 'Sign in to reveal mature content.' }, 401);
    const viewerUserId = identity.identity.userId;
    await enforceBackendRateLimit(admin, { scope: 'nsfw-reveal', key: viewerUserId, limit: 60, windowSeconds: 600 });
    const { data, error } = await admin.rpc('reveal_nsfw_post', { p_post_id: postId, p_viewer_id: viewerUserId });
    if (error) throw error;
    if (data !== true) return json({ error: 'Enable mature content on the website first. The post must also be available to you.', code: 'MATURE_CONTENT_DISABLED' }, 403);
    const options = { viewerUserId, revealNsfw: true, countryCode: request.headers.get('x-vercel-ip-country') };
    const detail = await getPublicPostDetail(postId, options);
    if (!detail?.nsfwRevealed) return json({ error: 'Post not found.' }, 404);
    const item = await getShowcaseFeedItemById({ postId, ...options });
    return json({ success: true, detail, item, expiresInSeconds: 600 });
  } catch (error) {
    if (error instanceof BackendRateLimitError) return createBackendRateLimitResponse(error);
    if (error instanceof SyntaxError) return json({ error: 'Invalid JSON.' }, 400);
    return json({ error: 'Could not reveal this post. Please retry.' }, 500);
  }
}
