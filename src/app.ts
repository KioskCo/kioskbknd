import * as Sentry from "@sentry/node";
import express, { type Express, type Request, type Response } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
// Capture the raw body buffer so webhook routes can verify HMAC signatures on
// the exact bytes Paystack/Flutterwave sent (re-serialising req.body changes key order).
app.use(express.json({
  verify: (req: Request & { rawBody?: Buffer }, _res: Response, buf: Buffer) => {
    req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Sentry error handler must come after all routes
Sentry.setupExpressErrorHandler(app);

export default app;
