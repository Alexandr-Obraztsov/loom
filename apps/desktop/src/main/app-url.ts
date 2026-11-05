import { pathToFileURL } from "node:url";

/** The one address the window may show: the dev server origin, or the built index file. */
export type AppTarget =
  | { readonly kind: "dev"; readonly origin: string }
  | { readonly kind: "file"; readonly href: string };

export function appTarget(devUrl: string | undefined, indexFile: string): AppTarget {
  return devUrl === undefined
    ? { kind: "file", href: pathToFileURL(indexFile).href }
    : { kind: "dev", origin: new URL(devUrl).origin };
}

/** Whether `url` is a page of the app itself (hash and query do not matter for the built index). */
export function isAppUrl(target: AppTarget, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (target.kind === "dev") return parsed.origin === target.origin;
  return (
    parsed.protocol === "file:" &&
    `${parsed.protocol}//${parsed.host}${parsed.pathname}` === target.href
  );
}
