CREATE TABLE IF NOT EXISTS "users" (
  id INTEGER NOT NULL,
  email VARCHAR NOT NULL,
  phone VARCHAR,
  age INTEGER,
  total_games_played INTEGER NOT NULL DEFAULT 0,
  level TEXT CHECK(VALUE IN ('NOOB', 'INTERMEDIATE', 'EXPERT', 'KING', 'EMPEROR')) NOT NULL DEFAULT 'NOOB',
  bonus_balance DECIMAL NOT NULL,
  PRIMARY KEY
);
CREATE UNIQUE INDEX idx_users_email ON users (email);
CREATE TRIGGER trg_users_insert_after_0
  AFTER INSERT
  ON users
  FOR EACH ROW
  EXECUTE FUNCTION UPDATE users SET bonus_balance = 10.00 WHERE id = NEW.id;;
CREATE TRIGGER trg_users_insert_after_1
  AFTER INSERT
  ON users
  FOR EACH ROW
  EXECUTE FUNCTION INSERT INTO audit_logs (message, created_at) VALUES ( 'New user created: ' || NEW.id, CURRENT_TIMESTAMP );;
CREATE TRIGGER trg_users_update_after_0
  AFTER UPDATE
  ON users
  FOR EACH ROW
  EXECUTE FUNCTION INSERT INTO user_level_history ( user_id, old_level, new_level, changed_at ) VALUES ( NEW.id, OLD.level, NEW.level, CURRENT_TIMESTAMP ) WHERE OLD.level <> NEW.level;;
CREATE TRIGGER trg_users_update_after_1
  AFTER UPDATE
  ON users
  FOR EACH ROW
  EXECUTE FUNCTION INSERT INTO audit_logs (message, created_at) VALUES ( 'Bonus changed, from ' || OLD.bonus_balance || ' to ' || NEW.bonus_balance, CURRENT_TIMESTAMP ) WHERE OLD.bonus_balance <> NEW.bonus_balance;;
CREATE TABLE IF NOT EXISTS "games" (
  id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  timestamp DATETIME NOT NULL DEFAULT 'CURRENT_TIMESTAMP',
  PRIMARY KEY
);
ALTER TABLE games ADD CONSTRAINT fk_games_user_id FOREIGN KEY (user_id) REFERENCES users(id);,CREATE INDEX IF NOT EXISTS idx_games_user_id ON games (user_id);