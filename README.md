# 🪽 Hermes Gateway

A self-hosted chat dashboard for a squad of [Hermes Agent](https://github.com/NousResearch/hermes-agent) profiles.
Every agent is a contact. `#squad` messages all of them at once, and each agent also has a private DM thread.
It works with any number of profiles and finds them on its own.

- **#squad channel**: one message goes to every agent, or only to the ones you `@mention` (`@all` works too).
  Agents answer side by side, and each one also gets the teammate replies it hasn't seen yet.
- **DMs**: a private thread per agent, backed by its own Hermes session.
- **Live runs**: streaming replies, tool calls with their results, subagent notes, a Stop button, and
  **approval cards** (Allow once / for session / Always / Deny) when Hermes gates a command.
- **Auto-discovery**: every profile in `~/.hermes/profiles` with its API server on shows up, using its name,
  role and model from `profile.yaml`, `SOUL.md` and `config.yaml`. New profiles appear without a restart.
- **Shared-model friendly**: agents on the same LLM take turns, and "rate limit" or "slots in use" errors are retried.
- **Status**: online, offline, key rejected or API off per agent, plus unread badges.
  Transcripts persist in `data/`, and runs still in progress are re-attached after a restart.
- **No dependencies**: one Node 18+ process. API keys stay on the server and never reach the browser.

## Quick start

```bash
git clone https://github.com/<you>/hermes-gateway && cd hermes-gateway
npm run demo        # four mock agents, no Hermes needed → http://127.0.0.1:8790
```

With a real squad, on the machine that runs Hermes:

```bash
./enable-api.sh     # turns on the API server for every profile (port + key in each profile's .env)
# restart each profile's gateway:  hermes -p <profile> gateway   (or systemctl restart hermes-gateway-<profile>)
npm start           # → http://127.0.0.1:8790
```

That's all: there's no config file to write. Click **↻ Check agents** after adding profiles.

## How it works

```
browser ⇄ Hermes Gateway (Node, :8790) ⇄ each profile's Hermes API server (127.0.0.1:8643, 8644, …)
             one SSE stream               POST /v1/runs  +  GET /v1/runs/{id}/events
```

Each Hermes profile runs its own gateway with `API_SERVER_ENABLED=true`. The dashboard starts a run per agent,
follows its event stream (deltas, `tool.*`, `approval.request`, `run.completed`…), saves the transcript, and
streams one event bus to the browser. Hermes needs no CORS settings.

## Configuration

Everything is optional. Settings go in `.env` (see [.env.example](.env.example)) or `squad.json`
(copy [squad.example.json](squad.example.json)).

| What | How |
| --- | --- |
| Port / bind address | `DASH_PORT`, `DASH_HOST` (default `127.0.0.1:8790`) |
| Password login | `DASH_PASSWORD` (required if you bind to anything but localhost) |
| Extra hostnames | `DASH_ALLOWED_HOSTS=my-server.local:8790` |
| Who the agents think is talking | `DASH_USER_NAME` |
| Hermes home | `HERMES_HOME` (default `~/.hermes`); `HERMES_DISCOVER=false` to use only `squad.json` |
| Hide profiles | `"exclude": ["scratch"]` in `squad.json` |
| Rename / recolor an agent | an entry in `"agents"` with the same `id` (`name`, `role`, `emoji`, `color`, `model`) |
| Agents on other machines / Docker | an entry with `baseUrl` and its key in `HERMES_KEY_<ID>` (or `keyEnv`) |
| Multiplexed gateway | `baseUrl: "http://host:8642/p/<profile>"` |
| Parallel runs per model | `"dashboard": { "maxParallelPerModel": 1 }` (0 = unlimited) |

Each API key is taken from the first of these that is set: `key` in squad.json, the env var named by `keyEnv`,
`HERMES_KEY_<ID>`, or `API_SERVER_KEY` in the profile's `.env`.

## Running as a service

See [deploy/hermes-gateway.service](deploy/hermes-gateway.service). Run it as the user that owns `~/.hermes`,
so it can read the profiles' keys.

## Security

Anyone who can reach the dashboard can run your agents, and through them terminal commands.

- By default it listens on `127.0.0.1` only.
- To open it on a network, set `DASH_HOST=0.0.0.0` **and** `DASH_PASSWORD`. The password unlocks a 30-day
  HttpOnly cookie, and 5 wrong tries lock that IP out for a minute. Add the hostnames you use to `DASH_ALLOWED_HOSTS`.
- Requests with an unknown `Host` or a foreign `Origin` are refused (DNS-rebinding and CSRF protection).
- The connection is plain HTTP, so use it on a LAN, over Tailscale or an SSH tunnel, or behind a TLS reverse proxy.
  Don't expose it directly to the internet.

## License

MIT
