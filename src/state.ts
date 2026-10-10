import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WatcherState } from "./types.js";

export interface StateStore {
  load(): Promise<WatcherState>;
  save(state: WatcherState): Promise<void>;
}

const INITIAL_STATE: WatcherState = {
  lastHandledSignature: null,
  lastWakeAt: null,
};

export class FileStateStore implements StateStore {
  private readonly filePath: string;

  constructor(private readonly directory: string) {
    this.filePath = join(directory, "cto-idle.json");
  }

  async load(): Promise<WatcherState> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...INITIAL_STATE };
      throw error;
    }

    // An invalid state file is an error: fail closed rather than re-waking the CTO.
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object") throw new Error("Invalid watcher state");
    const value = data as Record<string, unknown>;
    if (
      !(value.lastHandledSignature === null || typeof value.lastHandledSignature === "string") ||
      !(value.lastWakeAt === null || (typeof value.lastWakeAt === "number" && Number.isFinite(value.lastWakeAt)))
    ) {
      throw new Error("Invalid watcher state fields");
    }
    return {
      lastHandledSignature: value.lastHandledSignature as string | null,
      lastWakeAt: value.lastWakeAt as number | null,
    };
  }

  async save(state: WatcherState): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const tempPath = this.filePath + "." + randomUUID() + ".tmp";
    try {
      await writeFile(tempPath, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      await rename(tempPath, this.filePath);
    } finally {
      await rm(tempPath, { force: true }).catch(() => {});
    }
  }
}
