/**
 * Per-chat serialized execution queue.
 *
 * Ensures only one Claude CLI process runs per chat at a time.
 * Messages arriving while a process is running are queued and
 * executed sequentially.
 */

const queues = new Map<number, Promise<unknown>>();

export function enqueue<T>(chatId: number, task: () => Promise<T>): Promise<T> {
  const prior = queues.get(chatId) ?? Promise.resolve();
  const chained = prior.catch(() => {}).then(task);
  // Keep queue continuity even when a run rejects, without emitting unhandled rejections.
  const tracked = chained
    .catch(() => {})
    .finally(() => {
      if (queues.get(chatId) === tracked) {
        queues.delete(chatId);
      }
    });
  queues.set(chatId, tracked);
  return chained;
}
