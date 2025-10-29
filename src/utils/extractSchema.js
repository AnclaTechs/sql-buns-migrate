export function schemaTopologicalSort(graph) {
  const visited = new Set();
  const temp = new Set();
  const result = [];
  const stack = [];

  function visit(node) {
    if (temp.has(node)) {
      const cycleStart = stack.indexOf(node);
      const cyclePath =
        cycleStart >= 0
          ? stack.slice(cycleStart).concat(node)
          : [...stack, node];
      throw new Error(`Cyclic dependency detected: ${cyclePath.join(" -> ")}`);
    }

    if (!visited.has(node)) {
      temp.add(node);
      stack.push(node);

      for (const dep of graph[node] || []) {
        if (!graph[dep]) graph[dep] = new Set(); // include unknown refs
        visit(dep);
      }

      stack.pop();
      temp.delete(node);
      visited.add(node);
      result.push(node);
    }
  }

  // This ensures isolated nodes are visited
  for (const node of Object.keys(graph)) {
    if (!visited.has(node)) visit(node);
  }

  return result;
}

export function normalizeSchemasForChecksum(oldSchema, currentSchema) {
  let oldFiltered = JSON.parse(JSON.stringify(oldSchema));
  let currentFiltered = JSON.parse(JSON.stringify(currentSchema));

  // Get all model objects from both schemas
  const oldModels = Object.values(oldFiltered);
  const currentModels = Object.values(currentFiltered);

  // Helper to generate a unique key for matching indexes (order-independent)
  function getIndexKey(idx) {
    if (!idx || !idx.fields) return null;
    const fieldsStr = [...idx.fields].sort().join(",");
    return `${fieldsStr}|${idx.unique ? "true" : "false"}`;
  }

  // Iterate over current models to find matches in old
  currentModels.forEach((currentModel) => {
    const currentTable = currentModel.meta?.tableName || currentModel.name;
    if (!currentTable) return; // Skip if no table identifier

    const matchingOldModel = oldModels.find((oldModel) => {
      const oldTable = oldModel.meta?.tableName || oldModel.name;
      return oldTable === currentTable;
    });

    if (!matchingOldModel) return; // No match, skip

    // Now normalize indexes for this matched pair
    const oldIndexes = matchingOldModel.meta?.indexes || [];
    const currentIndexes = currentModel.meta?.indexes || [];

    // Build a map of old indexes by key for quick lookup
    const oldIndexMap = {};
    oldIndexes.forEach((oldIdx) => {
      const key = getIndexKey(oldIdx);
      if (key) oldIndexMap[key] = oldIdx;
    });

    // For each current index, check for match in old and normalize if needed
    currentIndexes.forEach((currentIdx) => {
      const key = getIndexKey(currentIdx);
      if (!key) return; // Skip invalid indexes

      const matchingOldIdx = oldIndexMap[key];
      if (!matchingOldIdx) return; // No match in old, leave as-is (new index)

      // PS: Old always has 'name', so check if current lacks it
      if (!currentIdx.hasOwnProperty("name")) {
        // Delete from old to match lack in current
        delete matchingOldIdx.name;
      }
      // Else: current has 'name' (possibly different value)—keep both as-is
      // If values differ, checksum will detect the change
    });
  });

  return { oldFiltered, currentFiltered };
}

export function extractSchemas(modelsModule) {
  const schemas = {};
  const dependencyGraph = {};

  for (const [name, model] of Object.entries(modelsModule)) {
    const schema = model.toJSON ? model.toJSON() : model;
    schemas[name] = schema;
    if (!dependencyGraph[name]) {
      dependencyGraph[name] = new Set();
    }

    if (schema.relations) {
      for (const rel of Object.values(schema.relations)) {
        if (rel.model && rel.model !== name) {
          const match = Object.entries(modelsModule).reduce(
            (acc, [key, model]) => {
              if (acc === null && model.name === rel.model) {
                return key;
              }
              return acc;
            },
            null
          );

          if (match !== null) {
            try {
              dependencyGraph[match].add(name);
            } catch (err) {
              if (err instanceof TypeError && !dependencyGraph[match]) {
                dependencyGraph[match] = new Set();
                dependencyGraph[match].add(name);
              } else {
                throw err;
              }
            }
          }
        }
      }
    }
  }

  const sorted = schemaTopologicalSort(dependencyGraph);

  const orderedSchemas = {};
  for (const modelName of sorted) {
    orderedSchemas[modelName] = schemas[modelName];
  }

  return orderedSchemas;
}
