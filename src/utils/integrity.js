import chalk from "chalk";
import { getSingleRow, RecordDoesNotExist } from "@anclatechs/sql-buns";
import { diffSchemas } from "./schemaDiffConstructor.js";
import { generateChecksum } from "./generics.js";

export async function inspectDBForDrift(oldSchema, newSchema) {
  // Fetch last applied migration
  let lastMigration;
  try {
    lastMigration = await getSingleRow(`
  SELECT * FROM _sqlbuns_migrations
  WHERE direction = 'up' AND rolled_back = false
  ORDER BY applied_at DESC
  LIMIT 1;
`);
  } catch (err) {
    if (err instanceof RecordDoesNotExist) return null;
    throw err;
  }

  if (!lastMigration) {
    console.warn("⚠️ No previous migrations found, skipping drift check.");
    return;
  }

  // Compare checksum from DB vs locally stored schema hash
  const { checksum } = lastMigration;

  const localChecksum = generateChecksum(oldSchema);

  if (localChecksum !== checksum) {
    console.error(chalk.red("\n⚠️ Schema drift detected!"));
    console.error(
      chalk.red("Your database structure differs from the last known schema.")
    );

    // Optional: auto-generate SQL diff
    const diff = await diffSchemas(oldSchema, newSchema);
    console.log("Detected DB changes that didn’t go through migration files:");
    diff.sql.forEach((q) => console.log("   -", q));

    console.log(
      "\n💡 Recommendation: revert manual DB changes and reapply using `buns-migrate up`."
    );

    process.exit(1);
  } else {
    // PASS
  }
}
