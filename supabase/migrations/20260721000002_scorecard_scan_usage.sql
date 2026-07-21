-- Per-user daily cap for the scorecard-scan Edge Function. Each scan spends
-- money on the vision API, and the public anon key can reach the function, so
-- the function gates on a real signed-in user AND caps calls per user per day
-- via this table. Only the Edge Function (service role) touches it — RLS is on
-- with no policies, so clients get nothing.

create table scan_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  count int not null default 0,
  primary key (user_id, day)
);

alter table scan_usage enable row level security;
-- (no policies: only the service role, which bypasses RLS, may read/write)

-- Atomic increment-and-return so the function can decide before spending money:
-- returns the running count for (user, today) including this call.
create or replace function increment_scan_usage(uid uuid)
returns int
language sql
security definer
set search_path = public
as $$
  insert into scan_usage (user_id, day, count)
  values (uid, current_date, 1)
  on conflict (user_id, day) do update set count = scan_usage.count + 1
  returning count;
$$;

-- The function is called only by the service role from the Edge Function.
revoke all on function increment_scan_usage(uuid) from public, anon, authenticated;
