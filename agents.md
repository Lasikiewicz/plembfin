# Agent Guidelines

> [!IMPORTANT]
> The following rules are absolute constraints. You must adhere to them strictly under all circumstances.

- **NO Git Pushes**: Never execute `git push` or push commits to any remote repository unless the user explicitly instructs you to push in their request.
- **NO Deployments**: Never deploy the application or run deployment commands (e.g., `firebase deploy`) unless explicitly instructed by the user.
- **Deploy Shortcut**: If the user simply says `Deploy`, treat that as explicit instruction to deploy the entire site to Firebase and push the current Git branch to its remote.
- **No Unsolicited Actions**: Do only exactly what the user asks. Do not perform unsolicited refactorings, add extra features, or modify files outside the direct scope of the request.
- **NO Tests or Browser Actions**: Never run test commands (e.g., `npm test`, `pytest`) or open web browsers/browser tools unless the user has explicitly requested it.
