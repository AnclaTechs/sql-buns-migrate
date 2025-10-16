import "dotenv/config";
import path from "path";
import fs from "fs";
import { pool } from "@anclatechs/sql-buns";

export async function resolveModelsPath() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS _sqlbuns_migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        rolled_back BOOLEAN DEFAULT FALSE
      );
    `);
  } catch (err) {
    console.error(
      "⚠️ Unable to initialize/connect to migration table:",
      err.message
    );
    throw err.message;
  }

  // Locate model file
  const pkgPath = path.join(process.cwd(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const userPath = pkg?.sqlBuns?.modelsPath;

  const defaultPath = path.join(
    process.cwd(),
    "database",
    "models",
    "index.js"
  );
  const resolved = userPath
    ? path.resolve(process.cwd(), userPath)
    : defaultPath;

  if (!fs.existsSync(resolved)) {
    throw new Error(
      `❌ Models file not found at ${resolved}\nPlease create database/models/index.js or set "sqlBuns.modelsPath" in package.json`
    );
  }

  return resolved;
}
