import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_MANIFEST_PATH = path.resolve(
  process.cwd(),
  'config/generation-model-catalog/releases/2026-07-24-seedance-2-hd.json',
);

const ALLOWED_ADAPTERS = new Set([
  'image-v1',
  'video-v1',
  'motion-v1',
  'kie-task-v1',
]);
const ALLOWED_PRICING_STRATEGIES = new Set([
  'image-v1',
  'video-v1',
  'motion-v1',
  'flat',
  'lookup',
  'per-second',
  'conditional',
  'reference-adjustment',
]);
const ALLOWED_VALIDATION_STRATEGIES = new Set([
  'image-v1',
  'video-v1',
  'motion-v1',
  'descriptor-rules-v1',
]);
const ALLOWED_VALIDATION_RULES = new Set([
  'max-slot-count',
  'min-slot-count',
  'weighted-slot-count',
  'combined-duration',
  'mutually-exclusive-slots',
  'forbidden-combination',
  'control-options',
  'control-range',
]);
const ALLOWED_CONSTRAINT_TYPES = new Set([
  'total-count',
  'weighted-count',
  'combined-duration',
]);
const ALLOWED_CONDITION_SOURCES = new Set(['setting', 'inputCount']);
const ALLOWED_CONDITION_OPERATORS = new Set([
  'equals',
  'notEquals',
  'in',
  'notIn',
  'greaterThan',
  'greaterThanOrEqual',
]);
const ALLOWED_CONTROL_TYPES = new Set(['choice', 'boolean', 'integer']);
const ALLOWED_INPUT_KINDS = new Set([
  'image',
  'video',
  'audio',
  'character',
  'preparedVoice',
]);
const ALLOWED_INPUT_ROLES = new Set([
  'reference',
  'startFrame',
  'endFrame',
]);
const SENSITIVE_KEY_PATTERN = /^(?:api[-_]?key|authorization|password|secret|token)$/i;

const USAGE = `
Magicbooklet generation-model catalog operations (service role only)

Usage:
  tsx scripts/generation-model-catalog.ts validate [--manifest <path>] [--json]
  tsx scripts/generation-model-catalog.ts diff [--manifest <path>] [--json]
  tsx scripts/generation-model-catalog.ts stage [--manifest <path>] [--json]
  tsx scripts/generation-model-catalog.ts stage [--manifest <path>] --apply --expected-active <revision> --confirm-revision <new-revision>
  tsx scripts/generation-model-catalog.ts publish [--manifest <path>] [--json]
  tsx scripts/generation-model-catalog.ts publish [--manifest <path>] --apply --expected-active <revision> --confirm-revision <new-revision>
  tsx scripts/generation-model-catalog.ts rollback --target-revision <revision> [--json]
  tsx scripts/generation-model-catalog.ts rollback --target-revision <revision> --expected-active <revision> --apply --confirm-revision <target-revision>

Environment for commands that read or mutate Supabase:
  SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)
  SUPABASE_SERVICE_ROLE_KEY

Safety:
  - validate is local and does not need credentials.
  - diff, stage, publish, and rollback without --apply are read-only.
  - stage, publish, and rollback only mutate with --apply plus exact revision guards.
  - output never includes provider mappings, adapter configuration, service keys, or prices.
`.trim();

type JsonObject = Record<string, unknown>;
type CatalogKind = 'image' | 'video' | 'motion';

export type CatalogManifestEntry = {
  modelId: string;
  kind: CatalogKind;
  publicDescriptor: JsonObject;
  webEnabled: boolean;
  mobileEnabled: boolean;
  adapterKey: string;
  adapterConfig: JsonObject;
  providerModelMap: Record<string, string>;
  pricingStrategy: string;
  pricingConfig: JsonObject;
  validationStrategy: string;
  validationConfig: JsonObject;
  verificationConfig: JsonObject;
};

export type CatalogReleaseManifest = {
  manifestVersion: 1;
  mode: 'clone-active';
  release: {
    schemaVersion: 2;
    revision: string;
    basedOnRevision: string;
    changeNote: string;
    createdBy: string;
  };
  upgrade: {
    legacyDescriptorsToV2: true;
  };
  expectedModelIds: string[];
  defaults: Record<'web' | 'mobile', Record<CatalogKind, string>>;
  entries: CatalogManifestEntry[];
  acceptanceQuotes: Array<{
    modelId: string;
    settings: Record<string, string | number | boolean>;
    inputs: Array<{
      slot: string;
      durationSeconds?: number;
    }>;
    expectedCredits: number;
  }>;
};

export type MaterializedCatalogRelease = {
  schemaVersion: 2;
  revision: string;
  defaults: CatalogReleaseManifest['defaults'];
  changeNote: string;
  createdBy: string;
  entries: CatalogManifestEntry[];
};

export type ActiveCatalogSnapshot = {
  releaseId: string;
  schemaVersion: number;
  revision: string;
  defaults: CatalogReleaseManifest['defaults'];
  entries: CatalogManifestEntry[];
};

type AcceptanceQuote = CatalogReleaseManifest['acceptanceQuotes'][number];

type ParsedArguments = {
  command: string | null;
  flags: Map<string, string | true>;
};

type Output = {
  log: (message: string) => void;
};

type CatalogDiff = {
  fromRevision: string;
  toRevision: string;
  added: string[];
  removed: string[];
  changed: Array<{
    modelId: string;
    publicDescriptor: boolean;
    availability: boolean;
    adapter: boolean;
    pricing: boolean;
    validation: boolean;
  }>;
};

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, context: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  return value;
}

function requireArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  return value;
}

function requireString(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value.trim();
}

function requireBoolean(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${context} must be a boolean.`);
  return value;
}

function requireFiniteNumber(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${context} must be a finite number.`);
  }
  return value;
}

function isCatalogPrimitive(value: unknown): value is string | number | boolean {
  return (
    typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  );
}

function requireNonNegativeNumber(value: unknown, context: string): number {
  const result = requireFiniteNumber(value, context);
  if (result < 0) throw new Error(`${context} cannot be negative.`);
  return result;
}

function requireKind(value: unknown, context: string): CatalogKind {
  if (value !== 'image' && value !== 'video' && value !== 'motion') {
    throw new Error(`${context} must be image, video, or motion.`);
  }
  return value;
}

function requireStringRecord(value: unknown, context: string): Record<string, string> {
  const record = requireRecord(value, context);
  const entries = Object.entries(record);
  if (entries.length === 0) throw new Error(`${context} cannot be empty.`);
  return Object.fromEntries(entries.map(([key, item]) => [
    requireString(key, `${context} key`),
    requireString(item, `${context}.${key}`),
  ]));
}

function requireStringArray(value: unknown, context: string): string[] {
  const result = requireArray(value, context).map((item, index) => (
    requireString(item, `${context}[${index}]`)
  ));
  if (result.length === 0) throw new Error(`${context} cannot be empty.`);
  if (new Set(result).size !== result.length) {
    throw new Error(`${context} contains duplicates.`);
  }
  return result;
}

function assertNoSensitiveKeys(value: unknown, context = 'manifest'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSensitiveKeys(item, `${context}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      throw new Error(`${context} contains forbidden credential field ${key}.`);
    }
    assertNoSensitiveKeys(item, `${context}.${key}`);
  }
}

function assertNonNegativePricing(value: unknown, context: string): void {
  if (typeof value === 'number') {
    requireNonNegativeNumber(value, context);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNonNegativePricing(item, `${context}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    assertNonNegativePricing(item, `${context}.${key}`);
  }
}

