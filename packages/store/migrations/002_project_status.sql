-- applied-if: SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='github_project_id')
-- Projects v2 Status write-back.
--
-- Setting a single-select field needs four node ids: the project, the item, the
-- field and the chosen option. Three of them are per-project and stable, so we
-- resolve them once through GraphQL and cache them on the project row; only the
-- item id is per-task.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS github_project_id      text,   -- ProjectV2 node id
  ADD COLUMN IF NOT EXISTS github_status_field_id text,   -- ProjectV2SingleSelectField node id for "Status"
  -- Option name -> option id, exactly as the board defines them.
  ADD COLUMN IF NOT EXISTS github_status_options  jsonb NOT NULL DEFAULT '{}',
  -- Optional per-project override: muster task_status -> option name on the
  -- board. Boards name their columns differently ("Todo" vs "To do" vs
  -- "Backlog"); when this is null the sync falls back to built-in aliases.
  ADD COLUMN IF NOT EXISTS github_status_map      jsonb,
  ADD COLUMN IF NOT EXISTS github_fields_synced_at timestamptz;

-- ProjectV2Item node id for the task's issue, resolved lazily by the sync loop
-- and by the projects_v2_item webhook.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS mirrored_at timestamptz;

-- The mirror used to pick up "everything touched in the last couple of
-- intervals", which both re-pushed unchanged rows every cycle and lost rows
-- whenever the backend was down longer than the window. Track what has actually
-- been mirrored instead.
CREATE INDEX IF NOT EXISTS tasks_unmirrored_idx ON tasks (project_id)
  WHERE mirrored_at IS NULL OR mirrored_at < updated_at;

-- Mirror bookkeeping must not look like a change worth mirroring, or writing
-- mirrored_at/github_item_id would re-dirty the row and the loop would never
-- settle. Everything else still bumps updated_at.
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
DECLARE before tasks; after tasks;
BEGIN
  before := OLD; after := NEW;
  after.updated_at     := before.updated_at;
  after.mirrored_at    := before.mirrored_at;
  after.github_item_id := before.github_item_id;
  IF after IS DISTINCT FROM before THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
