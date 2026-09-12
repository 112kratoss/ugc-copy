import { Search, X } from 'lucide-react';

export function SearchField({
  autoFocus = false,
  onChange,
  onClear,
  value,
}: {
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
  value: string;
}) {
  return (
    <label className="ui-focus-within-ring flex min-h-14 items-center gap-3 rounded-full border border-white/10 bg-white/[0.055] px-5 shadow-[0_18px_60px_-32px_rgba(0,0,0,0.9)] backdrop-blur-xl">
      <Search className="h-5 w-5 shrink-0 text-zinc-400" aria-hidden="true" />
      <span className="sr-only">Search creators, posts, and recipes</span>
      <input
        autoFocus={autoFocus}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.preventDefault();
            onClear();
          }
        }}
        placeholder="Search creators, posts, and recipes"
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent py-3 text-base text-white outline-none placeholder:text-zinc-500"
      />
      {value ? (
        <button
          type="button"
          onClick={onClear}
          className="ui-focus-ring inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-zinc-400 transition hover:bg-white/10 hover:text-white"
          aria-label="Clear search"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>
      ) : null}
    </label>
  );
}
