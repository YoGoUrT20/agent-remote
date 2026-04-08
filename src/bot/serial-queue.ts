const chains = new Map<string, Promise<unknown>>();

export function runSerial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  chains.set(key, next.catch(() => {}));
  return next;
}
