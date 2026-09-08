-- Represent media whose only source is gone as unavailable, explicitly.
--
-- The 2026-09-05 media delivery audit found three records no repair can
-- restore: generation 058a82f8 (a motion clip whose only copy was a temporary
-- provider URL that now returns 404), post media a54b4ead (an image with no
-- stored object and the same kind of expired provider URL) and generation
-- a2b54deb (recorded as succeeded with no output URL at all). Every surface
-- treated them as transient -- spinners, "Tap to retry" -- because nothing
-- durable said the bytes are gone.
--
-- `source_unavailable_at` is that durable statement. It is set when a source
-- is known to be unrecoverable; the owner API then withholds the dead address
-- and clients render an explicit unavailable state instead of retrying. The
-- original columns are left untouched for the record, and nothing is deleted.

alter table public.generations
  add column if not exists source_unavailable_at timestamptz;

comment on column public.generations.source_unavailable_at is
  'Set when the output''s only source is known to be gone (expired provider URL, missing object). The owner API withholds the dead address and clients render an explicit unavailable state.';

alter table public.post_media
  add column if not exists source_unavailable_at timestamptz;

comment on column public.post_media.source_unavailable_at is
  'Set when the media''s only source is known to be gone. Clients render an explicit unavailable state instead of retrying the dead address.';

-- The three records from the audit. A replay on an empty database updates
-- nothing, which is the intended no-op.
update public.generations
set source_unavailable_at = now()
where id in ('058a82f8-b08a-418f-a420-561a501dae02', 'a2b54deb-262f-455a-8cea-019e963fbced')
  and source_unavailable_at is null;

update public.post_media
set source_unavailable_at = now()
where id = 'a54b4ead-428f-4788-938d-ce8367d8f0e4'
  and source_unavailable_at is null;
