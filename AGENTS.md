# Repository Guidelines

## Project Structure & Module Organization
This repository is an AWS SAM monorepo for ESC automation. Lambda handlers live in `functions/`, one package per function: `discord_event_handler`, `helloasso_event_handler`, `discord_garbage_collector`, `tickets_registor`, and `calendar_generator`. Each function keeps its entrypoint in `app.ts`, business logic in `src/`, and local package config in `package.json`, `tsconfig.json`, `jest.config.ts`, `.eslintrc.js`, and `.prettierrc.js`. Shared AWS, Discord, DynamoDB, and HelloAsso helpers live in `layers/commons/`. Use `events/` for local SAM payloads, `utils/` for development scripts, and `template.yaml` for infrastructure changes.

## Build, Test, and Development Commands
Run these commands from the repository root unless noted otherwise:

- `sam build`: build all Lambda functions and the shared layer.
- `sam local start-api`: start the local API Gateway emulator.
- `sam local invoke DiscordEventHandlerFunction --event events/event_ping.json`: invoke a function with a sample event.
- `sam logs -n DiscordEventHandlerFunction --stack-name efrei-sport-climbing-aws-app --tail`: tail deployed Lambda logs.
- `cd functions/discord_event_handler && npm run lint`: lint and auto-fix TypeScript in one function package.
- `cd functions/discord_event_handler && npm test`: compile with `tsc` and run Jest.
- `cd layers/commons && npm run build`: compile the shared layer.

## Coding Style & Naming Conventions
TypeScript is the default language. Prettier enforces 4-space indentation, semicolons, single quotes, trailing commas, and a `printWidth` of 120. ESLint uses `@typescript-eslint/recommended` with Prettier integration; `any` is currently allowed where needed. Follow the existing naming style: snake_case for many utility functions, PascalCase for enums/types, and descriptive folder names matching the Lambda purpose.

## Testing Guidelines
Jest is configured per function with coverage enabled and `testMatch` set to `**/tests/unit/*.test.ts`. Add new unit tests under each function package, for example `functions/helloasso_event_handler/tests/unit/order.test.ts`. Run `npm test` inside the affected function before opening a PR. There is no repo-wide coverage gate today, but new logic should ship with focused unit coverage.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit prefixes such as `feat:`, `fix:`, and `doc:`, sometimes scoped like `fix(discord_garbage_collector): ...`. Keep subjects short and imperative. PRs should describe the affected Lambda or SAM resource, summarize validation steps run locally, link the related issue, and include screenshots or log excerpts when behavior changes are visible in Discord or operational tooling.

## Security & Configuration Tips
Do not commit secrets or generated credentials. Store local secret files outside git, and prefer AWS Secrets Manager paths already used by the handlers. When changing `template.yaml`, verify IAM permissions, event sources, and environment variables together.
