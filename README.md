# @tetherto/mdk-app-agent

## Overview

An MDK app that serves [`@tetherto/mdk-agent`][mdk-agent] behind the Gateway as an auth-gated chat API: sessions, SSE message
streams, and approval round-trips for its write tools. It runs in its own app runtime process, and the Gateway forwards its routes
to it.

> [!TIP]
> The [Gateway agent guide][agent-guide] covers enabling this app and driving a session end to end.

## Run it

Add the app to an MDK project, then start the stack with `mdk run`:

```bash
mdk add app github:tetherto/mdk-app-agent#main
```

`mdk add` writes this entry under `spec.apps` in `mdk.yaml`, `mount: /` included. Fill in `config.agent`:

```yaml
spec:
  apps:
    - name: agent
      package: "@tetherto/mdk-app-agent"
      mount: /
      config:
        agent:
          provider: { kind: qvac, model: qwen3-4b, baseURL: http://127.0.0.1:11500/v1 }
          mcp:
            url: http://127.0.0.1:3947/mcp
            credential:
              file: .mdk/credentials/agents/operator-agent.json
              gatewayUrl: http://127.0.0.1:3847
```

`mdk run mcp` checks every agent against `spec.rbac`, so the agent signs in to it as its own service account. With the stack
running, create the account with `mdk sa add operator-agent`, bind it to a role that grants the routes it may call, and run
`mdk rbac apply`; the [Gateway agent guide][agent-guide] walks through it. An MCP server that checks no token, such as the MVP
site example's on `3101`, needs only `mcp: { url }`.

The Gateway serves an app's routes under `/apps/<name>` unless `mount` is set. Keep `mount: /` for this app:
[`@tetherto/mdk-ui-agent`][ui-agent] calls `/agent/sessions…` at the Gateway root.

## Configuration

The manifest's `setup` block asks for these values, read from `config.agent` at `require('@tetherto/mdk-gateway/plugin')`:

