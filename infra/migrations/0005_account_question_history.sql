-- Account-linked question history is a separate, user-clearable product
-- feature. It is never joined into aggregate demand telemetry.
CREATE TABLE IF NOT EXISTS account_question_history (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  account_sub        TEXT NOT NULL CHECK (length(account_sub) BETWEEN 1 AND 512),
  question_text      TEXT NOT NULL CHECK (length(question_text) BETWEEN 1 AND 1000),
  visualization_path TEXT NOT NULL CHECK (
    length(visualization_path) BETWEEN 1 AND 2048 AND
    visualization_path GLOB '/[a-z][a-z]/q?*'
  ),
  locale             TEXT NOT NULL CHECK (locale IN ('en', 'es')),
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_question_history_recent
  ON account_question_history(account_sub, id DESC);
