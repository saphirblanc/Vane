import { ResearcherOutput, SearchAgentInput } from './types';
import SessionManager from '@/lib/session';
import { classify } from './classifier';
import Researcher from './researcher';
import { getWriterPrompt } from '@/lib/prompts/search/writer';
import { WidgetExecutor } from './widgets';
import db from '@/lib/db';
import { messages } from '@/lib/db/schema';
import { and, eq, gt } from 'drizzle-orm';
import { TextBlock } from '@/lib/types';
import { getTokenCount } from '@/lib/utils/splitText';

class SearchAgent {
  /**
   * Creates or resets the `messages` row this turn streams into.
   *
   * Skipped entirely for an ephemeral turn - see `SearchAgentInput.ephemeral`.
   * The answer still streams to the client; it just leaves nothing behind.
   */
  private async beginMessage(
    session: SessionManager,
    input: SearchAgentInput,
  ) {
    const exists = await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, input.chatId),
        eq(messages.messageId, input.messageId),
      ),
    });

    if (!exists) {
      await db.insert(messages).values({
        chatId: input.chatId,
        messageId: input.messageId,
        backendId: session.id,
        query: input.followUp,
        createdAt: new Date().toISOString(),
        status: 'answering',
        responseBlocks: [],
      });
    } else {
      await db
        .delete(messages)
        .where(
          and(eq(messages.chatId, input.chatId), gt(messages.id, exists.id)),
        )
        .execute();
      await db
        .update(messages)
        .set({
          status: 'answering',
          backendId: session.id,
          responseBlocks: [],
        })
        .where(
          and(
            eq(messages.chatId, input.chatId),
            eq(messages.messageId, input.messageId),
          ),
        )
        .execute();
    }
  }

  async searchAsync(session: SessionManager, input: SearchAgentInput) {
    if (!input.ephemeral) {
      await this.beginMessage(session, input);
    }

    const classification = await classify({
      chatHistory: input.chatHistory,
      enabledSources: input.config.sources,
      query: input.followUp,
      llm: input.config.classifierLlm ?? input.config.llm,
    });

    const widgetPromise = WidgetExecutor.executeAll({
      classification,
      chatHistory: input.chatHistory,
      followUp: input.followUp,
      llm: input.config.llm,
    }).then((widgetOutputs) => {
      widgetOutputs.forEach((o) => {
        session.emitBlock({
          id: crypto.randomUUID(),
          type: 'widget',
          data: {
            widgetType: o.type,
            params: o.data,
          },
        });
      });
      return widgetOutputs;
    });

    let searchPromise: Promise<ResearcherOutput> | null = null;

    /* The classifier decides `skipSearch` from whether it believes the query is
     * answerable from general knowledge, and it is far too eager about it -
     * measured on this deployment it skipped the search for "What is the Nord
     * Stream pipeline?" and "latest news about EU AI Act enforcement". Stock
     * then hands the writer "<Query to be answered without searching>", which
     * yields either an un-sourced answer from training data - no citations, no
     * sources, and no UI signal that nothing was searched - or the writer's
     * canned "could not find any relevant information" refusal.
     *
     * Honour it only when a widget already answers the query, since that
     * output does reach the writer as <widgets_result>.
     *
     * This is not "always search". The researcher's orchestrator still decides
     * whether to call web_search, so a greeting costs one extra LLM turn
     * rather than an actual search.
     *
     * The flag is cleared rather than merely ignored here, because
     * `web_search`, `academic_search` and `social_search` gate themselves on
     * `classification.skipSearch === false` in their own `enabled()`. Only
     * skipping the check at this level let the researcher start with no search
     * tool at all: it emitted a reasoning preamble, called `done`, and the
     * writer refused for lack of sources - strictly worse than the stock
     * behaviour it replaced. */
    const { classification: c } = classification;
    const widgetAnswersQuery =
      c.showWeatherWidget || c.showStockWidget || c.showCalculationWidget;

    if (c.skipSearch && !widgetAnswersQuery) {
      c.skipSearch = false;
    }

    if (!c.skipSearch) {
      const researcher = new Researcher();
      searchPromise = researcher.research(session, {
        chatHistory: input.chatHistory,
        followUp: input.followUp,
        classification: classification,
        config: input.config,
      });
    }

    const [widgetOutputs, searchResults] = await Promise.all([
      widgetPromise,
      searchPromise,
    ]);

    session.emit('data', {
      type: 'researchComplete',
    });

    let finalContext =
      '<Query to be answered without searching; Search not made>';

    if (searchResults) {
      finalContext = searchResults?.searchFindings
        .map(
          (f, index) =>
            `<result index=${index + 1} title=${f.metadata.title}>${f.content}</result>`,
        )
        .join('\n');
    }

    const widgetContext = widgetOutputs
      .map((o) => {
        return `<result>${o.llmContext}</result>`;
      })
      .join('\n-------------\n');

    const finalContextWithWidgets = `<search_results note="These are the search results and assistant can cite these">\n${finalContext}\n</search_results>\n<widgets_result noteForAssistant="Its output is already showed to the user, assistant can use this information to answer the query but do not CITE this as a souce">\n${widgetContext}\n</widgets_result>`;

    const writerPrompt = getWriterPrompt(
      finalContextWithWidgets,
      input.config.systemInstructions,
      input.config.mode,
    );

    const answerStream = input.config.llm.streamText({
      messages: [
        {
          role: 'system',
          content: writerPrompt,
        },
        ...input.chatHistory,
        {
          role: 'user',
          content: input.followUp,
        },
      ],
    });

    let responseBlockId = '';

    /* `replace /data` carries the whole answer so far rather than the delta,
     * so emitting one per token puts O(n^2) bytes on the wire - a measured
     * 1.38 MB for a 2653-character reply - and forces the client to re-render
     * the full markdown that many times. The patch shape is fixed (perpink-ios
     * applies these too, and rfc6902 has no string-append op), so the fix is
     * to send fewer of them: tokens accumulate on the block, which is the live
     * session object, and only the emit is rate limited.
     *
     * At 10 updates a second the stream still reads as continuous. `pending`
     * carries whatever the last interval did not cover, so the final flush
     * below is what guarantees a reconnecting client replaying the event log
     * ends up with the complete answer. */
    const FLUSH_INTERVAL_MS = 100;
    let lastFlushAt = 0;
    let pending = false;

    const flush = (block: TextBlock) => {
      pending = false;
      lastFlushAt = Date.now();

      session.updateBlock(block.id, [
        {
          op: 'replace',
          path: '/data',
          value: block.data,
        },
      ]);
    };

    for await (const chunk of answerStream) {
      if (!responseBlockId) {
        const block: TextBlock = {
          id: crypto.randomUUID(),
          type: 'text',
          data: chunk.contentChunk,
        };

        session.emitBlock(block);

        responseBlockId = block.id;
        lastFlushAt = Date.now();
      } else {
        const block = session.getBlock(responseBlockId) as TextBlock | null;

        if (!block) {
          continue;
        }

        block.data += chunk.contentChunk;
        pending = true;

        if (Date.now() - lastFlushAt >= FLUSH_INTERVAL_MS) {
          flush(block);
        }
      }
    }

    if (pending && responseBlockId) {
      const block = session.getBlock(responseBlockId) as TextBlock | null;

      if (block) {
        flush(block);
      }
    }

    session.emit('end', {});

    if (input.ephemeral) return;

    await db
      .update(messages)
      .set({
        status: 'completed',
        responseBlocks: session.getAllBlocks(),
      })
      .where(
        and(
          eq(messages.chatId, input.chatId),
          eq(messages.messageId, input.messageId),
        ),
      )
      .execute();
  }
}

export default SearchAgent;
