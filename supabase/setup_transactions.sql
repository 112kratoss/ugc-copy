-- 1. Create transactions table if not exists
create table if not exists public.transactions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references auth.users not null,
  razorpay_order_id text unique not null,
  razorpay_payment_id text,
  amount int not null,
  credits int not null,
  status text not null check (status in ('created', 'success', 'failed')),
  created_at timestamp with time zone default timezone('utc'::text, now()) not null,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 2. Enable RLS
alter table public.transactions enable row level security;

-- 3. Create policies
create policy "Users can view their own transactions." on public.transactions
  for select using (auth.uid() = user_id);

-- Depending on your backend API approach (if using service_role key, these might not be strictly needed for inserts)
create policy "Users can insert their own transactions." on public.transactions
  for insert with check (auth.uid() = user_id);

create policy "Users can update their own transactions." on public.transactions
  for update using (auth.uid() = user_id);

-- 4. Create RPC to add credits safely upon payment success
create or replace function public.add_credits(
  p_user_id uuid,
  p_credits int,
  p_transaction_id uuid,
  p_payment_id text
)
returns boolean
language plpgsql
security definer
as $$
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
$$;
