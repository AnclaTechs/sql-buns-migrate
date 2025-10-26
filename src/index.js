import fs from "fs";
import path from "path";
import chalk from "chalk";
import { getAllRows, pool } from "@anclatechs/sql-buns";
import { generateChecksum } from "./utils/generics.js";
import { loadModels } from "./utils/loadModels.js";
import { diffSchemas } from "./utils/schemaDiffConstructor.js";
import { inspectDBForDrift } from "./utils/integrity.js";
import { SUPPORTED_SQL_DIALECTS_TYPES } from "./utils/constants.js";
const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");
const SNAPSHOT_FILE = path.join(MIGRATIONS_DIR, "schema_snapshot.json");

function sanitizeMigrationName(name) {
  /**
   * 1. Replace special characters with underscore
   * 2. Remove leading/trailing underscores
   */
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function schemaTopologicalSort(graph) {
  const visited = new Set();
  const temp = new Set();
  const result = [];
  const stack = [];

  function visit(node) {
    if (temp.has(node)) {
      const cycleStart = stack.indexOf(node);
      const cyclePath =
        cycleStart >= 0
          ? stack.slice(cycleStart).concat(node)
          : [...stack, node];
      throw new Error(`Cyclic dependency detected: ${cyclePath.join(" -> ")}`);
    }

    if (!visited.has(node)) {
      temp.add(node);
      stack.push(node);

      for (const dep of graph[node] || []) {
        if (!graph[dep]) graph[dep] = new Set(); // include unknown refs
        visit(dep);
      }

      stack.pop();
      temp.delete(node);
      visited.add(node);
      result.push(node);
    }
  }

  // This ensures isolated nodes are visited
  for (const node of Object.keys(graph)) {
    if (!visited.has(node)) visit(node);
  }

  return result;
}

function extractSchemas(modelsModule) {
  const schemas = {};
  const dependencyGraph = {};

  for (const [name, model] of Object.entries(modelsModule)) {
    const schema = model.toJSON();
    schemas[name] = schema;
    if (!dependencyGraph[name]) {
      dependencyGraph[name] = new Set();
    }

    if (schema.relations) {
      for (const rel of Object.values(schema.relations)) {
        if (rel.model && rel.model !== name) {
          const match = Object.entries(modelsModule).reduce(
            (acc, [key, model]) => {
              if (acc === null && model.name === rel.model) {
                return key;
              }
              return acc;
            },
            null
          );

          if (match !== null) {
            try {
              dependencyGraph[match].add(name);
            } catch (err) {
              if (err instanceof TypeError && !dependencyGraph[match]) {
                dependencyGraph[match] = new Set();
                dependencyGraph[match].add(name);
              } else {
                throw err;
              }
            }
          }
        }
      }
    }
  }

  const sorted = schemaTopologicalSort(dependencyGraph);

  const orderedSchemas = {};
  for (const modelName of sorted) {
    orderedSchemas[modelName] = schemas[modelName];
  }

  return orderedSchemas;
}

function normalizeSchemasForChecksum(oldSchema, currentSchema) {
  let oldFiltered = JSON.parse(JSON.stringify(oldSchema));
  let currentFiltered = JSON.parse(JSON.stringify(currentSchema));

  // Get all model objects from both schemas
  const oldModels = Object.values(oldFiltered);
  const currentModels = Object.values(currentFiltered);

  // Helper to generate a unique key for matching indexes (order-independent)
  function getIndexKey(idx) {
    if (!idx || !idx.fields) return null;
    const fieldsStr = [...idx.fields].sort().join(",");
    return `${fieldsStr}|${idx.unique ? "true" : "false"}`;
  }

  // Iterate over current models to find matches in old
  currentModels.forEach((currentModel) => {
    const currentTable = currentModel.meta?.tableName || currentModel.name;
    if (!currentTable) return; // Skip if no table identifier

    const matchingOldModel = oldModels.find((oldModel) => {
      const oldTable = oldModel.meta?.tableName || oldModel.name;
      return oldTable === currentTable;
    });

    if (!matchingOldModel) return; // No match, skip

    // Now normalize indexes for this matched pair
    const oldIndexes = matchingOldModel.meta?.indexes || [];
    const currentIndexes = currentModel.meta?.indexes || [];

    // Build a map of old indexes by key for quick lookup
    const oldIndexMap = {};
    oldIndexes.forEach((oldIdx) => {
      const key = getIndexKey(oldIdx);
      if (key) oldIndexMap[key] = oldIdx;
    });

    // For each current index, check for match in old and normalize if needed
    currentIndexes.forEach((currentIdx) => {
      const key = getIndexKey(currentIdx);
      if (!key) return; // Skip invalid indexes

      const matchingOldIdx = oldIndexMap[key];
      if (!matchingOldIdx) return; // No match in old, leave as-is (new index)

      // PS: Old always has 'name', so check if current lacks it
      if (!currentIdx.hasOwnProperty("name")) {
        // Delete from old to match lack in current
        delete matchingOldIdx.name;
      }
      // Else: current has 'name' (possibly different value)—keep both as-is
      // If values differ, checksum will detect the change
    });
  });

  return { oldFiltered, currentFiltered };
}

export async function createMigration(name) {
  // CHECK DIRECTORY
  if (!fs.existsSync(MIGRATIONS_DIR))
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });

  const models = await loadModels();
  const currentSchema = extractSchemas(models);

  let oldSchema = {};
  if (fs.existsSync(SNAPSHOT_FILE)) {
    oldSchema = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf-8"));
  }

  const { oldFiltered, currentFiltered } = normalizeSchemasForChecksum(
    oldSchema,
    currentSchema
  );
  const currentChecksum = generateChecksum(currentFiltered);
  const oldChecksum = generateChecksum(oldFiltered);

  if (currentChecksum === oldChecksum) {
    console.log("✅ No schema changes detected.");
    return;
  }

  // Read all migration files in the directory
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // Fetch all migrations already applied to the database
  const applied = await getAllRows(`SELECT name FROM  _sqlbuns_migrations`);
  const appliedNames = new Set(applied.map((r) => r.name));

  // Detect files yet to be applied
  const unapplied = files.filter((f) => !appliedNames.has(f));

  if (unapplied.length > 0) {
    console.error(
      `\n❌ Migration files not yet applied:\n${unapplied
        .map((f) => "  - " + f)
        .join("\n")}`
    );
    console.error(
      "\nYour local migration files are out of sync with the database.\nRun: `buns-migrate up` to apply them before creating a new one.\n"
    );
    process.exit(1);
  }

  await inspectDBForDrift(oldSchema, currentSchema);

  const changes = await diffSchemas(oldSchema, currentSchema);

  if (changes.warnings.length > 0) {
    console.log("Warnings:");
    changes.warnings.forEach((w) => console.log(" - " + w));
  }

  const sql = changes.sql.join("\n");

  const timestamp = Date.now();
  const filename = `${timestamp}_${sanitizeMigrationName(name)}.sql`;
  fs.writeFileSync(path.join(MIGRATIONS_DIR, filename), sql);

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(currentSchema, null, 2));

  console.log(chalk.green(`✅ Migration created: ${filename}`));
}

