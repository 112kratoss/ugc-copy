-- For You: get_ranked_feed_candidates_v4 is planned for each call's own values.
--
-- THE DEFECT (production, 2026-11-18, read-only calls on one connection). The
-- function answers in 22 to 30 ms, and the sixth call a connection makes took
-- 613 ms and 1,164 ms on two runs. Its all-time worst was 7.8 s, against the
-- 8 s the Data API allows a statement.
--
-- WHY. plpgsql plans a statement for its own values on its first five runs
-- and on the sixth builds a generic plan, one for any values, to see whether
-- it can stop planning (plan_cache_mode = auto). The function is one statement
-- of some twenty CTEs whose shape depends on its arguments: with the viewer
-- known, every `p_viewer_user_id IS NULL OR …` branch folds away and the plan
-- is small; with no values none folds, so the generic plan has every branch
-- and takes that long to build. It is then kept, and it is the slower of the
-- two to run (36 ms a call against 22 on production, 13.8 against 11.7 on a
-- replay seeded to production's size).
--
-- THE CHANGE. The function carries plan_cache_mode = force_custom_plan, as
-- search_starter_entity_offer does (20261113100423): every call is planned as
-- the first five already were. Measured on production with the setting applied
-- to the session: the sixth call 32 ms, the others unchanged. Its search path
-- stays pinned; ALTER FUNCTION ... SET adds to the settings and replaces none.
--
-- A later CREATE OR REPLACE of the function drops the setting unless it
-- repeats it: feed_candidates_custom_plans.test.sql holds the live function
-- to it after a full replay.
ALTER FUNCTION public.get_ranked_feed_candidates_v4(
  uuid, text, text, integer, integer, integer, integer, integer, integer,
  double precision, double precision, timestamptz, integer, integer, integer,
  integer, integer, integer, double precision, integer, double precision,
  integer, integer, boolean, boolean
) SET plan_cache_mode = force_custom_plan;
