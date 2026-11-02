-- Account Settings page: a user edits their own display name and phone (on every worker profile linked to
-- their login, and as the owner name of the business they own). Email changes go through Supabase Auth;
-- sync_my_email copies the confirmed address to their worker profiles.

create or replace function public.update_my_account(p_name text, p_phone text) returns void
language plpgsql security definer set search_path = public as $$
declare n text := nullif(trim(p_name), ''); ph text := nullif(trim(p_phone), ''); d text;
begin
  if auth.uid() is null then raise exception 'Please log in again.'; end if;
  if n is not null and length(n) > 60 then raise exception 'Use a name of 60 characters or fewer.'; end if;
  d := regexp_replace(coalesce(ph, ''), '\D', '', 'g');
  if ph is not null and length(d) < 7 then raise exception 'That phone number looks too short.'; end if;
  if d <> '' and exists (select 1 from employees where phone_digits = d and user_id is distinct from auth.uid() and user_id is not null) then
    raise exception 'That phone number is already used by another login.';
  end if;
  update employees set name = coalesce(n, name), phone = ph where user_id = auth.uid();
  update organizations set owner_name = coalesce(n, owner_name) where owner_id = auth.uid();
end $$;
revoke execute on function public.update_my_account(text, text) from public, anon;
grant execute on function public.update_my_account(text, text) to authenticated;

create or replace function public.sync_my_email() returns void
language sql security definer set search_path = public as $$
  update employees e set email = u.email
  from auth.users u
  where u.id = auth.uid() and e.user_id = u.id and e.email is distinct from u.email
$$;
revoke execute on function public.sync_my_email() from public, anon;
grant execute on function public.sync_my_email() to authenticated;
