import { NextRequest, NextResponse } from 'next/server';

import { createServiceClient, createUserClient } from '@/lib/server-helpers';
import {
  buildProfileApiResponse,
  PROFILE_SELECT_FIELDS,
  type ProfileRow,
  validateProfileSubmission,
} from '@/lib/profile-server';
import {
  buildFallbackUsername,
  getAuthAvatarUrl,
  getCreatorDisplayName,
  type ProfileApiResponse,
} from '@/lib/profile';

function buildStarterProfileApiResponse(user: {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}): ProfileApiResponse {
  const metadata = user.user_metadata ?? null;
  const metadataName =
    typeof metadata?.full_name === 'string'
      ? metadata.full_name
      : typeof metadata?.name === 'string'
        ? metadata.name
        : null;

  return {
    id: user.id,
    username: null,
    suggestedUsername: buildFallbackUsername(user.id),
    displayName: getCreatorDisplayName({
      displayName: metadataName,
      email: user.email ?? null,
    }),
    bio: null,
    avatarUrl: getAuthAvatarUrl(metadata),
    coverUrl: null,
    websiteUrl: null,
    twitterHandle: null,
    instagramHandle: null,
    tiktokHandle: null,
    location: null,
    credits: null,
  };
}

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
      return NextResponse.json(buildStarterProfileApiResponse(user));
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

    const profileValues = {
      id: user.id,
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
    };

    const { data: updatedProfile, error: updateError } = await adminSupabase
      .from('profiles')
      .upsert(profileValues, {
        onConflict: 'id',
      })
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
