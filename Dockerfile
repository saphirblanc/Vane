FROM node:24.5.0-slim AS builder

RUN apt-get update && apt-get install -y python3 python3-pip sqlite3 && rm -rf /var/lib/apt/lists/*

WORKDIR /home/vane

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --network-timeout 600000

COPY tsconfig.json next.config.mjs next-env.d.ts postcss.config.js drizzle.config.ts tailwind.config.ts ./
COPY src ./src
COPY public ./public
COPY drizzle ./drizzle

RUN mkdir -p /home/vane/data
RUN yarn build

FROM node:24.5.0-slim

RUN apt-get update && apt-get install -y \
    python3-dev python3-babel python3-venv python-is-python3 \
    uwsgi uwsgi-plugin-python3 \
    git build-essential libxslt-dev zlib1g-dev libffi-dev libssl-dev \
    curl sudo \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /home/vane

# Everything below this point is independent of the application source. It is
# ordered before the COPY --from=builder lines so that a source-only change
# does not invalidate the SearXNG layers. Touching any line in this section
# rebuilds all of it.

RUN mkdir /home/vane/uploads

RUN useradd --shell /bin/bash --system \
    --home-dir "/usr/local/searxng" \
    --comment 'Privacy-respecting metasearch engine' \
    searxng

RUN mkdir "/usr/local/searxng"
RUN mkdir -p /etc/searxng
RUN chown -R "searxng:searxng" "/usr/local/searxng"

COPY searxng/settings.yml /etc/searxng/settings.yml
COPY searxng/limiter.toml /etc/searxng/limiter.toml
COPY searxng/uwsgi.ini /etc/searxng/uwsgi.ini
RUN chown -R searxng:searxng /etc/searxng

USER searxng

RUN git clone "https://github.com/searxng/searxng" \
                   "/usr/local/searxng/searxng-src"

RUN python3 -m venv "/usr/local/searxng/searx-pyenv"
RUN "/usr/local/searxng/searx-pyenv/bin/pip" install --upgrade pip setuptools wheel pyyaml msgspec typing_extensions
RUN cd "/usr/local/searxng/searxng-src" && \
    "/usr/local/searxng/searx-pyenv/bin/pip" install --use-pep517 --no-build-isolation -e .

USER root

WORKDIR /home/vane
COPY entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
RUN sed -i 's/\r$//' ./entrypoint.sh || true

RUN echo "searxng ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Playwright. `playwright` is already an app dependency, but the standalone
# output traces only its runtime entrypoint (index.js) — not cli.js — so the
# browser installer has to come from the builder's full node_modules. Both
# resolve from the same yarn.lock, so the version, and therefore the browser
# build number the app looks for at launch, always match.
#
# These COPY layers are keyed on the content of the playwright packages rather
# than on the app source, so they and the download below stay cached across
# ordinary source changes. Do not fold this into the section below.
COPY --from=builder /home/vane/node_modules/playwright ./node_modules/playwright
COPY --from=builder /home/vane/node_modules/playwright-core ./node_modules/playwright-core
RUN node ./node_modules/playwright/cli.js install --with-deps --only-shell chromium

# Application artifacts last: these are the only layers a source change should
# invalidate. The standalone COPY lands its trimmed playwright over the full
# copy above; COPY merges rather than replaces, so cli.js survives.
COPY --from=builder /home/vane/public ./public
COPY --from=builder /home/vane/.next/static ./public/_next/static
COPY --from=builder /home/vane/.next/standalone ./
COPY --from=builder /home/vane/data ./data
COPY drizzle ./drizzle

EXPOSE 3000 8080

ENV SEARXNG_API_URL=http://localhost:8080

CMD ["/home/vane/entrypoint.sh"]
