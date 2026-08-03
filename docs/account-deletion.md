# Account deletion and reinstatement

How deletion works, and the runbook for undoing an accidental one.

## What happens on delete

1. The `delete-account` Edge Function copies the user's `round_archives` and `players`
   rows into `deleted_account_archives`, keyed by their old uid and stamped with their
   email. That table has **no foreign key to `auth.users`**, which is what lets it survive
   the next step.
2. The auth user is **hard**-deleted. Everything owned cascades away with it
   (`round_archives`, `players`, `scan_usage`). Published courses survive — `courses.created_by`
   is `on delete set null`, so the shared library isn't collateral damage.
3. The client wipes this device's copy of that user's rows and signs out.
4. A nightly `pg_cron` job purges archives older than **30 days**.

Two consequences worth internalising:

- **The email frees up immediately.** `auth.users` has a unique constraint on email, and the
  row is gone, so the person can sign straight back up with the same address. They get a
  **new uid** — reinstatement is a re-key, never a restore-in-place.
- **Archiving is best-effort.** If the copy fails, the deletion still proceeds. The user asked
  to be deleted; a snapshot kept for our convenience must not be able to block that. The cost
  of a failed archive is the undo, not the deletion.

Supabase's built-in soft delete is deliberately **not** used: it SHA256-hashes the email and
is documented as "not reversible", so it would block re-signup while destroying exactly the
data reinstatement needs.

## Why bounded retention, not indefinite

App Store guideline 5.1.1(v) accepts deletion that "takes time to complete" as long as the
user is told how long — which the delete confirmation does. But it is explicit that
*"only offering to temporarily deactivate or disable an account is insufficient."*

So the purge job is the part that makes this compliant. Keeping archives indefinitely so an
admin could always reinstate would be deactivation wearing deletion's clothes, and a
right-to-erasure problem independently of the App Store. **If you ever disable the cron job,
you have broken compliance, not just tidiness.**

## Runbook: reinstate an accidental deletion

Only possible within 30 days, and only via the SQL editor with service-role access —
`deleted_account_archives` has RLS on with no policies, so nothing client-side can read it.

**1. Find the archive.** You need the email they used.

```sql
select original_user_id, email, deleted_at,
       jsonb_array_length(payload->'rounds')  as rounds,
       jsonb_array_length(payload->'players') as players
from deleted_account_archives
where email = 'them@example.com';
```

No row means it was purged, or the archive failed, or they never had synced data. Nothing to
recover in any of those cases — say so plainly rather than implying it might turn up.

**2. Get their new uid.** They must have signed up again first.

```sql
select id, email from auth.users where email = 'them@example.com';
```

**3. Re-key the rounds onto the new uid.**

```sql
insert into round_archives (user_id, round_id, data, updated_at)
select '<NEW_UID>', (r->>'round_id')::uuid, r->'data', now()
from deleted_account_archives a,
     jsonb_array_elements(a.payload->'rounds') r
where a.email = 'them@example.com'
on conflict (user_id, round_id) do nothing;
```

**4. Re-key the roster.** New ids, because the originals are gone and a collision with rows
they've since created would be worse than a duplicate.

```sql
insert into players (id, user_id, name, handicap_index, last_course_handicap, updated_at)
select gen_random_uuid(), '<NEW_UID>', p->>'name',
       (p->>'handicap_index')::numeric, (p->>'last_course_handicap')::int, now()
from deleted_account_archives a,
     jsonb_array_elements(a.payload->'players') p
where a.email = 'them@example.com';
```

**5. Have them pull.** Signing out and back in triggers `syncNow`, which pulls the restored
rows down. Confirm with them that their rounds are actually back before closing it out.

**6. Delete the archive row**, so the restored data isn't also sitting in a PII table waiting
on the purge.

```sql
delete from deleted_account_archives where email = 'them@example.com';
```

## Making this self-serve

Tracked as MAI-30 in Future Enhancements. The blocker is not the restore logic — it's that
`enable_confirmations = false`, so signing up does not prove control of an address. Keying a
restore on email alone would hand anyone who knows a deleted user's address their round
history. Self-serve therefore requires emailing a code at the moment of restore, which in turn
needs real SMTP (`[auth.email.smtp]` is commented out; the built-in service is capped at 2
emails/hour). The manual runbook above has none of that exposure, because you verify the
person out-of-band.
