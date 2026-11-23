FROM node:22-alpine AS wa-builder
RUN apk add --no-cache git
WORKDIR /wa
COPY wa/package.json wa/tsconfig.json ./
COPY wa/src ./src
RUN npm install --ignore-scripts && npx tsc --noEmit

FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim AS py-builder
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src ./src
COPY config.jsonc ./config.jsonc
COPY README.md ./README.md
RUN uv sync --frozen --no-dev

FROM node:22-bookworm-slim AS wa-runtime
WORKDIR /app/wa
COPY --from=wa-builder /wa/node_modules ./node_modules
COPY --from=wa-builder /wa/src ./src
COPY --from=wa-builder /wa/package.json ./package.json

FROM debian:bookworm-slim AS whisper-builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential cmake git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /whisper
RUN git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git . \
 && cmake -B build -DGGML_NATIVE=OFF -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
 && cmake --build build --config Release --target whisper-cli -j"$(nproc)"

FROM python:3.14-slim-bookworm AS runtime
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-fra tesseract-ocr-eng libpq5 ffmpeg libgomp1 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=whisper-builder /whisper/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=py-builder /app/.venv /app/.venv
COPY --from=py-builder /app/config.jsonc /app/config.jsonc
COPY --from=py-builder /app/src /app/src
COPY --from=wa-runtime /app/wa /app/wa
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
ENV PATH="/app/.venv/bin:/usr/local/bin:$PATH" PYTHONUNBUFFERED=1
ENV STOCKLINE_WA_URL=http://localhost:3001
EXPOSE 8000
CMD ["sh", "-c", "mkdir -p /app/models/whisper && if [ ! -s /app/models/whisper/ggml-large-v3-turbo-q5_0.bin ]; then echo '[stt] downloading ggml-large-v3-turbo-q5_0.bin...' && curl -L --fail --retry 3 -o /app/models/whisper/ggml-large-v3-turbo-q5_0.bin.tmp https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin && mv /app/models/whisper/ggml-large-v3-turbo-q5_0.bin.tmp /app/models/whisper/ggml-large-v3-turbo-q5_0.bin; fi; (cd /app/wa && /usr/local/bin/node node_modules/.bin/tsx src/index.ts) & exec stockline-api"]
