# Security

AI修仙传 is intended for local development use.

## Reporting

Open a private security advisory on GitHub if available, or create an issue with minimal reproduction details and no sensitive tokens, logs, or local paths.

## Local Security Notes

- Bind to `127.0.0.1` by default
- Set `AGENT_MONITOR_TOKEN` before exposing the service beyond localhost
- Reinstall hooks after changing `AGENT_MONITOR_URL`, `AGENT_MONITOR_PORT`, or `AGENT_MONITOR_TOKEN`
- Do not commit `.env`, `.agent-monitor`, SQLite files, logs, or hook backup files
- Hook payloads can include prompts, paths, command metadata, and tool input; treat them as local-sensitive data
