# SQL-Buns-Migrate 🥯

SQL-Buns Migrate is the official migration tool for [@anclatechs/sql-buns](https://www.npmjs.com/package/@anclatechs/sql-buns). Focusing on simplicity, predictability, and control — built for developers who love raw SQL but want structured schema evolution.

#### ✨ Core Features

- Database modeling with `defineModel`
- Simple, file-based migrations with intuitive migration history tracking
- Forward (up) and backward (down) migrations with generated `.sql` and `.js` files
- Works with PostgreSQL, MySQL, and SQLite
- Zero ORM dependency
- Auto-inspection with `inspectdb`
- Built-in validation via `this.assertParams`
- Hooks and triggers support for post SQL insert/update logic
- Custom model methods accessible via `Model.methods.methodName()`
- CLI commands for creating, applying, and rolling back migrations



### 📦 Installation
```bash
npm install sql-buns-migrate
```
Or
```bash
yarn add sql-buns-migrate
```
<hr/>

### 🧱 Database Modeling

Models are defined with `defineModel()`, using structured field definitions, metadata, and optional relations, triggers, and methods.

```js
...
const Users = defineModel(
  "users",
  {
    id: { type: Fields.IntegerField, primaryKey: true, autoIncrement: true },
    email: { type: Fields.CharField, unique: true },
    phone: { type: Fields.CharField, nullable: true },
    age: { type: Fields.IntegerField, nullable: true },
    total_games_played: { type: Fields.IntegerField, default: 0 },
    level: {
      type: Fields.EnumField,
      nullable: false,
      choices: GAME_LEVELS,
      default: "NOOB",
    },
    bonus_balance: {
      type: Fields.DecimalField,
      maxDigits: 5,
      decimalPlaces: 2,
    },
  },
```

<details>
  <summary>View Full Example</summary>

  ```js
import { defineModel, Fields, pool } from "sql-buns-migrate";
import { getSingleRow } from "../utils/db";
import { GAME_LEVELS } from "../constants";
import { UserModelTriggers } from "../triggers/userTriggers.js";

const Users = defineModel(
  "users",
  {
    id: { type: Fields.IntegerField, primaryKey: true, autoIncrement: true },
    email: { type: Fields.CharField, unique: true },
    phone: { type: Fields.CharField, nullable: true },
    age: { type: Fields.IntegerField, nullable: true },
    total_games_played: { type: Fields.IntegerField, default: 0 },
    level: {
      type: Fields.EnumField,
      nullable: false,
      choices: GAME_LEVELS,
      default: "NOOB",
    },
    bonus_balance: {
      type: Fields.DecimalField,
      maxDigits: 5,
      decimalPlaces: 2,
    },
  },
  {
    relations: {
      games: { type: "hasMany", model: "games", foreignKey: "user_id" },
    },
    triggers: {
      afterInsert: UserModelTriggers.AFTER_INSERT,
      afterUpdate: UserModelTriggers.AFTER_UPDATE,
    },
    meta: {
      tableName: "users",
      comment: "Users migrated from v0",
      indexes: [{ fields: ["email"], unique: true }],
    },
    methods: {
      async getUserProfile(id) {
        this.assertParams({ id, required: true, type: "number", min: 1 });
        const user = await getSingleRow("SELECT * FROM ?? WHERE id = ?", [
          this.meta.tableName,
          id,
        ]);
        return user || null;
      },

      async updateLevel(id, newLevel) {
        this.assertParams([
          { id, required: true, type: "number", min: 1 },
          { newLevel, required: true, enum: GAME_LEVELS },
        ]);

        await pool.query("UPDATE ?? SET level = ? WHERE id = ?", [
          this.meta.tableName,
          newLevel,
          id,
        ]);
        return { success: true, newLevel };
      },
    },
  }
);

```
</details>

<hr/>

### Model Structure

| Section       | Description                                                   |
| ------------- | ------------------------------------------------------------- |
| **Fields**    | Define each column and constraints.                           |
| **Meta**      | Add metadata such as `tableName`, `indexes`, and `comments`.       |
| **Relations** | Define relations like `hasOne`, `hasMany`, `manyToMany`, etc.            |
| **Triggers**  | Attach lifecycle hooks for `afterInsert`, `afterUpdate`, etc. |
| **Methods**   | Attach custom methods directly callable from your model.      |



## 🔒 `this.assertParams`

A lightweight runtime validator for your model methods.
Allowing you to validate arguments in either object or array form:

```js
this.assertParams({ id, required: true, type: "number", min: 1 });

this.assertParams([
  { id, required: true, type: "number" },
  { newLevel, enum: GAME_LEVELS },
]);
```

Automatically throws if validation fails.

<br/>

### Using Custom Methods

Once exported, methods are namespaced under `.methods`:

```js
export { Users };
```
```js
// Usage withing your app:
const profile = await Users.methods.getUserProfile(5);
await Users.methods.updateLevel(5, "PRO");
```
<hr/>

### ⚙ CLI Commands
All CLI commands use the prefix `buns-migrate`.

| Command                      | Description                                                         |
| ---------------------------- | ------------------------------------------------------------------- |
| `buns-migrate inspectdb`     | Introspects an existing database and generates model/index.js definitions.   |
| `buns-migrate create <name>` | Creates a new migration file (both `.sql` and `.js` rollback pair). |
| `buns-migrate up`            | Applies all pending migrations sequentially.                        |
| `buns-migrate down`          | Rolls back the **latest migration only** (once per migration).      |


### Example CLI Usage

```bash
# Inspect database and generate base models
buns-migrate inspectdb

# Create new migration
buns-migrate create add_bonus_balance_to_users

# Apply migrations
buns-migrate up

# Rollback the last migration
buns-migrate down

```


### Migration Design

Every migration generates two files:

- `.sql` file (forward schema changes)

- `.js` file (rollback definitions)

##### File structure Example

```bash
migrations/
  ├── 2025_10_26_1200_add_users_table.sql
  └── 2025_10_26_1200_add_users_table.js
```

Inside `.js` file:

```js
export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS users;`);
}

