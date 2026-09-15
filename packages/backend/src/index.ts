import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { githubWebhookRouter } from "./webhooks/github.js";
import { adminRouter } from "./admin/index.js";
import { eventsRouter } from "./events/sse.js";
import { startSyncLoop } from "./sync/github.js";
import { startReconcileLoop } from "./sync/reconcile.js";

const app = express();
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
const port = Number(process.env.BACKEND_PORT ?? 8080);
app.listen(port, () => console.log(`muster-backend listening on :${port}`));
