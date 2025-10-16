import { createRequire } from "module";
const require = createRequire(import.meta.url);
global.require = require;

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadModels } = require("./utils/loadModels.js");
const { diffSchemas } = require("./utils/schemaDiffConstructor.js");
const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");
const SNAPSHOT_FILE = path.join(MIGRATIONS_DIR, "schema_snapshot.json");

function checksum(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

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
  if (!fs.existsSync(MIGRATIONS_DIR)) fs.mkdirSync(MIGRATIONS_DIR);

  const models = await loadModels();
  const currentSchema = extractSchemas(models);
  const currentChecksum = checksum(currentSchema);

  let oldSchema = {};
  if (fs.existsSync(SNAPSHOT_FILE)) {
    oldSchema = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, "utf-8"));
  }

  const oldChecksum = checksum(oldSchema);

  if (currentChecksum === oldChecksum) {
    console.log("✅ No schema changes detected.");
    return;
  }

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
