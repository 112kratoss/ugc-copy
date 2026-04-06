import { NextRequest, NextResponse } from 'next/server';

import {
  isMarketplaceAssetStatus,
  isMarketplaceAssetType,
} from '@/lib/marketplace';
import { createUserClient } from '@/lib/server-helpers';
import {
  normalizeWorkflowGraph,
  serializeWorkflowGraph,
  type WorkflowCanvasGraph,
} from '@/lib/workflow-canvas';

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeRequiredText(value: unknown, fallback: string): string {
  return normalizeOptionalText(value) ?? fallback;
}

function toPriceUsdCents(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.round(value);
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return Math.round(parsed);
    }
  }

  return null;
}

type LinkedPostRow = {
  id: string;
  user_id: string;
  visibility: 'public' | 'unlisted' | 'private';
};

export async function POST(request: NextRequest) {
  try {
    const supabase = createUserClient(request);
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const assetId = normalizeOptionalText(body.assetId);
    const postId = normalizeOptionalText(body.postId);
    const canvasId = normalizeOptionalText(body.canvasId);
    const type = typeof body.type === 'string' ? body.type : null;
    const status = typeof body.status === 'string' ? body.status : null;
    const title = normalizeOptionalText(body.title);
    const description = normalizeRequiredText(body.description, '');
    const preview = normalizeRequiredText(body.preview, description);
    const promptPack = normalizeOptionalText(body.promptPack);
    const guideMarkdown = normalizeOptionalText(body.guideMarkdown);
    const priceUsdCents = toPriceUsdCents(body.priceUsdCents);

    if (!isMarketplaceAssetType(type)) {
      return NextResponse.json({ error: 'Invalid asset type.' }, { status: 400 });
    }

    if (!isMarketplaceAssetStatus(status)) {
      return NextResponse.json({ error: 'Invalid listing status.' }, { status: 400 });
    }

    if (!title) {
      return NextResponse.json({ error: 'Title is required.' }, { status: 400 });
    }

    if (priceUsdCents === null || priceUsdCents < 0 || (priceUsdCents > 0 && priceUsdCents < 100)) {
      return NextResponse.json({ error: 'Price must be free or at least $1.00.' }, { status: 400 });
    }

    if (postId) {
      const { data: linkedPost, error: linkedPostError } = await supabase
        .from('posts')
        .select('id, user_id, visibility')
        .eq('id', postId)
        .maybeSingle();

      const typedLinkedPost = (linkedPost as LinkedPostRow | null) ?? null;

      if (linkedPostError || !typedLinkedPost || typedLinkedPost.user_id !== user.id) {
        return NextResponse.json({ error: 'You can only attach listings to your own posts.' }, { status: 400 });
      }

      if (status === 'active' && typedLinkedPost.visibility !== 'public') {
        return NextResponse.json({
          error: 'Active listings can only attach to public posts. Publish the post first or save this listing as draft/unlisted.',
        }, { status: 400 });
      }

      const { data: existingPostAsset, error: existingPostAssetError } = await supabase
        .from('marketplace_assets')
        .select('id')
        .eq('post_id', postId)
        .maybeSingle();

      if (existingPostAssetError) {
        console.error('Failed to check existing post asset:', existingPostAssetError);
        return NextResponse.json({ error: 'Failed to validate linked post.' }, { status: 500 });
      }

      if (existingPostAsset && existingPostAsset.id !== assetId) {
        return NextResponse.json({ error: 'This post already has a linked marketplace listing.' }, { status: 409 });
      }
    }

    let workflowGraph: ReturnType<typeof serializeWorkflowGraph> | null = null;
    if (type === 'workflow') {
      if (!canvasId) {
        return NextResponse.json({ error: 'Select a workflow canvas to list.' }, { status: 400 });
      }

      const { data: canvas, error: canvasError } = await supabase
        .from('workflow_canvases')
        .select('id, user_id, graph')
        .eq('id', canvasId)
        .maybeSingle();

      if (canvasError || !canvas || canvas.user_id !== user.id) {
        return NextResponse.json({ error: 'Workflow canvas not found.' }, { status: 404 });
      }

      workflowGraph = serializeWorkflowGraph(
        normalizeWorkflowGraph(canvas.graph as Partial<WorkflowCanvasGraph>)
      );
    }

    if (type === 'prompt_pack' && !promptPack) {
      return NextResponse.json({ error: 'Prompt pack content is required.' }, { status: 400 });
    }

    if (type === 'guide' && !guideMarkdown) {
      return NextResponse.json({ error: 'Guide content is required.' }, { status: 400 });
    }

    if (assetId) {
      const { data: existingAsset, error: assetError } = await supabase
        .from('marketplace_assets')
        .select('id, seller_user_id')
        .eq('id', assetId)
        .maybeSingle();

      if (assetError || !existingAsset || existingAsset.seller_user_id !== user.id) {
        return NextResponse.json({ error: 'Listing not found.' }, { status: 404 });
      }
    }

    const { data: asset, error: assetUpsertError } = await supabase
      .from('marketplace_assets')
      .upsert({
        id: assetId ?? undefined,
        seller_user_id: user.id,
        post_id: postId,
        type,
        title,
        description,
        preview,
        price_usd_cents: priceUsdCents,
        status,
      })
      .select('id, post_id, status')
      .single();

    if (assetUpsertError || !asset) {
      console.error('Failed to upsert marketplace asset:', assetUpsertError);
      return NextResponse.json({ error: 'Failed to save listing.' }, { status: 500 });
    }

    const { error: contentError } = await supabase
      .from('marketplace_asset_content')
      .upsert({
        asset_id: asset.id,
        workflow_graph: type === 'workflow' ? workflowGraph : null,
        prompt_pack: type === 'prompt_pack' ? promptPack : null,
        guide_markdown: type === 'guide' ? guideMarkdown : null,
      });

    if (contentError) {
      console.error('Failed to upsert marketplace asset content:', contentError);
      return NextResponse.json({ error: 'Failed to save listing content.' }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      assetId: asset.id,
      postId: asset.post_id,
      status: asset.status,
    });
  } catch (error) {
    console.error('Marketplace asset save failed:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
