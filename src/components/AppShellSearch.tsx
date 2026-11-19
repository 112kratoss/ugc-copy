'use client';

import Form from 'next/form';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { SearchEntrancePart, SearchEntranceStandIn } from '@/components/search/SearchEntrancePart';
import { isPlainPress, markSearchEntrance } from '@/components/search/search-entrance';
import { markSearchFieldHandoff } from '@/components/search/search-field-handoff';
import type { SearchEntry } from '../../ugc-mobile/lib/public-search-policy/search-open-log';
import { clearSearchHistory, forgetSearchQuery, readSearchHistory } from '@/components/search/search-history';
import { searchStartPanelEntry, searchStartPanelSections, type SearchStartPanelRow } from '@/components/search/search-start-panel';
import { SearchTypeaheadList } from '@/components/search/SearchTypeaheadList';
import { searchTypeaheadEntityRoute } from '@/components/search/search-typeahead-rows';
import { useSearchStarter } from '@/components/search/use-search-starter';
import { useSearchTypeahead, type SearchTypeaheadPick } from '@/components/search/use-search-typeahead';
import { useFieldValueBeforeHydration } from '@/lib/use-field-value-before-hydration';
import { holdForLeaveGuard } from '@/lib/use-leave-guard';

import {
  NO_SEARCH_FILTERS,
  SEARCH_CLEAR_FIELD_LABEL,
  SEARCH_FIELD_LABEL,
  SEARCH_PLACEHOLDER,
  searchFilterParams,
} from '../../ugc-mobile/lib/public-search-policy/public-search-policy';

/**
 * The top bar's search field (from 1024px; below it the bar has a link to
 * /search instead). Enter searches what is typed, on the search page, as it
 * always did. A click or a tap on it, before anything is typed (or the Down
 * key, for a field the Tab key reached), opens a panel under it
 * with what the search page starts from (search-start-panel.ts: this browser's
 * recent searches, each removable, then the starter's models and tools and its
 * searches, with their pictures; owner, 2026-11-16). While the person types,
 * that same panel offers the recent searches the text matches, then creators,
 * models and tools, and completions (`useSearchTypeahead`): every kind, since
 * no results are drawn under it, where the search page's own box leaves out
 * what its tab's results draw. A row goes where that page would take it. The
 * panel is drawn over the page, never in its flow, so it moves nothing.
 *
 * Every way out of here is the shell's and not a link, so each asks a page's
 * leave guard first (`holdForLeaveGuard`): a page with unsaved work asks its
 * question, and a leave goes on to where the row or the search led.
 */
