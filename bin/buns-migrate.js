#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { migrateUp, migrateDown, createMigration } from "../src/index.js";
import { resolveModelsPath } from "../src/utils/resolveModelsPath.js";
import { inspectdb } from "../src/utils/introspect.js";

const program = new Command();

(async () => {
  try {
    const modelsPath = await resolveModelsPath();
    console.log(chalk.cyan(`📦 Models file detected at: ${modelsPath}`));

    program
      .name("buns-migrate")
      .description("SQL-Buns migration CLI")
      .version("1.0.0");

    program
      .command("inspectdb")
      .description("Introspects existing DB and writes models/index.js")
      .action(async () => {
        await inspectdb();
        console.log(chalk.green(`✅ Completed successfully`));
      });

    program
      .command("create <name>")
      .description("Create a new migration file")
      .action(async (name) => {
        name = String(name).toLowerCase();
        await createMigration(name);
      });

    program
      .command("up")
      .description("Run all pending migrations")
      .action(async () => {
        await migrateUp();
      });

    program
      .command("down")
      .alias("rollback")
      .description("Revert the last migration")
      .action(async () => {
        await migrateDown();
      });

    program.parse(process.argv);
  } catch (err) {
    console.error(chalk.red("❌ Migration Error:"), err.message);
    process.exit(1);
  }
})();
