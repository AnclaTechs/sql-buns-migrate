const { pool, getSingleRow } = require("@anclatechs/sql-buns");
const { defineModel, Fields } = require("@anclatechs/sql-buns-migrate");
const { UserModelTriggers } = require("./signals");
const { GAME_LEVELS } = require("./constants");

const Games = defineModel(
  "games",
  {
    id: { type: Fields.IntegerField, primaryKey: true, autoIncrement: true },
    user_id: { type: Fields.IntegerField },
    timestamp: { type: Fields.DateTimeField },
  },
  {
    meta: {
      tableName: "games",
    },
  }
);
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
        if (!user) return null;

        return user;
      },

      async updateLevel(id, newLevel) {
        this.assertParams([
          { id, required: true, type: "number", min: 1 },
          {
            newLevel,
            required: true,
            enum: GAME_LEVELS,
          },
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

module.exports = {
  Users,
  Games,
};
