import fs from "fs";
import { createRequire } from "module";
import { resolveModelsPath } from "./resolveModelsPath.js";
const require = createRequire(import.meta.url);
global.require = require;

/**
 * Dynamically loads the user's model definitions ensuring file exists
 */
export async function loadModels() {
  const modelsPath = await resolveModelsPath();

  if (!fs.existsSync(modelsPath)) {
    throw new Error(`❌ Models file not found at ${modelsPath}`);
  }

  try {
    delete require.cache[require.resolve(modelsPath)];
    const modelsModule = require(modelsPath);

    const models =
      modelsModule.default && typeof modelsModule.default === "object"
        ? modelsModule.default
        : modelsModule;

    if (
      !models ||
      typeof models !== "object" ||
      Object.keys(modelsModule).length === 0
    ) {
      throw new Error(`⚠️ No exports found in models file: ${modelsPath}`);
    }

    console.log(`📦 Successfully loaded models from: ${modelsPath}`);
    return modelsModule;
  } catch (err) {
    console.error("❌ Failed to load models:", err);
    throw err;
  }
}
