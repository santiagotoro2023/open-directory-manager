# Builds the odm-client package.
#
# glfw builds an X11 and a Wayland backend on Linux, so both sets of headers
# have to be here — the same four the CI job installs.
FROM golang:1.25-trixie

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libgl1-mesa-dev xorg-dev libwayland-dev libxkbcommon-dev dpkg-dev \
 && rm -rf /var/lib/apt/lists/*
