# Build runner container — Flutter SDK included, Android SDK excluded.
#
# The previous base image (ghcr.io/cirruslabs/flutter:stable) bundles the full
# Android SDK (~2 GB) on top of an Ubuntu base, which pushed the final image to
# 2867 MB — exceeding Cloudflare Containers' 2000 MB image size limit.
#
# Instead we install the Flutter SDK directly (the same method the cirruslabs
# image uses — a shallow git clone of flutter/flutter) on top of a slim Debian
# base and precache only web artifacts. This keeps the image well under the
# 2000 MB limit while still supporting Flutter web, test, and Linux desktop
# builds. The container has internet access at runtime, so any additional
# Flutter engine artifacts are downloaded on demand.
FROM debian:bookworm-slim

USER root

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake clang ninja-build git python3 ca-certificates curl unzip xz-utils \
  && rm -rf /var/lib/apt/lists/*

ARG flutter_version=stable
ENV FLUTTER_HOME=/opt/flutter
ENV FLUTTER_ROOT=${FLUTTER_HOME}
ENV PATH="${PATH}:${FLUTTER_HOME}/bin:${FLUTTER_HOME}/bin/cache/dart-sdk/bin"

# Install the Flutter SDK via a shallow clone (same approach as cirruslabs/flutter).
RUN git clone --depth 1 --branch ${flutter_version} https://github.com/flutter/flutter.git ${FLUTTER_HOME} \
  && flutter precache --web \
  && chown -R root:root ${FLUTTER_HOME}

WORKDIR /app
COPY container-server.py /app/container-server.py
EXPOSE 8080
CMD ["python3", "/app/container-server.py"]
