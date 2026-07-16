export function connectionLabel(type) {
  const text = String(type || "unknown").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
