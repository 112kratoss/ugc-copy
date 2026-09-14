'use client';
import { useMemo, useState } from 'react';
import type {
  CatalogPrimitive,
  GenerationModelDescriptor,
} from '@/lib/generation-model-catalog';
// The condition evaluator is the one the server runtime and the native app use.
import { catalogConditionsMatch } from '../../ugc-mobile/lib/model-catalog-protocol';

type Settings = Record<string, CatalogPrimitive>;

export function catalogChoiceDefault(
  descriptor: GenerationModelDescriptor | undefined,
  key: string,
  fallback: string,
): string {
  const control = descriptor?.controls.find((control) => control.key === key);
  return control?.type === 'choice' ? control.defaultValue : fallback;
}

export function useAdditionalCatalogSettings(
  descriptor: GenerationModelDescriptor | undefined,
  handledKeys: readonly string[],
) {
  const [edits, setEdits] = useState<{ modelId: string; values: Settings }>({
    modelId: '',
    values: {},
  });
  const settings = useMemo(
    () =>
      Object.fromEntries(
        (descriptor?.controls ?? [])
          .filter((c) => !handledKeys.includes(c.key))
          .map((control) => {
            const edited =
              edits.modelId === descriptor?.id
                ? edits.values[control.key]
                : undefined;
            const valid =
              control.type === 'choice'
                ? control.options.some((o) => o.value === String(edited))
                : control.type === 'boolean'
                  ? typeof edited === 'boolean'
                  : typeof edited === 'number' &&
                    Number.isInteger(edited) &&
                    edited >= control.min &&
                    edited <= control.max &&
                    (edited - control.min) % control.step === 0;
            return [control.key, valid ? edited! : control.defaultValue];
          }),
      ),
    [descriptor, edits, handledKeys],
  );
  return {
    settings,
    onChange: (key: string, value: CatalogPrimitive) =>
      setEdits((current) => ({
        modelId: descriptor?.id ?? '',
        values: {
          ...(current.modelId === descriptor?.id ? current.values : {}),
          [key]: value,
        },
      })),
  };
}
export default function CatalogAdditionalControls({
  descriptor,
  handledKeys,
  settings,
  inputCounts,
  onChange,
}: {
  descriptor?: GenerationModelDescriptor;
  handledKeys: readonly string[];
  settings: Settings;
  inputCounts?: Record<string, number>;
  onChange: (key: string, value: CatalogPrimitive) => void;
}) {
  const controls =
    descriptor?.controls.filter(
      (control) =>
        !handledKeys.includes(control.key) &&
        catalogConditionsMatch(control.conditions, settings, inputCounts),
    ) ?? [];
  if (!controls.length) return null;
  return (
    <div className="space-y-3" aria-label="Additional model settings">
      {controls.map((control) => (
        <label
          key={control.key}
          className="flex flex-col gap-2 text-sm text-zinc-300"
        >
          {control.label}
          {control.type === 'choice' ? (
            <select
              value={String(settings[control.key] ?? control.defaultValue)}
              onChange={(event) => onChange(control.key, event.target.value)}
              className="min-h-11 rounded-xl border border-white/10 bg-zinc-900 px-3 text-white"
            >
              {control.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : control.type === 'boolean' ? (
            <input
              type="checkbox"
              checked={Boolean(settings[control.key] ?? control.defaultValue)}
              onChange={(event) => onChange(control.key, event.target.checked)}
              className="h-6 w-6"
            />
          ) : (
            <input
              type="number"
              value={Number(settings[control.key] ?? control.defaultValue)}
              min={control.min}
              max={control.max}
              step={control.step}
              onChange={(event) => {
                if (Number.isFinite(event.target.valueAsNumber))
                  onChange(control.key, event.target.valueAsNumber);
              }}
              className="min-h-11 rounded-xl border border-white/10 bg-zinc-900 px-3 text-white"
            />
          )}
        </label>
      ))}
    </div>
  );
}
