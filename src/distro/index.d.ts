declare module "@anclatechs/sql-buns-migrate" {
  /**
   * Defines the types of relationships that can exist between two models.
   *
   * Relationships in SQL describe how one table (or model) references another,
   * allowing the migration engine to generate appropriate
   * SQL foreign keys, join tables, or constraints automatically.
   *
   * - `"hasOne"` — A one-to-one relationship.
   *   The current model owns or references exactly one record
   *   in the related model (e.g., a `User` has one `Profile`).
   *
   * - `"hasMany"` — A one-to-many relationship.
   *   The current model can have multiple related records
   *   in the target model (e.g., a `User` has many `Posts`).
   *
   * - `"manyToMany"` — A many-to-many relationship.
   *   Both models reference each other through a join (pivot) table.
   *   This requires specifying a `through` table name and both
   *   `foreignKey` and `otherKey` to link the two sides.
   *
   * @example
   * ```ts
   * const User = defineModel("users", {
   *   id: IntegerField({ primaryKey: true }),
   *   name: CharField(),
   * }, {
   *   relations: {
   *     profile: { type: "hasOne", model: "profiles", foreignKey: "user_id" },
   *     posts: { type: "hasMany", model: "posts", foreignKey: "user_id" },
   *     groups: {
   *       type: "manyToMany",
   *       model: "groups",
   *       through: "user_groups",
   *       foreignKey: "user_id",
   *       otherKey: "group_id",
   *     },
   *   },
   * });
   * ```
   */
  export type RelationType = "hasOne" | "hasMany" | "manyToMany";

  /**
   * Defines a relationship between two models.
   */
  export interface RelationConfig {
    /** Type of relationship — one-to-one, one-to-many, or many-to-many. */
    type: RelationType;

    /** Target model name being referenced. */
    model: string;

    /** Foreign key in the current table that links to the related model. */
    foreignKey: string;

    /** (Optional) Secondary key for many-to-many relations. */
    otherKey?: string;

    /** (Optional) Intermediate table used for many-to-many relations. */
    through?: string;
  }

  /**
   * A collection of all defined relationships for a model,
   * keyed by the relation name (e.g., "posts", "profile").
   */
  export interface ModelRelations {
    [relationName: string]: RelationConfig;
  }

  /**
   * Describes a database index definition for a model table.
   *
   * Example:
   * ```ts
   * indexes: [
   *   { fields: ["email"], unique: true, name: "idx_users_email" },
   * ]
   * ```
   */
  export interface IndexDefinition {
    /** List of one or more field names included in the index. */
    fields: string[];

    /** Marks the index as unique, preventing duplicate combinations of values. */
    unique?: boolean;

    /** Optional custom name for the index (defaults to an auto-generated name). */
    name?: string;
  }

  export interface ModelMeta {
    /** Custom table name override */
    db_table?: string;

    /** Automatically add created_at / updated_at fields */
    timestamps?: boolean;

    /** Developer note or description */
    comment?: string;

    /** Index definitions */
    indexes?: IndexDefinition[];
  }

  /**
   * Describes the structure and constraints of a single model field.
   * Used to define how a column should be created in the database.
   */
  export interface FieldDefinition {
    /** SQL data type (e.g., 'INTEGER', 'VARCHAR', 'TEXT'). */
    type: string;

    /** Whether the field must always have a value (NOT NULL). */
    nullable?: boolean;

    /** Default value assigned if none is provided. */
    default?: any;

    /** Ensures all values in this column are unique. */
    unique?: boolean;

    /** Marks this field as the primary key. */
    primaryKey?: boolean;

    /** Automatically increments the value for new records (if supported). */
    autoIncrement?: boolean;

    /** Maximum number of characters (for string-based fields). */
    maxLength?: number;

    /** Total number of digits (for decimal/numeric fields). */
    maxDigits?: number;

    /** Number of digits after the decimal point (for decimal/numeric fields). */
    decimalPlaces?: number;

    /** Developer comment (stored in DB if supported). */
    comment?: string;

    /** Developer help text (not stored in DB; for documentation only). */
    helpText?: string;
  }

  /**
   *
   * ENUM fields restrict values to a predefined list of choices,
   * commonly used for statuses, roles, or any other categorical values.
   *
   * @template T The literal string type representing possible choices.
   */
  export interface CustomEnumFieldDefinition<T extends string = string> {
    /**
     * Array of allowed string values.
     * Example: `["draft", "published", "archived"]`
     */
    choices: readonly T[];

    /**
     * Default value for the field.
     * Must be one of the defined `choices`.
     */
    default?: T;

    /**
     * Whether the field allows NULL values.
     * Defaults to `false`.
     */
    null?: boolean;

    /**
     * Optional database comment describing the field.
     */
    comment?: string;

    /**
     * Optional developer-facing hint.
     * Not stored in database or migration snapshots.
     */
    helpText?: string;
  }

  /**
   * Defines SQL trigger actions for different database events on a model.
   * Each trigger can run one or more SQL statements automatically.
   */
  export interface ModelTriggers {
    /** Runs before inserting a new record (e.g., set timestamps, validate data). */
    beforeInsert?: string[];

    /** Runs after a record is inserted (e.g., log or sync changes). */
    afterInsert?: string[];

    /** Runs before updating an existing record (e.g., modify values, audit). */
    beforeUpdate?: string[];

    /** Runs after a record is updated (e.g., trigger another table update). */
    afterUpdate?: string[];

    /** Runs before deleting a record (e.g., check constraints, archive data). */
    beforeDelete?: string[];

    /** Runs after a record is deleted (e.g., cleanup related data, log actions). */
    afterDelete?: string[];
  }

  /**
   * Possible JS primitive types accepted for assertParams validation
   */
  export type AllowedJsType =
    | "string"
    | "number"
    | "boolean"
    | "object"
    | "array"
    | "undefined"
    | "function";

  /**
   * Validation rules applicable to a single parameter.
   */
  export interface ValidationRule {
    /** Whether the field is required */
    required?: boolean;

    /** Expected JavaScript data type */
    type?: AllowedJsType;

    /** Minimum numeric value (applies to number type) */
    min?: number;

    /** Maximum numeric value (applies to number type) */
    max?: number;

    /** Enum of allowed values */
    enum?: any[];
  }

  /**
   * Describes a validation object.
   * It must contain exactly one "parameter key" (e.g., `{ age, required: true }`)
   * along with optional validation rules.
   */
  export type ParamValidationObject = ValidationRule & Record<string, any>; // merges your param key + rules dynamically

  /**
   * The input to assertParams:
   * - Single validation object, or
   * - Array of multiple validation objects
   */
  export type AssertParamInput =
    | ParamValidationObject
    | ParamValidationObject[];

  /**
   * Base runtime methods automatically available to every defined model.
   */
  export interface BaseModelContext {
    /** Model name (e.g., "users") */
    name: string;

    /** Model metadata (e.g., table name, comments, indexes) */
    meta?: ModelMeta;

    /** SQL triggers bound to this model */
    triggers?: ModelTriggers;

    /** Relations between this model and others */
    relations?: ModelRelations;

    /**
     * Validates model methods input parameters.
     * Allows both single and array inputs validation rules. Throws if (any) validation fails.
     *
     * Example:
     * ```ts
     * this.assertParams({ id, required: true, type: "number", min: 1 });
     *
     * or
     *
     * this.assertParams([{ id, required: true, type: "number", min: 1 }]);
     *
     * ```
     */
    assertParams(input: ParamValidationObject): void;

    /**
     * Validates model methods input parameters.
     * Allows both single and array inputs validation rules. Throws if (any) validation fails.
     *
     * Example:
     * ```ts
     * this.assertParams({ id, required: true, type: "number", min: 1 });
     *
     * or
     *
     * this.assertParams([{ id, required: true, type: "number", min: 1 }]);
     *
     * ```
     */
    assertParams(inputs: ParamValidationObject[]): void;
  }

  /**
   * Options to customize a model’s behavior, structure, and database interactions.
   */
  export interface DefineModelOptions<M = {}> {
    /** Defines relationships (hasOne, hasMany, manyToMany) with other models. */
    relations?: ModelRelations;

    /** SQL trigger definitions to execute before/after INSERT, UPDATE, or DELETE operations. */
    triggers?: ModelTriggers;

    /** Metadata for the model such as table name, comments, and index definitions. */
    meta?: ModelMeta;

    /**
     * Custom methods bound to the model instance.
     * Each method automatically receives the model context (`this`) so it can access
     * helpers like `this.assertParams`, `this.meta`, etc.
     * */
   methods?: {
    [K in keyof M]: (this: BaseModelContext & M, ...args: any[]) => any;
  } & ThisType<BaseModelContext & M>;
  }

  /**
   * Defines a new SQL model structure with its fields, relations, triggers, and metadata.
   *
   * Example:
   * ```ts
   * const User = defineModel("users", {
   *   id: { type: IntegerField, primaryKey: true, autoIncrement: true },
   *   email: { type: CharacterField, unique: true},
   *   phone: { type: CharacterField, nullable: true},
   *
   * }, {
   *   relations: {
   *     posts: { type: "hasMany", model: "posts", foreignKey: "user_id" }
   *   },
   *   triggers: {
   *     beforeInsert: ["SET NEW.created_at = CURRENT_TIMESTAMP"]
   *   },
   *   meta: {
   *     db_table: "app_users",
   *     comment: "Registered application users",
   *     indexes: [{ fields: ["email"], unique: true }]
   *   }
   *   methods: {
   *      async getUserProfile(id: number) {
   *          this.assertParams({ id, required: true, type: "number", min: 1 });
   *          return await pool.query("SELECT * FROM users WHERE id = ?", [id]);
   *      }
   *   }
   * });
   * ```
   */
export function defineModel<
  M extends Record<string, (...args: any[]) => any> = {},
  O = {}
>(
  name: string,
  fields: Record<string, FieldDefinition | CustomEnumFieldDefinition>,
  options?: O & (DefineModelOptions<M> & { methods?: M })
): BaseModelContext & {
  name: string;
  fields: Record<string, FieldDefinition>;
  relations?: ModelRelations;
  triggers?: ModelTriggers;
  meta?: ModelMeta;
  methods: M;
} & M {
  // Base model object
  const model: any = {
    name,
    fields,  // Note: You may need to cast if CustomEnumFieldDefinition isn't assignable to FieldDefinition
    relations: options?.relations,
    triggers: options?.triggers,
    meta: options?.meta,
    methods: {},
  };

  // Bind custom methods
  if ((options as any)?.methods) {
    for (const [key, fn] of Object.entries((options as any).methods)) {
      model.methods[key] = fn.bind(model);
      // Optional: model[key] = fn.bind(model); // For direct User.create() access
    }
  }

  return model;
}
  //COMMON FIELD HELPERS
  export const Fields: {
    IntegerField: (options?: Partial<FieldDefinition>) => FieldDefinition;
    DecimalField: (options?: Partial<FieldDefinition>) => FieldDefinition;
    FloatingPointField: (options?: Partial<FieldDefinition>) => FieldDefinition;
    CharField: (options?: Partial<FieldDefinition>) => FieldDefinition;
    TextField: (options?: Partial<FieldDefinition>) => FieldDefinition;
    EnumField: (
      options?: Partial<CustomEnumFieldDefinition>
    ) => CustomEnumFieldDefinition;
    DateField: (options?: Partial<FieldDefinition>) => FieldDefinition;
    DateTimeField: (options?: Partial<FieldDefinition>) => FieldDefinition;
    BlobField: (options?: Partial<FieldDefinition>) => FieldDefinition;
    BooleanField: (options?: Partial<FieldDefinition>) => FieldDefinition;
    UUIDField: (options?: Partial<FieldDefinition>) => FieldDefinition;
    JsonField: (options?: Partial<FieldDefinition>) => FieldDefinition;
    XmlField: (options?: Partial<FieldDefinition>) => FieldDefinition;
  };
}
