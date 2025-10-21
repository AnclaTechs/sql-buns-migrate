import fs from "fs";
import path from "path";
import { getAllRows } from "@anclatechs/sql-buns";
import { generateChecksum } from "./utils/generics.js";
import { loadModels } from "./utils/loadModels.js";
import { diffSchemas } from "./utils/schemaDiffConstructor.js";
import { inspectDBForDrift } from "./utils/integrity.js";
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

function extractSchemas(modelsModule) {
  const schemas = {};

  for (const [name, model] of Object.entries(modelsModule)) {
    schemas[name] = model.toJSON();
  }

  return schemas;
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

export async function migrateUp() {
  console.log("Running migrations...");
  // check and run all unapplied migrations
}

export async function migrateDown() {
  console.log("Reverting last migration...");
  // future: rollback logic
}
