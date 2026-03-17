import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const category = searchParams.get('category') || 'all';
        const sort = searchParams.get('sort') || 'recent';
        const page = parseInt(searchParams.get('page') || '1', 10);
        const limit = parseInt(searchParams.get('limit') || '20', 10);
        const offset = (page - 1) * limit;

        // Use service role to bypass RLS for aggregating the feed,
        // but we'll manually enforce only fetching public generations
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!
        );

        // Optional authenticated user context to check if they saved an item
        const authHeader = request.headers.get('Authorization');
        let userId: string | null = null;
        if (authHeader) {
            const authClient = createClient(
                process.env.NEXT_PUBLIC_SUPABASE_URL!,
                process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
                { global: { headers: { Authorization: authHeader } } }
            );
            const { data: { user } } = await authClient.auth.getUser();
            userId = user?.id || null;
        }

        // Build base query
        let query = supabase
            .from('generations')
            .select(`
                id, 
                output_url, 
                model, 
                prompt,
                workflow_settings,
                status, 
                is_public, 
                title, 
                category, 
                save_count, 
                remix_count, 
                created_at,
                user_id
            `, { count: 'exact' })
            .eq('is_public', true)
            .eq('status', 'succeeded')
            .not('output_url', 'is', null);

        // Apply filters
        if (category !== 'all' && category !== 'ugc-ad') {
            query = query.eq('category', category);
        } else if (category === 'ugc-ad') {
            // Future-proofing: right now all our creations are kinda AI, but if we tag them specifically:
            query = query.eq('category', 'video'); // Placeholder logic for now
        }

        // Apply sorting
        if (sort === 'top-saves') {
            query = query.order('save_count', { ascending: false }).order('created_at', { ascending: false });
        } else if (sort === 'top-remixes') {
            query = query.order('remix_count', { ascending: false }).order('created_at', { ascending: false });
        } else {
            // Default to recent
            query = query.order('created_at', { ascending: false });
        }

        // Apply pagination
        query = query.range(offset, offset + limit - 1);

        const { data: generations, error, count } = await query;

        if (error) {
            console.error('Error fetching showcase feed:', error);
            throw error;
        }

        // Get signed URLs, "hasSaved" status, AND user profiles
        let savedGenerationIds: Set<string> = new Set();
        let profilesMap: Record<string, any> = {};

        if (generations && generations.length > 0) {
            const genIds = generations.map(g => g.id);
            const userIds = Array.from(new Set(generations.map(g => g.user_id).filter(Boolean)));
            
            // Fetch saves
            if (userId) {
                const { data: saves } = await supabase
                    .from('showcase_saves')
                    .select('generation_id')
                    .eq('user_id', userId)
                    .in('generation_id', genIds);
                
                if (saves) {
                    savedGenerationIds = new Set(saves.map(s => s.generation_id));
                }
            }

            // Fetch profiles
            if (userIds.length > 0) {
                const { data: profiles } = await supabase
                    .from('profiles')
                    .select('id, email, display_name, avatar_url')
                    .in('id', userIds);
                
                if (profiles) {
                    profiles.forEach(p => {
                        profilesMap[p.id] = p;
                    });
                }
            }
        }

        // Map and sign URLs
        const feedItems = await Promise.all((generations || []).map(async (gen) => {
            let finalUrl = gen.output_url;

            // Generate signed URL if it's a private storage path
            if (gen.output_url && !gen.output_url.startsWith('http')) {
                // Determine bucket based on typical paths
                let bucket = 'generated_images';
                if (gen.output_url.startsWith('generated_videos/')) bucket = 'generated_videos';

                const fileName = gen.output_url.split('/').pop() || '';
                const idFolder = gen.output_url.split('/')[1]; // usually user_id
                const path = bucket === 'generated_images' ? `${idFolder}/${fileName}` : fileName;
                
                // For videos, the path structure might be simpler in generated_videos
                const finalPath = bucket === 'generated_videos' ? (gen.output_url.replace('generated_videos/', '')) : path;

                const { data: signedData } = await supabase.storage
                    .from(bucket)
                    .createSignedUrl(finalPath, 3600);
                
                if (signedData?.signedUrl) {
                    finalUrl = signedData.signedUrl;
                }
            }

            // Fallback display name from our manually fetched profiles
            const profile = gen.user_id ? profilesMap[gen.user_id] : null;
            const displayName = profile?.display_name || profile?.email?.split('@')[0] || 'Anonymous';

            return {
                id: gen.id,
                url: finalUrl,
                model: gen.model,
                prompt: gen.prompt || '',
                workflowSettings: gen.workflow_settings || {},
                title: gen.title || 'Untitled Creation',
                category: gen.category,
                saveCount: gen.save_count || 0,
                remixCount: gen.remix_count || 0,
                createdAt: gen.created_at,
                creator: {
                    id: profile?.id,
                    name: displayName,
                    avatar: profile?.avatar_url
                },
                hasSaved: savedGenerationIds.has(gen.id)
            };
        }));

        const totalPages = count ? Math.ceil(count / limit) : 0;

        return NextResponse.json({
            items: feedItems,
            pagination: {
                total: count || 0,
                page,
                limit,
                totalPages,
                hasMore: page < totalPages
            }
        });

    } catch (error) {
        console.error('Showcase feed error:', error);
        return NextResponse.json({ error: 'Failed to fetch showcase feed' }, { status: 500 });
    }
}
