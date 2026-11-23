# Native Redis, unmodified, from the same pinned release as packages/wasm/redis/build.sh.
FROM debian:trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates curl pkg-config libjemalloc-dev \
  && rm -rf /var/lib/apt/lists/*
ARG REDIS_VERSION=8.12.0
ARG REDIS_SHA256=07e2477372566acf587e32c1abc8af088ad901fb2c725388ec9a5bef29c47319
RUN curl -fsSL "https://github.com/redis/redis/archive/refs/tags/${REDIS_VERSION}.tar.gz" -o /redis.tgz \
  && echo "${REDIS_SHA256}  /redis.tgz" | sha256sum -c - \
  && mkdir /src && tar -xzf /redis.tgz -C /src --strip-components=1 \
  && make -C /src -j"$(nproc)" BUILD_TLS=no USE_SYSTEM_JEMALLOC=yes \
  && make -C /src install PREFIX=/out

FROM debian:trixie-slim
# netcat: a restore streams the stored RDB in over TCP, faster than exec() stdin.
RUN apt-get update && apt-get install -y --no-install-recommends libjemalloc2 netcat-openbsd && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/bin/redis-server /out/bin/redis-cli /usr/local/bin/
RUN mkdir /data
WORKDIR /data
EXPOSE 6379
# The Durable Object passes the real arguments with start({ entrypoint }).
CMD ["redis-server", "--protected-mode", "no"]