function assertConditions(value: unknown, context: string): void {
  if (value === undefined) return;
  for (const [index, conditionValue] of requireArray(value, context).entries()) {
    const condition = requireRecord(conditionValue, `${context}[${index}]`);
    const source = requireString(condition.source, `${context}[${index}].source`);
    const operator = requireString(condition.operator, `${context}[${index}].operator`);
    if (!ALLOWED_CONDITION_SOURCES.has(source)) {
      throw new Error(`${context}[${index}] uses unsupported condition source ${source}.`);
    }
    if (!ALLOWED_CONDITION_OPERATORS.has(operator)) {
      throw new Error(`${context}[${index}] uses unsupported condition operator ${operator}.`);
    }
    requireString(condition.key, `${context}[${index}].key`);
    if (!('value' in condition)) {
      throw new Error(`${context}[${index}].value is required.`);
    }
    const expected = condition.value;
    if (
      !isCatalogPrimitive(expected)
      && !(
        Array.isArray(expected)
        && expected.length > 0
        && expected.every(isCatalogPrimitive)
      )
    ) {
      throw new Error(`${context}[${index}].value must be a primitive or non-empty primitive array.`);
    }
    if (
      (operator === 'greaterThan' || operator === 'greaterThanOrEqual')
      && typeof expected !== 'number'
    ) {
      throw new Error(`${context}[${index}].value must be numeric for ${operator}.`);
    }
  }
}

function assertControl(value: unknown, context: string): void {
  const control = requireRecord(value, context);
  const key = requireString(control.key, `${context}.key`);
  const type = requireString(control.type, `${context}.type`);
  requireString(control.label, `${context}.label`);
  if (!ALLOWED_CONTROL_TYPES.has(type)) {
    throw new Error(`${context} uses unsupported control type ${type}.`);
  }
  if (control.minClientSchemaVersion !== undefined) {
    const minimumSchema = requireFiniteNumber(
      control.minClientSchemaVersion,
      `${context}.minClientSchemaVersion`,
    );
    if (!Number.isInteger(minimumSchema) || minimumSchema < 1 || minimumSchema > 2) {
      throw new Error(`${context}.minClientSchemaVersion must be 1 or 2.`);
    }
  }
  assertConditions(control.conditions, `${context}.conditions`);

  if (type === 'choice') {
    if (control.presentation !== 'chips' && control.presentation !== 'select') {
      throw new Error(`${context}.presentation must be chips or select.`);
    }
    if (
      control.normalizedValueType !== undefined
      && control.normalizedValueType !== 'string'
      && control.normalizedValueType !== 'number'
    ) {
      throw new Error(`${context}.normalizedValueType must be string or number.`);
    }
    const defaultValue = requireString(control.defaultValue, `${context}.defaultValue`);
    const options = requireArray(control.options, `${context}.options`);
    if (options.length === 0) throw new Error(`${context}.options cannot be empty.`);
    const optionValues = options.map((optionValue, index) => {
      const option = requireRecord(optionValue, `${context}.options[${index}]`);
      requireString(option.label, `${context}.options[${index}].label`);
      return requireString(option.value, `${context}.options[${index}].value`);
    });
    if (new Set(optionValues).size !== optionValues.length) {
      throw new Error(`${context} has duplicate option values.`);
    }
    if (!optionValues.includes(defaultValue)) {
      throw new Error(`${context} default ${defaultValue} is not an option.`);
    }
    return;
  }
  if (type === 'boolean') {
    if (control.presentation !== 'toggle') {
      throw new Error(`${context}.presentation must be toggle.`);
    }
    requireBoolean(control.defaultValue, `${context}.defaultValue`);
    return;
  }

  if (control.presentation !== 'stepper') {
    throw new Error(`${context}.presentation must be stepper.`);
  }
  const minimum = requireFiniteNumber(control.min, `${context}.min`);
  const maximum = requireFiniteNumber(control.max, `${context}.max`);
  const step = requireFiniteNumber(control.step, `${context}.step`);
  const defaultValue = requireFiniteNumber(control.defaultValue, `${context}.defaultValue`);
  if (
    !Number.isInteger(minimum)
    || !Number.isInteger(maximum)
    || !Number.isInteger(step)
    || !Number.isInteger(defaultValue)
    || maximum < minimum
    || step <= 0
    || defaultValue < minimum
    || defaultValue > maximum
    || (defaultValue - minimum) % step !== 0
  ) {
    throw new Error(`${context} has an invalid integer range for ${key}.`);
  }
}

function assertInputModes(value: unknown, context: string): Set<string> {
  const modes = requireArray(value, context);
  if (modes.length === 0) throw new Error(`${context} cannot be empty.`);
  const keys: string[] = [];
  const allSlotKeys = new Set<string>();
  let defaultCount = 0;
  for (const [modeIndex, modeValue] of modes.entries()) {
    const mode = requireRecord(modeValue, `${context}[${modeIndex}]`);
    const modeSlotKeys = new Set<string>();
    keys.push(requireString(mode.key, `${context}[${modeIndex}].key`));
    requireString(mode.label, `${context}[${modeIndex}].label`);
    if (requireBoolean(mode.default, `${context}[${modeIndex}].default`)) defaultCount += 1;
    assertConditions(mode.conditions, `${context}[${modeIndex}].conditions`);

    for (const [slotIndex, slotValue] of requireArray(
      mode.slots,
      `${context}[${modeIndex}].slots`,
    ).entries()) {
      const slot = requireRecord(
        slotValue,
        `${context}[${modeIndex}].slots[${slotIndex}]`,
      );
      const slotKey = requireString(
        slot.key,
        `${context}[${modeIndex}].slots[${slotIndex}].key`,
      );
      if (modeSlotKeys.has(slotKey)) {
        throw new Error(`${context}[${modeIndex}] has duplicate slot key ${slotKey}.`);
      }
      modeSlotKeys.add(slotKey);
      allSlotKeys.add(slotKey);
      requireString(slot.label, `${context}[${modeIndex}].slots[${slotIndex}].label`);
      const kind = requireString(slot.kind, `${context}[${modeIndex}].slots[${slotIndex}].kind`);
      const role = requireString(slot.role, `${context}[${modeIndex}].slots[${slotIndex}].role`);
      if (!ALLOWED_INPUT_KINDS.has(kind)) {
        throw new Error(`${context} uses unsupported input kind ${kind}.`);
      }
      if (!ALLOWED_INPUT_ROLES.has(role)) {
        throw new Error(`${context} uses unsupported input role ${role}.`);
      }
      const minimum = requireNonNegativeNumber(
        slot.min,
        `${context}[${modeIndex}].slots[${slotIndex}].min`,
      );
      const maximum = requireNonNegativeNumber(
        slot.max,
        `${context}[${modeIndex}].slots[${slotIndex}].max`,
      );
      if (!Number.isInteger(minimum) || !Number.isInteger(maximum) || maximum < minimum) {
        throw new Error(`${context} has an invalid slot count range.`);
      }
      if (slot.supportsNaming !== undefined) {
        requireBoolean(
          slot.supportsNaming,
          `${context}[${modeIndex}].slots[${slotIndex}].supportsNaming`,
        );
      }
      if (
        slot.durationMetadata !== undefined
        && slot.durationMetadata !== 'optional'
        && slot.durationMetadata !== 'required'
      ) {
        throw new Error(
          `${context}[${modeIndex}].slots[${slotIndex}].durationMetadata must be optional or required.`,
        );
      }
      if (slot.maxDurationSeconds !== undefined) {
        const maximumDuration = requireNonNegativeNumber(
          slot.maxDurationSeconds,
          `${context}[${modeIndex}].slots[${slotIndex}].maxDurationSeconds`,
        );
        if (maximumDuration <= 0) {
          throw new Error(
            `${context}[${modeIndex}].slots[${slotIndex}].maxDurationSeconds must be positive.`,
          );
        }
      }
      assertConditions(
        slot.conditions,
        `${context}[${modeIndex}].slots[${slotIndex}].conditions`,
      );
    }
  }
  if (new Set(keys).size !== keys.length) throw new Error(`${context} has duplicate mode keys.`);
  if (defaultCount !== 1) throw new Error(`${context} must have exactly one default mode.`);
  return allSlotKeys;
}

