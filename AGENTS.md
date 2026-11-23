# AGENTS.md - stock-ai

Project context for all AI agents working in this repository. Loaded automatically at the project root.

## Mantras

Problem First, Why before How, Visualization.
0 Trust and 100 percent Control. 0 Magic and 100 percent Transparency. 0 Hardcoding and 100 percent Flexibility.

## Reply Gate

Before replying, check: an ASCII diagram for the main idea, a table for comparisons, full connected sentences, then diagram, table, paragraphs.

## Purpose

Stock AI builds agentic AI for the food supply chain: WhatsApp voice orders converted into ERP lines, demand forecasting, supervised purchasing and a live voice ordering agent. The deliverable is a 24 hour demo plus a pitch.

## Team

Six named people are involved in this Stockline X-Forum hackathon. Emails come from the Zimbra team mail (Matthias Rondier, uid 12999) or from git commit authors. Phone numbers come from Sigma user profiles unless noted.

| Name | Email | Phone | Sigma profile | Note |
| --- | --- | --- | --- | --- |
| Ivann Kamdem Pouokam (KpihX) | ivann.kamdem-pouokam@polytechnique.edu | 33605957785 (WhatsApp business line) | /app/me | Owner of this repo |
| Gabriel Bermejo | gabriel.bermejo@polytechnique.edu | +33 7 66 63 13 16 | /app/user/gabriel.bermejo | Teammate in the original assignment mail |
| Scott Chendjou Noussi | scott.chendjou-noussi@polytechnique.edu | +237 6 93 11 32 71 | /app/user/scott.chendjou-noussi | Teammate in the original assignment mail |
| Allan Chastel | chastelallan13@gmail.com | unresolved, WhatsApp LID 122514630004890, display name AllanXJC | not found on Sigma | Teammate in the original assignment mail |
| Ezechiel Jovan Kamdem Kouam | ezechiel.kamdem-kouam@polytechnique.edu | +33 7 80 72 88 82 | /app/user/ezechiel.kamdem-kouam | Teammate in the reassigned group |
| Yohann Bikele | yohann.bikele@polytechnique.edu | +33 7 45 74 60 25 | /app/user/yohann.bikele | Teammate in the reassigned group; seeded as CLI-0045 in SCENARIOS.md |

Resolution note (appended 2026-11-23): Allan Chastel's WhatsApp number is 33759026570. It was resolved from the LID 122514630004890 via the reverse lid-mapping file lid-mapping-122514630004890_reverse.json in the local whats-proxy state for account 33745717350. The table row above is kept unchanged as history.

## Stack

Python 3.12 or newer, uv, package stockline_ai, CLI stock-ai.
Core libraries from pyproject.toml: typer, rich, pydantic, pydantic-ai, httpx, python-dotenv.
Optional extras: forecast for statsforecast and darts, voice for pipecat-ai.
External runtime already installed on this machine: whats-proxy for Baileys and the WhatsApp store, whisper-cli and k-whisper for speech to text, k-piper for text to speech, tesseract for OCR.

## Hard rules

- Use uv only. Never pip, never python -m pip, never uv pip for agent work. Add a library with uv add.
- Run scripts with uv run. Use make targets for checks, builds and pushes.
- config.jsonc at the project root is the single source of truth for every default, model id, URL and path. It is structured in four sections: selection, settings, overrides and runtime.
- .env.example lists secrets only and lives at the project root, always. Never put a default, a model id, a URL or a path in it, and never create a second copy inside src/ or any subdirectory. config.py is a typed view over config.jsonc plus the provider registry, with no hardcoded values, and it loads only the root .env.
- The package version has exactly one source: the project.version field in pyproject.toml. Read it with stockline_ai.version.get_version(). Never write a version literal in code, config.jsonc, docs or the CLI. Derive it everywhere.
- No information is duplicated in two places. One source of truth per value, derive or reference it everywhere else: pyproject.toml for metadata, config.jsonc for configuration, providers.py for provider ids and defaults. Prefer a dynamic read over a copy.
- Starting 2026-11-22 the agent must never edit anything under .agents/. No file, no exception, including logs, skills, rules or context. This is a standing rule for every future session in this project.
- Starting 2026-11-22 the agent must never rewrite an existing file. The Edit tool is the only way to modify a file, even for a large change. The Write tool is reserved for a genuinely new file that does not exist yet. This rule has no exception and applies to every future session in this project.
- No hardcoded absolute paths. Use Path.home() or the paths declared in config.py.
- English for all files and comments. Match the language of the chat for replies.
- Public API explicit, internals prefixed with an underscore, no god modules.
- Fail loud at boundaries. Never silently swallow errors.
- Agent output stays in tmp/ until the user validates it. Nothing lands in src/ before validation.
- No raw sudo in agent shells. No em dashes or smart quotes in committed docs.

## Layout

config.jsonc at the root holds the structured configuration. The src/stockline_ai package holds the code. providers.py is the brick registry, config.py is the typed and provider aware view over config.jsonc, cli.py is the thin Typer entry point. Future agents/ modules will hold one agent per concern. Future tools/ modules will hold external adapters.
tests/ holds pytest tests. tmp/ is gitignored scratch. CONTRACT.md defines the operation surface and the error model before implementation grows.
refs/ holds reference material downloaded during the hackathon. It contains the launch deck 2211_-_Amphi_de_lancement_Hackathon_X-Forum.pdf (French, 15 pages) and its English mirror 2311_-_Kick-off_Hackathon_X-Forum_EN.pdf (15 pages), both retrieved from the WhatsApp group Hackathon Stockline - Infos on 2026-11-23. The two files are the same slide deck in two languages.

## Competition context

The launch deck defines three judging criteria: Intelligent (right order, right product, right client, never invents), Rapide (time to first word and latency between turns), Naturel (interruptions, accents, background noise, changes of mind). Four deliverables are required: a GitHub repo launchable from the README, DECISIONS.md explaining the chosen use case and technical choices, slides describing problem, approach and results, and a short demo video as backup if the live demo fails. Submission deadline is Tuesday 2026-11-24 17:30 with no exception. Five finalists pitch on Wednesday 2026-11-25 15:15 at X-Forum. Prizes are 3000, 2000 and 1000 EUR shared inside the winning team, plus Bal de l'X places. The use case is free but must be justified; the deck names five recurring voice problems to address: understanding, conversing, speed, finding the right information, and not making mistakes.

Documentation note: AGENTS.md is version controlled in this repo despite the older line at the end of this file. Corrections are appended, never deleted.

## Workflow

1. Check pyproject.toml before adding a dependency.
2. Prototype in tmp/ with uv run.
3. Promote validated code into src/ with a small edit.
4. Run make check before any commit.
5. Use make push, never a raw git push.

## Docs

README.md is user facing. CHANGELOG.md is newest first. TODO.md is the active backlog. AGENTS.md is this file and is not committed.
