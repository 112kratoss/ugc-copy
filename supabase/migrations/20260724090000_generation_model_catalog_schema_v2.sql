-- Schema-v2 generation-model catalog publication support.
--
-- One catalog release is authoritative at a time. A v2 release retains the
-- legacy descriptor fields needed to project schema v1 while adding generic
-- controls, input modes, constraints, and private declarative adapter config.

ALTER TABLE public.generation_model_catalog_entries
  ADD COLUMN IF NOT EXISTS adapter_config jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(adapter_config) = 'object');

ALTER TABLE public.generation_model_catalog_entries
  DROP CONSTRAINT IF EXISTS generation_model_catalog_entries_adapter_key_check;
ALTER TABLE public.generation_model_catalog_entries
  ADD CONSTRAINT generation_model_catalog_entries_adapter_key_check
  CHECK (adapter_key IN ('image-v1', 'video-v1', 'motion-v1', 'kie-task-v1'));

ALTER TABLE public.generation_model_catalog_entries
  DROP CONSTRAINT IF EXISTS generation_model_catalog_entries_pricing_strategy_check;
ALTER TABLE public.generation_model_catalog_entries
  ADD CONSTRAINT generation_model_catalog_entries_pricing_strategy_check
  CHECK (
    pricing_strategy IN (
      'image-v1',
      'video-v1',
      'motion-v1',
      'flat',
      'lookup',
      'per-second',
      'conditional',
      'reference-adjustment'
    )
  );

ALTER TABLE public.generation_model_catalog_entries
  DROP CONSTRAINT IF EXISTS generation_model_catalog_entries_validation_strategy_check;
ALTER TABLE public.generation_model_catalog_entries
  ADD CONSTRAINT generation_model_catalog_entries_validation_strategy_check
  CHECK (
    validation_strategy IN (
      'image-v1',
      'video-v1',
      'motion-v1',
      'descriptor-rules-v1'
    )
  );

-- A v2 release is projected down for v1 clients. Keeping one active release
-- globally prevents an unqualified service query from observing two rows.
DROP INDEX IF EXISTS public.generation_model_catalog_one_active_idx;
CREATE UNIQUE INDEX generation_model_catalog_one_active_idx
  ON public.generation_model_catalog_releases ((status))
  WHERE status = 'active';

