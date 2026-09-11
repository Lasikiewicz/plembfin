// The hosted demo is deliberately isolated from normal Plembfin behaviour.
// Keep this check server-side so demo fixtures can be projected without
// pretending that a real media app or user account is connected.
export function isDemoMode() {
  return String(process.env.PLEMBFIN_DEMO_MODE || "").trim() === "1";
}
