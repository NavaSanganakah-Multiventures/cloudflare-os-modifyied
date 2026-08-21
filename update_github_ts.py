import re

with open("packages/gatekeeper-github/src/github.ts", "r") as f:
    content = f.read()

# createIssue
content = re.sub(
    r'async createIssue\(options: GitHubCreateIssueOptions\): Promise<GitHubIssue> \{',
    r'async createIssue(options: GitHubCreateIssueOptions & { _awaitDecision?: boolean }): Promise<GitHubIssue> {',
    content
)
content = re.sub(
    r'actionKind: CREATE_ISSUE_ACTION,\n\s*autoApprovable: true,\n\s*\}\);',
    r'actionKind: CREATE_ISSUE_ACTION,\n      autoApprovable: true,\n      awaitDecision: options._awaitDecision ?? true,\n    });',
    content
)

# createPullRequest
content = re.sub(
    r'async createPullRequest\(options: GitHubCreatePullRequestOptions\): Promise<GitHubPullRequest> \{',
    r'async createPullRequest(options: GitHubCreatePullRequestOptions & { _awaitDecision?: boolean }): Promise<GitHubPullRequest> {',
    content
)
content = re.sub(
    r'actionKind: CREATE_PULL_REQUEST_ACTION,\n\s*autoApprovable: true,\n\s*branchRef: options\.head,\n\s*\}\);',
    r'actionKind: CREATE_PULL_REQUEST_ACTION,\n      autoApprovable: true,\n      branchRef: options.head,\n      awaitDecision: options._awaitDecision ?? true,\n    });',
    content
)

# createBranch
content = re.sub(
    r'async createBranch\(name: string, sha: string\): Promise<GitHubBranch> \{',
    r'async createBranch(name: string, sha: string, _awaitDecision = true): Promise<GitHubBranch> {',
    content
)
content = re.sub(
    r'awaitDecision: true,\n\s*actionKind: CREATE_BRANCH_ACTION,',
    r'awaitDecision: _awaitDecision,\n      actionKind: CREATE_BRANCH_ACTION,',
    content
)

# writeFile
content = re.sub(
    r'async writeFile\(options: GitHubWriteFileOptions\): Promise<GitHubCommitHandle> \{',
    r'async writeFile(options: GitHubWriteFileOptions & { _awaitDecision?: boolean }): Promise<GitHubCommitHandle> {',
    content
)
content = re.sub(
    r'awaitDecision: true,\n\s*actionKind: isWorkflowFilePath\(options\.path\) \? EDIT_WORKFLOW_FILE_ACTION : WRITE_REPO_FILE_ACTION,',
    r'awaitDecision: options._awaitDecision ?? true,\n      actionKind: isWorkflowFilePath(options.path) ? EDIT_WORKFLOW_FILE_ACTION : WRITE_REPO_FILE_ACTION,',
    content
)

# deleteFile
content = re.sub(
    r'async deleteFile\(options: GitHubDeleteFileOptions\): Promise<GitHubCommitHandle> \{',
    r'async deleteFile(options: GitHubDeleteFileOptions & { _awaitDecision?: boolean }): Promise<GitHubCommitHandle> {',
    content
)
content = re.sub(
    r'awaitDecision: true,\n\s*actionKind: isWorkflowFilePath\(options\.path\) \? EDIT_WORKFLOW_FILE_ACTION : DELETE_REPO_FILE_ACTION,',
    r'awaitDecision: options._awaitDecision ?? true,\n      actionKind: isWorkflowFilePath(options.path) ? EDIT_WORKFLOW_FILE_ACTION : DELETE_REPO_FILE_ACTION,',
    content
)

# proposeFileChange
content = re.sub(
    r'const branch = await this\.createBranch\(options\.branchName, defaultBranchRef\.sha\);',
    r'const branch = await this.createBranch(options.branchName, defaultBranchRef.sha, false);',
    content
)
content = re.sub(
    r'sha: options\.sha,\n\s*\}\);',
    r'sha: options.sha,\n      _awaitDecision: false,\n    });',
    content
)
# proposeFileDeletion
content = re.sub(
    r'branch: options\.branchName,\n\s*\}\);',
    r'branch: options.branchName,\n      _awaitDecision: false,\n    });',
    content
)

with open("packages/gatekeeper-github/src/github.ts", "w") as f:
    f.write(content)
