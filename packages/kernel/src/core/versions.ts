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

// `valid` also accepts "v1.0.0", "=1.0.0" and surrounding whitespace (it cleans them); a manifest must start the version with its
// major number and carry no padding. Prerelease and build metadata stay legal ("1.0.0-beta.1+sha.abc").
export const isVersion: (version: string) => boolean = memo((v) => /^\d/.test(v) && v === v.trim() && valid(v) !== null);
// `validRange("")` is "*"; an empty range in a manifest is a mistake, not "any version" (write "*" for that).
export const isRange: (range: string) => boolean = memo((r) => r !== "" && validRange(r) !== null);
export const inRange: (version: string, range: string) => boolean = memo((v, r) =>
  satisfies(v, r, { includePrerelease: true }),
);
