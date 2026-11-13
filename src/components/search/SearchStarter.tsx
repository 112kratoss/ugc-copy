'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Box, Search, Wrench } from 'lucide-react';

import { getUserInitials } from '@/lib/profile';

import {
  searchCreatorCardLabel,
  searchEntityActionLabel,
  searchEntityCountLabel,
  searchEntityKindLabel,
} from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';
import { searchTypeaheadRowLabel } from '../../../ugc-mobile/lib/public-search-policy/search-typeahead';
import {
  SEARCH_STARTER_LABEL,
  isSearchStarterEmpty,
  parseSearchStarterResponse,
  searchStarterSections,
  type SearchStarterEntity,
  type SearchStarterResponse,
  type SearchStarterSearch,
} from '../../../ugc-mobile/lib/public-search-policy/search-starter';

// The browser's Supabase client, loaded when the request needs the session, as
// the typeahead loads it.
const loadSupabase = () => import('@/lib/supabase').then((module) => module.supabase);

/**
 * What to start a search from (`GET /api/search/starter`), asked once per
 * opening of the page and kept for its life: the answer is drawn under the
 * empty box and again under a search that found nothing. Null until it lands,
 * and for good when it cannot be had (the route switched off or not there yet,
 * a refusal, offline, an answer that is not one, or one with nothing in it):
 * the page then draws what it drew before. A visitor's request carries no
 * token and is the edge's to keep (about a minute); an account's carries its
 * token, so a creator it follows or has blocked is left out. So it is asked
 * again when the account changes (a sign-in or a sign-out on this page or in
 * another tab), never for the SIGNED_IN supabase-js repeats for the same
 * account each time the tab comes back into view.
 */
export function useSearchStarter(): SearchStarterResponse | null {
  const [answer, setAnswer] = useState<SearchStarterResponse | null>(null);
  useEffect(() => {
    let disposed = false;
    let stopWatching: (() => void) | null = null;
    let request: AbortController | null = null;
    // The account the answer on hand was asked for; undefined while none has been asked.
    let askedFor: string | null | undefined;
    const ask = async (supabase: Awaited<ReturnType<typeof loadSupabase>>) => {
      request?.abort();
      const controller = new AbortController();
      request = controller;
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (controller.signal.aborted) return;
        askedFor = session?.user?.id ?? null;
        const response = await fetch('/api/search/starter', {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : undefined,
          signal: controller.signal,
        });
        if (!response.ok) return;
        const parsed = parseSearchStarterResponse(await response.json().catch(() => null));
        if (!controller.signal.aborted && !isSearchStarterEmpty(parsed)) setAnswer(parsed);
      } catch {
        // An extra: its failure is drawn as nothing.
      }
    };
    void loadSupabase().then((supabase) => {
      if (disposed) return;
      const { data } = supabase.auth.onAuthStateChange((event, session) => {
        if (event !== 'SIGNED_IN' && event !== 'SIGNED_OUT') return;
        const next = event === 'SIGNED_OUT' ? null : session?.user?.id ?? null;
        if (askedFor === undefined || next === askedFor) return;
        // Another account: what was offered to the one before is not this one's.
        askedFor = undefined;
        setAnswer(null);
        void ask(supabase);
      });
      stopWatching = () => data.subscription.unsubscribe();
      void ask(supabase);
    }).catch(() => {});
    return () => {
      disposed = true;
      stopWatching?.();
      request?.abort();
    };
  }, []);
  return answer;
}

const HEADING_CLASS = 'mb-3 text-base font-semibold text-white';

/** A section's heading: under the page's h1 an h2, under the starter's own h2 ("Try one of these instead") an h3. */
function SectionHeading({ id, level, children }: { id: string; level: 2 | 3; children: React.ReactNode }) {
  return level === 2
    ? <h2 id={id} className={HEADING_CLASS}>{children}</h2>
    : <h3 id={id} className={HEADING_CLASS}>{children}</h3>;
}

/**
 * The starter's three lists, each under its heading, in the shared order;
 * an empty list draws no heading. `heading`: one over them all, as on a
 * search that found nothing ("Try one of these instead").
 */
export function SearchStarter({
  answer,
  heading = null,
  onEntity,
  onSearch,
}: {
  answer: SearchStarterResponse;
  heading?: string | null;
  /** A model or tool pressed: Posts for its own query, narrowed to it. */
  onEntity: (entity: SearchStarterEntity) => void;
  /** A suggested search pressed: put in the box and searched, as Enter does. */
  onSearch: (search: SearchStarterSearch) => void;
}) {
  const sections = searchStarterSections(answer);
  if (sections.length === 0) return null;
  const sectionLevel = heading ? 3 : 2;
  return (
    <section aria-label={SEARCH_STARTER_LABEL} data-search-starter="" className="space-y-8">
      {heading ? <h2 className="text-xl font-semibold text-white">{heading}</h2> : null}
      {sections.map((section) => {
        const headingId = `search-starter-${section.id}`;
        if (section.id === 'entities') {
          return (
            <div key={section.id}>
              <SectionHeading id={headingId} level={sectionLevel}>{section.heading}</SectionHeading>
              <ul aria-labelledby={headingId} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {section.entities.map((entity) => {
                  const Icon = entity.kind === 'model' ? Box : Wrench;
                  return (
                    <li key={`${entity.kind}:${entity.key}`}>
                      <button
                        type="button"
                        aria-label={searchEntityActionLabel(entity)}
                        onClick={() => onEntity(entity)}
                        className="ui-focus-ring flex min-h-16 w-full items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.035] px-4 py-3 text-left transition hover:border-white/15 hover:bg-white/[0.065]"
                      >
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-[var(--ui-primary)]">
                          <Icon className="h-4.5 w-4.5" aria-hidden="true" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-white">{entity.label}</span>
                          <span className="mt-0.5 block truncate text-xs text-zinc-400">
                            {searchEntityKindLabel(entity.kind)} · {searchEntityCountLabel(entity)}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        }
        if (section.id === 'creators') {
          return (
            <div key={section.id}>
              <SectionHeading id={headingId} level={sectionLevel}>{section.heading}</SectionHeading>
              <ul aria-labelledby={headingId} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {section.creators.map((creator) => (
                  <li key={creator.id}>
                    <Link
                      href={`/creators/${encodeURIComponent(creator.username)}`}
                      prefetch={false}
                      aria-label={searchCreatorCardLabel(creator)}
                      className="ui-focus-ring flex min-h-16 items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.035] px-4 py-3 transition hover:border-white/15 hover:bg-white/[0.065]"
                    >
                      {creator.avatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={creator.avatarUrl} alt="" loading="lazy" className="h-10 w-10 shrink-0 rounded-full border border-white/10 object-cover" />
                      ) : (
                        <span aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-xs font-bold text-zinc-200">
                          {getUserInitials(creator.displayName)}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-white">{creator.displayName}</span>
                        <span className="mt-0.5 block truncate text-xs text-zinc-400">@{creator.username}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          );
        }
        return (
          <div key={section.id}>
            <SectionHeading id={headingId} level={sectionLevel}>{section.heading}</SectionHeading>
            <ul aria-labelledby={headingId} className="flex flex-wrap gap-2">
              {section.searches.map((search) => (
                <li key={search.text}>
                  <button
                    type="button"
                    aria-label={searchTypeaheadRowLabel({ kind: 'completion', key: search.text, text: search.text })}
                    onClick={() => onSearch(search)}
                    className="ui-focus-ring inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 text-sm font-semibold text-zinc-200 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
                  >
                    <Search className="h-4 w-4 text-zinc-400" aria-hidden="true" />
                    {search.text}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
