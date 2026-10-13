import type { PaperclipClient } from "./paperclip-client.js";

/** A single authenticated line in the *current CTO run's* issue comment. */
export type CTOHandoff = "waiting" | "ready" | null;
export async function readLatestCtoHandoff(
  client: PaperclipClient,
  issueId: string | null | undefined,
  runId: string | null | undefined,
  ctoId: string,
): Promise<CTOHandoff> {
  if (!issueId || !runId) return null;
  const comments = await client.listIssueComments(issueId);
  for (const comment of comments) {
    if (comment.authorAgentId !== ctoId || comment.createdByRunId !== runId) continue;
    const tokens = comment.body.split(/\r?\n/).map(v => v.trim()).filter(Boolean);
    if (tokens.includes("WATCHER: WAITING_FOR_HUMAN")) return "waiting";
    if (tokens.includes("WATCHER: READY")) return "ready";
  }
  return null;
}
