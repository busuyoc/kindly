# Skills Audit — What's Reusable from MateGenius for korea

Source: `/Users/claw/mategenius/.claude/{skills,commands,memory}/`. Report-only — nothing copied yet.

## Inventory

| Skill | Purpose (1 line) | Reusable for korea | Why / Notes |
|-------|------------------|--------------------|-------------|
| **planner** | Strategic planning mode with lenses (business/technical/product/ux-research); 3 modes: planning, brainstorm, refine | **Yes** (core mechanics), needs new lenses | Domain-agnostic mechanics. Current lenses are tuned to MG (pricing, B2B/B2C, Java/Spring). For korea we'd rewrite lenses: `technical` (CLI/filesystem/cross-platform), `product` (CLI UX, new-user onboarding), `ecosystem` (KOReader plugin compat), drop `business` until pricing matters. |
| **implement** | `plan` + `exec` modes; 4-step plan (discovery → draft → paradigm check → elegance), layer-by-layer exec with build gates | **Yes, high-value**, needs adapt | Framework is generic (KISS/SOLID/DRY/YAGNI + elegance pass). Layer tables (L1-L7 Migration/Entity/Repository/...) are Spring-specific — rewrite for korea's stack (Rust/Go/Python? parser → model → differ → applier → CLI). Zero Hardcode Rule + build checkpoints port directly. |
| **commit** | Auto-detect files → classify → resolve Jira epic → sanity scan → checklist → commit+push+Jira | **Partial** — drop Jira, keep structure | Commit classification + pre-commit sanity grep (hardcoded values, unsafe patterns) is excellent. Jira integration (`commit-helper.py`, epic mapping, transitions) is MG infrastructure — strip. Keep the PAUSE-before-execute gate. |
| **review** | 6 parallel agents per story diff → triage findings → fix → DoD close | **Yes, adapt** | Multi-agent parallel review is the reusable pattern. `be-agents.md` / `fe-agents.md` reference files are MG paths — rewrite for korea (parser agent, CLI UX agent, cross-platform agent, test coverage agent). |
| **sprint** | Orchestrator: plan → test-plan → reconcile → implement → review → test-run, one agent per step with fresh context | **Yes, conceptually** | The orchestrator-dispatches-fresh-context-agents pattern is gold for korea's iterative dev. Templates tied to Jira/status file — need stripped version. |
| **sprint-review** | 5-lens product completeness check: design vs stories vs code | **Yes, adapt** | Generic pattern: "does our implementation actually deliver the promised user journey?" Lens 1 (User Journey Mapping) is the reusable core. |
| **tester** | 5 lens agents (Happy Path, Adversarial, Integration, Temporal, User Fitness) generate test cases, then consolidate into curl script | **Yes, adapt**, very relevant | The lens-based test-case generation is domain-agnostic. For korea: Happy Path + Adversarial + Cross-Platform (macOS/Linux) + Device-State (mounted/unmounted/corrupted config) + Round-Trip (pull then apply = identity). Replace curl with korea CLI invocations. |
| **scaffold-service** | Checklist-driven Spring Boot service scaffold | **No** | Pure MateGenius microservice pattern. |
| **git-status** | Collector script → Romanian team-aware report on deploy state, pending commits, per-committer work | **No** | Team-specific (team-aliases.json, prod/uat tags). Korea is solo. |
| **git-merge** | Safe merge with pre-merge checks | **Yes** (trivial) | Generic; lift as-is if wanted. Low value for solo project. |
| **atlassian** | Jira/Confluence via curl (bypass MCP) | **No** | MG-only. |
| **design** | MateGenius design-system-aware FE redesign | **No** | Web-only, MG design tokens. |
| **frontend-test-and-fix** | Playwright visual test pipeline with evaluator agents on screenshot chunks | **No** | korea is a CLI, no UI to screenshot. |
| **cold-email** | B2B outreach file generator | **No** | MG go-to-market. |
| **social-post** | Math-exercise carousels | **No** | MG content. |
| **format-latex / latex-audit** | LaTeX cleanup for BAC variants | **No** | MG content. |
| **bac-pipeline / bac-b2b-pipeline** | BAC variant generation | **No** | MG content. |
| **practice-* (fill/generate/pipeline/status) / process-lesson** | Math-content generation pipelines | **No** | MG content. |
| **sim-service-design** | Design hub for sim-service | **No** | MG-specific. |
| **commands/{bac_status, improve_bac, prod_users}** | Old-style slash commands for MG ops | **No** | MG-specific. |