function assertInputConstraints(
  value: unknown,
  context: string,
  availableSlots: Set<string>,
  durationRequiredSlots: Set<string>,
): void {
  for (const [index, rawConstraint] of requireArray(value, context).entries()) {
    const constraint = requireRecord(rawConstraint, `${context}[${index}]`);
    const type = requireString(constraint.type, `${context}[${index}].type`);
    if (!ALLOWED_CONSTRAINT_TYPES.has(type)) {
      throw new Error(`${context}[${index}] uses unsupported constraint ${type}.`);
    }
    const slotKeys = requireArray(
      constraint.slotKeys,
      `${context}[${index}].slotKeys`,
    ).map((slot, slotIndex) => requireString(
      slot,
      `${context}[${index}].slotKeys[${slotIndex}]`,
    ));
    if (slotKeys.length === 0) throw new Error(`${context}[${index}] needs slot keys.`);
    if (new Set(slotKeys).size !== slotKeys.length) {
      throw new Error(`${context}[${index}].slotKeys contains duplicates.`);
    }
    for (const slotKey of slotKeys) {
      if (!availableSlots.has(slotKey)) {
        throw new Error(`${context}[${index}] references unknown slot ${slotKey}.`);
      }
      if (type === 'combined-duration' && !durationRequiredSlots.has(slotKey)) {
        throw new Error(
          `${context}[${index}] requires ${slotKey}.durationMetadata to be required.`,
        );
      }
    }
    requireNonNegativeNumber(constraint.max, `${context}[${index}].max`);
    if (type === 'weighted-count') {
      const weights = requireRecord(constraint.weights, `${context}[${index}].weights`);
      if (Object.keys(weights).length === 0) {
        throw new Error(`${context}[${index}].weights cannot be empty.`);
      }
      for (const [slotKey, weight] of Object.entries(weights)) {
        if (!slotKeys.includes(slotKey)) {
          throw new Error(`${context}[${index}].weights references unknown slot ${slotKey}.`);
        }
        requireNonNegativeNumber(weight, `${context}[${index}].weights.${slotKey}`);
      }
      for (const slotKey of slotKeys) {
        requireNonNegativeNumber(weights[slotKey], `${context}[${index}].weights.${slotKey}`);
      }
    }
    assertConditions(constraint.conditions, `${context}[${index}].conditions`);
    requireString(constraint.message, `${context}[${index}].message`);
  }
}

function assertDescriptor(
  descriptorValue: unknown,
  entry: Pick<CatalogManifestEntry, 'modelId' | 'kind' | 'webEnabled' | 'mobileEnabled'>,
  schemaVersion: number,
): JsonObject {
  const descriptor = requireRecord(descriptorValue, `${entry.modelId} publicDescriptor`);
  if (descriptor.id !== entry.modelId || descriptor.kind !== entry.kind) {
    throw new Error(`${entry.modelId} descriptor identity does not match its entry.`);
  }
  requireString(descriptor.displayName, `${entry.modelId} displayName`);
  if (typeof descriptor.description !== 'string') {
    throw new Error(`${entry.modelId} description must be a string.`);
  }
  if (descriptor.badge !== null && typeof descriptor.badge !== 'string') {
    throw new Error(`${entry.modelId} badge must be a string or null.`);
  }
  requireBoolean(descriptor.recommended, `${entry.modelId} recommended`);
  requireNonNegativeNumber(descriptor.sortOrder, `${entry.modelId} sortOrder`);
  const minimumSchema = requireNonNegativeNumber(
    descriptor.minClientSchemaVersion,
    `${entry.modelId} minClientSchemaVersion`,
  );
  if (!Number.isInteger(minimumSchema) || minimumSchema < 1 || minimumSchema > schemaVersion) {
    throw new Error(`${entry.modelId} has an incompatible minimum client schema.`);
  }

  const controlKeys: string[] = [];
  for (const [index, control] of requireArray(
    descriptor.controls,
    `${entry.modelId} controls`,
  ).entries()) {
    assertControl(control, `${entry.modelId} controls[${index}]`);
    controlKeys.push(requireString(
      requireRecord(control, `${entry.modelId} control`).key,
      `${entry.modelId} control key`,
    ));
  }
  if (new Set(controlKeys).size !== controlKeys.length) {
    throw new Error(`${entry.modelId} has duplicate control keys.`);
  }
  const capabilities = requireRecord(
    descriptor.capabilities,
    `${entry.modelId} capabilities`,
  );
  for (const capability of [
    'multiShot',
    'sound',
    'fixedLens',
    'googleSearch',
    'outputFormat',
  ]) {
    requireBoolean(
      capabilities[capability],
      `${entry.modelId} capabilities.${capability}`,
    );
  }
  const legacyInputs = requireRecord(descriptor.inputs, `${entry.modelId} legacy inputs`);
  for (const key of ['imageReferences', 'videoReferences', 'audioReferences']) {
    const limit = legacyInputs[key];
    if (limit === null) continue;
    const limitRecord = requireRecord(limit, `${entry.modelId} legacy inputs.${key}`);
    const maximum = requireNonNegativeNumber(
      limitRecord.max,
      `${entry.modelId} legacy inputs.${key}.max`,
    );
    if (!Number.isInteger(maximum)) {
      throw new Error(`${entry.modelId} legacy inputs.${key}.max must be an integer.`);
    }
    if (key === 'imageReferences') {
      requireBoolean(
        limitRecord.supportsNaming,
        `${entry.modelId} legacy inputs.imageReferences.supportsNaming`,
      );
    }
  }
  for (const key of ['preparedAudioReferences', 'characterReferences']) {
    const limit = legacyInputs[key];
    if (limit === undefined || limit === null) continue;
    const limitRecord = requireRecord(limit, `${entry.modelId} legacy inputs.${key}`);
    const maximum = requireNonNegativeNumber(
      limitRecord.max,
      `${entry.modelId} legacy inputs.${key}.max`,
    );
    if (!Number.isInteger(maximum)) {
      throw new Error(`${entry.modelId} legacy inputs.${key}.max must be an integer.`);
    }
  }
  requireBoolean(legacyInputs.startFrame, `${entry.modelId} legacy inputs.startFrame`);
  requireBoolean(legacyInputs.endFrame, `${entry.modelId} legacy inputs.endFrame`);
  if (legacyInputs.combineFramesWithReferences !== undefined) {
    requireBoolean(
      legacyInputs.combineFramesWithReferences,
      `${entry.modelId} legacy inputs.combineFramesWithReferences`,
    );
  }

  if (schemaVersion === 2) {
    if (descriptor.schemaVersion !== 2) {
      throw new Error(`${entry.modelId} descriptor is not schema v2.`);
    }
    const availability = requireRecord(
      descriptor.availability,
      `${entry.modelId} availability`,
    );
    const webAvailability = requireBoolean(
      availability.web,
      `${entry.modelId} availability.web`,
    );
    const mobileAvailability = requireBoolean(
      availability.mobile,
      `${entry.modelId} availability.mobile`,
    );
    if (webAvailability !== entry.webEnabled || mobileAvailability !== entry.mobileEnabled) {
      throw new Error(`${entry.modelId} public availability does not match private flags.`);
    }
    const slotKeys = assertInputModes(descriptor.inputModes, `${entry.modelId} inputModes`);
    const durationRequiredSlots = new Set(
      requireArray(descriptor.inputModes, `${entry.modelId} inputModes`)
        .flatMap((modeValue) => {
          const mode = requireRecord(modeValue, `${entry.modelId} input mode`);
          return requireArray(mode.slots, `${entry.modelId} input mode slots`);
        })
        .filter((slotValue) => (
          requireRecord(slotValue, `${entry.modelId} input slot`).durationMetadata === 'required'
        ))
        .map((slotValue) => (
          requireString(
            requireRecord(slotValue, `${entry.modelId} input slot`).key,
            `${entry.modelId} input slot key`,
          )
        )),
    );
    assertInputConstraints(
      descriptor.inputConstraints ?? [],
      `${entry.modelId} inputConstraints`,
      slotKeys,
      durationRequiredSlots,
    );
  }
  return descriptor;
}

