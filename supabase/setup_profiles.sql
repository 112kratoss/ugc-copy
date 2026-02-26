-- 1. Create profiles table if not exists
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade not null primary key,
  credits int default 0,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 2. Enable RLS
alter table public.profiles enable row level security;

-- 3. Create policies
create policy "Public profiles are viewable by everyone." on public.profiles
  for select using (true);

create policy "Users can update own profile." on public.profiles
  for update using (auth.uid() = id);

-- 4. Create a trigger to create a profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, credits)
  values (new.id, 25); -- Give 25 free credits on signup
  return new;
end;
$$ language plpgsql security definer;

-- Trigger the function every time a user is created
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- 5. Backfill for existing users (run once)
insert into public.profiles (id, credits)
select id, 100 -- Give 100 credits to existing users for testing
from auth.users
where id not in (select id from public.profiles);

-- 6. Recreate deduct_credits function
create or replace function deduct_credits(p_user_id uuid, p_cost int)
returns int
language plpgsql
security definer
as $$
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
$$;
