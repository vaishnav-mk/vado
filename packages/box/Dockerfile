# Valkey or Redis, unmodified, built from the same pinned release tarballs as packages/wasm (packages/wasm/update.sh
# moves both). SERVER picks one: docker build --build-arg SERVER=redis packages/box
FROM debian:trixie-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates curl pkg-config \
  && rm -rf /var/lib/apt/lists/*
ARG SERVER=valkey
ARG VALKEY_VERSION=9.1.1
ARG VALKEY_SHA256=7d7232acd1b8a49b4e05d07a00b3ca8c801ae06ab633ca6a3423bc5f385ab7ee
ARG REDIS_VERSION=8.12.0
ARG REDIS_SHA256=07e2477372566acf587e32c1abc8af088ad901fb2c725388ec9a5bef29c47319
RUN case "$SERVER" in \
      valkey) url="https://github.com/valkey-io/valkey/archive/refs/tags/$VALKEY_VERSION.tar.gz" sum="$VALKEY_SHA256" ;; \
      redis) url="https://github.com/redis/redis/archive/refs/tags/$REDIS_VERSION.tar.gz" sum="$REDIS_SHA256" ;; \
      *) echo "SERVER is valkey or redis" >&2; exit 1 ;; \
    esac \
  && curl -fsSL "$url" -o /server.tgz && echo "$sum  /server.tgz" | sha256sum -c - \
  && mkdir /src && tar -xzf /server.tgz -C /src --strip-components=1 \
  && make -C /src -j"$(nproc)" BUILD_TLS=no \
  && make -C /src install PREFIX=/out

FROM debian:trixie-slim
# netcat: a restore streams the stored RDB in over TCP, faster than exec() stdin.
RUN apt-get update && apt-get install -y --no-install-recommends netcat-openbsd && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/bin/ /usr/local/bin/
RUN mkdir /data
WORKDIR /data
# No CMD: the shard's object passes the command line with start({ entrypoint }).
