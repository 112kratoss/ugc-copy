'use client';

import { Check, ChevronDown, Search } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

export interface ToolFilterOption {
  label: string;
  href: string;
  active: boolean;
}

const subscribeToHydration = () => () => undefined;
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;

/**
 * The tool filter, as a searchable disclosure rather than a row of pills.
 *
 * There are 64 tools. As pills in an `overflow-x-auto` strip that was ~6,500px
 * of content inside a ~520px rail — everything past the fourth tool reachable
 * only by a horizontal scroll nobody discovers, on a control whose whole job is
 * to be discoverable. A trigger plus a filterable list turns "scroll blindly"
 * into "type three letters".
 *
 * Built on `<details>` rather than React state on purpose. This renders inside
 * the bootstrap shell, which must work before hydration and without JavaScript:
 * the options have to be real links in the document, and the disclosure has to
 * open, with no React involved. The state below only *enhances* that — it adds
 * filtering, Escape, and click-outside on top of markup that already works.
 *
 * Access (3 options) and Kind (6) stay as pills: at that count showing the
 * options outright beats hiding them behind a click.
 */
export default function MarketplaceToolFilter({ options }: { options: ToolFilterOption[] }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // The marketplace bootstrap is a demand shell that stays unhydrated until the
  // viewer scrolls, so a filter box rendered before that point would swallow
  // keystrokes and do nothing. This is false on the server and through the first
  // client render, and true only once React is genuinely attached — the same
  // hydration probe AppShellClient and useSupabaseAuthCookieHint use.
  const enhanced = useSyncExternalStore(
    subscribeToHydration,
    getHydratedSnapshot,
    getServerHydratedSnapshot
  );
  const detailsRef = useRef<HTMLDetailsElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selected = options.find((option) => option.active);
  const needle = query.trim().toLowerCase();

  const close = () => {
    if (detailsRef.current) detailsRef.current.open = false;
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;

    // Focus the field, not the first option: with 64 tools the fastest route to
    // any of them is typing, not arrowing through a long list.
    const frame = window.requestAnimationFrame(() => searchRef.current?.focus());

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
      detailsRef.current?.querySelector('summary')?.focus();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && detailsRef.current?.contains(event.target)) return;
      close();
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open]);

  // Index 0 is always the "All tools" reset, so anything past it is a real
  // selection worth accenting on the trigger.
  const isToolSelected = options.findIndex((option) => option.active) > 0;

  return (
    <div className="relative min-w-0">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-zinc-500">
        Tool
      </div>

      <details
        ref={detailsRef}
        className="group"
        onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary
          className={`ui-focus-ring flex cursor-pointer list-none items-center justify-between gap-2 rounded-full border px-3.5 py-2 text-sm transition duration-150 active:scale-[0.98] [&::-webkit-details-marker]:hidden ${
            isToolSelected
              ? 'border-[rgba(255,122,89,0.3)] bg-[var(--ui-primary-soft)] font-semibold text-[var(--ui-text-primary)]'
              : 'border-white/10 bg-white/[0.03] text-zinc-300 hover:bg-white/[0.06] hover:text-white'
          }`}
        >
          <span className="truncate">{selected?.label ?? 'All tools'}</span>
          <ChevronDown
            className="h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200 group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>

        {/* Grows from the trigger it belongs to, and from 0.96 rather than 0 —
            nothing in the real world appears out of nothing. */}
        <div className="ui-enter-pop absolute left-0 right-0 z-30 mt-2 origin-top overflow-hidden rounded-2xl border border-white/12 bg-[#0b0b0f] shadow-[0_24px_60px_rgba(0,0,0,0.6)]">
          {enhanced ? (
            <div className="flex items-center gap-2 border-b border-white/8 px-3 py-2.5">
              <Search className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter tools"
                aria-label="Filter tools"
                className="w-full bg-transparent text-sm text-white outline-none placeholder:text-zinc-600"
              />
            </div>
          ) : null}

          <div className="max-h-72 overflow-y-auto p-1.5">
            {options.map((option) => {
              // Filtered out by hiding rather than unmounting, so every tool
              // stays a real link in the document for the no-JS pass.
              const hidden = needle.length > 0 && !option.label.toLowerCase().includes(needle);
              return (
                <Link
                  key={option.label}
                  href={option.href}
                  prefetch={false}
                  onClick={close}
                  className={`ui-focus-ring items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm transition ${
                    hidden ? 'hidden' : 'flex'
                  } ${
                    option.active
                      ? 'bg-[var(--ui-primary-soft)] font-semibold text-[var(--ui-text-primary)]'
                      : 'text-zinc-300 hover:bg-white/[0.06] hover:text-white'
                  }`}
                >
                  <span className="truncate">{option.label}</span>
                  {option.active ? (
                    <Check className="h-4 w-4 shrink-0 text-[var(--ui-primary)]" aria-hidden="true" />
                  ) : null}
                </Link>
              );
            })}
          </div>
        </div>
      </details>
    </div>
  );
}
