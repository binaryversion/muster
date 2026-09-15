/**
 * One LISTEN connection for the whole process, fanned out in memory.
 *
 * Replaces a per-connection poll: load now scales with how much is happening
 * rather than with how many leads are watching.
 *
 * A notification only says "something new exists for this project". It never
 * carries the event, so a listener still reads forward from the last id it
 * sent. That is what keeps this correct when a notification is missed, when the
 * LISTEN connection drops, and on reconnect with a Last-Event-ID.
 */
import pg from "pg";

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();
let client: pg.Client | null = null;
let connecting: Promise<void> | null = null;
let reconnectDelay = 1000;

/** Also poll at this interval, however healthy LISTEN looks. */
export const FALLBACK_POLL_MS = Number(process.env.EVENT_POLL_MS ?? 15_000);

function wake(projectId: string) {
  for (const listener of listeners.get(projectId) ?? []) {
    try { listener(); } catch (err) { console.error("event bus listener failed", err); }
  }
}

async function connect(): Promise<void> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
  c.on("notification", msg => { if (msg.payload) wake(msg.payload); });
  c.on("error", err => {
    console.error("event bus connection error:", (err as Error)?.message ?? err);
    c.end().catch(() => {});
    if (client === c) { client = null; scheduleReconnect(); }
  });
  await c.connect();
  await c.query("LISTEN muster_events");
  client = c;
  reconnectDelay = 1000;
}

function scheduleReconnect() {
  if (connecting) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
  setTimeout(() => {
    connecting = connect()
      .catch(err => {
        console.error("event bus reconnect failed:", (err as Error)?.message ?? err);
        scheduleReconnect();
      })
      .finally(() => { connecting = null; });
  }, delay);
}

/**
 * Subscribe to a project. Returns an unsubscribe function.
 *
 * Connecting is lazy and failures are not fatal: if LISTEN never comes up, the
 * stream still works on its fallback poll. A push feature must not be able to
 * take the feature it was replacing down with it.
 */
export function subscribe(projectId: string, listener: Listener): () => void {
  let set = listeners.get(projectId);
  if (!set) { set = new Set(); listeners.set(projectId, set); }
  set.add(listener);

  if (!client && !connecting) {
    connecting = connect()
      .catch(err => {
        console.error("event bus could not LISTEN, falling back to polling:", (err as Error)?.message ?? err);
        scheduleReconnect();
      })
      .finally(() => { connecting = null; });
  }

  return () => {
    const current = listeners.get(projectId);
    if (!current) return;
    current.delete(listener);
    if (!current.size) listeners.delete(projectId);
  };
}

/** Tests and shutdown. */
export async function closeEventBus(): Promise<void> {
  listeners.clear();
  const c = client;
  client = null;
  if (c) await c.end().catch(() => {});
}