| Key                       | Status   | Type     | Default  | Description                                                             |
| ------------------------- | -------- | -------- | -------- | ----------------------------------------------------------------------- |
| `agent.provider`          | Required | `object` | None     | The model the agent talks to, per the [provider shape](#provider-shape) |
| `agent.mcp`               | Optional | `object` | None     | The MCP tool server the agent calls fleet tools through, per the [MCP shape](#mcp-shape). Omitting this, or its `url`, still loads the app: the agent runs as a grounded chat with no fleet tools, and [why that happens](#troubleshooting) has its own entry. |
| `agent.approvalTimeoutMs` | Optional | `number` | `120000` | How long a paused write waits for a decision. With none, the write does not run. With `@tetherto/mdk-agent` 0.13.1 or later the agent reports the approval as expired; the 0.13.0 agent reports it as rejected |

### Provider shape

`agent.provider` ([`provider.js`][provider-js]):

| Key           | Status   | Type     | Default | Description                                          |
| ------------- | -------- | -------- | ------- | ---------------------------------------------------- |
| `kind`        | Required | `string` | None    | `'qvac'` or `'openai-compatible'`. `'qvac'` in `external` mode wraps any server speaking `/v1/chat/completions`, so it is the right kind for a non-QVAC local endpoint too; `'openai-compatible'` is for a **hosted** one and additionally requires `apiKey`, adding key redaction and rate-limit pacing |
| `model`       | Required | `string` | None    | The model id served or connected to                  |
| `mode`        | Optional | `'external'` or `'managed'` | `'external'` if `baseURL` is set, else `'managed'` | Picks how the agent reaches the model |
| `baseURL`     | Optional | `string` | None    | Required in `external` mode: the URL of an already-running OpenAI-compatible server |
| `apiKey`      | Optional | `string` | `qvac`  | Used only in `external` mode                         |
| `modelConfig` | Optional | `object` | `{ ctx_size: 16384, reasoning_budget: 0 }` | Used only in `managed` mode; overrides `qvac serve`'s own defaults, which are too small to use as-is |

**`external`** connects to an already-running OpenAI-compatible server at `baseURL`, any such server and not only QVAC's own.
**`managed`** has the agent spawn and own the QVAC server itself for `model`, which needs the agent and the GPU on the same OS.

### MCP shape

`agent.mcp`, as [`@tetherto/mdk-agent`][mdk-agent] 0.14.0 reads it. Set `credential` or `token`, not both:

| Key                     | Status   | Type     | Default | Description                                          |
| ----------------------- | -------- | -------- | ------- | ---------------------------------------------------- |
| `url`                   | Required | `string` | None    | The Streamable HTTP MCP endpoint, e.g. `http://127.0.0.1:3947/mcp` for `mdk run mcp` (the Gateway port + 100) |
| `credential.file`       | Optional | `string` | None    | The credential `mdk sa add <name>` wrote, e.g. `.mdk/credentials/agents/operator-agent.json`; relative to the project directory |
| `credential.gatewayUrl` | Optional | `string` | None    | The Gateway the service account signs in at, which must belong to the stack the MCP server runs in. Required with `credential.file` |
| `token`                 | Optional | `string` | None    | A fixed access token instead of `credential`, from `mdk sa token <name>`. It expires after about 10 minutes, so it only suits a quick test |

With `credential`, the agent signs in as the service account, sends its access token on every MCP request, and renews it
before it expires. With neither, it sends no token, and an MCP server that checks agents answers `401`.

[Mount the app][mount-the-app] demonstrates a complete, schema-correct `mdk.yaml` example, running this app standalone against an
MCP tool server run elsewhere.

## Routes

| Route                   | Method + path                                    | Notes                                |
| ----------------------- | ------------------------------------------------ | ------------------------------------ |
| `agent.session.create`  | `POST /agent/sessions`                           |                                      |
| `agent.session.message` | `POST /agent/sessions/:id/messages`              | `text/event-stream`; events carry `turnId`, `seq`, and `approvalId` on `pending_approval` |
| `agent.approval.decide` | `POST /agent/sessions/:id/approvals/:approvalId` | Fail-safe timeout: the write does not run (reported as expired from `@tetherto/mdk-agent` 0.13.1) |
| `agent.session.delete`  | `DELETE /agent/sessions/:id`                     |                                      |

Sessions bind to the caller's identity: the `kind:sub` of the token the Gateway verified against `spec.rbac` (so a user and a
service account with the same name never share sessions), else an older `authVerifier`'s `req._info.user`. A Gateway running
with neither serves a single `local` operator, so every caller shares one identity.
A session id and its approvals are only reachable by the identity that created them; a foreign id reads as missing rather than
forbidden, so existence never leaks.

[`tests/plugin.test.js`](tests/plugin.test.js) is the executable spec for this contract: envelope stamping, the approval pause and
resume order, the timeout path (write blocked, reported as expired), and per-identity isolation across sessions and approvals.

## Errors

| Code                              | Fires when                                 | Fix                     |
| --------------------------------- | ------------------------------------------ | ----------------------- |
| `ERR_AGENT_UNAVAILABLE`           | `config.agent` is missing entirely, or the agent failed to construct: a bad provider config, the MCP server was unreachable at startup, or it refused the agent's sign-in (`503`) | Add the `agent` block to this app's config, or fix the provider or MCP config the underlying error names. [Troubleshooting](#troubleshooting) covers each MCP sign-in message |
| `ERR_AGENT_SESSION_NOT_FOUND`     | The session id doesn't exist, or belongs to a different caller than the one making the request (`404`) | Create a new session, or confirm you're using the identity that created this one |
| `ERR_AGENT_TURN_ACTIVE`           | A message or delete is sent to a session while its previous turn is still streaming or paused on an approval (`409`) | Wait for the current turn to finish, or decide its pending approval, before sending another |
| `ERR_AGENT_APPROVAL_NOT_FOUND`    | The approval id doesn't exist for that session: already decided, timed out, or never existed (`404`) | Check whether it already resolved; approvals also expire after `agent.approvalTimeoutMs`, and the write does not run |
| `ERR_AGENT_MESSAGE_TEXT_REQUIRED` | `agent.session.message`'s `text` field is missing, not a string, or empty after trimming (`400`) | Send a non-empty `text` string |

## Troubleshooting

| Symptom                        | Cause                             | Fix                          |
| ------------------------------ | --------------------------------- | ---------------------------- |
| Sessions and messages work, but the agent never calls a tool | `agent.mcp` (or its `url`) is omitted | Set `agent.mcp.url` to a reachable MCP server. [`createAgent`][mdk-agent] only connects to MCP when `config.mcp.url` is set, and without it the agent runs as a grounded chat with no fleet tools. |
| Same symptom, but `agent.mcp.url` is set correctly | The MCP tool server was still starting, or unreachable, at the exact moment the session was created; the agent connects to MCP once, at session create, and never retries later in that session's life | Confirm the tool server is up, then create a new session; restarting or messaging the existing session does not retry the connection |
| Creating a session answers `503 ERR_AGENT_UNAVAILABLE: the MCP server at <url> answered 401: set mcp.credential to the agent's service account` | The MCP server checks agents against `spec.rbac`, and the agent sent no token | Create the account with `mdk sa add operator-agent` and set `agent.mcp.credential`, per the [MCP shape](#mcp-shape), then restart `mdk run` |
| Creating a session answers `503 ERR_AGENT_UNAVAILABLE: ERR_IDENTITY_ASSERTION_INVALID: unknown service account` | The Kernel behind `credential.gatewayUrl` has no such account | Run `mdk sa add <name>` against this stack while it runs, and check `gatewayUrl` is this stack's Gateway |
| Creating a session answers `503 ERR_AGENT_UNAVAILABLE: … answered 401: its token was refused` | Another stack issued the token, or `agent.mcp.token` expired | Point `credential.gatewayUrl` at the Gateway of the stack `mdk run mcp` belongs to, or replace `token` with `credential` |
| Creating a session answers `503 ERR_AGENT_UNAVAILABLE: … mcp.credential.file … unreadable` | The credential file is missing, or the path does not resolve from the directory `mdk run` started in | Run `mdk sa add <name>` from the project directory, and start `mdk run` there |
| `agent.mcp.credential` is set, but the agent never calls a tool | `mdk run mcp` lists only the tools the account's roles allow, and no rule grants it a route | Bind the account to a role in `spec.rbac`, run `mdk rbac apply`, then restart `mdk run`: the agent reads its tool list once, when the first session creates it |
| `npm ci` fails fetching `mdk` | `@tetherto/mdk-agent` is not on npm yet, so the app installs the `tetherto/mdk` GitHub repo as `mdk` (a git dependency) and loads `mdk/backend/core/agent` | Allow npm to fetch from GitHub (npm 12 also needs `allow-git` set) |

## Develop

Node 24 or later. Install, lint and test:

```bash
npm install
npm run lint
npm test
```

> [!NOTE]
> The `@tetherto/mdk-*` dependencies resolve from npm. Until they are published, run the tests against an MDK checkout that has
> run `npm ci`:
>
> ```bash
> MDK=/path/to/mdk
> NODE_ENV=test NODE_PATH=$MDK/node_modules $MDK/node_modules/.bin/brittle tests/*.test.js
> ```

## Directory layout

```text
mdk-app-agent/
├── mdk-app.yaml            # App manifest: id, version, display name, permissions
├── mdk-plugin.json         # Route table, plus the setup questions `mdk onboard` asks
├── controllers/
│   ├── sessions.js         # agent.session.create and agent.session.delete
│   ├── messages.js         # agent.session.message: streams one agent turn over SSE
│   └── approvals.js        # agent.approval.decide
├── lib/
│   ├── agent.js            # One shared agent per app, built from config.agent
│   ├── sessions.js         # In-memory sessions, bound to the caller's identity
│   ├── approvals.js        # Pending approvals with their fail-safe timeout
│   └── sse.js              # SSE framing for the message stream
└── tests/
    └── plugin.test.js      # The route contract, loaded through the Gateway's plugin loader
```

## Next steps

- [Enable the agent through the Gateway][agent-guide]: onboarding, mounting, and driving a session with curl
- [Understand the underlying agent][mdk-agent]: the model, its tools, and the eval battery
- [Render the chat in a UI][ui-agent]: the React transport and components that call this app's routes

[agent-guide]: https://docs.mdk.tether.io/guides/agent/gateway-deployment
[mount-the-app]: https://docs.mdk.tether.io/guides/agent/gateway-deployment#mount-the-app
[mdk-agent]: https://github.com/tetherto/mdk/blob/main/backend/core/agent/README.md
[provider-js]: https://github.com/tetherto/mdk/blob/main/backend/core/agent/src/provider.js
[ui-agent]: https://github.com/tetherto/mdk/blob/main/ui/packages/ui-agent/README.md
