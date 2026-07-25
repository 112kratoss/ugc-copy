-- Carry the generation model on provider dependency telemetry.
--
-- Per-*service* outcome rates already exist, but a service name aggregates
-- every model routed through it: `KIE task creation` covers all 29 catalog
-- models at once. One consistently failing model is therefore invisible, because
-- its failures are averaged against healthy traffic hitting the same endpoint.
-- Attributing an event to the model it was made for is what makes a single bad
-- model detectable before users report it.
--
-- Nullable on purpose, and deliberately never backfilled:
--
--   * Not every provider call belongs to a generation. FX rate lookups, push
--     delivery, and payment calls have no model, and inventing one would make
--     the per-model denominator wrong.
--   * Existing rows cannot be attributed after the fact — the association was
--     simply not recorded when they were written.
--
-- Readers must treat NULL as "not model-attributed" and exclude those rows from
-- per-model rates, rather than bucketing them under a model named 'unknown'
-- which would then compete with real models for alert thresholds.

alter table public.provider_dependency_events
  add column if not exists model_id text;

comment on column public.provider_dependency_events.model_id is
  'Generation model this provider call was made on behalf of, or NULL for calls with no model (payments, FX, push receipts). Populated from the ambient provider-model request trace. Never backfilled: rows written before this column existed carry NULL and are excluded from per-model rates.';

-- Partial index: the per-model aggregation only ever reads attributed rows, so
-- excluding NULLs keeps the index off the majority of non-generation traffic.
create index if not exists provider_dependency_events_model_outcome_created_idx
  on public.provider_dependency_events (model_id, outcome, created_at desc)
  where model_id is not null;
