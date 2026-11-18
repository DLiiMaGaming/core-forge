[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/DLiiMaGaming/core-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard)
[![reward](https://make.fun/badge/github-core-clone-01/DLiiMaGaming/core-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01)

# Core Forge

A standalone, GitHub-compatible git forge in a single Node process — standard
library only, no `git` binary, no network, no dependencies. It serves the
whole surface from its own in-memory store:

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2
  (ls-refs, fetch with shallow/deepen, pack generation) and receive-pack v0
  (report-status, side-band-64k, delete-refs, fast-forward enforcement with
  a per-ref ok/ng report).
- **REST v3** under `/api/v3` — repositories, branches, contents, labels,
  issues, comments and pull requests, including squash merge with conflict
  detection.
- **GraphQL v4** at `/api/graphql` — the query/mutation documents `gh` and
  `github-mcp-server` send, plus the `__type` introspection surface for
  Issue, PullRequest, Repository and SearchType.
- **MCP** at `/mcp` — JSON-RPC 2.0 over streamable HTTP, with `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request` and
  `merge_pull_request` acting on the same store as REST, so objects created
  over MCP read back over `/api/v3` unchanged.

Entry for the make.fun bounty [github-core-clone-01](https://make.fun/bounty/github-core-clone-01).

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22, which strips TypeScript
types on its own. The program binds an ephemeral port, POSTs `{"port": N}`
to `$MAKEFUN_ENV_URL/register`, long-polls `$MAKEFUN_ENV_URL/done` while the
suite drives it, and exits 0 when the suite is done. Every API call carries
`Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; a request without it is refused
401.

## Determinism

The store's clock is seeded from `MAKEFUN_TRIAL_NOW` and advanced by a
counter, ids and global ids derive from creation order, and the state export
sorts every collection — two runs of the same trial leave byte-identical
exports.

## Layout

- `main.ts` — the harness lifecycle (bind, register, wait for done, exit).
- `app.ts` — the HTTP surface: routing table, REST v3, git transport,
  serializers, pull merge/diff.
- `gitcore.ts` — the git object model: trees, commits, merge bases,
  three-way file merge, packfile read/write.
- `store.ts` — the in-memory forge state, deterministic clock, and export.
- `graphql.ts` — the GraphQL v4 tokenizer, parser and executor.
- `mcp.ts` — the MCP endpoint and its six tools.

MIT licensed.
