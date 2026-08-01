# Customizations in this fork

Six behaviour changes against upstream `ItzCrazyKns/Vane`, plus one build
change (7). They previously lived as
idempotent string replacements against the minified production build in the
`itzcrazykns1337/vane:latest` image; they are now source changes, built into a
local `vane-custom` image.

Keeping them here rather than as patches means the compiler checks them, they
survive an image rebuild, and a conflict with upstream shows up as a merge
conflict in a readable file rather than as a patch that silently matches
nothing.

| # | Change | Files |
| --- | --- | --- |
| 1 | Per-mode answer length, configurable from Settings | `lib/config/answerLength.ts`, `lib/config/index.ts`, `lib/prompts/search/writer.ts` |
| 2 | The classifier can no longer skip the search phase at will | `lib/agents/search/index.ts` |
| 3 | OpenRouter requests opt out of prompt retention | `lib/models/providers/openai/privacyFetch.ts`, `openaiLLM.ts`, `openaiEmbedding.ts` |
| 4 | Provider robustness fixes | `lib/models/constants.ts`, `openaiLLM.ts`, `ollama/ollamaLLM.ts` |
| 5 | Retry with a different model and mode | `components/MessageActions/Rewrite.tsx`, `lib/hooks/useChat.tsx` |
| 6 | Ephemeral chats for clients that keep their own history | `app/api/chat/route.ts`, `lib/agents/search/index.ts`, `lib/agents/search/types.ts` |
| 7 | Dockerfile layer order: cacheable rebuilds, smaller image | `Dockerfile` |
| 8 | Embedding vectors no longer stream to the client | `lib/agents/search/researcher/actions/search/baseSearch.ts` |
| 9 | Search embeddings are fetched in one batch | `baseSearch.ts`, `lib/models/providers/openai/openaiEmbedding.ts` |
| 10 | The answer stream is rate limited instead of per token | `lib/agents/search/index.ts` |
| 11 | The classifier model is configurable | `lib/models/classifierModel.ts`, `lib/config/index.ts`, `app/api/chat/route.ts`, `lib/agents/search/index.ts`, `lib/agents/search/types.ts` |

## 1. Per-mode answer length

The writer prompt is almost entirely mode-blind upstream — the only thing that
branches on mode is the Quality directive at the end. Speed therefore inherits
"read like a high-quality blog post", "provide comprehensive coverage" and a
mandatory closing paragraph, which is why a Speed answer reads like an essay.

Four blocks of that prompt are now mode-aware, and each mode carries a word
target read from **Settings → Personalization**:

| Field | Config key | Default |
| --- | --- | --- |
| Speed mode answer length | `personalization.speedWordTarget` | 200 |
| Balanced mode answer length | `personalization.balancedWordTarget` | 500 |
| Quality mode answer length | `personalization.qualityWordTarget` | 2000 |

These are `scope: 'server'` fields, so the settings UI POSTs them to
`/api/config` and they persist to `config.json`. No client change is needed —
the settings page renders whatever fields `GET /api/config` hands it. The
prompt reads them back through the ConfigManager singleton, which holds
`config.json` in memory and mutates it on write, so **a change applies to the
next question with no restart**. A missing, blank or unparseable value falls
back to the default.

The number is stated as a target, never a cap. Every mode carries the same
sentence: *"That figure is a target, not a ceiling: when answering the question
accurately and completely needs more words, use them — and when it needs fewer,
stop early rather than padding to reach it."*

Brevity is explicitly subordinated to accuracy. Both shortened modes name what
may be cut (background, restatement, analogies, conclusions) and what may not
(citations, figures, dates, names, caveats, disagreement between sources). The
citation requirements are untouched.

Measured on this deployment, changing only the setting between runs:

| Mode | Target | Answer |
| --- | --- | --- |
| Speed | 90 | 95 words, 8 citations, 30 sources |
| Speed | 400 | 437 words |
| Balanced | 250 | 286 words, 23 citations, 74 sources |
| Quality | 800 | 1104 words, 11 citations, 221 sources |

Quality overshoots — the "research report" framing pulls upwards, and the
target is deliberately soft — but it tracks: the same question at the stock
2000 produced 1731 words.

## 2. The classifier can no longer skip the search phase at will

