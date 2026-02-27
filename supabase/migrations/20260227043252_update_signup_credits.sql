create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, credits)
  values (new.id, 25); -- Give 25 free credits on signup
  return new;
end;
$$ language plpgsql security definer;
