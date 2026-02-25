drop extension if exists "pg_net";


  create table "public"."generations" (
    "id" uuid not null default gen_random_uuid(),
    "user_id" uuid,
    "template_id" uuid,
    "status" text default 'pending'::text,
    "input_image_url" text not null,
    "output_video_url" text,
    "replicate_prediction_id" text,
    "error_message" text,
    "created_at" timestamp with time zone default now(),
    "completed_at" timestamp with time zone,
    "actual_cost" integer
      );


alter table "public"."generations" enable row level security;


  create table "public"."profiles" (
    "id" uuid not null,
    "credits" integer default 0,
    "created_at" timestamp with time zone not null default timezone('utc'::text, now())
      );


alter table "public"."profiles" enable row level security;


  create table "public"."templates" (
    "id" uuid not null default gen_random_uuid(),
    "name" text not null,
    "description" text,
    "video_url" text not null,
    "thumbnail_url" text,
    "category" text default 'general'::text,
    "is_active" boolean default true,
    "created_at" timestamp with time zone default now()
      );


alter table "public"."templates" enable row level security;


  create table "public"."transactions" (
    "id" uuid not null default gen_random_uuid(),
    "user_id" uuid not null,
    "razorpay_order_id" text not null,
    "razorpay_payment_id" text,
    "amount" integer not null,
    "credits" integer not null,
    "status" text not null,
    "created_at" timestamp with time zone not null default timezone('utc'::text, now()),
    "updated_at" timestamp with time zone not null default timezone('utc'::text, now())
      );


alter table "public"."transactions" enable row level security;

CREATE UNIQUE INDEX generations_pkey ON public.generations USING btree (id);

CREATE INDEX idx_generations_status ON public.generations USING btree (status);

CREATE INDEX idx_generations_user_id ON public.generations USING btree (user_id);

CREATE UNIQUE INDEX profiles_pkey ON public.profiles USING btree (id);

CREATE UNIQUE INDEX templates_pkey ON public.templates USING btree (id);

CREATE UNIQUE INDEX transactions_pkey ON public.transactions USING btree (id);

CREATE UNIQUE INDEX transactions_razorpay_order_id_key ON public.transactions USING btree (razorpay_order_id);

alter table "public"."generations" add constraint "generations_pkey" PRIMARY KEY using index "generations_pkey";

alter table "public"."profiles" add constraint "profiles_pkey" PRIMARY KEY using index "profiles_pkey";

alter table "public"."templates" add constraint "templates_pkey" PRIMARY KEY using index "templates_pkey";

alter table "public"."transactions" add constraint "transactions_pkey" PRIMARY KEY using index "transactions_pkey";

alter table "public"."generations" add constraint "generations_status_check" CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text]))) not valid;

alter table "public"."generations" validate constraint "generations_status_check";

alter table "public"."generations" add constraint "generations_template_id_fkey" FOREIGN KEY (template_id) REFERENCES public.templates(id) ON DELETE SET NULL not valid;

alter table "public"."generations" validate constraint "generations_template_id_fkey";

alter table "public"."generations" add constraint "generations_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."generations" validate constraint "generations_user_id_fkey";

alter table "public"."profiles" add constraint "profiles_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."profiles" validate constraint "profiles_id_fkey";

alter table "public"."transactions" add constraint "transactions_razorpay_order_id_key" UNIQUE using index "transactions_razorpay_order_id_key";

alter table "public"."transactions" add constraint "transactions_status_check" CHECK ((status = ANY (ARRAY['created'::text, 'success'::text, 'failed'::text]))) not valid;

alter table "public"."transactions" validate constraint "transactions_status_check";

alter table "public"."transactions" add constraint "transactions_user_id_fkey" FOREIGN KEY (user_id) REFERENCES auth.users(id) not valid;

