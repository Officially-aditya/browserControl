/** Upper bound on how long the extension may need to finish one action_queue RPC. */
export function actionQueueTimeoutMs(params: Record<string, any> = {}): number {
  const queue: Record<string, any>[] = Array.isArray(params.queue) ? params.queue : [];
  const numberOr = (value: unknown, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
  // Human typing, per-action dwell, and explicit waits can exceed the normal 30s RPC limit.
  const executionMs = queue.reduce((total, item) =>
    total + 3000 + numberOr(item?.dwellMs, 1000)
    + (item?.type === "type" && typeof item.text === "string" ? item.text.length * 400 : 0)
    + (item?.type === "wait" ? numberOr(item.ms, 1000) : 0), 0);
  return 30_000 + executionMs + numberOr(params.timeoutMs, 10_000);
}
