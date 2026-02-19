# Zhuge Loop Open Source Master Plan (v1.0)

Last updated: 2026-02-19

## 1. Purpose

This plan defines how `zhuge-loop` evolves from a stable core runtime into an open-source product that is:

- easy to start (`run --once` success in under 10 minutes),
- memorable (keeps the Three Kingdoms identity),
- reusable across projects (vendor-neutral shell command orchestration).

## 2. Product Strategy

### 2.1 Dual-Layer Product Design

- Brand layer: Three Kingdoms role templates (`zhuge`, `zhaoyun`, `guanyu`, `zhangfei`, `caocao`) as default onboarding language.
- Engine layer: generic runtime (`profile`, `phases`, `rotation`) with no hard dependency on any specific agent vendor.

### 2.2 Progressive Disclosure (Key DX Principle)

- Level 1 (Beginner): `zhuge-solo` preset, one-role flow, minimum concepts.
- Level 2 (Team): `zhuge-team` preset, coordinator → executor → reviewer.
- Level 3 (Advanced): custom roles, custom adapters, multi-team routing.

### 2.3 Default Positioning

- Not “fully generic agent framework.”
- Not “hard-wired Kiro/Claude tooling.”
- It is “a reliable autonomous dev loop runtime with Zhuge methodology presets.”

## 3. North Star Goals (v1.0)

- New repository from zero to first successful `run --once` in <= 10 minutes.
- Vendor-neutral integration via shell commands.
- Documentation and CLI behavior remain 1:1 aligned.
- Three Kingdoms role system is first-class in product narrative and starter presets.

## 4. Non-Goals (v1.0)

- Notion sync in core.
- Auto-push/auto-merge in core.
- Vendor-specific runtime implementation bundled in core.
- Full parity with private `airline-simulation` orchestration script in v1.0.

## 5. Workstreams

### WS-A: Onboarding & CLI

- `quickstart` path with minimal user inputs.
- `init --preset` with practical templates.
- `doctor --strict` for preflight validation.

### WS-B: Templates & Bridge

- policy-to-runtime mapping docs (`AGENTS.md` / `CLAUDE.md` -> `profile/phases`).
- starter pack (`AGENTS`, `CLAUDE`, handoff, multi-team config).
- Three Kingdoms role template pack.

### WS-C: Quality & Reliability

- CI + smoke tests + integration tests.
- clearer error messages and diagnostics.
- release guardrails.

### WS-D: Ecosystem & Adoption

- showcase examples from real usage patterns.
- migration guides from custom loops.
- contributor workflow and release process.

## 6. 10-Week Roadmap

## Phase 1 (Week 1-2): P0-1 Onboarding Consistency

### Scope

- Rewrite README with one primary onboarding path and two advanced paths.
- Add `init --preset`.
- Add `doctor --strict`.
- Add config schema early (to support strict validation).

### Deliverables

- `README.md` with:
- 30-second value proposition.
- Path A: `zhuge-solo` quickstart.
- Path B: policy-driven (`AGENTS` / `CLAUDE`) usage.
- Path C: multi-agent team flow.
- `src/cli.js`: parse `--preset`, `--strict`.
- `src/config.js`: `PRESETS` catalog and preset-driven sample generation.
- `schema/zhuge.config.schema.json`.

### Definition of Done

- Three clean repos (`node-lib`, `react-vite`, `python`) run:
- `init --preset ...`
- `doctor --strict`
- `run --once`
- Success rate >= 90%.

## Phase 2 (Week 3-4): P0-2 Templates and Policy Bridge

### Scope

- Ship practical starter files and role templates.
- Explain policy-runtime mapping with concrete examples.

### Deliverables

- `starters/AGENTS.md.template`
- `starters/CLAUDE.md.template`
- `starters/handoff.md.template`
- `starters/multi-team.zhuge.config.json`
- `starters/TEAM_COMPOSITION.md`
- `starters/agents/*.json` (Three Kingdoms roles, vendor-neutral fields)
- `docs/policy-runtime-bridge.md`

### Definition of Done

