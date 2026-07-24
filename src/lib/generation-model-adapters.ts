import type {
  CatalogPrimitive,
  GenerationModelKind,
} from '@/lib/generation-model-catalog';

export const GENERIC_GENERATION_ADAPTER_KEYS = ['kie-task-v1'] as const;

export type GenericGenerationAdapterKey =
  typeof GENERIC_GENERATION_ADAPTER_KEYS[number];

export type CatalogGenerationInputKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'character'
  | 'preparedVoice';

export type CatalogGenerationInputAsset = {
  slot: string;
  kind: CatalogGenerationInputKind;
  url?: string | null;
  assetId?: string | null;
  durationSeconds?: number | null;
  label?: string | null;
  handle?: string | null;
  storagePath?: string | null;
  sourceGenerationId?: string | null;
};

export type CatalogGenerationShot = {
  prompt: string;
  duration?: number | null;
  settings?: Record<string, CatalogPrimitive>;
};

export type CatalogGenerationRequestPayload = {
  kind: GenerationModelKind;
  modelId: string;
  catalogRevision: string;
  settings: Record<string, CatalogPrimitive>;
  prompt?: string;
  shots?: CatalogGenerationShot[];
  inputs?: CatalogGenerationInputAsset[];
  sourceGenerationId?: string | null;
};

export type GenericGenerationAdapterOperation = {
  modelId: string;
  kind: GenerationModelKind;
  adapterKey: string;
  providerModelMap: Record<string, string>;
  adapterConfig?: Record<string, unknown>;
};

export type GenerationProviderRequest = {
  endpoint: 'https://api.kie.ai/api/v1/jobs/createTask';
  body: {
    model: string;
    input: Record<string, unknown>;
  };
  providerModelId: string;
  variant: string;
};

type AdapterTransform =
  | 'identity'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'stringify'
  | 'uppercase'
  | 'lowercase'
  | 'jpg-to-jpeg';

type SettingBinding = {
  field: string;
  transform: AdapterTransform;
};

type SlotBinding = {
  field: string;
  cardinality: 'one' | 'many';
  source: 'url' | 'assetId';
  required: boolean;
};

type VariantSelector =
  | { type: 'static'; variant: string }
  | {
      type: 'setting';
      setting: string;
      variants: Record<string, string>;
      fallback: string;
    }
  | {
      type: 'slot-presence';
      slot: string;
      present: string;
      absent: string;
    };

type ParsedAdapterConfig = {
  promptField: string | null;
  settings: Record<string, SettingBinding>;
  slots: Record<string, SlotBinding>;
  constants: Record<string, unknown>;
  shotsField: string | null;
  variantSelector: VariantSelector;
};

const PROVIDER_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const SAFE_TRANSFORMS = new Set<AdapterTransform>([
  'identity',
  'string',
  'number',
  'integer',
  'boolean',
  'stringify',
  'uppercase',
  'lowercase',
  'jpg-to-jpeg',
]);

export class GenerationProviderAdapterError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'GenerationProviderAdapterError';
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireProviderField(value: unknown, context: string): string {
  if (
    typeof value !== 'string'
    || !PROVIDER_FIELD_PATTERN.test(value)
    || value === 'constructor'
    || value === 'prototype'
  ) {
    throw new GenerationProviderAdapterError(`Invalid provider field for ${context}.`);
  }
  return value;
}

function requireNonEmptyString(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new GenerationProviderAdapterError(`Invalid ${context}.`);
  }
  return value.trim();
}

function parseSettingBindings(value: unknown): Record<string, SettingBinding> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new GenerationProviderAdapterError('Invalid adapter setting bindings.');
  }

  return Object.fromEntries(Object.entries(value).map(([setting, rawBinding]) => {
    if (!setting.trim()) {
      throw new GenerationProviderAdapterError('Invalid adapter setting key.');
    }
    if (typeof rawBinding === 'string') {
      return [setting, {
        field: requireProviderField(rawBinding, `setting ${setting}`),
        transform: 'identity' as const,
      }];
    }
    if (!isRecord(rawBinding)) {
      throw new GenerationProviderAdapterError(`Invalid adapter binding for setting ${setting}.`);
    }
    const transform = rawBinding.transform ?? 'identity';
    if (typeof transform !== 'string' || !SAFE_TRANSFORMS.has(transform as AdapterTransform)) {
      throw new GenerationProviderAdapterError(`Unsupported adapter transform for setting ${setting}.`);
    }
    return [setting, {
      field: requireProviderField(rawBinding.field, `setting ${setting}`),
      transform: transform as AdapterTransform,
    }];
  }));
}

