import "./instrument.js"; // must be first — initialises Sentry before any other module loads
import app from "./app";
import { logger } from "./lib/logger";
import { scheduleJobs } from "./lib/queue.js";
import { startWorkers } from "./workers.js";
import { startOrderFollowUpScheduler } from "./routes/whatsapp.js";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Register repeatable BullMQ jobs and start the in-process worker. Safe to run
  // alongside a dedicated `npm run start:worker` process (jobs are idempotent).
  scheduleJobs()
    .then(() => startWorkers())
    .catch((err) => logger.warn({ err: err.message }, "Unable to start BullMQ workers"));

  startOrderFollowUpScheduler();
  logger.info("Order follow-up scheduler started");
});
