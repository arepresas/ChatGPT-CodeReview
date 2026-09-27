import * as core from '@actions/core';
import * as github from '@actions/github';
import { minimatch } from 'minimatch';

import { Chat } from './chat.js';

const OPENAI_API_KEY = 'OPENAI_API_KEY';
const COMPARE_FILES_LIMIT = 300;
const REVIEW_MARKER = '<!-- chatgpt-code-review -->';
// An incomplete review did not inspect every file, so it cannot be trusted as
// the base for the next incremental pass. Using one would permanently skip the
// files that failed, since nothing would ever ask for them again.
const INCOMPLETE_MARKER = '<!-- chatgpt-code-review incomplete -->';
const MAX_LISTED_FILES = 10;
const SUPPORTED_ACTIONS = new Set(['opened', 'reopened', 'synchronize']);
const MAX_PATCH_COUNT = process.env.MAX_PATCH_LENGTH
  ? +process.env.MAX_PATCH_LENGTH
  : Infinity;

type ChangedFile = {
  filename: string;
  status?: string;
  contents_url: string;
  patch?: string;
};

type Octokit = ReturnType<typeof github.getOctokit>;

type ChangedFilesParams = {
  owner: string;
  repo: string;
  pull_number: number;
  action: string;
  before?: string;
  headSha: string;
};

type PullRequestPayload = {
  number: number;
  state?: string;
  locked?: boolean;
  labels?: Array<{ name?: string }>;
  head: { sha: string };
  html_url?: string;
};

const parseHunkHeader = (hunkHeader?: string) => {
  if (!hunkHeader) {
    return null;
  }

  const match = hunkHeader.trim().match(
    /^@@\s+-\s*(\d+)(?:,(\d+))?\s+\+\s*(\d+)(?:,(\d+))?\s+@@/
  );
  if (!match) {
    return null;
  }

  const [, oldStartValue, oldCountValue, newStartValue, newCountValue] = match;
  const oldStart = Number(oldStartValue);
  const oldCount = oldCountValue === undefined ? 1 : Number(oldCountValue);
  const newStart = Number(newStartValue);
  const newCount = newCountValue === undefined ? 1 : Number(newCountValue);

  return { oldStart, oldCount, newStart, newCount };
};

export const getReviewCommentLocation = (hunkHeader?: string) => {
  const range = parseHunkHeader(hunkHeader);
  if (!range) {
    return null;
  }

  const { oldStart, oldCount, newStart, newCount } = range;

  if (newCount > 0) {
    return {
      line: newStart + newCount - 1,
      side: 'RIGHT' as const,
    };
  }

  if (oldCount > 0) {
    return {
      line: oldStart + oldCount - 1,
      side: 'LEFT' as const,
    };
  }

  return null;
};

export const isHunkHeaderInPatch = (
  hunkHeader: string | undefined,
  patch: string
) => {
  const expectedRange = parseHunkHeader(hunkHeader);
  if (!expectedRange) {
    return false;
  }

  return patch.split('\n').some((line) => {
    if (!line.startsWith('@@')) {
      return false;
    }
    const actualRange = parseHunkHeader(line);
    return (
      actualRange?.oldStart === expectedRange.oldStart &&
      actualRange.oldCount === expectedRange.oldCount &&
      actualRange.newStart === expectedRange.newStart &&
      actualRange.newCount === expectedRange.newCount
    );
  });
};

export const createInlineReviewComment = (
  path: string,
  body: string,
  hunkHeader: string | undefined,
  patch: string
) => {
  const location = getReviewCommentLocation(hunkHeader);
  if (!location || !isHunkHeaderInPatch(hunkHeader, patch)) {
    return null;
  }

  return {
    path,
    body,
    line: location.line,
    side: location.side,
  };
};

/**
 * Renders a value as a markdown code span.
 *
 * Backslash escapes are not processed inside a code span, so escaping a
 * backtick with a backslash does not work: the backtick closes the span early
 * and the backslash shows up literally. Instead use a delimiter one backtick
 * longer than the longest run in the value, and pad when the value itself
 * starts or ends with a backtick.
 */
