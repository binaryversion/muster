-- applied-if: SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='projects' AND column_name='reconciled_at')
-- Nightly reconcile bookkeeping.
--
-- Webhook deliveries get dropped: GitHub gives up after enough failures, and a
-- backend that was down during a redelivery window never hears about the issue
-- at all. The reconcile job diffs GitHub against the store to catch that, and
-- uses this column to ask GitHub only for issues touched since the last pass.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;
