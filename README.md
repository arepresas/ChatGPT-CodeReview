# ChatGPT CodeReview

A GitHub Action that reviews pull requests with an LLM and leaves the feedback
as inline review comments on the lines it refers to.

## Usage

1. Add `OPENAI_API_KEY` to your repository's Actions secrets.
2. Create `.github/workflows/cr.yml`:

```yml
name: Code Review

permissions:
  contents: read
  pull-requests: write
  actions: read # only needed to read OPENAI_API_KEY from repo Variables

on:
  pull_request:
    types: [opened, reopened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: OWNER/REPO@REF
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          MODEL: gpt-4o-mini
```

Replace `OWNER/REPO@REF` with the repository and ref that provides the action.
Pin a tag or a commit SHA rather than a branch, so that upstream changes cannot
break your workflow unexpectedly.

### Secrets and variables

It is usually worth keeping the credential and the tunables apart, so that
switching model or endpoint does not mean touching the workflow file or
exposing a secret.

Set the credential as a **secret** — Settings → Secrets and variables →
Actions → **Secrets**:

| Name | Value |
| --- | --- |
| `OPENAI_API_KEY` | Your provider key. |

Set the tunables as **variables** — same screen, **Variables** tab:

| Name | Value | Example |
| --- | --- | --- |
| `OPENAI_API_ENDPOINT` | Base URL. Omit for the public OpenAI endpoint. | `https://opencode.ai/zen/go/v1` |
| `MODEL` | Model id. Omit for `gpt-4o-mini`. | `space-bunny-free` |
| `OPENCODE_SESSION` | Stable session id, for gateways that route on it. | `cr-bot` |
| `OPENAI_EXTRA_HEADERS` | JSON object of extra headers. | `{"User-Agent": "cr-bot/1.0"}` |

Then reference them through the two contexts:

```yml
- uses: OWNER/REPO@REF
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    OPENAI_API_ENDPOINT: ${{ vars.OPENAI_API_ENDPOINT }}
    MODEL: ${{ vars.MODEL }}
```

An empty variable is harmless: the action falls back to the default endpoint
and the default model. Any option can also be written as a literal in `env:`
instead, which is what the examples below do.

### Authentication

The action's `github-token` input defaults to `${{ github.token }}`, so the
workflow token is used automatically and you do not need to pass `GITHUB_TOKEN`
yourself. Override it only if the action needs a different identity:

```yml
- uses: OWNER/REPO@REF
  with:
    github-token: ${{ secrets.MY_PAT }}
```

The LLM credential is resolved in this order:

1. `OPENAI_API_KEY` — used for OpenAI, Azure OpenAI, or any OpenAI-compatible
   gateway.
2. The repository variable `OPENAI_API_KEY`, read through the API. Requires the
   `actions: read` permission. If neither resolves, the action comments on the
   pull request explaining what is missing.

> GitHub Models is not supported. It was retired on 30 July 2026, along with
> its inference API, so the `USE_GITHUB_MODELS` variable that earlier versions
> accepted has been removed rather than left to fail silently. Use OpenAI,
> Azure OpenAI, or any OpenAI-compatible gateway.

## Configuration

All options are environment variables on the step. See `.env.example`.

### LLM

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | — | API key. Required unless the repository variable of the same name is set. |
| `MODEL` | `gpt-4o-mini` | Model id. A gateway may namespace it, e.g. `openai/gpt-4o`. |
| `OPENAI_API_ENDPOINT` | `https://api.openai.com/v1` | Base URL for OpenAI-compatible gateways. |
| `AZURE_API_VERSION` | — | Set both this and `AZURE_DEPLOYMENT` to route through Azure OpenAI. |
| `AZURE_DEPLOYMENT` | — | Azure deployment name. |
| `OPENAI_EXTRA_HEADERS` | — | JSON object of extra HTTP headers, e.g. `{"x-opencode-session": "my-session"}`. |
| `OPENCODE_SESSION` | — | Shorthand for the `x-opencode-session` header. |

