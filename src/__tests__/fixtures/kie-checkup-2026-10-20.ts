import type { GenerationModelDescriptor } from '@/lib/generation-model-catalog';
import type { GenerationModelOperationalConfig } from '@/lib/generation-model-runtime';

/**
 * The code build as it stood before the 2026-10-20 Kie check-up
 * (archive/model-checkup-2026-10-20/README.md; the changes are pinned in
 * kie-checkup-2026-10-20.test.ts). A release test written before it holds its entries to
 * the code build of its day, so it reads today's build through these and compares like
 * with like. Each change the check-up made is named here once:
 *
 * - Nano Banana 2: 10 references, not 14; no Google Search control, capability or
 *   grounding description. Both Nano Banana tiers stopped binding `google_search`.
 * - Seedance 2 Mini and Fast, and Seedance 2.5 at 1080p: Kie's list prices once the
 *   offers ended. Seedance 2.5 also caps reference audio at 30 s in total.
 * - PixVerse V6: one price table, with no reference-to-video branch.
 * - MiniMax H3: 5 reference images, not 9.
 * - Gemini Omni Video and 1.1 Flash: the reference clip stops at 30 s.
 * - Wan 2.7: a 10 s reference voice, and no references run of the voice alone.
 * - Veo 3.1: reference runs take 16:9 or 9:16 only.
 */

type Rule = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function referenceSlot(descriptor: GenerationModelDescriptor, slotKey: string) {
  const found = (descriptor.inputModes ?? [])
    .find((mode) => mode.key === 'references')
    ?.slots.find((slot) => slot.key === slotKey);
  if (!found) throw new Error(`${descriptor.id} has no references/${slotKey} slot`);
  return found;
}

/** A published descriptor of today's build, as the build before the check-up made it. */
export function descriptorBeforeKieCheckup<T extends GenerationModelDescriptor>(current: T): T {
  const descriptor = clone(current);
  if (descriptor.id === 'nano-banana-2') {
    descriptor.description = 'Versatile image gen with Google Search grounding';
    const afterOutputFormat = descriptor.controls.findIndex((control) => control.key === 'outputFormat') + 1;
    descriptor.controls.splice(afterOutputFormat, 0, {
      key: 'googleSearch',
      label: 'Google Search',
      type: 'boolean',
      presentation: 'toggle',
      defaultValue: false,
    });
    descriptor.capabilities.googleSearch = true;
    descriptor.inputs.imageReferences = { max: 14, supportsNaming: true };
    referenceSlot(descriptor, 'imageReferences').max = 14;
  }
  if (descriptor.id === 'minimax-h3') {
    descriptor.inputs.imageReferences = { max: 9, supportsNaming: true };
    referenceSlot(descriptor, 'imageReferences').max = 9;
  }
  if (descriptor.id === 'gemini-omni-video' || descriptor.id === 'gemini-omni-1.1-flash') {
    const clip = referenceSlot(descriptor, 'videoReferences');
    clip.durationMetadata = 'optional';
    delete clip.maxDurationSeconds;
  }
  if (descriptor.id === 'wan-2.7') {
    delete referenceSlot(descriptor, 'audioReferences').maxDurationSeconds;
  }
  return descriptor;
}

const PIXVERSE_REFERENCE_RATES = {
  '360p': { false: 4.5, true: 6.3 },
  '540p': { false: 6.3, true: 8.1 },
  '720p': { false: 8.1, true: 10.8 },
  '1080p': { false: 16.2, true: 20.7 },
};

function isRule(rule: Rule, type: string, match: (rule: Rule) => boolean): boolean {
  return rule.type === type && match(rule);
}

function slotKeysAre(rule: Rule, slotKey: string): boolean {
  return Array.isArray(rule.slotKeys) && rule.slotKeys.length === 1 && rule.slotKeys[0] === slotKey;
}

/** An operational entry of today's build, as the build before the check-up made it. */
export function operationBeforeKieCheckup(current: GenerationModelOperationalConfig): GenerationModelOperationalConfig {
  const operation = clone(current);
  const rules = (operation.validationConfig.rules ?? []) as Rule[];
  const setRules = (next: Rule[]) => {
    operation.validationConfig = { ...operation.validationConfig, rules: next };
  };
  const rates = operation.pricingConfig.rates as Record<'noReference' | 'withReference', Record<string, number>>;

  switch (operation.modelId) {
    case 'nano-banana-2':
    case 'nano-banana-pro': {
      const settings = (operation.adapterConfig as { settings: Record<string, unknown> }).settings;
      settings.googleSearch = { field: 'google_search' };
      break;
    }
    case 'seedance-2-mini':
      rates.noReference = { '480p': 9.5, '720p': 20.5 };
      rates.withReference = { '480p': 6, '720p': 12.5 };
      break;
    case 'seedance-2-fast':
      rates.noReference = { '480p': 15.5, '720p': 33 };
      rates.withReference = { '480p': 9, '720p': 20 };
      break;
    case 'seedance-2-5':
      rates.noReference['1080p'] = 159;
      rates.withReference['1080p'] = 96;
      setRules(rules.filter((rule) => !isRule(rule, 'combined-duration', (candidate) => slotKeysAre(candidate, 'audioReferences'))));
      break;
    case 'pixverse-v6': {
      const standard = operation.pricingConfig;
      const reference = clone(standard);
      ((reference.rate as { config: { table: unknown } }).config).table = PIXVERSE_REFERENCE_RATES;
      operation.pricingStrategy = 'conditional';
      operation.pricingConfig = {
        branches: [{
          conditions: [
            { source: 'setting', key: 'referenceMode', operator: 'equals', value: 'elements' },
            { source: 'inputCount', key: 'images', operator: 'greaterThan', value: 0 },
          ],
          pricing: { strategy: 'per-second', config: reference },
        }],
        fallback: { strategy: 'per-second', config: standard },
      };
      break;
    }
    case 'minimax-h3':
      setRules(rules.map((rule) => (
        isRule(rule, 'max-slot-count', (candidate) => candidate.slotKey === 'images' && candidate.max === 5)
          ? { ...rule, max: 9 }
          : rule
      )));
      break;
    case 'gemini-omni-video':
    case 'gemini-omni-1.1-flash':
      setRules(rules.filter((rule) => !isRule(rule, 'combined-duration', (candidate) => slotKeysAre(candidate, 'videoReferences'))));
      break;
    case 'wan-2.7':
      setRules(rules.filter((rule) => (
        !isRule(rule, 'combined-duration', (candidate) => slotKeysAre(candidate, 'audioReferences'))
        && !isRule(rule, 'forbidden-combination', (candidate) => candidate.field === 'audios')
      )));
      break;
    case 'veo-3.1':
      setRules(rules.filter((rule) => !isRule(rule, 'control-options', (candidate) => candidate.key === 'aspectRatio')));
      break;
    default:
      break;
  }
  return operation;
}