function parseSlotBindings(value: unknown): Record<string, SlotBinding> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new GenerationProviderAdapterError('Invalid adapter slot bindings.');
  }

  return Object.fromEntries(Object.entries(value).map(([slot, rawBinding]) => {
    if (!slot.trim() || !isRecord(rawBinding)) {
      throw new GenerationProviderAdapterError(`Invalid adapter binding for slot ${slot || '(empty)'}.`);
    }
    const cardinality = rawBinding.cardinality ?? 'many';
    const source = rawBinding.source ?? 'url';
    if (cardinality !== 'one' && cardinality !== 'many') {
      throw new GenerationProviderAdapterError(`Invalid cardinality for slot ${slot}.`);
    }
    if (source !== 'url' && source !== 'assetId') {
      throw new GenerationProviderAdapterError(`Invalid source for slot ${slot}.`);
    }
    if (rawBinding.required !== undefined && typeof rawBinding.required !== 'boolean') {
      throw new GenerationProviderAdapterError(`Invalid required flag for slot ${slot}.`);
    }
    return [slot, {
      field: requireProviderField(rawBinding.field, `slot ${slot}`),
      cardinality,
      source,
      required: rawBinding.required === true,
    }];
  }));
}

function parseConstants(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new GenerationProviderAdapterError('Invalid adapter constants.');
  }

  return Object.fromEntries(Object.entries(value).map(([field, constant]) => [
    requireProviderField(field, 'constant'),
    constant,
  ]));
}

function parseVariantSelector(value: unknown): VariantSelector {
  if (value === undefined) {
    return { type: 'static', variant: 'default' };
  }
  if (!isRecord(value)) {
    throw new GenerationProviderAdapterError('Invalid provider model variant selector.');
  }

  if (value.type === 'static') {
    return {
      type: 'static',
      variant: requireNonEmptyString(value.variant ?? 'default', 'static provider variant'),
    };
  }
  if (value.type === 'setting') {
    if (!isRecord(value.variants)) {
      throw new GenerationProviderAdapterError('Invalid provider setting variant map.');
    }
    const variants = Object.fromEntries(Object.entries(value.variants).map(([settingValue, variant]) => [
      settingValue,
      requireNonEmptyString(variant, `provider variant for ${settingValue}`),
    ]));
    return {
      type: 'setting',
      setting: requireNonEmptyString(value.setting, 'provider variant setting'),
      variants,
      fallback: requireNonEmptyString(value.fallback ?? 'default', 'provider variant fallback'),
    };
  }
  if (value.type === 'slot-presence') {
    return {
      type: 'slot-presence',
      slot: requireNonEmptyString(value.slot, 'provider variant slot'),
      present: requireNonEmptyString(value.present, 'present provider variant'),
      absent: requireNonEmptyString(value.absent, 'absent provider variant'),
    };
  }

  throw new GenerationProviderAdapterError('Unsupported provider model variant selector.');
}

function parseAdapterConfig(value: unknown): ParsedAdapterConfig {
  if (!isRecord(value)) {
    throw new GenerationProviderAdapterError('The generation adapter is not configured.');
  }
  if (value.endpoint !== undefined) {
    throw new GenerationProviderAdapterError('Provider endpoints are selected by the server adapter.');
  }
  const promptField = value.promptField === null
    ? null
    : requireProviderField(value.promptField ?? 'prompt', 'prompt');
  const shotsField = value.shotsField === undefined || value.shotsField === null
    ? null
    : requireProviderField(value.shotsField, 'shots');

  return {
    promptField,
    shotsField,
    settings: parseSettingBindings(value.settings),
    slots: parseSlotBindings(value.slots),
    constants: parseConstants(value.constants),
    variantSelector: parseVariantSelector(value.variantSelector),
  };
}

