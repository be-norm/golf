-- A user's saved course library, so it follows them the way rounds and players
-- do. Before this, saving a course meant saving it ON THAT DEVICE: `pull()`
-- restored round_archives and players and nothing else, so clearing storage or
-- signing in on a second phone brought the rounds back and left the library
-- empty (MAI-76).
--
-- WHY THE COURSE DATA IS COPIED IN, rather than a foreign key to `courses`:
-- `courses` is the shared DISCOVERY library — the bulk OpenGolfAPI import plus
-- courses users chose to publish. It is NOT a superset of what people save. A
-- course found through the live OpenGolfAPI is cached locally and never
-- upserted here (only source:'user' is published, see outbox.ts), so most saved
-- courses have no row to point at; an FK would reject them outright. Same split
-- that lets a round keep its own `courseSnapshot`: the shared table is for
-- finding courses, this is the user's own copy of what they kept.
--
-- Mirrors round_archives: (user, id) primary key, whole payload as jsonb,
-- last-write-wins on updated_at, soft delete so a removal propagates instead of
-- the row simply reappearing on the next pull.
create table saved_courses (
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null,
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

create index saved_courses_user_idx on saved_courses (user_id);
