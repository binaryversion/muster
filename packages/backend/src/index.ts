import express from "express";
import { githubWebhookRouter } from "./webhooks/github.js";
import { adminRouter } from "./admin/index.js";
import { eventsRouter } from "./events/sse.js";
import { startSyncLoop } from "./sync/github.js";
import { startReconcileLoop } from "./sync/reconcile.js";

const app = express();
// Keep the raw body for webhook signature verification.
app.use(express.json({ limit: "2mb", verify: (req: any, _res, buf) => { req.rawBody = buf.toString("utf8"); } }));

app.get("/healthz", (_req, res) => res.send("ok"));
app.use(githubWebhookRouter);
app.use(adminRouter);
app.use(eventsRouter);

startSyncLoop();
startReconcileLoop();
const port = Number(process.env.BACKEND_PORT ?? 8080);
app.listen(port, () => console.log(`muster-backend listening on :${port}`));