CREATE OR REPLACE FUNCTION public.generation_model_catalog_has_negative_number(
  p_value jsonb
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  child jsonb;
BEGIN
  IF jsonb_typeof(p_value) = 'number' THEN
    RETURN (p_value #>> '{}')::numeric < 0;
  END IF;
  IF jsonb_typeof(p_value) = 'array' THEN
    FOR child IN SELECT value FROM jsonb_array_elements(p_value) LOOP
      IF public.generation_model_catalog_has_negative_number(child) THEN
        RETURN true;
      END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_value) = 'object' THEN
    FOR child IN SELECT value FROM jsonb_each(p_value) LOOP
      IF public.generation_model_catalog_has_negative_number(child) THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.validate_generation_model_catalog_release(
  p_release_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  target public.generation_model_catalog_releases%ROWTYPE;
  platform_name text;
  kind_name text;
  default_model_id text;
BEGIN
  SELECT * INTO target
  FROM public.generation_model_catalog_releases
  WHERE id = p_release_id;

  IF target.id IS NULL THEN
    RAISE EXCEPTION 'The catalog release does not exist';
  END IF;
  IF target.schema_version NOT IN (1, 2) THEN
    RAISE EXCEPTION 'Unsupported catalog schema version';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.generation_model_catalog_entries
    WHERE release_id = p_release_id
  ) THEN
    RAISE EXCEPTION 'A catalog release must contain at least one model';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.generation_model_catalog_entries AS entry
    JOIN public.generation_models AS model ON model.model_id = entry.model_id
    WHERE entry.release_id = p_release_id
      AND (
        entry.public_descriptor ->> 'id' IS DISTINCT FROM entry.model_id
        OR entry.public_descriptor ->> 'kind' IS DISTINCT FROM model.kind
        OR NULLIF(entry.public_descriptor ->> 'displayName', '') IS NULL
        OR jsonb_typeof(entry.public_descriptor -> 'description') IS DISTINCT FROM 'string'
        OR jsonb_typeof(entry.public_descriptor -> 'badge') IS NULL
        OR jsonb_typeof(entry.public_descriptor -> 'badge') NOT IN ('string', 'null')
        OR jsonb_typeof(entry.public_descriptor -> 'recommended') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(entry.public_descriptor -> 'sortOrder') IS DISTINCT FROM 'number'
        OR CASE
          WHEN jsonb_typeof(entry.public_descriptor -> 'sortOrder') = 'number'
            THEN (entry.public_descriptor ->> 'sortOrder')::numeric < 0
          ELSE true
        END
        OR jsonb_typeof(entry.public_descriptor -> 'minClientSchemaVersion')
          IS DISTINCT FROM 'number'
        OR jsonb_typeof(entry.public_descriptor -> 'controls') IS DISTINCT FROM 'array'
        OR jsonb_typeof(entry.public_descriptor -> 'capabilities') IS DISTINCT FROM 'object'
        OR jsonb_typeof(entry.public_descriptor -> 'capabilities' -> 'multiShot')
          IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(entry.public_descriptor -> 'capabilities' -> 'sound')
          IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(entry.public_descriptor -> 'capabilities' -> 'fixedLens')
          IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(entry.public_descriptor -> 'capabilities' -> 'googleSearch')
          IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(entry.public_descriptor -> 'capabilities' -> 'outputFormat')
          IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(entry.public_descriptor -> 'inputs') IS DISTINCT FROM 'object'
        OR jsonb_typeof(entry.public_descriptor -> 'inputs' -> 'startFrame')
          IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(entry.public_descriptor -> 'inputs' -> 'endFrame')
          IS DISTINCT FROM 'boolean'
        OR entry.provider_model_map = '{}'::jsonb
        OR jsonb_typeof(entry.adapter_config) IS DISTINCT FROM 'object'
        OR entry.adapter_config ? 'endpoint'
        OR entry.public_descriptor ?| ARRAY[
          'adapterConfig',
          'adapterKey',
          'providerModelMap',
          'pricingConfig',
          'pricingStrategy',
          'validationConfig',
          'verificationConfig'
        ]
        OR public.generation_model_catalog_has_negative_number(entry.pricing_config)
      )
  ) THEN
    RAISE EXCEPTION 'One or more catalog entries are invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.generation_model_catalog_entries AS entry
    CROSS JOIN LATERAL jsonb_array_elements(entry.public_descriptor -> 'controls') AS control
    WHERE entry.release_id = p_release_id
      AND (
        control ->> 'type' IS NULL
        OR control ->> 'type' NOT IN ('choice', 'boolean', 'integer')
        OR NULLIF(control ->> 'key', '') IS NULL
        OR NULLIF(control ->> 'label', '') IS NULL
        OR (
          control ? 'conditions'
          AND jsonb_typeof(control -> 'conditions') IS DISTINCT FROM 'array'
        )
        OR (
          control ->> 'type' = 'choice'
          AND (
            (
              control ->> 'presentation' IS NULL
              OR control ->> 'presentation' NOT IN ('chips', 'select')
            )
            OR jsonb_typeof(control -> 'options') IS DISTINCT FROM 'array'
            OR jsonb_typeof(control -> 'defaultValue') IS DISTINCT FROM 'string'
            OR (
              control ? 'normalizedValueType'
              AND (
                control ->> 'normalizedValueType' IS NULL
                OR control ->> 'normalizedValueType' NOT IN ('string', 'number')
              )
            )
            OR CASE
              WHEN jsonb_typeof(control -> 'options') = 'array'
                THEN
                  jsonb_array_length(control -> 'options') = 0
                  OR NOT EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(control -> 'options') AS option
                    WHERE option ->> 'value' = control ->> 'defaultValue'
                  )
              ELSE true
            END
          )
        )
        OR (
          control ->> 'type' = 'boolean'
          AND (
            control ->> 'presentation' IS DISTINCT FROM 'toggle'
            OR jsonb_typeof(control -> 'defaultValue') IS DISTINCT FROM 'boolean'
          )
        )
        OR (
          control ->> 'type' = 'integer'
          AND (
            control ->> 'presentation' IS DISTINCT FROM 'stepper'
            OR jsonb_typeof(control -> 'defaultValue') IS DISTINCT FROM 'number'
            OR jsonb_typeof(control -> 'min') IS DISTINCT FROM 'number'
            OR jsonb_typeof(control -> 'max') IS DISTINCT FROM 'number'
            OR jsonb_typeof(control -> 'step') IS DISTINCT FROM 'number'
            OR CASE
              WHEN
                jsonb_typeof(control -> 'defaultValue') = 'number'
                AND jsonb_typeof(control -> 'min') = 'number'
                AND jsonb_typeof(control -> 'max') = 'number'
                AND jsonb_typeof(control -> 'step') = 'number'
              THEN
                (control ->> 'min')::numeric > (control ->> 'max')::numeric
                OR (control ->> 'defaultValue')::numeric < (control ->> 'min')::numeric
                OR (control ->> 'defaultValue')::numeric > (control ->> 'max')::numeric
                OR (control ->> 'step')::numeric <= 0
                OR trunc((control ->> 'defaultValue')::numeric)
                  <> (control ->> 'defaultValue')::numeric
                OR trunc((control ->> 'min')::numeric) <> (control ->> 'min')::numeric
                OR trunc((control ->> 'max')::numeric) <> (control ->> 'max')::numeric
                OR trunc((control ->> 'step')::numeric) <> (control ->> 'step')::numeric
                OR CASE
                  WHEN (control ->> 'step')::numeric > 0
                    THEN mod(
                      (control ->> 'defaultValue')::numeric
                        - (control ->> 'min')::numeric,
                      (control ->> 'step')::numeric
                    ) <> 0
                  ELSE true
                END
              ELSE true
            END
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'One or more catalog controls are invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.generation_model_catalog_entries AS entry
    CROSS JOIN LATERAL jsonb_array_elements(entry.public_descriptor -> 'controls')
      AS control(value)
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(control.value -> 'options') = 'array'
          THEN control.value -> 'options'
        ELSE '[]'::jsonb
      END
    ) AS option_value(value)
    WHERE entry.release_id = p_release_id
      AND control.value ->> 'type' = 'choice'
      AND (
        jsonb_typeof(option_value.value) IS DISTINCT FROM 'object'
        OR NULLIF(option_value.value ->> 'value', '') IS NULL
        OR NULLIF(option_value.value ->> 'label', '') IS NULL
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.generation_model_catalog_entries AS entry
    CROSS JOIN LATERAL jsonb_array_elements(entry.public_descriptor -> 'controls')
      AS control(value)
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(control.value -> 'options') = 'array'
          THEN control.value -> 'options'
        ELSE '[]'::jsonb
      END
    )
      AS option_value(value)
    WHERE entry.release_id = p_release_id
      AND control.value ->> 'type' = 'choice'
    GROUP BY entry.model_id, control.value ->> 'key'
    HAVING count(*) <> count(DISTINCT option_value.value ->> 'value')
  ) THEN
    RAISE EXCEPTION 'One or more catalog choice options are invalid';
  END IF;

  IF target.schema_version = 2 AND EXISTS (
    SELECT 1
    FROM public.generation_model_catalog_entries AS entry
    WHERE entry.release_id = p_release_id
      AND (
        jsonb_typeof(entry.public_descriptor -> 'schemaVersion') IS DISTINCT FROM 'number'
        OR entry.public_descriptor ->> 'schemaVersion' IS DISTINCT FROM '2'
        OR jsonb_typeof(entry.public_descriptor -> 'availability') IS DISTINCT FROM 'object'
        OR jsonb_typeof(entry.public_descriptor -> 'availability' -> 'web')
          IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(entry.public_descriptor -> 'availability' -> 'mobile')
          IS DISTINCT FROM 'boolean'
        OR CASE
          WHEN jsonb_typeof(entry.public_descriptor -> 'availability' -> 'web') = 'boolean'
            THEN (entry.public_descriptor -> 'availability' ->> 'web')::boolean
              IS DISTINCT FROM entry.web_enabled
          ELSE true
        END
        OR CASE
          WHEN jsonb_typeof(entry.public_descriptor -> 'availability' -> 'mobile') = 'boolean'
            THEN (entry.public_descriptor -> 'availability' ->> 'mobile')::boolean
              IS DISTINCT FROM entry.mobile_enabled
          ELSE true
        END
        OR jsonb_typeof(entry.public_descriptor -> 'inputModes') IS DISTINCT FROM 'array'
        OR jsonb_array_length(entry.public_descriptor -> 'inputModes') = 0
        OR jsonb_typeof(entry.public_descriptor -> 'inputConstraints') IS DISTINCT FROM 'array'
        OR jsonb_typeof(entry.public_descriptor -> 'minClientSchemaVersion')
          IS DISTINCT FROM 'number'
        OR CASE
          WHEN jsonb_typeof(entry.public_descriptor -> 'minClientSchemaVersion') = 'number'
          THEN
            (entry.public_descriptor ->> 'minClientSchemaVersion')::numeric
              NOT BETWEEN 1 AND 2
            OR trunc((entry.public_descriptor ->> 'minClientSchemaVersion')::numeric)
              <> (entry.public_descriptor ->> 'minClientSchemaVersion')::numeric
          ELSE true
        END
      )
  ) THEN
    RAISE EXCEPTION 'One or more schema v2 descriptors are invalid';
  END IF;

  IF target.schema_version = 2 AND (
    EXISTS (
      SELECT 1
      FROM public.generation_model_catalog_entries AS entry
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(entry.public_descriptor -> 'inputModes') = 'array'
            THEN entry.public_descriptor -> 'inputModes'
          ELSE '[]'::jsonb
        END
      ) AS mode_value(value)
      WHERE entry.release_id = p_release_id
        AND (
          jsonb_typeof(mode_value.value) IS DISTINCT FROM 'object'
          OR NULLIF(mode_value.value ->> 'key', '') IS NULL
          OR NULLIF(mode_value.value ->> 'label', '') IS NULL
          OR jsonb_typeof(mode_value.value -> 'default') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(mode_value.value -> 'slots') IS DISTINCT FROM 'array'
          OR (
            mode_value.value ? 'conditions'
            AND jsonb_typeof(mode_value.value -> 'conditions') IS DISTINCT FROM 'array'
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.generation_model_catalog_entries AS entry
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(entry.public_descriptor -> 'inputModes') = 'array'
            THEN entry.public_descriptor -> 'inputModes'
          ELSE '[]'::jsonb
        END
      ) AS mode_value(value)
      WHERE entry.release_id = p_release_id
      GROUP BY entry.model_id
      HAVING
        count(*) FILTER (WHERE mode_value.value -> 'default' = 'true'::jsonb) <> 1
        OR count(*) <> count(DISTINCT mode_value.value ->> 'key')
    )
    OR EXISTS (
      SELECT 1
      FROM public.generation_model_catalog_entries AS entry
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(entry.public_descriptor -> 'inputModes') = 'array'
            THEN entry.public_descriptor -> 'inputModes'
          ELSE '[]'::jsonb
        END
      ) AS mode_value(value)
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(mode_value.value -> 'slots') = 'array'
            THEN mode_value.value -> 'slots'
          ELSE '[]'::jsonb
        END
      ) AS slot_value(value)
      WHERE entry.release_id = p_release_id
        AND (
          jsonb_typeof(slot_value.value) IS DISTINCT FROM 'object'
          OR NULLIF(slot_value.value ->> 'key', '') IS NULL
          OR NULLIF(slot_value.value ->> 'label', '') IS NULL
          OR slot_value.value ->> 'kind' IS NULL
          OR slot_value.value ->> 'kind'
            NOT IN ('image', 'video', 'audio', 'character', 'preparedVoice')
          OR slot_value.value ->> 'role' IS NULL
          OR slot_value.value ->> 'role'
            NOT IN ('reference', 'startFrame', 'endFrame')
          OR jsonb_typeof(slot_value.value -> 'min') IS DISTINCT FROM 'number'
          OR jsonb_typeof(slot_value.value -> 'max') IS DISTINCT FROM 'number'
          OR CASE
            WHEN jsonb_typeof(slot_value.value -> 'min') = 'number'
              AND jsonb_typeof(slot_value.value -> 'max') = 'number'
            THEN
              (slot_value.value ->> 'min')::numeric < 0
              OR trunc((slot_value.value ->> 'min')::numeric)
                <> (slot_value.value ->> 'min')::numeric
              OR trunc((slot_value.value ->> 'max')::numeric)
                <> (slot_value.value ->> 'max')::numeric
              OR (slot_value.value ->> 'max')::numeric
                < (slot_value.value ->> 'min')::numeric
            ELSE true
          END
          OR (
            slot_value.value ? 'supportsNaming'
            AND jsonb_typeof(slot_value.value -> 'supportsNaming')
              IS DISTINCT FROM 'boolean'
          )
          OR (
            slot_value.value ? 'durationMetadata'
            AND (
              slot_value.value ->> 'durationMetadata' IS NULL
              OR slot_value.value ->> 'durationMetadata'
                NOT IN ('optional', 'required')
            )
          )
          OR (
            slot_value.value ? 'maxDurationSeconds'
            AND (
              jsonb_typeof(slot_value.value -> 'maxDurationSeconds')
                IS DISTINCT FROM 'number'
              OR CASE
                WHEN jsonb_typeof(slot_value.value -> 'maxDurationSeconds') = 'number'
                  THEN (slot_value.value ->> 'maxDurationSeconds')::numeric <= 0
                ELSE true
              END
            )
          )
          OR (
            slot_value.value ? 'conditions'
            AND jsonb_typeof(slot_value.value -> 'conditions')
              IS DISTINCT FROM 'array'
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.generation_model_catalog_entries AS entry
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(entry.public_descriptor -> 'inputModes') = 'array'
            THEN entry.public_descriptor -> 'inputModes'
          ELSE '[]'::jsonb
        END
      ) AS mode_value(value)
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(mode_value.value -> 'slots') = 'array'
            THEN mode_value.value -> 'slots'
          ELSE '[]'::jsonb
        END
      )
        AS slot_value(value)
      WHERE entry.release_id = p_release_id
      GROUP BY
        entry.model_id,
        mode_value.value ->> 'key',
        slot_value.value ->> 'key'
      HAVING count(*) > 1
    )
  ) THEN
    RAISE EXCEPTION 'One or more schema v2 input modes are invalid';
  END IF;

  IF target.schema_version = 2 AND EXISTS (
    SELECT 1
    FROM public.generation_model_catalog_entries AS entry
    CROSS JOIN LATERAL jsonb_array_elements(
      entry.public_descriptor -> 'inputConstraints'
    ) AS constraint_value
    WHERE entry.release_id = p_release_id
      AND (
        constraint_value ->> 'type' IS NULL
        OR constraint_value ->> 'type'
          NOT IN ('total-count', 'weighted-count', 'combined-duration')
        OR jsonb_typeof(constraint_value -> 'slotKeys') IS DISTINCT FROM 'array'
        OR jsonb_array_length(constraint_value -> 'slotKeys') = 0
        OR jsonb_typeof(constraint_value -> 'max') IS DISTINCT FROM 'number'
        OR CASE
          WHEN jsonb_typeof(constraint_value -> 'max') = 'number'
            THEN (constraint_value ->> 'max')::numeric < 0
          ELSE true
        END
        OR NULLIF(constraint_value ->> 'message', '') IS NULL
        OR (
          constraint_value ? 'conditions'
          AND jsonb_typeof(constraint_value -> 'conditions') IS DISTINCT FROM 'array'
        )
        OR (
          constraint_value ->> 'type' = 'weighted-count'
          AND (
            jsonb_typeof(constraint_value -> 'weights') IS DISTINCT FROM 'object'
            OR constraint_value -> 'weights' = '{}'::jsonb
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'One or more schema v2 input constraints are invalid';
  END IF;

  IF target.schema_version = 2 AND (
    EXISTS (
      SELECT 1
      FROM public.generation_model_catalog_entries AS entry
      CROSS JOIN LATERAL jsonb_array_elements(
        entry.public_descriptor -> 'inputConstraints'
      ) AS constraint_value(value)
      CROSS JOIN LATERAL jsonb_array_elements(
        constraint_value.value -> 'slotKeys'
      ) AS constraint_slot(value)
      WHERE entry.release_id = p_release_id
        AND (
          jsonb_typeof(constraint_slot.value) IS DISTINCT FROM 'string'
          OR NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(entry.public_descriptor -> 'inputModes')
              AS mode_value(value)
            CROSS JOIN LATERAL jsonb_array_elements(mode_value.value -> 'slots')
              AS slot_value(value)
            WHERE slot_value.value ->> 'key' = constraint_slot.value #>> '{}'
              AND (
                constraint_value.value ->> 'type' <> 'combined-duration'
                OR slot_value.value ->> 'durationMetadata' = 'required'
              )
          )
          OR (
            constraint_value.value ->> 'type' = 'weighted-count'
            AND NOT (
              (constraint_value.value -> 'weights') ? (constraint_slot.value #>> '{}')
            )
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.generation_model_catalog_entries AS entry
      CROSS JOIN LATERAL jsonb_array_elements(
        entry.public_descriptor -> 'inputConstraints'
      ) WITH ORDINALITY AS constraint_value(value, position)
      CROSS JOIN LATERAL jsonb_array_elements(
        constraint_value.value -> 'slotKeys'
      ) AS constraint_slot(value)
      WHERE entry.release_id = p_release_id
      GROUP BY entry.model_id, constraint_value.position
      HAVING count(*) <> count(DISTINCT constraint_slot.value #>> '{}')
    )
    OR EXISTS (
      SELECT 1
      FROM public.generation_model_catalog_entries AS entry
      CROSS JOIN LATERAL jsonb_array_elements(
        entry.public_descriptor -> 'inputConstraints'
      ) AS constraint_value(value)
      CROSS JOIN LATERAL jsonb_each(
        CASE
          WHEN jsonb_typeof(constraint_value.value -> 'weights') = 'object'
            THEN constraint_value.value -> 'weights'
          ELSE '{}'::jsonb
        END
      ) AS weight_value(key, value)
      WHERE entry.release_id = p_release_id
        AND constraint_value.value ->> 'type' = 'weighted-count'
        AND (
          jsonb_typeof(weight_value.value) IS DISTINCT FROM 'number'
          OR CASE
            WHEN jsonb_typeof(weight_value.value) = 'number'
              THEN (weight_value.value #>> '{}')::numeric < 0
            ELSE true
          END
          OR NOT (constraint_value.value -> 'slotKeys') ? weight_value.key
        )
    )
  ) THEN
    RAISE EXCEPTION 'One or more schema v2 input constraints reference invalid slots';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.generation_model_catalog_entries AS entry
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN entry.validation_strategy = 'descriptor-rules-v1'
          AND jsonb_typeof(entry.validation_config -> 'rules') = 'array'
          THEN entry.validation_config -> 'rules'
        ELSE '[]'::jsonb
      END
    ) AS rule
    WHERE entry.release_id = p_release_id
      AND (
        rule ->> 'type' NOT IN (
          'max-slot-count',
          'min-slot-count',
          'weighted-slot-count',
          'combined-duration',
          'mutually-exclusive-slots',
          'forbidden-combination',
          'control-options',
          'control-range'
        )
        OR (
          rule ->> 'type' = 'max-slot-count'
          AND (
            NULLIF(rule ->> 'slotKey', '') IS NULL
            OR jsonb_typeof(rule -> 'max') IS DISTINCT FROM 'number'
            OR (rule ->> 'max')::numeric < 0
          )
        )
        OR (
          rule ->> 'type' = 'min-slot-count'
          AND (
            NULLIF(rule ->> 'slotKey', '') IS NULL
            OR jsonb_typeof(rule -> 'min') IS DISTINCT FROM 'number'
            OR (rule ->> 'min')::numeric < 0
          )
        )
        OR (
          rule ->> 'type' = 'combined-duration'
          AND (
            jsonb_typeof(rule -> 'slotKeys') IS DISTINCT FROM 'array'
            OR jsonb_array_length(rule -> 'slotKeys') = 0
            OR jsonb_typeof(rule -> 'max') IS DISTINCT FROM 'number'
            OR (rule ->> 'max')::numeric < 0
          )
        )
        OR (
          rule ->> 'type' = 'weighted-slot-count'
          AND (
            jsonb_typeof(rule -> 'weights') IS DISTINCT FROM 'object'
            OR rule -> 'weights' = '{}'::jsonb
            OR jsonb_typeof(rule -> 'max') IS DISTINCT FROM 'number'
            OR (rule ->> 'max')::numeric < 0
          )
        )
        OR (
          rule ->> 'type' = 'mutually-exclusive-slots'
          AND (
            jsonb_typeof(rule -> 'slotKeys') IS DISTINCT FROM 'array'
            OR jsonb_array_length(rule -> 'slotKeys') < 2
          )
        )
        OR (
          rule ->> 'type' = 'forbidden-combination'
          AND (
            jsonb_typeof(rule -> 'conditions') IS DISTINCT FROM 'array'
            OR jsonb_array_length(rule -> 'conditions') = 0
          )
        )
        OR (
          rule ->> 'type' = 'control-options'
          AND (
            NULLIF(rule ->> 'key', '') IS NULL
            OR jsonb_typeof(rule -> 'options') IS DISTINCT FROM 'array'
            OR jsonb_array_length(rule -> 'options') = 0
          )
        )
        OR (
          rule ->> 'type' = 'control-range'
          AND (
            NULLIF(rule ->> 'key', '') IS NULL
            OR jsonb_typeof(rule -> 'min') IS DISTINCT FROM 'number'
            OR jsonb_typeof(rule -> 'max') IS DISTINCT FROM 'number'
            OR (rule ->> 'min')::numeric > (rule ->> 'max')::numeric
          )
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.generation_model_catalog_entries AS entry
    WHERE entry.release_id = p_release_id
      AND entry.validation_strategy = 'descriptor-rules-v1'
      AND jsonb_typeof(entry.validation_config -> 'rules') IS DISTINCT FROM 'array'
  ) OR EXISTS (
    SELECT 1
    FROM public.generation_model_catalog_entries AS entry
    CROSS JOIN LATERAL jsonb_array_elements(entry.validation_config -> 'rules') AS rule
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(rule -> 'conditions') = 'array'
          THEN rule -> 'conditions'
        ELSE '[]'::jsonb
      END
    ) AS condition
    WHERE entry.release_id = p_release_id
      AND entry.validation_strategy = 'descriptor-rules-v1'
      AND (
        condition ->> 'source' NOT IN ('setting', 'inputCount')
        OR condition ->> 'operator' NOT IN (
          'equals',
          'notEquals',
          'in',
          'notIn',
          'greaterThan',
          'greaterThanOrEqual'
        )
        OR NULLIF(condition ->> 'key', '') IS NULL
        OR NOT condition ? 'value'
      )
  ) THEN
    RAISE EXCEPTION 'One or more validation rules are unsupported';
  END IF;

  FOREACH platform_name IN ARRAY ARRAY['web', 'mobile'] LOOP
    FOREACH kind_name IN ARRAY ARRAY['image', 'video', 'motion'] LOOP
      default_model_id := target.defaults -> platform_name ->> kind_name;
      IF default_model_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.generation_model_catalog_entries AS entry
        JOIN public.generation_models AS model ON model.model_id = entry.model_id
        WHERE entry.release_id = p_release_id
          AND entry.model_id = default_model_id
          AND model.kind = kind_name
          AND CASE
            WHEN platform_name = 'mobile' THEN entry.mobile_enabled
            ELSE entry.web_enabled
          END
      ) THEN
        RAISE EXCEPTION 'Invalid % default for %', kind_name, platform_name;
      END IF;
    END LOOP;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.stage_generation_model_catalog(
  p_manifest jsonb,
  p_expected_active_revision text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  active_revision text;
  new_release_id uuid := gen_random_uuid();
  manifest_revision text := NULLIF(btrim(p_manifest ->> 'revision'), '');
  manifest_schema integer;
BEGIN
  IF jsonb_typeof(p_manifest) IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_manifest -> 'entries') IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_manifest -> 'entries') = 0
    OR jsonb_typeof(p_manifest -> 'defaults') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'The catalog manifest is malformed';
  END IF;

  BEGIN
    manifest_schema := (p_manifest ->> 'schemaVersion')::integer;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'The catalog manifest schema is invalid';
  END;
  IF manifest_schema <> 2 THEN
    RAISE EXCEPTION 'Only schema v2 manifests may be staged';
  END IF;
  IF manifest_revision IS NULL OR char_length(manifest_revision) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'The catalog manifest revision is invalid';
  END IF;

  SELECT revision INTO active_revision
  FROM public.generation_model_catalog_releases
  WHERE status = 'active'
  FOR UPDATE;

  IF active_revision IS DISTINCT FROM p_expected_active_revision THEN
    RAISE EXCEPTION 'The active catalog revision changed';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.generation_model_catalog_releases
    WHERE revision = manifest_revision
  ) THEN
    RAISE EXCEPTION 'The catalog revision already exists';
  END IF;

  INSERT INTO public.generation_models (model_id, kind)
  SELECT
    entry ->> 'modelId',
    entry ->> 'kind'
  FROM jsonb_array_elements(p_manifest -> 'entries') AS entry
  ON CONFLICT (model_id) DO NOTHING;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_manifest -> 'entries') AS entry
    JOIN public.generation_models AS model ON model.model_id = entry ->> 'modelId'
    WHERE model.kind IS DISTINCT FROM entry ->> 'kind'
  ) THEN
    RAISE EXCEPTION 'A catalog entry changes an immutable model kind';
  END IF;

  INSERT INTO public.generation_model_catalog_releases (
    id,
    schema_version,
    revision,
    status,
    defaults,
    change_note,
    created_by
  )
  VALUES (
    new_release_id,
    manifest_schema,
    manifest_revision,
    'draft',
    p_manifest -> 'defaults',
    COALESCE(p_manifest ->> 'changeNote', ''),
    COALESCE(NULLIF(btrim(p_manifest ->> 'createdBy'), ''), 'catalog-operations')
  );

  INSERT INTO public.generation_model_catalog_entries (
    release_id,
    model_id,
    public_descriptor,
    web_enabled,
    mobile_enabled,
    adapter_key,
    adapter_config,
    provider_model_map,
    pricing_strategy,
    pricing_config,
    validation_strategy,
    validation_config,
    verification_config
  )
  SELECT
    new_release_id,
    manifest_entry."modelId",
    manifest_entry."publicDescriptor",
    manifest_entry."webEnabled",
    manifest_entry."mobileEnabled",
    manifest_entry."adapterKey",
    COALESCE(manifest_entry."adapterConfig", '{}'::jsonb),
    manifest_entry."providerModelMap",
    manifest_entry."pricingStrategy",
    manifest_entry."pricingConfig",
    manifest_entry."validationStrategy",
    COALESCE(manifest_entry."validationConfig", '{}'::jsonb),
    COALESCE(manifest_entry."verificationConfig", '{}'::jsonb)
  FROM jsonb_to_recordset(p_manifest -> 'entries') AS manifest_entry(
    "modelId" text,
    "kind" text,
    "publicDescriptor" jsonb,
    "webEnabled" boolean,
    "mobileEnabled" boolean,
    "adapterKey" text,
    "adapterConfig" jsonb,
    "providerModelMap" jsonb,
    "pricingStrategy" text,
    "pricingConfig" jsonb,
    "validationStrategy" text,
    "validationConfig" jsonb,
    "verificationConfig" jsonb
  );

  PERFORM public.validate_generation_model_catalog_release(new_release_id);

  UPDATE public.generation_model_catalog_releases
  SET status = 'shadow'
  WHERE id = new_release_id;

  RETURN jsonb_build_object(
    'status', 'staged',
    'releaseId', new_release_id,
    'revision', manifest_revision,
    'basedOnRevision', active_revision,
    'entryCount', jsonb_array_length(p_manifest -> 'entries')
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.publish_generation_model_catalog(
  p_release_id uuid,
  p_expected_active_revision text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  target public.generation_model_catalog_releases%ROWTYPE;
  current_revision text;
BEGIN
  SELECT * INTO target
  FROM public.generation_model_catalog_releases
  WHERE id = p_release_id
  FOR UPDATE;

  IF target.id IS NULL OR target.status NOT IN ('draft', 'shadow') THEN
    RAISE EXCEPTION 'The target catalog release is not publishable';
  END IF;

  SELECT revision INTO current_revision
  FROM public.generation_model_catalog_releases
  WHERE status = 'active'
  FOR UPDATE;

  IF p_expected_active_revision IS NOT NULL
    AND current_revision IS DISTINCT FROM p_expected_active_revision THEN
    RAISE EXCEPTION 'The active catalog revision changed';
  END IF;

  PERFORM public.validate_generation_model_catalog_release(p_release_id);

  UPDATE public.generation_model_catalog_releases
  SET status = 'retired', retired_at = timezone('utc'::text, now())
  WHERE status = 'active';

  UPDATE public.generation_model_catalog_releases
  SET
    status = 'active',
    activated_at = timezone('utc'::text, now()),
    retired_at = NULL
  WHERE id = p_release_id;

  RETURN jsonb_build_object(
    'status', 'published',
    'releaseId', p_release_id,
    'revision', target.revision,
    'previousRevision', current_revision
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.clone_generation_model_catalog(
  p_source_revision text,
  p_new_revision text,
  p_change_note text,
  p_created_by text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  source_release public.generation_model_catalog_releases%ROWTYPE;
  new_release_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO source_release
  FROM public.generation_model_catalog_releases
  WHERE revision = p_source_revision;

  IF source_release.id IS NULL THEN
    RAISE EXCEPTION 'The source catalog revision does not exist';
  END IF;
  IF char_length(p_new_revision) NOT BETWEEN 8 AND 128 THEN
    RAISE EXCEPTION 'The new catalog revision is invalid';
  END IF;
  IF NULLIF(btrim(p_created_by), '') IS NULL THEN
    RAISE EXCEPTION 'The catalog creator is required';
  END IF;

  INSERT INTO public.generation_model_catalog_releases (
    id,
    schema_version,
    revision,
    status,
    defaults,
    change_note,
    created_by
  )
  VALUES (
    new_release_id,
    source_release.schema_version,
    p_new_revision,
    'draft',
    source_release.defaults,
    COALESCE(p_change_note, ''),
    p_created_by
  );

  INSERT INTO public.generation_model_catalog_entries (
    release_id,
    model_id,
    public_descriptor,
    web_enabled,
    mobile_enabled,
    adapter_key,
    adapter_config,
    provider_model_map,
    pricing_strategy,
    pricing_config,
    validation_strategy,
    validation_config,
    verification_config
  )
  SELECT
    new_release_id,
    model_id,
    public_descriptor,
    web_enabled,
    mobile_enabled,
    adapter_key,
    adapter_config,
    provider_model_map,
    pricing_strategy,
    pricing_config,
    validation_strategy,
    validation_config,
    verification_config
  FROM public.generation_model_catalog_entries
  WHERE release_id = source_release.id;

  RETURN new_release_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.rollback_generation_model_catalog(
  p_target_revision text,
  p_expected_active_revision text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  target_id uuid;
  current_revision text;
BEGIN
  SELECT id INTO target_id
  FROM public.generation_model_catalog_releases
  WHERE revision = p_target_revision
    AND status IN ('retired', 'active')
  FOR UPDATE;

  IF target_id IS NULL THEN
    RAISE EXCEPTION 'The rollback catalog revision does not exist';
  END IF;

  SELECT revision INTO current_revision
  FROM public.generation_model_catalog_releases
  WHERE status = 'active'
  FOR UPDATE;

  IF current_revision IS DISTINCT FROM p_expected_active_revision THEN
    RAISE EXCEPTION 'The active catalog revision changed';
  END IF;
  IF current_revision = p_target_revision THEN
    RETURN jsonb_build_object(
      'status', 'already_active',
      'revision', p_target_revision
    );
  END IF;

  UPDATE public.generation_model_catalog_releases
  SET status = 'retired', retired_at = timezone('utc'::text, now())
  WHERE status = 'active';

  UPDATE public.generation_model_catalog_releases
  SET
    status = 'active',
    activated_at = timezone('utc'::text, now()),
    retired_at = NULL
  WHERE id = target_id;

  RETURN jsonb_build_object(
    'status', 'rolled_back',
    'revision', p_target_revision,
    'previousRevision', current_revision
  );
END;
$$;

REVOKE ALL ON FUNCTION public.generation_model_catalog_has_negative_number(jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.validate_generation_model_catalog_release(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stage_generation_model_catalog(jsonb, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.publish_generation_model_catalog(uuid, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clone_generation_model_catalog(text, text, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rollback_generation_model_catalog(text, text)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.generation_model_catalog_has_negative_number(jsonb)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.validate_generation_model_catalog_release(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.stage_generation_model_catalog(jsonb, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_generation_model_catalog(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.clone_generation_model_catalog(text, text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.rollback_generation_model_catalog(text, text)
  TO service_role;