## Planner-lens deep dive

This is the most transferable pattern. Structure:

```
.claude/memory/
  planner-brain.md          ← the methodology (how to think)
  planner-lens-business.md  ← one perspective
  planner-lens-technical.md ← one perspective
  planner-lens-product.md   ← one perspective
  planner-lens-ux-research.md
.claude/skills/planner/SKILL.md ← the invoker/dispatcher
```

### The brain
`planner-brain.md` owns the meta-methodology — it's deliberately domain-neutral:

> "Nu dezvoltăm. Înțelegem, aprofundăm, documentăm, rafinăm." — philosophy.
> "O decizie e o decizie — nu revii decât dacă apare info nouă." — decision durability.
> "Story = CE + DE CE, nu CUM." — story content discipline (story holds behavior + why, not code).

The brain also contains process recipes: Faza 1 (structurare raw input), Faza 2 (decizii în ordine de dependență: arhitectură → tech core → business → UX → detaliu tehnic), Faza 3 (deep-dive separate docs when a topic > 3-4 bullets), Faza 4 (capture off-topic ideas immediately).

### The lenses
Each lens is a *framework repository* for one perspective. E.g. `planner-lens-technical.md`:
- **Frameworks**: Microservice Decision, Coupling Assessment, Flow Differentiator, State Machine Completeness, Cross-Service Dependency Inventory, Deployment Parity...
- **Întrebări de pus mereu**: the questions the lens always asks ("Ce e sync, ce e async?", "Ce supraviețuiește restart?", "Câte flow-uri partajează același data model?").
- **Anti-patterns** + **Principii validate** + **Lecții din Sprint N**: the lens *learns* over time (validated principles get appended after every sprint/retrospective).

Explicit rule (from brain, line 117):

> "Nu pune date specifice unui feature în lentile — lentilele sunt framework-uri generale. Datele specifice trăiesc în design docs și skills per feature."

This separation is what makes the lens scalable: lenses carry **principles**, design docs carry **specifics**.

### The three modes
1. **Standard planning** — single or combined lens on raw input; produces EPIC.md.
2. **Brainstorm** (3 rounds) — parallel agents per lens, cross-critique, orchestrator synthesis with mandatory 1:1 cross-check (TECH-XX → SIM-XX).
3. **Refine** — one primary lens drafts story, others consulted as needed; KISS red-flag table gate before presenting.

Validated insight from brain:

> "3 agenți paraleli cu lentile diferite = tensiuni productive care nu apar în brainstorming solo. Runda 2 (critică încrucișată) > Runda 1 ca quality."

### Is it applicable to korea?
**Yes**, with different lenses. korea's decision surface has genuine tensions between:

- **ecosystem-lens** — what does KOReader actually store, how do plugin authors version configs, what breaks across KOReader versions, SimpleUI vs stock UI divergence
- **technical-lens** — schema design (YAML/TOML), parser, diff algorithm, idempotency of `apply`, cross-platform filesystem (Kindle vs Kobo vs PocketBook mount points)
- **product-lens** — CLI UX (`korea pull` then `korea diff` must feel like `git`), new-user ergonomics (`korea init minimal` discoverability), error messages when a plugin is missing
- **ux-research-lens** — what do r/koreader posters *actually* share, what pain gets re-mentioned, what does Chezmoi do right

