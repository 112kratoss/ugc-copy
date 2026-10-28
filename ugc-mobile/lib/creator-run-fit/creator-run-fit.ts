/**
 * How a creator fits a run to a model and to a balance, on the web and, once it adopts
 * it, in the app: which settings a model opens on when a creator switches to it, how the
 * model list is split by what the balance covers, which model a remix opens on when the
 * original costs more than the balance, and how an option's price is read against the
 * balance ("23 · +1"). Each side brings its own facts (its descriptors, its form, the
 * prices its server quoted); the decisions are made here, so the two cannot decide
 * differently. The web bundle compiles this file too: keep it free of React Native, Expo
 * and Node imports.
 */

export type FitSettingValue = string | number | boolean;

/** A model's control, as far as fitting a run to it reads one (the catalog descriptor's shape). */
export type FitControl =
  | { key: string; type: 'choice'; defaultValue: string; options: ReadonlyArray<{ value: string }> }
  | { key: string; type: 'integer'; defaultValue: number; min: number; max: number; step?: number }
  | { key: string; type: 'boolean'; defaultValue: boolean };

/**
 * A resolution's height in pixels, near enough to order resolutions by: "480p" is 480,
 * "768P" 768, "2K" 2000 and "4k" 4000. Null for anything else ("Auto").
 */
export function resolutionRank(value: string): number | null {
  const pixels = /^(\d{3,4})p$/i.exec(value.trim());
  if (pixels) return Number(pixels[1]);
  const thousands = /^(\d+(?:\.\d+)?)k$/i.exec(value.trim());
  return thousands ? Number(thousands[1]) * 1000 : null;
}

/** The value nearest `target` by `measure`; of two as near, the smaller (the cheaper run). */
function nearest<T>(values: readonly T[], target: number, measure: (value: T) => number | null): T | null {
  let best: { value: T; distance: number; size: number } | null = null;
  for (const value of values) {
    const size = measure(value);
    if (size === null) continue;
    const distance = Math.abs(size - target);
    if (!best || distance < best.distance || (distance === best.distance && size < best.size)) {
      best = { value, distance, size };
    }
  }
  return best?.value ?? null;
}

