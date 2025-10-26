export const UserModelTriggers = {
  AFTER_INSERT: [
    /** Initialize a welcome bonus */
    `UPDATE users SET bonus_balance = 10.00 WHERE id = NEW.id;`,
    /** Log the creation */
    `INSERT INTO audit_logs (message, created_at) VALUES (
            'New user created: ' || NEW.id, CURRENT_TIMESTAMP
        );`,
  ],
  AFTER_UPDATE: [
    /** Track level upgrades automatically */
    {
      body: `INSERT INTO user_level_history (
            user_id, old_level, new_level, changed_at
        )
        VALUES (
            NEW.id, OLD.level, NEW.level, CURRENT_TIMESTAMP
        )
        `,
      when: "WHEN OLD.level <> NEW.level",
    },

    /** Audit bonus changes */
    {
      body: `INSERT INTO audit_logs (message, created_at)
        VALUES (
            'Bonus changed, from ' || OLD.bonus_balance || ' to ' || NEW.bonus_balance,
            CURRENT_TIMESTAMP
        );`,
      when: "WHEN OLD.bonus_balance <> NEW.bonus_balance",
    },
  ],
};