const codeSpan = (value: string): string => {
  const runs = value.match(/`+/g) || [];
  let longestRun = 0;
  for (const run of runs) {
    if (run.length > longestRun) {
      longestRun = run.length;
    }
  }
  const fence = '`'.repeat(longestRun + 1);
  const pad = value.startsWith('`') || value.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${value}${pad}${fence}`;
};

/**
 * Keeps the review body bounded. A wide outage can fail hundreds of files, and
 * GitHub rejects a body that exceeds its size limit, which would throw away
 * every finding that did succeed.
 */
const listFiles = (files: string[]): string => {
  const shown = files.slice(0, MAX_LISTED_FILES).map(codeSpan).join(', ');
  const rest = files.length - MAX_LISTED_FILES;
  return rest > 0 ? `${shown} (+${rest} more)` : shown;
};

const splitPatterns = (raw: string | undefined): string[] =>
  (raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

const splitLines = (raw: string | undefined): string[] =>
  (raw || '')
    .split('\n')
    .map((value) => value.replace(/\r$/, '').trim())
    .filter(Boolean);

/**
 * Builds the review body.
 *
 * `failedFiles` are files whose review attempt errored, which makes the run
 * incomplete. `skippedFiles` are files that carried no usable diff, such as
 * binaries or oversized patches; retrying them would not help, so they do not
 * invalidate the run, but they are still a gap in coverage.
 *
 * LGTM is only claimed when nothing was reported and nothing was missed.
 * Reporting "no issues" for a review that never inspected the code is worse
 * than reporting nothing. The review marker is always kept so the next push
 * can still find this review as its base.
 */
export const createReviewBody = (
  hasInlineComments: boolean,
  bodyComments: string[],
  failedFiles: string[] = [],
  skippedFiles: string[] = []
) => {
  const sections: string[] = [];

  if (failedFiles.length) {
    sections.push(
      `> **Review incomplete.** Could not review ${failedFiles.length} file(s): ${listFiles(failedFiles)}`
    );
  }

  if (skippedFiles.length) {
    sections.push(
      `> **Coverage gap.** No reviewable diff for ${skippedFiles.length} file(s): ${listFiles(skippedFiles)}`
    );
  }

  const hasFindings = hasInlineComments || bodyComments.length > 0;
  const completeCoverage = !failedFiles.length && !skippedFiles.length;
  if (hasFindings) {
    sections.push('Code review by ChatGPT');
  } else if (completeCoverage) {
    sections.push('LGTM 👍');
  }

  sections.push(...bodyComments);
  sections.push(failedFiles.length ? INCOMPLETE_MARKER : REVIEW_MARKER);

  return sections.join('\n\n');
};

export const getChangedFiles = async (
  octokit: Octokit,
  params: ChangedFilesParams
): Promise<ChangedFile[]> => {
  const { owner, repo, pull_number, action, before, headSha } = params;
  const pullRequestFiles = (await octokit.paginate(
    octokit.rest.pulls.listFiles,
    {
      owner,
      repo,
      pull_number,
      per_page: 100,
    }
  )) as ChangedFile[];

  if (action !== 'synchronize') {
    return pullRequestFiles;
  }

  let comparisonBase: string | undefined;

  try {
    const reviews = (await octokit.paginate(
      octokit.rest.pulls.listReviews,
      {
        owner,
        repo,
        pull_number,
        per_page: 100,
      }
    )) as Array<{
      body?: string | null;
      commit_id?: string | null;
      user?: { type?: string } | null;
    }>;
    const botReview = reviews
      .slice()
      .reverse()
      .find(
        (r) =>
          r.user?.type === 'Bot' &&
          (r.body?.includes(REVIEW_MARKER) ||
            r.body?.includes(INCOMPLETE_MARKER))
      );

    if (botReview) {
      if (!botReview.commit_id) {
        return pullRequestFiles;
      }
      if (botReview.body?.includes(INCOMPLETE_MARKER)) {
        // The previous pass did not finish, so it is not a sound base. Fall
        // back to the synchronize `before` SHA so the files it missed get
        // another chance on this push.
        core.debug(
          `previous review at ${botReview.commit_id} was incomplete; re-reviewing from the push base`
        );
      } else {
        comparisonBase = botReview.commit_id;
      }
    } else {
      const hasLegacyReview = reviews.some(
        (r) =>
          r.user?.type === 'Bot' &&
          r.body &&
          (r.body.startsWith('Code review by ChatGPT') ||
            r.body.startsWith('LGTM'))
      );
      if (hasLegacyReview) {
        return pullRequestFiles;
      }
    }
  } catch (err) {
    core.debug(`failed to detect previous bot review: ${err}`);
    return pullRequestFiles;
  }

  if (!comparisonBase) {
    comparisonBase = before;
  }

  if (!comparisonBase) {
    return pullRequestFiles;
  }

  try {
    const { data } = await octokit.rest.repos.compareCommits({
      owner,
      repo,
      base: comparisonBase,
      head: headSha,
    });

    if (data.status === 'identical') {
      return [];
    }

    if (data.status === 'ahead') {
      if (!data.files) {
        core.debug(
          'commit comparison omitted files; using the full pull request diff'
        );
        return pullRequestFiles;
      }

      const comparisonFiles = data.files;
      if (comparisonFiles.length >= COMPARE_FILES_LIMIT) {
        core.debug(
          'commit comparison reached the GitHub file limit; using the full pull request diff'
        );
        return pullRequestFiles;
      }

      const changedFilenames = new Set(
        comparisonFiles.map((file) => file.filename)
      );
      return pullRequestFiles.filter((file) =>
        changedFilenames.has(file.filename)
      );
    }

    core.debug(
      `commit comparison from ${comparisonBase} is ${data.status}; using the full pull request diff`
    );
  } catch (err) {
    core.debug(`failed to compare commits from ${comparisonBase}: ${err}`);
  }

  return pullRequestFiles;
};

export const loadChat = async (
  octokit: Octokit,
  owner: string,
  repo: string,
  pull_number: number
): Promise<Chat | null> => {
  if (process.env.OPENAI_API_KEY) {
    return new Chat(process.env.OPENAI_API_KEY);
  }

  try {
    const { data } = await octokit.rest.actions.getRepoVariable({
      owner,
      repo,
      name: OPENAI_API_KEY,
    });

    if (!data?.value) {
      return null;
    }

    return new Chat(data.value);
  } catch (err) {
    const status = (err as { status?: number })?.status;
    if (status !== 404) {
      // A 403, a rate limit or a network blip says nothing about whether the
      // variable is configured, so do not tell the user it is missing.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `could not read the ${OPENAI_API_KEY} repository variable (HTTP ${status ?? 'no status'}): ${detail}`
      );
    }

    try {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pull_number,
        body: `ChatGPT CodeReview is running, but no LLM credential was found. Set OPENAI_API_KEY in this repository's Actions secrets or Variables. See the action README for details.`,
      });
    } catch (commentErr) {
      core.debug(`failed to post missing-key comment: ${commentErr}`);
    }
    return null;
  }
};

