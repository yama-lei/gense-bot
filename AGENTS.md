## Development Workflow

Follow an "Intent → Spec → Design" workflow:
- Understand the user's intent first. Consider whether a better approach already exists.
- Once the intent is clear, assess how it fits the current architecture and specs. If a small adjustment to the intent would substantially simplify the specs or design, discuss the trade-off with the user and agree on a revised intent.
- Review the design and code. Use Git for implementation, develop new work on a branch such as `{feat,docs,fix}/{slug}`, and report the changes to the user.

## Coding Principles

- Do not write tests that only exercise mocks rather than real functionality.
- During beta, backward compatibility with previous designs is not required. Explain incompatible changes to the user.

## Guidance Maintenance

- Commit only after the user gives permission. Use `{chore,feat,bugs,docs}/slug: content` for commit messages and branch name.
- If you find conflicting content or opportunities for improvement, notify the user and obtain permission before making changes. Examples include improving grammar and clarity in `AGENTS.md` and fixing bugs in code.
