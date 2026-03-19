'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AtSign, ExternalLink, Loader2, Save, UserRound } from 'lucide-react';

import type { EditableCreatorProfile, ProfileFieldErrors } from '@/lib/profile';
import { supabase } from '@/lib/supabase';

interface CreatorProfileCardProps {
  initialProfile: EditableCreatorProfile | null;
  isLoading: boolean;
  loadError: string | null;
  onProfileSaved?: (profile: EditableCreatorProfile) => void;
}

const EMPTY_ERRORS: ProfileFieldErrors = {};

export default function CreatorProfileCard({
  initialProfile,
  isLoading,
  loadError,
  onProfileSaved,
}: CreatorProfileCardProps) {
  const [form, setForm] = useState<EditableCreatorProfile | null>(initialProfile);
  const [fieldErrors, setFieldErrors] = useState<ProfileFieldErrors>(EMPTY_ERRORS);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    setForm(initialProfile);
    setFieldErrors(EMPTY_ERRORS);
    setFormError(null);
  }, [initialProfile]);

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

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session?.access_token) {
        setFormError('Please log in again to update your profile.');
        return;
      }

      const response = await fetch('/api/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          username: form.username,
          displayName: form.displayName,
          bio: form.bio,
          avatarUrl: form.avatarUrl,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
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
        credits: data.credits ?? form.credits,
      };

      setForm(nextProfile);
      setSuccessMessage('Creator profile updated.');
      onProfileSaved?.(nextProfile);
    } catch (error) {
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
    <section className="mb-8 rounded-3xl border border-white/5 bg-zinc-900/30 p-6 backdrop-blur-sm">
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
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

      <form onSubmit={handleSubmit} className="mt-6 grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            <AtSign className="h-3.5 w-3.5" />
            Username
          </span>
          <input
            type="text"
            value={form.username}
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
            value={form.displayName}
            onChange={(event) => updateField('displayName', event.target.value)}
            placeholder="Your creator name"
            className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
          />
          {fieldErrors.displayName ? <p className="mt-2 text-xs text-red-300">{fieldErrors.displayName}</p> : null}
        </label>

        <label className="block md:col-span-2">
          <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            Bio
          </span>
          <textarea
            value={form.bio}
            onChange={(event) => updateField('bio', event.target.value)}
            placeholder="What kind of UGC creator are you?"
            rows={3}
            className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
          />
          {fieldErrors.bio ? <p className="mt-2 text-xs text-red-300">{fieldErrors.bio}</p> : null}
        </label>

        <label className="block md:col-span-2">
          <span className="mb-2 block text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500">
            Avatar URL
          </span>
          <input
            type="url"
            value={form.avatarUrl}
            onChange={(event) => updateField('avatarUrl', event.target.value)}
            placeholder="https://example.com/avatar.jpg"
            className="w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white outline-none transition-colors focus:border-purple-500/50"
          />
          {fieldErrors.avatarUrl ? <p className="mt-2 text-xs text-red-300">{fieldErrors.avatarUrl}</p> : null}
        </label>

        <div className="md:col-span-2 flex flex-col gap-3 border-t border-white/5 pt-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-sm text-zinc-500">
            {form.credits !== null ? `${form.credits} credits available right now.` : 'Credits will update automatically from your account.'}
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            {formError ? <p className="text-sm text-red-300">{formError}</p> : null}
            {!formError && successMessage ? <p className="text-sm text-emerald-300">{successMessage}</p> : null}
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center gap-2 rounded-full bg-gradient-to-r from-purple-600 to-pink-600 px-5 py-2.5 text-sm font-semibold text-white shadow-[0_0_20px_-6px_rgba(168,85,247,0.45)] transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save profile
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