The multi-lens brainstorm round would surface conflicts like "technical wants strict schema validation / product wants `apply` to be forgiving when a plugin is missing". Worth adopting once korea has an EPIC.md + first design docs (not before).

## Reusable patterns (ideas, not files)

1. **Brain + lens split** — one methodology file, N perspective files; lenses carry frameworks + accumulated lessons, not feature data. Port directly.
2. **"Story = CE + DE CE, not CUM"** — any story/issue template for korea should require a DE CE (why/impact) section and forbid source code inside. This discipline survived through the MG pipeline (PLAN, TEST_PLAN, IMPLEMENT, REVIEW all read DE CE).
3. **Plan-layer discipline with Build Checkpoints** — `implement`'s L1…L7 with build gates after checkpoint groups prevents error accumulation. For korea: L1 schema → L2 parser → L3 model → L4 differ → L5 applier → L6 CLI → L7 tests, with `cargo build` / `go test` between groups.
4. **Paradigm check + Elegance pass** — KISS/SOLID/DRY/YAGNI red-flag tables, then one "is there a more elegant form?" pass. Both are generic; lift the tables into korea's planning skill.
5. **Multi-agent lens-based test generation** (`tester`) — 5 parallel lenses (Happy/Adversarial/Integration/Temporal/User-Fitness) generate UCs, consolidate, emit an executable script. Excellent fit for korea: `korea apply` has rich failure surface (device unmounted mid-apply, conflicting plugin configs, KOReader running, version mismatch).
6. **Multi-agent parallel review** (`review`, 6 BE agents) — one per concern (Compliance, Security, Testing, Performance, UX, Architecture). For korea: Parser correctness, Cross-platform paths, CLI ergonomics, Idempotency, Test coverage, Error messages.
7. **Commit sanity grep before commit** (from `commit` skill step 1e) — pre-commit grep for hardcoded URLs/paths/credentials. Trivial to port; valuable.
8. **PAUSE-before-execute gate** (`commit`, `implement`) — always present a checklist, wait for explicit accept. Good default for agentic workflows.
9. **Orchestrator with fresh-context agents** (`sprint`) — thin orchestrator reads status file, dispatches agent per step with minimal context, validates artifact, moves on. Prevents context pollution across pipeline steps.
10. **Living skill** — `planner` ends with "Actualizează brain + lentile cu lecții noi după fiecare sesiune." Every skill should capture lessons into its own memory over time. The `Lecții din Sprint 5` append-only sections in the lens files are the concrete evidence this works.
11. **KISS red-flag table at refine time** — explicit table (new column / new migration / new DTO / new abstraction / denormalization / externalized config) with "is this actually needed?" check. Port as-is, adapt red flags to korea domain (new schema field, new config layer, new CLI subcommand, new format variant).
12. **Cross-check mapping (brainstorm round 3)** — after parallel lens output is consolidated, orchestrator must produce a 1:1 table (each TECH-XX story → SIM-XX or explicitly V2+). Prevents stories falling between cracks. Port.

## Direct lifts (symlink/copy with minimal edits)

Tier A — copy with find/replace only:
- `.claude/memory/planner-brain.md` → keep philosophy + process, drop the Hormozi pricing section and Dual Thinking B2B framing (not relevant yet).
- `.claude/skills/planner/SKILL.md` → keep entire structure, swap lens filenames and `sim-service-design` example references.

