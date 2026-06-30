# Agent Guidelines

> [!IMPORTANT]
> **`CLAUDE.md` is the single source of truth for all AI agent behaviour in this repository.**
> Read `CLAUDE.md` in full before taking any action. The rules there take precedence over any defaults or prior training.

## What to read

| File | Purpose |
| --- | --- |
| [`CLAUDE.md`](./CLAUDE.md) | Absolute constraints, commands, architecture reference, and the "Push to git" workflow |

## Summary of absolute constraints

The full rules are in `CLAUDE.md`. Key points reproduced here for quick reference — **always defer to `CLAUDE.md` if anything conflicts**:

- **No git pushes** unless the user explicitly asks
- **No deployments** unless explicitly instructed
- **No unsolicited actions** — do only what was asked, nothing more
- **No tests or browser actions** unless explicitly requested
- **"Push to git"** triggers the full pre-push checklist defined in `CLAUDE.md` (doc sync, help sync, descriptive commit message, then push)
- **Minimize thinking and analysis**: Keep reasoning, planning, and explanations brief and direct. Act immediately on instructions without over-analyzing simple tasks.
