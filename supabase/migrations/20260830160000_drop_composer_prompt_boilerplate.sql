-- The mobile composer attaches a prompt card on the creator's behalf and gave
-- it a description that only restates the card's own title: "The reusable
-- prompt used for this creation." It is filler on every surface that shows it,
-- and it is not the creator's writing.
--
-- `normalizePostResourceSections` now drops it on the way out and on the way
-- in, so no reader sees it and no new row stores it. This clears the rows that
-- already have it, so stored data matches what both apps render and nothing
-- reading raw rows later reintroduces it.
--
-- Only the description is touched, and only on a prompt section carrying that
-- exact sentence. A creator who wrote their own description keeps it, and a
-- section of any other type keeps it too.
UPDATE public.post_resource_bundles b
SET resource_sections = (
  SELECT jsonb_agg(
    CASE
      WHEN section->>'resourceType' = 'prompt'
       AND section->>'description' = 'The reusable prompt used for this creation.'
      THEN section - 'description'
      ELSE section
    END
    ORDER BY ordinality
  )
  FROM jsonb_array_elements(b.resource_sections) WITH ORDINALITY AS t(section, ordinality)
)
WHERE jsonb_typeof(b.resource_sections) = 'array'
  AND b.resource_sections::text LIKE '%The reusable prompt used for this creation.%';

UPDATE public.post_resource_bundle_revisions r
SET resource_sections = (
  SELECT jsonb_agg(
    CASE
      WHEN section->>'resourceType' = 'prompt'
       AND section->>'description' = 'The reusable prompt used for this creation.'
      THEN section - 'description'
      ELSE section
    END
    ORDER BY ordinality
  )
  FROM jsonb_array_elements(r.resource_sections) WITH ORDINALITY AS t(section, ordinality)
)
WHERE jsonb_typeof(r.resource_sections) = 'array'
  AND r.resource_sections::text LIKE '%The reusable prompt used for this creation.%';
