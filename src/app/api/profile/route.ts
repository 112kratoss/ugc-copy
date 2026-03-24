import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  buildProfileApiResponse,
  PROFILE_SELECT_FIELDS,
  type ProfileRow,
  validateProfileSubmission,
} from '@/lib/profile-server';

export async function GET(request: NextRequest) {
  try {
    const supabase = createUserClient(request);
    const adminSupabase = createServiceClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: profile, error } = await adminSupabase
      .from('profiles')
      .select(PROFILE_SELECT_FIELDS)
      .eq('id', user.id)
      .maybeSingle();

    if (error) {
      console.error('Failed to fetch profile:', error);
      return NextResponse.json({ error: 'Failed to fetch profile' }, { status: 500 });
    }

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    return NextResponse.json(buildProfileApiResponse(profile as ProfileRow, user.id));
  } catch (error) {
    console.error('Profile GET error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const supabase = createUserClient(request);
    const adminSupabase = createServiceClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const validation = await validateProfileSubmission(
      adminSupabase,
      user.id,
      await request.json()
    );
    if (!validation.ok) {
      return NextResponse.json(validation.body, { status: validation.status });
    }

    const { data: updatedProfile, error: updateError } = await adminSupabase
      .from('profiles')
      .update({
        username: validation.payload.data.username ?? validation.existingUsername,
        display_name: validation.payload.data.displayName,
        bio: validation.payload.data.bio,
        avatar_url: validation.payload.data.avatarUrl,
        cover_url: validation.payload.data.coverUrl,
        website_url: validation.payload.data.websiteUrl,
        twitter_handle: validation.payload.data.twitterHandle,
        instagram_handle: validation.payload.data.instagramHandle,
        tiktok_handle: validation.payload.data.tiktokHandle,
        location: validation.payload.data.location,
      })
      .eq('id', user.id)
      .select(PROFILE_SELECT_FIELDS)
      .single();

    if (updateError) {
      if (updateError.code === '23505') {
        return NextResponse.json(
          {
            error: 'That username is already taken.',
            fieldErrors: { username: 'That username is already taken.' },
          },
          { status: 409 }
        );
      }

      console.error('Failed to update profile:', updateError);
      return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 });
    }

    return NextResponse.json(buildProfileApiResponse(updatedProfile as ProfileRow, user.id));
  } catch (error) {
    console.error('Profile PATCH error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
