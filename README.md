# YouTube Operations Manager

A private/internal operations tool for managing one or more YouTube channels through the official YouTube APIs.

The project is an **independent private repository initialized from the TubeMaster codebase** and is being extended into a broader YouTube operations platform for human operators and future AI agents.

Core goals:

- safe YouTube metadata operations;
- localization management;
- bulk import/export;
- approval and audit workflows;
- Web UI, CLI, MCP, and API access;
- future analytics, publishing, and automation.

## Project specification

Before making architectural or product changes, read:

[`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md)

It defines:

- project roadmap;
- YouTube write-safety requirements;
- localization workflow;
- upstream relationship;
- agent rules;
- implementation phases;
- acceptance criteria.

## Start here

1. **Configure Google Cloud OAuth + YouTube API**
   - Follow: [`docs/getting-started.md#1-google-cloud-console-setup`](docs/getting-started.md#1-google-cloud-console-setup)

2. **Create `.env.local`** with required credentials
   - Follow: [`docs/getting-started.md#2-local-environment-envlocal`](docs/getting-started.md#2-local-environment-envlocal)

3. **Install and run locally**
   ```bash
   npm install
   npm run dev
   ```

4. **Authenticate and verify access**
   ```bash
   npm run cli:video-metadata -- auth login
   npm run cli:video-metadata -- auth whoami
   ```

Full walkthrough:

[`docs/getting-started.md`](docs/getting-started.md)

## Interfaces

| Interface | Entry point | Best for |
| --- | --- | --- |
| Web UI | `http://localhost:3000` | Visual channel operations |
| CLI | `npm run cli:video-metadata -- <command>` | Local automation and manual operations |
| MCP Server (stdio) | `npm run mcp:video-metadata` | AI-agent/tool integrations |
| API Route Handlers | `/api/youtube/videos`, `/api/video-metadata/*` | App/backend integrations |

Detailed usage:

[`docs/interfaces.md`](docs/interfaces.md)

## Quick commands

```bash
npm run dev
npm run test
npm run lint
```

### CLI examples

```bash
# Playlist operations
npm run cli:video-metadata -- playlist create --title "Roadtrip 2026" --description "Videos del viaje" --expectedChannelId <CHANNEL_ID> --privacyStatus unlisted
npm run cli:video-metadata -- playlist update --playlistId <PLAYLIST_ID> --expectedChannelId <CHANNEL_ID> --description "Nueva descripción"
npm run cli:video-metadata -- playlist add --playlistId <PLAYLIST_ID> --videoIds <VIDEO_ID_1>,<VIDEO_ID_2>

# Metadata operations
npm run cli:video-metadata -- transcript --videoId <VIDEO_ID>
npm run cli:video-metadata -- preview --videoId <VIDEO_ID> --editorialPrompt "Hacé un título claro"
npm run cli:video-metadata -- apply --videoId <VIDEO_ID> --finalTitle "Nuevo título" --description "Nueva descripción" --expectedChannelId <CHANNEL_ID> --dryRun
```

## Environment variables

### Required

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `NEXTAUTH_SECRET`
- `NEXTAUTH_URL`

See:

[`docs/getting-started.md#2-local-environment-envlocal`](docs/getting-started.md#2-local-environment-envlocal)

### Optional

- `YOUTUBE_TRANSCRIPT_PROVIDER`
- `METADATA_GENERATOR_MODE`
- `METADATA_GENERATOR_RAW_OUTPUT`
- `CLI_OAUTH_CALLBACK_PORT`

Use the existing documentation for current defaults and behavior.

## Safety model

The project must preserve and extend the existing safety guarantees.

Current important guarantees include:

- stable JSON envelopes across CLI/MCP/core;
- typed errors and non-zero exit status on failures;
- strict credential resolution;
- fail-closed write operations requiring expected channel identity;
- safe partial results for bulk playlist operations;
- transcript compatibility contracts.

All future YouTube write operations must follow the safety model in:

[`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md)

At minimum, safety-critical writes should support:

```text
identity check
validation
backup
diff
approval
dry-run
audit
verification
```

Troubleshooting:

[`docs/troubleshooting.md`](docs/troubleshooting.md)

## Documentation

- Project specification: [`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md)
- Getting started: [`docs/getting-started.md`](docs/getting-started.md)
- Interfaces: [`docs/interfaces.md`](docs/interfaces.md)
- Troubleshooting: [`docs/troubleshooting.md`](docs/troubleshooting.md)

Additional project documentation may be added under `docs/` as development progresses.

## Repository relationship to TubeMaster

This repository is **not a GitHub fork** and should not be treated as permanently coupled to the original TubeMaster repository.

Recommended Git remote model:

```text
origin   → independent private repository
upstream → original TubeMaster repository, optional reference only
```

The `upstream` remote is used only for explicit manual operations such as:

```bash
git fetch upstream
git log main..upstream/<branch> --oneline
git diff main..upstream/<branch>
```

No automatic merge, rebase, or synchronization from `upstream` is required.

Useful upstream changes may be reviewed and adopted selectively.

## Attribution and license

This project contains code derived from TubeMaster.

Code inherited from TubeMaster remains subject to the original MIT license and required copyright/license notices.

Keep the repository's `LICENSE` file and any required attribution notices for inherited code.

New project-specific code may evolve independently, but inherited MIT-licensed code must remain compliant with its original license terms.
