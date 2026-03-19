import { NextRequest, NextResponse } from 'next/server';
import { createUserClient } from '@/lib/server-helpers';

export async function GET(request: NextRequest) {
    try {
        const supabase = createUserClient(request);
        const {
            data: { user },
            error: authError,
        } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        const idsParam = request.nextUrl.searchParams.get('ids');
        const generationIds = (idsParam ?? '')
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
            .slice(0, 100);

        if (generationIds.length === 0) {
            return NextResponse.json([]);
        }

        const { data, error } = await supabase
            .from('showcase_saves')
            .select('generation_id')
            .eq('user_id', user.id)
            .in('generation_id', generationIds);

        if (error) {
            console.error('Error fetching showcase saved state:', error);
            return NextResponse.json({ error: 'Failed to fetch saved state' }, { status: 500 });
        }

        return NextResponse.json((data ?? []).map((row) => row.generation_id));
    } catch (error) {
        console.error('Showcase saved-state error:', error);
        return NextResponse.json({ error: 'Failed to fetch saved state' }, { status: 500 });
    }
}
