# Research plan

Before picking features, stack, or scope, understand the user base.

## Sources

- **r/koreader** — posts + top comments, last 6-12 months
- **r/kindle**, **r/kobo**, **r/eink** — cross-references to KOReader setup
- **KOReader GitHub discussions & issues** — feature requests, pain points
- **SimpleUI issues** — recurring themes, what people struggle with
- **MobileRead forums** — older/deeper KOReader conversations
- **Hacker News** — threads on zlibrary.koplugin, KOReader
- **YouTube setup guides** — what do they spend time explaining? (= what's confusing)

## Questions to answer

### Pain points

1. What's the #1 complaint about configuring KOReader?
2. How often do people ask "how do I set up X"? Which X?
3. What plugins do people most often mention wanting to disable?
4. What plugins do people most often install post-factory-reset?
5. How much ProjectTitle → SimpleUI migration pain is there? ("I switched from PT and now...")
6. Factory reset / new device stories — how painful is re-setup?

### Setup sharing patterns

7. How common are "here's my setup" posts? (= appetite for shareable profiles)
8. What format do people currently share in? (prose, screenshots, gists?)
9. Do people reference each other's setups? Any community dotfile-like repos?
10. How detailed/reproducible are these shares?

### Multi-device

11. How many users own multiple KOReader devices?
12. Do they want parity across devices? Or device-specific?

### Plugins & customization depth

13. Beyond SimpleUI, what are the top 5 community plugins?
14. What's the zlibrary plugin adoption like?
15. Gestures — are custom gesture maps a big thing?
16. Fonts, themes — common customization?

### Anti-signals

17. Is there any tool in this space already? (if yes, why did it fail / why are we different)
18. Do people actually want another CLI, or is the audience non-technical?
19. What % of r/koreader users would install something that requires `brew install ...`?

### Technical reality check

20. Does KOReader really expose all config via `settings.reader.lua`, or are there hidden state files?
21. How often do schema-breaking changes land in KOReader main?
22. How do Kobo/Boox/Kindle differ in where they mount + where KOReader lives?

## Deliverables from research

- `docs/10-research-findings.md` — structured notes per question
- `docs/11-feature-priorities.md` — features ranked by pain-point frequency
- `docs/12-prior-art.md` — any existing tools, what they do, why not enough

## Stack decision deferred

Don't lock Rust/Go/TS until we know:
- Whether Lua interop is actually needed (vs pure text manipulation of `settings.reader.lua`)
- Target audience technical level (affects install story)
- Whether web UI is needed at all or CLI is enough
