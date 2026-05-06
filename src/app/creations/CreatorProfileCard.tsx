'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AtSign, ExternalLink, Loader2, Save, UserRound, Camera, ImagePlus } from 'lucide-react';

import type { EditableCreatorProfile, ProfileFieldErrors, ProfileUpdatePayload } from '@/lib/profile';
import { supabase } from '@/lib/supabase';

interface CreatorProfileCardProps {
  initialProfile: EditableCreatorProfile | null;
  isLoading: boolean;
  loadError: string | null;
  onProfileSaved?: (profile: EditableCreatorProfile) => void;
  isEmbedded?: boolean;
}

const EMPTY_ERRORS: ProfileFieldErrors = {};

function buildProfilePayload(
  form: EditableCreatorProfile,
  overrides?: Partial<Pick<EditableCreatorProfile, 'avatarUrl' | 'coverUrl'>>
): ProfileUpdatePayload {
  return {
    username: form.username,
    displayName: form.displayName,
    bio: form.bio,
    avatarUrl: overrides?.avatarUrl ?? form.avatarUrl,
    coverUrl: overrides?.coverUrl ?? form.coverUrl,
    websiteUrl: form.websiteUrl,
    twitterHandle: form.twitterHandle,
    instagramHandle: form.instagramHandle,
    tiktokHandle: form.tiktokHandle,
    location: form.location,
  };
}

