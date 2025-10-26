import {
  SUPPORTED_SQL_DIALECTS,
  SUPPORTED_SQL_DIALECTS_TYPES,
} from "../utils/constants.js";

function _normalizeOptions(options, defaults = {}) {
  /**
   * Ensures consistent ordering and managment of default values
   *  */
  const final = { ...defaults, ...options };
  return Object.fromEntries(
    Object.entries(final).filter(([key, value]) => value !== undefined)
  );
}

function _createField(type, options = {}, defaults = {}) {
  const field = {
    type,
    ..._normalizeOptions(options, defaults),
    toJSON() {
      return {
        type,
        ..._normalizeOptions(options, defaults),
      };
    },
  };
  return field;
}

function _normalizeSQLForJSON(sql) {
  if (typeof sql === "string") {
    let clean = sql.trim();

    if (
      (clean.startsWith("`") && clean.endsWith("`")) ||
      (clean.startsWith('"') && clean.endsWith('"')) ||
      (clean.startsWith("'") && clean.endsWith("'"))
    ) {
      clean = clean.slice(1, -1);
    }

    clean = clean.replace(/\s+/g, " ").trim();

    clean = clean.replace(/"/g, "'");

    clean = clean.replace(/;?\s*$/, ";");

    return clean;
  } else if (typeof sql === "object" && sql !== null) {
    const cleaned = { ...sql };
    if (typeof cleaned.body === "string") {
      cleaned.body = _normalizeSQLForJSON(cleaned.body);
    }
    if (typeof cleaned.when === "string") {
      cleaned.when = _normalizeSQLForJSON(cleaned.when);
    }
    return cleaned;
  } else {
    throw new Error("Unexpected SQL type");
  }
}

function _formatSQLArray(statements) {
  return statements.map((sql) => _normalizeSQLForJSON(sql));
}

export const IntegerField = (options = {}) => {
  return _createField("INTEGER", options, {
    autoIncrement: false,
    primaryKey: false,
  });
};

export const DecimalField = (options = {}) => {
  return _createField(
    "DECIMAL",
    { precision: options.maxDigits, scale: options.decimalPlaces, ...options },
    { precision: 10, scale: 2 }
  );
};

export const FloatingPointField = (options = {}) => {
  return _createField("FLOAT", options);
};

export const CharField = (options = {}) => {
  return _createField("VARCHAR", options, { maxLength: 255 });
};

export const TextField = (options = {}) => {
  return _createField("TEXT", options);
};

export const EnumField = (options = {}) => {
  const supportedENUMDialects = SUPPORTED_SQL_DIALECTS;

  const { choices, default: def, typeName, ...rest } = options;

  const dialect = process.env.DATABASE_ENGINE;

  // Normalize and validate dialect
  const engine = (dialect || "").toLowerCase();

  if (!supportedENUMDialects.includes(engine)) {
    const supported = supportedENUMDialects.join(", ");
    throw new Error(
      `❌ Unsupported or missing DATABASE_ENGINE for EnumField.\n` +
        `Received: "${dialect || "undefined"}"\n` +
        `Supported engines: ${supported}`
    );
  }

  // Validate choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("EnumField requires a non-empty 'choices' array.");
  }

  // Validate default
  if (def && !choices.includes(def)) {
    throw new Error(
      `Default value '${def}' is not one of the allowed choices: ${choices.join(
        ", "
      )}`
    );
  }

  // Handle database-specific type definitions
  let inlineType;
  let enumTypeName = null;

  switch (dialect.toLowerCase()) {
    case SUPPORTED_SQL_DIALECTS_TYPES.MYSQL:
      inlineType = `ENUM(${choices.map((c) => `'${c}'`).join(", ")})`;
      break;

    case SUPPORTED_SQL_DIALECTS_TYPES.SQLITE:
      // SQLite doesn't support ENUM natively, so we simulate it with CHECK
      inlineType = `TEXT CHECK(${rest.name || "value"} IN (${choices
        .map((c) => `'${c}'`)
        .join(", ")}))`;
      break;

    case SUPPORTED_SQL_DIALECTS_TYPES.POSTGRES:
      enumTypeName =
        typeName || `enum_${Math.random().toString(36).substring(2, 8)}`;
      inlineType = enumTypeName; // references a type to be created elsewhere
      break;

    default:
      throw new Error(
        `Unsupported SQL dialect '${dialect}'. Use ${SUPPORTED_SQL_DIALECTS.join(
          ","
        )}.`
      );
  }

  // ✅ Build field definition (assuming _createField wraps metadata)
  const field = _createField(inlineType, {
    ...rest,
    choices,
    default: def,
    enumTypeName,
  });

  // ✅ JSON representation for migration or schema export
  field.toJSON = function () {
    const json = {
      type: inlineType,
      choices,
      default: def,
      null: rest.null,
      comment: rest.comment,
      dialect,
    };
    return _normalizeOptions(json);
  };

  return field;
};

export const DateField = (options = {}) => {
  return _createField("DATE", options);
};

export const DateTimeField = (options = {}) => {
  return _createField("DATETIME", options, { default: "CURRENT_TIMESTAMP" });
};

export const BlobField = (options = {}) => {
  return _createField("BLOB", options);
};

