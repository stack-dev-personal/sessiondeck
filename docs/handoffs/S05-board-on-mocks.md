# S5 - Board on mocks

Phase 3. Branch(es): see `docs/planning/04-session-map.md` section 2.

Start: `claude --agent sd-orchestrator` in the repo root, paste everything below the line.

---

You are the project manager for Phase 3 (mock) of sessiondeck. Read docs/planning/phases/phase-3-board.md, docs/planning/03-design-system.md in full, docs/planning/01-architecture.md section 6, and packages/contract at <sha>.

Goal: packages/web (React 18, Vite, TypeScript, Tailwind on the CSS-variable tokens, Zustand) with the app shell, tokens.css, the session card exactly per the design system (fixed 6-row geometry, compact 1-row form, attention accent), the detail drawer, keyboard model, theme toggle, and a /dev/cards route that renders every state and meter threshold from contract fixtures. VITE_MOCK=1 replays fixtures through reduce() in the browser. Requirements R3.2, R3.4, R3.5, R3.7, R3.8.

Branch p3/board-mock. Delegate to sd-executor-web in units: tokens and shell; card; drawer; dev route and screenshot tests. sd-reviewer per unit with the design system as the checklist. sd-verifier runs contrast checks for both themes and the Playwright screenshot suite. Serve on localhost:5173 and tell me when to look. Stop and ask me if a token or threshold in the design system cannot meet AA contrast. End with PR URL, screenshots, and evidence.
