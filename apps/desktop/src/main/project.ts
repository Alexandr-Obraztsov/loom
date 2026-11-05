import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface ProjectSources {
  /** `LOOM_PROJECT_DIR`. */
  readonly env: string | undefined;
  /** `<userData>/last-project.json`. */
  readonly lastFile: string;
  /** Asks the user for a folder; undefined when cancelled. */
  pick(): Promise<string | undefined>;
}

const isDirectory = async (path: string): Promise<boolean> =>
  await stat(path).then(
    (s) => s.isDirectory(),
    () => false,
  );

async function lastUsed(file: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as { dir?: unknown };
    return typeof parsed.dir === "string" && (await isDirectory(parsed.dir))
      ? parsed.dir
      : undefined;
  } catch {
    return undefined;
  }
}

/** The project folder: env override, else the last used one, else the user's pick (remembered). */
export async function resolveProjectDir(sources: ProjectSources): Promise<string | undefined> {
  if (sources.env) {
    if (!(await isDirectory(sources.env)))
      throw new Error(`LOOM_PROJECT_DIR is not a directory: ${sources.env}`);
    return sources.env;
  }
  const last = await lastUsed(sources.lastFile);
  if (last !== undefined) return last;
  const picked = await sources.pick();
  if (picked !== undefined) {
    await mkdir(dirname(sources.lastFile), { recursive: true });
    await writeFile(sources.lastFile, JSON.stringify({ dir: picked }));
  }
  return picked;
}