function parseManifestEntry(value: unknown, context: string): CatalogManifestEntry {
  const entry = requireRecord(value, context);
  const parsed: CatalogManifestEntry = {
    modelId: requireString(entry.modelId, `${context}.modelId`),
    kind: requireKind(entry.kind, `${context}.kind`),
    publicDescriptor: requireRecord(entry.publicDescriptor, `${context}.publicDescriptor`),
    webEnabled: requireBoolean(entry.webEnabled, `${context}.webEnabled`),
    mobileEnabled: requireBoolean(entry.mobileEnabled, `${context}.mobileEnabled`),
    adapterKey: requireString(entry.adapterKey, `${context}.adapterKey`),
    adapterConfig: requireRecord(entry.adapterConfig ?? {}, `${context}.adapterConfig`),
    providerModelMap: requireStringRecord(
      entry.providerModelMap,
      `${context}.providerModelMap`,
    ),
    pricingStrategy: requireString(entry.pricingStrategy, `${context}.pricingStrategy`),
    pricingConfig: requireRecord(entry.pricingConfig, `${context}.pricingConfig`),
    validationStrategy: requireString(
      entry.validationStrategy,
      `${context}.validationStrategy`,
    ),
    validationConfig: requireRecord(
      entry.validationConfig ?? {},
      `${context}.validationConfig`,
    ),
    verificationConfig: requireRecord(
      entry.verificationConfig ?? {},
      `${context}.verificationConfig`,
    ),
  };
  return parsed;
}

function parseDefaults(value: unknown): CatalogReleaseManifest['defaults'] {
  const defaults = requireRecord(value, 'defaults');
  const result = {} as CatalogReleaseManifest['defaults'];
  for (const platform of ['web', 'mobile'] as const) {
    const platformDefaults = requireRecord(defaults[platform], `defaults.${platform}`);
    result[platform] = {
      image: requireString(platformDefaults.image, `defaults.${platform}.image`),
      video: requireString(platformDefaults.video, `defaults.${platform}.video`),
      motion: requireString(platformDefaults.motion, `defaults.${platform}.motion`),
    };
  }
  return result;
}

export function validateCatalogManifest(value: unknown): CatalogReleaseManifest {
  assertNoSensitiveKeys(value);
  const manifest = requireRecord(value, 'manifest');
  if (manifest.manifestVersion !== 1) throw new Error('manifestVersion must be 1.');
  if (manifest.mode !== 'clone-active') throw new Error('mode must be clone-active.');

  const release = requireRecord(manifest.release, 'release');
  if (release.schemaVersion !== 2) throw new Error('release.schemaVersion must be 2.');
  const revision = requireString(release.revision, 'release.revision');
  const basedOnRevision = requireString(
    release.basedOnRevision,
    'release.basedOnRevision',
  );
  if (revision === basedOnRevision) {
    throw new Error('A catalog release revision must differ from its base revision.');
  }
  if (revision.length < 8 || revision.length > 128) {
    throw new Error('release.revision must contain 8 to 128 characters.');
  }

  const upgrade = requireRecord(manifest.upgrade, 'upgrade');
  if (upgrade.legacyDescriptorsToV2 !== true) {
    throw new Error('upgrade.legacyDescriptorsToV2 must be true.');
  }

  const expectedModelIds = requireArray(
    manifest.expectedModelIds,
    'expectedModelIds',
  ).map((modelId, index) => requireString(modelId, `expectedModelIds[${index}]`));
  if (expectedModelIds.length === 0) throw new Error('expectedModelIds cannot be empty.');
  if (new Set(expectedModelIds).size !== expectedModelIds.length) {
    throw new Error('expectedModelIds contains duplicates.');
  }
  if (JSON.stringify([...expectedModelIds].sort()) !== JSON.stringify(expectedModelIds)) {
    throw new Error('expectedModelIds must be sorted.');
  }

  const entries = requireArray(manifest.entries, 'entries')
    .map((entry, index) => parseManifestEntry(entry, `entries[${index}]`));
  if (entries.length === 0) throw new Error('entries cannot be empty.');
  const entryIds = entries.map((entry) => entry.modelId);
  if (new Set(entryIds).size !== entryIds.length) throw new Error('entries contains duplicates.');
  for (const entry of entries) {
    if (!expectedModelIds.includes(entry.modelId)) {
      throw new Error(`${entry.modelId} is missing from expectedModelIds.`);
    }
    assertEntryPolicy(entry, 2);
  }

  const acceptanceQuotes = requireArray(
    manifest.acceptanceQuotes ?? [],
    'acceptanceQuotes',
  ).map((quoteValue, index) => {
    const quote = requireRecord(quoteValue, `acceptanceQuotes[${index}]`);
    const modelId = requireString(quote.modelId, `acceptanceQuotes[${index}].modelId`);
    if (!entryIds.includes(modelId)) {
      throw new Error(`Acceptance quote model ${modelId} is not changed by this manifest.`);
    }
    const settings = requireRecord(
      quote.settings,
      `acceptanceQuotes[${index}].settings`,
    ) as Record<string, string | number | boolean>;
    const inputs = requireArray(
      quote.inputs ?? [],
      `acceptanceQuotes[${index}].inputs`,
    ).map((inputValue, inputIndex) => {
      const input = requireRecord(
        inputValue,
        `acceptanceQuotes[${index}].inputs[${inputIndex}]`,
      );
      return {
        slot: requireString(
          input.slot,
          `acceptanceQuotes[${index}].inputs[${inputIndex}].slot`,
        ),
        ...(input.durationSeconds === undefined
          ? {}
          : {
              durationSeconds: requireNonNegativeNumber(
                input.durationSeconds,
                `acceptanceQuotes[${index}].inputs[${inputIndex}].durationSeconds`,
              ),
            }),
      };
    });
    return {
      modelId,
      settings,
      inputs,
      expectedCredits: requireNonNegativeNumber(
        quote.expectedCredits,
        `acceptanceQuotes[${index}].expectedCredits`,
      ),
    };
  });

  const result: CatalogReleaseManifest = {
    manifestVersion: 1,
    mode: 'clone-active',
    release: {
      schemaVersion: 2,
      revision,
      basedOnRevision,
      changeNote: requireString(release.changeNote, 'release.changeNote'),
      createdBy: requireString(release.createdBy, 'release.createdBy'),
    },
    upgrade: { legacyDescriptorsToV2: true },
    expectedModelIds,
    defaults: parseDefaults(manifest.defaults),
    entries,
    acceptanceQuotes,
  };
  for (const quote of result.acceptanceQuotes) {
    const entry = result.entries.find((candidate) => candidate.modelId === quote.modelId);
    if (!entry) throw new Error(`Acceptance quote model ${quote.modelId} is missing.`);
    const calculated = calculateManifestAcceptanceQuote(entry, quote);
    if (calculated !== quote.expectedCredits) {
      throw new Error(
        `Acceptance quote for ${quote.modelId} expected ${quote.expectedCredits} but pricing calculates ${calculated}.`,
      );
    }
  }
  return result;
}

