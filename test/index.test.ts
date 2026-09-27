import { Chat } from '../src/chat';
import {
  createInlineReviewComment,
  createReviewBody,
  getChangedFiles,
  getReviewCommentLocation,
  isHunkHeaderInPatch,
  loadChat,
} from '../src/bot';

const pullRequestFiles = [
  {
    filename: 'src/current.ts',
    status: 'modified',
    contents_url: 'https://api.github.com/repos/owner/repo/contents/src/current.ts',
    patch: 'current pull request patch',
  },
  {
    filename: 'src/incremental.ts',
    status: 'modified',
    contents_url: 'https://api.github.com/repos/owner/repo/contents/src/incremental.ts',
    patch: 'incremental pull request patch',
  },
];

const incrementalFiles = [
  {
    filename: 'src/incremental.ts',
    status: 'modified',
    contents_url: 'https://api.github.com/repos/owner/repo/contents/src/incremental.ts',
    patch: 'commit comparison patch',
  },
];

const unrelatedFiles = [
  {
    filename: 'README.md',
    status: 'modified',
    contents_url: 'https://api.github.com/repos/owner/repo/contents/README.md',
    patch: 'unrelated comparison patch',
  },
];

const patch = [
  '@@ -10,2 +10,3 @@ function example() {',
  ' unchanged',
  '-old',
  '+new',
  '+added',
  '@@ -20,3 +21,0 @@ function removed() {',
  '-one',
  '-two',
  '-three',
].join('\n');

const createBotReview = (
  body = 'Code review by ChatGPT',
  commitId: string | null = 'reviewed-head'
) => ({
  body: `${body}\n\n<!-- chatgpt-code-review -->`,
  commit_id: commitId,
  user: { type: 'Bot' },
});

const createIncompleteBotReview = (
  commitId: string | null = 'partial-head'
) => ({
  body: '> **Review incomplete.**\n\n<!-- chatgpt-code-review incomplete -->',
  commit_id: commitId,
  user: { type: 'Bot' },
});

const baseParams = {
  owner: 'owner',
  repo: 'repo',
  pull_number: 123,
  action: 'synchronize',
  before: 'previous-head',
  headSha: 'current-head',
};

const createOctokit = ({
  reviews = [],
  comparisons = [],
  reviewsError,
}: {
  reviews?: Array<{
    body: string;
    commit_id?: string | null;
    user?: { type: string };
  }>;
  comparisons?: Array<
    | {
        status: 'ahead' | 'behind' | 'diverged' | 'identical';
        files?: typeof pullRequestFiles;
      }
    | Error
  >;
  reviewsError?: Error;
} = {}) => {
  const listFiles = jest.fn();
  const listReviews = jest.fn();
  const compareCommits = jest.fn();
  const createReview = jest.fn();
  const getRepoVariable = jest.fn();
  const createComment = jest.fn();

  for (const comparison of comparisons) {
    if (comparison instanceof Error) {
      compareCommits.mockRejectedValueOnce(comparison);
    } else {
      compareCommits.mockResolvedValueOnce({ data: comparison });
    }
  }

  const rest = {
    pulls: {
      listFiles,
      listReviews,
      createReview,
    },
    repos: {
      compareCommits,
    },
    actions: {
      getRepoVariable,
    },
    issues: {
      createComment,
    },
  };

  const paginate = jest.fn(async (method: unknown) => {
    if (method === listFiles) {
      return pullRequestFiles;
    }
    if (method === listReviews) {
      if (reviewsError) {
        throw reviewsError;
      }
      return reviews;
    }
    throw new Error('unexpected pagination method');
  });

  return {
    octokit: { paginate, rest } as any,
    compareCommits,
    listFiles,
    listReviews,
    paginate,
    getRepoVariable,
    createComment,
  };
};

