const readline = require("readline");

function _handleMetaDiff(table, oldMeta = {}, newMeta = {}, sql = []) {
  // --- Table rename ---
  if (
    oldMeta.db_table &&
    newMeta.db_table &&
    oldMeta.db_table !== newMeta.db_table
  ) {
    sql.push(`ALTER TABLE ${oldMeta.db_table} RENAME TO ${newMeta.db_table};`);
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

  const oldIndexMap = Object.fromEntries(oldIndexes.map((i) => [i.name, i]));
  const newIndexMap = Object.fromEntries(newIndexes.map((i) => [i.name, i]));

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

function _handleRelationsDiff(
  table,
  oldRelations = {},
  newRelations = {},
  sql = []
) {
  const autoThroughName = (base, target) => `${base}_${target}_link`;

  // --- Added or changed relations ---
  for (const [relName, rel] of Object.entries(newRelations)) {
    const oldRel = oldRelations[relName];

    // Auto-generate through table if not specified
    if (rel.type === "manyToMany" && !rel.through) {
      rel.through = autoThroughName(table, rel.model);
    }

    // Skip unchanged
    if (JSON.stringify(oldRel) === JSON.stringify(rel)) continue;

    switch (rel.type) {
      case "hasOne":
      case "hasMany":
        sql.push(
          `ALTER TABLE ${rel.model} ADD CONSTRAINT fk_${rel.model}_${rel.foreignKey} FOREIGN KEY (${rel.foreignKey}) REFERENCES ${table}(id);`
        );
        sql.push(
          `CREATE INDEX IF NOT EXISTS idx_${rel.model}_${rel.foreignKey} ON ${rel.model} (${rel.foreignKey});`
        );
        break;

      case "manyToMany":
        sql.push(
          `CREATE TABLE IF NOT EXISTS ${rel.through} (
            ${rel.foreignKey} UUID REFERENCES ${table}(id),
            ${rel.otherKey} UUID REFERENCES ${rel.model}(id),
            PRIMARY KEY (${rel.foreignKey}, ${rel.otherKey})
          );`
        );
        break;

      default:
        throw new Error(
          `Unknown relation type "${rel.type}" in ${table}.${relName}`
        );
    }
  }

  // --- Removed relations ---
  for (const [relName, oldRel] of Object.entries(oldRelations)) {
    if (!newRelations[relName]) {
      switch (oldRel.type) {
        case "hasOne":
        case "hasMany":
          sql.push(
            `ALTER TABLE ${oldRel.model} DROP CONSTRAINT IF EXISTS fk_${oldRel.model}_${oldRel.foreignKey};`
          );
          sql.push(
            `DROP INDEX IF EXISTS idx_${oldRel.model}_${oldRel.foreignKey};`
          );
          break;

        case "manyToMany":
          const throughTable =
            oldRel.through || autoThroughName(table, oldRel.model);
          sql.push(`DROP TABLE IF EXISTS ${throughTable};`);
          break;
      }
    }
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
  for (const [key, trig] of Object.entries(newTriggers)) {
    const oldTrig = oldTriggers[key];
    if (JSON.stringify(oldTrig) === JSON.stringify(trig)) continue;

    const triggerName = `trg_${table}_${trig.event.toLowerCase()}_${trig.timing.toLowerCase()}`;
    sql.push(`DROP TRIGGER IF EXISTS ${triggerName} ON ${table};`);

    trig.statements.forEach((statement, idx) => {
      sql.push(`
        CREATE TRIGGER ${triggerName}_${idx}
        ${trig.timing} ${trig.event}
        ON ${table}
        FOR EACH ROW
        EXECUTE FUNCTION ${statement};
      `);
    });
  }
}

export async function diffSchemas(oldSchema, newSchema) {
  const sql = [];
  const warnings = [];

  for (const [table, newModel] of Object.entries(newSchema)) {
    const oldModel = oldSchema[table] || {};

    // 1️⃣ Handle meta-level changes (table rename, comment, indexes)
    _handleMetaDiff(table, oldModel.meta, newModel.meta, sql);

    // 2️⃣ Handle relationships
    _handleRelationsDiff(table, oldModel.relations, newModel.relations, sql);

    // 3️⃣ Handle fields (columns)
    await _handleFieldDiff(
      table,
      oldModel.fields,
      newModel.fields,
      sql,
      warnings
    );

    // 4️⃣ Handle triggers
    _handleTriggersDiff(table, oldModel.triggers, newModel.triggers, sql);
  }

  return { sql, warnings };
}
