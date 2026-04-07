import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;
  const supabase = createUserClient(request);
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const adminSupabase = createServiceClient();
    const { data, error } = await adminSupabase
      .from('generations')
      .update({
        archived_at: null,
        archived_by_user_id: null,
      })
      .eq('id', id)
      .eq('user_id', user.id)
      .not('archived_at', 'is', null)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('Failed to restore creation:', error);
      return NextResponse.json({ error: 'Failed to restore creation.' }, { status: 500 });
    }

    if (!data) {
      return NextResponse.json({ error: 'Creation not found.' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      restored: true,
    });
  } catch (error) {
    console.error('Failed to restore owner generation:', error);
    return NextResponse.json({ error: 'Failed to restore creation.' }, { status: 500 });
  }
}
