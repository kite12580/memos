# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM tonistiigi/xx AS xx

FROM --platform=$BUILDPLATFORM node:26-alpine AS client
WORKDIR /build/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
COPY server/templates /build/server/templates
COPY server/src /build/server/src
RUN npm run build

FROM --platform=$BUILDPLATFORM rust:1-alpine AS server
COPY --from=xx / /
RUN apk add --no-cache clang lld
ARG TARGETPLATFORM
RUN xx-apk add --no-cache musl-dev gcc
WORKDIR /build/server
COPY client/locales /build/client/locales
COPY server/Cargo.toml server/Cargo.lock server/build.rs ./
COPY server/.cargo ./.cargo
RUN mkdir src && echo 'fn main() {}' > src/main.rs && touch src/lib.rs \
    && xx-cargo build --release --locked \
    && rm -rf src
COPY client/src /build/client/src
COPY server/templates ./templates
COPY server/src ./src
RUN touch src/main.rs src/lib.rs build.rs && xx-cargo build --release --locked \
    && cp target/$(xx-cargo --print-target-triple)/release/memos-lite /memos-lite \
    && xx-verify --static /memos-lite \
    && mkdir /data

FROM scratch AS runtime
COPY --from=server /memos-lite /memos-lite
COPY --from=client /build/client/dist /client
COPY --from=server --chown=65534:65534 /data /data
ENV DATA_DIR=/data CLIENT_DIR=/client PORT=5230 HOST=0.0.0.0
USER 65534:65534
EXPOSE 5230
ENTRYPOINT ["/memos-lite"]
