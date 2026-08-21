import { describe, it, expect } from "vitest";
import { GitHubGatekeeperImpl, isWorkflowFilePath } from "../src/github.js";

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
    expect(tags).toContain("githubRepoWriteFile");
    expect(tags).toContain("githubRepoDeleteFile");
    expect(tags).toContain("githubCreateBranch");
    expect(tags).toContain("githubEditWorkflowFile");
  });

  describe("isWorkflowFilePath", () => {
    it("recognizes workflow files directly under .github/workflows/", () => {
      expect(isWorkflowFilePath(".github/workflows/ci.yml")).toBe(true);
      expect(isWorkflowFilePath(".github/workflows/deploy.yaml")).toBe(true);
      // Leading slash is tolerated.
      expect(isWorkflowFilePath("/.github/workflows/ci.yml")).toBe(true);
    });

    it("rejects non-workflow paths", () => {
      expect(isWorkflowFilePath("packages/gatekeeper-github/src/github.ts")).toBe(false);
      expect(isWorkflowFilePath(".github/workflows/ci.txt")).toBe(false);
      expect(isWorkflowFilePath("docs/workflows/ci.yml")).toBe(false);
      expect(isWorkflowFilePath(".github/workflows")).toBe(false);
    });

    it("rejects files nested in subdirectories of .github/workflows/", () => {
      // GitHub does not recognize workflow files in subdirectories.
      expect(isWorkflowFilePath(".github/workflows/subdir/ci.yml")).toBe(false);
      expect(isWorkflowFilePath(".github/workflows/a/b/deep.yaml")).toBe(false);
    });
  });
});
