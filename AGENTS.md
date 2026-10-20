## Development Workflow

Follow an "Intent → Spec → Design" workflow:
- Understand the user's intent first. Consider whether a better approach already exists.
- Once the intent is clear, assess how it fits the current architecture and specs. If a small adjustment to the intent would substantially simplify the specs or design, discuss the trade-off with the user and agree on a revised intent.
- Review the design and code. Use Git for implementation, develop new work on a branch such as `{feat,docs,fix}/{slug}`, and report the changes to the user.

## Coding Principles

- Do not write tests that only exercise mocks rather than real functionality.
- During beta, backward compatibility with previous designs is not required. Explain incompatible changes to the user.

## Guidance Maintenance

- When you find mistakes or outdated content in skills or `AGENTS.md`, tell the user and fix the guidance only with their permission.

