import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAudioModel } from '@/lib/models';

type ShowcaseCategory = 'image' | 'video' | 'motion' | 'ugc-ad';

function detectCategoryFromModel(model: string): ShowcaseCategory {
    if (model.includes('banana')) return 'image';
    if (model === 'kling-3.0/video' || model.includes('/video')) return 'video';
    if (model.startsWith('kling-')) return 'motion';
    return 'image';
}

export async function POST(request: NextRequest) {
    try {
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            { global: { headers: { Authorization: request.headers.get('Authorization')! } } }
        );

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const { generationId, isPublic, title, description, prompt, category, workflowSettings } = await request.json();

        if (!generationId) {
            return NextResponse.json({ error: 'Missing generation ID' }, { status: 400 });
        }

        // Verify ownership
        const { data: generation, error: fetchError } = await supabase
            .from('generations')
            .select('id, user_id, status, model, category')
            .eq('id', generationId)
            .single();

        if (fetchError || !generation) {
            return NextResponse.json({ error: 'Generation not found' }, { status: 404 });
        }

        if (generation.user_id !== user.id) {
            return NextResponse.json({ error: 'Unauthorized: You do not own this creation' }, { status: 403 });
        }

        if (generation.status !== 'succeeded') {
            return NextResponse.json({ error: 'Cannot publish a generation that has not succeeded' }, { status: 400 });
        }

        if (isPublic && (generation.category === 'audio' || isAudioModel(generation.model))) {
            return NextResponse.json({ error: 'Audio generations are not publishable to the showcase yet' }, { status: 400 });
        }

        // Auto-detect category if not provided
        let detectedCategory: ShowcaseCategory | undefined = category ?? generation.category ?? undefined;
        if (!detectedCategory && isPublic) {
            detectedCategory = detectCategoryFromModel(generation.model);
        }

        // Build update payload
        const updatePayload: { is_public: boolean; [key: string]: unknown } = { is_public: isPublic };
        
        // Only update these if making it public (or if explicitly passed)
        if (isPublic) {
            // Overwrite stored prompt and settings only if provided during publish
            // (ideally we save these at generation time, but this acts as a fallback)
            if (title !== undefined) updatePayload.title = title;
            if (description !== undefined) updatePayload.description = description;
            if (prompt !== undefined) updatePayload.prompt = prompt;
            if (detectedCategory !== undefined) updatePayload.category = detectedCategory;
            if (workflowSettings !== undefined) updatePayload.workflow_settings = workflowSettings;
        }

        const { error: updateError } = await supabase
            .from('generations')
            .update(updatePayload)
            .eq('id', generationId);

        if (updateError) {
            console.error('Error updating generation visibility:', updateError);
            return NextResponse.json({ error: 'Failed to update visibility' }, { status: 500 });
        }

        return NextResponse.json({ 
            success: true, 
            isPublic,
            message: isPublic ? 'Successfully published to showcase' : 'Successfully removed from showcase'
        });

    } catch (error) {
        console.error('Publish error:', error);
        return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
    }
}
