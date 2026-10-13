import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PaperclipClient } from "./paperclip-client.js";
import { isWaitingOnHumanReview } from "./review-wait.js";
import type { IssueSummary, PushoverConfig } from "./types.js";

type FetchLike = typeof fetch;

/**
 * Delivers one push per new human-owned review or pending interaction.
 * Notification state is independent from CTO idle state. This code never
 * answers a question, changes an issue or triggers an agent run.
 */
export class HumanInputNotifier {
  private readonly path: string;
  private delivered: Set<string> | null = null;
  constructor(
    private readonly client: PaperclipClient,
    private readonly stateDir: string,
    private readonly config: PushoverConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.path = join(stateDir, "human-input-notifications.json");
  }

  private async load(): Promise<Set<string>> {
    if (this.delivered) return this.delivered;
    let raw: string;
    try { raw = await readFile(this.path, "utf8"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return (this.delivered = new Set());
      throw err;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some(value => typeof value !== "string")) {
      throw new Error("Invalid notification state");
    }
    return (this.delivered = new Set(parsed as string[]));
  }

  private async save(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const tmp = this.path + "." + randomUUID() + ".tmp";
    await writeFile(tmp, JSON.stringify([...this.delivered!]) + "\n", { mode: 0o600 });
    await rename(tmp, this.path);
  }

  private link(issue: IssueSummary): string | null {
    const identifier = issue.identifier;
    if (!identifier || !/^[A-Za-z0-9]+-[0-9]+$/.test(identifier)) return null;
    const prefix = identifier.split("-")[0];
    return this.config.baseUrl + "/" + encodeURIComponent(prefix!) +
      "/issues/" + encodeURIComponent(identifier);
  }

  private async send(issue: IssueSummary, label: string, key: string): Promise<void> {
    const link = this.link(issue);
    if (!link) throw new Error("Cannot link Paperclip issue " + issue.id);
    const form = new URLSearchParams({
      token: this.config.token,
      user: this.config.user,
      title: "Shape Display: antwoord nodig",
      message: (issue.identifier ?? "Paperclip") + ": " +
        (issue.title ?? "Een vraag of goedkeuring wacht op jou") +
        "\n" + label + ". Open Paperclip om te antwoorden.",
      url: link,
      url_title: "Open vraag in Paperclip",
      priority: "0",
    });
    const response = await this.fetchImpl("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Pushover rejected notification: HTTP " + response.status);
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || (payload as { status?: number }).status !== 1) {
      throw new Error("Pushover did not acknowledge notification");
    }
    this.delivered!.add(key);
    await this.save();
  }

  async poll(companyId: string, ctoAgentId: string): Promise<number> {
    const sent = await this.load();
    const issues = await this.client.listAssignedIssues(companyId, ctoAgentId);
    let count = 0;
    for (const issue of issues) {
      if (issue.status !== "in_review") continue;
      if (!await isWaitingOnHumanReview(issue, this.client)) continue;
      const paths = issue.reviewAttention?.paths ?? [];
      for (const path of paths) {
        if (this.config.userId && path.kind === "human_reviewer" &&
            path.ref !== this.config.userId) continue;
        if (this.config.userId && path.kind === "execution_participant" &&
            path.ref !== this.config.userId) continue;
        if (this.config.userId && path.kind === "approval") continue; // ownership not verified
        if (path.kind === "interaction") {
          const interactions = await this.client.listIssueInteractions(issue.id);
          const interaction = interactions.find(item => item.id === path.ref && item.status === "pending");
          if (!interaction) continue;
          if (this.config.userId && interaction.addresseeUserId !== this.config.userId) continue;
        }
        const key = issue.id + ":" + path.kind + ":" + path.ref;
        if (sent.has(key)) continue;
        await this.send(issue, "Menselijke reactie vereist", key);
        count++;
      }
    }
    return count;
  }
}