Tier B — copy skeleton, rewrite body:
- `.claude/memory/planner-lens-technical.md` → keep structure (Focus / Frameworks / Întrebări / Anti-patterns / Principii / Lecții). Rewrite all frameworks for korea's domain (no async pipelines, replace with: Cross-Platform Filesystem, Schema Evolution, Idempotency Guarantees, Plugin Compat Matrix, Parse-Apply Round-Trip).
- `.claude/memory/planner-lens-product.md` → keep structure. Replace Dual Perspective (B2C/B2B) with Dual-Mode (interactive CLI vs CI/scripted), Friction Mapping stays.
- `.claude/skills/implement/SKILL.md` + `PLAN_TEMPLATE.md` → keep the plan/exec structure, Zero Hardcode Rule, paradigm check + elegance pass. Rewrite layer tables for korea's stack.
- `.claude/skills/tester/SKILL.md` + `templates/lens-*.md` → strong fit; rewrite lens prompts for CLI+filesystem instead of HTTP+Testcontainers, swap `test-template.sh` from curl to korea CLI invocations.
- `.claude/skills/commit/SKILL.md` → keep analyze → checklist → execute shape. Gut Jira + epic sections. Keep sanity grep; rewrite patterns for korea (hardcoded device paths, hardcoded user homes, `unwrap()`/`panic!` in library code if Rust, etc.).

Tier C — useful but optional:
- `.claude/skills/sprint/SKILL.md` + templates — only worth it once korea has multiple features in flight.
- `.claude/skills/sprint-review/SKILL.md` — only after the first "sprint" equivalent.
- `.claude/skills/git-merge/SKILL.md` — trivial; lift only if the branching workflow warrants it.

## Recommendations — wire up first

If I were Claudiu, I'd wire these three into `/Users/claw/korea/.claude/` **in this order**, and skip the rest until korea has actual implementation in flight:

### 1. `planner` + brain + 3 lenses (ecosystem / technical / product)
**Why first:** korea is in the design phase (EPIC-style docs, open questions, architecture). The planner skill is literally built for this phase: "Nu dezvoltăm. Înțelegem, aprofundăm, documentăm, rafinăm." Lenses guarantee you don't miss the ecosystem angle (KOReader plugin authors, version fragmentation) while obsessing over schema design.

**Concrete win:** `/planner brainstorm korea-schema` would run 3 parallel lenses on your current `01-profile-schema.md` and surface conflicts you haven't seen yet.

### 2. `implement` (plan + exec modes)
**Why second:** once schema + architecture are settled, every feature ("add plugin-enable/disable", "add diff renderer", "add gist publish") should go through plan → paradigm → elegance → exec with build gates. Zero Hardcode Rule alone will save you from hardcoding `/Volumes/Kindle` six places.

**Concrete win:** forces you to think about reuse and KISS red flags before writing code, on a greenfield project where "just one more abstraction" is the biggest risk.

### 3. `tester` (lens-based test-case generator)
**Why third:** `korea apply` is the feature that can destroy a user's device config. The adversarial + temporal + integration lenses will generate failure modes you won't think of solo (device unmounts mid-write, KOReader running during apply, schema v1 profile against KOReader v2, partial apply + retry). Emit a bash test harness that runs against real KOReader directories.

**Concrete win:** gives you a test plan before writing the `apply` command, which is exactly the feature where you want it.

**Skip for now:** `review`, `sprint`, `sprint-review`, `commit`. They shine with team workflow / Jira / multiple parallel stories. Solo greenfield doesn't need them yet. `commit` is worth revisiting once you're on a release cadence — port just the sanity-grep piece into a git pre-commit hook instead of a full skill.

## Key file references

- Methodology: `/Users/claw/mategenius/.claude/memory/planner-brain.md`
- Lenses: `/Users/claw/mategenius/.claude/memory/planner-lens-{business,technical,product,ux-research}.md`
- Planner invoker: `/Users/claw/mategenius/.claude/skills/planner/SKILL.md`
- Implement skill + template: `/Users/claw/mategenius/.claude/skills/implement/{SKILL.md,PLAN_TEMPLATE.md}`
- Tester skill + lens templates: `/Users/claw/mategenius/.claude/skills/tester/{SKILL.md,templates/lens-*.md}`
- Review skill (multi-agent): `/Users/claw/mategenius/.claude/skills/review/{SKILL.md,templates/}`
- Commit skill: `/Users/claw/mategenius/.claude/skills/commit/SKILL.md`
- Sprint orchestrator: `/Users/claw/mategenius/.claude/skills/sprint/SKILL.md`