- A developer unfamiliar with the repo completes one full turn from docs only (no verbal guidance).

## Phase 3 (Week 5-6): P1 Engineering Credibility

### Scope

- CI baseline and integration testing.
- Better runtime error UX.

### Deliverables

- `.github/workflows/ci.yml`
- lint configuration (`eslint.config.js`)
- `tests/integration.test.js`:
- `init -> doctor -> run --once`
- preset config normalization checks
- Error improvements in:
- `src/config.js` (fix suggestions),
- `src/lock.js` (owner pid/start time),
- `src/loop.js` (recent failure summaries on fuse halt).

### Definition of Done

- PR CI gate is required and green.
- Local smoke test reproducible by fresh clone.

## Phase 4 (Week 7-8): P1 Real-World Productization

### Scope

- Extract reusable patterns from `airline-simulation`.
- Keep project-specific behavior out of core.

### Deliverables

- `examples/multi-team-pipeline/zhuge.config.json`
- `examples/multi-team-pipeline/README.md`
- `docs/migration-from-custom-loop.md`

### Definition of Done

- One internal custom loop can migrate to `zhuge-loop` config with no runtime code change.

## Phase 5 (Week 9-10): P2 Release & Community

### Scope

- npm release hardening.
- contribution and issue workflows.
- docs structure stabilization.

### Deliverables

- `package.json` release metadata (`files`, `repository`, `homepage`, `prepublishOnly`)
- versioned docs structure under `docs/`
- `CONTRIBUTING.md`
- `.github/ISSUE_TEMPLATE/*`

### Definition of Done

- `v1.0.0` published.
- at least five external successful onboarding reports.

## 7. Core vs Optional Boundary

### Core (must stay lightweight)

- lock, timeout, fuse, state/logging
- profile rotation and phase execution
- preset initialization
- doctor checks
- config validation/schema

### Optional (adapter/plugin style)

- agent runtime abstraction module
- vendor-specific adapters
- auto-push / auto-merge
- Notion/task system integration
- heavyweight review automation

## 8. Three Kingdoms Template Policy

### Preserve identity without lock-in

- Default onboarding uses Three Kingdoms names.
- Each role always includes plain engineering label:
- `zhuge (Coordinator/Architect)`
- `zhaoyun (Senior Developer)`
- `guanyu (Staff Reviewer)`
- `zhangfei (Breakthrough/Stress Tester)`
- `caocao (Automation/DevOps)`
- Role templates are portable JSON structures; runtime remains shell-command-driven.

## 9. KPI Framework

### Activation KPI

- median time to first successful `run --once` <= 10 minutes.

### Reliability KPI

- no crash/lock dead state in 24h continuous test runs.

### Understandability KPI

- first-time users can start without reading advanced docs.

### Adoption KPI

- external repos using presets and reporting successful onboarding.

## 10. Risks and Mitigations

- Risk: overfitting to `airline-simulation` private patterns.
- Mitigation: strict core/optional boundary and extraction review.

- Risk: docs drift from implementation.
- Mitigation: CI smoke tests for documented commands and sample configs.

- Risk: beginner overload from too many concepts.
- Mitigation: single-path quickstart first, advanced sections later.

- Risk: identity diluted by generic wording.
- Mitigation: keep Three Kingdoms presets as default narrative.

## 11. Execution Cadence

- Weekly planning: lock top 3 priorities.
- Mid-week checkpoint: verify DoD risks.
- End-week demo: run fresh-clone onboarding + smoke pipeline.
- Every phase closes only after DoD + KPI check + docs sync.

## 12. Immediate Next Steps (Start This Week)

- Implement `init --preset` with `zhuge-solo` as default recommendation.
- Add `schema/zhuge.config.schema.json` and wire strict validation.
- Redesign README first screen to one-command quickstart flow.
- Add initial CI workflow with test + smoke run.
- Draft `docs/policy-runtime-bridge.md` using existing env vars:
- `ZHUGE_TURN`
- `ZHUGE_PROFILE`
- `ZHUGE_PHASE`
