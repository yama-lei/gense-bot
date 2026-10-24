# The sandbox images (roadmap-3 D7): `slim` and `full`. Build both with `npm run sandbox:build`.
# The host runs one container per user as the host's own uid, with the user's files at /data.
FROM ghcr.io/astral-sh/uv:0.12.24 AS uv

FROM node:24.21.0-trixie-slim AS slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv git ripgrep grep findutils zip unzip tar xz-utils curl wget ca-certificates \
      jq file less vim-tiny procps iptables \
 && rm -rf /var/lib/apt/lists/*
COPY --from=uv /uv /uvx /usr/local/bin/
# Caches and user-level installs live under /data, so they survive the container (D7).
ENV HOME=/data/.home \
    XDG_CACHE_HOME=/data/.cache \
    UV_CACHE_DIR=/data/.cache/uv \
    PIP_CACHE_DIR=/data/.cache/pip \
    npm_config_cache=/data/.cache/npm \
    npm_config_prefix=/data/.local \
    PYTHONUSERBASE=/data/.local \
    PIP_BREAK_SYSTEM_PACKAGES=1 \
    PATH=/data/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8
CMD ["sleep", "infinity"]

FROM slim AS full
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential python3-dev ffmpeg imagemagick poppler-utils pandoc fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*
RUN UV_CACHE_DIR=/tmp/uv uv pip install --system --break-system-packages --no-cache \
      numpy==2.5.3 pandas==3.0.6 matplotlib==3.11.2 requests==2.34.2 beautifulsoup4==4.15.0 lxml==6.1.3 pillow==12.3.0 \
      openpyxl==3.1.5 python-docx==1.2.0 python-pptx==1.0.2 pypdf==6.19.0 pyyaml==6.0.3
