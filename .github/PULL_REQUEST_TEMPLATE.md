# Pull Request

## Summary

<!-- One or two sentences describing the change. -->

## Type of change

- [ ] Bug fix (non-breaking change that fixes an issue)
- [ ] New feature (non-breaking change that adds functionality)
- [ ] Breaking change (fix or feature that changes Action inputs/behavior)
- [ ] Refactor / chore (no functional change)
- [ ] Documentation

## Modules touched

- [ ] `src/bot.ts` (review logic, filters, inline comments)
- [ ] `src/chat.ts` (LLM client: OpenAI / Azure / GitHub Models)
- [ ] `src/github-action.cjs` / `src/fetch-polyfill.cjs` / `src/log.ts` (Action runtime)
- [ ] `action/index.cjs` (rebuilt bundle, must be committed)
- [ ] `action.yml` (Action definition)
- [ ] `.github` / CI (workflows, this template)
- [ ] Docs (`README.md`, `.env.example`)

## Changes

<!-- Bullet list of the most important changes. -->

-

## Action inputs / compatibility

- [ ] No input change
- [ ] New env input(s) added (list them):
- [ ] Changed default / removed input (breaking, list them):
- [ ] Docs updated (`README.md` + `.env.example`)

## How to test

1. `npm install`
2. `npm test` (jest: `test/chat.test.ts`, `test/index.test.ts`)
3. `npm run build` and confirm `action/index.cjs` regenerated with no stale `.d.ts` / `src/` / `test/` inside `action/`
4. Point a test workflow at your branch and open a PR to see the review comment:
   ```yml
   - uses: <owner>/ChatGPT-CodeReview@<branch>
     env:
       GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
       OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
       MODEL: gpt-4o-mini
   ```

## Quality gates

- [ ] `npm test` passes locally (52 tests)
- [ ] `npm run build` passes and `action/index.cjs` is committed
- [ ] `package-lock.json` updated, no `yarn.lock`
- [ ] New tests cover the change
- [ ] `ocr review` shows no new findings (or findings justified)

## Risks & rollback

<!-- Describe any risk and how to revert (e.g. revert commit, re-release tag). -->

## Checklist

- [ ] Code follows existing style (`bot.ts` / `chat.ts` patterns)
- [ ] Hard-to-understand areas commented
- [ ] Relevant documentation updated
- [ ] No new warnings in test/build output
- [ ] Tests added proving fix/feature works
