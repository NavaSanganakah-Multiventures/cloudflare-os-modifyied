import { describe, it, expect } from "vitest";
import { GitHubGatekeeperImpl } from "../src/github.js";
import { ActionKind } from "@gadgets/workshop-shared/api";

describe("GitHubGatekeeperImpl", () => {
  it("includes all auto-approvable actions in getAutoApprovableActions", async () => {
    // getAutoApprovableActions doesn't use instance state, so a fake environment is sufficient
    const fakeState = {} as any;
    const fakeEnv = {} as any;
    const gk = new GitHubGatekeeperImpl(fakeState, fakeEnv);
    
    const actions = await gk.getAutoApprovableActions();
    const tags = actions.map(a => a.tag);
    
    expect(tags).toContain("githubCreatePullRequest");
    expect(tags).toContain("githubDispatchWorkflow");
    expect(tags).toContain("githubMergePullRequest");
    expect(tags).toContain("githubCreateIssue");
    expect(tags).toContain("githubSetTitle");
    expect(tags).toContain("githubSetBody");
    expect(tags).toContain("githubAddLabels");
    expect(tags).toContain("githubRemoveLabels");
    expect(tags).toContain("githubChangeState");
    expect(tags).toContain("githubPostComment");
    expect(tags).toContain("githubPostReview");
    expect(tags).toContain("githubReplyDiffComment");
    expect(tags).toContain("githubWriteFile");
    expect(tags).toContain("githubDeleteFile");
    expect(tags).toContain("githubCreateBranch");
  });
});
