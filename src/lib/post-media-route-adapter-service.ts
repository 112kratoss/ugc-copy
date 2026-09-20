import 'server-only';
import { NextResponse } from 'next/server';
import { requireIdentity } from '@/lib/account-identity';
import { logBackendRouteError } from '@/lib/backend-logger';
import { createMediaSupabaseClient } from '@/lib/media-route-shared';
import { parsePrivatePostMediaPath, readPostMedia } from '@/lib/post-media-read-service';
import { createServiceClient } from '@/lib/server-helpers';

const headers = { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie' };

type Dependencies = {
  createMediaSupabaseClient: typeof createMediaSupabaseClient;
  requireIdentity: typeof requireIdentity;
  createServiceClient: typeof createServiceClient;
  readPostMedia: typeof readPostMedia;
};

export async function getPostMediaRouteResponse(request: Request, overrides: Partial<Dependencies> = {}) {
  const dependencies = { createMediaSupabaseClient, requireIdentity, createServiceClient, readPostMedia, ...overrides };
  const path = parsePrivatePostMediaPath(new URL(request.url).searchParams.get('path'));
  if (!path) return NextResponse.json({ error: 'Invalid media path' }, { status: 400, headers });
  try {
    const admin = dependencies.createServiceClient();
    const client = await dependencies.createMediaSupabaseClient(request);
    const identity = await dependencies.requireIdentity(client, () => admin);
    // No session is allowed for public posts. An invalid/lifecycle-blocked
    // session must not be silently upgraded to an anonymous public read.
    if (!identity.ok && (identity.status !== 401 || request.headers.has('authorization'))) {
      return NextResponse.json({ error: identity.error }, { status: identity.status, headers });
    }
    const signedUrl = await dependencies.readPostMedia({
      admin, path, viewerUserId: identity.ok ? identity.identity.userId : null,
    });
    if (!signedUrl) return NextResponse.json({ error: 'Media not found' }, { status: 404, headers });
    return new NextResponse(null, { status: 302, headers: { ...headers, Location: signedUrl } });
  } catch (error) {
    logBackendRouteError('Error serving post media:', error);
    return NextResponse.json({ error: 'Unable to load media' }, { status: 500, headers });
  }
}