function assertEntryPolicy(entry: CatalogManifestEntry, schemaVersion: number): void {
  if (!ALLOWED_ADAPTERS.has(entry.adapterKey)) {
    throw new Error(`${entry.modelId} uses unsupported adapter ${entry.adapterKey}.`);
  }
  if (!ALLOWED_PRICING_STRATEGIES.has(entry.pricingStrategy)) {
    throw new Error(`${entry.modelId} uses unsupported pricing strategy ${entry.pricingStrategy}.`);
  }
  if (!ALLOWED_VALIDATION_STRATEGIES.has(entry.validationStrategy)) {
    throw new Error(
      `${entry.modelId} uses unsupported validation strategy ${entry.validationStrategy}.`,
    );
  }
  if ('endpoint' in entry.adapterConfig) {
    throw new Error(`${entry.modelId} adapterConfig cannot select an endpoint.`);
  }
  assertNonNegativePricing(entry.pricingConfig, `${entry.modelId} pricingConfig`);
  assertDescriptor(entry.publicDescriptor, entry, schemaVersion);

  if (entry.validationStrategy === 'descriptor-rules-v1') {
    if (entry.validationConfig.normalizedDefaults !== undefined) {
      const defaults = requireRecord(
        entry.validationConfig.normalizedDefaults,
        `${entry.modelId} validationConfig.normalizedDefaults`,
      );
      for (const [key, value] of Object.entries(defaults)) {
        requireString(key, `${entry.modelId} validationConfig.normalizedDefaults key`);
        if (!isCatalogPrimitive(value)) {
          throw new Error(
            `${entry.modelId} validationConfig.normalizedDefaults.${key} must be a primitive.`,
          );
        }
      }
    }
    if (entry.validationConfig.passthroughSettingKeys !== undefined) {
      requireStringArray(
        entry.validationConfig.passthroughSettingKeys,
        `${entry.modelId} validationConfig.passthroughSettingKeys`,
      );
    }
    const rules = requireArray(
      entry.validationConfig.rules,
      `${entry.modelId} validationConfig.rules`,
    );
    for (const [index, ruleValue] of rules.entries()) {
      const rule = requireRecord(
        ruleValue,
        `${entry.modelId} validationConfig.rules[${index}]`,
      );
      const type = requireString(
        rule.type,
        `${entry.modelId} validationConfig.rules[${index}].type`,
      );
      if (!ALLOWED_VALIDATION_RULES.has(type)) {
        throw new Error(`${entry.modelId} uses unsupported validation rule ${type}.`);
      }
      if (rule.conditions !== undefined) {
        assertConditions(
          rule.conditions,
          `${entry.modelId} validationConfig.rules[${index}].conditions`,
        );
      }
      if (rule.field !== undefined) {
        requireString(rule.field, `${entry.modelId} validationConfig.rules[${index}].field`);
      }
      if (rule.message !== undefined) {
        requireString(rule.message, `${entry.modelId} validationConfig.rules[${index}].message`);
      }
      if (type === 'control-options') {
        requireString(rule.key, `${entry.modelId} validationConfig.rules[${index}].key`);
        requireStringArray(
          rule.options,
          `${entry.modelId} validationConfig.rules[${index}].options`,
        );
      } else if (type === 'control-range') {
        requireString(rule.key, `${entry.modelId} validationConfig.rules[${index}].key`);
        const minimum = requireFiniteNumber(
          rule.min,
          `${entry.modelId} validationConfig.rules[${index}].min`,
        );
        const maximum = requireFiniteNumber(
          rule.max,
          `${entry.modelId} validationConfig.rules[${index}].max`,
        );
        if (maximum < minimum) throw new Error(`${entry.modelId} has an invalid control range.`);
      } else if (type === 'max-slot-count' || type === 'min-slot-count') {
        requireString(rule.slotKey, `${entry.modelId} validationConfig.rules[${index}].slotKey`);
        requireNonNegativeNumber(
          rule[type === 'max-slot-count' ? 'max' : 'min'],
          `${entry.modelId} validationConfig.rules[${index}].${type === 'max-slot-count' ? 'max' : 'min'}`,
        );
      } else if (type === 'combined-duration') {
        requireStringArray(
          rule.slotKeys,
          `${entry.modelId} validationConfig.rules[${index}].slotKeys`,
        );
        requireNonNegativeNumber(
          rule.max,
          `${entry.modelId} validationConfig.rules[${index}].max`,
        );
      } else if (type === 'weighted-slot-count') {
        const weights = requireRecord(
          rule.weights,
          `${entry.modelId} validationConfig.rules[${index}].weights`,
        );
        if (Object.keys(weights).length === 0) {
          throw new Error(`${entry.modelId} weighted slot rule needs weights.`);
        }
        for (const [slotKey, weight] of Object.entries(weights)) {
          requireNonNegativeNumber(
            weight,
            `${entry.modelId} validationConfig.rules[${index}].weights.${slotKey}`,
          );
        }
        requireNonNegativeNumber(
          rule.max,
          `${entry.modelId} validationConfig.rules[${index}].max`,
        );
      } else if (type === 'mutually-exclusive-slots') {
        const slotKeys = requireStringArray(
          rule.slotKeys,
          `${entry.modelId} validationConfig.rules[${index}].slotKeys`,
        );
        if (slotKeys.length < 2) {
          throw new Error(`${entry.modelId} mutually exclusive rule needs two slots.`);
        }
      } else if (type === 'forbidden-combination') {
        assertConditions(
          rule.conditions,
          `${entry.modelId} validationConfig.rules[${index}].conditions`,
        );
        if (requireArray(
          rule.conditions,
          `${entry.modelId} validationConfig.rules[${index}].conditions`,
        ).length === 0) {
          throw new Error(`${entry.modelId} forbidden combination needs conditions.`);
        }
      }
    }
  }

  if (entry.pricingStrategy === 'reference-adjustment') {
    if (entry.pricingConfig.unit !== 'second') {
      throw new Error(`${entry.modelId} reference-adjustment pricing must use seconds.`);
    }
    requireString(entry.pricingConfig.settingKey, `${entry.modelId} pricing settingKey`);
    requireString(
      entry.pricingConfig.durationSettingKey,
      `${entry.modelId} pricing durationSettingKey`,
    );
    requireStringArray(
      entry.pricingConfig.referenceDurationSlots,
      `${entry.modelId} pricing referenceDurationSlots`,
    );
    if (
      entry.pricingConfig.rounding !== undefined
      && !['none', 'round', 'floor', 'ceil'].includes(String(entry.pricingConfig.rounding))
    ) {
      throw new Error(`${entry.modelId} uses unsupported pricing rounding.`);
    }
    const rateGroups = requireRecord(entry.pricingConfig.rates, `${entry.modelId} pricing rates`);
    const noReference = requireRecord(
      rateGroups.noReference,
      `${entry.modelId} no-reference rates`,
    );
    const withReference = requireRecord(
      rateGroups.withReference,
      `${entry.modelId} with-reference rates`,
    );
    const noReferenceKeys = Object.keys(noReference).sort();
    const withReferenceKeys = Object.keys(withReference).sort();
    if (
      noReferenceKeys.length === 0
      || JSON.stringify(noReferenceKeys) !== JSON.stringify(withReferenceKeys)
    ) {
      throw new Error(`${entry.modelId} reference pricing rate keys must match.`);
    }
    for (const key of noReferenceKeys) {
      requireNonNegativeNumber(
        noReference[key],
        `${entry.modelId} no-reference rates.${key}`,
      );
      requireNonNegativeNumber(
        withReference[key],
        `${entry.modelId} with-reference rates.${key}`,
      );
    }
  }
}

