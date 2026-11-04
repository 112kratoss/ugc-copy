'use client';

import type { ReactNode } from 'react';
import Image from 'next/image';
import { Globe2, Instagram, MapPin, Music2, Twitter } from 'lucide-react';

import type { CreatorProfilePageData } from '@/lib/creator-profile';
import {
  normalizeSocialProfileHandle,
  type EditableCreatorProfile,
  type SocialProfileField,
} from '@/lib/profile';

import { CreatorProfileActions, useCreatorPageProfile } from './CreatorPageViewer';

/**
 * Social pills, each opening the platform it names. A row saved before the
 * server checked handles can hold any text, a link to another site included,
 * so a pill is drawn only for a value that reads as that platform's handle (a
 * pasted link on its own host counts), and the handle is encoded into the path.
 */
const SOCIAL_LINKS: ReadonlyArray<{
  field: SocialProfileField;
  label: string;
  icon: ReactNode;
  buildHref: (encodedHandle: string) => string;
}> = [
  { field: 'instagramHandle', label: 'Instagram', icon: <Instagram className="h-4 w-4" />, buildHref: (handle) => `https://instagram.com/${handle}` },
  { field: 'tiktokHandle', label: 'TikTok', icon: <Music2 className="h-4 w-4" />, buildHref: (handle) => `https://tiktok.com/@${handle}` },
  { field: 'twitterHandle', label: 'X', icon: <Twitter className="h-4 w-4" />, buildHref: (handle) => `https://x.com/${handle}` },
];

/**
 * The creator page's header: cover, avatar, name, handle, place, bio, the
 * page's actions and links, with the server's totals (`stats`) under them.
 * Drawn in the browser as well as the cached render so that a creator who has
 * just saved their profile sees it here while the cache catches up
 * (`useCreatorPageProfile`); everyone else sees the page's read.
 */
export function CreatorProfileHeader({
  profile: pageProfile,
  stats,
}: {
  profile: CreatorProfilePageData['profile'];
  /** The totals, drawn by the server: their numbers are formatted there. */
  stats: ReactNode;
}) {
  const profile = useCreatorPageProfile(pageProfile);
  const profileForActions: EditableCreatorProfile = {
    id: profile.id,
    username: profile.username,
    displayName: profile.displayName,
    bio: profile.bio ?? '',
    avatarUrl: profile.avatarUrl ?? '',
    coverUrl: profile.coverUrl ?? '',
    websiteUrl: profile.websiteUrl ?? '',
    twitterHandle: profile.twitterHandle ?? '',
    instagramHandle: profile.instagramHandle ?? '',
    tiktokHandle: profile.tiktokHandle ?? '',
    location: profile.location ?? '',
    credits: null,
  };

  return (
    <section className="overflow-hidden rounded-3xl border border-white/8 bg-[#111215] shadow-[0_24px_80px_-60px_rgba(255,122,89,0.32)]">
      <div className="relative h-40 overflow-hidden bg-[#0b0c10] sm:h-52 lg:h-60">
        {profile.coverUrl ? (
          // Full-bleed banner: served at viewport width rather than at
          // whatever the creator uploaded, which was previously the raw
          // source at full resolution on every profile view.
          <Image
            src={profile.coverUrl}
            alt={`${profile.displayName} cover`}
            fill
            sizes="(min-width: 1560px) 1560px, 100vw"
            className="object-cover"
          />
        ) : (
          <div className="h-full w-full bg-[linear-gradient(120deg,rgba(255,122,89,0.15),rgba(17,18,21,0.92)_44%,rgba(242,185,94,0.08))]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[#111215] via-transparent to-black/10" />
      </div>

      <div className="relative px-4 pb-5 sm:px-7 sm:pb-7 lg:px-9">
        <div className="-mt-12 flex flex-col gap-5 lg:-mt-14 lg:flex-row lg:items-end lg:justify-between">
          <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-end">
            {profile.avatarUrl ? (
              // Renders at 96-112px, so there is no reason to ship the
              // uploaded original here.
              <Image
                src={profile.avatarUrl}
                alt={`${profile.displayName} avatar`}
                width={112}
                height={112}
                sizes="(min-width: 640px) 112px, 96px"
                className="h-24 w-24 shrink-0 rounded-full border-4 border-[#111215] bg-zinc-900 object-cover shadow-xl sm:h-28 sm:w-28"
              />
            ) : (
              <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full border-4 border-[#111215] bg-zinc-800 text-3xl font-black text-white shadow-xl sm:h-28 sm:w-28">
                {profile.displayName[0]?.toUpperCase() ?? 'C'}
              </div>
            )}

            <div className="min-w-0 max-w-3xl pb-1">
              <h1 className="truncate text-3xl font-black tracking-normal text-white sm:text-4xl">
                {profile.displayName}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
                <span className="font-bold text-sky-300">@{profile.username}</span>
                {profile.location ? (
                  <span className="inline-flex items-center gap-1.5 text-zinc-400">
                    <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                    {profile.location}
                  </span>
                ) : null}
              </div>
              {profile.bio ? (
                <p className="mt-3 max-w-2xl text-sm leading-6 text-zinc-300">{profile.bio}</p>
              ) : null}
            </div>
          </div>

          <div className="pb-1 lg:shrink-0">
            {/* Follow and Share, or for a viewer who blocked the creator the menu alone. */}
            <CreatorProfileActions profile={profileForActions} />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {profile.websiteUrl ? (
            <SocialLink href={profile.websiteUrl} label="Website" icon={<Globe2 className="h-4 w-4" />} />
          ) : null}
          {SOCIAL_LINKS.map(({ field, label, icon, buildHref }) => {
            const storedValue = profile[field];
            const handle = storedValue ? normalizeSocialProfileHandle(field, storedValue) : null;
            return handle ? (
              <SocialLink key={field} href={buildHref(encodeURIComponent(handle))} label={label} icon={icon} />
            ) : null;
          })}
        </div>

        {stats}
      </div>
    </section>
  );
}

function SocialLink({ href, icon, label }: { href: string; icon: ReactNode; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="ui-focus-ring inline-flex min-h-10 items-center gap-2 rounded-full border border-white/8 bg-white/[0.04] px-3.5 text-xs font-bold text-zinc-300 transition hover:border-white/18 hover:bg-white/[0.07] hover:text-white"
    >
      {icon}
      {label}
    </a>
  );
}
