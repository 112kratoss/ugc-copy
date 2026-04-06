import { NextRequest, NextResponse } from 'next/server';

import { recordPostShareEvent } from '@/lib/post-share-events';
import { findPublicPostReferenceByIdOrGenerationId } from '@/lib/posts-server';
import {
  createUserClient,
} from '@/lib/server-helpers';
import {
  isGenerationShareChannel,
  isGenerationShareSourceSurface,
} from '@/lib/share';

export async function POST(request: NextRequest) {
  try {
    const { generationId, postId, sourceSurface, channel } = await request.json();
    const referenceId = typeof postId === 'string' ? postId : generationId;

    if (!referenceId || typeof referenceId !== 'string') {
      return NextResponse.json({ error: 'Missing post ID' }, { status: 400 });
    }

    if (!sourceSurface || typeof sourceSurface !== 'string' || !isGenerationShareSourceSurface(sourceSurface)) {
      return NextResponse.json({ error: 'Invalid share source surface' }, { status: 400 });
    }

    if (!channel || typeof channel !== 'string' || !isGenerationShareChannel(channel)) {
      return NextResponse.json({ error: 'Invalid share channel' }, { status: 400 });
    }

    const post = await findPublicPostReferenceByIdOrGenerationId(referenceId);
    if (!post) {
      return NextResponse.json({ error: 'Only public creations can be shared' }, { status: 404 });
    }

    let actorUserId: string | null = null;
    try {
      const supabase = createUserClient(request);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      actorUserId = user?.id ?? null;
    } catch {
      actorUserId = null;
    }

    await recordPostShareEvent({
      postId: post.id,
      eventType: 'share_click',
      sourceSurface,
      channel,
      actorUserId,
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Share tracking error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
