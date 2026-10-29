import type { GenerationModelDescriptor } from '@/lib/generation-model-catalog';
import type { GenerationModelOperationalConfig } from '@/lib/generation-model-runtime';

/**
 * The code build as it stood before release 2026-10-29-kie-catalog-inputs
 * (kie-catalog-inputs-manifest.test.ts; docs/model-api-references/kie-catalog-inputs-2026-10-29.md).
 * A release test written before it holds its entries to the code build of its day, so it
 * reads today's build through these and compares like with like. The release:
 *
 * - Grok Imagine Video: up to 7 reference pictures, not 1.
 * - Grok Imagine Video 1.5: an end frame, and the start frame kept beside its references
 *   (`combineFramesWithReferences`, a start slot in the references mode); its reference cap
 *   counts the reference slot, and an end frame needs the start frame.
 * - Seedance 1.5 Pro: offered on no platform, since Kie retired it.
 */

type Rule = Record<string, unknown>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mode(descriptor: GenerationModelDescriptor, key: string) {
  const found = (descriptor.inputModes ?? []).find((candidate) => candidate.key === key);
  if (!found) throw new Error(`${descriptor.id} has no ${key} mode`);
  return found;
}

/** A published descriptor of today's build, as the build before this release made it. */
export function descriptorBeforeKieCatalogInputs<T extends GenerationModelDescriptor>(current: T): T {
  const descriptor = clone(current);
  if (descriptor.id === 'grok-imagine-video') {
    descriptor.inputs.imageReferences = { max: 1, supportsNaming: true };
    const pictures = mode(descriptor, 'references').slots.find((slot) => slot.key === 'imageReferences');
    if (!pictures) throw new Error('grok-imagine-video has no imageReferences slot');
    pictures.max = 1;
  }
  if (descriptor.id === 'grok-imagine-video-1.5') {
    descriptor.inputs.endFrame = false;
    descriptor.inputs.combineFramesWithReferences = false;
    const frames = mode(descriptor, 'frames');
    frames.slots = frames.slots.filter((slot) => slot.key !== 'endFrame');
    const references = mode(descriptor, 'references');
    references.slots = references.slots.filter((slot) => slot.key !== 'startFrame');
  }
  if (descriptor.id === 'seedance-1.5-pro') {
    descriptor.availability = { web: true, mobile: true };
  }
  return descriptor;
}

function isEndFrameNeedsStart(rule: Rule): boolean {
  return rule.type === 'min-slot-count' && rule.slotKey === 'startFrame';
}

/** A model's operational config from today's build, as the build before this release made it. */
export function operationBeforeKieCatalogInputs<T extends GenerationModelOperationalConfig>(current: T): T {
  const operation = clone(current);
  if (operation.modelId !== 'grok-imagine-video' && operation.modelId !== 'grok-imagine-video-1.5') return operation;
  const rules = operation.validationConfig.rules as Rule[];
  operation.validationConfig = {
    ...operation.validationConfig,
    rules: rules
      .filter((rule) => operation.modelId !== 'grok-imagine-video-1.5' || !isEndFrameNeedsStart(rule))
      .map((rule) => {
        if (rule.type !== 'max-slot-count' || (rule.slotKey !== 'images' && rule.slotKey !== 'imageReferences')) return rule;
        const elements = (rule.conditions as Rule[] | undefined)?.some((condition) => condition.value === 'elements');
        if (!elements) return rule;
        if (operation.modelId === 'grok-imagine-video') return { ...rule, max: 1 };
        const cap: Rule = { ...rule, slotKey: 'images' };
        delete cap.field;
        delete cap.message;
        return cap;
      }),
  };
  return operation;
}
