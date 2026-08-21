import re

with open("packages/gatekeeper-github/src/github.ts", "r") as f:
    content = f.read()

content = re.sub(
    r'autoApprovable: true,\n\s*branchRef: action\.branch,',
    r'autoApprovable: true,\n      branchRef: action.branch ?? targetBranch,',
    content
)

with open("packages/gatekeeper-github/src/github.ts", "w") as f:
    f.write(content)
