import crypto from "node:crypto";
import os from "node:os";

const VALID_ROLES = new Set(["all", "web", "worker"]);

export function resolveProcessRole(value = process.env.ROLE || "all") {
  const role = String(value || "all").trim().toLowerCase();
  if (!VALID_ROLES.has(role)) throw new Error(`Invalid ROLE "${value}". Expected all, web, or worker.`);
  return role;
}

export function createInstanceId(role = resolveProcessRole()) {
  return `${role}:${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
}

export function roleHasWeb(role) {
  return role === "all" || role === "web";
}

export function roleHasWorker(role) {
  return role === "all" || role === "worker";
}
