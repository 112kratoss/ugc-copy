import { NextRequest, NextResponse } from 'next/server';

import { validateProfileSubmission } from '@/lib/profile-server';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

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

    const adminSupabase = createServiceClient();
    const validation = await validateProfileSubmission(
      adminSupabase,
      user.id,
      await request.json()
    );

    if (!validation.ok) {
      return NextResponse.json(validation.body, { status: validation.status });
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Profile validate error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
