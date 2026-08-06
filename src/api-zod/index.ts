import { z } from "zod";

export const HealthCheckResponse = z.object({
  status: z.enum(["ok", "degraded", "down"]),
});
export type HealthCheckResponse = z.infer<typeof HealthCheckResponse>;
