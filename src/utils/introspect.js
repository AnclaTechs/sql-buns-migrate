import fs from "fs";
import path from "path";
import readline from "readline";
import { pool } from "@anclatechs/sql-buns";
import { generateChecksum } from "./generics.js";
import {
  SUPPORTED_SQL_DIALECTS,
  SUPPORTED_SQL_DIALECTS_TYPES,
} from "./constants.js";
import {
  extractSchemas,
  normalizeSchemasForChecksum,
} from "./extractSchema.js";
import { modelDataToJSON } from "./serializeModelToJson.js";
import { loadModels } from "./loadModels.js";

const pkgPath = path.join(process.cwd(), "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const userPath = pkg?.sqlBuns?.modelsPath;

const defaultPath = path.join(process.cwd(), "database", "models", "index.js");

const resolvedModelPath = userPath
  ? path.resolve(process.cwd(), userPath)
  : defaultPath;

if (!fs.existsSync(resolvedModelPath)) {
  throw new Error(
    `❌ Please create database/models/index.js in your root folder or set "sqlBuns.modelsPath" in package.json`
  );
}

const MIGRATIONS_DIR = path.join(process.cwd(), "database/migrations");
const SNAPSHOT_FILE = path.join(MIGRATIONS_DIR, "schema_snapshot.json");
const MODELS_PATH = resolvedModelPath;

/**
 * Prompt for confirmation before overwriting models/index.js
 */
async function confirmOverwrite(filePath) {
  if (!fs.existsSync(filePath)) return true;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${filePath} already exists. Overwrite? (y/N): `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y");
    });
  });
}

/**
 * Main inspectdb() function — introspects existing DB and writes models/index.js
 */
export async function inspectdb() {
  console.log("🔍 Inspecting connected database...");

  const dbType = process.env.DATABASE_ENGINE;

  let connection = null;
  const isPostgres = dbType === SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES;
  const isMySQL = dbType === SUPPORTED_SQL_DIALECTS_TYPES.MYSQL;
  const isSQLite = dbType === SUPPORTED_SQL_DIALECTS_TYPES.SQLITE;
  const useConnection = isPostgres || isMySQL;

  if (isPostgres) {
    connection = await pool.connect();
  } else if (isMySQL) {
    connection = await pool.getConnection();
  }

  if (!SUPPORTED_SQL_DIALECTS.includes(dbType)) {
    throw new Error(
      `${dbType} DATABASE_ENGINE not supported. Review .env file.`
    );
  }

  console.log(`📦 Detected database: ${dbType}`);

  try {
    // Fetch all tables
    let tables = [];
    if (isPostgres) {
      const res = await connection.query(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
      `);
      tables = res.rows.map((r) => r.table_name);
    } else if (isMySQL) {
      const [rows] = await connection.query("SHOW TABLES;");
      tables = rows.map((r) => Object.values(r)[0]);
    } else if (isSQLite) {
      const res = await pool.all(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
      );
      tables = res.map((r) => r.name);
    }

    if (tables.length === 0) {
      console.log("No tables found in this database.");
      return;
    }

    console.log(`🧱 Found ${tables.length} tables: ${tables.join(", ")}`);

    // Gather model schemas
    const schema = {};
    const dependencies = []; // store foreign key relationships temporarily

    for (const table of tables) {
      const model = await introspectTable(connection || pool, dbType, table);
      const fks = await introspectForeignKeys(
        connection || pool,
        dbType,
        table
      );

      // Collect dependency info — don't assign yet
      for (const [refTable, rel] of Object.entries(fks)) {
        dependencies.push({
          parent: rel.model, // referenced table
          child: table, // table that holds the FK
          type: rel.type,
          foreignKey: rel.foreignKey,
          through: rel.through || null,
        });
      }

      const tableObj = {
        ...model,
        relations: {},
      };

      tableObj.toJSON = modelDataToJSON.bind(tableObj);

      schema[table] = tableObj;
    }

    // Build specifically from parent-side relations
    for (const dep of dependencies) {
      if (!schema[dep.parent]) continue;
      const parentRelations = schema[dep.parent].relations;

      // Assign relation only on the parent side
      parentRelations[dep.child] = {
        type: dep.type,
        model: dep.child,
        foreignKey: dep.foreignKey,
        ...(dep.through ? { through: dep.through } : {}),
      };
    }

    const modelFile = buildModelFile(schema);

    const proceed = await confirmOverwrite(MODELS_PATH);
    if (!proceed) {
      console.log("🚫 Operation cancelled.");
      process.exit(0);
    }

    fs.writeFileSync(MODELS_PATH, modelFile);
    console.log(`✅ Generated: ${MODELS_PATH}`);

    // Create baseline migration
    if (!fs.existsSync(MIGRATIONS_DIR)) fs.mkdirSync(MIGRATIONS_DIR);

    const models = await loadModels();
    const currentSchema = extractSchemas(models);
    const { oldFiltered, currentFiltered } = normalizeSchemasForChecksum(
      {},
      currentSchema
    );

    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(currentSchema, null, 2));

    const baselineFile = path.join(
      MIGRATIONS_DIR,
      "0000_initial_bootstrap.sql"
    );
    fs.writeFileSync(
      baselineFile,
      `-- Baseline migration (auto-generated by inspectdb): ${new Date()}\n`
    );
    console.log(`📜 Created baseline migration: ${baselineFile}`);

    // Checksum is generated on the Normalised filter not the raw Model file
    const checksum = generateChecksum(currentFiltered);

    await recordBaselineMigration(connection || pool, checksum);

    console.log("✅ Inspectdb completed successfully.");
  } catch (err) {
    console.error("❌ Inspectdb failed:", err.message);
  } finally {
    if (useConnection) connection.release();
  }
}

