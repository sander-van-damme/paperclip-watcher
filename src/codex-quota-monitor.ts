import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { QuotaAvailability, QuotaSnapshot } from "./codex-quota.js";

export interface QuotaMonitorState {
  lastValidAvailability: "available" | "exhausted" | null;
  recoveryEpoch: number;
}
export interface QuotaReport {
  availability: QuotaAvailability;
  recoveryEpoch: number;
  reason: string;
}
export class CodexQuotaMonitor {
  private readonly path: string;
  private previous: QuotaMonitorState | null = null;
  constructor(
    stateDir: string,
    private readonly probe: () => Promise<QuotaSnapshot>,
  ) { this.path = join(stateDir, "codex-quota.json"); }

  private async load(): Promise<QuotaMonitorState> {
    if (this.previous) return this.previous;
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return this.previous = { lastValidAvailability: null, recoveryEpoch: 0 };
      }
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    const v = parsed as QuotaMonitorState | null;
    if (!v || ![null, "available", "exhausted"].includes(v.lastValidAvailability) ||
        !Number.isSafeInteger(v.recoveryEpoch) || v.recoveryEpoch < 0) {
      throw new Error("Invalid Codex quota monitor state");
    }
    return this.previous = v;
  }
  private async save(): Promise<void> {
    await mkdir(join(this.path, ".."), { recursive: true, mode: 0o700 });
    const tmp = this.path + "." + randomUUID() + ".tmp";
    await writeFile(tmp, JSON.stringify(this.previous) + "\n", { mode: 0o600, flag: "wx" });
    await rename(tmp, this.path);
  }
  async poll(): Promise<QuotaReport> {
    const previous = await this.load();
    let snapshot: QuotaSnapshot;
    try { snapshot = await this.probe(); }
    catch {
      return { availability: "unknown", recoveryEpoch: previous.recoveryEpoch, reason: "codex_probe_failed" };
    }
    const epoch = previous.recoveryEpoch +
      (previous.lastValidAvailability === "exhausted" && snapshot.availability === "available" ? 1 : 0);
    if (snapshot.availability !== "unknown") {
      if (epoch !== previous.recoveryEpoch || snapshot.availability !== previous.lastValidAvailability) {
        this.previous = { lastValidAvailability: snapshot.availability, recoveryEpoch: epoch };
        await this.save();
      }
    }
    return { availability: snapshot.availability, recoveryEpoch: epoch, reason: snapshot.reason };
  }
}
