CREATE TABLE IF NOT EXISTS opponent_labels (
  opponent_id TEXT PRIMARY KEY CHECK (
    length(CAST(opponent_id AS BLOB)) = length(opponent_id) AND
    opponent_id GLOB 'club:[1-9]*' AND
    substr(opponent_id, 6) NOT GLOB '*[^0-9]*' AND
    length(opponent_id) <= 23
  ),
  label TEXT NOT NULL CHECK (
    length(CAST(label AS BLOB)) = length(label) AND
    length(label) BETWEEN 1 AND 80
  ),
  snapshot_id TEXT NOT NULL CHECK (
    length(CAST(snapshot_id AS BLOB)) = length(snapshot_id) AND
    length(snapshot_id) = 64 AND
    snapshot_id NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;