/**
 * Run all unapplied migrations
 */
export async function migrateUp() {
  console.log(chalk.cyan("🔍 Checking for unapplied migrations..."));

  // Get all migration files
  let migrationFiles;
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    migrationFiles = [];
  } else {
    migrationFiles = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  }

  if (migrationFiles.length === 0) {
    console.log(chalk.yellow("⚠️ No migration files found."));
    return;
  }

  // Fetch applied migrations from DB
  const appliedMigrations = await getAllRows(`
        SELECT name, checksum FROM _sqlbuns_migrations
        WHERE direction = 'up' AND rolled_back = false
      `);

  const appliedMap = new Map(
    appliedMigrations.map((m) => [m.name, m.checksum])
  );

  // Filter unapplied migrations
  const unapplied = migrationFiles.filter((file) => !appliedMap.has(file));

  if (unapplied.length === 0) {
    console.log(chalk.green("✅ All migrations are synced up to db."));
    return;
  }

  console.log(chalk.blue(`\nApplying ${unapplied.length} migrations...`));

  for (const file of unapplied) {
    /** CAVEAT -- From my initial process flow, this is designed to only have one unapplied migration
     * at a time, this may be a bottleneck in some instances but the merit is allow us to determine
     * at near 100% accuracy the current schema being processed
     *
     * Thus unapplied array lenght would be === 1
     * */

    const dbType = process.env.DATABASE_ENGINE;
    const schema = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf-8"));
    const filePath = path.join(MIGRATIONS_DIR, file);
    const content = fs.readFileSync(filePath, "utf8");
    const checksum = generateChecksum(schema);

    console.log(chalk.cyan(`\n▶ Running migration: ${file}`));

    let connection = null;
    const isPostgres = dbType === SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES;
    const isMySQL = dbType === SUPPORTED_SQL_DIALECTS_TYPES.MYSQL;
    const isSQLite = dbType === SUPPORTED_SQL_DIALECTS_TYPES.SQLITE;
    const useConnection = isPostgres || isMySQL;

    try {
      if (isPostgres) {
        connection = await pool.connect();
        await connection.query("BEGIN");
      } else if (isMySQL) {
        connection = await pool.getConnection();
        await connection.beginTransaction();
      } else if (isSQLite) {
        await pool.exec("BEGIN TRANSACTION");
      }

      if (useConnection) {
        await connection.query(content);
      } else {
        await pool.exec(content);
      }

      const params = [file, checksum, "up", false];
      let insertQuery;
      if (isPostgres) {
        insertQuery = `INSERT INTO _sqlbuns_migrations (name, checksum, direction, rolled_back) VALUES ($1, $2, $3, $4)`;
        await connection.query(insertQuery, params);
      } else if (isMySQL) {
        insertQuery = `INSERT INTO _sqlbuns_migrations (name, checksum, direction, rolled_back) VALUES (?, ?, ?, ?)`;
        await connection.query(insertQuery, params);
      } else if (isSQLite) {
        insertQuery = `INSERT INTO _sqlbuns_migrations (name, checksum, direction, rolled_back) VALUES (?, ?, ?, ?)`;
        await pool.run(insertQuery, params);
      }

      // Commit transaction
      if (isPostgres) {
        await connection.query("COMMIT");
      } else if (isMySQL) {
        await connection.commit();
      } else if (isSQLite) {
        await pool.exec("COMMIT");
      }

      console.log(chalk.green(`✅ Migration applied: ${file}`));
    } catch (err) {
      // Rollback on error
      if (isPostgres) {
        if (connection) await connection.query("ROLLBACK");
      } else if (isMySQL) {
        if (connection) await connection.rollback();
      } else if (isSQLite) {
        await pool.exec("ROLLBACK");
      }

      console.error(chalk.red(`❌ Failed migration: ${file}`));
      console.error(err.message);
      process.exit(1);
    } finally {
      if (connection) {
        if (isPostgres) {
          connection.release();
        } else if (isMySQL) {
          connection.release();
        }
      }
    }
  }

  console.log(chalk.green("\n🎉 All migrations applied successfully!"));
}

export async function migrateDown() {
  console.log("Reverting last migration...");
  // future: rollback logic
}
