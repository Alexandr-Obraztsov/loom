# Loom

A customizable IDE for ACP agents, where everything is a plugin. This repository currently contains the plugin kernel (`@loom/kernel`) and its SDK (`@loom/sdk`).

**Status:** work in progress.

## Development

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm check          # lint + typecheck + dependency-cruiser + knip
pnpm test           # unit tests
pnpm test:coverage  # tests with the 95% coverage gate
```

Design: [docs/superpowers/specs/2026-11-04-loom-design.md](docs/superpowers/specs/2026-11-04-loom-design.md)

## License

MIT