export function AppShellSearch() {
  const router = useRouter();
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  // The server's HTML draws the field, and what is typed into it before the
  // page's script runs reaches no state: the next render would write over it.
  const fieldRef = useRef<HTMLInputElement>(null);
  useFieldValueBeforeHydration(fieldRef, { drawn: text, onValue: setText });
  // This browser's recent searches, read as the field takes the focus (a
  // search made on another page or tab since is among them): the ones the
  // text matches are offered first.
  const [recents, setRecents] = useState<readonly string[]>([]);
  // The starter's answer, asked for once a person reaches for the field (the
  // pointer over it, or the focus in it) and kept for the visit: the field is
  // on every page, and a page that is never searched from asks nothing.
  const [reachedFor, setReachedFor] = useState(false);
  const starter = useSearchStarter({ enabled: reachedFor, kept: true });
  // The search page is prefetched as a person reaches for the field too (a mouse
  // over it, or the focus in it), not as the bar comes into view: the bar is on
  // every page and `/search` is dynamic, so a prefetch on sight ran a function on
  // most page views for a search few of them make (speed baseline, 2026-11-19:
  // two per desktop page). Asked at each reach, as the shell's nav does
  // (`useNavIntentPrefetch`): Next skips one it holds fresh or is still fetching.
  // The shell's other ways in already wait (`prefetch={false}` on
  // `AppShellSearchButton` and `SearchEntryLink`).
  const prefetchSearch = () => router.prefetch('/search');
  const start = useMemo(() => searchStartPanelSections({ recents, starter }), [recents, starter]);
  const typeahead = useSearchTypeahead<SearchStartPanelRow>({ text, focused, recents, start });
  // Whether the focus now arriving was put there by a pointer or a finger.
  const pointerDown = useRef(false);
  const takeFocus = (byPointer: boolean) => {
    if (!focused) {
      setRecents(readSearchHistory());
      // The Tab key passing through the bar opens nothing: the panel under an empty box would put
      // its buttons between the field and the bar's next control on every page (review of #830),
      // and Google's and YouTube's boxes open on a click, not on Tab. Down opens it from there.
      if (!byPointer && text === '') typeahead.closeFor('');
    }
    setFocused(true);
    setReachedFor(true);
    prefetchSearch();
  };
  // A click that landed before the page's script ran left the focus in the
  // field with nobody told: taken up as the field mounts, so the panel the
  // click asked for opens.
  useEffect(() => {
    // Taken as a click: that is what puts the focus in a field before its script has run.
    if (document.activeElement === fieldRef.current) takeFocus(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, as the field mounts
  }, []);
  // A recent search forgotten, or all of them: the focus stays in (or returns to) the field, so the panel stays.
  const forgetRecent = (query: string) => {
    setRecents(forgetSearchQuery(query));
    fieldRef.current?.focus();
  };
  const forgetRecents = () => {
    setRecents(clearSearchHistory());
    fieldRef.current?.focus();
  };

  // `entry`: how the search was entered, handed to the search page for the search log.
  const leaveFor = (path: string, entry: SearchEntry = 'typed') => {
    const leave = () => {
      // A search lands with the focus in the search page's field
      // (search-field-handoff.ts). Marked only as the leave happens: a leave
      // the person cancels hands nothing on.
      // The page's field grows out of this one (search-entrance.ts).
      if (path.startsWith('/search')) {
        markSearchFieldHandoff(Date.now(), entry);
        markSearchEntrance('bar');
      }
      router.push(path);
    };
    if (!holdForLeaveGuard(leave)) leave();
  };

  const runTypeaheadAction = (action: SearchTypeaheadPick<SearchStartPanelRow> | null) => {
    if (!action) return;
    if (action.type === 'creator') {
      leaveFor(`/creators/${encodeURIComponent(action.username)}`);
      return;
    }
    const params = new URLSearchParams();
    if (action.type === 'entity') {
      const route = searchTypeaheadEntityRoute(action.entity, text);
      if (route.type === 'creator') {
        // A model of the catalog nobody has posted with: its creator, with the model chosen.
        leaveFor(route.href);
        return;
      }
      if (route.type === 'top') {
        // A text Posts does not search yet: Top for it, narrowed to nothing (review of #828, N1).
        params.set('q', route.query);
        leaveFor(`/search?${params.toString()}`, 'entity');
        return;
      }
      // Posts for the row's search (its own query where the server gave one,
      // what is typed otherwise), narrowed to the entity and to nothing else:
      // the search page's address for the same press.
      params.set('q', route.query);
      params.set('type', 'posts');
      for (const [name, value] of Object.entries(searchFilterParams({ ...NO_SEARCH_FILTERS, madeWith: action.madeWith }, false))) {
        params.set(name, value);
      }
    } else {
      // The field says what is being searched for, as the search page's does.
      setText(action.query);
      params.set('q', action.query);
    }
    leaveFor(
      `/search?${params.toString()}`,
      action.type === 'entity' ? 'entity' : searchStartPanelEntry(action.row, action.query, text, recents),
    );
  };

  return (
    // The capsule's skin, its magnifier, text and clear button are named for
    // search's entrance (search-entrance.ts): the search page's field grows
    // out of them. The skin is an element of its own, under the rest, so each
    // part travels by itself and only the plain skin is ever stretched.
    <Form
      action="/search"
      prefetch={false}
      // Not a link, so a page's leave guard is asked here: a page with
      // unsaved work asks first, and a leave submits the search again.
      onSubmit={(event) => {
        const form = event.currentTarget;
        if (holdForLeaveGuard(() => form.requestSubmit())) {
          // Held for the page's question; a leave submits again, and is marked then.
          event.preventDefault();
          return;
        }
        // Enter, leaving: the search page takes the focus on in its own field,
        // which grows out of this one.
        markSearchFieldHandoff();
        markSearchEntrance('bar');
      }}
      onPointerDown={() => { pointerDown.current = true; }}
      onFocus={() => {
        const byPointer = pointerDown.current;
        pointerDown.current = false;
        takeFocus(byPointer);
      }}
      onPointerEnter={(event) => {
        setReachedFor(true);
        if (event.pointerType === 'mouse') prefetchSearch();
      }}
      onKeyDown={(event) => {
        // Escape with the focus on a button of the panel (Tab reaches "Clear all" and each remove
        // button): the panel closes and the focus goes back to the field, as Escape in the field
        // closes it. The field's own keys are handled on the field.
        if (event.key !== 'Escape' || event.target === fieldRef.current || !typeahead.shown) return;
        event.preventDefault();
        typeahead.close();
        fieldRef.current?.focus();
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocused(false);
      }}
      className="app-shell-search group relative isolate mx-auto min-w-0 basis-md items-center gap-2.5 rounded-full border border-transparent px-4"
    >
      <SearchEntrancePart origin="bar" part="capsule" side="control">
        <span aria-hidden="true" className="pointer-events-none absolute -inset-px -z-10 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] transition group-focus-within:border-[var(--ui-border-strong)] group-focus-within:bg-[var(--ui-surface-3)]" />
      </SearchEntrancePart>
      <button
        type="submit"
        aria-label="Search"
        className="ui-focus-ring -ml-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--ui-text-faint)] transition hover:text-[var(--ui-text-primary)]"
      >
        <SearchEntrancePart origin="bar" part="icon" side="control">
          <Search className="h-4 w-4" aria-hidden />
        </SearchEntrancePart>
      </button>
      {/* The browser's own clear button is hidden (Chrome and Safari drew it); the field draws its own below. */}
      <SearchEntrancePart origin="bar" part="text" side="control">
        <input
          ref={fieldRef}
          type="search"
          name="q"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => runTypeaheadAction(typeahead.onKeyDown(event))}
          // A click in the field asks for a panel that Escape closed.
          onClick={typeahead.reopen}
          placeholder={SEARCH_PLACEHOLDER}
          aria-label={SEARCH_FIELD_LABEL}
          role="combobox"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-expanded={typeahead.shown}
          aria-controls={typeahead.shown ? typeahead.listId : undefined}
          aria-activedescendant={typeahead.shown ? typeahead.activeOptionId : undefined}
          autoComplete="off"
          className="h-12 min-w-0 flex-1 bg-transparent text-sm text-[var(--ui-text-primary)] outline-none placeholder:text-[var(--ui-text-faint)] [&::-webkit-search-cancel-button]:hidden"
        />
      </SearchEntrancePart>
      {text ? (
        <SearchEntrancePart origin="bar" part="clear" side="control">
          <button
            type="button"
            aria-label={SEARCH_CLEAR_FIELD_LABEL}
            // A press keeps the focus in the field, so the bar stays open under the pointer.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setText('');
              fieldRef.current?.focus();
            }}
            className="ui-focus-ring -mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--ui-text-faint)] transition hover:bg-[var(--ui-surface-3)] hover:text-[var(--ui-text-primary)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </SearchEntrancePart>
      ) : (
        // Holding no text, the bar has no clear button: the field's travels into its end and goes.
        <SearchEntranceStandIn origin="bar" part="clear" className="inset-y-0 right-0 w-11" />
      )}
      {/* Said politely when the list opens or changes. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-search-typeahead-status="">{typeahead.status}</div>
      {typeahead.shown ? (
        <SearchTypeaheadList
          listId={typeahead.listId}
          sections={typeahead.sections}
          query={typeahead.query}
          activeIndex={typeahead.activeIndex}
          busy={typeahead.busy}
          settlingRows={typeahead.settlingRows}
          onPick={(row) => runTypeaheadAction(typeahead.press(row))}
          onHighlight={typeahead.highlightRow}
          onRemoveRecent={forgetRecent}
          onClearRecents={forgetRecents}
          // Under the field, over the page: the bar is the page's top layer.
          // Tall enough for the start panel's three lists on a laptop, and
          // scrolled inside itself on a shorter window.
          className="absolute inset-x-0 top-full mt-2 max-h-[min(42rem,calc(100dvh-6rem))]"
        />
      ) : null}
    </Form>
  );
}

/**
 * The top bar's way into search below 1024px, where its field folds into this
 * round magnifier. The search page's field grows out of it and shrinks back
 * into it (search-entrance.ts): its skin and magnifier are named for that,
 * with unseen stand-ins for the words and the clear button it has no use for.
 * The shell draws it everywhere but on the search page, so it is mounted, and
 * named, whenever it can pair.
 */
export function AppShellSearchButton() {
  return (
    <Link
      href="/search"
      prefetch={false}
      aria-label={SEARCH_FIELD_LABEL}
      onClick={(event) => {
        if (isPlainPress(event)) markSearchEntrance('button');
      }}
      className="app-shell-search-link group ui-focus-ring relative isolate inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-transparent text-[var(--ui-text-muted)] transition hover:text-[var(--ui-text-primary)]"
    >
      <SearchEntrancePart origin="button" part="capsule" side="control">
        <span aria-hidden className="pointer-events-none absolute -inset-px -z-10 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] transition group-hover:bg-[var(--ui-surface-3)]" />
      </SearchEntrancePart>
      <SearchEntrancePart origin="button" part="icon" side="control">
        <Search className="h-[18px] w-[18px]" aria-hidden />
      </SearchEntrancePart>
      {/* No words and no clear button: the field's travel into the
          button, to the right of its magnifier as in the field, and go. */}
      <SearchEntranceStandIn origin="button" part="text" className="inset-y-0 left-9 right-0" />
      <SearchEntranceStandIn origin="button" part="clear" className="inset-y-0 left-9 right-0" />
    </Link>
  );
}
