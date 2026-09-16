-- applied-if: SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='webhook_deliveries' AND column_name='processed_at')
-- Make an accepted webhook survive the process that accepted it.
--
-- The handler recorded a delivery id, answered 202 and only then processed the
-- payload. Dying in between lost the delivery for good: the id was already on
-- record, so a redelivery from GitHub was refused as a duplicate. Being *down*
-- was always safe — GitHub retries a connection error — but being up and
-- dropping it was not, because we had already said yes.
--
-- The payload is now kept until the work is done, and cleared afterwards, so
-- the table stores bodies only for deliveries actually in flight.

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS event        text,
  ADD COLUMN IF NOT EXISTS payload      text,
  -- When this attempt started. A claim older than the timeout is assumed dead,
  -- which is what lets a restart take the work back.
  ADD COLUMN IF NOT EXISTS claimed_at   timestamptz,
  -- Set once the handlers have finished. Null means the work never completed.
  ADD COLUMN IF NOT EXISTS processed_at timestamptz;

-- Rows that predate this migration were processed under the old contract, so
-- record them as done rather than leaving them to look like orphans for ever.
UPDATE webhook_deliveries SET processed_at = received_at WHERE processed_at IS NULL;

-- Finds the replay candidates on boot, and the rows retention deletes.
CREATE INDEX IF NOT EXISTS webhook_deliveries_unfinished_idx
  ON webhook_deliveries (received_at) WHERE processed_at IS NULL;
CREATE INDEX IF NOT EXISTS webhook_deliveries_received_idx
  ON webhook_deliveries (received_at);

COMMENT ON COLUMN webhook_deliveries.payload IS
  'Raw body, kept only until the delivery is processed. Null with a null processed_at means it was abandoned as too old to replay.';
