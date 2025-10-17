import { getSingleRow } from "@anclatechs/sql-buns";
import chalk from "chalk";
import readline from "readline";

async function _tableExistsInDb(table) {
  try {
    await getSingleRow(`SELECT 1 FROM ${table} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

async function _columnExistsInDb(table, column) {
  try {
    await getSingleRow(`SELECT ${column} FROM ${table} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

function _handleMetaDiff(table, oldMeta = {}, newMeta = {}, sql = []) {
  // --- Table rename ---
  if (
    oldMeta.tableName &&
    newMeta.tableName &&
    oldMeta.tableName !== newMeta.tableName
  ) {
    sql.push(
      `ALTER TABLE ${oldMeta.tableName} RENAME TO ${newMeta.tableName};`
    );
  }

  // --- Table comment ---
  // if (oldMeta.comment !== newMeta.comment) {
  //   const commentSql = newMeta.comment
  //     ? `COMMENT ON TABLE ${table} IS '${newMeta.comment}';`
  //     : `COMMENT ON TABLE ${table} IS NULL;`;
  //   sql.push(commentSql);
  // }

  // --- Indexes ---
  const oldIndexes = oldMeta.indexes || [];
  const newIndexes = newMeta.indexes || [];

  function normalizeIndexes(indexes, table) {
    return indexes.map((idx) => {
      if (!idx.name) {
        const fieldPart = Array.isArray(idx.fields)
          ? idx.fields.join("_")
          : idx.field || "field";
        idx.name = `idx_${table}_${fieldPart}`;
      }
      return idx;
    });
  }

  const normalizedOldIndexes = normalizeIndexes(oldIndexes, table);
  const normalizedNewIndexes = normalizeIndexes(newIndexes, table);

  const oldIndexMap = Object.fromEntries(
    normalizedOldIndexes.map((i) => [i.name, i])
  );
  const newIndexMap = Object.fromEntries(
    normalizedNewIndexes.map((i) => [i.name, i])
  );

  // Add new indexes
  for (const idx of newIndexes) {
    if (!oldIndexMap[idx.name]) {
      const unique = idx.unique ? "UNIQUE " : "";
      sql.push(
        `CREATE ${unique}INDEX ${idx.name} ON ${table} (${idx.fields.join(
          ", "
        )});`
      );
    }
  }

  // Drop removed indexes
  for (const oldIdx of oldIndexes) {
    if (!newIndexMap[oldIdx.name]) {
      sql.push(`DROP INDEX IF EXISTS ${oldIdx.name};`);
    }
  }
}

/**
 * Process relations and defer if needed.
 */
export async function _handleRelationsDiff(
  table,
  oldRelations = {},
  newRelations = {},
  allNewModels = {},
  sql = []
) {
  const pendingRelations = [];

  const autoThroughName = (base, target) => `${base}_${target}_link`;

  // Inline: Decision logic as a nested helper (reusable within this scope)
  const decideRelationAction = async (rel, currentTable) => {
    const foreignTable = rel.model;
    const foreignKey = rel.foreignKey;

    const tableExists = await _tableExistsInDb(foreignTable);
    const columnExists = tableExists
      ? await _columnExistsInDb(foreignTable, foreignKey)
      : false;

    const targetInBatch = !!allNewModels[foreignTable];
    const targetDefinesField =
      targetInBatch && !!(allNewModels[foreignTable].fields || {})[foreignKey];

    if (tableExists && columnExists) {
      return { action: "createNow" };
    }

    if (targetInBatch && targetDefinesField) {
      return { action: "defer" };
    }

    if (targetInBatch && !targetDefinesField) {
      return {
        action: "error",
        error: new Error(
          `Relation error: target model "${foreignTable}" is part of the current migration but does not define field "${foreignKey}" required by relation "${currentTable}.${rel.model}".`
        ),
      };
    }

    return {
      action: "error",
      error: new Error(
        `Relation error: target table "${foreignTable}" does not exist in DB and is not part of the current migration batch (relation: ${currentTable}.${rel.model}).`
      ),
    };
  };

  // Inline: SQL generation logic (extracted for reuse in both loops)
  const createRelationSql = (rel, baseTable) => {
    if (rel.type === "hasOne" || rel.type === "hasMany") {
      return [
        `ALTER TABLE ${rel.model} ADD CONSTRAINT fk_${rel.model}_${rel.foreignKey} FOREIGN KEY (${rel.foreignKey}) REFERENCES ${baseTable}(id);`,
        `CREATE INDEX IF NOT EXISTS idx_${rel.model}_${rel.foreignKey} ON ${rel.model} (${rel.foreignKey});`,
      ];
    } else if (rel.type === "manyToMany") {
      return [
        `CREATE TABLE IF NOT EXISTS ${rel.through} (
          ${rel.foreignKey} INTEGER REFERENCES ${baseTable}(id),
          ${rel.otherKey} INTEGER REFERENCES ${rel.model}(id),
          PRIMARY KEY (${rel.foreignKey}, ${rel.otherKey})
        );`,
      ];
    }
    return [];
  };

  for (const [relName, rel] of Object.entries(newRelations)) {
    const oldRel = oldRelations[relName];
    if (JSON.stringify(oldRel) === JSON.stringify(rel)) continue;

    if (rel.type === "manyToMany" && !rel.through) {
      rel.through = autoThroughName(table, rel.model);
    }

    const { action, error } = await decideRelationAction(rel, table);

    if (error) {
      console.error(chalk.red(`❌ ${error.name}:`), error.message);
      process.exit();
    }

    if (action === "defer") {
      pendingRelations.push({ base: table, relName, rel });
      continue;
    }

    if (action === "createNow") {
      const relSql = createRelationSql(rel, table);
      sql.push(...relSql);
    }
  }

  // Inline: Process deferred relations (re-run decision tree, then create)
  // ✅ Once all tables are handled, if we have deferred ones, process them now
  if (pendingRelations.length > 0) {
    for (const { base, relName, rel } of pendingRelations) {
      const { action, error } = await decideRelationAction(rel, base);

      if (error) {
        console.error(chalk.red(`❌ ${error.name}:`), error.message);
        process.exit();
      }
      if (action !== "createNow") {
        console.error(
          chalk.red("Error"),
          `Pending relation ${base}.${relName} still cannot be created (table/field missing).`
        );
        process.exit();
      }

      // Create the now-valid relation
      const relSql = createRelationSql(rel, base);
      sql.push(...relSql);
    }

    // Clear after processing
    pendingRelations.length = 0;
  }

  return sql;
}

async function _confirmRename(table, oldCol, newCol, type, interactive = true) {
  /**
   * Prompt to confirm a column rename (interactive only)
   */

  if (!interactive) return false;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await new Promise((resolve) => {
    rl.question(
      `Did you rename "${oldCol}" to "${newCol}" (a ${type}) in table "${table}"? [y/N]: `,
      (input) => {
        rl.close();
        resolve(input.toLowerCase().startsWith("y"));
      }
    );
  });

  return answer;
}

async function _handleFieldDiff(
  table,
  oldFields = {},
  newFields = {},
  sql = [],
  warnings = [],
  options = {}
) {
  const { interactive = true } = options;

  const dropped = Object.keys(oldFields).filter((c) => !newFields[c]);
  const added = Object.keys(newFields).filter((c) => !oldFields[c]);
  const renames = [];

  // Step 1: Detect potential renames
  for (const newCol of [...added]) {
    const newDef = newFields[newCol];
    for (const oldCol of [...dropped]) {
      const oldDef = oldFields[oldCol];

      const newNullable = newDef.nullable === true;
      const oldNullable = oldDef.nullable === true;

      if (
        newDef.type === oldDef.type &&
        newNullable === oldNullable &&
        newDef.default === oldDef.default
      ) {
        const answer = await _confirmRename(
          table,
          oldCol,
          newCol,
          newDef.type,
          interactive
        );

        if (answer) {
          renames.push({ old: oldCol, new: newCol });
          sql.push(
            `ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol};`
          );
          dropped.splice(dropped.indexOf(oldCol), 1);
          added.splice(added.indexOf(newCol), 1);
          break;
        }
      }
    }
  }

  // Step 2: Drop remaining columns
  for (const col of dropped) {
    sql.push(`ALTER TABLE ${table} DROP COLUMN ${col};`);
  }

  // Step 3: Add new columns
  for (const col of added) {
    const def = newFields[col];
    const defVal =
      typeof def.default === "string" ? `'${def.default}'` : def.default;

    const nullable = def.nullable === true; // explicitly nullable
    const notNull = !nullable; // default is NOT NULL

    if (def.default === undefined && notNull) {
      warnings.push(
        `Column "${col}" in table "${table}" has no default value.`
      );
    }

    sql.push(
      `ALTER TABLE ${table} ADD COLUMN ${col} ${def.type}${
        notNull ? " NOT NULL" : ""
      }${def.default !== undefined ? ` DEFAULT ${defVal}` : ""};`
    );
  }

  // Step 4: Detect modifications on existing columns
  for (const [col, def] of Object.entries(newFields)) {
    const oldDef = oldFields[col];
    if (!oldDef || renames.some((r) => r.new === col)) continue;

    const oldNullable = oldDef.nullable === true;
    const newNullable = def.nullable === true;

    // Type changed
    if (def.type !== oldDef.type) {
      sql.push(`ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${def.type};`);
    }

    // Nullability changed
    if (newNullable !== oldNullable) {
      sql.push(
        `ALTER TABLE ${table} ALTER COLUMN ${col} ${
          newNullable ? "DROP" : "SET"
        } NOT NULL;`
      );
    }

    // Default changed
    if (def.default !== oldDef.default) {
      if (def.default === undefined) {
        sql.push(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP DEFAULT;`);
      } else {
        const defVal =
          typeof def.default === "string" ? `'${def.default}'` : def.default;
        sql.push(
          `ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT ${defVal};`
        );
      }
    }
  }

  return { sql, warnings, renames };
}

function _handleTriggersDiff(
  table,
  oldTriggers = {},
  newTriggers = {},
  sql = []
) {
  // Normalize an object of triggers (preserving insertion order) into an array
  // Each item will have:
  // - key: original key from object
  // - event, timing (uppercased for comparison / lowercased for name)
  // - statements: array
  // - order: numeric position in the list
  // - baseName: trg_<table>_<event>_<timing>_<order>
  const normalize = (triggers) => {
    return Object.entries(triggers).map(([key, trig], order) => {
      const event = (trig.event || "").toUpperCase();
      const timing = (trig.timing || "").toUpperCase();
      const statements = Array.isArray(trig.statements) ? trig.statements : [];
      const baseName = `trg_${table}_${event.toLowerCase()}_${timing.toLowerCase()}`;
      return { key, event, timing, statements, order, baseName, raw: trig };
    });
  };

  const oldList = normalize(oldTriggers);
  const newList = normalize(newTriggers);

  // Build maps by baseName for quick lookup
  const oldMap = Object.fromEntries(oldList.map((t) => [t.baseName, t]));
  const newMap = Object.fromEntries(newList.map((t) => [t.baseName, t]));

  // 1) Drop triggers that existed previously but do not exist in the new list (by baseName).
  //    We must drop each per-statement trigger (baseName_0, baseName_1, ...)
  for (const oldTrig of oldList) {
    if (!newMap[oldTrig.baseName]) {
      for (let si = 0; si < oldTrig.statements.length; si++) {
        const dropName = `${oldTrig.baseName}_${si}`;
        sql.push(`DROP TRIGGER IF EXISTS ${dropName} ON ${table};`);
      }
    }
  }

  // 2) For every new trigger (in order), compare to old:
  //    - If exact same (same number & text of statements and same order), do nothing.
  //    - Otherwise drop existing (if any) and recreate each statement trigger
  newList.forEach((newTrig) => {
    const oldTrig = oldMap[newTrig.baseName];

    const sameStatements =
      oldTrig &&
      oldTrig.statements.length === newTrig.statements.length &&
      oldTrig.statements.every((s, i) => s === newTrig.statements[i]);

    // If oldTrig exists and statements are identical and the baseName includes the same order,
    // we consider it unchanged and keep it (so order is respected).
    if (oldTrig && sameStatements) {
      // unchanged — do nothing
      return;
    }

    // Otherwise drop any existing triggers with the same baseName (if present)
    // Note: dropping by exact per-statement name keeps it safe and precise.
    if (oldTrig) {
      for (let si = 0; si < oldTrig.statements.length; si++) {
        const dropName = `${oldTrig.baseName}_${si}`;
        sql.push(`DROP TRIGGER IF EXISTS ${dropName} ON ${table};`);
      }
    } else {
      // If there was no oldTrig with same baseName there might still exist triggers
      // with a different baseName pattern for the same event/timing. We do not
      // auto-drop those here because we only drop triggers we know are obsolete.
      // (Optional: you may scan oldList for same event/timing but different order and drop them.)
    }

    // Recreate new statements as per-statement triggers named baseName_<idx>
    newTrig.statements.forEach((statement, idx) => {
      const createName = `${newTrig.baseName}_${idx}`;
      // Use the preserved timing & event for the CREATE statement.
      // Trim and normalize spacing to keep SQL tidy.
      const timing = newTrig.timing;
      const event = newTrig.event;

      sql.push(
        `CREATE TRIGGER ${createName}\n  ${timing} ${event}\n  ON ${table}\n  FOR EACH ROW\n  EXECUTE FUNCTION ${statement};`
      );
    });
  });

  return sql;
}

export function _generateCreateTableSQL(table, newModel, sql = []) {
  const columns = [];
  const pk = [];

  const added = Object.keys(newModel.fields);

  for (const col of added) {
    const def = newModel.fields[col];
    let columnSQLdef = `${col}`;

    // 1️⃣ Map field type
    columnSQLdef += " " + def.type;

    // 2️⃣ Nullability
    const nullable = def.nullable === true; // explicitly nullable
    const notNull = !nullable; // default is NOT NULL

    if (notNull) columnSQLdef += " NOT NULL";

    if (def.primaryKey) pk.push(col);
    if (def.autoIncrement) columnSQLdef += " AUTO_INCREMENT";

    // 4️⃣ Default value
    if (def.default !== undefined && def.default !== null) {
      if (typeof def.default === "string") {
        columnSQLdef += ` DEFAULT '${def.default}'`;
      } else {
        columnSQLdef += ` DEFAULT ${def.default}`;
      }
    }

    columns.push(columnSQLdef);
  }

  // 5️⃣ Handle primary key
  if (pk.length) {
    columns.push(`PRIMARY KEY (${pk.map((f) => `"${f}"`).join(", ")})`);
  }

  // 6️⃣ Build table-level comment and index SQL
  let tableSQL = `CREATE TABLE IF NOT EXISTS "${table}" (\n  ${columns.join(
    ",\n  "
  )}\n);`;

  sql.push(tableSQL);

  return tableSQL;
}

export async function diffSchemas(oldSchema, newSchema) {
  const sql = [];
  const warnings = [];

  for (const [_, newModel] of Object.entries(newSchema)) {
    const table = newModel.meta?.tableName || newModel.name;
    let tableIsNew;

    const oldModel =
      Object.values(oldSchema).find(
        (m) => (m.meta?.tableName || m.name) === table
      ) || {};

    // If table doesn’t exist in old schema, create it
    if (Object.entries(oldModel).length == 0) {
      tableIsNew = true;
      _generateCreateTableSQL(table, newModel, sql);
    }

    // Handle meta-level changes (table rename, comment, indexes)
    _handleMetaDiff(table, oldModel.meta, newModel.meta, sql);

    if (!tableIsNew) {
      // Handle fields (columns)
      await _handleFieldDiff(
        table,
        oldModel.fields,
        newModel.fields,
        sql,
        warnings
      );
    }

    // Handle relationships
    const newModelsObject = Object.entries(newSchema);
    await _handleRelationsDiff(
      table,
      oldModel.relations,
      newModel.relations,
      newModelsObject,
      sql
    );

    // Handle triggers
    _handleTriggersDiff(table, oldModel.triggers, newModel.triggers, sql);

    // Handle dropped tables
    for (const [_, oldModel] of Object.entries(oldSchema)) {
      const table = oldModel.meta?.tableName || oldModel.name;

      const existsInNew = Object.values(newSchema).some(
        (m) => (m.meta?.tableName || m.name) === table
      );

      if (!existsInNew) {
        sql.push(`DROP TABLE IF EXISTS ${table};`);
        warnings.push(`Table '${table}' was removed.`);
      }
    }
  }

  return { sql, warnings };
}