### Review

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROMPT` | generic bug/risk prompt | Custom review instructions. |
| `LANGUAGE` | — | Answer language, e.g. `English`. |
| `temperature` | `1` | Sampling temperature. Lowercase. |
| `top_p` | `1` | Nucleus sampling. Lowercase. |
| `max_tokens` | model default | Response cap. Lowercase. |
| `REASONING_EFFORT` | — | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. Reasoning models only. |
| `MAX_PATCH_LENGTH` | unlimited | Skip files whose diff exceeds this many characters. |
| `TARGET_LABEL` | — | Only review pull requests carrying this label. |

`temperature` and `top_p` are ignored for reasoning models, which the action
detects from the model id: `o1`, `o1-mini` and their dated variants, or any id
starting with `o3`, `o4` or `gpt-5`. `REASONING_EFFORT` is only sent for those
models.

### File selection

| Variable | Purpose |
| --- | --- |
| `INCLUDE_PATTERNS` | Comma-separated globs or regexes. If set, **only** matching files are reviewed. |
| `IGNORE_PATTERNS` | Comma-separated globs or regexes to skip. |
| `IGNORE` | Legacy, newline-separated exact filenames. |

`INCLUDE_PATTERNS` and `IGNORE_PATTERNS` are matched against the file's API URL
path rather than its repository path, so they are prefixed with `**`
internally: `*.ts` becomes `**/*.ts`, and a leading `/` is treated as
repo-absolute. A pattern that is not valid glob syntax is retried as a regular
expression. `IGNORE`, by contrast, is compared against the repository-relative
filename as an exact match.

`INCLUDE_PATTERNS` takes precedence: when set, `IGNORE_PATTERNS` and `IGNORE`
are not consulted.

## Behaviour

- Findings are posted as a pull request review with inline comments anchored to
  the reviewed lines.
- A finding the model attributes to a hunk that is not in the current diff is
  demoted to the review body instead of being posted inline, so a hallucinated
  line number can never fail the whole review.
- On `synchronize`, only the files changed since the bot's own last review are
  re-reviewed, keeping token use proportional to the new diff. The bot
  recognises its previous reviews by a marker in the review body and skips
  human reviews. A review that did not finish is not used as a base, so files
  left unreviewed by an outage get another chance on the next push.
- Files that are deleted or renamed are skipped, since there is no new content
  to review. A file that changed but carries no diff, such as a binary, or one
  whose diff exceeds `MAX_PATCH_LENGTH`, is reported as a coverage gap.
- When there is nothing to report, the review body is `LGTM 👍`. That claim is
  withheld when any file failed or could not be read, because reporting "no
  issues" for a review that never inspected the code is worse than saying
  nothing.
- A file that fails to review does not abort the run. The remaining files are
  still reviewed, the findings collected so far are posted, the body lists the
  files that could not be reviewed, and the step is then failed so the error
  still surfaces in CI.

## Fork pull requests

On the `pull_request` event GitHub issues the workflow token as **read-only**
for pull requests from forks, so posting the review fails with a 403. This
action does not support fork pull requests under that event.

`pull_request_target` grants the token the workflow's own permissions and does
work, but the action then runs with base-repository privileges while reading
fork-supplied content. It never checks out the PR's code, so the exposure is
limited to the diff text — which is sent to the LLM, meaning untrusted prompt
injection against the reviewer remains possible. Combine it with
`TARGET_LABEL` so only explicitly labelled pull requests are reviewed.

## Development

```sh
npm install
npm test        # jest
npm run build   # bundles src/github-action.cjs into action/index.cjs with ncc
```

`action/index.cjs` is a build artifact and must be committed together with the
sources, since the action runs it directly. After changing anything under
`src/`, run the build and commit the result.

| Path | Purpose |
| --- | --- |
| `src/bot.ts` | Review logic: file selection, filters, inline comment placement. |
| `src/chat.ts` | LLM client for OpenAI, Azure and OpenAI-compatible gateways. |
| `src/github-action.cjs` | Action entry point. |
| `action.yml` | Action metadata, including the automatic `github-token` default. |
| `test/` | Jest suites for the review logic and the LLM client. |

## Credits

Original author: [anc95](https://github.com/anc95), for
[ChatGPT-CodeReview](https://github.com/anc95/ChatGPT-CodeReview), from which
this project descends.

Inspired by [codereview.gpt](https://github.com/sturdy-dev/codereview.gpt).

Built with [Probot](https://probot.github.io) in earlier versions, and with the
GitHub Actions toolkit — `@actions/github` and `@actions/core` — in the current
one.

## License

[ISC](LICENSE)
