import { randomUUID } from "node:crypto";

const MAX_ACTIVITIES = 40;
const MAX_LINES = 500;
const ACTIVITY_TTL_MS = 30 * 60 * 1000;
const activities = new Map();

function pruneActivities(now = Date.now()) {
  for (const [id, activity] of activities) {
    if (now - activity.updatedAt > ACTIVITY_TTL_MS) activities.delete(id);
  }
  while (activities.size > MAX_ACTIVITIES) {
    const oldest = [...activities.values()].sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!oldest) break;
    activities.delete(oldest.id);
  }
}

function activitySnapshot(activity) {
  if (!activity) return null;
  return {
    ...activity,
    lines: activity.lines.map((line) => ({ ...line })),
    meta: { ...activity.meta },
    result: activity.result || null,
  };
}

export function createMediaForceSyncActivity(meta = {}) {
  pruneActivities();
  const now = Date.now();
  const activity = {
    id: randomUUID(),
    status: "running",
    createdAt: now,
    updatedAt: now,
    meta: { ...meta },
    lines: [],
    result: null,
    error: "",
  };
  activities.set(activity.id, activity);
  appendMediaForceSyncActivity(activity.id, "Operation started.", "info");
  return activity.id;
}

export function appendMediaForceSyncActivity(id, text, level = "info") {
  const activity = activities.get(String(id));
  if (!activity) return false;
  activity.lines.push({ at: Date.now(), level: String(level || "info"), text: String(text || "") });
  if (activity.lines.length > MAX_LINES) activity.lines.splice(0, activity.lines.length - MAX_LINES);
  activity.updatedAt = Date.now();
  return true;
}

export function finishMediaForceSyncActivity(id, result, error = "") {
  const activity = activities.get(String(id));
  if (!activity) return false;
  activity.status = error ? "error" : "completed";
  activity.error = String(error || "");
  activity.result = result || null;
  activity.updatedAt = Date.now();
  appendMediaForceSyncActivity(id, error || "Operation completed.", error ? "error" : "success");
  return true;
}

export function getMediaForceSyncActivity(id) {
  pruneActivities();
  return activitySnapshot(activities.get(String(id || "")));
}
