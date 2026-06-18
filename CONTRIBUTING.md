# Contributing

## Development

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm run typecheck
npm run build
```

## Pull Requests

- Keep changes focused and small
- Update `README.md` when behavior, setup, scripts, or config changes
- Do not commit local runtime data, build output, logs, or hook backups
- Include verification commands in the PR description

## Project Layout

- `apps/server`: HTTP API, WebSocket hub, SQLite persistence, agent discovery
- `apps/web`: React dashboard
- `packages/shared`: shared TypeScript types
- `scripts`: hook installation, hook forwarding, restart helper
