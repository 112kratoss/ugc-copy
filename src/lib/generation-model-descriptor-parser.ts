import type {
  CatalogCondition,
  CatalogControl,
  CatalogInputConstraint,
  CatalogInputMode,
  CatalogInputSlot,
  CatalogPlatform,
  CatalogPrimitive,
  GenerationModelDescriptor,
  GenerationModelKind,
} from './generation-model-catalog';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isGenerationModelKind(value: unknown): value is GenerationModelKind {
  return value === 'image' || value === 'video' || value === 'motion';
}

function isCatalogPrimitive(value: unknown): value is CatalogPrimitive {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function parseCondition(value: unknown): CatalogCondition | null {
  if (
    !isRecord(value) ||
    (value.source !== 'setting' && value.source !== 'inputCount') ||
    !isString(value.key) ||
    ![
      'equals',
      'notEquals',
      'in',
      'notIn',
      'greaterThan',
      'greaterThanOrEqual',
    ].includes(String(value.operator))
  ) {
    return null;
  }
  const expected = value.value;
  if (
    !isCatalogPrimitive(expected) &&
    !(Array.isArray(expected) && expected.every(isCatalogPrimitive))
  ) {
    return null;
  }
  return {
    source: value.source,
    key: value.key,
    operator: value.operator as CatalogCondition['operator'],
    value: expected,
  };
}

function parseConditions(value: unknown): CatalogCondition[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const conditions = value.map(parseCondition);
  return conditions.some((condition) => !condition)
    ? undefined
    : (conditions as CatalogCondition[]);
}

function parseCatalogControl(value: unknown): CatalogControl | null {
  if (!isRecord(value) || !isString(value.key) || !isString(value.label))
    return null;
  const compatibility = {
    ...(value.minClientSchemaVersion === undefined
      ? {}
      : Number.isInteger(value.minClientSchemaVersion) &&
          Number(value.minClientSchemaVersion) > 0
        ? { minClientSchemaVersion: Number(value.minClientSchemaVersion) }
        : { invalid: true }),
    ...(value.conditions === undefined
      ? {}
      : parseConditions(value.conditions)
        ? { conditions: parseConditions(value.conditions) }
        : { invalid: true }),
  };
  if ('invalid' in compatibility) return null;
  if (value.type === 'boolean') {
    return value.presentation === 'toggle' &&
      typeof value.defaultValue === 'boolean'
      ? {
          key: value.key,
          label: value.label,
          type: 'boolean',
          presentation: 'toggle',
          defaultValue: value.defaultValue,
          ...compatibility,
        }
      : null;
  }
  if (value.type === 'choice') {
    if (
      !(
        (value.presentation === 'chips' || value.presentation === 'select') &&
        isString(value.defaultValue) &&
        Array.isArray(value.options) &&
        value.options.length > 0 &&
        value.options.every(
          (option) =>
            isRecord(option) &&
            isString(option.value) &&
            isString(option.label),
        )
      )
    )
      return null;
    const options = value.options as Array<{ value: string; label: string }>;
    if (!options.some((option) => option.value === value.defaultValue))
      return null;
    if (
      value.normalizedValueType !== undefined &&
      value.normalizedValueType !== 'string' &&
      value.normalizedValueType !== 'number'
    )
      return null;
    return {
      key: value.key,
      label: value.label,
      type: 'choice',
      presentation: value.presentation,
      defaultValue: value.defaultValue,
      options: options.map((option) => ({
        value: option.value,
        label: option.label,
      })),
      ...(value.normalizedValueType
        ? { normalizedValueType: value.normalizedValueType }
        : {}),
      ...compatibility,
    };
  }
  if (
    !(
      value.type === 'integer' &&
      value.presentation === 'stepper' &&
      Number.isFinite(value.defaultValue) &&
      Number.isFinite(value.min) &&
      Number.isFinite(value.max) &&
      Number.isFinite(value.step) &&
      Number(value.step) > 0 &&
      Number(value.min) <= Number(value.defaultValue) &&
      Number(value.defaultValue) <= Number(value.max)
    )
  )
    return null;
  return {
    key: value.key,
    label: value.label,
    type: 'integer',
    presentation: 'stepper',
    defaultValue: Number(value.defaultValue),
    min: Number(value.min),
    max: Number(value.max),
    step: Number(value.step),
    ...(typeof value.unit === 'string' ? { unit: value.unit } : {}),
    ...compatibility,
  };
}

function parseReferenceLimit(
  value: unknown,
  supportsNaming: true,
): { max: number; supportsNaming: boolean } | null | undefined;
function parseReferenceLimit(
  value: unknown,
  supportsNaming: false,
): { max: number } | null | undefined;
function parseReferenceLimit(value: unknown, supportsNaming: boolean) {
  if (value === null) return null;
  if (!isRecord(value) || !Number.isInteger(value.max) || Number(value.max) < 0)
    return undefined;
  if (supportsNaming && typeof value.supportsNaming !== 'boolean')
    return undefined;
  return supportsNaming
    ? {
        max: Number(value.max),
        supportsNaming: value.supportsNaming as boolean,
      }
    : { max: Number(value.max) };
}

function parseInputSlot(value: unknown): CatalogInputSlot | null {
  if (
    !isRecord(value) ||
    !isString(value.key) ||
    !isString(value.label) ||
    !['image', 'video', 'audio', 'character', 'preparedVoice'].includes(
      String(value.kind),
    ) ||
    !['reference', 'startFrame', 'endFrame'].includes(String(value.role)) ||
    !Number.isInteger(value.min) ||
    !Number.isInteger(value.max) ||
    Number(value.min) < 0 ||
    Number(value.max) < Number(value.min)
  ) {
    return null;
  }
  if (
    value.supportsNaming !== undefined &&
    typeof value.supportsNaming !== 'boolean'
  )
    return null;
  if (
    value.durationMetadata !== undefined &&
    value.durationMetadata !== 'optional' &&
    value.durationMetadata !== 'required'
  )
    return null;
  if (
    value.maxDurationSeconds !== undefined &&
    (!Number.isFinite(value.maxDurationSeconds) ||
      Number(value.maxDurationSeconds) <= 0)
  )
    return null;
  const conditions = parseConditions(value.conditions);
  if (value.conditions !== undefined && !conditions) return null;
  return {
    key: value.key,
    label: value.label,
    kind: value.kind as CatalogInputSlot['kind'],
    role: value.role as CatalogInputSlot['role'],
    min: Number(value.min),
    max: Number(value.max),
    ...(typeof value.supportsNaming === 'boolean'
      ? { supportsNaming: value.supportsNaming }
      : {}),
    ...(value.durationMetadata
      ? { durationMetadata: value.durationMetadata }
      : {}),
    ...(value.maxDurationSeconds === undefined
      ? {}
      : { maxDurationSeconds: Number(value.maxDurationSeconds) }),
    ...(conditions ? { conditions } : {}),
  };
}

function parseInputMode(value: unknown): CatalogInputMode | null {
  if (
    !isRecord(value) ||
    !isString(value.key) ||
    !isString(value.label) ||
    typeof value.default !== 'boolean' ||
    !Array.isArray(value.slots)
  )
    return null;
  const slots = value.slots.map(parseInputSlot);
  const conditions = parseConditions(value.conditions);
  if (
    slots.some((slot) => !slot) ||
    (value.conditions !== undefined && !conditions)
  )
    return null;
  return {
    key: value.key,
    label: value.label,
    default: value.default,
    slots: slots as CatalogInputSlot[],
    ...(conditions ? { conditions } : {}),
  };
}

function parseInputConstraint(value: unknown): CatalogInputConstraint | null {
  if (
    !isRecord(value) ||
    !['total-count', 'weighted-count', 'combined-duration'].includes(
      String(value.type),
    ) ||
    !Array.isArray(value.slotKeys) ||
    !value.slotKeys.every(isString) ||
    !Number.isFinite(value.max) ||
    Number(value.max) < 0 ||
    !isString(value.message)
  )
    return null;
  if (
    value.weights !== undefined &&
    (!isRecord(value.weights) ||
      Object.values(value.weights).some(
        (weight) =>
          typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0,
      ))
  ) {
    return null;
  }
  const conditions = parseConditions(value.conditions);
  if (value.conditions !== undefined && !conditions) return null;
  return {
    type: value.type as CatalogInputConstraint['type'],
    slotKeys: value.slotKeys as string[],
    max: Number(value.max),
    message: value.message,
    ...(value.weights
      ? { weights: value.weights as Record<string, number> }
      : {}),
    ...(conditions ? { conditions } : {}),
  };
}

export function parsePublishedModelDescriptor(
  value: unknown,
  modelId: string,
  releaseSchemaVersion: number,
  availability: Record<CatalogPlatform, boolean>,
): GenerationModelDescriptor {
  if (
    !isRecord(value) ||
    value.id !== modelId ||
    !isGenerationModelKind(value.kind)
  ) {
    throw new Error(`Invalid public descriptor for ${modelId}.`);
  }
  if (
    !isString(value.displayName) ||
    typeof value.description !== 'string' ||
    (value.badge !== null && typeof value.badge !== 'string') ||
    typeof value.recommended !== 'boolean' ||
    !Number.isFinite(value.sortOrder) ||
    !Number.isInteger(value.minClientSchemaVersion) ||
    !Array.isArray(value.controls) ||
    !isRecord(value.capabilities) ||
    !isRecord(value.inputs)
  ) {
    throw new Error(`Invalid public descriptor for ${modelId}.`);
  }
  const controls = value.controls.map(parseCatalogControl);
  if (controls.some((control) => !control))
    throw new Error(`Invalid controls for ${modelId}.`);
  const capabilities = value.capabilities;
  const capabilityKeys = [
    'multiShot',
    'sound',
    'fixedLens',
    'googleSearch',
    'outputFormat',
  ];
  if (capabilityKeys.some((key) => typeof capabilities[key] !== 'boolean')) {
    throw new Error(`Invalid capabilities for ${modelId}.`);
  }
  if (
    typeof value.inputs.startFrame !== 'boolean' ||
    typeof value.inputs.endFrame !== 'boolean'
  ) {
    throw new Error(`Invalid input configuration for ${modelId}.`);
  }
  const imageReferences = parseReferenceLimit(
    value.inputs.imageReferences,
    true,
  );
  const videoReferences = parseReferenceLimit(
    value.inputs.videoReferences,
    false,
  );
  const audioReferences = parseReferenceLimit(
    value.inputs.audioReferences,
    false,
  );
  const preparedAudioReferences =
    value.inputs.preparedAudioReferences === undefined
      ? null
      : parseReferenceLimit(value.inputs.preparedAudioReferences, false);
  const characterReferences =
    value.inputs.characterReferences === undefined
      ? null
      : parseReferenceLimit(value.inputs.characterReferences, false);
  if (
    imageReferences === undefined ||
    videoReferences === undefined ||
    audioReferences === undefined ||
    preparedAudioReferences === undefined ||
    characterReferences === undefined ||
    (value.inputs.combineFramesWithReferences !== undefined &&
      typeof value.inputs.combineFramesWithReferences !== 'boolean')
  ) {
    throw new Error(`Invalid input configuration for ${modelId}.`);
  }
  let inputModes: CatalogInputMode[] | undefined;
  let inputConstraints: CatalogInputConstraint[] | undefined;
  if (releaseSchemaVersion >= 2) {
    if (
      !Array.isArray(value.inputModes) ||
      !Array.isArray(value.inputConstraints)
    ) {
      throw new Error(`Schema-v2 inputs are missing for ${modelId}.`);
    }
    const parsedModes = value.inputModes.map(parseInputMode);
    const parsedConstraints = value.inputConstraints.map(parseInputConstraint);
    if (
      parsedModes.some((mode) => !mode) ||
      parsedConstraints.some((constraint) => !constraint)
    ) {
      throw new Error(`Invalid schema-v2 inputs for ${modelId}.`);
    }
    inputModes = parsedModes as CatalogInputMode[];
    inputConstraints = parsedConstraints as CatalogInputConstraint[];
  }
  return {
    id: modelId,
    kind: value.kind,
    displayName: value.displayName,
    description: value.description,
    badge: value.badge,
    recommended: value.recommended,
    sortOrder: Number(value.sortOrder),
    minClientSchemaVersion: Number(value.minClientSchemaVersion),
    controls: controls as CatalogControl[],
    capabilities: {
      multiShot: capabilities.multiShot as boolean,
      sound: capabilities.sound as boolean,
      fixedLens: capabilities.fixedLens as boolean,
      googleSearch: capabilities.googleSearch as boolean,
      outputFormat: capabilities.outputFormat as boolean,
    },
    inputs: {
      imageReferences,
      videoReferences,
      audioReferences,
      preparedAudioReferences,
      characterReferences,
      startFrame: value.inputs.startFrame,
      endFrame: value.inputs.endFrame,
      ...(typeof value.inputs.combineFramesWithReferences === 'boolean'
        ? {
            combineFramesWithReferences:
              value.inputs.combineFramesWithReferences,
          }
        : {}),
    },
    ...(releaseSchemaVersion >= 2
      ? {
          availability,
          inputModes,
          inputConstraints,
        }
      : {}),
  };
}