export const run = async (): Promise<string> => {
  try {
    if (
      github.context.eventName !== 'pull_request' &&
      github.context.eventName !== 'pull_request_target'
    ) {
      core.warning(`unsupported event: ${github.context.eventName}`);
      return 'skipped event';
    }

    const pull_request = github.context.payload
      .pull_request as PullRequestPayload | undefined;

    if (!pull_request) {
      core.warning('no pull_request in event payload');
      return 'no pull request';
    }

    const { owner, repo } = github.context.repo;
    const rawAction = github.context.payload.action;
    const action = typeof rawAction === 'string' ? rawAction : '';

    // Checked before anything else, so an unconfigured action never posts a
    // missing-credential comment, and so `labeled`, `edited` and friends do not
    // each trigger a full review of the whole pull request.
    if (!SUPPORTED_ACTIONS.has(action)) {
      core.warning(`unsupported pull_request action: ${action || '(none)'}`);
      return 'skipped action';
    }

    const rawBefore = github.context.payload.before;
    const before = typeof rawBefore === 'string' ? rawBefore : undefined;

    const pull_number = pull_request.number;
    const token =
      core.getInput('github-token') || process.env.GITHUB_TOKEN || '';
    if (!token) {
      core.setFailed(
        'GITHUB_TOKEN is missing. Pass it via the github-token input or GITHUB_TOKEN env.'
      );
      return 'no token';
    }
    const octokit = github.getOctokit(token);
    const chat = await loadChat(octokit, owner, repo, pull_number);

    if (!chat) {
      core.info('Chat initialized failed');
      return 'no chat';
    }

    core.debug(`pull_request: ${pull_request.number}`);

    if (pull_request.state === 'closed' || pull_request.locked) {
      core.info('invalid event payload');
      return 'invalid event payload';
    }

    const target_label = process.env.TARGET_LABEL;
    if (
      target_label &&
      (!pull_request.labels?.length ||
        pull_request.labels.every((label) => label.name !== target_label))
    ) {
      core.info('no target label attached');
      return 'no target label attached';
    }

    let changedFiles = await getChangedFiles(octokit, {
      owner,
      repo,
      pull_number,
      action,
      before,
      headSha: pull_request.head.sha,
    });

    core.debug(`changedFiles: ${changedFiles.length}`);

    const ignoreList = splitLines(process.env.IGNORE || process.env.ignore);
    const ignorePatterns = splitPatterns(process.env.IGNORE_PATTERNS);
    const includePatterns = splitPatterns(process.env.INCLUDE_PATTERNS);

    core.debug(`ignoreList: ${JSON.stringify(ignoreList)}`);
    core.debug(`ignorePatterns: ${JSON.stringify(ignorePatterns)}`);
    core.debug(`includePatterns: ${JSON.stringify(includePatterns)}`);

    changedFiles = changedFiles.filter((file) => {
      const url = new URL(file.contents_url);
      const pathname = decodeURIComponent(url.pathname);
      // if includePatterns is not empty, only include files that match the pattern
      if (includePatterns.length) {
        return matchPatterns(includePatterns, pathname);
      }

      if (ignoreList.includes(file.filename)) {
        return false;
      }

      // if ignorePatterns is not empty, ignore files that match the pattern
      if (ignorePatterns.length) {
        return !matchPatterns(ignorePatterns, pathname);
      }

      return true;
    });

    if (!changedFiles.length) {
      core.info('no change found');
      return 'no change';
    }

    const ress: Array<{
      path: string;
      body: string;
      line: number;
      side: 'RIGHT' | 'LEFT';
    }> = [];
    const bodyComments: string[] = [];
    const failedFiles: string[] = [];
    // Files that carried no reviewable diff. Retrying them cannot help, so
    // they do not make the run incomplete, but they are a real gap in
    // coverage and must not be reported as LGTM.
    const skippedFiles: string[] = [];

    for (let i = 0; i < changedFiles.length; i++) {
      const file = changedFiles[i];
      const patch = file.patch || '';

      if (file.status !== 'modified' && file.status !== 'added') {
        // Deleted or renamed. There is no new content to review, so this is a
        // policy exclusion rather than a gap in coverage.
        core.info(`${file.filename} skipped: status is ${file.status}`);
        continue;
      }

      if (!patch) {
        core.info(`${file.filename} skipped: no diff available (binary?)`);
        skippedFiles.push(file.filename);
        continue;
      }

      if (patch.length > MAX_PATCH_COUNT) {
        core.info(
          `${file.filename} skipped: diff of ${patch.length} exceeds MAX_PATCH_LENGTH`
        );
        skippedFiles.push(file.filename);
        continue;
      }
      try {
        const res = await chat.codeReview(patch);
        // res can be a single review or an array of reviews (one for each hunk)
        const reviews = Array.isArray(res) ? res : [res];

        for (const review of reviews) {
          if (!review.lgtm && !!review.review_comment) {
            const inlineComment = createInlineReviewComment(
              file.filename,
              review.review_comment,
              review.hunk_header,
              patch
            );
            if (!inlineComment) {
              bodyComments.push(
                `**File:** ${codeSpan(file.filename)}\n\n${review.review_comment}`
              );
              core.error(
                `Failed to locate inline review comment: ${review.hunk_header || 'missing hunk header'}`
              );
              continue;
            }

            ress.push(inlineComment);
          }
        }
      } catch (e) {
        // Keep going so the remaining files are still reviewed and the findings
        // already collected are not lost to a single bad file. The step is
        // failed after the review is posted, so the error still shows in CI.
        const message = e instanceof Error ? e.message : String(e);
        core.warning(`review ${file.filename} failed: ${message}`);
        failedFiles.push(file.filename);
      }
    }
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number,
        body: createReviewBody(
          ress.length > 0,
          bodyComments,
          failedFiles,
          skippedFiles
        ),
        event: 'COMMENT',
        commit_id: pull_request.head.sha,
        comments: ress,
      });
    } catch (e) {
      core.info(`Failed to create review: ${e}`);
      throw e;
    }

    if (failedFiles.length) {
      core.setFailed(
        `could not review ${failedFiles.length} file(s): ${failedFiles.join(', ')}`
      );
      return 'partial failure';
    }

    core.info(`successfully reviewed ${pull_request.html_url}`);
    return 'success';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(message);
    throw error;
  }
};

const toGlob = (pattern: string) => {
  if (pattern.startsWith('/')) {
    return '**' + pattern;
  }
  if (pattern.startsWith('**')) {
    return pattern;
  }
  return '**/' + pattern;
};

const matchPatterns = (patterns: string[], path: string) => {
  return patterns.some((pattern) => {
    try {
      return minimatch(path, toGlob(pattern));
    } catch {
      // if the pattern is not a valid glob pattern, try to match it as a regular expression
      try {
        return new RegExp(pattern).test(path);
      } catch {
        return false;
      }
    }
  });
};