export function calculateManifestAcceptanceQuote(
  entry: CatalogManifestEntry,
  quote: AcceptanceQuote,
): number {
  if (entry.pricingStrategy !== 'reference-adjustment') {
    throw new Error(
      `Acceptance quote evaluation is unsupported for ${entry.pricingStrategy}.`,
    );
  }
  const settingKey = requireString(
    entry.pricingConfig.settingKey,
    `${entry.modelId} pricing settingKey`,
  );
  const durationSettingKey = requireString(
    entry.pricingConfig.durationSettingKey,
    `${entry.modelId} pricing durationSettingKey`,
  );
  const selectedValue = requireString(
    quote.settings[settingKey],
    `${entry.modelId} quote ${settingKey}`,
  );
  const outputDuration = requireNonNegativeNumber(
    quote.settings[durationSettingKey],
    `${entry.modelId} quote ${durationSettingKey}`,
  );
  const referenceSlots = new Set(requireArray(
    entry.pricingConfig.referenceDurationSlots,
    `${entry.modelId} referenceDurationSlots`,
  ).map((slot, index) => requireString(
    slot,
    `${entry.modelId} referenceDurationSlots[${index}]`,
  )));
  const referenceInputs = quote.inputs.filter((input) => referenceSlots.has(input.slot));
  const referenceDuration = referenceInputs
    .reduce((total, input) => total + requireNonNegativeNumber(
      input.durationSeconds,
      `${entry.modelId} quote input duration`,
    ), 0);
  const rateGroups = requireRecord(entry.pricingConfig.rates, `${entry.modelId} rates`);
  const groupName = referenceInputs.length > 0 ? 'withReference' : 'noReference';
  const rates = requireRecord(rateGroups[groupName], `${entry.modelId} ${groupName} rates`);
  const rate = requireNonNegativeNumber(
    rates[selectedValue],
    `${entry.modelId} ${groupName}.${selectedValue}`,
  );
  const raw = rate * (outputDuration + referenceDuration);
  return entry.pricingConfig.rounding === 'ceil'
    ? Math.ceil(raw)
    : entry.pricingConfig.rounding === 'floor'
      ? Math.floor(raw)
      : Math.round(raw);
}

function legacySlots(inputsValue: unknown): JsonObject[] {
  const inputs = isRecord(inputsValue) ? inputsValue : {};
  const slots: JsonObject[] = [];
  const addReferences = (
    legacyKey: string,
    key: string,
    kind: string,
    label: string,
  ) => {
    const value = inputs[legacyKey];
    if (!isRecord(value) || typeof value.max !== 'number' || value.max <= 0) return;
    slots.push({
      key,
      kind,
      role: 'reference',
      label,
      min: 0,
      max: value.max,
      ...(value.supportsNaming === true ? { supportsNaming: true } : {}),
    });
  };
  addReferences('imageReferences', 'imageReferences', 'image', 'Reference images');
  addReferences('videoReferences', 'videoReferences', 'video', 'Reference videos');
  addReferences('audioReferences', 'audioReferences', 'audio', 'Reference audio');
  addReferences(
    'preparedAudioReferences',
    'preparedAudioReferences',
    'preparedVoice',
    'Prepared voices',
  );
  addReferences(
    'characterReferences',
    'characterReferences',
    'character',
    'Prepared characters',
  );
  if (inputs.startFrame === true) {
    slots.push({
      key: 'startFrame',
      kind: 'image',
      role: 'startFrame',
      label: 'Start frame',
      min: 0,
      max: 1,
    });
  }
  if (inputs.endFrame === true) {
    slots.push({
      key: 'endFrame',
      kind: 'image',
      role: 'endFrame',
      label: 'End frame',
      min: 0,
      max: 1,
    });
  }
  return slots;
}

function upgradeDescriptorToV2(
  descriptorValue: JsonObject,
  webEnabled: boolean,
  mobileEnabled: boolean,
): JsonObject {
  if (descriptorValue.schemaVersion === 2) {
    return {
      ...descriptorValue,
      availability: {
        web: webEnabled,
        mobile: mobileEnabled,
      },
    };
  }
  return {
    ...descriptorValue,
    schemaVersion: 2,
    availability: {
      web: webEnabled,
      mobile: mobileEnabled,
    },
    inputModes: [
      {
        key: 'default',
        label: 'Default',
        default: true,
        slots: legacySlots(descriptorValue.inputs),
      },
    ],
    inputConstraints: [],
  };
}

export function materializeCatalogManifest(
  manifest: CatalogReleaseManifest,
  active: ActiveCatalogSnapshot,
): MaterializedCatalogRelease {
  if (active.revision !== manifest.release.basedOnRevision) {
    throw new Error(
      `Active revision ${active.revision} does not match manifest base ${manifest.release.basedOnRevision}.`,
    );
  }
  const activeIds = active.entries.map((entry) => entry.modelId).sort();
  if (JSON.stringify(activeIds) !== JSON.stringify(manifest.expectedModelIds)) {
    throw new Error('The active model inventory does not match expectedModelIds.');
  }

  const byId = new Map(active.entries.map((entry) => [
    entry.modelId,
    {
      ...entry,
      publicDescriptor: upgradeDescriptorToV2(
        entry.publicDescriptor,
        entry.webEnabled,
        entry.mobileEnabled,
      ),
    },
  ]));
  for (const replacement of manifest.entries) {
    const previous = byId.get(replacement.modelId);
    if (!previous) throw new Error(`Cannot replace missing base model ${replacement.modelId}.`);
    if (previous.kind !== replacement.kind) {
      throw new Error(`Cannot change immutable kind for ${replacement.modelId}.`);
    }
    byId.set(replacement.modelId, replacement);
  }

  const release: MaterializedCatalogRelease = {
    schemaVersion: 2,
    revision: manifest.release.revision,
    defaults: manifest.defaults,
    changeNote: manifest.release.changeNote,
    createdBy: manifest.release.createdBy,
    entries: [...byId.values()].sort((left, right) => left.modelId.localeCompare(right.modelId)),
  };
  validateMaterializedCatalog(release);
  return release;
}

