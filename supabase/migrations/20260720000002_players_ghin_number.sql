-- Players added via GHIN lookup carry their GHIN number, so it round-trips
-- across devices (and enables a future "refresh handicap from GHIN"). Text,
-- not numeric — a GHIN number is an identifier, and leading zeros matter.
-- Covered by the existing players_owner_rw RLS policy (whole-row).
alter table players add column ghin_number text;
