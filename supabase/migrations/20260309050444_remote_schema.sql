alter table "public"."generations" drop constraint "generations_status_check";

alter table "public"."generations" add column "cost" integer;

alter table "public"."generations" add column "duration" integer;

alter table "public"."generations" add column "model" text;

alter table "public"."generations" add column "output_url" text;

alter table "public"."generations" add column "prediction_id" text;

alter table "public"."generations" alter column "input_image_url" drop not null;

alter table "public"."generations" add constraint "generations_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'succeeded'::text, 'failed'::text, 'waiting'::text]))) not valid;

alter table "public"."generations" validate constraint "generations_status_check";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  insert into public.profiles (id, credits)
  values (new.id, 25);
  return new;
end;
$function$
;


  create policy "Users can update generated videos."
  on "storage"."objects"
  as permissive
  for update
  to public
using (((bucket_id = 'generated_videos'::text) AND (auth.role() = 'authenticated'::text)));



