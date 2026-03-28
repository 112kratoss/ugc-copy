import { NextRequest, NextResponse } from 'next/server';

import { recordGenerationShareEvent } from '@/lib/generation-share-events';
import {
  createServiceClient,
  createUserClient,
} from '@/lib/server-helpers';
import {
  isGenerationShareChannel,
  isGenerationShareSourceSurface,
} from '@/lib/share';

export async function POST(request: NextRequest) {
  try {
    const { generationId, sourceSurface, channel } = await request.json();

    if (!generationId || typeof generationId !== 'string') {
      return NextResponse.json({ error: 'Missing generation ID' }, { status: 400 });
    }

    if (!sourceSurface || typeof sourceSurface !== 'string' || !isGenerationShareSourceSurface(sourceSurface)) {
      return NextResponse.json({ error: 'Invalid share source surface' }, { status: 400 });
    }

    if (!channel || typeof channel !== 'string' || !isGenerationShareChannel(channel)) {
      return NextResponse.json({ error: 'Invalid share channel' }, { status: 400 });
    }

    const adminSupabase = createServiceClient();
    const { data: generation, error: generationError } = await adminSupabase
      .from('generations')
      .select('id, is_public')
      .eq('id', generationId)
      .maybeSingle();

    if (generationError) {
      console.error('Failed to verify shareable generation:', generationError);
      return NextResponse.json({ error: 'Failed to verify generation' }, { status: 500 });
    }

    if (!generation?.is_public) {
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

    await recordGenerationShareEvent({
      generationId,
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