/**
 * Introspect columns and constraints for a given table
 */
async function introspectTable(client, dbType, table) {
  const fields = {};

  if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES) {
    const res = await client.query(`
      SELECT
        c.column_name,
        c.data_type,
        c.is_nullable,
        c.column_default,
        (SELECT EXISTS (
          SELECT 1 FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = tc.constraint_name
          WHERE tc.table_name = c.table_name
            AND tc.constraint_type = 'PRIMARY KEY'
            AND kcu.column_name = c.column_name
        )) AS is_primary
      FROM information_schema.columns c
      WHERE c.table_schema = 'public' AND c.table_name = '${table}';
    `);

    // Detect enums
    const enumRes = await client.query(`
      SELECT
        c.column_name,
        e.enumlabel AS enum_label
      FROM information_schema.columns c
      JOIN pg_type t ON t.typname = c.udt_name
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE c.table_schema = 'public' AND c.table_name = '${table}'
      ORDER BY c.column_name, e.enumsortorder;
    `);

    const enumMap = {};
    for (const row of enumRes.rows) {
      if (!enumMap[row.column_name]) enumMap[row.column_name] = [];
      enumMap[row.column_name].push(row.enum_label);
    }

    for (const col of res.rows) {
      const isSerial =
        col.column_default &&
        /nextval\('.*_seq'::regclass\)/.test(col.column_default);

      const isEnum = !!enumMap[col.column_name];

      fields[col.column_name] = {
        type: isEnum ? "EnumField" : mapPgType(col.data_type),
        choices: isEnum ? enumMap[col.column_name] : undefined,
        nullable: col.is_nullable !== "NO",
        default: col.column_default || undefined,
        primaryKey: col.is_primary,
        autoIncrement: isSerial,
      };
    }
  } else if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.MYSQL) {
    const [rows] = await client.query(`DESCRIBE \`${table}\`;`);

    for (const col of rows) {
      const match = col.Type.match(/^enum\((.+)\)$/i);
      const choices = match
        ? match[1].split(",").map((v) => v.trim().replace(/^'|'$/g, ""))
        : undefined;

      fields[col.Field] = {
        type: choices ? "EnumField" : mapMySQLType(col.Type),
        choices,
        nullable: col.Null !== "NO",
        default: col.Default || undefined,
        primaryKey: col.Key === "PRI",
        autoIncrement: col.Extra.includes("auto_increment"),
      };
    }
  } else if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.SQLITE) {
    const res = await client.all(`PRAGMA table_info(${table});`);
    const tableDef = await client.get(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name=?`,
      [table]
    );

    const createSQL = tableDef?.sql || "";

    for (const col of res) {
      const isAutoInc = /AUTOINCREMENT/i.test(createSQL) && col.pk === 1;
      fields[col.name] = {
        type: mapSQLiteType(col.type),
        nullable: col.notnull !== 1,
        default: col.dflt_value || undefined,
        primaryKey: col.pk === 1,
        autoIncrement: isAutoInc,
      };
    }

    // Detect CHECK enums
    const checkMatches = [
      ...createSQL.matchAll(
        /["'`]?(\w+)["'`]?\s+(?:TEXT|CHAR|VARCHAR)\s+CHECK\s*\(\s*\1\s+IN\s*\(([^)]+)\)\s*\)/gi
      ),
    ];

    for (const [, colName, valuesRaw] of checkMatches) {
      const choices = valuesRaw
        .split(",")
        .map((v) => v.trim().replace(/^'|'$/g, ""));

      if (fields[colName]) {
        fields[colName].type = "EnumField";
        fields[colName].choices = choices;
      }
    }
  }

  return { name: table, fields };
}