export const BooleanField = (options = {}) => {
  return _createField("BOOLEAN", options, { default: false });
};

export const UUIDField = (options = {}) => {
  return _createField("UUID", options, { default: "gen_random_uuid()" });
};

export const JsonField = (options = {}) => {
  return _createField("JSON", options);
};

export const XmlField = (options = {}) => {
  return _createField("XML", options);
};

export function defineModel(name, fields, options = {}) {
  const normalizedFields = {};
  const normalizedRelations = {};
  const normalizedTriggers = {};
  const { relations, triggers, meta } = options;

  /** Normalize Fields */
  for (const [fieldName, fieldDef] of Object.entries(fields)) {
    const { type, ...options } = fieldDef;
    if (typeof type === "function") {
      normalizedFields[fieldName] = type(options);
    } else {
      normalizedFields[fieldName] = fieldDef;
    }
  }

  /**
   *  Validate & Normalize Relations
   * */
  if (relations) {
    for (const [relName, relConfig] of Object.entries(relations)) {
      const { type, model, foreignKey, otherKey, through } = relConfig;

      if (!["hasOne", "hasMany", "manyToMany"].includes(type)) {
        throw new Error(
          `Invalid relation type '${type}' in ${name}.${relName}`
        );
      }

      normalizedRelations[relName] = {
        type,
        model,
        foreignKey,
        otherKey,
        through,
      };
    }
  }

  /**
   *  Normalize Triggers
   *  */
  if (triggers) {
    const mapping = {
      beforeInsert: { timing: "BEFORE", event: "INSERT" },
      afterInsert: { timing: "AFTER", event: "INSERT" },
      beforeUpdate: { timing: "BEFORE", event: "UPDATE" },
      afterUpdate: { timing: "AFTER", event: "UPDATE" },
      beforeDelete: { timing: "BEFORE", event: "DELETE" },
      afterDelete: { timing: "AFTER", event: "DELETE" },
    };

    for (const [key, statements] of Object.entries(triggers)) {
      if (!mapping[key]) continue;

      normalizedTriggers[key] = {
        ...mapping[key],
        statements: Array.isArray(statements)
          ? _formatSQLArray(statements)
          : _formatSQLArray([statements]),
      };
    }
  }

  /**
   *  Model Object
   *  */
  const model = {
    name,
    fields: normalizedFields,
    relations: normalizedRelations,
    triggers: normalizedTriggers,
    meta: meta || {},
    methods: {},

    /**
     *  JSON Representation Function
     *   */
    toJSON() {
      // Remove helpText and comment from fields
      const filteredFields = Object.fromEntries(
        Object.entries(normalizedFields).map(([key, field]) => {
          const { helpText, comment, ...rest } = field;
          return [
            key,
            typeof field.toJSON === "function" ? field.toJSON() : rest,
          ];
        })
      );

      // Remove comment from meta
      const filteredMeta = (() => {
        if (!this.meta) return {};
        const { comment, helpText, ...restMeta } = this.meta;
        return restMeta;
      })();

      return {
        name: this.name,
        fields: filteredFields,
        relations: this.relations,
        triggers: this.triggers,
        meta: filteredMeta,
        //methods are excluded
      };
    },
  };

  /**
   * ASSERT PARAMS
   * Allows both single and array inputs.
   */
  model.assertParams = function (input) {
    const validateOne = (obj) => {
      const paramEntries = Object.entries(obj).filter(
        ([key]) => !["required", "type", "min", "max", "enum"].includes(key)
      );

      if (paramEntries.length !== 1) {
        throw new Error(
          `assertParams: Expected exactly one parameter key, got ${paramEntries.length}`
        );
      }

      const [[paramName, value]] = paramEntries;
      const rules = { ...obj };
      delete rules[paramName];

      const fail = (msg) => {
        throw new Error(`Validation failed for '${paramName}': ${msg}`);
      };

      if (rules.required && (value === undefined || value === null)) {
        fail("is required");
      }

      if (rules.type && typeof value !== rules.type) {
        fail(`must be of type ${rules.type}, got ${typeof value}`);
      }

      if (
        rules.min !== undefined &&
        typeof value === "number" &&
        value < rules.min
      ) {
        fail(`must be >= ${rules.min}`);
      }

      if (
        rules.max !== undefined &&
        typeof value === "number" &&
        value > rules.max
      ) {
        fail(`must be <= ${rules.max}`);
      }

      if (rules.enum && !rules.enum.includes(value)) {
        fail(`must be one of: ${rules.enum.join(", ")}`);
      }
    };

    if (Array.isArray(input)) {
      input.forEach(validateOne);
    } else {
      validateOne(input);
    }
  };

  /**
   * --- Bind model methods only if provided ---
   * This ensures `this` context points to the model instance.
   */
  if (options.methods) {
    for (const [name, fn] of Object.entries(options.methods)) {
      model.methods[name] = fn.bind(model);
    }
  }

  return model;
}

// Unified export object
export const models = {
  defineModel,
  IntegerField,
  DecimalField,
  FloatingPointField,
  CharField,
  TextField,
  DateField,
  DateTimeField,
  BlobField,
  BooleanField,
  UUIDField,
  JsonField,
  XmlField,
};

export default models;
