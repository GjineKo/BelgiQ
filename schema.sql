CREATE TABLE IF NOT EXISTS scores (
 id BIGSERIAL PRIMARY KEY,
 game_id UUID NOT NULL UNIQUE,
 nickname VARCHAR(24) NOT NULL,
 score SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 10),
 total SMALLINT NOT NULL DEFAULT 10 CHECK (total = 10),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS scores_ranking ON scores (score DESC, created_at ASC);
-- Additive V2 migration: existing V1 scores remain intact.
ALTER TABLE scores ADD COLUMN IF NOT EXISTS language VARCHAR(2) NOT NULL DEFAULT 'fr' CHECK (language IN ('fr','nl','en'));
ALTER TABLE scores ADD COLUMN IF NOT EXISTS elapsed_ms INTEGER CHECK (elapsed_ms BETWEEN 0 AND 3600000);
CREATE INDEX IF NOT EXISTS scores_best_nickname ON scores (lower(nickname), score DESC, elapsed_ms ASC, created_at ASC);
