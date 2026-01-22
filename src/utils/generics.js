import crypto from "crypto";

function canonicalize(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalize);
  }
  const sorted = {};
  Object.keys(obj)
    .sort() // Sort keys alphabetically
    .forEach((key) => {
      sorted[key] = canonicalize(obj[key]);
    });
  return sorted;
}

export function generateChecksum(obj) {
  const canonicalObj = canonicalize(obj);
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalObj))
    .digest("hex");
}

export function isDefinitionEnum(def) {
  return (
    typeof def?.enumTypeName === "string" ||
    def?.type?.toLowerCase().startsWith("enum")
  );
}

export function normalizeDefinitionDefault(def) {
  if (def === undefined || def === null) return null;

  let d = String(def).trim();
  d = d.replace(/::[\w_]+/g, "");
  if (!d.startsWith("'") && isNaN(d)) {
    d = `'${d}'`;
  }
  return d;
}

export function generateEnumTypeName(table, column, choices) {
  const base = `${table}_${column}`;
  const sortedChoices = [...choices].sort();
  const signature = `${base}:${sortedChoices.join("|")}`;
  const hash = crypto
    .createHash("sha1")
    .update(signature)
    .digest("hex")
    .slice(0, 8);

  return `enum_${base}_${hash}`;
}