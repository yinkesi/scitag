-- Replace __SCITAG_SECRET_SHA256__ with the SHA256 hex digest of a random server-only
-- SCITAG_DATABASE_SECRET. Never use an account password or Supabase service-role key.
begin;
create table public.scitag_state (
  id integer primary key check (id = 1),
  revision bigint not null default 0,
  state jsonb,
  secret_digest text not null,
  updated_at timestamptz not null default now()
);
alter table public.scitag_state enable row level security;
revoke all on public.scitag_state from anon, authenticated;
insert into public.scitag_state(id, secret_digest) values (1, '__SCITAG_SECRET_SHA256__');

-- Intentional server capability boundary: clients have no row access and cannot use
-- these two RPCs without the separate 256-bit server secret. No Supabase user JWT is
-- involved; SciTag's existing per-agent credentials are checked by the Vercel API.
create function public.scitag_read(p_secret text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  select jsonb_build_object('revision', revision, 'state', state) into result
  from public.scitag_state where id = 1
    and secret_digest = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex');
  if result is null then raise exception 'Access denied' using errcode = '42501'; end if;
  return result;
end;
$$;

create function public.scitag_commit(p_secret text, p_revision bigint, p_state jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from public.scitag_state where id = 1
    and secret_digest = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')) then
    raise exception 'Access denied' using errcode = '42501';
  end if;
  if p_state is null or jsonb_typeof(p_state) is distinct from 'object' or not (p_state ? 'agents' and p_state ? 'tasks') then
    raise exception 'Invalid state';
  end if;
  update public.scitag_state set state = p_state, revision = revision + 1, updated_at = now()
    where id = 1 and revision = p_revision;
  return found;
end;
$$;
revoke all on function public.scitag_read(text) from public, anon, authenticated;
revoke all on function public.scitag_commit(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.scitag_read(text) to anon;
grant execute on function public.scitag_commit(text, bigint, jsonb) to anon;
commit;
