'use client';

import { Box, Search, Wrench } from 'lucide-react';

import {
  searchCreatorCardLabel,
  searchEntityActionLabel,
  searchEntityCountLabel,
  searchEntityKindLabel,
  type SearchEntity,
  type SearchThumbnail,
} from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';
import { searchTypeaheadRowLabel } from '../../../ugc-mobile/lib/public-search-policy/search-typeahead';
import {
  SEARCH_STARTER_LABEL,
  searchStarterHeading,
  searchStarterPeriod,
  searchStarterSections,
  type SearchStarterEntity,
  type SearchStarterResponse,
  type SearchStarterSearch,
} from '../../../ugc-mobile/lib/public-search-policy/search-starter';
import { CreatorSearchResult } from './CreatorSearchResult';
import { SearchRowPicture } from './SearchRowPicture';

// The answer's reader, kept beside the starter it feeds (the top bar reads it without this file's cards).
export { useSearchStarter, useSearchStarterState } from './use-search-starter';

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
 * A model or tool as a card: its picture (or its glyph, in the same frame),
 * its name, its kind and count. The start screen's rows and the "Models and
 * tools" results of a Top search are the same card, so the same model looks
 * the same wherever search offers it. `thumbnail` stands in where the entity
 * itself carries none: a search result's entity does not, and the page then
 * gives the picture it already holds for that model from the start screen or
 * from a suggestion (SearchClient's `entityPictures`).
 */
export function SearchEntityCard<Entity extends SearchEntity>({
  entity,
  thumbnail = null,
  onPress,
}: {
  entity: Entity;
  thumbnail?: SearchThumbnail | null;
  onPress: (entity: Entity) => void;
}) {
  return (
    <button
      type="button"
      aria-label={searchEntityActionLabel(entity)}
      onClick={() => onPress(entity)}
      className="ui-focus-ring flex min-h-16 w-full items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.035] p-2 pr-4 text-left transition-[background-color,border-color,scale] duration-150 ease-out hover:border-white/15 hover:bg-white/[0.065] motion-safe:active:scale-[0.985]"
    >
      {/* The entity's own word first, a "none" included; the picture the page holds only where it says nothing. */}
      <SearchRowPicture thumbnail={entity.thumbnail !== undefined ? entity.thumbnail : thumbnail} icon={entity.kind === 'model' ? Box : Wrench} className="h-12 w-12 rounded-lg" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-white">{entity.label}</span>
        <span className="mt-0.5 block truncate text-xs text-zinc-400">
          {searchEntityKindLabel(entity.kind)} · {searchEntityCountLabel(entity)}
        </span>
      </span>
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
                    <SearchEntityCard entity={entity} onPress={onEntity} />
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
              {/* As many columns as fit cards of 20rem: by the room the list has, not the window's
                  width. Beside the shell's sidebar a 640px breakpoint gave two columns of 15rem,
                  where Follow left the name three letters ("Mag…", owner's live check 2026-11-16). */}
              <ul aria-labelledby={headingId} className="grid grid-cols-[repeat(auto-fill,minmax(min(20rem,100%),1fr))] gap-3">
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
