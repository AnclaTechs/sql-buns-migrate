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
