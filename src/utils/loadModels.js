const path = require("path");
const fs = require("fs");
const { resolveModelsPath } = require("./resolveModelsPath.js");

/**
 * Dynamically loads the user's model definitions ensuring file exists
 */
export async function loadModels() {
  const modelsPath = resolveModelsPath();

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
