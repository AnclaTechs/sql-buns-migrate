#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { migrateUp, migrateDown, createMigration } from "../src/index.js";
import { resolveModelsPath } from "../src/utils/resolveModelsPath.js";

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
      .command("create <name>")
      .description("Create a new migration file")
      .action((name) => {
        createMigration(name);
        console.log(chalk.green(`✅ Created migration: ${name}`));
      });

    program
      .command("up")
      .description("Run all pending migrations")
      .action(async () => {
        await migrateUp();
        console.log(chalk.blue("🚀 Migrations applied successfully"));
      });

    program
      .command("down")
      .alias("rollback")
      .description("Revert the last migration")
      .action(async () => {
        await migrateDown();
        console.log(chalk.yellow("🔁 Last migration reverted"));
      });

    program.parse(process.argv);
  } catch (err) {
    console.error(chalk.red("❌ Migration Error:"), err.message);
    process.exit(1);
  }
})();
