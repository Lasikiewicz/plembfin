import { requireAdmin } from "../utils/auth.js";
import { readJson } from "../utils/requestBody.js";
import { methodNotAllowed, sendJson, sendOptions } from "../utils/http.js";
import {
  dismissPlaystateAliasesForShow,
  foldPlaystateAliasesIntoShow,
  listUnprovenPlaystateAliases,
} from "../utils/playstateAliasReview.js";

// Settings -> Tools -> Database Repairs -> Watch-State Aliases
// (plan/playstate-episode-id-repair.md).
//   GET  /api/playstate-aliases          shows with unproven episode-id aliases
//   POST /api/playstate-aliases/fold     { showKey, profile } belongs to this show
//   POST /api/playstate-aliases/dismiss  { showKey } different show
export async function handlePlaystateAliases(req, res, path) {
  if (req.method === "OPTIONS") return sendOptions(res);
  if (!(await requireAdmin(req, res))) return;
  const action = String(path || "").split("/")[1] || "";
  try {
    if (!action) {
      if (req.method !== "GET") return methodNotAllowed(res);
      const shows = await listUnprovenPlaystateAliases();
      return sendJson(res, { ok: true, shows }, 200, { "Cache-Control": "no-store" });
    }
    if (req.method !== "POST") return methodNotAllowed(res);
    const body = await readJson(req);
    if (action === "fold") {
      const result = await foldPlaystateAliasesIntoShow(body.showKey, body.profile ?? 0);
      return sendJson(res, { ok: true, ...result });
    }
    if (action === "dismiss") {
      const result = await dismissPlaystateAliasesForShow(body.showKey);
      return sendJson(res, { ok: true, ...result });
    }
    return sendJson(res, { error: "Unknown watch-state alias action" }, 404);
  } catch (error) {
    return sendJson(res, { error: error.message }, error.status || 500);
  }
}
