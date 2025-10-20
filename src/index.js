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

export async function createMigration(name) {
  // CHECK DIRECTORY
  if (!fs.existsSync(MIGRATIONS_DIR))
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });

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
      "\n⚠️ Your local migration files are out of sync with the database.\nRun:  buns-migrate up  to apply them before creating a new one.\n"
    );
    process.exit(1);
  }

  const models = await loadModels();
  const currentSchema = extractSchemas(models);
  const currentChecksum = generateChecksum(currentSchema);

  let oldSchema = {};
  if (fs.existsSync(SNAPSHOT_FILE)) {
    oldSchema = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf-8"));
  }

  const oldChecksum = generateChecksum(oldSchema);

  if (currentChecksum === oldChecksum) {
    console.log("✅ No schema changes detected.");
    return;
  }

  await inspectDBForDrift(oldSchema, currentSchema);

  const changes = await diffSchemas(oldSchema, currentSchema);

  if (changes.warnings.length > 0) {
    console.log("⚠️ Warnings:");
    changes.warnings.forEach((w) => console.log(" - " + w));
  }

  const sql = changes.sql.join("\n");

  const timestamp = Date.now();
  const filename = `${timestamp}_${sanitizeMigrationName(name)}.sql`;
  fs.writeFileSync(path.join(MIGRATIONS_DIR, filename), sql);

  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(currentSchema, null, 2));

  console.log(`✅ Migration created: ${filename}`);
}

export async function migrateUp() {
  console.log("Running migrations...");
  // future: check and run all unapplied migrations
}

export async function migrateDown() {
  console.log("Reverting last migration...");
  // future: rollback logic
}
