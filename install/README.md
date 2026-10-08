# Install the Jev-Reviewer agent skill

These scripts install the canonical skill from `skill/jev-reviewer` for Codex, Claude Code, or both. They do not install the Jev-Reviewer CLI or browser extension and never request, read, or store credentials.

From the repository root:

```bash
./install/install-agent-skill.sh --all
```

The default is a symlink, which is convenient while developing this checkout. Use `--copy` for an independent installation:

```bash
./install/install-agent-skill.sh --all --copy
```

The individual adapters are equivalent:

```bash
./install/install-codex.sh
./install/install-claude.sh
```

Targets are:

- Codex: `~/.agents/skills/jev-reviewer`
- Claude Code: `~/.claude/skills/jev-reviewer`

An existing target is left untouched. `--force` moves it to a timestamped backup before installing the new skill.

## CLI setup is separate

Live analysis requires `OPENAI_API_KEY` for natural-language explanations. Jev classification works without a key via classifier.dev's free tier; `TYPESAFE_API_KEY` is optional and selects TypeSafe's keyed endpoint instead. Configure them locally by running:

```bash
jev-reviewer setup
```

Keep credentials out of chat, the skill directory, the repository, and browser-extension files. The skill installer deliberately does not handle secrets; CLI setup is the local, masked-input configuration boundary.

Installing the skill makes it discoverable when a coding agent creates or updates a PR. It does not add a guaranteed background GitHub listener. During a PR workflow, the skill instructs the agent to run `jev-reviewer analyze --pr <github-pr-url> --repo <local-repository-path>` after the latest push.
