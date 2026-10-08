# Jev-Reviewer architecture

Jev-Reviewer is a local-first prototype that overlays prioritized, natural-language change cards on GitHub's existing pull-request page. There is no hosted Jev-Reviewer backend and no GitHub App in v1.

```text
Local checkout + git + gh
           |
           v
   Jev-Reviewer CLI ---- optional Graphify context
       |        |
       |        +---- OpenAI: old logic / new logic / what changed
       |        +---- Jev: structured review priority (classifier.dev free tier by
       |                 default, TypeSafe System One when TYPESAFE_API_KEY is set)
       v
~/.cache/jev-reviewer/reviews
           |
           v
127.0.0.1 local server -- pairing token --> unpacked Chrome extension
                                                |
                                                v
                             Native GitHub file rows and headers
                             (only diff tables are replaced)
```

## Components

### CLI

`bin/jev-reviewer.mjs` owns the workflow:

- `setup` collects the OpenAI key (required) and the TypeSafe key (optional) with hidden terminal input and stores them outside the repository. Without a TypeSafe key, Jev classification uses classifier.dev's free, keyless System One-compatible endpoint.
- `analyze --pr <github-pr-url> --repo <path>` resolves the pull request with `gh`, reads the local checkout and Git history, invokes the providers, applies policy, and writes a cached report.
- `serve` exposes cached reports to the same-computer browser extension over loopback only.
- `demo` serves the bundled recorded report replay. It does not call either model provider.
- `token` prints the local pairing token for a human to copy into the extension.

The CLI uses the repository's existing GitHub access through `gh`; it does not ask for a GitHub token itself. Private repositories therefore need an authenticated `gh` session and a local checkout that the user can already read.

### Context and explanation

The Git diff is the base source of truth. By default, the CLI attempts to use Graphify for structural context such as related symbols and dependencies, then falls back to source-only context if it is unavailable. `--no-graphify` disables the attempt; `--graphify` explicitly enables the default behavior. Graphify installation is optional, and live analysis must label the context it actually had rather than imply whole-repository understanding.

OpenAI generates the natural-language fields shown to the reviewer:

- old logic
- new logic
- what changed
- why the change may need human attention

Those summaries are an interface over the code, not an authoritative replacement for it. The extension can restore the untouched GitHub diff tables immediately from its popup.

### Priority classification

Jev produces the structured classification signal. Policy then maps the available evidence to the project's P0/P1/P2 meanings:

- P0: human review required
- P1: human review recommended
- P2: mechanical or well-supported

The bundled default is `config/policy.json`. A repository can override it with `.jev-reviewer.json`, or a caller can pass `--policy <file>`. Policy belongs in configuration, not in the installed agent skill.

Policy is local operator configuration read from the working directory, separately from the committed code under review. Its hash is recorded with each report. Use an explicit policy file if an agent's changes to repository-local configuration should not affect your review rules.

### Cache and browser bridge

Completed reports live below `~/.cache/jev-reviewer/reviews`. The local server reads that cache and binds to loopback, so it is reachable only from the same computer under normal configuration. For a GitHub PR, the extension requests `GET http://127.0.0.1:4731/api/reviews/{owner}/{repo}/{pullRequest}` with the pairing token as a bearer token. It matches the response to the current PR. It does not read arbitrary local files. The popup's **Save** button calls `GET /api/pairing` with the candidate token; the server answers 200 only when the token matches, so a mistyped token is rejected before it is stored.

The pairing token is not a model-provider key, but it should still be treated as local access material. A coding agent should never run `jev-reviewer token` into its transcript; the human follows **Connection** → **Local pairing token** → **Save** in the extension action popup. Chrome stores it locally for subsequent requests.

### Native GitHub integration

The extension does not replace the PR page or add a global dashboard. For each matching changed file, it preserves GitHub's existing file wrapper and header—including the filename, anchor, sticky behavior, and native collapse chevron—and replaces only the diff table inside the file's content area. The replacement shows:

- a P0/P1/P2 badge in the native file header;
- Old logic and New logic columns in place of code rows; and
- an informational change note beneath New logic.

One file can contain multiple analyzed change units, so the extension groups every matching unit into that file's replacement. GitHub's native chevron continues to expand or collapse the whole content area.

Connection, **Refresh report**, **Show logic in place of code**, and expand-by-default settings live in the extension popup. The content script contains no Analyze action; refresh only reloads a report already produced by the CLI or agent.

The extension fails open to source code. When the feature is off, the local server is unavailable, no report matches, or freshness is stale or unverified, it leaves every native diff table in place. Unavailable or unverifiable reports add a warning badge to the extension icon while the popup provides the detailed status; it does not inject an on-page warning banner.

## Data and trust boundaries

Live analysis is not fully offline. Relevant private source, diff, and context are sent to the configured Jev provider (classifier.dev by default, TypeSafe when `TYPESAFE_API_KEY` is set) and OpenAI APIs. Teams must decide whether those providers and their configured data controls are acceptable before analyzing private code.

The credential file is stored outside the repository with owner-only filesystem permissions, but it is not encrypted at rest. Environment variables can also satisfy provider configuration. The browser extension receives cached review results and a local pairing token; it must never receive `TYPESAFE_API_KEY` or `OPENAI_API_KEY`.

The recorded demo is different: it replays a bundled, precomputed report and makes no live provider request. Its initial priorities are recorded results from TypeSafe Jev; its explanations are prepared demonstration copy because funded OpenAI verification was unavailable. `demo/README.md` documents the exact provenance. The UI and demo narration must label replay mode clearly.

## Automatic agent use

The portable skill tells a coding agent to run analysis after it creates or updates a PR. This is best-effort behavior while that agent is active. The skill is not a daemon, webhook, Git hook, or guaranteed listener for future PR updates.

## Provider contracts

- [TypeSafe quick start](https://docs.typesafe.ai/introduction/quickstart) and [Choice primitive](https://docs.typesafe.ai/primitives/choice): direct System One endpoint, typed choices and distributions.
- [classifier.dev developers](https://classifier.dev/developers): free, keyless System One wire-compatible endpoint (`POST /v1/systemone`) used when no `TYPESAFE_API_KEY` is configured.
- [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create) and [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs): schema-constrained prose, with `store: false` in this client.
- [Graphify](https://github.com/Graphify-Labs/graphify): local code-only structural extraction. Static neighbors do not prove runtime impact.