/**
 * Extract foreign key relations
 */
async function introspectForeignKeys(client, dbType, table) {
  const foreignKeys = [];

  // 1️⃣ Gather FK metadata per dialect
  if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES) {
    const res = await client.query(`
      SELECT
        kcu.column_name AS fk_column,
        ccu.table_name AS ref_table,
        ccu.column_name AS ref_column,
        tc.constraint_name
      FROM information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_name = '${table}';
    `);
    foreignKeys.push(...res.rows);
  } else if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.MYSQL) {
    const [rows] = await client.query(`
      SELECT
        COLUMN_NAME AS fk_column,
        REFERENCED_TABLE_NAME AS ref_table,
        REFERENCED_COLUMN_NAME AS ref_column,
        CONSTRAINT_NAME
      FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_NAME = '${table}' AND REFERENCED_TABLE_NAME IS NOT NULL;
    `);
    foreignKeys.push(...rows);
  } else if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.SQLITE) {
    const res = await client.all(`PRAGMA foreign_key_list(${table});`);
    for (const row of res) {
      foreignKeys.push({
        fk_column: row.from,
        ref_table: row.table,
        ref_column: row.to,
      });
    }
  }

  // No FKs
  if (foreignKeys.length === 0) return {};

  // 2️⃣ Detect if this is a join table
  const isJoinTable = await detectJoinTable(client, dbType, table, foreignKeys);

  // For join tables, just return enough info to mark them as "through"
  if (isJoinTable) {
    const [fk1, fk2] = foreignKeys;
    return {
      [fk1.ref_table]: {
        type: "manyToMany",
        model: fk1.ref_table,
        through: table,
        joinColumn: fk1.fk_column,
        inverseJoinColumn: fk2.fk_column,
      },
      [fk2.ref_table]: {
        type: "manyToMany",
        model: fk2.ref_table,
        through: table,
        joinColumn: fk2.fk_column,
        inverseJoinColumn: fk1.fk_column,
      },
    };
  }

  // 3️⃣ For normal FK tables, return minimal info (the direction is resolved later)
  const relations = {};
  for (const fk of foreignKeys) {
    const unique = await isColumnUnique(client, dbType, table, fk.fk_column);
    relations[fk.ref_table] = {
      type: unique ? "hasOne" : "hasMany",
      model: fk.ref_table,
      foreignKey: fk.fk_column,
      ref_column: fk.ref_column,
    };
  }

  return relations;
}

/**
 * Detects if table looks like a join table
 */
async function detectJoinTable(client, dbType, table, fks) {
  if (fks.length !== 2) return false;

  // check number of columns in table
  let columnCount = 0;
  if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES) {
    const res = await client.query(`
      SELECT COUNT(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = '${table}';
    `);
    columnCount = parseInt(res.rows[0].count);
  } else if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.MYSQL) {
    const [rows] = await client.query(`SHOW COLUMNS FROM \`${table}\`;`);
    columnCount = rows.length;
  } else if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.SQLITE) {
    const res = await client.all(`PRAGMA table_info(${table});`);
    columnCount = res.length;
  }

  // If table has only 2-3 columns and both are FKs — it's likely a join table
  return columnCount <= 3 && fks.length === 2;
}

