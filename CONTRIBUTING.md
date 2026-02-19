# Contributing to Zhuge Loop

## Development Setup

```bash
git clone https://github.com/frankekn/zhuge-loop.git
cd zhuge-loop
npm install
npm test
```

## Running Tests

```bash
npm test          # unit + integration tests
npm run lint      # eslint
```

## Making Changes

1. Fork the repo and create a branch from `main`.
2. Make your changes. Keep diffs small and focused.
3. Add tests for new functionality.
4. Run `npm run lint && npm test` and ensure everything passes.
5. Submit a pull request.

## Code Style

- Zero runtime dependencies. Use only Node.js built-in modules.
- ESM only (`import`/`export`).
- No `as any` casts or dynamic imports.
- Fail fast on errors; do not swallow failures.

## Adding a Preset

1. Add the preset config to `PRESETS` in `src/config.js`.
2. Use `buildSoloPreset(name, verifyCmd)` for simple presets.
3. Add the preset name to the help text in `src/cli.js`.
4. Add a test in `tests/integration.test.js` that verifies the preset passes `normalizeConfig`.

## Adding an Agent Template

1. Create a JSON file in `starters/agents/`.
2. Follow the existing format: `name`, `displayName`, `role`, `tagline`, `promptTemplate`, `tools`.
3. Do not include vendor-specific CLI commands in `promptTemplate`.
4. Update `starters/TEAM_COMPOSITION.md`.

## Issue Templates

Use the appropriate issue template:
- **Bug report**: Something broken or unexpected behavior.
- **Preset request**: Request a new preset for a specific workflow.
- **Adapter request**: Request integration with a specific agent framework.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
