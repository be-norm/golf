-- Account-deletion archive + scheduled purge.
--
-- Deleting an account hard-deletes the auth user, which frees the email address
-- immediately (auth.users has a unique constraint on it) so the person can sign
-- straight back up with the same address. Everything owned cascades away with
-- that row, so the only way to offer a grace period is to copy the data out
-- FIRST, into a table that does not reference auth.users.
--
-- Retention is bounded and disclosed, not indefinite. App Store guideline
-- 5.1.1(v) accepts deletion that "takes time to complete" as long as the user is
-- told how long, but is explicit that only deactivating an account is
-- insufficient — so the purge below is what makes this compliant, not optional
-- garnish. The delete confirmation tells the user about the 30-day window.

create table deleted_account_archives (
  -- The old uid. Not a foreign key: the auth user is gone by the time this row
  -- is read, and a reference would have cascaded the archive away with it.
  original_user_id uuid primary key,
  email text not null,
  deleted_at timestamptz not null default now(),
  -- { rounds: [{ round_id, data }], players: [ ... ] } — the same shapes the
  -- app already pushes, so reinstating is a re-key onto the new uid rather than
  -- a schema translation.
  payload jsonb not null
);

create index deleted_account_archives_email_idx on deleted_account_archives (email);
create index deleted_account_archives_deleted_at_idx on deleted_account_archives (deleted_at);

-- RLS on with NO policies: this table holds the personal data of people who
-- asked to be forgotten, and nothing reachable with the anon key should ever
-- read it. Only the service role (which bypasses RLS) touches it — the
-- delete-account function writing, and an admin reinstating by hand.
alter table deleted_account_archives enable row level security;

revoke all on deleted_account_archives from anon, authenticated;

comment on table deleted_account_archives is
  'Deleted accounts, retained 30 days so an admin can reinstate an accidental deletion. Purged by cron; never expose to anon/authenticated.';

-- Scheduled purge. Without this the table is an indefinite store of deleted
-- users'' data, which is the "deactivate instead of delete" pattern Apple names
-- as insufficient — and a right-to-erasure problem independently of the store.
create extension if not exists pg_cron;

select cron.schedule(
  'purge-deleted-account-archives',
  '17 3 * * *',
  $$delete from deleted_account_archives where deleted_at < now() - interval '30 days'$$
);
