import { NextRequest, NextResponse } from 'next/server';

import { buildFallbackUsername, sanitizeProfileRecord, validateProfileUpdate } from '@/lib/profile';
import { createServiceClient, createUserClient } from '@/lib/server-helpers';

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  cover_url: string | null;
  website_url: string | null;
  twitter_handle: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  location: string | null;
  credits: number | null;
};

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
      .select('id, username, display_name, bio, avatar_url, cover_url, website_url, twitter_handle, instagram_handle, tiktok_handle, location, credits')
      .eq('id', user.id)
      .maybeSingle();

    if (error) {
      console.error('Failed to fetch profile:', error);
      return NextResponse.json({ error: 'Failed to fetch profile' }, { status: 500 });
    }

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    return NextResponse.json({
      ...sanitizeProfileRecord({
        ...(profile as ProfileRow),
        username: profile.username ?? buildFallbackUsername(user.id),
      }),
    });
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

    const payload = validateProfileUpdate(await request.json());
    if (Object.keys(payload.fieldErrors).length > 0) {
      return NextResponse.json(
        { error: 'Please fix the highlighted fields.', fieldErrors: payload.fieldErrors },
        { status: 400 }
      );
    }

    const { data: existingProfile, error: existingError } = await adminSupabase
      .from('profiles')
      .select('id, username')
      .eq('id', user.id)
      .maybeSingle();

    if (existingError) {
      console.error('Failed to load current profile:', existingError);
      return NextResponse.json({ error: 'Failed to load profile' }, { status: 500 });
    }

    if (payload.data.username) {
      const { data: duplicateProfile, error: duplicateError } = await adminSupabase
        .from('profiles')
        .select('id')
        .eq('username', payload.data.username)
        .neq('id', user.id)
        .maybeSingle();

      if (duplicateError) {
        console.error('Failed to validate username:', duplicateError);
        return NextResponse.json({ error: 'Failed to validate username' }, { status: 500 });
      }

      if (duplicateProfile) {
        return NextResponse.json(
          {
            error: 'That username is already taken.',
            fieldErrors: { username: 'That username is already taken.' },
          },
          { status: 409 }
        );
      }
    }

    const { data: updatedProfile, error: updateError } = await adminSupabase
      .from('profiles')
      .update({
        username: payload.data.username ?? (existingProfile?.username ?? buildFallbackUsername(user.id)),
        display_name: payload.data.displayName,
        bio: payload.data.bio,
        avatar_url: payload.data.avatarUrl,
        cover_url: payload.data.coverUrl,
        website_url: payload.data.websiteUrl,
        twitter_handle: payload.data.twitterHandle,
        instagram_handle: payload.data.instagramHandle,
        tiktok_handle: payload.data.tiktokHandle,
        location: payload.data.location,
      })
      .eq('id', user.id)
      .select('id, username, display_name, bio, avatar_url, cover_url, website_url, twitter_handle, instagram_handle, tiktok_handle, location, credits')
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

    return NextResponse.json(sanitizeProfileRecord(updatedProfile as ProfileRow));
  } catch (error) {
    console.error('Profile PATCH error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
