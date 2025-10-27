import { defineModel, Fields } from "@anclatechs/sql-buns-migrate";

export const SqlbunsMigrations = defineModel("_sqlbuns_migrations", {
  id: { type: Fields.IntegerField, required: false },
  name: { type: Fields.TextField, required: true },
  checksum: { type: Fields.TextField, required: true },
  previous_checksum: { type: Fields.TextField, required: false },
  direction: { type: Fields.TextField, required: true, default: "'up'" },
  applied_at: { type: Fields.TextField, required: false, default: "CURRENT_TIMESTAMP" },
  rolled_back: { type: Fields.IntegerField, required: false, default: "0" },
}, {
  meta: { db_table: "_sqlbuns_migrations" }
});

export const Users = defineModel("users", {
  id: { type: Fields.IntegerField, required: true },
  email: { type: Fields.TextField, required: true },
  phone: { type: Fields.TextField, required: false },
  age: { type: Fields.IntegerField, required: false },
  total_games_played: { type: Fields.IntegerField, required: true, default: "0" },
  level: { type: Fields.TextField, required: true, default: "'NOOB'" },
  bonus_balance: { type: Fields.TextField, required: true },
}, {
  relations: {
    games: { type: "hasMany", model: "games", foreignKey: "user_id" },
  },
  meta: { db_table: "users" }
});

export const Games = defineModel("games", {
  id: { type: Fields.IntegerField, required: true },
  user_id: { type: Fields.IntegerField, required: true },
  timestamp: { type: Fields.TextField, required: true, default: "'CURRENT_TIMESTAMP'" },
}, {
  meta: { db_table: "games" }
});

export const AuditLogs = defineModel("audit_logs", {
  id: { type: Fields.IntegerField, required: true },
  message: { type: Fields.TextField, required: true },
  created_at: { type: Fields.TextField, required: true, default: "'CURRENT_TIMESTAMP'" },
}, {
  meta: { db_table: "audit_logs" }
});

export const UserLevelHistory = defineModel("user_level_history", {
  id: { type: Fields.IntegerField, required: true },
  user_id: { type: Fields.IntegerField, required: true },
  old_level: { type: Fields.TextField, required: true },
  new_level: { type: Fields.TextField, required: true },
  changed_at: { type: Fields.TextField, required: true, default: "'CURRENT_TIMESTAMP'" },
}, {
  meta: { db_table: "user_level_history" }
});