A classifier LLM runs before any searching and sets `skipSearch` when it thinks
the query is answerable from general knowledge. Upstream then skips the entire
research phase and hands the writer
`"<Query to be answered without searching; Search not made>"`.

It is far too eager. Measured on this deployment, it skipped the search for
"What is the Nord Stream pipeline?", "newest features in the Next.js 16.2
release" and "latest news about EU AI Act enforcement", yielding either an
un-sourced answer from training data — no citations, no sources, and no UI
signal that nothing was searched — or the writer's canned refusal.

`skipSearch` is now honoured only when a weather / stock / calculation widget
already covers the query, since that output does reach the writer as
`<widgets_result>`.

The flag is **cleared**, not merely ignored at the call site. `web_search`,
`academic_search` and `social_search` each gate themselves a second time in
their own `enabled()`:

```ts
config.classification.classification.skipSearch === false
```

The first version of this change only skipped the check in
`lib/agents/search/index.ts`, so a query the classifier wanted to skip entered
the research phase with **no search tool in the list at all** — the researcher
wrote a reasoning preamble, called `done`, and the writer refused for lack of
sources. That is strictly worse than the stock behaviour it replaced, which at
least answered from training data. Measured on this deployment with
`deepseek/deepseek-v4-flash-0731`, "pourquoi le 1er août est le jour de fête
national en suisse ?" produced 0 sources on 4 of 4 runs; after clearing the
flag, 10 / 24 / 18 sources on 3 of 3.

It looked model-specific but is not. GLM 5.2 classifies the same query
`skipSearch: true` (8 of 8 runs across both models) and gets the same crippled
tool list; it merely copes by recalling a URL and calling `scrape_url`, which
is not gated. Any model that does not improvise a URL returns the refusal.

This is not "always search": the researcher's orchestrator still decides
whether to call `web_search`, so a greeting costs one extra LLM turn rather
than a search.

| Query | Before | After |
| --- | --- | --- |
| "What is the Nord Stream pipeline?" | refusal, 0 sources | 175 words, 15 citations, 50 sources |
| "latest news about EU AI Act enforcement" | 0 citations | 166 words, 13 citations, 72 sources |
| "pourquoi le 1er août est la fête nationale suisse ?" | refusal, 0 sources (4/4) | 10-24 sources (3/3) |
| "hi there" | no research | research entered, 0 searches, 12 s |
| "What is 25% of 80?" | widget, no search | unchanged |

## 3. OpenRouter requests opt out of prompt retention

OpenRouter picks an upstream provider per request, and unless the request says
otherwise it may pick one whose terms permit training on the prompt.

Rather than editing every call site, `privacyFetch` wraps the `fetch` the
OpenAI SDK client is constructed with, so one hook covers streaming,
non-streaming, `generateObject`, embeddings and every retry — including
providers added later through the Settings UI.

- **Scope:** only `openrouter.ai` URLs whose path ends in `/chat/completions`
  or `/embeddings`. `/models` and every non-OpenRouter provider are untouched.
- **Precedence:** a default, not an override. An existing `provider` object in
  the body is spread over the injected one.
- **Trade-off:** a model with no compliant endpoint returns
  `404 No allowed providers are available` instead of silently falling back to
  a data-collecting provider. Intended, but it is the failure mode to expect
  when adding models.

## 4. Provider robustness fixes

- `max_completion_tokens` / `num_predict` default to `DEFAULT_MAX_TOKENS`
  (16384) when neither the request nor the provider config sets one. Left
  undefined, several providers default low enough to truncate a Quality answer
  mid-sentence.
- `generateObject` retries with `response_format: { type: 'json_object' }` when
  the `json_schema` form is rejected — several OpenRouter upstreams reject it
  outright. The schema is still enforced on the parsed result.
- Reasoning models routed through OpenRouter sometimes return the payload in
  `message.reasoning` and leave `message.content` null; that is now handled.
- A tool call with an empty `arguments` string parses as `{}` instead of
  throwing and losing the whole turn.
- The same guard now applies to the **streaming** path, which had its own
  `partial-json` call and no fallback. Several providers prime a tool call with
  one or more empty `arguments` deltas before the first real one — DeepSeek V4
  Flash and GLM 5.2 do it on every call — and `partial-json` throws
  `Error(' is empty')` on a blank string. Because that happened inside the
  stream generator it surfaced as an `unhandledRejection`, the turn never
  emitted `done`, and the UI hung indefinitely rather than showing an error.
