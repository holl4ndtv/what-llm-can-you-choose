# Harness research notes (checked 2026-11-01)

## Dropped candidates
- Roo Code: dropped. Repo is archived (last push 2026-05-15) and its README says the extension was shut down on May 15. README points to ZooCode (fork, Apache-2.0, active) and Cline. Source: https://github.com/RooCodeInc/Roo-Code (README). ZooCode was not researched, so it is not listed.
- Open WebUI "chat page" and LM Studio chat: kept (not dropped).
- Everything else on the candidate list was kept. Nothing was added beyond the list (Atomic Chat, Lemonade, Docker Model Runner, Ramalama, Copilot CLI, Droid, Onyx, n8n appear in vendor docs but were not researched).

## Key findings to know
- llama-server default port: the master README lists 127.0.0.1:9931, but its Docker examples use 8080 and Zed docs use 8080. Treat port as "check the line the server prints". JSON uses 9931 as the doc default and tells the user to pass --port.
- Claude Code: works with a local model only through a compatible endpoint. Ollama's own docs show Claude Code pointed at Ollama (ANTHROPIC_BASE_URL=http://localhost:11434, or ollama launch claude). Kept, with 64k context advice from that page. Anthropic's gateway page was opened but gave no local-model statement.
- OpenClaw + Ollama: OpenClaw docs say do NOT use the /v1 URL (breaks tool calling); use http://host:11434. Other harnesses use /v1.
- OpenCode: README on the dev branch now shows a "v2" installer (curl .../v2/install, npm i -g @opencode/cli); the docs page https://opencode.ai/docs/ still shows curl -fsSL https://opencode.ai/install | bash and npm install -g opencode-ai. JSON uses the docs page command.
- Aider: not archived, but last push to the repo was 2026-05-22 (5 months ago).
- Crush license is FSL-1.1-MIT (source-available, turns MIT later), not plain MIT.
- Open WebUI license is a custom BSD-3 style license with a branding clause.
- Qwen Code: Qwen OAuth free tier ended 2026-04-15. Local use goes through Custom Provider / modelProviders.
- Hermes Agent hard-requires 64,000 tokens of context (Hermes provider docs). OpenCode and Codex "need 64k" is from Ollama's pages, not the tools' own docs.
- Ollama default context is 4k / 32k / 256k by VRAM; coding tools should have at least 64000 (https://docs.ollama.com/context-length).
- No harness page I opened lists MLX as a supported runner. MLX (and any OpenAI-compatible URL) should work with tools that accept a custom base URL (OpenCode, Pi, Crush, Codex model_providers, Zed OpenAI-compatible, Open WebUI OpenAI connection), but that was not tested per tool: not checked.

## Claims NOT verified (labelled "not checked")
- Connect lines for Qwen Code (settings.json entry with baseUrl http://localhost:11434/v1 and envKey OLLAMA_API_KEY): the format comes from the Qwen auth doc example for a cloud provider; the Ollama values are my adaptation. Not checked on a real run.
- Codex: "config.toml" location not stated; docs say oss_provider = "ollama" or "lmstudio" and --oss. Path left generic. Not checked.
- Pi: models.json in ~/.pi/agent is inferred (configuration.md says user config lives in ~/.pi/agent; models.md says models.json). Not checked.
- Nanocoder: only the README CLI example (--provider ollama) was seen; the provider config file format was not opened. Not checked.
- Crush: crushrc path ~/.config/crush/crushrc is from the README (also ./.crushrc). Verified in README, but the command was not run.
- Cline, Kilo Code, Continue: install links are the marketplace links from their READMEs. JetBrains support for Continue and Cline is from their READMEs; Kilo JetBrains not stated, so not listed.
- works_with_runners for Aider (LM Studio), Continue (LM Studio), Kilo (LM Studio), OpenClaw (LM Studio, vLLM), AnythingLLM (LM Studio), Open WebUI (llama.cpp, vLLM): the provider pages exist (HTTP 200) but I read only headings or the first lines, not the full setup. Not checked in detail.
- Jan: "llamacpp" runner means Jan's built-in engine (README acknowledges llama.cpp). Whether Jan can attach to an external Ollama server: not checked.
- Msty: only the "use existing Ollama models" intro was read (shares download folder with Ollama). Whether Msty connects to a running Ollama or OpenAI-compatible URL: not checked. License not stated in docs I opened; pricing page shows a $0 Core plan.
- LM Studio chat: license/pricing terms not found on pages I opened (Terms page is generic). Marked null. Platforms listed (macOS, Windows, Linux) come from the download page title "Mac, Linux, Windows".
- Zed license: GitHub reports NOASSERTION (mixed licenses). Marked null.
- Claude Code license: not stated in docs opened. Marked null.
- Platforms for Goose, OpenCode, Aider, Qwen, Codex, Crush, Pi, Hermes, OpenClaw, OpenHands: taken from install commands/READMEs where shown; Windows for Aider/OpenCode/Qwen/Codex/Nanocoder is inferred from install options, not tested.
- Docker image tag in the OpenHands command (1.8 / 1.26.0-python) will go stale; copied from the doc on 2026-11-01.
- vLLM install: the uv command is for NVIDIA CUDA; Apple Silicon and AMD have other tabs. Not checked beyond the quickstart.
- mlx-lm server host/port: doc says port 8080 on localhost; `--host` flag text not found. OpenAI path /v1/chat/completions confirmed.
- needs_big_memory_window: true means the tool or Ollama's general rule asks for 64k+ context for tool use; min_context_tokens is set only where the tool's own docs (or Ollama's page for that tool) give a number. Kilo's "32k" is from Kilo docs ("at least 32k to get decent results").
