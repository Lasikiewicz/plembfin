import { Hono } from "hono";
import type { TaskRequest, TaskResponse } from "@devvit/web/server";
import { checkAndAnnounceNewRelease } from "../core/release";

export const scheduler = new Hono();

scheduler.post("/check-new-release", async (c) => {
  await c.req.json<TaskRequest>().catch(() => undefined);

  try {
    await checkAndAnnounceNewRelease();
  } catch (error) {
    console.error("Failed to check/post new release:", error);
  }

  return c.json<TaskResponse>({ status: "ok" }, 200);
});
