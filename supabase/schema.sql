-- Sides — cross-device sync, the whole server side.
--
-- This file exists because it did not. The original project was set up by
-- pasting SQL into the dashboard and nothing recorded what was pasted, so when
-- the free-tier project was eventually deleted there was no way to rebuild it
-- without reverse-engineering the client. Keep this in step with index.html.
--
-- SECURITY MODEL
-- The publishable key ships inside index.html in a public repo, so it must be
-- assumed public. The table is therefore unreachable with it: RLS is on and no
-- policy grants access, and the privileges are revoked besides. The only doors
-- are the two SECURITY DEFINER functions below, and both demand the sync code.
-- The sync code is the secret.

create table if not exists public.sync_state (
  code       text primary key,
  blob       jsonb       not null,
  updated_at timestamptz not null default now()
);

alter table public.sync_state enable row level security;

-- deliberately NO policies: with RLS on and nothing granted, anon and
-- authenticated can read nothing, even though the key is public
revoke all on public.sync_state from anon, authenticated;

-- Returns a row set. The client reads r.data[0].updated_at / .blob, so this
-- must stay `returns table`, not a scalar or a composite.
create or replace function public.sync_pull(p_code text)
returns table (updated_at timestamptz, blob jsonb)
language sql
security definer
set search_path = public
as $$
  select s.updated_at, s.blob
    from public.sync_state s
   where s.code = p_code
     and length(p_code) >= 20;          -- never match on a short or empty code
$$;

-- Returns the new timestamp as a scalar. The client assigns r.data straight to
-- lastTs, so this must stay a scalar, not a row set.
create or replace function public.sync_push(p_code text, p_blob jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare ts timestamptz;
begin
  if length(p_code) < 20 then
    raise exception 'sync code too short';
  end if;
  insert into public.sync_state as s (code, blob, updated_at)
       values (p_code, p_blob, now())
  on conflict (code) do update
          set blob = excluded.blob, updated_at = now()
    returning s.updated_at into ts;
  return ts;
end;
$$;

grant execute on function public.sync_pull(text)        to anon, authenticated;
grant execute on function public.sync_push(text, jsonb) to anon, authenticated;

-- AUDIO
-- Clips are content-addressed and stored at {syncCode}/{clipKey}.mp3. The
-- bucket is public to READ, which is what serves /object/public/..., but it
-- must never be listable: an unguessable code is the only thing keeping one
-- person's audio separate from another's.
insert into storage.buckets (id, name, public)
     values ('sides-audio', 'sides-audio', true)
on conflict (id) do update set public = true;

-- Upload only. Do NOT add a select policy on storage.objects: that would let
-- anyone enumerate the bucket and discover sync codes.
drop policy if exists "sides-audio insert" on storage.objects;
create policy "sides-audio insert"
    on storage.objects for insert
    to anon, authenticated
    with check (bucket_id = 'sides-audio');
