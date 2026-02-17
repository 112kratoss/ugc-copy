-- Create a function to deduct credits safely
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
