// Give timers, HTTP requests, and lease renewals a chance to run between
// bounded synchronous batches of maintenance work.
export function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}