/**
 * Checks if a column is unique or primary key
 */
async function isColumnUnique(client, dbType, table, column) {
  if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES) {
    const res = await client.query(`
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
        WHERE tc.table_name = '${table}'
          AND (tc.constraint_type = 'UNIQUE' OR tc.constraint_type = 'PRIMARY KEY')
          AND ccu.column_name = '${column}'
      ) AS is_unique;
    `);
    return res.rows[0].is_unique;
  } else if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.MYSQL) {
    const [rows] = await client.query(`
      SHOW INDEX FROM \`${table}\` WHERE Column_name = '${column}' AND (Non_unique = 0);
    `);
    return rows.length > 0;
  } else if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.SQLITE) {
    const res = await client.all(`PRAGMA index_list(${table});`);
    for (const idx of res) {
      if (idx.unique) {
        const cols = await client.all(`PRAGMA index_info(${idx.name});`);
        if (cols.some((c) => c.name === column)) return true;
      }
    }
    return false;
  }
}

/**
 * Map DB-specific data types to your internal Field types
 */
function mapPgType(type) {
  const t = type.toLowerCase();

  switch (true) {
    // Numbers
    case /int|serial|smallint|bigint/.test(t):
      return "IntegerField";
    case /numeric|decimal/.test(t):
      return "DecimalField";
    case /real|double\s+precision|float/.test(t):
      return "FloatingPointField";

    // Text
    case /char|character varying|varchar/.test(t):
      return "CharField";
    case /text|json|jsonb|xml/.test(t):
      return "TextField";

    // Boolean
    case /bool/.test(t):
      return "BooleanField";

    // Temporal
    case /timestamp/.test(t):
      return "DateTimeField";
    case /\btime(?!stamp)\b/.test(t):
      return "TimeField";
    case /\bdate\b/.test(t):
      return "DateField";

    // Binary / UUID
    case /uuid/.test(t):
      return "UUIDField";
    case /bytea/.test(t):
      return "BlobField";

    // Default
    default:
      return "TextField";
  }
}

function mapMySQLType(type) {
  const t = type.toLowerCase();

  switch (true) {
    // Integers
    case /\b(int|tinyint|smallint|mediumint|bigint)\b/.test(t):
      return "IntegerField";

    // Decimals / Numerics
    case /\b(decimal|numeric)\b/.test(t):
      return "DecimalField";

    // Floating point
    case /\b(float|double|real)\b/.test(t):
      return "FloatingPointField";

    // Boolean (MySQL represents BOOLEAN as TINYINT(1))
    case /\bbool|boolean|tinyint\(1\)\b/.test(t):
      return "BooleanField";

    // Character types
    case /\b(char|varchar)\b/.test(t):
      return "CharField";

    // Text types
    case /\b(text|tinytext|mediumtext|longtext)\b/.test(t):
      return "TextField";

    // Temporal types
    case /\b(datetime|timestamp)\b/.test(t):
      return "DateTimeField";
    case /\bdate\b/.test(t):
      return "DateField";
    case /\btime\b/.test(t):
      return "TimeField";

    // Binary types
    case /\b(blob|tinyblob|mediumblob|longblob|binary|varbinary|bit)\b/.test(t):
      return "BlobField";

    // JSON
    case /\bjson\b/.test(t):
      return "JsonField";

    // Enumerations
    case /\b(enum|set)\b/.test(t):
      return "EnumField";

    // UUID (commonly stored as CHAR(36) or BINARY(16))
    case /\buuid\b/.test(t):
    case /\bchar\(36\)\b/.test(t):
    case /\bbinary\(16\)\b/.test(t):
      return "UUIDField";

    // Default fallback
    default:
      return "TextField";
  }
}
function mapSQLiteType(type) {
  const t = type.toLowerCase();

  switch (true) {
    case t.includes("int"):
      return "IntegerField";

    case t.includes("real") || t.includes("floa") || t.includes("doub"):
      return "FloatingPointField";

    case t.includes("bool"):
      return "BooleanField";

    case t.includes("date") && !t.includes("datetime"):
      return "DateField";

    case t.includes("datetime") ||
      t.includes("time") ||
      t.includes("timestamp"):
      return "DateTimeField";

    case t.includes("text") || t.includes("char") || t.includes("clob"):
      return "TextField";

    case t.includes("blob"):
      return "BlobField";

    case t.includes("json"):
      return "JsonField";

    default:
      return "TextField";
  }
}

