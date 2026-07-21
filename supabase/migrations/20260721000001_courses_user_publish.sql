-- User-published courses: let signed-in users contribute courses they authored
-- (manual entry or scorecard scan) to the shared, publicly-readable library, so
-- a course one person adds (e.g. a small muni no API carries) is available to
-- everyone. Attribution lives in created_by; the app badges these "user-added"
-- to set the unverified expectation. Courses stay global/shared — the existing
-- read policy (anon + authenticated, status='published') is unchanged.

alter table courses
  add column created_by uuid references auth.users (id) on delete set null;

-- A signed-in user may publish their OWN user-sourced courses. The check pins
-- created_by to the caller and forbids inserting seed/API rows or draft rows.
create policy courses_user_insert on courses
  for insert to authenticated
  with check (auth.uid() = created_by and source = 'user' and status = 'published');

-- ...and re-publish edits to rows they created. created_by guards both sides, so
-- a user can never overwrite a seed/API row or another user's row. (The bulk
-- importer runs as the service role and bypasses RLS, so it is unaffected.)
create policy courses_user_update on courses
  for update to authenticated
  using (auth.uid() = created_by)
  with check (auth.uid() = created_by and source = 'user');
