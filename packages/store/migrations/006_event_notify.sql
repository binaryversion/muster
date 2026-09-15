-- applied-if: SELECT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='events_notify')
-- Tell listeners when an event lands, instead of making them ask.
--
-- Every open /events/stream connection ran its own 2-second poll. At a handful
-- of leads that is nothing; at thirty it is thirty queries every two seconds
-- whether or not anything happened, which is almost always. The floor was set
-- by the number of watchers rather than by the amount of activity — the wrong
-- way round.
--
-- The payload carries only the project id. A notification says "something new
-- exists for this project", not what it is: the listener still reads forward
-- from the last id it sent, which is what makes it correct across reconnects
-- and missed notifications.
CREATE OR REPLACE FUNCTION notify_event() RETURNS trigger AS $$
BEGIN
  -- pg_notify rather than NOTIFY, because the channel name is fixed but the
  -- payload is per row.
  PERFORM pg_notify('muster_events', NEW.project_id::text);
  RETURN NULL;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_notify ON events;
CREATE TRIGGER events_notify AFTER INSERT ON events
  FOR EACH ROW EXECUTE FUNCTION notify_event();