/**
 * Generate the models/index.js file content
 */
function buildModelFile(schema) {
  let file = `import { defineModel, Fields } from "@anclatechs/sql-buns-migrate";\n\n`;

  for (const [table, def] of Object.entries(schema)) {
    file += `export const ${camelCase(def.name)} = defineModel("${
      def.name
    }", {\n`;
    for (const [col, info] of Object.entries(def.fields)) {
      file += `  ${col}: { type: Fields.${info.type}${
        info.nullable ? ", nullable: true" : ""
      }`;
      if (info.primaryKey) {
        file += `, primaryKey: true`;
      }
      if (info.autoIncrement) {
        file += `, autoIncrement: true`;
      }
      if (info.choices) {
        file += `, choices: ${JSON.stringify(info.choices)}`;
      }
      if (info.default) {
        const strippedDefault = info.default.replace(/^["']+|["']+$/g, "");
        file += `, default: "${strippedDefault}"`;
      }
      file += " },\n";
    }
    file += "}, {\n";

    if (Object.keys(def.relations).length) {
      file += "  relations: {\n";
      for (const [rel, info] of Object.entries(def.relations)) {
        file += `    ${rel}: { type: "${info.type}", model: "${info.model}", foreignKey: "${info.foreignKey}"`;

        // Only add "through" if it exists
        if (info.through) {
          file += `, through: "${info.through}"`;
        }

        file += " },\n";
      }
      file += "  },\n";
    }

    file += `  meta: { tableName: "${def.name}" }\n});\n\n`;
  }

  return file.trim() + "\n";
}

/**
 * Insert a baseline migration record
 */
async function recordBaselineMigration(client, checksum) {
  const dbType = process.env.DATABASE_ENGINE;
  const migrationName = "0000_initial_inspection.sql";

  // Create table
  if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _sqlbuns_migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        checksum VARCHAR(64) NOT NULL,
        previous_checksum VARCHAR(64),
        direction VARCHAR(10) CHECK (direction IN ('up', 'down')) DEFAULT 'up' NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        rolled_back BOOLEAN DEFAULT FALSE,
        rolled_back_at TIMESTAMP
      );
    `);
    await client.query(
      `INSERT INTO _sqlbuns_migrations (name, direction, checksum) VALUES ($1, $2, $3) ON CONFLICT (name) DO NOTHING;`,
      [migrationName, "up", checksum]
    );
  } else if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.MYSQL) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _sqlbuns_migrations (
        id INTEGER AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        checksum VARCHAR(64) NOT NULL,
        previous_checksum VARCHAR(64),
        direction VARCHAR(10) CHECK (direction IN ('up', 'down')) DEFAULT 'up' NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        rolled_back BOOLEAN DEFAULT FALSE,
        rolled_back_at TIMESTAMP
      );
    `);
    await client.query(
      `INSERT INTO _sqlbuns_migrations (name, direction, checksum) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE checksum = checksum;`,
      [migrationName, "up", checksum]
    );
  } else if (dbType === SUPPORTED_SQL_DIALECTS_TYPES.SQLITE) {
    await client.run(`
      CREATE TABLE IF NOT EXISTS _sqlbuns_migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR(255) NOT NULL UNIQUE,
        checksum VARCHAR(64) NOT NULL,
        previous_checksum VARCHAR(64),
        direction VARCHAR(10) CHECK (direction IN ('up', 'down')) DEFAULT 'up' NOT NULL,
        applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        rolled_back INTEGER DEFAULT 0,
        rolled_back_at TIMESTAMP
      );
    `);
    await client.run(
      `INSERT OR IGNORE INTO _sqlbuns_migrations (name, direction, checksum) VALUES (?, ?, ?);`,
      [migrationName, "up", checksum]
    );
  }
}

function camelCase(str) {
  return str
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}
