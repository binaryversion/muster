-- Nightly reconcile bookkeeping.
--
-- Webhook deliveries get dropped: GitHub gives up after enough failures, and a
-- backend that was down during a redelivery window never hears about the issue
-- at all. The reconcile job diffs GitHub against the store to catch that, and
-- uses this column to ask GitHub only for issues touched since the last pass.
ALTER TABLE projects ADD COLUMN reconciled_at timestamptz;