export function validateMaterializedCatalog(release: MaterializedCatalogRelease): void {
  if (release.schemaVersion !== 2) throw new Error('Only schema v2 releases may be staged.');
  if (release.entries.length === 0) throw new Error('A catalog release must contain models.');
  const ids = new Set<string>();
  for (const entry of release.entries) {
    if (ids.has(entry.modelId)) throw new Error(`Duplicate model ${entry.modelId}.`);
    ids.add(entry.modelId);
    assertEntryPolicy(entry, release.schemaVersion);
  }
  for (const platform of ['web', 'mobile'] as const) {
    for (const kind of ['image', 'video', 'motion'] as const) {
      const defaultId = release.defaults[platform][kind];
      const entry = release.entries.find((candidate) => candidate.modelId === defaultId);
      const enabled = platform === 'web' ? entry?.webEnabled : entry?.mobileEnabled;
      if (!entry || entry.kind !== kind || !enabled) {
        throw new Error(`Invalid ${platform} ${kind} default ${defaultId}.`);
      }
    }
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

export function buildCatalogDiff(
  active: ActiveCatalogSnapshot,
  target: MaterializedCatalogRelease,
): CatalogDiff {
  const activeById = new Map(active.entries.map((entry) => [entry.modelId, entry]));
  const targetById = new Map(target.entries.map((entry) => [entry.modelId, entry]));
  const added = [...targetById.keys()].filter((id) => !activeById.has(id)).sort();
  const removed = [...activeById.keys()].filter((id) => !targetById.has(id)).sort();
  const changed = [...targetById.keys()].flatMap((modelId) => {
    const before = activeById.get(modelId);
    const after = targetById.get(modelId);
    if (!before || !after) return [];
    const change = {
      modelId,
      publicDescriptor: !same(before.publicDescriptor, after.publicDescriptor),
      availability:
        before.webEnabled !== after.webEnabled
        || before.mobileEnabled !== after.mobileEnabled,
      adapter:
        before.adapterKey !== after.adapterKey
        || !same(before.adapterConfig, after.adapterConfig)
        || !same(before.providerModelMap, after.providerModelMap),
      pricing:
        before.pricingStrategy !== after.pricingStrategy
        || !same(before.pricingConfig, after.pricingConfig),
      validation:
        before.validationStrategy !== after.validationStrategy
        || !same(before.validationConfig, after.validationConfig),
    };
    return Object.values(change).some((value) => value === true) ? [change] : [];
  });
  return {
    fromRevision: active.revision,
    toRevision: target.revision,
    added,
    removed,
    changed,
  };
}

function parseArguments(args: string[]): ParsedArguments {
  const [command = null, ...tokens] = args;
  const flags = new Map<string, string | true>();
  const booleanFlags = new Set(['--apply', '--json', '--help']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    if (flags.has(token)) throw new Error(`Duplicate flag: ${token}`);
    if (booleanFlags.has(token)) {
      flags.set(token, true);
      continue;
    }
    const value = tokens[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
    flags.set(token, value);
    index += 1;
  }
  return { command, flags };
}

function optionalFlag(flags: Map<string, string | true>, name: string): string | null {
  const value = flags.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requireFlag(flags: Map<string, string | true>, name: string): string {
  const value = optionalFlag(flags, name);
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

export function requireMutationApproval(
  flags: Map<string, string | true>,
  expectedTargetRevision: string,
): void {
  if (flags.get('--apply') !== true) {
    throw new Error('Mutation refused without --apply.');
  }
  const confirmation = requireFlag(flags, '--confirm-revision');
  if (confirmation !== expectedTargetRevision) {
    throw new Error('--confirm-revision must exactly match the target revision.');
  }
}

async function readManifest(manifestPath: string): Promise<CatalogReleaseManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read catalog manifest ${manifestPath}: ${error instanceof Error ? error.message : error}`,
    );
  }
  return validateCatalogManifest(value);
}

function createAdminClient(environment: NodeJS.ProcessEnv): SupabaseClient {
  const url = environment.SUPABASE_URL || environment.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  }
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });
}

function databaseEntryToManifestEntry(value: unknown): CatalogManifestEntry {
  const row = requireRecord(value, 'database catalog entry');
  return parseManifestEntry({
    modelId: row.model_id,
    kind: row.kind,
    publicDescriptor: row.public_descriptor,
    webEnabled: row.web_enabled,
    mobileEnabled: row.mobile_enabled,
    adapterKey: row.adapter_key,
    adapterConfig: row.adapter_config ?? {},
    providerModelMap: row.provider_model_map,
    pricingStrategy: row.pricing_strategy,
    pricingConfig: row.pricing_config,
    validationStrategy: row.validation_strategy,
    validationConfig: row.validation_config,
    verificationConfig: row.verification_config,
  }, 'database catalog entry');
}

function missingAdapterConfigColumn(error: unknown): boolean {
  if (!isRecord(error) || error.code !== '42703') return false;
  return [error.message, error.details, error.hint]
    .some((value) => typeof value === 'string' && value.includes('adapter_config'));
}

async function queryActiveCatalogEntries(
  client: SupabaseClient,
  releaseId: string,
  includeAdapterConfig: boolean,
) {
  const adapterConfigColumn = includeAdapterConfig ? 'adapter_config,' : '';
  return client
    .from('generation_model_catalog_entries')
    .select(`
      model_id,
      public_descriptor,
      web_enabled,
      mobile_enabled,
      adapter_key,
      ${adapterConfigColumn}
      provider_model_map,
      pricing_strategy,
      pricing_config,
      validation_strategy,
      validation_config,
      verification_config,
      generation_models!inner(kind)
    `)
    .eq('release_id', releaseId)
    .order('model_id', { ascending: true });
}

export async function loadActiveCatalog(
  client: SupabaseClient,
): Promise<ActiveCatalogSnapshot> {
  const { data: releaseData, error: releaseError } = await client
    .from('generation_model_catalog_releases')
    .select('id, schema_version, revision, defaults')
    .eq('status', 'active')
    .maybeSingle();
  if (releaseError) throw releaseError;
  if (!releaseData) throw new Error('No active catalog release is published.');

  let { data: entryData, error: entryError } = await queryActiveCatalogEntries(
    client,
    releaseData.id,
    true,
  );
  if (missingAdapterConfigColumn(entryError)) {
    ({ data: entryData, error: entryError } = await queryActiveCatalogEntries(
      client,
      releaseData.id,
      false,
    ));
  }
  if (entryError) throw entryError;
  if (!entryData?.length) throw new Error('The active catalog release has no entries.');

  return {
    releaseId: requireString(releaseData.id, 'active release id'),
    schemaVersion: requireFiniteNumber(
      releaseData.schema_version,
      'active schema version',
    ),
    revision: requireString(releaseData.revision, 'active revision'),
    defaults: parseDefaults(releaseData.defaults),
    entries: entryData.map((row) => {
      const record = requireRecord(row, 'database catalog entry');
      const joinedModel = Array.isArray(record.generation_models)
        ? record.generation_models[0]
        : record.generation_models;
      return databaseEntryToManifestEntry({
        ...record,
        kind: requireRecord(joinedModel, 'database generation model').kind,
      });
    }),
  };
}

function safeSummary(
  manifest: CatalogReleaseManifest,
  extra: JsonObject = {},
): JsonObject {
  return {
    revision: manifest.release.revision,
    basedOnRevision: manifest.release.basedOnRevision,
    schemaVersion: manifest.release.schemaVersion,
    expectedModels: manifest.expectedModelIds.length,
    changedModels: manifest.entries.map((entry) => entry.modelId),
    acceptanceQuoteCount: manifest.acceptanceQuotes.length,
    ...extra,
  };
}

export function buildStagePreview(
  manifest: CatalogReleaseManifest,
  active: ActiveCatalogSnapshot,
  diff: CatalogDiff,
): JsonObject {
  return {
    operation: 'stage',
    status: 'dry-run',
    ...safeSummary(manifest, {
      activeRevision: active.revision,
      added: diff.added,
      removed: diff.removed,
      changed: diff.changed.map((change) => change.modelId),
    }),
  };
}

export function buildPublishPreview(
  manifest: CatalogReleaseManifest,
  activeRevision: string,
  releaseReady: boolean,
): JsonObject {
  return {
    operation: 'publish',
    status: 'dry-run',
    revision: manifest.release.revision,
    activeRevision,
    releaseReady,
  };
}

function print(output: Output, json: boolean, value: JsonObject): void {
  output.log(json ? JSON.stringify(value, null, 2) : Object.entries(value)
    .map(([key, item]) => {
      const rendered = Array.isArray(item)
        ? item.map((entry) => (
            entry && typeof entry === 'object' ? JSON.stringify(entry) : String(entry)
          )).join(', ')
        : item && typeof item === 'object'
          ? JSON.stringify(item)
          : String(item);
      return `${key}: ${rendered}`;
    })
    .join('\n'));
}

async function findDraftReleaseId(
  client: SupabaseClient,
  revision: string,
): Promise<string> {
  const { data, error } = await client
    .from('generation_model_catalog_releases')
    .select('id')
    .eq('revision', revision)
    .in('status', ['draft', 'shadow'])
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new Error(`No publishable draft exists for ${revision}.`);
  return requireString(data.id, 'draft release id');
}

async function loadActiveRevision(client: SupabaseClient): Promise<string> {
  const { data, error } = await client
    .from('generation_model_catalog_releases')
    .select('revision')
    .eq('status', 'active')
    .maybeSingle();
  if (error) throw error;
  if (!data?.revision) throw new Error('No active catalog release is published.');
  return requireString(data.revision, 'active revision');
}

export async function runGenerationModelCatalogCli(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  output: Output = { log: console.log },
): Promise<void> {
  const { command, flags } = parseArguments(args);
  if (!command || command === 'help' || command === '--help' || flags.has('--help')) {
    output.log(USAGE);
    return;
  }
  const json = flags.get('--json') === true;

  if (command === 'rollback') {
    const targetRevision = requireFlag(flags, '--target-revision');
    const client = createAdminClient(environment);
    const { data: target, error: targetError } = await client
      .from('generation_model_catalog_releases')
      .select('status')
      .eq('revision', targetRevision)
      .in('status', ['retired', 'active'])
      .maybeSingle();
    if (targetError) throw targetError;
    if (!target) throw new Error(`No rollback release exists for ${targetRevision}.`);
    if (flags.get('--apply') !== true) {
      print(output, json, {
        operation: 'rollback',
        status: 'dry-run',
        targetRevision,
        targetStatus: target.status,
        activeRevision: await loadActiveRevision(client),
      });
      return;
    }
    const expectedActive = requireFlag(flags, '--expected-active');
    requireMutationApproval(flags, targetRevision);
    const { data, error } = await client.rpc('rollback_generation_model_catalog', {
      p_target_revision: targetRevision,
      p_expected_active_revision: expectedActive,
    });
    if (error) throw error;
    print(output, json, {
      operation: 'rollback',
      targetRevision,
      expectedActive,
      status: isRecord(data) && typeof data.status === 'string' ? data.status : 'completed',
    });
    return;
  }

  if (!['validate', 'diff', 'stage', 'publish'].includes(command)) {
    throw new Error(`Unknown command: ${command}\n\n${USAGE}`);
  }

  const manifestPath = path.resolve(
    process.cwd(),
    optionalFlag(flags, '--manifest') ?? DEFAULT_MANIFEST_PATH,
  );
  const manifest = await readManifest(manifestPath);
  if (command === 'validate') {
    print(output, json, {
      operation: 'validate',
      status: 'valid',
      ...safeSummary(manifest),
    });
    return;
  }

  const client = createAdminClient(environment);
  if (command === 'publish') {
    const releaseId = await findDraftReleaseId(client, manifest.release.revision);
    if (flags.get('--apply') !== true) {
      print(output, json, buildPublishPreview(
        manifest,
        await loadActiveRevision(client),
        Boolean(releaseId),
      ));
      return;
    }
    requireMutationApproval(flags, manifest.release.revision);
    const expectedActive = requireFlag(flags, '--expected-active');
    if (expectedActive !== manifest.release.basedOnRevision) {
      throw new Error('--expected-active must exactly match the manifest base revision.');
    }
    const { data, error } = await client.rpc('publish_generation_model_catalog', {
      p_release_id: releaseId,
      p_expected_active_revision: expectedActive,
    });
    if (error) throw error;
    print(output, json, {
      operation: 'publish',
      revision: manifest.release.revision,
      expectedActive,
      status: isRecord(data) && typeof data.status === 'string' ? data.status : 'published',
    });
    return;
  }

  const active = await loadActiveCatalog(client);
  const materialized = materializeCatalogManifest(manifest, active);
  const diff = buildCatalogDiff(active, materialized);
  if (command === 'diff') {
    print(output, json, {
      operation: 'diff',
      ...diff,
    });
    return;
  }

  if (flags.get('--apply') !== true) {
    print(output, json, buildStagePreview(manifest, active, diff));
    return;
  }

  requireMutationApproval(flags, manifest.release.revision);
  const expectedActive = requireFlag(flags, '--expected-active');
  if (expectedActive !== manifest.release.basedOnRevision) {
    throw new Error('--expected-active must exactly match the manifest base revision.');
  }
  const { data, error } = await client.rpc('stage_generation_model_catalog', {
    p_manifest: materialized,
    p_expected_active_revision: expectedActive,
  });
  if (error) throw error;
  print(output, json, {
    operation: 'stage',
    revision: manifest.release.revision,
    expectedActive,
    entryCount: materialized.entries.length,
    status: isRecord(data) && typeof data.status === 'string' ? data.status : 'staged',
  });
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  runGenerationModelCatalogCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
