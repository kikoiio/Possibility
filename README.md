# Wispiva

A wisp is a spark of an idea. Wispiva gives ideas a world where they can take shape, live, and evolve.

The project is in research and prototyping. Its [documentation index](docs/README.md) describes the product and current evidence. The world creation prototype is preserved on the `proto/world-genesis` branch; the separate Minecraft societies experiment is on `experiment/minecraft-societies`.

## Local model configuration

Model-backed prototype runs read their configuration from a single `.env` file in the repository root (or the file named by `WISPIVA_ENV_FILE`). Copy [`.env.example`](.env.example) to `.env` and fill in:

- `WISPIVA_LLM_BASE_URL` — your provider's base URL, e.g. `https://api.example.com/v1`
- `WISPIVA_LLM_MODEL` — model ID
- `WISPIVA_LLM_API_KEY` — API key

`.env` is git-ignored and must never be committed. There is no JSON configuration file: the former `config.json` support was removed with the v1 engine. Running the main branch alone makes no model calls — configuration is only needed by the prototype and experiment branches.
