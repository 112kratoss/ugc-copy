import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET(request: NextRequest) {
    try {
        const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
                global: { headers: { Authorization: request.headers.get('Authorization')! } },
            }
        );

        const { data: { user }, error: authError } = await supabase.auth.getUser();
        if (authError || !user) {
            return NextResponse.json(
                { error: 'Unauthorized' },
                { status: 401 }
            );
        }

        const { data: generations, error } = await supabase
            .from('generations')
            .select('id, output_url, status, created_at, duration, cost, model')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error fetching generations:', error);
            return NextResponse.json(
                { error: 'Failed to fetch generations' },
                { status: 500 }
            );
        }

        // Convert storage paths to signed URLs
        const generationsWithUrls = await Promise.all(
            (generations || []).map(async (gen) => {
                if (!gen.output_url) return gen;

                // Check if the output_url is a storage path (not an http URL)
                if (gen.output_url.startsWith('generated_videos/')) {
                    const filePath = gen.output_url.replace('generated_videos/', '');
                    const { data } = await supabase.storage
                        .from('generated_videos')
                        .createSignedUrl(filePath, 3600);
                    return { ...gen, output_url: data?.signedUrl || gen.output_url };
                }
                if (gen.output_url.startsWith('generated_images/')) {
                    const filePath = gen.output_url.replace('generated_images/', '');
                    const { data } = await supabase.storage
                        .from('generated_images')
                        .createSignedUrl(filePath, 3600);
                    return { ...gen, output_url: data?.signedUrl || gen.output_url };
                }

                // Legacy: already a full URL, return as-is
                return gen;
            })
        );

        return NextResponse.json({ generations: generationsWithUrls });
    } catch (error) {
        console.error('Error in generations API:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
