import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const appSource = fs.readFileSync(path.join(root, "public/app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");

test("locked login keeps its logo in sync with the selected theme", () => {
  assert.match(indexSource, /<body class="auth-locked">/);
  assert.match(indexSource, /<section id="authView" class="auth-view hidden">/);
  assert.match(indexSource, /class="auth-brand-logo" data-theme-logo src="\/plembfin_header_logo_dark\.png"/);
  assert.match(appSource, /querySelectorAll\("\.brand-logo, \[data-theme-logo\]"\)/);
  assert.match(appSource, /isLightMode \? "\/plembfin_header_logo_light\.png" : "\/plembfin_header_logo_dark\.png"/);
});

test("locked login uses an onboarding-style shell and footer controls", () => {
  assert.match(indexSource, /id="authFooterBar" class="setup-footer-bar auth-footer-bar hidden"/);
  assert.match(indexSource, /id="authFooterBarMeta" class="setup-footer-bar-meta"/);
  assert.match(appSource, /const isAuthView = document\.body\.classList\.contains\("auth-locked"\)/);
  assert.match(appSource, /authFooterBarMeta \|\| authFooterBar/);
  assert.match(appSource, /document\.body\.classList\.toggle\("auth-locked", showAuthView\)/);
  assert.match(stylesSource, /body\.auth-locked \.topnav,[\s\S]*?body\.auth-locked #pageTopbar/);
});

test("login form separates the password field from the submit control", () => {
  assert.match(stylesSource, /\.auth-panel \.auth-form \{[\s\S]*?gap: var\(--space-3\);/);
  assert.match(indexSource, /<input id="adminToken"[\s\S]*?type="password"/);
  assert.match(indexSource, /<button class="button-primary" type="submit">Sign In<\/button>/);
});

test("locked login exposes local password recovery guidance", () => {
  assert.match(indexSource, /<details class="auth-recovery-help">/);
  assert.match(indexSource, /<summary>Forgot your password\?<\/summary>/);
  assert.match(indexSource, /ADMIN_PASSWORD/);
  assert.match(indexSource, /authManagedInApp/);
  assert.match(indexSource, /The old password cannot be recovered from the stored hash\./);
});
