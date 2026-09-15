-- Full-text search over findings.
--
-- muster_search_findings matched with `content ILIKE '%…%'`, which no index can
-- serve, so every search was a sequential scan. Worse, it did not match how
-- agents ask: a lead searching "failing tests" would not find a finding that
-- says "the test suite fails", so the tool returned nothing and the agent
-- re-debugged something already written down — exactly the waste findings exist
-- to prevent.

-- array_to_string is only STABLE, because in general it depends on the element
-- type's output function, and a generated column needs IMMUTABLE. For text[]
-- the result genuinely is deterministic, so a wrapper is safe here.
CREATE OR REPLACE FUNCTION muster_tags_text(text[]) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  AS $$ SELECT array_to_string($1, ' ') $$;

ALTER TABLE findings ADD COLUMN search tsvector
  GENERATED ALWAYS AS (
    -- Tags outrank the body: someone who tagged a finding `flaky` said what it
    -- is about more deliberately than the prose did.
    setweight(to_tsvector('english'::regconfig, muster_tags_text(tags)), 'A') ||
    setweight(to_tsvector('english'::regconfig, content), 'B')
  ) STORED;

CREATE INDEX findings_search_idx ON findings USING GIN (search);

-- The ILIKE fallback still runs for short or symbol-heavy queries, where full
-- text does badly: `ENOSPC`, `--no-sandbox`, `5432`. Give it a trigram index
-- rather than leaving one query shape on a sequential scan.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX findings_content_trgm_idx ON findings USING GIN (content gin_trgm_ops);

COMMENT ON COLUMN findings.search IS
  'Generated: tags weighted A, content weighted B. Queried with websearch_to_tsquery.';
