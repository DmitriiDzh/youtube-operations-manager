# Manual Checklist — cli-auth-bootstrap

## 1) Loopback browser login

- [ ] Run `npm run cli:video-metadata -- auth login`
- [ ] Browser consent opens and callback returns to localhost without manual code copy
- [ ] CLI prints `{ ok: true, data: { method: "loopback", ... } }`
- [ ] `npm run cli:video-metadata -- auth whoami` returns active user summary

## 2) Device flow fallback

- [ ] Run `npm run cli:video-metadata -- auth login --device`
- [ ] CLI shows verification URL + user code (or actionable structured failure if OAuth client type is unsupported)
- [ ] After authorization, CLI sets active context and `auth whoami` succeeds

## 3) Active user fallback for metadata commands

- [ ] With active user set, run metadata command without `--userId` (e.g. `list`)
- [ ] Command succeeds and uses active context
- [ ] With explicit `--userId`, command uses explicit user over active context

## 4) Revoked active user

- [ ] Run `npm run cli:video-metadata -- auth revoke` while active user is selected
- [ ] Remote revoke succeeds before local cleanup
- [ ] User tokens are cleared and active context is removed
- [ ] Subsequent metadata command without explicit credential fails with `AUTH_USER_NOT_FOUND`

## 5) Missing refresh token on expired credentials

- [ ] Create/force a user with expired access token and no refresh token
- [ ] Trigger any operation requiring credential resolution
- [ ] Confirm structured error `AUTH_REFRESH_TOKEN_MISSING`

## 6) MCP override behavior

- [ ] Start MCP server: `npm run mcp:video-metadata`
- [ ] Call tool without `credentialRef` and verify active user fallback
- [ ] Call tool with explicit `credentialRef` and verify explicit precedence
- [ ] Validate structured auth errors (`AUTH_USER_NOT_FOUND`, `AUTH_SCOPE_INSUFFICIENT`)
