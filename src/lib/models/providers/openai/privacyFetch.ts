/**
 * Per-host request body defaults for OpenAI-compatible providers.
 *
 * Rather than editing every `chat.completions` call site, this wraps the
 * `fetch` the OpenAI SDK client is constructed with. One hook covers
 * streaming, non-streaming, generateObject, embeddings and every retry -
 * including providers added later through the Settings UI.
 *
 * Every rule is a default, not an override: a request that already sets the
 * field itself still wins. Hosts without a rule, and paths a rule does not
 * list (`/models` in particular), are sent untouched.
 */

type BodyRule = {
  host: string;
  paths: string[];
  apply: (body: Record<string, any>) => void;
};

const RULES: BodyRule[] = [
  /* OpenRouter picks an upstream provider per request, and unless the request
   * says otherwise it may pick one whose terms permit training on the prompt.
   * OpenRouter also exposes an account-level privacy setting that does much
   * the same thing. Keeping the behaviour with the deployment means it holds
   * regardless of which account key is configured.
   *
   * The trade-off is real: a model with no compliant endpoint returns
   * `404 No allowed providers are available` instead of silently falling back
   * to a data-collecting provider. That is the intended behaviour, but it is
   * the failure mode to expect when adding models. */
  {
    host: 'openrouter.ai',
    paths: ['/chat/completions', '/embeddings'],
    apply: (body) => {
      body.provider = {
        data_collection: 'deny',
        ...(body.provider ?? {}),
      };
    },
  },
  /* Hetzner's inference API serves Qwen3 on vLLM with thinking on by default.
   * The reasoning arrives in `delta.reasoning`, which `streamText` does not
   * forward, so the answer box stayed empty for minutes: measured, the first
   * visible text of a speed-mode search landed at 270s, and a 1500-token
   * budget could be spent on reasoning alone with no answer at all. With
   * thinking off the same prompt finished in 13s instead of 66s. */
  {
    host: 'inference.hetzner.com',
    paths: ['/chat/completions'],
    apply: (body) => {
      body.chat_template_kwargs = {
        enable_thinking: false,
        ...(body.chat_template_kwargs ?? {}),
      };
    },
  },
];

const ruleFor = (url: string): BodyRule | undefined => {
  try {
    const parsed = new URL(url);

    return RULES.find(
      (rule) =>
        (parsed.hostname === rule.host ||
          parsed.hostname.endsWith(`.${rule.host}`)) &&
        rule.paths.some((path) => parsed.pathname.endsWith(path)),
    );
  } catch {
    return undefined;
  }
};

const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

export const privacyFetch: typeof fetch = async (input, init) => {
  const rule =
    typeof init?.body === 'string' ? ruleFor(urlOf(input)) : undefined;

  if (!rule) {
    return fetch(input, init);
  }

  try {
    const body = JSON.parse(init!.body as string);

    rule.apply(body);

    return fetch(input, { ...init, body: JSON.stringify(body) });
  } catch {
    /* Not a JSON body we understand. Send it untouched rather than break the
     * call over a default. */
    return fetch(input, init);
  }
};
