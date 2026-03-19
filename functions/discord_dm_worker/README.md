# Discord DM Worker

This service runs a persistent Discord Gateway client to answer user DMs with your Algolia Agent Studio agent.

The intended setup is:

- run the worker locally on your machine for now
- use AWS Secrets Manager for credentials
- use DynamoDB for conversation state
- move the same worker to Fargate later without changing application code

## Responsibilities

- Listen to Discord direct messages through the Gateway
- Mirror configured Discord announcement channels into DynamoDB
- Load recent conversation history from DynamoDB by default
- Add verified user context when the sender already exists in `Efrei-Sport-Climbing-App.users`
- Inject active association announcements from DynamoDB before each prompt
- Call the Algolia Agent Studio `/completions` endpoint
- Persist the updated conversation state
- Reply in the DM channel

## Why It Is Separate

The existing `discord_event_handler` Lambda only handles Discord Interactions (slash commands, buttons, modals). Arbitrary DMs require a persistent Gateway connection, so this worker is intentionally separate from the Lambda path.

## Runtime Modes

The worker supports two conversation stores:

- `dynamodb`: recommended mode for local execution and later Fargate deployment
- `file`: fallback mode only if you explicitly want no AWS dependency for conversation state

Mode selection:

- if `DM_CONVERSATION_STORE=dynamodb`, the worker uses DynamoDB
- if `DM_CONVERSATION_STORE=file`, the worker stores state in a local file
- if unset, it uses DynamoDB only when `DM_CONVERSATIONS_TABLE_NAME` is set, otherwise it defaults to `file`

## Environment Variables

- `ALGOLIA_AGENT_URL`
- `DM_CONVERSATION_STORE` (optional, `file` or `dynamodb`)
- `DM_CONVERSATION_FILE_PATH` (optional, default `./.data/discord-dm-conversations.json`)
- `DM_CONVERSATIONS_TABLE_NAME` (required only for `dynamodb`)
- `DM_CONVERSATION_HISTORY_LIMIT` (optional, default `20`)
- `DM_CONVERSATION_TTL_DAYS` (optional, default `30`)
- `DM_ANNOUNCEMENT_LOOKBACK_DAYS` (optional, minimum `30`, default `30`)
- `DM_ANNOUNCEMENT_LOOKAHEAD_DAYS` (optional, default `7`)
- `DM_ANNOUNCEMENT_RETENTION_DAYS` (optional, minimum `30`, default `30`)
- `DISCORD_ANNOUNCEMENTS_CHANNEL_IDS` (optional, comma-separated guild channel ids to mirror)
- `DISCORD_ANNOUNCEMENT_ACTIVE_DAYS` (optional, default `7`)
- `ANNOUNCEMENT_COMPACTION_OLLAMA_MODEL` (optional, local Ollama model used once per new/edited announcement)
- `ANNOUNCEMENT_COMPACTION_OLLAMA_URL` (optional, default `http://127.0.0.1:11434`)
- `DM_DISABLE_REGISTERED_USER_LOOKUP` (optional, set to `true` to avoid DynamoDB user lookups)

Credentials can come from either environment variables or AWS Secrets Manager, but the recommended mode is Secrets Manager.

Local env-first mode:

- `DISCORD_BOT_TOKEN`
- `ALGOLIA_APP_ID`
- `ALGOLIA_API_KEY`

AWS-backed mode:

- `DISCORD_BOT_TOKEN_SECRET_PATH` (optional, defaults to `Efrei-Sport-Climbing-App/secrets/discord_bot_token`)
- `ALGOLIA_SECRET_PATH`

## Required Secrets

- `Efrei-Sport-Climbing-App/secrets/discord_bot_token`
- `Efrei-Sport-Climbing-App/secrets/algolia`

Algolia secrets should contain:

- `ALGOLIA_APP_ID`
- `ALGOLIA_SEARCH_API_KEY` or `ALGOLIA_ADMIN_API_KEY`
- `ALGOLIA_KEY_ID` (optional, required for Agent Studio per-user memory)
- `ALGOLIA_SECRET_KEY` (optional, required for Agent Studio per-user memory)

## Discord Configuration

