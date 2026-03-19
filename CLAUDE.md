# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AWS SAM monorepo automating ESC (Efrei Sport Climbing) operations: Discord bot interactions, HelloAsso payment webhooks, ticket management, Algolia search indexing, and AI-powered session recommendations via DM.

## Commands

**SAM (from repo root):**
```bash
sam build                                                                          # Build all functions + layer
sam local start-api                                                                # Local API Gateway on :3000
sam local invoke <FunctionName> --event events/<event>.json                        # Invoke with sample event
sam logs -n <FunctionName> --stack-name efrei-sport-climbing-aws-app --tail        # Tail deployed logs
sam build && sam deploy                                                            # Deploy (uses samconfig.toml profiles)
```

**TypeScript functions (run inside function directory):**
```bash
npm test          # tsc compile + Jest (unit tests in tests/unit/*.test.ts)
npm run lint      # ESLint + auto-fix
npm run compile   # tsc only
```

**Shared layer:**
```bash
cd layers/commons && npm run build    # Compiles TypeScript → commons/ directory
```

**Python utilities (from repo root):**
```bash
poetry env use "$(pyenv which python)" && poetry install --no-root   # First-time setup
poetry run pytest                                                      # Run all tests with coverage
poetry run pylint utils tests                                          # Lint
poetry run ruff check utils tests                                      # Format check
poetry run mypy utils                                                  # Type check
```

**discord_dm_worker (long-running service):**
```bash
cd functions/discord_dm_worker
npm run dev      # Local development with tsx + .env.local
npm start        # Run built dist/app.js
npm test         # Jest tests
```

## Architecture

```
Discord / HelloAsso webhooks
        ↓
   API Gateway REST
   ├── POST /discord-event-handler
   └── POST /helloasso-event-handler
        ↓
   Lambda Functions  ←──  EventBridge Schedules (cron)
        ↓
   layers/commons/  (shared TypeScript utilities)
        ↓
   DynamoDB  │  S3  │  Secrets Manager  │  Algolia
```

**Lambda Functions** (all Node.js 22.x, arm64):

| Function | Trigger | Role |
|---|---|---|
| `discord_event_handler` | API GW | Discord slash commands, buttons, modals; Ed25519 sig verification |
| `helloasso_event_handler` | API GW | Payment webhooks → ticket distribution + DM sending |
| `discord_garbage_collector` | EventBridge daily | Delete expired session Discord messages |
| `tickets_registor` | S3 events | Manage ticket inventory in DynamoDB |
| `algolia_users_indexer` | DynamoDB stream | Index users + stats into Algolia |
| `weekly_session_recommender` | EventBridge Monday | Send personalized session recommendation DMs |
| `session_recommendation_reminder` | EventBridge hourly | Reminder for pending recommendations |
| `discord_dm_worker` | Long-running (Fargate) | Persistent Discord Gateway; AI DM conversations via Algolia Agent Studio |

**Shared Layer (`layers/commons/`):**
All functions import from this layer. Key modules:
- `dynamodb.*.ts` — typed DynamoDB clients for every table
- `discord.types.ts`, `discord.components.ts`, `discord.utils.ts` — Discord API
- `algolia.client.ts`, `algolia.agent.ts`, `algolia.insights.ts` — Algolia search + AI agent
- `session.discord.workflows.ts`, `session.recommendations.ts` — session business logic
- `aws.secret.ts` — Secrets Manager helper

**DynamoDB Tables** (all PAY_PER_REQUEST):
`Efrei-Sport-Climbing-App.{users, sessions, tickets, issues, user-stats, session-recommendations, dm-conversations, user-calendar-feeds, association-announcements}`

Streams enabled on `users` and `user-stats` tables (triggers `algolia_users_indexer`).

**Deployment Profiles** (`samconfig.toml`):
- `default` → test stack, `eu-west-3`
- `account_esc` → production stack, `eu-west-3`

## Code Style

TypeScript with Prettier: 4-space indentation, semicolons, single quotes, trailing commas, `printWidth: 120`. ESLint uses `@typescript-eslint/recommended` + Prettier. `any` is currently permitted where needed.

Naming: snake_case for utility functions, PascalCase for enums/types, folder names match Lambda purpose.

## Commit Conventions

Conventional Commits: `feat:`, `fix:`, `doc:`, `chore:`, optionally scoped e.g. `fix(discord_garbage_collector): ...`.

## Testing

Jest per function, `testMatch: **/tests/unit/*.test.ts`, coverage via v8. Run `npm test` inside the affected function directory. Python tests in `tests/` use pytest with fixtures in `conftest.py`. Sample SAM events are in `events/`.
