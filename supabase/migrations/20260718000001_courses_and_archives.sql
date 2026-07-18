create extension if not exists pg_trgm;

-- Course library: full Course documents (same jsonb shape the app uses)
-- with provenance so ODbL data stays distinguishable from user submissions.
create table courses (
  id uuid primary key,
  name text not null,
  location text,
  hole_count int not null check (hole_count in (9, 18)),
  data jsonb not null,
  status text not null default 'published' check (status in ('published', 'draft')),
  source text not null default 'seed',
  source_id text,
  fetched_at timestamptz,
  revision int not null default 1,
  updated_at timestamptz not null default now()
);

create index courses_name_trgm on courses using gin (name gin_trgm_ops);
create index courses_location_idx on courses (location);
create index courses_updated_at_idx on courses (updated_at);

-- Write-only dropbox for completed-round backups: insert-only for anon
-- (nothing readable, nothing overwritable). Each archive attempt is a new
-- row keyed by its own id; round_id groups re-archives after reopens.
-- Tightens to owner-scoped policies when auth lands post-MVP.
create table round_archives (
  id uuid primary key,
  round_id uuid not null,
  device_id uuid not null,
  data jsonb not null check (pg_column_size(data) < 512 * 1024),
  created_at timestamptz not null default now()
);

create index round_archives_round_idx on round_archives (round_id);

alter table courses enable row level security;
alter table round_archives enable row level security;

create policy anon_read_published_courses on courses
  for select to anon using (status = 'published');

create policy anon_insert_archives on round_archives
  for insert to anon with check (true);