```

The rollback system ensures:

- You can only roll back the latest unapplied migration

- Once rolled back, it’s marked as reverted (`rolled_back = true`) preventing re-rollback of already reverted migrations


#### ⚙️ Supported SQL Dialects: PostgreSQL, MySQL, SQLite

Your DATABASE_ENGINE environment variable determines which dialect to use. Read more on .env setup here: [@anclatechs/sql-buns](https://www.npmjs.com/package/@anclatechs/sql-buns)


###  🧾 Table _sqlbuns_migrations

The framework auto-manages a tracking table:

| Column        | Description                |
| ------------- | -------------------------- |
| `id`          | Auto-increment primary key |
| `filename`    | Migration file name        |
| `direction`   | ENUM `'up'` or `'down'`         |
| `rolled_back` | Boolean               |
| `applied_at`  | Timestamp when applied     |
| `rolled_back_at` | Timestamp when rolled back |


### 💡 Project Philosophy

> Developers should stay close to SQL, learn it, use it, tweak it, enjoy the thrill . It's declarative, safe, and intuitive—it shouldn't feel tedious and be abstracted away in ORM.


`sql-buns-migrate` simplifies reusable migration logic by letting developers define schema and functions once, while keeping close to SQL as possible in a safe, explicit, yet reversible, and readable manner.


### Example Project Structure

```bash
📂src/
  📂 database
    📂 models/
      📄 index.js
    📂 signals/
      📄 customSignal.js
    📂 migrations/
      📄 2025_10_26_1200_add_users_table.sql
      📄 2025_10_26_1200_add_users_table.js
    📄 schema_snapshot.json
  📂 your_app
  
  ⚙ .env

```

<br/>
<br/>

Developed with ❤️ to make SQL migrations simpler, safer, and more expressive for Node.js developers.

<br/>
<br/>
