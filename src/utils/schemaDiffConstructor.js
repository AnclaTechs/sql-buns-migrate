import { getSingleRow } from "@anclatechs/sql-buns";
import chalk from "chalk";
import readline from "readline";
import { SUPPORTED_SQL_DIALECTS_TYPES } from "./constants.js";
const dbType = process.env.DATABASE_ENGINE;
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

/**
 *
 * Validates trigger body for referenced tables/columns; It's similar to `decideRelationAction` function below,
 * but tailored for trigger statements. Throws on parse failure or invalid refs
 * Returns { action: "createNow" | "defer" } on success, or { action: "error", error: Error }
 */
async function _validateTriggerBody(body, allNewModels) {
  const upperBody = body.toUpperCase().trim();
  let targetTables = [],
    targetColumns = [];

  // Parse from body
  if (upperBody.startsWith("INSERT INTO")) {
    const tableMatch = body.match(/INSERT\s+INTO\s+["`']?(\w+)["`']?/i);
    if (!tableMatch) {
      console.error(
        chalk.red(
          `Could not parse target table from INSERT statement in trigger body \n${body}`
        )
      );
      process.exit();
    }
    targetTables.push(tableMatch[1].toLowerCase());

    // Columns from (col1, col2)
    const colMatch = body.match(/\(\s*([^)]+)\s*\)/);
    if (colMatch) {
      targetColumns = colMatch[1]
        .split(",")
        .map((col) =>
          col
            .trim()
            .replace(/^["`']|["`']$/g, "")
            .toLowerCase()
        )
        .filter(Boolean);
    }
  } else if (upperBody.startsWith("UPDATE")) {
    const tableMatch = body.match(/UPDATE\s+["`']?(\w+)["`']?/i);
    if (!tableMatch) {
      console.error(
        chalk.red(
          `Could not parse target table from UPDATE statement in trigger body \n${body}`
        )
      );
      process.exit();
    }
    targetTables.push(tableMatch[1].toLowerCase());

    // Columns from SET
    const setMatch = body.match(/SET\s+([^;]+)/i);
    if (setMatch) {
      const setClause = setMatch[1];
      targetColumns = setClause
        .split(",")
        .map((part) => {
          const colPart = part.trim().split("=")[0].trim();
          return colPart.replace(/^["`']|["`']$/g, "").toLowerCase();
        })
        .filter(Boolean);
    }
  } else if (upperBody.startsWith("DELETE FROM")) {
    const tableMatch = body.match(/DELETE\s+FROM\s+["`']?(\w+)["`']?/i);
    if (!tableMatch) {
      console.error(
        chalk.red(
          `Could not parse target table from DELETE statement in trigger body \n${body}`
        )
      );
      process.exit();
    }
    targetTables.push(tableMatch[1].toLowerCase());
  } else if (upperBody.startsWith("SELECT")) {
    // Basic SELECT: Grab FROM table (first one; extend for JOINs if needed)
    const fromMatch = body.match(/FROM\s+["`']?(\w+)["`']?/i);
    if (!fromMatch)
      throw new Error(
        "Could not parse target table from SELECT statement in trigger body"
      );
    targetTables.push(fromMatch[1].toLowerCase());

    // Columns: From SELECT col1, col2 or * (skip if *)
    if (!upperBody.includes("SELECT *")) {
      const selectMatch = body.match(/SELECT\s+([^;]+)/i);
      if (selectMatch) {
        const selectClause = selectMatch[1].split("FROM")[0].trim(); // Up to FROM
        targetColumns = selectClause
          .split(",")
          .map((col) =>
            col
              .trim()
              .replace(/^["`']|["`']$/g, "")
              .toLowerCase()
          )
          .filter(Boolean);
      }
    }

    // Warn on subqueries/JOINs (basic check)
    if (body.includes("JOIN") || body.match(/SELECT.*SELECT/i)) {
      console.warn(
        "Complex SELECT (JOIN/subquery) detected—manual validation recommended for all referenced tables."
      );
    }
  } else {
    // Non-DML (e.g., RETURN, IF without DML): assume safe
    return { action: "createNow" };
  }

  // Validate each derived targetTable (and its columns)
  for (const targetTable of targetTables) {
    const tableExists = await _tableExistsInDb(targetTable);

    const tablesInBatch = allNewModels.reduce((acc, [_, model]) => {
      const table = model.meta?.tableName || model.name;
      acc[table.toLowerCase()] = model;
      return acc;
    }, {});

    const targetInBatch = !!tablesInBatch[targetTable];
    const targetModel = targetInBatch ? tablesInBatch[targetTable] : null;

    if (tableExists) {
      // Existing: validate columns
      for (const col of targetColumns) {
        const colExists = await _columnExistsInDb(targetTable, col);
        if (!colExists) {
          return {
            action: "error",
            error: new Error(
              `Trigger references non-existent column "${col}" in existing table "${targetTable}".`
            ),
          };
        }
      }
    } else if (targetInBatch) {
      // In batch: validate model fields
      for (const col of targetColumns) {
        const definesField = !!(targetModel.fields || {})[col];
        if (!definesField) {
          return {
            action: "error",
            error: new Error(
              `Trigger references column "${col}" in batch table "${targetTable}", but model does not define this field.`
            ),
          };
        }
      }
    } else {
      // Missing entirely
      return {
        action: "error",
        error: new Error(
          `Trigger references table "${targetTable}" which does not exist in DB and is not part of the current migration batch.`
        ),
      };
    }

    // Per-table action: Use "defer" if *any* target needs it
    if (targetInBatch && !tableExists) {
      return { action: "defer" }; // Defer whole trigger if any dep in batch
    }
  }

  return { action: "createNow" };
}

function _handleMetaDiff(
  table,
  oldMeta = {},
  newMeta = {},
  sql = [],
  reverseSQL = []
) {
  // --- Table rename ---
  if (
    oldMeta.tableName &&
    newMeta.tableName &&
    oldMeta.tableName !== newMeta.tableName
  ) {
    sql.push(
      `ALTER TABLE ${oldMeta.tableName} RENAME TO ${newMeta.tableName};`
    );
    reverseSQL.push(
      `ALTER TABLE ${newMeta.tableName} RENAME TO ${oldMeta.tableName};`
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
      reverseSQL.push(`DROP INDEX IF EXISTS ${idx.name}`);
    }
  }

  // Drop removed indexes
  for (const oldIdx of oldIndexes) {
    if (!newIndexMap[oldIdx.name]) {
      const unique = oldIdx.unique ? "UNIQUE " : "";
      sql.push(`DROP INDEX IF EXISTS ${oldIdx.name};`);
      reverseSQL.push(
        `CREATE ${unique}INDEX ${oldIdx.name} ON ${table} (${oldIdx.fields.join(
          ", "
        )});`
      );
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
  sql = [],
  reverseSQL = [],
  deferedSql = [],
  pendingFKConstraints = []
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

    const tablesInBatch = allNewModels.reduce(
      (resultantAccumulatingArray, [_, model]) => {
        const table = model.meta?.tableName || model.name;
        resultantAccumulatingArray[table] = model;
        return resultantAccumulatingArray;
      },
      {}
    );

    const targetInBatch = !!tablesInBatch[foreignTable];
    const targetDefinesField =
      targetInBatch && !!(tablesInBatch[foreignTable].fields || {})[foreignKey];

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
  const createRelationSql = async (rel, baseTable) => {
    if (rel.type === "manyToMany") {
      return [
        [
          `CREATE TABLE IF NOT EXISTS ${rel.through} (
          ${rel.foreignKey} INTEGER REFERENCES ${baseTable}(id),
          ${rel.otherKey} INTEGER REFERENCES ${rel.model}(id),
          PRIMARY KEY (${rel.foreignKey}, ${rel.otherKey})
        );`,
        ],
        [`DROP TABLE IF EXISTS ${rel.through};`],
      ];
    } else if (rel.type === "hasOne" || rel.type === "hasMany") {
      const tableExists = await _tableExistsInDb(rel.model);
      if (tableExists) {
        if (dbType == SUPPORTED_SQL_DIALECTS_TYPES.SQLITE) {
          // THROW ERROR due to SQLite limitation
          process.exit();
        } else {
          return [
            [
              `ALTER TABLE ${rel.model} ADD CONSTRAINT fk_${rel.model}_${rel.foreignKey} FOREIGN KEY (${rel.foreignKey}) REFERENCES ${baseTable}(id);`,
              `CREATE INDEX IF NOT EXISTS idx_${rel.model}_${rel.foreignKey} ON ${rel.model} (${rel.foreignKey});`,
            ],
            [
              `DROP INDEX IF EXISTS idx_${rel.model}_${rel.foreignKey};`,
              `ALTER TABLE ${rel.model} DROP CONSTRAINT fk_${rel.model}_${rel.foreignKey};`,
            ],
          ];
        }
      } else {
        // Table doesn't exist yet, Check newModelsObject
        const tablesInBatch = allNewModels.reduce(
          (resultantAccumulatingArray, [_, model]) => {
            const table = model.meta?.tableName || model.name;
            resultantAccumulatingArray[table] = model;
            return resultantAccumulatingArray;
          },
          {}
        );

        const foreignTable = rel.model;
        const foreignKey = rel.foreignKey;
        const targetInBatch = !!tablesInBatch[foreignTable];
        const targetDefinesField =
          targetInBatch &&
          !!(tablesInBatch[foreignTable].fields || {})[foreignKey];

        if (targetInBatch && targetDefinesField) {
          pendingFKConstraints.push({
            model: rel.model,
            foreignKey: rel.foreignKey,
            baseTable,
          });
        } else {
          // UNABLE TO RECONCILE
        }
        return [[], []];
      }
    }
    return [[], []];
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
      const [relSql, reverseRelSQL] = await createRelationSql(rel, table);
      sql.push(...relSql);
      reverseSQL.push(...reverseRelSQL);
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

      switch (action) {
        case "defer":
          // IF AT THIS STAGE NO ERROR IS Received, table is most likely in batch and should be included
          // Create the now-valid relation but defer the sql.push
          var [relSql, reverseRelSQL] = await createRelationSql(rel, base);
          deferedSql.push(...relSql);
          reverseSQL.push(...reverseRelSQL);
          break;
        case "createNow":
          // Create the now-valid relation
          var [relSql, reverseRelSQL] = await createRelationSql(rel, base);
          sql.push(...relSql);
          reverseSQL.push(...reverseRelSQL);
          break;
        default:
          console.error(
            chalk.red("Error"),
            `Pending relation ${base}.${relName} still cannot be created (table/field missing).`
          );
          process.exit();
      }
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
  reverseSQL = [],
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
          reverseSQL.push(
            `ALTER TABLE ${table} RENAME COLUMN ${newCol} TO ${oldCol};`
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
    const oldDef = oldFields[col];
    const oldDefVal =
      typeof oldDef.default === "string"
        ? `'${oldDef.default}'`
        : oldDef.default;
    reverseSQL.push(
      `ALTER TABLE ${table} ADD COLUMN ${col} ${oldDef.type} ${
        oldDef.default !== undefined ? ` DEFAULT ${oldDefVal}` : ""
      };`
    );
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
    reverseSQL.push(`ALTER TABLE ${table} DROP COLUMN ${col};`);
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
      reverseSQL.push(
        `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${oldDef.type};`
      );
    }

    // Nullability changed
    if (newNullable !== oldNullable) {
      sql.push(
        `ALTER TABLE ${table} ALTER COLUMN ${col} ${
          newNullable ? "DROP" : "SET"
        } NOT NULL;`
      );
      reverseSQL.push(
        `ALTER TABLE ${table} ALTER COLUMN ${col} ${
          oldNullable ? "DROP" : "SET"
        } NOT NULL;`
      );
    }

    // Default changed
    if (def.default !== oldDef.default) {
      if (def.default === undefined) {
        sql.push(`ALTER TABLE ${table} ALTER COLUMN ${col} DROP DEFAULT;`);
        const oldDefVal =
          typeof oldDef.default === "string"
            ? `'${oldDef.default}'`
            : oldDef.default;
        reverseSQL.push(
          `ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT ${oldDefVal};`
        );
      } else {
        const defVal =
          typeof def.default === "string" ? `'${def.default}'` : def.default;
        sql.push(
          `ALTER TABLE ${table} ALTER COLUMN ${col} SET DEFAULT ${defVal};`
        );
        reverseSQL.push(
          `ALTER TABLE ${table} ALTER COLUMN ${col} DROP DEFAULT;`
        );
      }
    }
  }

  return { sql, warnings, renames };
}

async function _handleTriggersDiff(
  table,
  allNewModels = {},
  oldTriggers = {},
  newTriggers = {},
  sql = [],
  reverseSQL = []
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
        const funcName = `${dropName}_func`; // Tied to trigger name
        let dropSql = [];

        switch (dbType) {
          case SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES:
            // Optional flag for full cleanup
            dropSql.push(`DROP FUNCTION IF EXISTS ${funcName}();`);

            dropSql.push(`DROP TRIGGER IF EXISTS ${dropName} ON ${table};`);
            break;
          case SUPPORTED_SQL_DIALECTS_TYPES.MYSQL:
          case SUPPORTED_SQL_DIALECTS_TYPES.SQLITE:
            dropSql.push(`DROP TRIGGER IF EXISTS ${dropName};`);
            break;
          default:
            console.warn(
              `Unsupported dbType: ${dbType}; using generic syntax.`
            );
            dropSql.push(`DROP TRIGGER IF EXISTS ${dropName};`);
        }
        // Push all drops for this trigger (function first if applicable)
        dropSql.forEach((ds) => sql.push(ds));
      }
    }
  }

  // 2) For every new trigger (in order), compare to old:
  //    - If exact same (same number & text of statements and same order), do nothing.
  //    - Otherwise drop existing (if any) and recreate each statement trigger
  await Promise.all(
    newList.map(async (newTrig) => {
      const oldTrig = oldMap[newTrig.baseName];

      const sameStatements =
        oldTrig &&
        oldTrig.statements.length === newTrig.statements.length &&
        oldTrig.statements.every((oldS, i) => {
          const newS = newTrig.statements[i];
          const newBody = typeof newS === "string" ? newS : newS.body;
          return oldS === newBody;
        });

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
          const funcName = `${dropName}_func`; // Tied to trigger name
          let dropSql = [];

          switch (dbType) {
            case SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES:
              // Optional flag for full cleanup
              dropSql.push(`DROP FUNCTION IF EXISTS ${funcName}();`);

              dropSql.push(`DROP TRIGGER IF EXISTS ${dropName} ON ${table};`);
              break;
            case SUPPORTED_SQL_DIALECTS_TYPES.MYSQL:
            case SUPPORTED_SQL_DIALECTS_TYPES.SQLITE:
              dropSql.push(`DROP TRIGGER IF EXISTS ${dropName};`);
              break;
            default:
              console.warn(
                `Unsupported dbType: ${dbType}; using generic syntax.`
              );
              dropSql.push(`DROP TRIGGER IF EXISTS ${dropName};`);
          }
          // Push all drops for this trigger (function first if applicable)
          dropSql.forEach((ds) => sql.push(ds));
        }
      } else {
        // If there was no oldTrig with same baseName there might still exist triggers
        // with a different baseName pattern for the same event/timing. We do not
        // auto-drop those here because we only drop triggers we know are obsolete.
      }

      // Recreate new statements as per-statement triggers named baseName_<idx>
      await Promise.all(
        newTrig.statements.map(async (statement, idx) => {
          const createName = `${newTrig.baseName}_${idx}`;
          const funcName = `${createName}_func`;
          const timing = newTrig.timing;
          const event = newTrig.event;
          let body, when;
          if (typeof statement === "string") {
            body = statement.replace(/;+$/g, "").trim();
          } else {
            body = statement.body.replace(/;+$/g, "").trim();
            when = statement.when;
            // Regex to remove 'WHEN' keyword if present to prevent double (WHEN WHEN)
            if (when) {
              when = when
                .replace(/\bWHEN\b\s*/i, "")
                .replace(";", "")
                .trim();
            }
          }

          const validation = await _validateTriggerBody(body, allNewModels);
          if (validation.action === "error") {
            console.error(chalk.red(`${validation.error}`));
            process.exit();
          }

          const returnClause =
            event === "DELETE" ? "RETURN OLD;" : "RETURN NEW;";

          const whenClause = when ? `\n  WHEN (${when})` : "";

          let triggerSql;
          let reverseTriggerSql;
          switch (process.env.DATABASE_ENGINE) {
            case SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES:
              sql.push(
                `CREATE OR REPLACE FUNCTION ${funcName}() RETURNS trigger AS $$\n` +
                  `BEGIN\n` +
                  `  ${body};\n` +
                  `  ${returnClause}\n` +
                  `END;\n` +
                  `$$ LANGUAGE plpgsql;`
              );
              reverseSQL.push(`DROP FUNCTION IF EXISTS ${funcName}();`);
              triggerSql = `CREATE TRIGGER ${createName}\n  ${timing} ${event}\n  ON ${table}\n  FOR EACH ROW${whenClause}\n  EXECUTE FUNCTION ${funcName}();`;
              break;

            case SUPPORTED_SQL_DIALECTS_TYPES.MYSQL:
            case SUPPORTED_SQL_DIALECTS_TYPES.SQLITE:
              triggerSql = `CREATE TRIGGER ${createName}\n  ${timing} ${event}\n  ON ${table}\n  FOR EACH ROW${whenClause}\n  BEGIN\n    ${body};\n  END;`;
              break;

            default:
              triggerSql = `CREATE TRIGGER ${createName}\n  ${timing} ${event}\n  ON ${table}\n  FOR EACH ROW${whenClause}\n  EXECUTE FUNCTION ${body};`;
          }

          sql.push(triggerSql);
          reverseSQL.push(`DROP TRIGGER IF EXISTS ${createName} ON ${table};`);
        })
      );
    })
  );

  return sql;
}

export function _generateCreateTableSQL(
  table,
  newModel,
  sql = [],
  reverseSQL = [],
  pendingFKConstraints = [],
  leanSQLBuild = false // generate SQL but no push to sql or reverseSQL
) {
  const engine = process.env.DATABASE_ENGINE;
  const columns = [];
  const pk = [];

  // Helper: Dialect-specific adjustments
  const getAutoIncrement = (def) => {
    if (!def.autoIncrement) return "";
    if (engine === SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES) return "SERIAL"; // Replaces base type, e.g., INTEGER -> SERIAL
    if (engine === SUPPORTED_SQL_DIALECTS_TYPES.MYSQL) return "AUTO_INCREMENT";
    if (engine === SUPPORTED_SQL_DIALECTS_TYPES.SQLITE) return "AUTOINCREMENT";
    return "";
  };

  const getIdentifierQuote = (identifier) => {
    if (
      engine === SUPPORTED_SQL_DIALECTS_TYPES.SQLITE &&
      /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)
    )
      return identifier; // No quotes required for simple names
    return `"${identifier}"`; // Double quotes for Postgres/MySQL
  };

  const getDefaultClause = (def) => {
    if (def.default === undefined || def.default === null) return "";

    let defaultVal = def.default;
    if (typeof defaultVal === "string") {
      // Escape single quotes for strings
      defaultVal = defaultVal.replace(/'/g, "''");
      return ` DEFAULT '${defaultVal}'`;
    }
    if (defaultVal === "CURRENT_TIMESTAMP") {
      if (engine === SUPPORTED_SQL_DIALECTS_TYPES.SQLITE)
        return " DEFAULT CURRENT_TIMESTAMP";
      return ` DEFAULT ${defaultVal}`; // Works for all
    }
    return ` DEFAULT ${defaultVal}`;
  };

  const added = Object.keys(newModel.fields);
  let hasAutoIncInPk = false;

  for (const col of added) {
    const def = newModel.fields[col];
    let columnSQLdef = getIdentifierQuote(col);

    let baseType = def.type.toUpperCase();
    if (engine === SUPPORTED_SQL_DIALECTS_TYPES.SQLITE) {
      // Check for enum-like pattern: TEXT CHECK(VALUE IN (...))
      if (baseType.includes("TEXT CHECK(VALUE IN")) {
        const regex = /TEXT\s+CHECK\s*\(\s*VALUE\s+IN\s*\(/i;
        baseType = def.type.replace(
          regex,
          `TEXT CHECK(${getIdentifierQuote(col)} IN (`
        );
      }
    }
    const autoInc = getAutoIncrement(def);
    if (autoInc && engine === SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES) {
      columnSQLdef += ` ${autoInc}`; // example herein: SERIAL overrides INTEGER
    } else {
      columnSQLdef += ` ${baseType}${autoInc ? ` ${autoInc}` : ""}`;
    }

    if (def.unique) {
      columnSQLdef += " UNIQUE";
    }

    // Nullability
    const nullable = def.nullable === true;
    const notNull = !nullable;
    if (notNull) columnSQLdef += " NOT NULL";

    // Default value
    columnSQLdef += getDefaultClause(def);

    // Collect PK (unquoted col for lookup)
    if (def.primaryKey) {
      const quotedCol = getIdentifierQuote(col);
      pk.push(col); // Unquoted for def lookup
      // Flag if this PK has auto-inc
      if (autoInc) hasAutoIncInPk = true;
    }

    columns.push(columnSQLdef);
  }

  // Post-loop: Validate composite && Auto-Increment
  const pkQuoted = pk.map((col) => getIdentifierQuote(col));
  if (pkQuoted.length > 1 && hasAutoIncInPk) {
    console.error(
      chalk.red(
        `[${pkQuoted.join(
          ", "
        )}] in '${table}' table forms a composite PK. Auto-increment is invalid for composites (SQL-Engine: ${engine}).`
      )
    );
    process.exit(1);
  }

  // Handle primary key constraint
  if (pkQuoted.length > 0) {
    let pkClause;
    if (pkQuoted.length === 1) {
      // Single PK: Inline with auto-increment where possible
      switch (engine) {
        case SUPPORTED_SQL_DIALECTS_TYPES.SQLITE:
          for (let i = 0; i < columns.length; i++) {
            if (
              columns[i].includes(pkQuoted[0]) &&
              columns[i].includes("AUTOINCREMENT")
            ) {
              columns[i] = columns[i].replace(
                "AUTOINCREMENT",
                "PRIMARY KEY AUTOINCREMENT"
              );
              break;
            }
          }
          break;
        case SUPPORTED_SQL_DIALECTS_TYPES.MYSQL:
          for (let i = 0; i < columns.length; i++) {
            if (
              columns[i].includes(pkQuoted[0]) &&
              columns[i].includes("AUTO_INCREMENT")
            ) {
              columns[i] = columns[i].replace(
                "AUTO_INCREMENT",
                "AUTO_INCREMENT PRIMARY KEY"
              );
              break;
            }
          }
          break;
        case SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES:
          // Optional: Inline PRIMARY KEY on SERIAL col
          for (let i = 0; i < columns.length; i++) {
            if (
              columns[i].includes(pkQuoted[0]) &&
              columns[i].includes("SERIAL")
            ) {
              columns[i] = columns[i].replace("SERIAL", "SERIAL PRIMARY KEY");
              break;
            }
          }
        default:
          pkClause = `PRIMARY KEY (${pkQuoted.join(", ")})`;
          columns.push(pkClause);
      }
    } else {
      // Composite:
      pkClause = `PRIMARY KEY (${pkQuoted.join(", ")})`;
      columns.push(pkClause);
    }
  }

  // Check pendingFKConstraints
  pendingFKConstraints.map((record) => {
    const table = newModel.meta?.tableName || newModel.name;
    if (record.model == table) {
      columns.push(
        `FOREIGN KEY (${record.foreignKey}) REFERENCES ${record.baseTable}(id)`
      );
    }
  });

  // Build full CREATE TABLE
  const quotedTable = getIdentifierQuote(table);
  let tableSQL = `CREATE TABLE IF NOT EXISTS "${quotedTable}" (\n  ${columns.join(
    ",\n  "
  )}\n);`;

  if (!leanSQLBuild) {
    sql.push(tableSQL);
    reverseSQL.push(
      `DROP TABLE IF EXISTS ${newModel.meta?.tableName || newModel.name};`
    );
  }

  return tableSQL;
}

export async function diffSchemas(oldSchema, newSchema) {
  const sql = [];
  const reverseSQL = [];
  const warnings = [];
  const deferredRelationSqlDiff = [];
  const pendingFKConstraints = [];

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
      _generateCreateTableSQL(
        table,
        newModel,
        sql,
        reverseSQL,
        pendingFKConstraints
      );
    }

    // Handle meta-level changes (table rename, comment, indexes)
    _handleMetaDiff(table, oldModel.meta, newModel.meta, sql, reverseSQL);

    if (!tableIsNew) {
      // Handle fields (columns)
      await _handleFieldDiff(
        table,
        oldModel.fields,
        newModel.fields,
        sql,
        reverseSQL,
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
      sql,
      reverseSQL,
      deferredRelationSqlDiff,
      pendingFKConstraints
    );

    // Handle triggers
    await _handleTriggersDiff(
      table,
      newModelsObject,
      oldModel.triggers,
      newModel.triggers,
      sql,
      reverseSQL
    );

    // Handle dropped tables
    for (const [_, oldModel] of Object.entries(oldSchema)) {
      const table = oldModel.meta?.tableName || oldModel.name;

      const existsInNew = Object.values(newSchema).some(
        (m) => (m.meta?.tableName || m.name) === table
      );

      if (!existsInNew) {
        sql.push(`DROP TABLE IF EXISTS ${table};`);
        const [reverseTableSQL, _] = _generateCreateTableSQL(
          table,
          oldModel,
          [],
          [],
          [],
          true
        );
        reverseSQL.push(reverseTableSQL);
        warnings.push(`Table '${table}' was removed.`);
      }
    }
  }

  sql.push(...deferredRelationSqlDiff);

  return { sql, reverseSQL, warnings };
}
