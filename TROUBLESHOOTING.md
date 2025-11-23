# Sql-buns-migrate Troubleshooting Guide

Diagnostics and Manual Migration Repair guide

This document provides guidance for resolving schema inconsistencies, migration issues, and advanced debugging scenarios within the migration system. It is intended for developers who understand SQL, database schema design, and the internal workings of this migration tool.

---

## 1. Overview

Under normal circumstances, developers "should" not need to modify:

- Migration SQL files
- The schema snapshot file
- The migration history table

However, tools aren't perfect. In rare cases - especially in complex schemas, inspectdb and generated files may require manual correction.

This guide describes the _safe, approved_ process for performing such corrections.

---

## 2. Critical Rule: Fix Files Before Running `migrate up`

#### ⚠️ Manual changes to migration files or snapshots **must be completed _before_** executing the `buns-migrate up` command

Once `buns-migrate up` runs:

- The system computes and stores a migration checksum.
- The migration is considered canonical and immutable.
- Any later edits will cause checksum mismatches and break migration consistency.

**After a migration has been applied, do NOT modify its SQL or the snapshot.**

---

## 3. When Manual Repair Is Needed

You may need to intervene manually if:

- `inspectdb` produces incorrect field types or defaults
- ENUM / CHECK constraints require custom tuning
- Complex relations produce incomplete or incorrect SQL
- A partial migration breaks in the middle
- Conflicts arise between snapshot and actual database schema
- The database state differs from the migration history

If you must intervene, follow the workflow below.

---

## 4. Manual Repair Workflow

#### Step 1: Generate the migration

Your unmigrated files should look like this:

- `xxxx_migration.sql`
- xxxx_migration.js

#### Step 2: Review the generated files

Inspect and Check for:

- Incorrect column types,
- Wrong or missing defaults,
- Incorrect or missing foreign keys,
- ENUM definitions that need adjustment,
- SQLite CHECK constraints that require tuning,
- VARCHAR length issues (e.g., varchar(25) → varchar(50)), etc.

#### Step 3 — Apply manual fixes as needed

#### Step 4 — Only after validation, apply the migration

```bash
buns-migrate up
```

This step finalizes the migration and writes the checksum.

---

### You may need manual repair if you see:

- “Checksum mismatch” : This means a migration file was edited after it was executed.
- Snapshot out of sync.
- Cannot drop table referenced by trigger: There is a trigger pointing to the table being rebuilt.

---

Here is an improved, safer, clearer version — with correct warnings about **`migrate down` being unsafe for inspectdb-generated baselines**, plus better structure and guidance:

---

## Post-Migration Recovery Options

If you ran **`buns-migrate up`** _before fixing the generated migration or snapshot files_, here are the safe recovery paths.

> ⚠️ **Important:** > _Do NOT rely on `buns-migrate down` to undo InspectDB baseline migrations._
> InspectDB-generated migrations reflect your _current_ live database — rolling them back may corrupt the schema or cause irreversible data loss.

---

#### Option A — _Safely revert using a database backup_ (Recommended)

If you took a database backup or snapshot (recommended before structural changes):

1. Restore from backup
2. Fix your migration or snapshot files
3. Run the inspect command again

---

#### Option B — Drop & recreate the database (Development-only)

> 🔥 **Only use in development environments.**
> This will permanently remove all data.

If your setup is local and disposable:

---

#### Option C — Manually clean migration history (Advanced Users Only)

> ⚠️ **Very high risk.**
> Only attempt this if you fully understand your schema.

You may:

1. Open the migration history table (`_buns_migrations` or your system equivalent).
2. Remove the last migration entry.
3. Restore/edit the snapshot file.
4. Correct the migration SQL manually.
5. Run `buns-migrate up`

---

#### Option D — Manually reverse the migration using SQL (Experts)

If no backup exists and you cannot drop the database:

- Inspect the "down" SQL in your migration file
- Apply the reverse changes manually
- Fix the schema snapshot
- Regenerate or correct the migration SQL by hand

> Use with extreme caution.
> A mistake here can permanently corrupt data.
