// Sonarr-style settings primitives shared by the settings pages: service card
// grids with an "add" tile, an add-type picker modal, and an edit modal with a
// Test / Cancel / Save footer. Consumers describe fields declaratively; secret
// fields are never prefilled — a "Configured" placeholder stands in for the
// stored credential (redacted-config semantics).
import { escapeHtml, escapeAttribute } from "./utils.js";

const CONFIGURED_PLACEHOLDER = "Configured - enter a new key to replace it";

function closeSettingsModals() {
  document.querySelectorAll(".settings-modal-overlay").forEach((el) => {
    if (typeof el._settingsClose === "function") el._settingsClose();
    else el.remove();
  });
}

function fieldPlaceholder(field) {
  if (field.secret && field.configured) return field.configuredPlaceholder || CONFIGURED_PLACEHOLDER;
  return field.placeholder || "";
}

function renderFieldRow(field) {
  const help = field.help ? `<small class="settings-field-help">${field.helpIsHtml ? field.help : escapeHtml(field.help)}</small>` : "";
  if (field.type === "checkbox") {
    return `
      <label class="settings-modal-field settings-modal-field--checkbox" data-field-key="${escapeAttribute(field.key)}">
        <span class="settings-modal-field-label">${escapeHtml(field.label)}</span>
        <span class="settings-modal-field-control">
          <input type="checkbox" data-modal-field="${escapeAttribute(field.key)}" ${field.value ? "checked" : ""} />
          ${help}
        </span>
      </label>
    `;
  }
  const type = field.type || "text";
  const value = field.secret ? "" : (field.value ?? "");
  return `
    <label class="settings-modal-field" data-field-key="${escapeAttribute(field.key)}">
      <span class="settings-modal-field-label">${escapeHtml(field.label)}${field.optional ? ` <em class="settings-field-optional">optional</em>` : ""}</span>
      <span class="settings-modal-field-control">
        <input class="field" type="${escapeAttribute(type)}" data-modal-field="${escapeAttribute(field.key)}"
          value="${escapeAttribute(String(value))}" placeholder="${escapeAttribute(fieldPlaceholder(field))}"
          autocomplete="${escapeAttribute(field.autocomplete || "off")}" data-lpignore="true" data-1p-ignore="true" />
        ${help}
      </span>
    </label>
  `;
}

function collectValues(dialog) {
  const values = {};
  dialog.querySelectorAll("[data-modal-field]").forEach((input) => {
    values[input.dataset.modalField] = input.type === "checkbox" ? input.checked : input.value.trim();
  });
  return values;
}

// Opens a centered edit modal. Options:
//   title, fields          — dialog heading and field specs (see renderFieldRow)
//   onSave(values, ui)     — required; resolve to close, return false to stay open
//   onTest(values, ui)     — optional; resolve to a success message string
//   onDelete(ui)           — optional; shows a red button on the footer's left
//   deleteLabel, saveLabel, testLabel — button captions
//   enabledKey             — key of a checkbox field that gates the other fields;
//                            unchecking disables them and relabels Save
//   helpHtml               — trusted HTML rendered inside a "Setup help" disclosure
export function openSettingsEditModal({
  title = "Edit",
  fields = [],
  onSave,
  onTest,
  onDelete,
  deleteLabel = "Delete",
  saveLabel = "Save",
  saveDisabledLabel = "",
  testLabel = "Test",
  enabledKey = "",
  helpHtml = "",
} = {}) {
  closeSettingsModals();
  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay settings-modal-overlay";
  overlay.innerHTML = `
    <div class="edit-dialog settings-modal" role="dialog" aria-modal="true" aria-label="${escapeAttribute(title)}">
      <header class="settings-modal-head">
        <h3>${escapeHtml(title)}</h3>
        <button class="settings-modal-close" type="button" aria-label="Close">&times;</button>
      </header>
      <div class="settings-modal-body">
        ${fields.map(renderFieldRow).join("")}
        ${helpHtml ? `<details class="settings-help-disclosure settings-modal-help"><summary>Setup help</summary><div class="settings-help-body">${helpHtml}</div></details>` : ""}
      </div>
      <p class="settings-modal-status message" role="status" aria-live="polite" data-tone="muted"></p>
      <footer class="settings-modal-foot">
        ${onDelete ? `<button class="button-danger settings-modal-delete" type="button">${escapeHtml(deleteLabel)}</button>` : ""}
        <div class="settings-modal-actions">
          ${onTest ? `<button class="button-ghost settings-modal-test" type="button">${escapeHtml(testLabel)}</button>` : ""}
          <button class="button-ghost settings-modal-cancel" type="button">Cancel</button>
          <button class="button-primary settings-modal-save" type="button">${escapeHtml(saveLabel)}</button>
        </div>
      </footer>
    </div>
  `;

  const dialog = overlay.querySelector(".settings-modal");
  const statusEl = overlay.querySelector(".settings-modal-status");
  const saveButton = overlay.querySelector(".settings-modal-save");
  const testButton = overlay.querySelector(".settings-modal-test");
  const deleteButton = overlay.querySelector(".settings-modal-delete");

  const onKeydown = (event) => {
    if (event.key === "Escape") close();
  };
  function close() {
    document.removeEventListener("keydown", onKeydown);
    overlay.remove();
  }
  overlay._settingsClose = close;
  const setStatus = (text, tone = "muted") => {
    statusEl.textContent = text || "";
    statusEl.dataset.tone = tone;
    statusEl.className = `settings-modal-status message ${tone}`;
  };
  const setBusy = (busy) => {
    [saveButton, testButton, deleteButton].forEach((button) => {
      if (button) button.disabled = busy;
    });
  };
  const ui = { close, setStatus, collect: () => collectValues(dialog) };

  const syncEnabledState = () => {
    if (!enabledKey) return;
    const master = dialog.querySelector(`[data-modal-field="${enabledKey}"]`);
    if (!master) return;
    const active = master.checked;
    dialog.querySelectorAll("[data-modal-field]").forEach((input) => {
      if (input.dataset.modalField !== enabledKey) input.disabled = !active;
    });
    if (saveDisabledLabel) saveButton.textContent = active ? saveLabel : saveDisabledLabel;
  };

  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  overlay.querySelector(".settings-modal-close").addEventListener("click", close);
  overlay.querySelector(".settings-modal-cancel").addEventListener("click", close);
  document.addEventListener("keydown", onKeydown);

  if (enabledKey) {
    dialog.querySelector(`[data-modal-field="${enabledKey}"]`)?.addEventListener("change", syncEnabledState);
    syncEnabledState();
  }

  saveButton.addEventListener("click", async () => {
    if (typeof onSave !== "function") return close();
    setBusy(true);
    setStatus("Saving...", "muted");
    try {
      const result = await onSave(collectValues(dialog), ui);
      if (result !== false) close();
    } catch (error) {
      setStatus(error?.message || "Save failed.", "error");
    } finally {
      setBusy(false);
    }
  });

  testButton?.addEventListener("click", async () => {
    setBusy(true);
    setStatus("Testing...", "muted");
    try {
      const message = await onTest(collectValues(dialog), ui);
      setStatus(message || "✔ Connection OK", "success");
    } catch (error) {
      setStatus(`✘ ${error?.message || "Connection failed."}`, "error");
    } finally {
      setBusy(false);
    }
  });

  deleteButton?.addEventListener("click", async () => {
    setBusy(true);
    try {
      const result = await onDelete(ui);
      if (result !== false) close();
    } catch (error) {
      setStatus(error?.message || "Delete failed.", "error");
    } finally {
      setBusy(false);
    }
  });

  document.body.appendChild(overlay);
  const firstInput = dialog.querySelector("[data-modal-field]:not([disabled])");
  firstInput?.focus({ preventScroll: true });
  return ui;
}

