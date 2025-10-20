import "dotenv/config";
import path from "path";
import fs from "fs";
import { pool } from "@anclatechs/sql-buns";
import {
  SUPPORTED_SQL_DIALECTS,
  SUPPORTED_SQL_DIALECTS_TYPES,
} from "./constants.js";

export async function resolveModelsPath() {
  try {
    const dbType = process.env.DATABASE_ENGINE;
    if (!SUPPORTED_SQL_DIALECTS.includes(dbType)) {
      throw new Error(
        `${dbType} DATABASE_ENGINE not supported. Review .env file.`
      );
    }

    if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES) {
      await pool.query(`
      CREATE TABLE IF NOT EXISTS _sqlbuns_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        previous_checksum VARCHAR(64),
        direction VARCHAR(10) CHECK (direction IN ('up', 'down')) DEFAULT 'up' NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        rolled_back BOOLEAN DEFAULT FALSE
      );
    `);
    } else if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.MYSQL) {
      await pool.query(`
      CREATE TABLE IF NOT EXISTS _sqlbuns_migrations (
        id INTEGER AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        previous_checksum VARCHAR(64),
        direction VARCHAR(10) CHECK (direction IN ('up', 'down')) DEFAULT 'up' NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        rolled_back BOOLEAN DEFAULT FALSE
      );
    `);
    } else if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.SQLITE) {
      await pool.run(`
      CREATE TABLE IF NOT EXISTS _sqlbuns_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR(255) NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        previous_checksum VARCHAR(64),
        direction VARCHAR(10) CHECK (direction IN ('up', 'down')) DEFAULT 'up' NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        rolled_back INTEGER DEFAULT 0
      );
    `);
    }

    if (dbType !== SUPPORTED_SQL_DIALECTS_TYPES.SQLITE) {
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_migrations_name ON _sqlbuns_migrations (name);`
      );
    } else {
      await pool.run(
        `CREATE INDEX IF NOT EXISTS idx_migrations_name ON _sqlbuns_migrations (name);`
      );
    }
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
