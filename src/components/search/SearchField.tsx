import { useRef } from 'react';
import { Search, X } from 'lucide-react';

import { useFieldValueBeforeHydration } from '@/lib/use-field-value-before-hydration';

import {
  SEARCH_CLEAR_FIELD_LABEL,
  SEARCH_FIELD_LABEL,
  SEARCH_PLACEHOLDER,
} from '../../../ugc-mobile/lib/public-search-policy/public-search-policy';

/**
 * The browser's own clear button of a search field, hidden: every search
 * field draws its own, and Chrome and Safari drew theirs beside it.
 */
export const HIDE_NATIVE_SEARCH_CLEAR_CLASS = '[&::-webkit-search-cancel-button]:hidden';

/**
 * The typeahead a field controls: the field is then a combobox (the WAI-ARIA
 * pattern), whose list is drawn by the page (SearchTypeaheadList) under the
 * id it names.
 */
export type SearchFieldCombobox = {
  /** The list is drawn. */
  expanded: boolean;
  listId: string;
  /** The highlighted option's id, or none while the highlight is in the field. */
  activeOptionId?: string;
  /** Sees every key first; one it `preventDefault`s is not the field's. */
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
};

export function SearchField({
  autoFocus = false,
  combobox,
  onChange,
  onClear,
  value,
}: {
  autoFocus?: boolean;
  combobox?: SearchFieldCombobox;
  onChange: (value: string) => void;
  onClear: () => void;
  value: string;
}) {
  // The server's HTML draws the field, and a query typed before the page's script ran never
  // reached the page: nothing was searched for until the next key (2026-11-05;
  // tests/e2e/search-typed-before-script.spec.ts).
  const fieldRef = useRef<HTMLInputElement>(null);
  useFieldValueBeforeHydration(fieldRef, { drawn: value, onValue: onChange });
  return (
    <label className="ui-focus-within-ring flex min-h-14 items-center gap-3 rounded-full border border-white/10 bg-white/[0.055] px-5 shadow-[0_18px_60px_-32px_rgba(0,0,0,0.9)] backdrop-blur-xl">
      <Search className="h-5 w-5 shrink-0 text-zinc-400" aria-hidden="true" />
      <span className="sr-only">{SEARCH_FIELD_LABEL}</span>
      <input
        ref={fieldRef}
        autoFocus={autoFocus}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        {...(combobox ? {
          role: 'combobox',
          'aria-autocomplete': 'list' as const,
          'aria-haspopup': 'listbox' as const,
          'aria-expanded': combobox.expanded,
          // Named only while it is drawn: the id of a list that is not there points at nothing.
          'aria-controls': combobox.expanded ? combobox.listId : undefined,
          'aria-activedescendant': combobox.expanded ? combobox.activeOptionId : undefined,
        } : {})}
        onKeyDown={(event) => {
          // The typeahead first: its Escape closes the list and keeps the
          // text, and only with the list closed does Escape clear the field.
          combobox?.onKeyDown(event);
          if (event.defaultPrevented) return;
          if (event.key === 'Escape' && value) {
            event.preventDefault();
            onClear();
          }
        }}
        placeholder={SEARCH_PLACEHOLDER}
        autoComplete="off"
        // zinc-400: 4.5:1 and more on the field's surface, where zinc-500 was under it.
        className={`min-w-0 flex-1 bg-transparent py-3 text-base text-white outline-none placeholder:text-zinc-400 ${HIDE_NATIVE_SEARCH_CLEAR_CLASS}`}
      />
      {value ? (
        <button
          type="button"
          onClick={onClear}
          className="ui-focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/10 hover:text-white"
          aria-label={SEARCH_CLEAR_FIELD_LABEL}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      ) : null}
    </label>
  );
}
