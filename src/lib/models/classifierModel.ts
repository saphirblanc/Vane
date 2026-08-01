import configManager from '@/lib/config';
import ModelRegistry from './registry';
import BaseLLM from './base/llm';

/**
 * Resolves the model used for the classification step that precedes every
 * search.
 *
 * That step is a single short structured call, but it blocks the whole
 * pipeline: nothing else starts until it returns, and measured against
 * DeepSeek V4 Flash it cost between 7 and 19 seconds of a 64-second query.
 * Pointing it at a small fast model takes that off the front of every request
 * without touching the model that actually writes the answer.
 *
 * Deliberately forgiving. The setting is free text, so a typo, a model the
 * provider has retired, or a key that belongs to a different provider all have
 * to degrade to the chat model rather than fail the request - the classifier
 * being slow is a nuisance, the search not running at all is not.
 */
export const loadClassifierModel = async (
  registry: ModelRegistry,
  providerId: string,
  fallback: BaseLLM<any>,
): Promise<BaseLLM<any>> => {
  const key = String(
    configManager.getConfig('search.classifierModel', '') ?? '',
  ).trim();

  if (!key) return fallback;

  try {
    return await registry.loadChatModel(providerId, key);
  } catch (err) {
    console.error(
      `Classifier model "${key}" could not be loaded, falling back to the chat model:`,
      err,
    );

    return fallback;
  }
};
