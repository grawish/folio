# Use the Folio documentation skill

The reusable skill is in `skills/folio-resume/`. It helps an assistant explain Folio's workflows, diagnose common problems, and find the right implementation guide. It is not a provider plugin or an app automation API.

Copy that entire folder into your assistant's supported skill directory. For Codex, the default is `~/.codex/skills/folio-resume/` (or `$CODEX_HOME/skills/folio-resume/` if configured). Keep `SKILL.md`, `agents/`, `references/`, LICENSE and NOTICE together. Do not overwrite an unrelated existing skill.

Example prompts:

- “Use $folio-resume to help me connect my installed Codex account.”
- “Use $folio-resume to explain how I can mark a PDF and ask for a change.”
- “Use $folio-resume to help me keep my outside edits after an interrupted import.”
- “Use $folio-resume to find why my PDF is out of date.”

The entrypoint loads only the reference needed for the task. It preserves Settings-only AI selection, local/cloud privacy distinctions, draft protection and release limitations.

## Maintain it

The user guides are the source of truth. Run `npm run skill:build` after updating them. This regenerates the standalone references without requiring the recipient to clone the repository. The repository's CI checks that regeneration leaves the committed skill unchanged.

The skill was checked with the skill-creator frontmatter/scaffold validator and its local references were checked for existence. That validates packaging, not every possible assistant response. Update guidance when real usage reveals an inaccurate or missing decision.