alter table "public"."transactions" validate constraint "transactions_user_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.add_credits(p_user_id uuid, p_credits integer, p_transaction_id uuid, p_payment_id text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  txn_status text;
begin
  -- First, check the transaction status to prevent double-crediting
  select status into txn_status
  from transactions
  where id = p_transaction_id and user_id = p_user_id;

  if txn_status = 'success' then
    -- Already credited
    return false;
  end if;

  if txn_status = 'created' then
    -- Update transaction status
    update transactions
    set status = 'success',
        razorpay_payment_id = p_payment_id,
        updated_at = timezone('utc'::text, now())
    where id = p_transaction_id;

    -- Update user credits
    update profiles
    set credits = credits + p_credits
    where id = p_user_id;

    return true;
  end if;

  return false;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.deduct_credits(p_user_id uuid, p_cost integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
declare
  current_credits int;
begin
  -- Check if user has enough credits
  select credits into current_credits
  from profiles
  where id = p_user_id;

  if current_credits >= p_cost then
    -- Deduct credits
    update profiles
    set credits = credits - p_cost
    where id = p_user_id;
    
    return current_credits - p_cost;
  else
    return -1; -- Insufficient credits
  end if;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
begin
  insert into public.profiles (id, credits)
  values (new.id, 50); -- Give 50 free credits on signup
  return new;
end;
$function$
;

grant delete on table "public"."generations" to "anon";

grant insert on table "public"."generations" to "anon";

grant references on table "public"."generations" to "anon";

grant select on table "public"."generations" to "anon";

grant trigger on table "public"."generations" to "anon";

grant truncate on table "public"."generations" to "anon";

grant update on table "public"."generations" to "anon";

grant delete on table "public"."generations" to "authenticated";

grant insert on table "public"."generations" to "authenticated";

grant references on table "public"."generations" to "authenticated";

grant select on table "public"."generations" to "authenticated";

grant trigger on table "public"."generations" to "authenticated";

grant truncate on table "public"."generations" to "authenticated";

grant update on table "public"."generations" to "authenticated";

grant delete on table "public"."generations" to "service_role";

grant insert on table "public"."generations" to "service_role";

grant references on table "public"."generations" to "service_role";

grant select on table "public"."generations" to "service_role";

grant trigger on table "public"."generations" to "service_role";

grant truncate on table "public"."generations" to "service_role";

grant update on table "public"."generations" to "service_role";

grant delete on table "public"."profiles" to "anon";

grant insert on table "public"."profiles" to "anon";

grant references on table "public"."profiles" to "anon";

grant select on table "public"."profiles" to "anon";

grant trigger on table "public"."profiles" to "anon";

grant truncate on table "public"."profiles" to "anon";

grant update on table "public"."profiles" to "anon";

grant delete on table "public"."profiles" to "authenticated";

grant insert on table "public"."profiles" to "authenticated";

grant references on table "public"."profiles" to "authenticated";

grant select on table "public"."profiles" to "authenticated";

grant trigger on table "public"."profiles" to "authenticated";

grant truncate on table "public"."profiles" to "authenticated";

grant update on table "public"."profiles" to "authenticated";

grant delete on table "public"."profiles" to "service_role";

grant insert on table "public"."profiles" to "service_role";

grant references on table "public"."profiles" to "service_role";

grant select on table "public"."profiles" to "service_role";

grant trigger on table "public"."profiles" to "service_role";

grant truncate on table "public"."profiles" to "service_role";

grant update on table "public"."profiles" to "service_role";

grant delete on table "public"."templates" to "anon";

grant insert on table "public"."templates" to "anon";

grant references on table "public"."templates" to "anon";

grant select on table "public"."templates" to "anon";

grant trigger on table "public"."templates" to "anon";

grant truncate on table "public"."templates" to "anon";

grant update on table "public"."templates" to "anon";

grant delete on table "public"."templates" to "authenticated";

grant insert on table "public"."templates" to "authenticated";

grant references on table "public"."templates" to "authenticated";

grant select on table "public"."templates" to "authenticated";

grant trigger on table "public"."templates" to "authenticated";

grant truncate on table "public"."templates" to "authenticated";

grant update on table "public"."templates" to "authenticated";

grant delete on table "public"."templates" to "service_role";

grant insert on table "public"."templates" to "service_role";

grant references on table "public"."templates" to "service_role";

grant select on table "public"."templates" to "service_role";

grant trigger on table "public"."templates" to "service_role";

grant truncate on table "public"."templates" to "service_role";

grant update on table "public"."templates" to "service_role";

grant delete on table "public"."transactions" to "anon";

grant insert on table "public"."transactions" to "anon";

grant references on table "public"."transactions" to "anon";

grant select on table "public"."transactions" to "anon";

grant trigger on table "public"."transactions" to "anon";

grant truncate on table "public"."transactions" to "anon";

grant update on table "public"."transactions" to "anon";

grant delete on table "public"."transactions" to "authenticated";

grant insert on table "public"."transactions" to "authenticated";

grant references on table "public"."transactions" to "authenticated";

grant select on table "public"."transactions" to "authenticated";

grant trigger on table "public"."transactions" to "authenticated";

grant truncate on table "public"."transactions" to "authenticated";

grant update on table "public"."transactions" to "authenticated";

grant delete on table "public"."transactions" to "service_role";

grant insert on table "public"."transactions" to "service_role";

grant references on table "public"."transactions" to "service_role";

grant select on table "public"."transactions" to "service_role";

grant trigger on table "public"."transactions" to "service_role";

grant truncate on table "public"."transactions" to "service_role";

grant update on table "public"."transactions" to "service_role";


  create policy "Users can create own generations"
  on "public"."generations"
  as permissive
  for insert
  to public
with check ((auth.uid() = user_id));



  create policy "Users can insert their own generations."
  on "public"."generations"
  as permissive
  for insert
  to public
with check ((auth.uid() = user_id));



  create policy "Users can update own generations"
  on "public"."generations"
  as permissive
  for update
  to public
using ((auth.uid() = user_id));



  create policy "Users can update their own generations."
  on "public"."generations"
  as permissive
  for update
  to public
using ((auth.uid() = user_id));



  create policy "Users can view own generations"
  on "public"."generations"
  as permissive
  for select
  to public
using ((auth.uid() = user_id));



  create policy "Users can view their own generations."
  on "public"."generations"
  as permissive
  for select
  to public
using ((auth.uid() = user_id));



  create policy "Public profiles are viewable by everyone."
  on "public"."profiles"
  as permissive
  for select
  to public
using (true);



  create policy "Users can update own profile."
  on "public"."profiles"
  as permissive
  for update
  to public
using ((auth.uid() = id));



  create policy "Templates are viewable by everyone"
  on "public"."templates"
  as permissive
  for select
  to public
using ((is_active = true));



  create policy "Users can insert their own transactions."
  on "public"."transactions"
  as permissive
  for insert
  to public
with check ((auth.uid() = user_id));



  create policy "Users can update their own transactions."
  on "public"."transactions"
  as permissive
  for update
  to public
using ((auth.uid() = user_id));



  create policy "Users can view their own transactions."
  on "public"."transactions"
  as permissive
  for select
  to public
using ((auth.uid() = user_id));


CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


  create policy "Anyone can view generated videos."
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'generated_videos'::text));



  create policy "Public insert access"
  on "storage"."objects"
  as permissive
  for insert
  to public
with check ((bucket_id = 'uploads'::text));



  create policy "Public read access"
  on "storage"."objects"
  as permissive
  for select
  to public
using ((bucket_id = 'uploads'::text));



  create policy "Users can upload generated videos."
  on "storage"."objects"
  as permissive
  for insert
  to public
with check (((bucket_id = 'generated_videos'::text) AND (auth.role() = 'authenticated'::text)));



