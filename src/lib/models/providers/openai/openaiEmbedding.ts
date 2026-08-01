import OpenAI from 'openai';
import BaseEmbedding from '../../base/embedding';
import { Chunk } from '@/lib/types';
import { privacyFetch } from './privacyFetch';

type OpenAIConfig = {
  apiKey: string;
  model: string;
  baseURL?: string;
};

class OpenAIEmbedding extends BaseEmbedding<OpenAIConfig> {
  openAIClient: OpenAI;

  constructor(protected config: OpenAIConfig) {
    super(config);

    this.openAIClient = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      fetch: privacyFetch,
    });
  }

  /**
   * Callers pair the returned vectors with their inputs positionally, so the
   * response has to be ordered by `index` rather than trusted to arrive in
   * order - the API documents that field for exactly this reason. It never
   * mattered while the search path embedded one text per request; now that it
   * sends the query and every result as one batch, a provider answering out of
   * order would silently score each snippet against the wrong text.
   */
  private static ordered(
    data: { index: number; embedding: number[] }[],
  ): number[][] {
    return [...data]
      .sort((a, b) => a.index - b.index)
      .map((embedding) => embedding.embedding);
  }

  async embedText(texts: string[]): Promise<number[][]> {
    const response = await this.openAIClient.embeddings.create({
      model: this.config.model,
      input: texts,
    });

    return OpenAIEmbedding.ordered(response.data);
  }

  async embedChunks(chunks: Chunk[]): Promise<number[][]> {
    const response = await this.openAIClient.embeddings.create({
      model: this.config.model,
      input: chunks.map((c) => c.content),
    });

    return OpenAIEmbedding.ordered(response.data);
  }
}

export default OpenAIEmbedding;