export default function CreatorProfileCard({
  initialProfile,
  isLoading,
  loadError,
  onProfileSaved,
  isEmbedded = false,
}: CreatorProfileCardProps) {
  const [form, setForm] = useState<EditableCreatorProfile | null>(initialProfile);
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>(EMPTY_ERRORS);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAvatarFile(file);
      setAvatarPreview((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return URL.createObjectURL(file);
      });
      setFieldErrors((c) => ({ ...c, avatarUrl: undefined }));
    }
  };

  const handleCoverChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setCoverFile(file);
      setCoverPreview((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return URL.createObjectURL(file);
      });
      setFieldErrors((c) => ({ ...c, coverUrl: undefined }));
    }
  };

  useEffect(() => {
    setForm(initialProfile);
    setFieldErrors(EMPTY_ERRORS);
    setFormError(null);
  }, [initialProfile]);

  useEffect(() => {
    return () => {
      if (avatarPreview) {
        URL.revokeObjectURL(avatarPreview);
      }
    };
  }, [avatarPreview]);

  useEffect(() => {
    return () => {
      if (coverPreview) {
        URL.revokeObjectURL(coverPreview);
      }
    };
  }, [coverPreview]);

  const updateField = (key: keyof EditableCreatorProfile, value: string) => {
    setForm((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        [key]: value,
      };
    });

    setFieldErrors((current) => ({
      ...current,
      [key]: undefined,
    }));
    setFormError(null);
    setSuccessMessage(null);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form || isSaving) {
      return;
    }

    setIsSaving(true);
    setFieldErrors(EMPTY_ERRORS);
    setFormError(null);
    setSuccessMessage(null);
    const uploadedStoragePaths: string[] = [];

    const cleanupUploadedMedia = async () => {
      if (uploadedStoragePaths.length === 0) {
        return;
      }

      const { error: cleanupError } = await supabase.storage.from('profiles').remove(uploadedStoragePaths);
      if (cleanupError) {
        console.error('Failed to clean up uploaded profile media:', cleanupError);
      }
    };

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setFormError('Please log in again to update your profile.');
        return;
      }

      const validationResponse = await fetch('/api/profile/validate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(buildProfilePayload(form)),
      });
      const validationData = await validationResponse.json();
      if (!validationResponse.ok) {
        if (validationData.fieldErrors) {
          setFieldErrors(validationData.fieldErrors as ProfileFieldErrors);
        }

        setFormError(validationData.error || 'Failed to validate profile.');
        return;
      }

      let finalAvatarUrl = form.avatarUrl;
      let finalCoverUrl = form.coverUrl;
      const profilesStorage = supabase.storage.from('profiles');

      if (avatarFile || coverFile) {
        setSuccessMessage('Uploading new media...');
      }

      if (avatarFile) {
        const fileExt = avatarFile.name.split('.').pop();
        const fileName = `${session.user.id}/avatar-${Date.now()}.${fileExt}`;
        const { error: uploadError } = await profilesStorage.upload(fileName, avatarFile, { upsert: true });
        if (uploadError) throw new Error(`Avatar upload failed: ${uploadError.message}`);
        uploadedStoragePaths.push(fileName);
        const { data: { publicUrl } } = profilesStorage.getPublicUrl(fileName);
        finalAvatarUrl = publicUrl;
      }

      if (coverFile) {
        const fileExt = coverFile.name.split('.').pop();
        const fileName = `${session.user.id}/cover-${Date.now()}.${fileExt}`;
        const { error: uploadError } = await profilesStorage.upload(fileName, coverFile, { upsert: true });
        if (uploadError) throw new Error(`Cover upload failed: ${uploadError.message}`);
        uploadedStoragePaths.push(fileName);
        const { data: { publicUrl } } = profilesStorage.getPublicUrl(fileName);
        finalCoverUrl = publicUrl;
      }

      if (avatarFile || coverFile) {
        setSuccessMessage('Saving profile data...');
      }

      const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify(
          buildProfilePayload(form, {
            avatarUrl: finalAvatarUrl,
            coverUrl: finalCoverUrl,
          })
        ),
      });

      const data = await response.json();
      if (!response.ok) {
        await cleanupUploadedMedia();
        if (data.fieldErrors) {
          setFieldErrors(data.fieldErrors as ProfileFieldErrors);
        }

        setFormError(data.error || 'Failed to update profile.');
        return;
      }

      const nextProfile: EditableCreatorProfile = {
        id: data.id,
        username: data.username ?? '',
        displayName: data.displayName ?? '',
        bio: data.bio ?? '',
        avatarUrl: data.avatarUrl ?? '',
        coverUrl: data.coverUrl ?? '',
        websiteUrl: data.websiteUrl ?? '',
        twitterHandle: data.twitterHandle ?? '',
        instagramHandle: data.instagramHandle ?? '',
        tiktokHandle: data.tiktokHandle ?? '',
        location: data.location ?? '',
        credits: data.credits ?? form.credits,
      };

      setAvatarFile(null);
      setCoverFile(null);
      setAvatarPreview((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return null;
      });
      setCoverPreview((current) => {
        if (current) {
          URL.revokeObjectURL(current);
        }

        return null;
      });
      setForm(nextProfile);
      setSuccessMessage('Creator profile updated.');
      onProfileSaved?.(nextProfile);
    } catch (error) {
      await cleanupUploadedMedia();
      console.error('Failed to update profile:', error);
      setFormError('Failed to update profile.');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="mb-8 rounded-3xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm">
        <div className="h-6 w-48 animate-pulse rounded bg-white/10" />
        <div className="mt-3 h-4 w-80 animate-pulse rounded bg-white/5" />
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <div className="h-12 animate-pulse rounded-2xl bg-black/40" />
          <div className="h-12 animate-pulse rounded-2xl bg-black/40" />
          <div className="h-24 animate-pulse rounded-2xl bg-black/40 md:col-span-2" />
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mb-8 rounded-3xl border border-red-500/20 bg-red-500/5 p-6 text-sm text-red-200">
        {loadError}
      </div>
    );
  }

  if (!form) {
    return null;
  }

  const previewHref = form.username.trim().length > 0 ? `/creators/${form.username.trim().replace(/^@+/, '').toLowerCase()}` : null;

  return (
    <section className="space-y-6">
      {!isEmbedded && (
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between rounded-3xl border border-white/5 bg-zinc-900/40 p-6 backdrop-blur-md shadow-xl">
          <div>
            <div className="flex items-center gap-3">
              <div className="rounded-2xl border border-purple-500/20 bg-purple-500/10 p-3 text-purple-300">
                <UserRound className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white">Creator Profile</h2>
                <p className="mt-1 max-w-2xl text-sm text-zinc-400">
                  Claim your public identity so every showcase post points back to you, not just the output.
                </p>
              </div>
            </div>
          </div>

          {previewHref ? (
            <Link
              href={previewHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/40 px-4 py-2 text-sm font-medium text-zinc-200 transition-colors hover:border-white/20 hover:text-white"
            >
              Preview profile
              <ExternalLink className="h-4 w-4" />
            </Link>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-full border border-white/5 bg-black/20 px-4 py-2 text-sm text-zinc-500">
              Add a username to unlock your public profile
            </span>
          )}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Profile Identity Section */}
        <div className="rounded-3xl border border-white/5 bg-zinc-900/40 p-6 backdrop-blur-md shadow-xl">
          <div className="mb-6 flex flex-col gap-1">
            <h3 className="text-lg font-semibold text-white">Profile Identity</h3>
            <p className="text-sm text-zinc-400">Manage your basic information, avatar, and cover banner.</p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            {/* Live Media Pickers */}
            <div className="md:col-span-2 grid gap-6 sm:grid-cols-2">
              {/* Avatar Picker */}
              <div className="space-y-4">
                <span className="block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Avatar Image</span>
                <div className="flex items-center gap-6">
                  <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full border border-white/10 bg-black/50 shadow-inner">
                    {(avatarPreview || form.avatarUrl) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={avatarPreview || form.avatarUrl} alt="Avatar preview" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-zinc-600">
                        <UserRound className="h-8 w-8" />
                      </div>
                    )}
                  </div>
                  <label className="group relative flex cursor-pointer items-center justify-center gap-2 rounded-2xl border border-white/10 bg-black/40 px-5 py-3 text-sm font-medium text-white transition-all hover:bg-black/60 hover:border-purple-500/50">
                    <Camera className="h-4 w-4 text-purple-400 group-hover:scale-110 transition-transform" />
                    <span>Upload image</span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleAvatarChange}
                      className="hidden"
                    />
                  </label>
                </div>
                {fieldErrors.avatarUrl ? <p className="mt-2 text-xs text-red-300">{fieldErrors.avatarUrl}</p> : null}
              </div>

              {/* Cover Banner Picker */}
              <div className="space-y-4">
                <span className="block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">Cover Banner</span>
                <div className="flex flex-col gap-4">
                  <div className="h-24 w-full shrink-0 overflow-hidden rounded-2xl border border-white/10 bg-black/50 shadow-inner group relative">
                    {(coverPreview || form.coverUrl) ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={coverPreview || form.coverUrl} alt="Cover preview" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-zinc-600">
                        <ImagePlus className="h-8 w-8" />
                      </div>
                    )}
                    <label className="absolute bottom-3 right-3 flex cursor-pointer items-center justify-center">
                      <div className="flex items-center gap-2 rounded-full border border-white/20 bg-black/70 px-4 py-2 text-sm font-medium text-white shadow-lg backdrop-blur-md transition-colors hover:bg-white/10">
                        <Camera className="h-4 w-4 text-pink-400" />
                        <span>{coverPreview || form.coverUrl ? 'Change cover' : 'Upload cover'}</span>
                      </div>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleCoverChange}
                        className="hidden"
                      />
                    </label>
                  </div>
                </div>
                {fieldErrors.coverUrl ? <p className="mt-2 text-xs text-red-300">{fieldErrors.coverUrl}</p> : null}
              </div>
            </div>

            <label className="block">
              <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                <AtSign className="h-3.5 w-3.5" />
                Username
              </span>
              <input
                type="text"
                value={form.username || ''}
                onChange={(event) => updateField('username', event.target.value)}
                placeholder="creator-name"
                className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
                autoComplete="off"
              />
              {fieldErrors.username ? <p className="mt-2 text-xs text-red-300">{fieldErrors.username}</p> : null}
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Display Name
              </span>
              <input
                type="text"
                value={form.displayName || ''}
                onChange={(event) => updateField('displayName', event.target.value)}
                placeholder="Your creator name"
                className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
              />
              {fieldErrors.displayName ? <p className="mt-2 text-xs text-red-300">{fieldErrors.displayName}</p> : null}
            </label>

            <label className="block md:col-span-2">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Location
              </span>
              <input
                type="text"
                value={form.location || ''}
                onChange={(event) => updateField('location', event.target.value)}
                placeholder="e.g. San Francisco, CA"
                className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
              />
              {fieldErrors.location ? <p className="mt-2 text-xs text-red-300">{fieldErrors.location}</p> : null}
            </label>

            <label className="block md:col-span-2">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Bio
              </span>
              <textarea
                value={form.bio || ''}
                onChange={(event) => updateField('bio', event.target.value)}
                placeholder="What kind of UGC creator are you?"
                rows={3}
                className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
              />
              {fieldErrors.bio ? <p className="mt-2 text-xs text-red-300">{fieldErrors.bio}</p> : null}
            </label>
          </div>
        </div>

        {/* Web & Social Links Section */}
        <div className="rounded-3xl border border-white/5 bg-zinc-900/40 p-6 backdrop-blur-md shadow-xl">
          <div className="mb-6 flex flex-col gap-1">
            <h3 className="text-lg font-semibold text-white">Web & Social Links</h3>
            <p className="text-sm text-zinc-400">Connect your portfolio and other social media accounts.</p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            <label className="block md:col-span-2">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Website URL
              </span>
              <input
                type="url"
                value={form.websiteUrl || ''}
                onChange={(event) => updateField('websiteUrl', event.target.value)}
                placeholder="https://yourportfolio.com"
                className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
              />
              {fieldErrors.websiteUrl ? <p className="mt-2 text-xs text-red-300">{fieldErrors.websiteUrl}</p> : null}
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Twitter Handle
              </span>
              <div className="relative">
                <span className="absolute left-4 top-3.5 text-zinc-500">@</span>
                <input
                  type="text"
                  value={form.twitterHandle || ''}
                  onChange={(event) => updateField('twitterHandle', event.target.value)}
                  placeholder="username"
                  className="w-full rounded-2xl border border-white/10 bg-black/40 pl-8 pr-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
                />
              </div>
              {fieldErrors.twitterHandle ? <p className="mt-2 text-xs text-red-300">{fieldErrors.twitterHandle}</p> : null}
            </label>

            <label className="block">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                Instagram Handle
              </span>
              <div className="relative">
                <span className="absolute left-4 top-3.5 text-zinc-500">@</span>
                <input
                  type="text"
                  value={form.instagramHandle || ''}
                  onChange={(event) => updateField('instagramHandle', event.target.value)}
                  placeholder="username"
                  className="w-full rounded-2xl border border-white/10 bg-black/40 pl-8 pr-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
                />
              </div>
              {fieldErrors.instagramHandle ? <p className="mt-2 text-xs text-red-300">{fieldErrors.instagramHandle}</p> : null}
            </label>

            <label className="block md:col-span-2">
              <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
                TikTok Handle
              </span>
              <div className="relative">
                <span className="absolute left-4 top-3.5 text-zinc-500">@</span>
                <input
                  type="text"
                  value={form.tiktokHandle || ''}
                  onChange={(event) => updateField('tiktokHandle', event.target.value)}
                  placeholder="username"
                  className="w-full rounded-2xl border border-white/10 bg-black/40 pl-8 pr-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
                />
              </div>
              {fieldErrors.tiktokHandle ? <p className="mt-2 text-xs text-red-300">{fieldErrors.tiktokHandle}</p> : null}
            </label>
          </div>
        </div>

        {/* Action Bar */}
        <div className="rounded-3xl border border-purple-500/20 bg-purple-900/10 p-6 backdrop-blur-md shadow-[0_0_40px_-15px_rgba(168,85,247,0.3)]">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-zinc-400">
              {form.credits !== null ? (
                <span><strong className="text-purple-300">{form.credits} credits</strong> available right now.</span>
              ) : (
                'Credits will update automatically from your account.'
              )}
            </div>
            <div className="flex flex-col items-start gap-2 sm:items-end">
              {formError ? <p className="text-sm text-red-300">{formError}</p> : null}
              {!formError && successMessage ? <p className="text-sm text-emerald-300">{successMessage}</p> : null}
              <button
                type="submit"
                disabled={isSaving}
                className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-purple-600 to-pink-600 px-8 py-3 text-sm font-semibold text-white shadow-[0_0_20px_-5px_rgba(168,85,247,0.5)] transition-all hover:scale-105 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:scale-100"
              >
                {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      </form>
    </section>
  );
}
