'use client';

import { useSearchParams } from 'next/navigation';

import {
    EXPLORE_ACTIVE_FILTER_ROW_CLASS,
    exploreActiveFilters,
    exploreLaneFiltersFromSearchParams,
} from '@/app/showcase/explore-active-filters';
import { SkeletonBlock } from '@/components/TabLoadingShell';

/**
 * The loading outline's place for the filter bar's row of active filters. The outline is drawn
 * before the page has read anything, but the address names the lane's filters, and a lane with
 * one draws the row (the server's shell from the page's filters, then the full page from its
 * controls): one bar of a pill's height for each, so the grid lands where the outline's cards
 * stood. A pill is `py-1.5` around a `text-sm` line inside a 1px border, 2rem + 2px (34px at the
 * default font size), and the bar is sized the same way so it grows with a larger font as the
 * pill does.
 */
export default function ExploreActiveFiltersPlaceholder() {
    const filters = exploreActiveFilters(exploreLaneFiltersFromSearchParams(useSearchParams()), []);
    if (filters.length === 0) {
        return null;
    }

    return (
        <div aria-hidden="true" data-explore-active-filters="" className={EXPLORE_ACTIVE_FILTER_ROW_CLASS}>
            {filters.map((filter) => (
                <SkeletonBlock key={filter.key} className="h-[calc(2rem+2px)] w-28 shrink-0" />
            ))}
        </div>
    );
}