- Streamed tool calls are stored at `recievedToolCalls[tc.index]` instead of
  being `push`ed. With `push`, a provider that announces a higher index first
  wrote the call into the wrong slot and then appended a second call's
  arguments onto the first, corrupting both.
- `done` no longer discards the rest of the turn. The researcher used to break
  as soon as the last tool call was `done`, before executing anything, so a
  model that bundled `[__reasoning_preamble, web_search, done]` into one turn -
  DeepSeek V4 Flash does - had **every** call in that turn thrown away and left
  the writer with nothing to cite. The actionable calls now run first and
  `done` is honoured after, wherever in the turn it appeared.
- `ActionRegistry.executeAll` writes results at `results[index]` instead of
  pushing them. The caller pairs `results[i]` with `actions[i]` to build the
  tool messages, but `push` under `Promise.all` ordered by completion: a turn
  of `[web_search, __reasoning_preamble]` - the order DeepSeek emits - answered
  the search's `tool_call_id` with the preamble's output and vice versa.

## 5. Retry with a different model and mode

The stock retry button re-runs with whatever the chat is already set to, so
"the fast model got this wrong, try the good one" is a three-step detour
through the composer — and leaves the chat on the heavier model afterwards.

The button is now a menu: pick a mode, then either retry with the same model or
pick a different one. Both selections apply to that single retry and are not
persisted.

## 6. Ephemeral chats

A request carrying `X-Vane-Client: perpink-ios` streams its answer normally but
writes no `chats` and no `messages` rows. For clients that keep their own
history and should not leave a copy on the server.

Add further client identifiers to `EPHEMERAL_CLIENTS` in
`src/app/api/chat/route.ts`.

## 7. Dockerfile layer order

Upstream's runtime stage copies the app artifacts first and then runs
`yarn add playwright` and the SearXNG install. Two consequences:

- Every source change invalidated those layers, so a one-line fix cost a full
  rebuild (~20 min).
- `yarn add playwright` ran on top of the Next.js standalone output, so it
  re-resolved the app's whole dependency tree from standalone's `package.json`
  and installed **586 extra modules** — the entire dev tree (`eslint`,
  `@babel`, `autoprefixer`). That step alone took 283s and carried ~6 GB.

`playwright` is already a dependency in `package.json`, so the builder stage
installs it and Next.js traces it into the standalone output. The `yarn add`
was redundant. It is gone; SearXNG and the browser download are hoisted above
the `COPY --from=builder` lines.

The one subtlety: standalone traces only playwright's runtime entrypoint
(`index.js`), **not** `cli.js`, so the installer is copied from the builder's
full `node_modules`. Both come from the same `yarn.lock`, so the version — and
the browser build number the app looks for at launch — always match. Installing
the browser any other way (a separately resolved `yarn add`, or a pinned
`npx playwright@x.y.z`) risks a browser whose build number `playwright-core`
does not look for, which fails only at runtime with
`Executable doesn't exist at .../chromium_headless_shell-<n>`.

Measured on this host:

| | before | after |
| --- | --- | --- |
| source-only rebuild | ~1200s | 206s (all of it `yarn build`) |
| image size | 8.71 GB | 2.4 GB |

After changing this file, verify Chromium actually **launches** — not just that
`require('playwright')` resolves, which stays true even when the browser is
missing:

```sh
docker run --rm --entrypoint sh <image> -c 'cd /home/vane && node -e "
  require(\"playwright\").chromium.launch({args:[\"--no-sandbox\"]}).then(b=>{
    console.log(\"OK\"); b.close();
  }).catch(e=>console.log(\"FAILED:\", e.message.split(String.fromCharCode(10))[0]))"'
```

## 8. Embedding vectors no longer stream to the client

In `speed` and `balanced` mode the search path embeds every result to score and
deduplicate it, then pushes those chunks — vector and all — into the
`search_results` substep. The substep is what the session streams to the client
and what gets written to `messages.responseBlocks`.

A `pplx-embed` vector is 1024 floats, roughly 13 KB of JSON. Measured on one
real query, **2.6 MB of the 2.79 MB response was embeddings**: 93% of the
payload, for data the UI never reads. It renders the title and the url.

