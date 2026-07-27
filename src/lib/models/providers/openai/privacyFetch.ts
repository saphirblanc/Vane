/**
 * OpenRouter picks an upstream provider per request, and unless the request
 * says otherwise it may pick one whose terms permit training on the prompt.
 *
 * Rather than editing every `chat.completions` call site, this wraps the
 * `fetch` the OpenAI SDK client is constructed with. One hook covers
 * streaming, non-streaming, generateObject, embeddings and every retry -
 * including providers added later through the Settings UI.
 *
 * OpenRouter also exposes an account-level privacy setting that does much the
 * same thing. Keeping the behaviour with the deployment means it holds
 * regardless of which account key is configured.
 */

const OPENROUTER_HOST = 'openrouter.ai';

/**
 * Both of these enforce provider routing. The trade-off is real: a model with
 * no compliant endpoint returns `404 No allowed providers are available`
 * instead of silently falling back to a data-collecting provider. That is the
 * intended behaviour, but it is the failure mode to expect when adding models.
 *
 * `/models` and every non-OpenRouter provider are left untouched.
 */
const GUARDED_PATHS = ['/chat/completions', '/embeddings'];

const isGuarded = (url: string): boolean => {
  try {
    const parsed = new URL(url);

    return (
      (parsed.hostname === OPENROUTER_HOST ||
        parsed.hostname.endsWith(`.${OPENROUTER_HOST}`)) &&
      GUARDED_PATHS.some((path) => parsed.pathname.endsWith(path))
    );
  } catch {
    return false;
  }
};

const urlOf = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
};

export const privacyFetch: typeof fetch = async (input, init) => {
  if (typeof init?.body !== 'string' || !isGuarded(urlOf(input))) {
    return fetch(input, init);
  }

  try {
    const body = JSON.parse(init.body);

    body.provider = {
      data_collection: 'deny',
      /* A default, not an override - a request that sets `provider` itself
       * still wins. */
      ...(body.provider ?? {}),
    };

    return fetch(input, { ...init, body: JSON.stringify(body) });
  } catch {
    /* Not a JSON body we understand. Send it untouched rather than break the
     * call over a privacy default. */
    return fetch(input, init);
  }
};
