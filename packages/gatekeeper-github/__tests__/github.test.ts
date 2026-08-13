import { describe, it, expect } from "vitest";
import { GitHubGatekeeperImpl } from "../src/github.js";
import { ActionKind } from "@gadgets/workshop-shared/api";

describe("GitHubGatekeeperImpl", () => {
  it("includes all auto-approvable actions in getAutoApprovableActions", async () => {
    // Assuming GitHubGatekeeperImpl can be instantiated or we can just check the returned actions
    // Wait, the constructor requires DurableObject state and env. 
    // We can just verify the list of action kinds returned.
    
    // Instead of instantiating the full DO which might be tricky in a unit test, 
    // we can create a mock or partial instance if needed.
    // However, getAutoApprovableActions doesn't use instance state.
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
