---
name: jev-reviewer
description: Analyze and refresh Jev-Reviewer results when creating, updating, pushing to, or inspecting a GitHub pull request. Use after an agent changes a PR and for historical-PR demos; this skill invokes the local CLI and is not a guaranteed background hook.
---

# Jev Reviewer

Use the local `jev-reviewer` CLI to turn a pull request into prioritized, natural-language review cards for the locally installed browser extension.

## Creating or updating a pull request

Complete the requested implementation, run the repository's normal verification, push the intended commits, and create or update the pull request first. Then, as the final post-PR step, run:

```bash
jev-reviewer analyze --pr <github-pr-url> --repo <local-repository-path>
```

Use the full GitHub PR URL returned by the PR workflow and the repository's absolute local path. If the PR identity is unclear, resolve it with the repository's existing GitHub tooling instead of guessing.

This is a best-effort agent workflow, not an event listener. Do not claim the skill will run after the agent exits or when another actor pushes commits.

Do not create, push, or modify a PR solely to make analysis possible unless the user requested that action. If no PR exists or the latest commits are not pushed, state that analysis is deferred and provide the exact command to run later.

## Live analysis

Live analysis requires a locally configured `OPENAI_API_KEY` for natural-language explanations. Jev classification needs no key: it uses classifier.dev's free tier by default, switching to TypeSafe's keyed System One endpoint when `TYPESAFE_API_KEY` is configured. Before analyzing, run this check. It prints where each key comes from and whether each provider accepts it, never a key value, so it is safe in an agent transcript:

```bash
jev-reviewer doctor
```

Your shell may not load variables the user's login shell exports, so a key that is only in the user's environment can be invisible to you. If `doctor` reports a missing or environment-only key, ask the user to run this directly in their terminal; it stores keys it finds only in the environment:

```bash
jev-reviewer setup
```

Never ask the user to paste a key into chat, add it to this skill, commit it, print it, or inspect its value. Skill installation and credential setup are separate.

`analyze` prints how many change units it will send to the providers (default 12, in path order, `--max-units` up to 100). Tell the user when a PR has more units than were analyzed: files with an unanalyzed change keep GitHub's code in the extension. Do not raise `--max-units` without the user's agreement, because it increases provider cost and time.

The CLI attempts local Graphify enrichment by default and falls back to source-only context when Graphify is unavailable. `--no-graphify` disables that attempt; `--graphify` is an optional explicit enable. Do not present Graphify installation as required.

## Recorded demo

To replay the bundled, precomputed demonstration without provider keys, run:

```bash
jev-reviewer demo
```

Describe this accurately as a recorded report replay, not live model analysis. The bundled report contains real recorded Jev classifications and prepared explanation copy; see `demo/README.md` for provenance. Follow the command's output to open the standalone replay or matching PR page.

## Browser bridge

For a previously analyzed PR, start or confirm the local bridge:

```bash
jev-reviewer serve --port 4731
```

The human can run `jev-reviewer token | pbcopy` to copy the local browser-extension pairing token. Never run that command in an agent transcript: the token is for the human to paste into the extension's **Connection** section, whose **Save** button confirms the pairing. The extension works on GitHub's classic Files changed page (`/pull/<n>/files`); on the new `/changes` page it shows a notice instead of the logic view.

## Results and policy

- Treat the cards as supplemental review guidance, not proof that a PR is safe.
- Report analysis failures and stale results clearly. Never silently reuse results from a different commit.
- Preserve existing tests, approval rules, and human-review requirements.
- Use P0 as the highest priority. Read [references/priority-policy.md](references/priority-policy.md) only when interpreting or changing priority policy.
- Configure priorities in `config/policy.json`, a repository `.jev-reviewer.json`, or a file passed with `--policy`; do not edit this skill to change review policy.
- Do not start a persistent server unless the user is preparing to use the browser extension or explicitly asks for it.

If `jev-reviewer` is unavailable, report the missing prerequisite instead of inventing an installation command.
