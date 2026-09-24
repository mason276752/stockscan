// A small promise memo for the data layer: the same request (by arguments)
// is made once and shared, so a prefetch and the click that follows, or two
// tabs needing the same thing, do not fetch twice. Bounded: the oldest
// entries go when `max` is exceeded; a rejected promise is dropped at once.
export function memoize<A extends unknown[], R>(fn: (...args: A) => R | Promise<R>, max = 30) {
  const map = new Map<string, Promise<R>>();
  const wrapped = (...args: A): Promise<R> => {
    const key = JSON.stringify(args);
    if (map.has(key)) {
      const v = map.get(key)!;
      map.delete(key);
      map.set(key, v); // most recently used last
      return v;
    }
    const p = Promise.resolve().then(() => fn(...args));
    map.set(key, p);
    p.catch(() => map.delete(key));
    while (map.size > max) map.delete(map.keys().next().value!);
    return p;
  };
  wrapped.clear = () => map.clear();
  return wrapped;
}