function transformSetting(value: CatalogPrimitive, transform: AdapterTransform): unknown {
  if (transform === 'identity') return value;
  if (transform === 'string') return String(value);
  if (transform === 'number') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) {
      throw new GenerationProviderAdapterError('A provider number mapping received an invalid value.', 422);
    }
    return number;
  }
  if (transform === 'integer') {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(number)) {
      throw new GenerationProviderAdapterError('A provider integer mapping received an invalid value.', 422);
    }
    return number;
  }
  if (transform === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new GenerationProviderAdapterError('A provider boolean mapping received an invalid value.', 422);
    }
    return value;
  }
  if (transform === 'stringify') return JSON.stringify(value);
  if (transform === 'uppercase') return String(value).toUpperCase();
  if (transform === 'lowercase') return String(value).toLowerCase();
  return String(value).toLowerCase() === 'jpg' ? 'jpeg' : value;
}

function selectVariant(
  selector: VariantSelector,
  settings: Record<string, CatalogPrimitive>,
  inputs: CatalogGenerationInputAsset[],
): string {
  if (selector.type === 'static') return selector.variant;
  if (selector.type === 'slot-presence') {
    return inputs.some((input) => input.slot === selector.slot)
      ? selector.present
      : selector.absent;
  }
  const setting = settings[selector.setting];
  const value = setting === undefined ? '' : String(setting);
  return selector.variants[value] ?? selector.fallback;
}

function getBoundAssetValue(
  asset: CatalogGenerationInputAsset,
  source: SlotBinding['source'],
  slot: string,
): string {
  const value = source === 'url' ? asset.url : asset.assetId;
  if (typeof value !== 'string' || !value.trim()) {
    throw new GenerationProviderAdapterError(
      `Input slot ${slot} is missing its ${source === 'url' ? 'URL' : 'asset ID'}.`,
      422,
    );
  }
  return value.trim();
}

export function buildGenerationProviderRequest({
  operation,
  prompt,
  settings,
  inputs,
  shots = [],
}: {
  operation: GenericGenerationAdapterOperation;
  prompt: string;
  settings: Record<string, CatalogPrimitive>;
  inputs: CatalogGenerationInputAsset[];
  shots?: CatalogGenerationShot[];
}): GenerationProviderRequest {
  if (operation.adapterKey !== 'kie-task-v1') {
    throw new GenerationProviderAdapterError(
      `Unsupported generation adapter ${operation.adapterKey}.`,
    );
  }

  const config = parseAdapterConfig(operation.adapterConfig);
  const variant = selectVariant(config.variantSelector, settings, inputs);
  const providerModelId = operation.providerModelMap[variant]
    ?? operation.providerModelMap.default;
  if (typeof providerModelId !== 'string' || !providerModelId.trim()) {
    throw new GenerationProviderAdapterError(
      `Provider model variant ${variant} is not configured for ${operation.modelId}.`,
    );
  }

  const input: Record<string, unknown> = {};
  if (config.promptField) {
    input[config.promptField] = prompt;
  }
  for (const [setting, binding] of Object.entries(config.settings)) {
    const value = settings[setting];
    if (value !== undefined) {
      input[binding.field] = transformSetting(value, binding.transform);
    }
  }
  for (const [slot, binding] of Object.entries(config.slots)) {
    const slotAssets = inputs.filter((asset) => asset.slot === slot);
    if (binding.required && slotAssets.length === 0) {
      throw new GenerationProviderAdapterError(`Input slot ${slot} is required.`, 422);
    }
    if (slotAssets.length === 0) continue;
    if (binding.cardinality === 'one' && slotAssets.length > 1) {
      throw new GenerationProviderAdapterError(`Input slot ${slot} accepts only one asset.`, 422);
    }
    const values = slotAssets.map((asset) => getBoundAssetValue(asset, binding.source, slot));
    input[binding.field] = binding.cardinality === 'one' ? values[0] : values;
  }
  if (config.shotsField && shots.length > 0) {
    input[config.shotsField] = shots.map((shot) => ({
      prompt: shot.prompt,
      ...(typeof shot.duration === 'number' ? { duration: shot.duration } : {}),
      ...(shot.settings ? { settings: shot.settings } : {}),
    }));
  }

  Object.assign(input, config.constants);

  return {
    endpoint: 'https://api.kie.ai/api/v1/jobs/createTask',
    body: {
      model: providerModelId.trim(),
      input,
    },
    providerModelId: providerModelId.trim(),
    variant,
  };
}
