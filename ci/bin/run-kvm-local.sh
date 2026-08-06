#!/usr/bin/env bash
# Reproduce the CI zfs-local KVM run locally. Builds csi-sanity if missing,
# then boots the VM via ci/kvm/run-vm.sh. Requires an x86_64 KVM host.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CSI_SANITY="$ROOT/.ci-cache/csi-sanity"
export TEMPLATE_CONFIG_REL="${TEMPLATE_CONFIG_REL:-ci/configs/zfs-local/dataset.yaml}"

if [[ ! -x "$CSI_SANITY" ]]; then
  echo "Building csi-sanity (v5.5.0) — needs go, make, git..."
  need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1" >&2; exit 2; }; }
  need go; need make; need git
  BUILD_DIR="$(mktemp -d -t csi-sanity-XXXXXXXX)"
  trap 'rm -rf "$BUILD_DIR"' EXIT
  git clone --depth 1 --branch v5.5.0 https://github.com/kubernetes-csi/csi-test "$BUILD_DIR/csi-test"
  ( cd "$BUILD_DIR/csi-test/cmd/csi-sanity" && make csi-sanity )
  mkdir -p "$ROOT/.ci-cache"
  install -m 0755 "$BUILD_DIR/csi-test/cmd/csi-sanity/csi-sanity" "$CSI_SANITY"
fi

export WORKSPACE="$ROOT"
exec "$ROOT/ci/kvm/run-vm.sh" "$@"
