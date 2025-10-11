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
  if (
    !options.choices ||
    !Array.isArray(options.choices) ||
    options.choices.length === 0
  ) {
    throw new Error("EnumField requires a non-empty 'choices' array.");
  }

  const { choices, default: def, typeName, ...rest } = options;

  if (def && !choices.includes(def)) {
    throw new Error(
      `Default value '${def}' is not one of the allowed choices: ${choices.join(
        ", "
      )}`
    );
  }

  // Build ENUM SQL definition for MySQL/SQLite
  const inlineType = `ENUM(${choices.map((c) => `'${c}'`).join(", ")})`;

  // PostgreSQL style uses CREATE TYPE + reference
  const pgTypeName =
    typeName || `enum_${Math.random().toString(36).substring(2, 8)}`;

  const field = _createField(inlineType, {
    ...rest,
    choices,
    default: def,
    enumTypeName: pgTypeName, // used for PostgreSQL migration to emit CREATE TYPE
  });

  field.toJSON = function () {
    const json = {
      type: inlineType,
      choices,
      default: def,
      null: rest.null,
      comment: rest.comment,
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
  const normalizedRelations = {};
  const normalizedTriggers = {};
  const { relations, triggers, meta } = options;

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
        statements: Array.isArray(statements) ? statements : [statements],
      };
    }
  }

  /**
   *  Model Object
   *  */
  const model = {
    name,
    fields,
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
        Object.entries(fields).map(([key, field]) => {
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
