import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface TaskWatchdogCoverageStore {
  load(): Promise<string[]>;
  save(issueIds: readonly string[]): Promise<void>;
}

/**
 * Independent of the CTO idle supervisor state. Remember both watchers we
 * installed and existing watchers we found, so an explicit removal is not
 * silently undone by the next poll or a service restart.
 */
export class FileTaskWatchdogCoverageStore implements TaskWatchdogCoverageStore {
  private readonly filePath: string;

  constructor(private readonly directory: string) {
    this.filePath = join(directory, "task-watchdog-coverage.json");
  }

  async load(): Promise<string[]> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    // Unknown/corrupt state must never be silently discarded: this could
    // override a watchdog that a human intentionally removed.
    const parsed: unknown = JSON.parse(contents);
    if (
      !Array.isArray(parsed) ||
      parsed.some((value: unknown) => typeof value !== "string" || value.length === 0) ||
      new Set(parsed).size !== parsed.length
    ) {
      throw new Error("Invalid campaign watchdog state");
    }
    return parsed as string[];
  }

  async save(issueIds: readonly string[]): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = this.filePath + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temp, JSON.stringify([...issueIds].sort(), null, 2) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temp, this.filePath);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }
}
