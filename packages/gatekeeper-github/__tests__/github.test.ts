import { describe, it, expect } from "vitest";
import { GitHubGatekeeperImpl } from "../src/github.js";

describe("GitHubGatekeeperImpl", () => {
  it("lists the expected auto-approvable actions with correct branchScoped flags", async () => {
    // getAutoApprovableActions doesn't use instance state, so a fake environment is sufficient.
    const fakeState = {} as any;
    const fakeEnv = {} as any;
    const gk = new GitHubGatekeeperImpl(fakeState, fakeEnv);

    const actions = await gk.getAutoApprovableActions();
    const byTag = new Map(actions.map(a => [a.tag, a]));

    // merge is fully manual: it must NOT be auto-approvable.
    expect(byTag.has("githubMergePullRequest")).toBe(false);

    // Branch-scoped actions: gated by branch patterns; declare a branchRef.
    for (const tag of [
      "githubWriteFile",
      "githubDeleteFile",
      "githubCreateBranch",
      "githubCreatePullRequest",
      "githubDispatchWorkflow",
    ]) {
      expect(byTag.has(tag)).toBe(true);
      expect(byTag.get(tag)!.branchScoped).toBe(true);
    }

    // Non-branch-scoped actions: ignore branch patterns; auto-apply when a rule exists.
    for (const tag of [
      "githubCreateIssue",
      "githubSetTitle",
      "githubSetBody",
      "githubAddLabels",
      "githubRemoveLabels",
      "githubChangeState",
      "githubPostComment",
      "githubPostReview",
      "githubReplyDiffComment",
    ]) {
      expect(byTag.has(tag)).toBe(true);
      expect(byTag.get(tag)!.branchScoped).toBe(false);
    }
  });
});
