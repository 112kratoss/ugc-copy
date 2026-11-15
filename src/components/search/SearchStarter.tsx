'use client';

import { useEffect, useState } from 'react';
import { Box, Search, Wrench } from 'lucide-react';

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
  searchStarterHeading,
  searchStarterPeriod,
  searchStarterSections,
  type SearchStarterEntity,
  type SearchStarterResponse,
  type SearchStarterSearch,
} from '../../../ugc-mobile/lib/public-search-policy/search-starter';
import { CreatorSearchResult } from './CreatorSearchResult';
import { SearchRowPicture } from './SearchRowPicture';

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
 * A search offered as a chip: its picture (or the magnifier, in the same
 * round frame) and its words, put in the box and searched when pressed. The
 * starter's searches and an answer's related searches are drawn alike.
 */
export function SearchQueryChip({
  text,
  thumbnail = null,
  onPress,
}: {
  text: string;
  thumbnail?: SearchStarterSearch['thumbnail'];
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={searchTypeaheadRowLabel({ kind: 'completion', key: text, text })}
      onClick={onPress}
      className="ui-focus-ring inline-flex min-h-11 max-w-full shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] py-1.5 pl-1.5 pr-4 text-sm font-semibold text-zinc-200 transition-[background-color,border-color,color,scale] duration-150 ease-out hover:border-white/20 hover:bg-white/[0.08] hover:text-white motion-safe:active:scale-[0.97]"
    >
      <SearchRowPicture thumbnail={thumbnail} icon={Search} className="h-8 w-8 rounded-full" iconClassName="h-4 w-4 text-zinc-400" />
      <span className="truncate">{text}</span>
    </button>
  );
}

/**
 * The starter's three lists, each under its heading, in the shared order;
 * an empty list draws no heading. `heading`: one over them all, as on a
 * search that found nothing ("Try one of these instead"). A list made from
 * this week says so in its heading, and only then (`periods`,
 * searchStarterHeading). Each model, tool and search carries the picture of a
 * post it opens, where there is one (SearchRowPicture).
 */
export function SearchStarter({
  answer,
  heading = null,
  viewerId = null,
  followed,
  onEntity,
  onSearch,
  onFollowChange,
}: {
  answer: SearchStarterResponse;
  heading?: string | null;
  /** The signed-in account: its own row, if offered, has no Follow. */
  viewerId?: string | null;
  /** Creators this page has seen followed or unfollowed since the answer came, by id. */
  followed?: Readonly<Record<string, boolean>>;
  /** A model or tool pressed: Posts for its own query, narrowed to it. */
  onEntity: (entity: SearchStarterEntity) => void;
  /** A suggested search pressed: put in the box and searched, as Enter does. */
  onSearch: (search: SearchStarterSearch) => void;
  onFollowChange?: (creatorId: string, following: boolean) => void;
}) {
  const sections = searchStarterSections(answer);
  if (sections.length === 0) return null;
  const sectionLevel = heading ? 3 : 2;
  return (
    <section aria-label={SEARCH_STARTER_LABEL} data-search-starter="" className="space-y-8">
      {heading ? <h2 className="text-xl font-semibold text-white">{heading}</h2> : null}
      {sections.map((section) => {
        const headingId = `search-starter-${section.id}`;
        const sectionHeading = searchStarterHeading(section.id, searchStarterPeriod(answer, section.id));
        if (section.id === 'entities') {
          return (
            <div key={section.id}>
              <SectionHeading id={headingId} level={sectionLevel}>{sectionHeading}</SectionHeading>
              <ul aria-labelledby={headingId} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {section.entities.map((entity) => (
                  <li key={`${entity.kind}:${entity.key}`} className="min-w-0">
                    <button
                      type="button"
                      aria-label={searchEntityActionLabel(entity)}
                      onClick={() => onEntity(entity)}
                      className="ui-focus-ring flex min-h-16 w-full items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.035] p-2 pr-4 text-left transition-[background-color,border-color,scale] duration-150 ease-out hover:border-white/15 hover:bg-white/[0.065] motion-safe:active:scale-[0.985]"
                    >
                      <SearchRowPicture thumbnail={entity.thumbnail} icon={entity.kind === 'model' ? Box : Wrench} className="h-12 w-12 rounded-lg" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold text-white">{entity.label}</span>
                        <span className="mt-0.5 block truncate text-xs text-zinc-400">
                          {searchEntityKindLabel(entity.kind)} · {searchEntityCountLabel(entity)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        }
        if (section.id === 'creators') {
          return (
            <div key={section.id}>
              <SectionHeading id={headingId} level={sectionLevel}>{sectionHeading}</SectionHeading>
              <ul aria-labelledby={headingId} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {section.creators.map((item) => {
                  const creator = { ...item, isFollowing: followed?.[item.id] ?? item.isFollowing };
                  return (
                    <li key={creator.id} className="min-w-0">
                      <CreatorSearchResult
                        variant="starter"
                        creator={creator}
                        label={searchCreatorCardLabel(creator)}
                        viewerId={viewerId}
                        onFollowChange={onFollowChange}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        }
        return (
          <div key={section.id}>
            <SectionHeading id={headingId} level={sectionLevel}>{sectionHeading}</SectionHeading>
            <ul aria-labelledby={headingId} className="flex flex-wrap gap-2">
              {section.searches.map((search) => (
                <li key={search.text} className="max-w-full">
                  <SearchQueryChip text={search.text} thumbnail={search.thumbnail} onPress={() => onSearch(search)} />
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
