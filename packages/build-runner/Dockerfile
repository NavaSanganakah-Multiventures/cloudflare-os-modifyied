FROM ghcr.io/cirruslabs/flutter:stable

USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake clang ninja-build git python3 ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY container-server.py /app/container-server.py
EXPOSE 8080
CMD ["python3", "/app/container-server.py"]
