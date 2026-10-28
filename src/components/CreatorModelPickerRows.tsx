'use client';

import { useId } from 'react';
import { Check, X } from 'lucide-react';
import clsx from 'clsx';

import { getAccentClasses, type UiAccent } from '@/components/DesignSystem';
import { groupModelsByBalance, type PricedModel } from '../../ugc-mobile/lib/creator-run-fit/creator-run-fit';
import type { ListedPrice } from '@/lib/use-quote-prices';

/** One model in a creator's model list, with the price of the run it would make. */
export type PickerModelRow = {
  id: string;
  name: string;
  description: string;
  /** The run's price on this model (the price on Generate, for the model in use). */
  price: ListedPrice;
  /** What the price is for: "480P · 5s". */
  summary: string | null;
  /** What the run's references become on this model; null when the run has none. */
  keeps: { words: string; keepsAll: boolean } | null;
};

function priceWords(price: ListedPrice): string {
  if (price.status === 'ready') return `${price.costCredits} ${price.costCredits === 1 ? 'credit' : 'credits'}`;
  return price.status === 'pending' ? '…' : '—';
}

function ModelRow({ row, selected, over, accent, onSelect }: {
  row: PickerModelRow;
  selected: boolean;
  /** Its run costs more than the balance. */
  over: boolean;
  accent: UiAccent;
  onSelect: () => void;
}) {
  const { price } = row;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={clsx(
        'ui-focus-ring flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
        selected ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className={clsx('flex items-center gap-1.5 text-sm font-bold', selected ? 'text-white' : 'text-zinc-200')}>
          {row.name}
          {selected ? <Check aria-hidden className={clsx('h-4 w-4 shrink-0', getAccentClasses(accent).mark)} /> : null}
        </span>
        <span className="mt-0.5 block text-xs text-zinc-400">{row.description}</span>
        {row.keeps ? (
          <span className={clsx('mt-1.5 flex items-center gap-1 text-xs font-semibold', row.keeps.keepsAll ? 'text-emerald-300' : 'text-amber-300')}>
            {row.keeps.keepsAll ? <Check aria-hidden className="h-3.5 w-3.5 shrink-0" /> : <X aria-hidden className="h-3.5 w-3.5 shrink-0" />}
            {row.keeps.words}
          </span>
        ) : null}
        {price.status === 'refused' ? <span className="mt-1.5 block text-xs text-amber-300">{price.message}</span> : null}
      </span>
      <span className="shrink-0 text-right">
        <span
          data-testid="model-row-price"
          className={clsx('block text-sm font-bold tabular-nums', over ? 'text-zinc-400' : 'text-white')}
        >
          {price.status === 'pending' ? <><span aria-hidden>…</span><span className="sr-only">Pricing</span></> : priceWords(price)}
        </span>
        {price.status === 'ready' && row.summary ? (
          <span className="mt-0.5 block text-xs tabular-nums text-zinc-500">{row.summary}</span>
        ) : null}
      </span>
    </button>
  );
}

function RowGroup({ title, rows, selectedId, balance, accent, onSelect }: {
  title: string;
  rows: PricedModel<PickerModelRow>[];
  selectedId: string;
  balance: number;
  accent: UiAccent;
  onSelect: (id: string) => void;
}) {
  const titleId = useId();
  return (
    <div role="group" aria-labelledby={titleId}>
      <div id={titleId} className="px-4 pb-1 pt-3 text-[11px] font-bold uppercase tracking-[0.18em] text-zinc-500">{title}</div>
      {rows.map(({ item, cost }) => (
        <ModelRow
          key={item.id}
          row={item}
          selected={item.id === selectedId}
          over={cost !== null && cost > balance}
          accent={accent}
          onSelect={() => onSelect(item.id)}
        />
      ))}
    </div>
  );
}

/**
 * The rows of a creator's model list, each with the price of the run the creator would
 * make on it, the settings that price is for, and what it keeps of the run's references
 * (owner, 2026-10-28). Once every price is in, the list is split by what the balance
 * covers ("Fits your 22 credits", then "Needs more credits"); until then, and without a
 * balance, it stays in the catalog's order, so rows do not move under the pointer while
 * prices arrive.
 */
export default function CreatorModelPickerRows({ rows, selectedId, balance, balanceLabel, accent, onSelect }: {
  rows: readonly PickerModelRow[];
  selectedId: string;
  /** What the split reads against: the balance, or a visitor's welcome credits; null splits nothing. */
  balance: number | null;
  /** How the first group names that balance: "your 22 credits", "the 25 free credits". */
  balanceLabel: string;
  /** The creator's tool accent, for the mark on the model in use. */
  accent: UiAccent;
  onSelect: (id: string) => void;
}) {
  const priced = rows.map((row): PricedModel<PickerModelRow> => ({
    id: row.id,
    cost: row.price.status === 'ready' ? row.price.costCredits : null,
    item: row,
  }));
  const settled = rows.every((row) => row.price.status !== 'pending');

  if (!settled || balance === null) {
    return (
      <>
        {priced.map(({ item, cost }) => (
          <ModelRow
            key={item.id}
            row={item}
            selected={item.id === selectedId}
            over={balance !== null && cost !== null && cost > balance}
            accent={accent}
            onSelect={() => onSelect(item.id)}
          />
        ))}
      </>
    );
  }
  const split = groupModelsByBalance(priced, balance, selectedId);
  const groupProps = { selectedId, balance, accent, onSelect };
  return (
    <>
      {split.fits.length > 0 ? <RowGroup title={`Fits ${balanceLabel}`} rows={split.fits} {...groupProps} /> : null}
      {split.needsMore.length > 0 ? <RowGroup title="Needs more credits" rows={split.needsMore} {...groupProps} /> : null}
      {split.unpriced.length > 0 ? <RowGroup title="Not priced" rows={split.unpriced} {...groupProps} /> : null}
    </>
  );
}

/** Under a priced model list, outside its options. */
export function CreatorModelPickerFoot() {
  return (
    <p className="shrink-0 border-t border-white/8 px-4 py-3 text-xs text-zinc-500">
      Each price is for the settings under it. Generate shows your run’s exact price.
    </p>
  );
}
