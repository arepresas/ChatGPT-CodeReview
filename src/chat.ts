import { OpenAI, AzureOpenAI } from 'openai';

const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

type ReasoningEffort = typeof reasoningEfforts[number];

const isReasoningEffort = (effort: string): effort is ReasoningEffort =>
  (reasoningEfforts as readonly string[]).includes(effort);

/**
 * Models that cannot be forced into JSON mode often wrap their answer in a
 * markdown fence anyway. Unwrap it so the review still parses, rather than
 * posting a ```json block as the comment body.
 *
 * The pattern is anchored to the whole payload on purpose. A review comment
 * very often contains its own fenced example, and a non-greedy unanchored
 * match would stop at that inner fence and extract the example instead of the
 * review. Only an outer wrapper gets removed here.
 */
function stripJsonFence(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Extra HTTP headers for OpenAI-compatible gateways that require
 * them. `OPENAI_EXTRA_HEADERS` takes a JSON object, e.g.
 * '{"x-opencode-session": "my-session"}'.
 *
 * Shorthand: `OPENCODE_SESSION`, when set and not already present
 * in `OPENAI_EXTRA_HEADERS`, is sent as `x-opencode-session`
 * (mandated by OpenCode Go for request routing).
 */
function extraHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const raw = process.env.OPENAI_EXTRA_HEADERS;
  if (raw) {
    try {
      Object.assign(headers, JSON.parse(raw));
    } catch {
      console.warn('OPENAI_EXTRA_HEADERS is not valid JSON, ignoring');
    }
  }
  const session = process.env.OPENCODE_SESSION;
  if (session && !headers['x-opencode-session']) {
    headers['x-opencode-session'] = session;
  }
  return headers;
}

export class Chat {
  private openai: OpenAI | AzureOpenAI;
  private isAzure: boolean;

  private reasoningModels = ['o1', 'o1-2024-12-17', 'o1-mini', 'o1-mini-2024-09-12'];
  private reasoningPrefixes = ['o3', 'o4', 'gpt-5'];

  constructor(apikey: string) {
    // GitHub Models was retired on 30 July 2026 along with its inference API.
    // Silently ignoring the flag would send those users to OpenAI with the
    // default model and a confusing failure, so name the migration instead.
    if (process.env.USE_GITHUB_MODELS) {
      throw new Error(
        'USE_GITHUB_MODELS is no longer supported: GitHub Models and its ' +
          'inference API were retired on 30 July 2026. Unset it and point ' +
          'OPENAI_API_ENDPOINT and MODEL at an OpenAI-compatible endpoint.'
      );
    }

    this.isAzure = Boolean(
        process.env.AZURE_API_VERSION && process.env.AZURE_DEPLOYMENT,
    );

    if (this.isAzure) {
      // Azure OpenAI configuration
      this.openai = new AzureOpenAI({
        apiKey: apikey,
        endpoint: process.env.OPENAI_API_ENDPOINT || '',
        apiVersion: process.env.AZURE_API_VERSION || '',
        deployment: process.env.AZURE_DEPLOYMENT || '',
        defaultHeaders: extraHeaders(),
      });
    } else {
      // Standard OpenAI configuration
      this.openai = new OpenAI({
        apiKey: apikey,
        baseURL: process.env.OPENAI_API_ENDPOINT || 'https://api.openai.com/v1',
        defaultHeaders: extraHeaders(),
      });
    }
  }

  private get model(): string {
    return process.env.MODEL || 'gpt-4o-mini';
  }

  // Gateways may namespace model ids, e.g. "openai/o3-mini", so match the
  // reasoning families on the last segment.
  private get normalizedModel(): string {
    return this.model.split('/').pop() || this.model;
  }

  private get isReasoningModel(): boolean {
    const model = this.normalizedModel.toLowerCase();
    return this.reasoningModels.includes(model) || this.reasoningPrefixes.some(prefix => model.startsWith(prefix));
  }

  private get reasoningEffortOption(): { reasoning_effort?: ReasoningEffort } {
    const effort = process.env.REASONING_EFFORT;
    if (!effort || !this.isReasoningModel) return {};
    if (!isReasoningEffort(effort)) {
      console.warn(`REASONING_EFFORT="${effort}" is invalid, ignoring. Valid values: ${reasoningEfforts.join(', ')}`);
      return {};
    }
    return { reasoning_effort: effort };
  }

  private generatePrompt = (patch: string) => {
    const answerLanguage = process.env.LANGUAGE
        ? `Answer me in ${process.env.LANGUAGE},`
        : '';

    const userPrompt = process.env.PROMPT || 'Please review the following code patch. Focus on potential bugs, risks, and improvement suggestions.';
    
    const jsonFormatRequirement = '\nProvide your feedback in a strict JSON format with the following structure:\n' +
        '{\n' +
        '  "reviews": [\n' +
        '    {\n' +
        '      "hunk_header": string, // The @@ hunk header (e.g., "@@ -10,5 +10,7 @@"), optional\n' +
        '      "lgtm": boolean, // true if this hunk looks good, false if there are concerns\n' +
        '      "review_comment": string // Your detailed review comments for this hunk. Can use markdown syntax. Empty string if lgtm is true.\n' +
        '    }\n' +
        '  ]\n' +
        '}\n' +
        'Review each hunk (marked by @@) separately and provide feedback for hunks that need improvement.\n' +
        'Ensure your response is a valid JSON object with a reviews array.\n';

    return `${userPrompt}${jsonFormatRequirement} ${answerLanguage}:
    ${patch}
    `;
  };

  public codeReview = async (patch: string): Promise<Array<{ lgtm: boolean, review_comment: string, hunk_header?: string }> | { lgtm: boolean, review_comment: string, hunk_header?: string }> => {
    if (!patch) {
      return {
        lgtm: true,
        review_comment: ""
      };
    }

    const prompt = this.generatePrompt(patch);

    const isReasoning = this.isReasoningModel;

    const res = await this.openai.chat.completions.create({
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      model: this.model,
      ...(isReasoning ? {} : {
        temperature: +(process.env.temperature || 0) || 1,
        top_p: +(process.env.top_p || 0) || 1,
      }),
      max_tokens: process.env.max_tokens ? +process.env.max_tokens : undefined,
      ...this.reasoningEffortOption,
      response_format: { type: "json_object" },
    });

    const choices = res.choices;

    if (!choices?.length) {
      // Guard before touching `.length`: a gateway can resolve with a payload
      // that has no `choices` at all, and dereferencing it threw a TypeError
      // that hid the real response. Failing loudly keeps the payload in the
      // message, and reporting LGTM here would claim "no issues" for a review
      // that never actually ran.
      throw new Error(
        `no choices in response from ${this.model}: ${JSON.stringify(res).slice(0, 500)}`
      );
    }

    const content = choices[0].message?.content || '';

    try {
      const json = JSON.parse(stripJsonFence(content));
      // If response has a 'reviews' array, return it directly
      if (json.reviews && Array.isArray(json.reviews)) {
        return json.reviews;
      }
      // Otherwise, treat as a single review response
      return json;
    } catch {
      // Not valid JSON. Surface the raw text so the finding is not lost.
      return {
        lgtm: false,
        hunk_header: patch.split('\n')[0].startsWith('@@') ? patch.split('\n')[0] : undefined,
        review_comment: content
      }
    }
  };
}
