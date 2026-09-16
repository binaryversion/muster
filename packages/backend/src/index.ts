import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { githubWebhookRouter, replayUnfinishedDeliveries } from "./webhooks/github.js";
import { adminRouter } from "./admin/index.js";
import { eventsRouter } from "./events/sse.js";
import { startSyncLoop } from "./sync/github.js";
import { startReconcileLoop } from "./sync/reconcile.js";

const app = express();
// Behind Coolify, Traefik, nginx or any other proxy the hop into the container
// is plain http from a container IP; trust the forwarded headers so client IPs
// and the https flag on the session cookie are right.
if (process.env.TRUST_PROXY !== "false") app.set("trust proxy", true);
// Keep the raw body for webhook signature verification.
app.use(express.json({ limit: "2mb", verify: (req: any, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));

app.get("/healthz", (_req, res) => res.send("ok"));

// Backoffice UI. Served outside /admin because a browser cannot put a bearer
// token on the initial navigation; the page itself carries no data and asks the
// operator for ADMIN_TOKEN, which every /admin/* call it makes still requires.
app.use("/ui", express.static(join(dirname(fileURLToPath(import.meta.url)), "..", "public")));
app.get("/", (_req, res) => res.redirect("/ui/"));
app.use(githubWebhookRouter);
app.use(adminRouter);
app.use(eventsRouter);

startSyncLoop();
startReconcileLoop();

// Anything a previous process accepted but never finished. GitHub will not
// retry a delivery it was told we had, so this is the only chance to finish it.
// Not awaited: a slow replay must not hold up the port opening and start
// failing health checks.
replayUnfinishedDeliveries()
  .catch(err => console.error("webhooks: replay on startup failed", err));
const port = Number(process.env.BACKEND_PORT ?? 8080);
app.listen(port, () => console.log(`muster-backend listening on :${port}`));
