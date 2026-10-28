import { IMAGE_MODELS, MOTION_MODELS, VIDEO_MODELS } from '@/lib/client-generation-models';
import type {
  CatalogControl,
  CatalogPrimitive,
  GenerationModelCatalog,
  GenerationModelKind,
} from '@/lib/generation-model-catalog';

/**
 * The run a creator page opens on, read by its server from the published web catalog
 * (`loadCreatorOpening`) and drawn from the first paint.
 *
 * The pages drew a stand-in form until their catalog came back from the network, then made
 * their first pick. Once Seedance 2 Mini became the video default (2026-10-28), every new
 * visitor saw Kling 3.0's chip, settings and no price for two to three seconds before Mini's
 * took over; the motion creator swapped Kling 3.0 for Kling 2.6 the same way. The first pick
 * still waits for the revision the network confirms. On the revision the server read, it
 * picks this same run, so nothing on screen changes.
 */
export type CreatorOpening = {
  /** The published revision this was read from. */
  revision: string;
  /** A link's model the catalog offers, or the catalog's default. */
  modelId: string;
  /** The model's published settings, with a link's ratio and length where the model offers them. */
  settings: Readonly<Record<string, CatalogPrimitive>>;
  /**
   * The run's price with nothing attached, or null: a motion run takes a clip and is priced by
   * its length, and a run the catalog will not price without inputs has none.
   */
  costCredits: number | null;
};

/** What a creator's address asks of the run it opens on. */
export type CreatorOpeningLink = {
  model?: string | null;
  aspectRatio?: string | null;
  duration?: string | null;
};

// The page draws a model from its built-in table until its catalog is in: one the table lacks
// would be drawn under another model's name.
const DRAWABLE: Record<GenerationModelKind, Readonly<Record<string, unknown>>> = {
  image: IMAGE_MODELS,
  video: VIDEO_MODELS,
  motion: MOTION_MODELS,
};

/** A link's value as the control takes it, or undefined when the model does not offer it. */
function offeredValue(control: CatalogControl | undefined, raw: string | null | undefined): CatalogPrimitive | undefined {
  if (!control || !raw) return undefined;
  if (control.type === 'choice') return control.options.find((option) => option.value === raw)?.value;
  if (control.type !== 'integer') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= control.min && value <= control.max && (value - control.min) % control.step === 0
    ? value
    : undefined;
}

/**
 * The opening a catalog gives a creator, less its price: the link's model when the catalog
 * offers it, else the default, at its published settings (each control's `defaultValue`, as
 * the first pick sets them) with the link's ratio and length where the model offers them.
 * Null when there is nothing the page could draw as it will settle: a link to a model the
 * catalog does not offer (the page names it, then says it is gone), or a model missing from
 * the page's built-in table.
 */
export function creatorOpeningFromCatalog(
  catalog: GenerationModelCatalog,
  kind: GenerationModelKind,
  link: CreatorOpeningLink = {},
): Omit<CreatorOpening, 'costCredits'> | null {
  const modelId = link.model || catalog.defaults[kind];
  const descriptor = catalog.models.find((model) => model.id === modelId && model.kind === kind);
  if (!modelId || !descriptor || !Object.hasOwn(DRAWABLE[kind], modelId)) return null;
  const settings: Record<string, CatalogPrimitive> = Object.fromEntries(
    descriptor.controls.map((control) => [control.key, control.defaultValue]),
  );
  for (const key of ['aspectRatio', 'duration'] as const) {
    const value = offeredValue(descriptor.controls.find((control) => control.key === key), link[key]);
    if (value !== undefined) settings[key] = value;
  }
  return { revision: catalog.revision, modelId, settings };
}

/**
 * The opening's price, shown under the bar until the page has priced its own run: while the run
 * is still the one the server priced (its model, nothing attached, and every setting the server
 * priced at that value; one the page has yet to set is read as its default, as the server reads
 * it), while the page's own quote has neither answered nor failed, and while the page's catalog
 * is not one the network confirmed at another revision. Generate is never priced by it: a start
 * waits for the page's own quote of the run it sends.
 */
export function openingCost(
  opening: CreatorOpening | null,
  page: {
    run: { modelId: string; settings: Readonly<Record<string, unknown>>; inputs: readonly unknown[] };
    quoteStatus: 'idle' | 'pending' | 'ready' | 'error';
    /** The page's catalog revision once the network has confirmed it, else null. */
    confirmedRevision: string | null;
  },
): number | null {
  if (!opening || opening.costCredits === null) return null;
  if (page.quoteStatus === 'ready' || page.quoteStatus === 'error') return null;
  if (page.confirmedRevision !== null && page.confirmedRevision !== opening.revision) return null;
  const { run } = page;
  // A length is a number on the page and a choice's string in some descriptors ("4").
  const samePriced = Object.entries(opening.settings).every(([key, value]) => (
    run.settings[key] === undefined || String(run.settings[key]) === String(value)
  ));
  return run.modelId === opening.modelId && run.inputs.length === 0 && samePriced ? opening.costCredits : null;
}
