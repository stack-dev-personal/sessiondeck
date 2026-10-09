---
name: borrow-code
description: Procedure for porting code from another open-source project into sessiondeck with license checks, attribution headers, and NOTICE entries. Use whenever a delegation names a Borrow source or an executor wants to copy more than a few lines from any repository.
---
# Borrow code

The borrow map is `docs/planning/01-architecture.md` section 9. It tells you which projects are code sources and which are specification only.

## Before copying
1. Confirm the license from the project's own `LICENSE` file (not a README badge, not memory). MIT, BSD, Apache-2.0, ISC: copy allowed. AGPL, GPL, no LICENSE file: do not copy; read for behavior and write your own.
2. Pin the exact source: repo, path, tag or commit. ccusage must be tag `v19.0.3` or earlier (v20 is Rust). Crystal is archived; use `main` at its last commit.
3. Copy the smallest unit that does the job (a function, a schema, a component), not the file.

## While copying
Header comment at the top of the borrowed block or file:

```ts
// Ported from <owner>/<repo> <path> @ <tag|commit> (<SPDX license>)
// Changes: <one line: renamed types to contract names, removed X, added Windows ctime check>
```

Apache-2.0 sources: keep any existing license header lines they carry, and add the project to `NOTICE` under "Actual borrowings" with the Apache notice text if the source ships a NOTICE file.

## After copying
1. Add a line to `NOTICE` under "Actual borrowings": `<repo> <path> → <our path> (<license>)`.
2. Write a test that exercises the borrowed code with sessiondeck's own fixtures, not the source project's.
3. Mention the borrowing in the executor report so sd-reviewer checks the header and NOTICE (it is on the reviewer's checklist).

## Specification-only sources
claudecodeui (AGPL) and disler's observability repo (no license): you may describe their behavior in a comment (`// Behavior matches claudecodeui's dropSupersededPromptBranches: ...`), never their code. If you are unsure whether what you wrote is a copy, it is; rewrite it from the behavior description.
