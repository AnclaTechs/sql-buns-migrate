import { pool } from "@anclatechs/sql-buns";
import chalk from "chalk";

export async function rebuildTableForSqlite(
  table,
  oldFields,
  newFields,
  newModel,
  renames = [],
  _generateCreateTableSQL,
  sql = [],
  reverseSQL = [],
  warnings = []
) {
  // Check for other tables reference this table via FOREIGN KEY
  const referencing = await pool.all(
    `SELECT tbl_name, sql
   FROM sqlite_master
   WHERE type='table' AND sql LIKE '%REFERENCES ${table}%'`
  );

  if (referencing.length > 0) {
    const deps = referencing.map((r) => r.tbl_name).join(", ");
    console.error(
      chalk.red(
        `Cannot rebuild table "${table}" because it is referenced by other tables: [${deps}]. ` +
          `You must drop or rebuild those tables first.`
      )
    );
    process.exit();
  }

  // Check for other tables have triggers referencing this table
  const referencingTriggers = await pool.all(
    `SELECT name, tbl_name
   FROM sqlite_master
   WHERE type='trigger' AND sql LIKE '%' || ? || '%'`,
    [table]
  );

  if (referencingTriggers.length > 0) {
    const triggerInfo = referencingTriggers
      .map((t) => `${t.name} (on ${t.tbl_name})`)
      .join(", ");

    console.error(
      chalk.red(
        `Cannot rebuild table "${table}" because it is referenced in trigger(s): [${triggerInfo}]. ` +
          `Drop or update those triggers first.`
      )
    );
    process.exit();
  }

  // 1. Generate CREATE + REVERSE statements
  const [createSQL, reverseCreateSQL] = (await _generateCreateTableSQL(
    table,
    newModel,
    [],
    [],
    [],
    true // leanSQLBuild
  )) || ["", ""];

  // 2. Adjust CREATE TABLE to use <table>_new
  const createTableRegex = new RegExp(
    `(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(["'\`]?${table}["'\`]?)`,
    "i"
  );
  const createSQLNew = createSQL.replace(createTableRegex, `$1"${table}_new"`);

  // 3. Capture triggers & indexes before dropping the old table
  const triggers = await pool.all(
    `SELECT name, sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?`,
    [table]
  );
  const indexes = await pool.all(
    `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=?`,
    [table]
  );

  // 4. Drop dependent triggers & indexes
  for (const t of triggers) sql.push(`DROP TRIGGER IF EXISTS "${t.name}";`);
  for (const i of indexes) sql.push(`DROP INDEX IF EXISTS "${i.name}";`);

  // 5. Build column mapping for data migration
  const renameMap = Object.fromEntries(renames.map((r) => [r.old, r.new]));
  const newCols = Object.keys(newFields);

  const selectExprs = newCols.map((newCol) => {
    if (oldFields[newCol]) return `"${newCol}"`;

    const oldName = Object.keys(oldFields).find((o) => renameMap[o] === newCol);
    if (oldName) return `"${oldName}"`;

    const nf = newFields[newCol];
    if (nf && nf.default !== undefined) {
      const val =
        typeof nf.default === "string"
          ? `'${nf.default.replace(/'/g, "''")}'`
          : nf.default;
      return `${val} AS "${newCol}"`;
    }

    if (nf && nf.nullable !== true) {
      warnings.push(
        `Column "${newCol}" in table "${table}" is NOT NULL but has no default. It will get NULLs.`
      );
    }

    return `NULL AS "${newCol}"`;
  });

  // 6. Rebuild forward SQL
  sql.push("PRAGMA foreign_keys=off;");
  sql.push(createSQLNew.endsWith(";") ? createSQLNew : createSQLNew + ";");

  sql.push(
    `INSERT INTO "${table}_new" (${newCols
      .map((c) => `"${c}"`)
      .join(", ")})\nSELECT ${selectExprs.join(", ")} FROM "${table}";`
  );

  sql.push(`DROP TABLE "${table}";`);
  sql.push(`ALTER TABLE "${table}_new" RENAME TO "${table}";`);

  // 7. Restore indexes and triggers
  for (const i of indexes) if (i.sql) sql.push(i.sql + ";");
  for (const t of triggers) if (t.sql) sql.push(t.sql + ";");

  sql.push("PRAGMA foreign_keys=on;");

  // 8. Build reverse SQL if available
  if (reverseCreateSQL) {
    const reverseTableRegex = new RegExp(
      `(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)(["'\`]?${table}["'\`]?)`,
      "i"
    );
    const reverseCreatesOld = reverseCreateSQL.replace(
      reverseTableRegex,
      `$1"${table}_old"`
    );

    reverseSQL.push("PRAGMA foreign_keys=off;");
    reverseSQL.push(
      reverseCreatesOld.endsWith(";")
        ? reverseCreatesOld
        : reverseCreatesOld + ";"
    );

    const oldCols = Object.keys(oldFields);
    const copyBackSelects = oldCols.map((oldCol) => {
      const renameEntry = renames.find(
        (r) => r.old === oldCol || r.new === oldCol
      );
      if (renameEntry) return `"${renameEntry.new}"`;
      if (newFields[oldCol]) return `"${oldCol}"`;

      const od = oldFields[oldCol];
      if (od && od.default !== undefined) {
        const val =
          typeof od.default === "string"
            ? `'${od.default.replace(/'/g, "''")}'`
            : od.default;
        return `${val} AS "${oldCol}"`;
      }
      return `NULL AS "${oldCol}"`;
    });

    reverseSQL.push(
      `INSERT INTO "${table}_old" (${oldCols
        .map((c) => `"${c}"`)
        .join(", ")})\nSELECT ${copyBackSelects.join(", ")} FROM "${table}";`
    );

    reverseSQL.push(`DROP TABLE "${table}";`);
    reverseSQL.push(`ALTER TABLE "${table}_old" RENAME TO "${table}";`);

    // Recreate old triggers & indexes for rollback
    for (const i of indexes) if (i.sql) reverseSQL.push(i.sql + ";");
    for (const t of triggers) if (t.sql) reverseSQL.push(t.sql + ";");

    reverseSQL.push("PRAGMA foreign_keys=on;");
  } else {
    reverseSQL.push(
      `-- Reverse rebuild for "${table}" not available: no reverse CREATE SQL generated.`
    );
  }

  return { sql, reverseSQL, warnings };
}