function numeric(value: FitSettingValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function fitChoice(control: Extract<FitControl, { type: 'choice' }>, current: FitSettingValue | undefined): string {
  const values = control.options.map((option) => option.value);
  if (current !== undefined && values.includes(String(current))) return String(current);
  if (typeof current === 'string' && control.key === 'resolution') {
    const rank = resolutionRank(current);
    const fitted = rank === null ? null : nearest(values, rank, resolutionRank);
    if (fitted !== null) return fitted;
  }
  // A length offered as a list ("4", "8", "12"): the nearest one.
  const length = numeric(current);
  if (length !== null && values.every((value) => numeric(value) !== null)) {
    const fitted = nearest(values, length, numeric);
    if (fitted !== null) return fitted;
  }
  return control.defaultValue;
}

function fitInteger(control: Extract<FitControl, { type: 'integer' }>, current: FitSettingValue | undefined): number {
  const value = numeric(current);
  if (value === null) return control.defaultValue;
  const step = control.step && control.step > 0 ? control.step : 1;
  const clamped = Math.min(control.max, Math.max(control.min, value));
  return Math.min(control.max, control.min + Math.round((clamped - control.min) / step) * step);
}

/**
 * The settings a model opens on when a creator moves a run to it: every setting of the
 * run that the model offers is kept; a length or a resolution it does not offer becomes
 * the nearest it does (of two as near, the shorter or the lower, which costs less); any
 * other setting it does not offer, and any it has that the run lacks, takes the model's
 * own default. Only the model's own settings come back.
 */
export function fitSettingsToControls(
  controls: readonly FitControl[],
  current: Readonly<Record<string, FitSettingValue | undefined>>,
): Record<string, FitSettingValue> {
  const fitted: Record<string, FitSettingValue> = {};
  for (const control of controls) {
    const value = current[control.key];
    if (control.type === 'choice') fitted[control.key] = fitChoice(control, value);
    else if (control.type === 'integer') fitted[control.key] = fitInteger(control, value);
    else fitted[control.key] = typeof value === 'boolean' ? value : control.defaultValue;
  }
  return fitted;
}

/** One model in the model list, with the price of the run it would make. */
export type PricedModel<T> = {
  id: string;
  /** The run's price on this model; null while it is not known, or the model refused it. */
  cost: number | null;
  item: T;
};

/**
 * The model list split by what a balance covers: the models whose run fits it (the one in
 * use first, then the cheapest), those that need more credits (cheapest first), and those
 * with no price, in the list's own order. A caller without a balance, or still waiting for
 * prices, shows its list as it is.
 */
export function groupModelsByBalance<T>(
  models: readonly PricedModel<T>[],
  balance: number,
  selectedId: string | null,
): { fits: PricedModel<T>[]; needsMore: PricedModel<T>[]; unpriced: PricedModel<T>[] } {
  const byCost = (left: PricedModel<T>, right: PricedModel<T>) => (left.cost ?? 0) - (right.cost ?? 0);
  const priced = models.filter((model) => model.cost !== null);
  const fits = priced.filter((model) => (model.cost as number) <= balance)
    .sort((left, right) => Number(right.id === selectedId) - Number(left.id === selectedId) || byCost(left, right));
  const needsMore = priced.filter((model) => (model.cost as number) > balance).sort(byCost);
  return { fits, needsMore, unpriced: models.filter((model) => model.cost === null) };
}

/** A model a remix could open on: the original run moved to it, and its price. */
export type RemixCandidate = {
  modelId: string;
  /** The run's price on this model at its fitted settings; null while unknown or refused. */
  cost: number | null;
  /** The run's length on this model, as fitted: the original's when the model offers it. */
  durationSeconds: number;
  /** Whether the model takes every input the original run sends, its shots and its sound. */
  takesInputs: boolean;
};

export type RemixFit =
  /** Open the original: the balance covers it, or no other model fits it either. */
  | { kind: 'original' }
  /** Open this model at its fitted settings. */
  | { kind: 'fitted'; modelId: string; sameLength: boolean }
  /**
   * Not even this model, the cheapest, fits at its length: price its shorter lengths
   * (`longestLengthWithin`); when none fits, `otherwise` is the cheapest model that fits at
   * a length of its own (null when none does, and the original opens).
   */
  | {
    kind: 'shorten';
    modelId: string;
    durationSeconds: number;
    otherwise: { modelId: string; sameLength: boolean } | null;
  };

/**
 * Which model a remix opens on (owner, 2026-10-28): the original while the balance
 * covers it; otherwise the preferred model, the catalog's default video (Seedance 2 Mini),
 * whenever it takes the same inputs and its run fits the balance ("Seedance 2 Mini first");
 * otherwise the cheapest model that takes the same inputs, at the same length when that
 * fits. A model that cannot make the original's length is weighed only when none that can
 * is left; when even the cheapest is short of the balance, its shorter lengths are priced
 * next. A creator without a known balance gets the original.
 */
export function fitRemixToBalance({
  original,
  candidates,
  balance,
  preferredModelId,
}: {
  original: { modelId: string; cost: number | null; durationSeconds: number };
  candidates: readonly RemixCandidate[];
  balance: number | null;
  /** The model weighed before the cheapest: the catalog's default video; null for none. */
  preferredModelId: string | null;
}): RemixFit {
  if (balance === null || original.cost === null || original.cost <= balance) return { kind: 'original' };
  const eligible = candidates.filter((candidate): candidate is RemixCandidate & { cost: number } => (
    candidate.takesInputs && candidate.cost !== null && candidate.modelId !== original.modelId
  ));
  const preferred = eligible.find((candidate) => candidate.modelId === preferredModelId);
  if (preferred && preferred.cost <= balance) {
    return { kind: 'fitted', modelId: preferred.modelId, sameLength: preferred.durationSeconds === original.durationSeconds };
  }
  const atLength = eligible.filter((candidate) => candidate.durationSeconds === original.durationSeconds);
  const pool = atLength.length > 0 ? atLength : eligible;
  // The first of the cheapest, so the list's order settles a tie.
  const cheapest = pool.reduce<(typeof pool)[number] | null>(
    (best, candidate) => (!best || candidate.cost < best.cost ? candidate : best),
    null,
  );
  if (!cheapest) return { kind: 'original' };
  if (cheapest.cost <= balance) {
    return { kind: 'fitted', modelId: cheapest.modelId, sameLength: cheapest.durationSeconds === original.durationSeconds };
  }
  // Every model at the length is past the balance: one that fits at another length, the cheapest.
  const otherwise = eligible.reduce<(typeof eligible)[number] | null>(
    (best, candidate) => (candidate.cost <= balance && (!best || candidate.cost < best.cost) ? candidate : best),
    null,
  );
  return {
    kind: 'shorten',
    modelId: cheapest.modelId,
    durationSeconds: cheapest.durationSeconds,
    otherwise: otherwise
      ? { modelId: otherwise.modelId, sameLength: otherwise.durationSeconds === original.durationSeconds }
      : null,
  };
}

/** The longest length, below `belowSeconds`, whose price the balance covers; null when none does. */
export function longestLengthWithin(
  prices: ReadonlyArray<{ durationSeconds: number; cost: number | null }>,
  balance: number,
  belowSeconds: number,
): number | null {
  const fitting = prices.filter((price) => (
    price.durationSeconds < belowSeconds && price.cost !== null && price.cost <= balance
  ));
  return fitting.length > 0 ? Math.max(...fitting.map((price) => price.durationSeconds)) : null;
}

/**
 * An option's price as the settings show it: "16", or "23 · +1" when it costs more than
 * the balance; `over` is how much more. Without a balance, the price alone.
 */
export function optionPriceLabel(cost: number, balance: number | null): { text: string; over: number | null } {
  const over = balance !== null && cost > balance ? cost - balance : null;
  return { text: over === null ? String(cost) : `${cost} · +${over}`, over };
}

/**
 * The lowest of the known prices, or null. A balance under it is short of every model's
 * run, the cheapest included: then the video creator offers an image first and a top-up
 * second (owner, 2026-10-28). Unknown prices say nothing.
 */
export function cheapestCost(costs: ReadonlyArray<number | null>): number | null {
  const known = costs.filter((cost): cost is number => cost !== null);
  return known.length > 0 ? Math.min(...known) : null;
}

/** Whether a setting's options all cost the same, every price known: then it says so once ("Same price for each"). */
export function samePriceForEach(costs: ReadonlyArray<number | null>): boolean {
  return costs.length > 1 && costs.every((cost) => cost !== null && cost === costs[0]);
}

/**
 * What a model row says about the run's references (or, for a run with none, its
 * frames): "Keeps your 2 references", "Keeps 1 of your 3 references", "Drops your
 * references"; null when the run has none. A dropped reference stays in the draft for a
 * model that takes it.
 */
export function referenceKeepWords(
  held: number,
  kept: number,
  noun: 'reference' | 'frame' = 'reference',
): { words: string; keepsAll: boolean } | null {
  if (held <= 0) return null;
  if (kept >= held) {
    return { words: held === 1 ? `Keeps your ${noun}` : `Keeps your ${held} ${noun}s`, keepsAll: true };
  }
  if (kept > 0) return { words: `Keeps ${kept} of your ${held} ${noun}s`, keepsAll: false };
  return { words: held === 1 ? `Drops your ${noun}` : `Drops your ${noun}s`, keepsAll: false };
}
