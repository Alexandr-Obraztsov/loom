import { satisfies, valid, validRange } from "semver";

/**
 * Memoized semver predicates. Each reconcile re-checks every manifest and dependency range, and
 * semver re-parses its strings on every call; the results depend only on the strings, so they are
 * cached (bounded: a full cache is dropped and refilled).
 */
const LIMIT = 4096;

function memo<A extends string[]>(fn: (...args: A) => boolean): (...args: A) => boolean {
  const cache = new Map<string, boolean>();
  return (...args) => {
    const key = args.join("\u0000");
    let hit = cache.get(key);
    if (hit === undefined) {
      if (cache.size >= LIMIT) cache.clear();
      hit = fn(...args);
      cache.set(key, hit);
    }
    return hit;
  };
}

// `valid` also accepts "v1.0.0" and "=1.0.0" (returning the cleaned string); a manifest must spell the version canonically.
export const isVersion: (version: string) => boolean = memo((v) => valid(v) === v);
// `validRange("")` is "*"; an empty range in a manifest is a mistake, not "any version" (write "*" for that).
export const isRange: (range: string) => boolean = memo((r) => r !== "" && validRange(r) !== null);
export const inRange: (version: string, range: string) => boolean = memo((v, r) =>
  satisfies(v, r, { includePrerelease: true }),
);
