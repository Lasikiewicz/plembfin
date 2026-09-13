import test from "node:test";
import assert from "node:assert/strict";

import { collectFieldValues, renderFieldRow } from "../public/modules/settings-ui.js";

test("choice fields render accessible radio options", () => {
  const markup = renderFieldRow({
    key: "watchImportMode",
    id: "sync-field-watch_import_mode",
    label: "When you manually mark an item as watched in Plex / Emby / Jellyfin",
    type: "choice",
    value: "review",
    options: [
      { value: "now", label: "Mark as watched now" },
      { value: "review", label: "Require review", description: "Hold it for a decision." },
    ],
  });

  assert.match(markup, /role="radiogroup"/);
  assert.match(markup, /value="review"[\s\S]*checked/);
  assert.match(markup, /Hold it for a decision\./);
});

test("collectFieldValues returns only the checked choice", () => {
  const controls = [
    { type: "radio", checked: false, value: "now", dataset: { modalField: "watchImportMode" } },
    { type: "radio", checked: true, value: "review", dataset: { modalField: "watchImportMode" } },
    { type: "checkbox", checked: true, value: "on", dataset: { modalField: "fastLocalPacing" } },
  ];

  assert.deepEqual(collectFieldValues({ querySelectorAll: () => controls }), {
    watchImportMode: "review",
    fastLocalPacing: true,
  });
});

test("checkbox fields render with their persisted state", () => {
  const markup = renderFieldRow({
    key: "upNextSyncEnabled",
    id: "sync-field-up_next_sync",
    type: "checkbox",
    label: "Sync Up Next to media apps",
    value: true,
  });

  assert.match(markup, /id="sync-field-up_next_sync"/);
  assert.match(markup, /Sync Up Next to media apps/);
  assert.match(markup, /type="checkbox"[^>]*checked/);
});
