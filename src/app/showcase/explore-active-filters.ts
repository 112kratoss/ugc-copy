import {
    normalizeShowcaseResourceFilter,
    normalizeShowcaseUnlockFilter,
    type ShowcaseResourceFilter,
    type ShowcaseUnlockFilter,
} from '@/lib/showcase';
import type { SourceToolFilterOption } from '@/lib/source-tools';

export const UNLOCK_FILTERS: Array<{ id: ShowcaseUnlockFilter; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'with-unlock', label: 'Recipes' },
    { id: 'free', label: 'Free' },
    { id: 'paid', label: 'Paid' },
];

export const RESOURCE_FILTERS: Array<{ id: ShowcaseResourceFilter; label: string }> = [
    { id: 'all', label: 'All kinds' },
    { id: 'prompt', label: 'Prompts' },
    { id: 'workflow', label: 'Workflows' },
    { id: 'files', label: 'Files' },
    { id: 'notes', label: 'Notes' },
    { id: 'remix', label: 'Remixable' },
];

/** An Explore lane's filters past its kind and sort. */
export type ExploreLaneFilters = {
    /** A tool's slug. None, an empty one and `all` filter by no tool. */
    tool: string | null;
    unlock: ShowcaseUnlockFilter;
    resource: ShowcaseResourceFilter;
};

export type ExploreActiveFilter = { key: keyof ExploreLaneFilters; label: string };

/**
 * The filters a lane has on, as the filter bar's row under its controls names them: the tool
 * first, then the recipe filter, then the kind. The full client (ShowcaseClient) names them from
 * its controls, the server's shell (ShowcaseBootstrapClient) from the page's filters, and the
 * loading outline counts them from the address, so the row stands in one place, at one height,
 * in all three, and the page does not move as one hands over to the next.
 */
export function exploreActiveFilters(
    lane: ExploreLaneFilters,
    sourceToolOptions: SourceToolFilterOption[]
): ExploreActiveFilter[] {
    const filters: ExploreActiveFilter[] = [];
    if (lane.tool && lane.tool !== 'all') {
        filters.push({
            key: 'tool',
            label: sourceToolOptions.find((option) => option.slug === lane.tool)?.label ?? lane.tool,
        });
    }
    if (lane.unlock !== 'all') {
        filters.push({
            key: 'unlock',
            label: UNLOCK_FILTERS.find((option) => option.id === lane.unlock)?.label ?? lane.unlock,
        });
    }
    if (lane.resource !== 'all') {
        filters.push({
            key: 'resource',
            label: RESOURCE_FILTERS.find((option) => option.id === lane.resource)?.label ?? lane.resource,
        });
    }
    return filters;
}

/** A lane's filters as the page reads them from its address (`(feed)/page.tsx`): each one's first value. */
export function exploreLaneFiltersFromSearchParams(params: Pick<URLSearchParams, 'get'> | null): ExploreLaneFilters {
    return {
        tool: params?.get('tool') ?? null,
        unlock: normalizeShowcaseUnlockFilter(params?.get('unlock')),
        resource: normalizeShowcaseResourceFilter(params?.get('resource')),
    };
}

/** The row, under the bar's controls: one line, scrolled sideways when it is longer than the bar. */
export const EXPLORE_ACTIVE_FILTER_ROW_CLASS = 'mt-2 flex gap-2 overflow-x-auto pb-1 sm:mt-3';

/** One filter in the row, its name and an X: a 20px line of text-sm, py-1.5 and a 1px border (34px). */
export const EXPLORE_ACTIVE_FILTER_PILL_CLASS = 'inline-flex shrink-0 items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-sm text-zinc-200 hover:bg-white/[0.08]';
