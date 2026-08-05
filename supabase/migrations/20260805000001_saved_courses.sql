-- A user's saved course library, so it follows them the way rounds and players
-- do. Before this, saving a course meant saving it ON THAT DEVICE: `pull()`
-- restored round_archives and players and nothing else, so clearing storage or
-- signing in on a second phone brought the rounds back and left the library
-- empty (MAI-76).
--
-- DATA IS SHARED, MEMBERSHIP IS OWNED. `courses` holds the scorecard — the same
-- card serves everyone who plays there, so it has no owner. This table holds
-- the other fact: which courses are YOURS. That one is owned, has to follow you
-- between devices, and must not leak to whoever signs in on your phone next.
--
-- WHY THE COURSE DATA IS COPIED IN, rather than a foreign key to `courses`:
-- `courses` is the shared DISCOVERY library — the bulk API import plus courses
-- users chose to publish. It is NOT a superset of what people save. A course
-- found through the live OpenGolfAPI is cached locally and never upserted here
-- (only source:'user' is published, see outbox.ts), so most saved courses have
-- no row to point at and an FK would reject them outright. Same split that lets
-- a round keep its own `courseSnapshot`.
--
-- course_id IS TEXT, NOT UUID. Not every course id is a UUID: GolfCourseAPI
-- imports mint namespaced ids (`gca:9`) so they can never collide with a
-- library UUID, and they are stored verbatim. A uuid column rejects those
-- outright — and since the ids come from providers, it is not ours to promise
-- a format.
create table saved_courses (
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (user_id, course_id)
);

alter table saved_courses enable row level security;

-- Same rule as round_archives and players: your rows, nobody else's. One
-- policy for all commands — there is no sharing story here, and a saved library
-- is not something another user may read.
create policy saved_courses_own on saved_courses
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- No separate index on user_id: the primary key is (user_id, course_id) and its
-- btree already leads on user_id, which is the only way this table is queried.
-- (players_user_idx exists because that table's PK is `id` alone.)
