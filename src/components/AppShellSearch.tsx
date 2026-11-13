'use client';

import Form from 'next/form';
import { useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { useRef, useState } from 'react';

import { markSearchFieldHandoff } from '@/components/search/search-field-handoff';
import { readSearchHistory } from '@/components/search/search-history';
import { SearchTypeaheadList } from '@/components/search/SearchTypeaheadList';
import { useSearchTypeahead } from '@/components/search/use-search-typeahead';
import { useFieldValueBeforeHydration } from '@/lib/use-field-value-before-hydration';
import { holdForLeaveGuard } from '@/lib/use-leave-guard';

import {
  NO_SEARCH_FILTERS,
  SEARCH_CLEAR_FIELD_LABEL,
  SEARCH_FIELD_LABEL,
  SEARCH_PLACEHOLDER,
  normalizeSearchHistoryQuery,
  searchFilterParams,
} from '../../ugc-mobile/lib/public-search-policy/public-search-policy';
import type { SearchTypeaheadAction } from '../../ugc-mobile/lib/public-search-policy/search-typeahead';

/**
 * The top bar's search field (from 1024px; below it the bar has a link to
 * /search instead). Enter searches what is typed, on the search page, as it
 * always did. While the person types it offers the recent searches the text
 * matches, then creators, models and tools, and completions
 * (`useSearchTypeahead`): every kind, since no results are drawn under it, where
 * the search page's own box offers only what changes the query. A row goes
 * where that page would take it.
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
  const typeahead = useSearchTypeahead({ text, focused, recents });

  const leaveFor = (path: string) => {
    const leave = () => {
      // A search lands with the focus in the search page's field
      // (search-field-handoff.ts). Marked only as the leave happens: a leave
      // the person cancels hands nothing on.
      if (path.startsWith('/search')) markSearchFieldHandoff();
      router.push(path);
    };
    if (!holdForLeaveGuard(leave)) leave();
  };

  const runTypeaheadAction = (action: SearchTypeaheadAction | null) => {
    if (!action) return;
    if (action.type === 'creator') {
      leaveFor(`/creators/${encodeURIComponent(action.username)}`);
      return;
    }
    const params = new URLSearchParams();
    if (action.type === 'entity') {
      // Posts for what is typed, narrowed to the entity and to nothing else:
      // the search page's address for the same press.
      params.set('q', normalizeSearchHistoryQuery(text));
      params.set('type', 'posts');
      for (const [name, value] of Object.entries(searchFilterParams({ ...NO_SEARCH_FILTERS, madeWith: action.madeWith }, false))) {
        params.set(name, value);
      }
    } else {
      // The field says what is being searched for, as the search page's does.
      setText(action.query);
      params.set('q', action.query);
    }
    leaveFor(`/search?${params.toString()}`);
  };

  return (
    <Form
      action="/search"
      // Not a link, so a page's leave guard is asked here: a page with
      // unsaved work asks first, and a leave submits the search again.
      onSubmit={(event) => {
        const form = event.currentTarget;
        if (holdForLeaveGuard(() => form.requestSubmit())) {
          // Held for the page's question; a leave submits again, and is marked then.
          event.preventDefault();
          return;
        }
        // Enter, leaving: the search page takes the focus on in its own field.
        markSearchFieldHandoff();
      }}
      onFocus={() => {
        if (!focused) setRecents(readSearchHistory());
        setFocused(true);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) setFocused(false);
      }}
      className="app-shell-search relative mx-auto min-w-0 basis-md items-center gap-2.5 rounded-full border border-[var(--ui-border-default)] bg-[var(--ui-surface-2)] px-4 transition focus-within:border-[var(--ui-border-strong)] focus-within:bg-[var(--ui-surface-3)]"
    >
      <button
        type="submit"
        aria-label="Search"
        className="ui-focus-ring -ml-2 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--ui-text-faint)] transition hover:text-[var(--ui-text-primary)]"
      >
        <Search className="h-4 w-4" aria-hidden />
      </button>
      {/* The browser's own clear button is hidden (Chrome and Safari drew it); the field draws its own below. */}
      <input
        ref={fieldRef}
        type="search"
        name="q"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => runTypeaheadAction(typeahead.onKeyDown(event))}
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
      {text ? (
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
      ) : null}
      {/* Said politely when the list opens or changes. */}
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-search-typeahead-status="">{typeahead.status}</div>
      {typeahead.shown ? (
        <SearchTypeaheadList
          listId={typeahead.listId}
          sections={typeahead.sections}
          query={typeahead.query}
          activeIndex={typeahead.activeIndex}
          stale={typeahead.stale}
          busy={typeahead.busy}
          settlingRows={typeahead.settlingRows}
          onPick={(row) => runTypeaheadAction(typeahead.press(row))}
          onHighlight={typeahead.highlightRow}
          // Under the field, over the page: the bar is the page's top layer.
          className="absolute inset-x-0 top-full mt-2 max-h-[min(26rem,calc(100dvh-6rem))]"
        />
      ) : null}
    </Form>
  );
}