describe('getChangedFiles', () => {
  test('uses the current pull request files when the pull request is opened', async () => {
    const { octokit, compareCommits, listReviews } = createOctokit();

    await expect(
      getChangedFiles(octokit, { ...baseParams, action: 'opened' })
    ).resolves.toEqual(pullRequestFiles);
    expect(listReviews).not.toHaveBeenCalled();
    expect(compareCommits).not.toHaveBeenCalled();
  });

  test('uses current pull request patches for files in an incremental diff', async () => {
    const { octokit, compareCommits } = createOctokit({
      reviews: [createBotReview()],
      comparisons: [
        {
          status: 'ahead',
          files: incrementalFiles,
        },
      ],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual([
      pullRequestFiles[1],
    ]);
    expect(compareCommits).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      base: 'reviewed-head',
      head: 'current-head',
    });
  });

  test('ignores matching review text from a human reviewer', async () => {
    const { octokit, compareCommits } = createOctokit({
      reviews: [
        {
          body: 'LGTM 👍',
          commit_id: 'human-reviewed-head',
          user: { type: 'User' },
        },
      ],
      comparisons: [
        {
          status: 'ahead',
          files: incrementalFiles,
        },
      ],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual([
      pullRequestFiles[1],
    ]);
    expect(compareCommits).toHaveBeenCalledTimes(1);
    expect(compareCommits).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      base: 'previous-head',
      head: 'current-head',
    });
  });

  test('uses the full pull request for a legacy bot review without the marker', async () => {
    const { octokit, compareCommits } = createOctokit({
      reviews: [
        {
          body: 'Code review by ChatGPT',
          commit_id: 'legacy-reviewed-head',
          user: { type: 'Bot' },
        },
      ],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual(
      pullRequestFiles
    );
    expect(compareCommits).not.toHaveBeenCalled();
  });

  test('uses the full pull request when a trusted review has no commit', async () => {
    const { octokit, compareCommits } = createOctokit({
      reviews: [createBotReview('Code review by ChatGPT', null)],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual(
      pullRequestFiles
    );
    expect(compareCommits).not.toHaveBeenCalled();
  });

  test('uses the full pull request when review history cannot be listed', async () => {
    const { octokit, compareCommits } = createOctokit({
      reviewsError: new Error('reviews unavailable'),
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual(
      pullRequestFiles
    );
    expect(compareCommits).not.toHaveBeenCalled();
  });

  test('excludes files that are only present in an ahead comparison', async () => {
    const { octokit } = createOctokit({
      reviews: [createBotReview()],
      comparisons: [
        {
          status: 'ahead',
          files: unrelatedFiles,
        },
      ],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual([]);
  });

  test('falls back when a comparison reaches the GitHub file limit', async () => {
    const comparisonFiles = Array.from({ length: 300 }, (_, index) => ({
      filename: `src/file-${index}.ts`,
      status: 'modified',
      contents_url: `https://api.github.com/repos/owner/repo/contents/src/file-${index}.ts`,
      patch: 'commit comparison patch',
    }));
    const { octokit } = createOctokit({
      reviews: [createBotReview()],
      comparisons: [
        {
          status: 'ahead',
          files: comparisonFiles,
        },
      ],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual(
      pullRequestFiles
    );
  });

  test('falls back when an ahead comparison omits files', async () => {
    const { octokit } = createOctokit({
      reviews: [createBotReview()],
      comparisons: [
        {
          status: 'ahead',
        },
      ],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual(
      pullRequestFiles
    );
  });

  test('returns no files for an identical comparison', async () => {
    const { octokit } = createOctokit({
      reviews: [createBotReview()],
      comparisons: [
        {
          status: 'identical',
        },
      ],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual([]);
  });

  test('falls back to the current pull request files after diverged comparisons', async () => {
    const { octokit, compareCommits } = createOctokit({
      reviews: [createBotReview()],
      comparisons: [
        {
          status: 'diverged',
          files: unrelatedFiles,
        },
      ],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual(
      pullRequestFiles
    );
    expect(compareCommits).toHaveBeenCalledTimes(1);
    expect(compareCommits).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      base: 'reviewed-head',
      head: 'current-head',
    });
  });

  test('uses the synchronize before SHA when no prior bot review exists', async () => {
    const { octokit, compareCommits } = createOctokit({
      comparisons: [
        {
          status: 'ahead',
          files: incrementalFiles,
        },
      ],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual([
      pullRequestFiles[1],
    ]);
    expect(compareCommits).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      base: 'previous-head',
      head: 'current-head',
    });
  });

  test('uses the full pull request when the trusted review comparison fails', async () => {
    const { octokit, compareCommits } = createOctokit({
      reviews: [createBotReview('LGTM 👍')],
      comparisons: [new Error('reviewed commit is unavailable')],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual(
      pullRequestFiles
    );
    expect(compareCommits).toHaveBeenCalledTimes(1);
    expect(compareCommits).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      base: 'reviewed-head',
      head: 'current-head',
    });
  });

  test('paginates pull request reviews before selecting the latest one', async () => {
    const { octokit, listReviews, paginate } = createOctokit({
      reviews: [createBotReview()],
      comparisons: [
        {
          status: 'ahead',
          files: incrementalFiles,
        },
      ],
    });

    await getChangedFiles(octokit, baseParams);

    expect(paginate).toHaveBeenCalledWith(listReviews, {
      owner: 'owner',
      repo: 'repo',
      pull_number: 123,
      per_page: 100,
    });
  });

  test('does not use an incomplete review as the incremental base', async () => {
    // Otherwise the files that failed last time would never be asked for
    // again, because every later run would diff from a commit that already
    // contained them.
    const { octokit, compareCommits } = createOctokit({
      reviews: [createIncompleteBotReview()],
      comparisons: [
        {
          status: 'ahead',
          files: incrementalFiles,
        },
      ],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual([
      pullRequestFiles[1],
    ]);
    expect(compareCommits).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      base: 'previous-head',
      head: 'current-head',
    });
  });

  test('falls back to the push base when the last review was incomplete', async () => {
    const { octokit, compareCommits } = createOctokit({
      reviews: [createBotReview(), createIncompleteBotReview()],
      comparisons: [
        {
          status: 'ahead',
          files: pullRequestFiles,
        },
      ],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual(
      pullRequestFiles
    );
    expect(compareCommits).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      base: 'previous-head',
      head: 'current-head',
    });
  });

  test('uses the last complete review even when an older one was incomplete', async () => {
    const { octokit, compareCommits } = createOctokit({
      reviews: [createIncompleteBotReview(), createBotReview()],
      comparisons: [
        {
          status: 'ahead',
          files: incrementalFiles,
        },
      ],
    });

    await expect(getChangedFiles(octokit, baseParams)).resolves.toEqual([
      pullRequestFiles[1],
    ]);
    expect(compareCommits).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      base: 'reviewed-head',
      head: 'current-head',
    });
  });
});

describe('loadChat', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env['INPUT_GITHUB-TOKEN'];
    delete process.env.GITHUB_TOKEN;
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('uses OPENAI_API_KEY from env', async () => {
    process.env.OPENAI_API_KEY = 'env-key';
    const { octokit, getRepoVariable } = createOctokit();

    const chat = await loadChat(octokit, 'owner', 'repo', 123);

    expect(chat).toBeInstanceOf(Chat);
    expect(getRepoVariable).not.toHaveBeenCalled();
  });

  test('falls back to the repo variable', async () => {
    const { octokit, getRepoVariable } = createOctokit();
    getRepoVariable.mockResolvedValue({ data: { value: 'var-key' } });

    const chat = await loadChat(octokit, 'owner', 'repo', 123);

    expect(chat).toBeInstanceOf(Chat);
    expect(getRepoVariable).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      name: 'OPENAI_API_KEY',
    });
  });

  test('returns null when the repo variable is empty', async () => {
    const { octokit, getRepoVariable, createComment } = createOctokit();
    getRepoVariable.mockResolvedValue({ data: {} });

    await expect(loadChat(octokit, 'owner', 'repo', 123)).resolves.toBeNull();
    expect(createComment).not.toHaveBeenCalled();
  });

  test('comments on the PR and returns null when the variable is a 404', async () => {
    const { octokit, getRepoVariable, createComment } = createOctokit();
    const notFound = Object.assign(new Error('Not Found'), { status: 404 });
    getRepoVariable.mockRejectedValue(notFound);

    await expect(loadChat(octokit, 'owner', 'repo', 123)).resolves.toBeNull();
    expect(createComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 123,
      body: expect.stringContaining('OPENAI_API_KEY'),
    });
  });

  test('does not blame the configuration when the lookup is forbidden', async () => {
    const { octokit, getRepoVariable, createComment } = createOctokit();
    const forbidden = Object.assign(new Error('Forbidden'), { status: 403 });
    getRepoVariable.mockRejectedValue(forbidden);

    // A 403 says nothing about whether the variable is set, so it must not
    // post the "you forgot to configure this" comment, and must not pass
    // either: the run has to fail loudly instead of quietly skipping.
    await expect(loadChat(octokit, 'owner', 'repo', 123)).rejects.toThrow(
      /HTTP 403/
    );
    expect(createComment).not.toHaveBeenCalled();
  });

  test('surfaces a network failure instead of reporting a missing key', async () => {
    const { octokit, getRepoVariable, createComment } = createOctokit();
    getRepoVariable.mockRejectedValue(new Error('ECONNRESET'));

    await expect(loadChat(octokit, 'owner', 'repo', 123)).rejects.toThrow(
      /could not read the OPENAI_API_KEY repository variable/
    );
    expect(createComment).not.toHaveBeenCalled();
  });
});

describe('getReviewCommentLocation', () => {
  test('uses the last right-side line for a multi-line hunk', () => {
    expect(getReviewCommentLocation('@@ -10,5 +10,7 @@')).toEqual({
      line: 16,
      side: 'RIGHT',
    });
  });

  test('defaults omitted hunk counts to one line', () => {
    expect(getReviewCommentLocation('@@ -10 +12 @@ function name')).toEqual({
      line: 12,
      side: 'RIGHT',
    });
  });

  test('uses the left side for a deletion-only hunk', () => {
    expect(getReviewCommentLocation('@@ -10,3 +10,0 @@')).toEqual({
      line: 12,
      side: 'LEFT',
    });
  });

  test('rejects malformed hunk headers', () => {
    expect(getReviewCommentLocation('not a hunk header')).toBeNull();
  });

  test('rejects a missing hunk header', () => {
    expect(getReviewCommentLocation()).toBeNull();
  });
});

describe('isHunkHeaderInPatch', () => {
  test('accepts a hunk range present in the current patch', () => {
    expect(
      isHunkHeaderInPatch('@@ -10,2 +10,3 @@ function example() {', patch)
    ).toBe(true);
  });

  test('normalizes omitted single-line counts', () => {
    expect(isHunkHeaderInPatch('@@ -30 +30 @@', '@@ -30,1 +30,1 @@')).toBe(
      true
    );
  });

  test('rejects a valid hunk range absent from the current patch', () => {
    expect(isHunkHeaderInPatch('@@ -100,2 +100,3 @@', patch)).toBe(false);
  });

  test('does not treat a context line as a hunk header', () => {
    expect(
      isHunkHeaderInPatch(
        '@@ -100,2 +100,3 @@',
        ' @@ -100,2 +100,3 @@ example text'
      )
    ).toBe(false);
  });

  test('rejects a malformed hunk header', () => {
    expect(isHunkHeaderInPatch('not a hunk header', patch)).toBe(false);
  });
});

describe('createInlineReviewComment', () => {
  test('creates a right-side comment for a hunk in the current patch', () => {
    expect(
      createInlineReviewComment(
        'src/file.ts',
        'Finding',
        '@@ -10,2 +10,3 @@ function example() {',
        patch
      )
    ).toEqual({
      path: 'src/file.ts',
      body: 'Finding',
      line: 12,
      side: 'RIGHT',
    });
  });

  test('creates a left-side comment for a deletion hunk in the patch', () => {
    expect(
      createInlineReviewComment(
        'src/file.ts',
        'Finding',
        '@@ -20,3 +21,0 @@ function removed() {',
        patch
      )
    ).toEqual({
      path: 'src/file.ts',
      body: 'Finding',
      line: 22,
      side: 'LEFT',
    });
  });

  test('rejects a hallucinated hunk range', () => {
    expect(
      createInlineReviewComment(
        'src/file.ts',
        'Finding',
        '@@ -100,2 +100,3 @@',
        patch
      )
    ).toBeNull();
  });

  test('rejects a missing hunk header', () => {
    expect(
      createInlineReviewComment('src/file.ts', 'Finding', undefined, patch)
    ).toBeNull();
  });
});

describe('createReviewBody', () => {
  test('marks a review with inline comments as a ChatGPT review', () => {
    expect(createReviewBody(true, [])).toBe(
      'Code review by ChatGPT\n\n<!-- chatgpt-code-review -->'
    );
  });

  test('keeps unpositioned findings in the review body', () => {
    expect(createReviewBody(false, ['**File:** `src/file.ts`\n\nFinding'])).toBe(
      'Code review by ChatGPT\n\n**File:** `src/file.ts`\n\nFinding\n\n<!-- chatgpt-code-review -->'
    );
  });

  test('marks a review with no findings as LGTM', () => {
    expect(createReviewBody(false, [])).toBe(
      'LGTM 👍\n\n<!-- chatgpt-code-review -->'
    );
  });

  test('warns about failed files and keeps the findings', () => {
    expect(createReviewBody(true, [], ['src/broken.ts'])).toBe(
      '> **Review incomplete.** Could not review 1 file(s): `src/broken.ts`\n\n' +
        'Code review by ChatGPT\n\n<!-- chatgpt-code-review incomplete -->'
    );
  });

  test('does not claim LGTM when every file failed', () => {
    const body = createReviewBody(false, [], ['a.ts', 'b.ts']);

    expect(body).toContain('Could not review 2 file(s): `a.ts`, `b.ts`');
    expect(body).not.toContain('LGTM');
    expect(body).toContain('<!-- chatgpt-code-review incomplete -->');
  });

  test('wraps a backticked filename in a longer delimiter', () => {
    // A backslash does not escape a backtick inside a markdown code span, so
    // the delimiter has to grow instead.
    expect(createReviewBody(false, [], ['we`ird.ts'])).toContain(
      '``we`ird.ts``'
    );
  });

  test('pads a filename that would otherwise merge with the delimiter', () => {
    // Content starting with a backtick needs a space on both sides, or the
    // span is parsed as empty. The delimiter is two backticks because the
    // longest run inside the value is one.
    const body = createReviewBody(false, [], ['`edge`.ts']);

    expect(body).toContain('`` `edge`.ts ``');
  });

  test('keeps unpositioned findings alongside the failure warning', () => {
    const body = createReviewBody(false, ['**File:** `x.ts`\n\nFinding'], [
      'y.ts',
    ]);

    expect(body).toContain('> **Review incomplete.**');
    expect(body).toContain('**File:** `x.ts`\n\nFinding');
    expect(body.endsWith('<!-- chatgpt-code-review incomplete -->')).toBe(true);
  });

  test('caps the file list so the body cannot exceed the size limit', () => {
    const many = Array.from({ length: 40 }, (_, i) => `src/file-${i}.ts`);
    const body = createReviewBody(false, [], many);

    expect(body).toContain('Could not review 40 file(s)');
    expect(body).toContain('`src/file-9.ts`');
    expect(body).not.toContain('src/file-10.ts');
    expect(body).toContain('(+30 more)');
  });

  test('reports skipped files as a coverage gap without failing the run', () => {
    const body = createReviewBody(false, [], [], ['logo.png']);

    expect(body).toContain('**Coverage gap.**');
    expect(body).toContain('`logo.png`');
    expect(body).not.toContain('LGTM');
    // No failed file, so this review is a sound base for the next push.
    expect(body.endsWith('<!-- chatgpt-code-review -->')).toBe(true);
  });

  test('does not claim LGTM when a file was skipped and nothing was found', () => {
    const body = createReviewBody(false, [], [], ['a.ts', 'b.ts']);

    expect(body).toContain('**Coverage gap.**');
    expect(body).not.toContain('LGTM');
  });

  test('still claims LGTM when everything was reviewed', () => {
    expect(createReviewBody(false, [], [], [])).toBe(
      'LGTM 👍\n\n<!-- chatgpt-code-review -->'
    );
  });
});
