CREATE TABLE IF NOT EXISTS opponent_labels (
  opponent_id TEXT PRIMARY KEY CHECK (
    opponent_id GLOB 'club:[1-9]*' AND
    substr(opponent_id, 6) NOT GLOB '*[^0-9]*' AND
    length(opponent_id) <= 23
  ),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  snapshot_id TEXT NOT NULL CHECK (
    length(snapshot_id) = 64 AND
    snapshot_id NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;
