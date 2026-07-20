-- Auth ownership: owner-scope round backups, add a synced roster, and keep the
-- shared course library readable once users sign in. Paired with app auth
-- (Supabase email/password + Google). Apply BEFORE the auth code deploys.

-- Signed-in requests hit PostgREST as the `authenticated` role; the original
-- SELECT policy grants only `anon`, so without this a logged-in user would see
-- ZERO courses. Courses stay a public, shared library — grant both roles.
drop policy anon_read_published_courses on courses;
create policy read_published_courses on courses
  for select to anon, authenticated using (status = 'published');

-- round_archives becomes owner-scoped and readable (was an anon write-only
-- dropbox). One canonical row per (owner, round): re-archives update it in
-- place, deletes tombstone it so other devices converge on the next pull.
alter table round_archives
  add column user_id uuid references auth.users (id) on delete cascade,
  add column updated_at timestamptz not null default now(),
  add column deleted_at timestamptz;

-- Orphaned pre-auth rows (device_id only, no owner) are superseded by the
-- owner's re-push from local Dexie on first claim — drop them so (user_id,
-- round_id) can become the primary key.
delete from round_archives where user_id is null;

-- Make (user_id, round_id) the identity. The old surrogate `id` PK is dropped:
-- keeping it would let a cross-account re-push of the SAME round.id (a friend
-- importing an exported round, then claiming) collide on the `id` PK instead of
-- upserting on (user_id, round_id) — a silent, permanent push failure.
alter table round_archives
  drop constraint round_archives_pkey,
  drop column id,
  alter column user_id set not null,
  add primary key (user_id, round_id);

drop policy anon_insert_archives on round_archives;
create policy round_archives_owner_rw on round_archives
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Synced roster: one row per saved golfer, owner-scoped, soft-deletable so a
-- delete on one device propagates instead of being re-added on the next pull.
create table players (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  handicap_index numeric,
  last_course_handicap int,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index players_user_idx on players (user_id);

alter table players enable row level security;

create policy players_owner_rw on players
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
