import { Chat } from "../src/chat";

jest.mock("openai", () => {
  const mockCreate = jest.fn();
  return {
    OpenAI: jest.fn().mockImplementation(() => ({
      chat: { completions: { create: mockCreate } },
    })),
    mockCreate,
  };
});

const { OpenAI, mockCreate } = require("openai");

describe("Chat", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    mockCreate.mockReset();
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: '{"lgtm": true, "review_comment": ""}' } }],
    });
    (OpenAI as jest.Mock).mockClear();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("passes model from MODEL env var", async () => {
    process.env.MODEL = "gpt-5.4";

    const chat = new Chat("test-key");
    await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.4" })
    );
  });

  test("defaults to gpt-4o-mini when MODEL is not set", async () => {
    delete process.env.MODEL;

    const chat = new Chat("test-key");
    await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o-mini" })
    );
  });

  test("passes reasoning_effort when REASONING_EFFORT is set", async () => {
    process.env.MODEL = "o3-mini";
    process.env.REASONING_EFFORT = "low";

    const chat = new Chat("test-key");
    await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning_effort: "low" })
    );
  });

  test("passes reasoning_effort for the o1 reasoning model", async () => {
    process.env.MODEL = "o1";
    process.env.REASONING_EFFORT = "medium";

    const chat = new Chat("test-key");
    await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning_effort: "medium" })
    );
  });

  test("passes reasoning_effort for the o1-mini reasoning model", async () => {
    process.env.MODEL = "o1-mini";
    process.env.REASONING_EFFORT = "medium";

    const chat = new Chat("test-key");
    await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ reasoning_effort: "medium" })
    );
  });

  test("passes reasoning_effort for namespaced reasoning models", async () => {
    process.env.MODEL = "openai/o3-mini";
    process.env.REASONING_EFFORT = "medium";

    const chat = new Chat("test-key");
    await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "openai/o3-mini",
        reasoning_effort: "medium",
      })
    );
  });

  test("detects namespaced reasoning models case-insensitively", async () => {
    process.env.MODEL = "OpenAI/O3-MINI";
    process.env.REASONING_EFFORT = "high";

    const chat = new Chat("test-key");
    await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "OpenAI/O3-MINI",
        reasoning_effort: "high",
      })
    );
  });

  test.each(["none", "minimal", "xhigh"])(
    "passes SDK-supported reasoning_effort value %s",
    async (reasoningEffort) => {
      process.env.MODEL = "gpt-5.5";
      process.env.REASONING_EFFORT = reasoningEffort;

      const chat = new Chat("test-key");
      await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ reasoning_effort: reasoningEffort })
      );
    }
  );

  test("does not pass reasoning_effort when REASONING_EFFORT is not set", async () => {
    process.env.MODEL = "gpt-4o";
    delete process.env.REASONING_EFFORT;

    const chat = new Chat("test-key");
    await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.reasoning_effort).toBeUndefined();
  });

  test("does not pass reasoning_effort when model is not a reasoning model", async () => {
    process.env.MODEL = "gpt-4o";
    process.env.REASONING_EFFORT = "high";

    const chat = new Chat("test-key");
    await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.reasoning_effort).toBeUndefined();
  });

  test("does not treat every o-prefixed model as a reasoning model", async () => {
    process.env.MODEL = "orca-2";
    process.env.REASONING_EFFORT = "high";
    process.env.temperature = "0.5";
    process.env.top_p = "0.9";

    const chat = new Chat("test-key");
    await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.reasoning_effort).toBeUndefined();
    expect(callArgs.temperature).toBe(0.5);
    expect(callArgs.top_p).toBe(0.9);
    expect(callArgs.response_format).toEqual({ type: "json_object" });
  });

  test.each(["o1-preview"])(
    "does not pass reasoning_effort for %s",
    async (model) => {
      process.env.MODEL = model;
      process.env.REASONING_EFFORT = "high";
      process.env.temperature = "0.5";
      process.env.top_p = "0.9";

      const chat = new Chat("test-key");
      await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.reasoning_effort).toBeUndefined();
      expect(callArgs.temperature).toBe(0.5);
      expect(callArgs.top_p).toBe(0.9);
      expect(callArgs.response_format).toEqual({ type: "json_object" });
    }
  );

  test("omits temperature and top_p for reasoning models", async () => {
    process.env.MODEL = "gpt-5.4";
    process.env.temperature = "0.5";
    process.env.top_p = "0.9";

    const chat = new Chat("test-key");
    await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.temperature).toBeUndefined();
    expect(callArgs.top_p).toBeUndefined();
    expect(callArgs.response_format).toEqual({ type: "json_object" });
  });

  test("includes temperature, top_p, and response_format for non-reasoning models", async () => {
    process.env.MODEL = "gpt-4o";
    process.env.temperature = "0.5";
    process.env.top_p = "0.9";

    const chat = new Chat("test-key");
    await chat.codeReview("@@ -1,3 +1,4 @@\n+new line\n old line");

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.temperature).toBe(0.5);
    expect(callArgs.top_p).toBe(0.9);
    expect(callArgs.response_format).toEqual({ type: "json_object" });
  });

  test("returns empty review for empty patch", async () => {
    const chat = new Chat("test-key");
    const result = await chat.codeReview("");
    expect(result).toEqual({ lgtm: true, review_comment: "" });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("defaults to the public OpenAI endpoint", async () => {
    delete process.env.OPENAI_API_ENDPOINT;

    new Chat("test-key");

    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://api.openai.com/v1",
      })
    );
  });

  test("uses custom endpoint when OPENAI_API_ENDPOINT is set", async () => {
    process.env.OPENAI_API_ENDPOINT = "https://custom.api.com/v1";

    new Chat("test-key");

    expect(OpenAI).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: "https://custom.api.com/v1",
      })
    );
  });

  describe("malformed responses", () => {
    const patch = "@@ -1,3 +1,4 @@\n+new line\n old line";

    test("throws instead of crashing when the payload has no choices", async () => {
      mockCreate.mockResolvedValue({ error: { message: "unsupported" } });

      const chat = new Chat("test-key");

      await expect(chat.codeReview(patch)).rejects.toThrow(
        /no choices in response/
      );
    });

    test("includes the offending payload in the error", async () => {
      mockCreate.mockResolvedValue({ error: { code: "bad_request" } });

      const chat = new Chat("test-key");

      await expect(chat.codeReview(patch)).rejects.toThrow(/bad_request/);
    });

    test("throws when choices is null", async () => {
      mockCreate.mockResolvedValue({ choices: null });

      const chat = new Chat("test-key");

      await expect(chat.codeReview(patch)).rejects.toThrow(
        /no choices in response/
      );
    });

    test("throws rather than reporting LGTM when choices is empty", async () => {
      mockCreate.mockResolvedValue({ choices: [] });

      const chat = new Chat("test-key");

      // Reporting LGTM here would tell the PR author the code is fine when the
      // model never actually answered.
      await expect(chat.codeReview(patch)).rejects.toThrow(
        /no choices in response/
      );
    });

    test("does not crash when the message is missing", async () => {
      mockCreate.mockResolvedValue({ choices: [{}] });

      const chat = new Chat("test-key");

      await expect(chat.codeReview(patch)).resolves.toEqual({
        lgtm: false,
        hunk_header: "@@ -1,3 +1,4 @@",
        review_comment: "",
      });
    });

    test("keeps non-JSON content as the review comment", async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: "looks fine to me" } }],
      });

      const chat = new Chat("test-key");

      await expect(chat.codeReview(patch)).resolves.toEqual({
        lgtm: false,
        hunk_header: "@@ -1,3 +1,4 @@",
        review_comment: "looks fine to me",
      });
    });

    test("unwraps a markdown-fenced JSON answer", async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content:
                '```json\n{"lgtm": false, "review_comment": "check this"}\n```',
            },
          },
        ],
      });

      const chat = new Chat("test-key");

      await expect(chat.codeReview(patch)).resolves.toEqual({
        lgtm: false,
        review_comment: "check this",
      });
    });

    test("unwraps an unlabelled fence", async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: '```\n{"lgtm": true, "review_comment": ""}\n```',
            },
          },
        ],
      });

      const chat = new Chat("test-key");

      await expect(chat.codeReview(patch)).resolves.toEqual({
        lgtm: true,
        review_comment: "",
      });
    });

    test("keeps the raw text when a fenced block is not JSON", async () => {
      const raw = '```\nnot json at all\n```';
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: raw } }],
      });

      const chat = new Chat("test-key");

      await expect(chat.codeReview(patch)).resolves.toEqual({
        lgtm: false,
        hunk_header: "@@ -1,3 +1,4 @@",
        review_comment: raw,
      });
    });

    test("keeps a nested fence inside a review comment", async () => {
      // The outer fence is the model's wrapper; the inner one belongs to the
      // review comment. An unanchored match would extract the inner example and
      // lose the review entirely, which is the common case for code reviews.
      const review = {
        lgtm: false,
        review_comment: "use this:\n```js\nconst x = 1\n```",
      };
      mockCreate.mockResolvedValue({
        choices: [
          { message: { content: "```json\n" + JSON.stringify(review) + "\n```" } },
        ],
      });

      const chat = new Chat("test-key");

      await expect(chat.codeReview(patch)).resolves.toEqual(review);
    });

    test("handles CRLF inside a fenced JSON answer", async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: '```json\r\n{"lgtm": false, "review_comment": "crlf"}\r\n```',
            },
          },
        ],
      });

      const chat = new Chat("test-key");

      await expect(chat.codeReview(patch)).resolves.toEqual({
        lgtm: false,
        review_comment: "crlf",
      });
    });

    test("rejects the retired USE_GITHUB_MODELS flag with migration guidance", () => {
    process.env.USE_GITHUB_MODELS = "true";

    // Failing with a clear message beats silently falling through to OpenAI
    // with the default model, which is what an ignored flag would do.
    expect(() => new Chat("test-key")).toThrow(/retired on 30 July 2026/);
    expect(() => new Chat("test-key")).toThrow(/OPENAI_API_ENDPOINT/);
  });

  test("accepts an empty USE_GITHUB_MODELS without complaining", () => {
    process.env.USE_GITHUB_MODELS = "";

    expect(() => new Chat("test-key")).not.toThrow();
  });

  test("parses plain JSON that contains a fenced example", async () => {
      const review = {
        lgtm: false,
        review_comment: "wrap this:\n```py\nprint(1)\n```",
      };
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(review) } }],
      });

      const chat = new Chat("test-key");

      await expect(chat.codeReview(patch)).resolves.toEqual(review);
    });
  });
});
