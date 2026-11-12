#!/usr/bin/env bash
# Build linux/amd64 + linux/arm64 and push one manifest to Docker Hub.
# Usage: scripts/build-push.sh [tag]
#   tag    image tag; default is the current 12-char git SHA
# Env:
#   IMAGE=abu116/cursor2response
#   PLATFORMS=linux/amd64,linux/arm64
#   BUILDER=cursor2response-builder
#   PUSH_LATEST=1     set to 0 to skip the latest tag
#   NPM_REGISTRY=https://registry.npmmirror.com
#   APT_MIRROR=http://mirrors.tuna.tsinghua.edu.cn (empty uses Debian upstream)
#   NODE_IMAGE=node:24-bookworm-slim (may include a registry mirror prefix)
#   HTTP_PROXY / HTTPS_PROXY / NO_PROXY (must be reachable from build containers)
#   BUILD_PROGRESS=auto (plain shows full build logs)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

image="${IMAGE:-abu116/cursor2response}"
platforms="${PLATFORMS:-linux/amd64,linux/arm64}"
builder="${BUILDER:-cursor2response-builder}"
push_latest="${PUSH_LATEST:-1}"
npm_registry="${NPM_REGISTRY:-https://registry.npmmirror.com}"
apt_mirror="${APT_MIRROR-http://mirrors.tuna.tsinghua.edu.cn}"
node_image="${NODE_IMAGE:-node:24-bookworm-slim}"

if [[ $# -gt 1 ]]; then
  echo "usage: scripts/build-push.sh [tag]" >&2
  exit 2
fi

if [[ $# -eq 1 ]]; then
  tag="$1"
elif [[ -n "${TAG:-}" ]]; then
  tag="${TAG}"
elif tag="$(git -C "$root" rev-parse --short=12 HEAD 2>/dev/null)"; then
  :
else
  echo "unable to resolve a git SHA; pass a tag: scripts/build-push.sh <tag>" >&2
  exit 2
fi

if [[ ! "$image" =~ ^[a-z0-9]+([._-][a-z0-9]+)*(/[a-z0-9]+([._-][a-z0-9]+)*)+$ ]]; then
  echo "invalid image name: $image" >&2
  exit 2
fi

if [[ ! "$tag" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]; then
  echo "invalid tag: $tag" >&2
  exit 2
fi

if [[ "$platforms" != "linux/amd64,linux/arm64" && "$platforms" != "linux/arm64,linux/amd64" && "$platforms" != "linux/amd64" && "$platforms" != "linux/arm64" ]]; then
  echo "unsupported PLATFORMS: $platforms" >&2
  echo "use linux/amd64, linux/arm64, or linux/amd64,linux/arm64" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx is required" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "docker daemon is not reachable" >&2
  exit 1
fi

if ! docker buildx inspect "$builder" >/dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container --bootstrap >/dev/null
fi
docker buildx inspect --bootstrap --builder "$builder" >/dev/null

tags=(-t "${image}:${tag}")
if [[ "$push_latest" == "1" && "$tag" != "latest" ]]; then
  tags+=(-t "${image}:latest")
fi

echo "push ${image}:${tag} (${platforms})"
echo "npm registry: ${npm_registry}; apt mirror: ${apt_mirror:-Debian upstream}"
if [[ "$push_latest" == "1" && "$tag" != "latest" ]]; then
  echo "also tag ${image}:latest"
fi

docker buildx build \
  --builder "$builder" \
  --platform "$platforms" \
  --progress "${BUILD_PROGRESS:-auto}" \
  --build-arg "NPM_REGISTRY=$npm_registry" \
  --build-arg "APT_MIRROR=$apt_mirror" \
  --build-arg "NODE_IMAGE=$node_image" \
  --build-arg HTTP_PROXY \
  --build-arg HTTPS_PROXY \
  --build-arg NO_PROXY \
  --build-arg http_proxy \
  --build-arg https_proxy \
  --build-arg no_proxy \
  "${tags[@]}" \
  --push \
  "$root"

docker buildx imagetools inspect "${image}:${tag}"
