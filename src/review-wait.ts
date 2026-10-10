import type { IssueSummary, IssueReviewAttentionPath } from "./types.js";
import { PaperclipClient } from "./paperclip-client.js";

/**
 * True only if Paperclip's maintained review paths identify exclusively
 * human-owned next steps. Unknown, agent, monitoring and execution paths
 * fail closed. Never infer an owner from freeform comments or issue title.
 */
export async function isWaitingOnHumanReview(
  issue: IssueSummary,
  client: PaperclipClient,
): Promise<boolean> {
  if (issue.status !== "in_review") return false;
  const attention = issue.reviewAttention;
  if (!attention || attention.state !== "covered" ||
      !Array.isArray(attention.paths) || attention.paths.length === 0) return false;

  let detail: IssueSummary | null = null;
  let interactions: Awaited<ReturnType<PaperclipClient["listIssueInteractions"]>> | null = null;
  const getDetail = async () => {
    if (!detail) {
      detail = await client.getIssue(issue.id);
      if (!detail || detail.id !== issue.id || detail.status !== "in_review" ||
          (issue.companyId && detail.companyId !== issue.companyId) ||
          detail.assigneeAgentId !== issue.assigneeAgentId) {
        throw new Error("Review changed while checking " + issue.id);
      }
    }
    return detail;
  };
  const getInteractions = async () => {
    if (!interactions) interactions = await client.listIssueInteractions(issue.id);
    return interactions;
  };

  const isHumanPath = async (path: IssueReviewAttentionPath): Promise<boolean> => {
    switch (path.kind) {
      case "human_reviewer":
        return Boolean(path.ref);
      case "approval":
        // Issue approvals are formal, board-owned decisions.
        return Boolean(path.ref);
      case "execution_participant": {
        const issueDetail = await getDetail();
        const stage = issueDetail.executionState;
        const participant = stage?.currentParticipant;
        return stage?.status === "pending" &&
          participant?.type === "user" &&
          typeof participant.userId === "string" &&
          participant.userId.length > 0 &&
          participant.userId === path.ref;
      }
      case "interaction": {
        if (!path.ref) return false;
        const waiting = (await getInteractions()).find(x => x.id === path.ref && x.status === "pending");
        if (!waiting) return false;
        // A named human addressee has the next move. A human-only audience
        // is also authoritative even if no single user is named yet.
        return waiting.effectiveResolverPolicy === "human_only" ||
          (typeof waiting.addresseeUserId === "string" &&
           waiting.addresseeUserId.length > 0 &&
           !waiting.addresseeAgentId);
      }
      // Queued wakes, active runs, monitors and recovery paths mean another
      // participant or scheduler can still act. Do not bypass them.
      default:
        return false;
    }
  };
  for (const path of attention.paths) {
    if (!await isHumanPath(path)) return false;
  }
  return true;
}
