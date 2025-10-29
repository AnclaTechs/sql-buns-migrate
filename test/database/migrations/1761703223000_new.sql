CREATE TABLE IF NOT EXISTS "users" (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  email VARCHAR UNIQUE NOT NULL,
  phone VARCHAR,
  age INTEGER,
  total_games_played INTEGER NOT NULL DEFAULT 0,
  level TEXT CHECK(level IN ('NOOB', 'INTERMEDIATE', 'EXPERT', 'KING', 'EMPEROR')) NOT NULL DEFAULT 'NOOB',
  bonus_balance DECIMAL NOT NULL
);
CREATE UNIQUE INDEX idx_users_email ON users (email);
CREATE TRIGGER trg_users_insert_after_0
  AFTER INSERT
  ON users
  FOR EACH ROW
  BEGIN
    UPDATE users SET bonus_balance = 10.00 WHERE id = NEW.id;
  END;
CREATE TRIGGER trg_users_insert_after_1
  AFTER INSERT
  ON users
  FOR EACH ROW
  BEGIN
    INSERT INTO audit_logs (message, created_at) VALUES ( 'New user created: ' || NEW.id, CURRENT_TIMESTAMP );
  END;
CREATE TRIGGER trg_users_update_after_0
  AFTER UPDATE
  ON users
  FOR EACH ROW
  WHEN (OLD.level <> NEW.level)
  BEGIN
    INSERT INTO user_level_history ( user_id, old_level, new_level, changed_at ) VALUES ( NEW.id, OLD.level, NEW.level, CURRENT_TIMESTAMP );
  END;
CREATE TRIGGER trg_users_update_after_1
  AFTER UPDATE
  ON users
  FOR EACH ROW
  WHEN (OLD.bonus_balance <> NEW.bonus_balance)
  BEGIN
    INSERT INTO audit_logs (message, created_at) VALUES ( 'Bonus changed, from ' || OLD.bonus_balance || ' to ' || NEW.bonus_balance, CURRENT_TIMESTAMP );
  END;
CREATE TABLE IF NOT EXISTS "games" (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id INTEGER NOT NULL,
  timestamp DATETIME NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS "audit_logs" (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  message VARCHAR NOT NULL,
  created_at DATETIME NOT NULL DEFAULT 'CURRENT_TIMESTAMP'
);
CREATE TABLE IF NOT EXISTS "user_level_history" (
  id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
  user_id INTEGER NOT NULL,
  old_level VARCHAR NOT NULL,
  new_level VARCHAR NOT NULL,
  changed_at DATETIME NOT NULL DEFAULT 'CURRENT_TIMESTAMP'
);