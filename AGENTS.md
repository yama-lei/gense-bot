## Development Workflow

Follow an "Intent → Spec → Design" workflow:
- Understand the user's intent first. Consider whether a better approach already exists.
- Once the intent is clear, assess how it fits the current architecture and specs. If a small adjustment to the intent would substantially simplify the specs or design, discuss the trade-off with the user and agree on a revised intent.
- Review the design and code. Use Git for implementation, develop new work on a branch such as `{feat,docs,fix}/{slug}`, and report the changes to the user.

## Coding Principles

- Do not write tests that only exercise mocks rather than real functionality.
- During beta, backward compatibility with previous designs is not required. Explain incompatible changes to the user.
- Testings should follow the Specs.

## Guidance Maintenance

- Commit only after the user gives permission. Use `{chore,feat,bugs,docs,harness}/slug: content` for commit messages and branch name. The harness means the way we deploy, develop and the way how agent works, use this slug when update prompts/skills or update deploy and develop scaffold.
- If you find conflicting content or opportunities for improvement, notify the user and obtain permission before making changes. Examples include improving grammar and clarity in `AGENTS.md` and fixing bugs in code.


## Collobration
1. Use `hc` to dispatch agents and communicate with other agents is suggested when you need to dispatch claude code/codex/pi for module developing.
2. Use cheap subagent for general purpose (like Haiku/Luna for explore, Sonnet/Terra for medium tasks)