`withoutEmbeddings` now strips the vector from the copy handed to the session.
The full chunks stay on the local `results` array, which is what the similarity
and dedup passes below actually use, so scoring is unchanged.

The `quality` branch already built its chunks with `embedding: []` and needed no
change.

## 9. Search embeddings are fetched in one batch

`executeSearch` called `embedText([content])` once per search result — around 20
separate HTTPS round trips per query, for data the API accepts as a single
array. The sibling `embedChunks` in the same file already batched.

Now the query and every result go in one request. Measured directly against
OpenRouter: **0.47s for 21 texts, against 6.11s issuing them one at a time.**

This makes the response order load-bearing, so `openaiEmbedding` sorts on the
`index` field rather than trusting arrival order. It could not matter when each
request carried one text; with a batch, a provider answering out of order would
silently score every snippet against the wrong text — a corruption that would
look like poor result quality, not like a bug.

## 10. The answer stream is rate limited instead of per token

The writer emitted one `replace /data` per token, and that patch carries the
whole answer so far rather than the delta. The bytes are quadratic in answer
length: **1.38 MB for a 2653-character reply**, plus one full markdown
re-render at the client per token.

The patch shape is not ours to change — `perpink-ios` applies these patches too,
and rfc6902 has no string-append operation — so the fix is to send fewer of
them. Tokens accumulate on the block (which is the live session object, so
server state and the DB write stay current either way) and the emit is limited
to one per 100 ms. At 10 updates a second the stream still reads as continuous.

The flush after the loop is the part that matters for correctness: a client
reconnecting through `/api/reconnect/[id]` replays the event log, so the tail
that the last interval did not cover has to be emitted before `end`.

## 11. The classifier model is configurable

Classification runs before anything else and blocks the whole pipeline —
measured at 7s, 19s and 4.4s on three consecutive queries with DeepSeek V4
Flash, against a 64s total. It is one short structured call, so it does not need
the model that writes the answer.

`Settings -> Search -> Classifier model` takes a model key. Blank, which is the
default, reuses the chat model exactly as before.

| Field | Config key | Default |
| --- | --- | --- |
| Classifier model | `search.classifierModel` | `''` (reuse the chat model) |

The key must be one of the models already added to the same provider as the chat
model — `loadChatModel` validates against the configured list, not against
everything the provider offers. Resolution is deliberately forgiving: a typo, a
retired model, or a key from another provider all log and fall back to the chat
model rather than fail the request. A slow classifier is a nuisance; a search
that does not run is not.

```
Classifier model "nonexistent/not-a-real-model" could not be loaded, falling
back to the chat model: Error: Error Loading OpenAI Chat Model. Invalid Model
Selected
```

Measured on this host, time from request to the research block opening — which
is the classification step and nothing else:

| Classifier | Samples |
| --- | --- |
| `deepseek-v4-flash` (i.e. the chat model, the old behaviour) | 2.85, 3.35, 3.49, 3.50, 4.40, 4.55, 5.01, 6.87, 7.11, 7.32, 19.18 |
| `mistral-small-2603` | 12.91 (first call), 0.68, 0.66, ≤2.82 |

So roughly 3-4s per query once warm, but note the cold first call. The point of
the setting is that the right model here is an empirical question per host and
per provider — measure before assuming a smaller model is faster.

Measured end to end on this host, one balanced-mode query, `speed`/`balanced`
being the modes that never touch Playwright:

| | before | after |
| --- | --- | --- |
| bytes on the wire | 2.27–2.79 MB | 0.21 MB |
| embedding vectors sent to the client | 75 | 0 |
| `search_results` substep | 2.46 MB | 0.08 MB |
| answer stream (`/data`) | 1.38 MB | 0.13 MB |
| search + embedding step | 3.65–7.11s | 2.03–3.47s |

## Merging upstream

```sh
git remote add upstream https://github.com/ItzCrazyKns/Vane.git   # once
git fetch upstream
git merge upstream/master
```

Conflicts should only appear in the files listed in the table above. After
merging, rebuild and check the four things most likely to break silently: the
three answer-length boxes appear in Settings → Personalization, a Speed answer
is short, a general-knowledge question still returns sources, and the retry
button opens a menu.
