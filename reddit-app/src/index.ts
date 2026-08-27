import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createServer, getServerPort } from "@devvit/web/server";
import { scheduler } from "./routes/scheduler";

const app = new Hono();
const internal = new Hono();

internal.route("/scheduler", scheduler);

app.route("/internal", internal);

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
