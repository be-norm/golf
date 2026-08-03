-- Schedule the archive purge with pg_cron.
--
-- Split from the migration that creates the table on purpose. pg_cron needs a
-- background worker and is not guaranteed on every Supabase plan; if this
-- migration fails, the archive table and the purge function from
-- 20260803000001 are already applied and the app keeps working. The scheduled
-- GitHub Action (.github/workflows/purge-archives.yml) is the fallback trigger
-- and calls the same function, so retention is enforced either way.
--
-- If this migration fails on your project: that is expected and survivable, but
-- you MUST confirm the GitHub Action is running. Without one of the two, nothing
-- purges, retention becomes indefinite, and the deletion flow silently becomes
-- the "deactivate instead of delete" pattern App Store guideline 5.1.1(v) names
-- as insufficient. Running both is harmless -- the second run just purges zero
-- rows.

create extension if not exists pg_cron;

-- Named, so re-running this migration reschedules rather than duplicating.
select cron.schedule(
  'purge-deleted-account-archives',
  '17 3 * * *',
  $$select purge_deleted_account_archives()$$
);
