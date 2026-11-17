/**
 * Caches `compute` by its text argument, keeping the `limit` texts read most
 * recently. A cached result is returned by reference, so callers can memoize on it.
 */
export function memoizeByText<T>(compute: (text: string) => T, limit: number): ((text: string) => T) & { clear: () => void } {
  const cache = new Map<string, T>();
  const memoized = (text: string) => {
    if (cache.has(text)) {
      const cached = cache.get(text) as T;
      cache.delete(text);
      cache.set(text, cached);
      return cached;
    }
    const result = compute(text);
    if (cache.size >= limit) cache.delete(cache.keys().next().value!);
    cache.set(text, result);
    return result;
  };
  return Object.assign(memoized, { clear: () => cache.clear() });
}