// Opens the "+" picker: a grid of available service types. Picking one closes
// the picker and calls onPick(id).
export function openSettingsPickerModal({ title = "Add", intro = "", items = [], onPick } = {}) {
  closeSettingsModals();
  const overlay = document.createElement("div");
  overlay.className = "edit-dialog-overlay settings-modal-overlay";
  overlay.innerHTML = `
    <div class="edit-dialog settings-modal settings-picker-modal" role="dialog" aria-modal="true" aria-label="${escapeAttribute(title)}">
      <header class="settings-modal-head">
        <h3>${escapeHtml(title)}</h3>
        <button class="settings-modal-close" type="button" aria-label="Close">&times;</button>
      </header>
      <div class="settings-modal-body">
        ${intro ? `<p class="settings-picker-intro">${escapeHtml(intro)}</p>` : ""}
        <div class="settings-card-grid settings-picker-grid">
          ${items.map((item) => `
            <button class="service-card" type="button" data-picker-id="${escapeAttribute(item.id)}">
              <b>${escapeHtml(item.name)}</b>
              ${item.description ? `<span class="service-card-desc">${escapeHtml(item.description)}</span>` : ""}
            </button>
          `).join("")}
        </div>
      </div>
      <footer class="settings-modal-foot">
        <div class="settings-modal-actions">
          <button class="button-ghost settings-modal-cancel" type="button">Close</button>
        </div>
      </footer>
    </div>
  `;
  const onKeydown = (event) => { if (event.key === "Escape") close(); };
  const close = () => {
    document.removeEventListener("keydown", onKeydown);
    overlay.remove();
  };
  overlay._settingsClose = close;
  overlay.addEventListener("click", (event) => { if (event.target === overlay) close(); });
  overlay.querySelector(".settings-modal-close").addEventListener("click", close);
  overlay.querySelector(".settings-modal-cancel").addEventListener("click", close);
  overlay.querySelectorAll("[data-picker-id]").forEach((button) => {
    button.addEventListener("click", () => {
      close();
      onPick?.(button.dataset.pickerId);
    });
  });
  document.addEventListener("keydown", onKeydown);
  document.body.appendChild(overlay);
  overlay.querySelector("[data-picker-id], .settings-modal-close")?.focus({ preventScroll: true });
}

// Renders a Sonarr-style card grid: one card per configured service (name +
// status badges) and a trailing dashed "+" card when onAdd is provided.
export function renderServiceCardGrid(container, { items = [], onSelect, onAdd, addLabel = "Add" } = {}) {
  if (!container) return;
  const badgeMarkup = (badges = []) => badges.map((badge) =>
    `<span class="status-pill status-${escapeAttribute(badge.tone || "muted")}">${escapeHtml(badge.label)}</span>`
  ).join("");
  container.innerHTML = `
    ${items.map((item) => `
      <button class="service-card" type="button" data-service-id="${escapeAttribute(item.id)}">
        <b>${escapeHtml(item.name)}</b>
        ${item.description ? `<span class="service-card-desc">${escapeHtml(item.description)}</span>` : ""}
        <span class="service-card-badges">${badgeMarkup(item.badges)}</span>
      </button>
    `).join("")}
    ${onAdd ? `<button class="service-card service-card--add" type="button" aria-label="${escapeAttribute(addLabel)}"><span aria-hidden="true">+</span></button>` : ""}
  `;
  container.querySelectorAll("[data-service-id]").forEach((button) => {
    button.addEventListener("click", () => onSelect?.(button.dataset.serviceId));
  });
  container.querySelector(".service-card--add")?.addEventListener("click", () => onAdd?.());
}
