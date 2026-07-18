'use client';

import { ChevronDown, Plus } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface CreatableComboboxOption {
  value: string;
  label: string;
  provisional?: boolean;
  keywords?: string[];
  meta?: string;
  hiddenUntilSearch?: boolean;
}

interface CreatableComboboxProps {
  ariaLabel: string;
  value: string;
  options: CreatableComboboxOption[];
  placeholder: string;
  disabled?: boolean;
  emptyOptionLabel?: string;
  allowCreate?: boolean;
  allowCustomEdit?: boolean;
  maxLength?: number;
  onSelect: (option: CreatableComboboxOption | null) => void;
  onCreate?: (label: string) => void;
  onCustomEdit?: (label: string) => void;
}

type MenuEntry =
  | { type: 'empty'; key: string; label: string }
  | { type: 'option'; key: string; option: CreatableComboboxOption }
  | { type: 'create'; key: string; label: string };

function normalizeSearch(value: string) {
  return value.trim().toLocaleLowerCase();
}

export default function CreatableCombobox({
  ariaLabel,
  value,
  options,
  placeholder,
  disabled = false,
  emptyOptionLabel,
  allowCreate = true,
  allowCustomEdit = false,
  maxLength = 80,
  onSelect,
  onCreate,
  onCustomEdit,
}: CreatableComboboxProps) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [draftQuery, setDraftQuery] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const query = draftQuery ?? value;

  useEffect(() => {
    const closeOnOutsidePointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
        setDraftQuery(null);
      }
    };

    document.addEventListener('mousedown', closeOnOutsidePointer);
    return () => document.removeEventListener('mousedown', closeOnOutsidePointer);
  }, []);

  const normalizedQuery = normalizeSearch(query);
  const matchingOptions = useMemo(() => {
    if (!normalizedQuery) {
      return options.filter((option) => !option.hiddenUntilSearch);
    }

    return options.filter((option) => (
      normalizeSearch(option.label).includes(normalizedQuery)
      || normalizeSearch(option.value).includes(normalizedQuery)
      || (option.keywords ?? []).some((keyword) => normalizeSearch(keyword).includes(normalizedQuery))
    ));
  }, [normalizedQuery, options]);

  const hasExactMatch = options.some((option) => (
    normalizeSearch(option.label) === normalizedQuery
    || normalizeSearch(option.value) === normalizedQuery
  ));
  const canCreate = Boolean(allowCreate && onCreate && normalizedQuery && !hasExactMatch);

  const entries = useMemo<MenuEntry[]>(() => {
    const next: MenuEntry[] = [];
    if (emptyOptionLabel && (!normalizedQuery || normalizeSearch(emptyOptionLabel).includes(normalizedQuery))) {
      next.push({ type: 'empty', key: 'empty', label: emptyOptionLabel });
    }
    matchingOptions.forEach((option) => {
      next.push({ type: 'option', key: `option-${option.value}`, option });
    });
    if (canCreate) {
      next.push({ type: 'create', key: `create-${normalizedQuery}`, label: query.trim() });
    }
    return next;
  }, [canCreate, emptyOptionLabel, matchingOptions, normalizedQuery, query]);

  const safeActiveIndex = entries.length === 0 ? -1 : Math.min(activeIndex, entries.length - 1);

  const chooseEntry = (entry: MenuEntry) => {
    if (entry.type === 'empty') {
      onSelect(null);
    } else if (entry.type === 'option') {
      onSelect(entry.option);
    } else {
      onCreate?.(entry.label);
    }
    setDraftQuery(null);
    setIsOpen(false);
    setActiveIndex(-1);
  };

  const commitCustomEdit = () => {
    if (!allowCustomEdit || !onCustomEdit || !value || query.trim() === value.trim()) {
      return;
    }

    const exactOption = options.some((option) => normalizeSearch(option.label) === normalizedQuery);
    if (!exactOption && query.trim()) {
      onCustomEdit(query.trim());
    }
    setDraftQuery(null);
  };

  return (
    <div ref={rootRef} className="relative min-w-0 basis-full sm:basis-0 sm:flex-1">
      <div className="relative">
        <input
          aria-autocomplete="list"
          aria-controls={`${id}-listbox`}
          aria-expanded={isOpen}
          aria-label={ariaLabel}
          aria-activedescendant={safeActiveIndex >= 0 ? `${id}-option-${safeActiveIndex}` : undefined}
          autoComplete="off"
          disabled={disabled}
          maxLength={maxLength}
          placeholder={placeholder}
          role="combobox"
          value={query}
          onBlur={commitCustomEdit}
          onChange={(event) => {
            setDraftQuery(event.target.value);
            setIsOpen(true);
            setActiveIndex(0);
          }}
          onFocus={() => {
            setIsOpen(true);
            setActiveIndex(-1);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setIsOpen(true);
              setActiveIndex((current) => entries.length === 0 ? -1 : Math.min(current + 1, entries.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setIsOpen(true);
              setActiveIndex((current) => entries.length === 0 ? -1 : current <= 0 ? entries.length - 1 : current - 1);
            } else if (event.key === 'Enter' && isOpen && entries.length > 0) {
              event.preventDefault();
              chooseEntry(entries[safeActiveIndex >= 0 ? safeActiveIndex : 0]);
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setDraftQuery(null);
              setIsOpen(false);
              setActiveIndex(-1);
            }
          }}
          className="w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 pr-10 text-sm text-white outline-none transition placeholder:text-zinc-500 focus:border-sky-400/40 focus:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-70"
        />
        <button
          type="button"
          aria-label={`Open ${ariaLabel}`}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (isOpen) {
              setDraftQuery(null);
            }
            setIsOpen(!isOpen);
          }}
          className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center text-zinc-500 transition hover:text-white disabled:cursor-not-allowed"
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>

      {isOpen && !disabled ? (
        <div
          id={`${id}-listbox`}
          role="listbox"
          className="absolute z-50 mt-2 max-h-64 w-full overflow-y-auto rounded-2xl border border-white/10 bg-zinc-950 p-1.5 shadow-[0_20px_60px_rgba(0,0,0,0.65)]"
        >
          {entries.length > 0 ? entries.map((entry, index) => {
            const isActive = index === safeActiveIndex;
            const label = entry.type === 'option' ? entry.option.label : entry.label;
            const isSelected = entry.type === 'option' && normalizeSearch(entry.option.label) === normalizeSearch(value);

            return (
              <button
                key={entry.key}
                id={`${id}-option-${index}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-label={entry.type === 'create' ? `Create “${label}”` : label}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => chooseEntry(entry)}
                className={`flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition ${
                  isActive ? 'bg-white/10 text-white' : 'text-zinc-300 hover:bg-white/[0.06] hover:text-white'
                }`}
              >
                {entry.type === 'create' ? <Plus className="h-4 w-4 text-sky-300" /> : null}
                <span className="min-w-0 flex-1 truncate">
                  {entry.type === 'create' ? `Create “${label}”` : label}
                </span>
                {entry.type === 'option' && entry.option.provisional ? (
                  <span aria-hidden="true" className="text-[10px] uppercase text-sky-300">New</span>
                ) : entry.type === 'option' && entry.option.meta ? (
                  <span aria-hidden="true" className="shrink-0 rounded-full border border-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
                    {entry.option.meta}
                  </span>
                ) : null}
              </button>
            );
          }) : (
            <div className="px-3 py-2.5 text-sm text-zinc-500">No matches</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