- Enable the bot account for DMs
- Enable the `Direct Messages` Gateway intent
- If `DISCORD_ANNOUNCEMENTS_CHANNEL_IDS` is set, also enable:
  - `Server Members Intent` is not required
  - `Message Content Intent`
  - guild message access for the configured channels
- `Message Content` is not required for DMs if Discord keeps the current DM exception, but the bot should still be tested in your target guild/app configuration

## Announcement Sync

If `DISCORD_ANNOUNCEMENTS_CHANNEL_IDS` is configured, the worker also listens to those guild channels and mirrors each message to DynamoDB:

- `messageCreate`: upsert the announcement
- `messageUpdate`: refresh the stored announcement
- `messageDelete`: remove the announcement from DynamoDB

Prompt compaction is progressive:

- upcoming/ongoing announcements: full detail
- recently finished announcements: shorter summaries
- older announcements up to 30 days: compressed archive digest

Each compacted announcement can expose a stable reference based on the original Discord `messageId`, so the agent can later call `get_announce_detail` to load the full raw announcement only when needed.

If `ANNOUNCEMENT_COMPACTION_OLLAMA_MODEL` is configured, each new or edited announcement is compacted once through the local Ollama server and the generated summaries are stored in DynamoDB. If Ollama is unavailable, the worker falls back to deterministic summaries.

## Announcement Backfill

A quick backfill script is available:

```bash
cd functions/discord_dm_worker
AWS_PROFILE=default \
AWS_REGION=eu-west-3 \
ALGOLIA_SECRET_PATH='Efrei-Sport-Climbing-App/secrets/algolia' \
DISCORD_BOT_TOKEN_SECRET_PATH='Efrei-Sport-Climbing-App/secrets/discord_bot_token' \
DISCORD_ANNOUNCEMENT_BACKFILL_CHANNEL_ID='...' \
ANNOUNCEMENT_COMPACTION_OLLAMA_MODEL='qwen3:8b' \
npm run backfill:announcements
```

The script posts the bundled historical announcements to Discord and immediately upserts the corresponding compacted records in DynamoDB while preserving the original publication date in the stored announcement.

## Recommended Local Run

Run the worker locally while using AWS for secrets and conversation persistence:

```bash
cd functions/discord_dm_worker
npm install
npm run build
AWS_PROFILE=default \
AWS_REGION=eu-west-3 \
ALGOLIA_AGENT_URL='https://3qbu9og6w6.algolia.net/agent-studio/1/agents/471d5517-93b1-4c2f-b3a4-aa723a37bd5a/completions?compatibilityMode=ai-sdk-5' \
ALGOLIA_SECRET_PATH='Efrei-Sport-Climbing-App/secrets/algolia' \
DISCORD_BOT_TOKEN_SECRET_PATH='Efrei-Sport-Climbing-App/secrets/discord_bot_token' \
DM_CONVERSATION_STORE=dynamodb \
DM_CONVERSATIONS_TABLE_NAME='Efrei-Sport-Climbing-App.dm-conversations' \
npm run start
```

This gives you the same external dependencies you would use on Fargate later, without paying for a permanently running ECS task.

## Fallback Local Run

If you explicitly want to avoid AWS conversation storage, use the file-backed fallback:

```bash
cd functions/discord_dm_worker
npm install
npm run build
DISCORD_BOT_TOKEN=... \
ALGOLIA_APP_ID=... \
ALGOLIA_API_KEY=... \
ALGOLIA_AGENT_URL=... \
DM_CONVERSATION_STORE=file \
DM_DISABLE_REGISTERED_USER_LOOKUP=true \
npm run start
```

## Container Run

Build from the repository root:

```bash
docker build -f functions/discord_dm_worker/Dockerfile -t esc-discord-dm-worker .
```

## Deployment Notes

- This worker is designed for a long-lived runtime such as ECS Fargate
- The DynamoDB table definition is present in `template.yaml`
- You can run the worker locally today and move it unchanged to Fargate later
- For Fargate later, keep `DM_CONVERSATION_STORE=dynamodb` and provide `DM_CONVERSATIONS_TABLE_NAME`
- IAM for the runtime must allow:
  - `secretsmanager:GetSecretValue`
  - `dynamodb:GetItem`
  - `dynamodb:PutItem`
  - `dynamodb:Query` / `dynamodb:Scan` if you extend the worker further
