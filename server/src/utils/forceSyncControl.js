export function forceSyncStopAction({ workerRunning = false, runtimeActive = false, cancelRequested = false } = {}) {
  if (workerRunning) return "cancel";
  if (runtimeActive || cancelRequested) return "reset";
  return "idle";
}
