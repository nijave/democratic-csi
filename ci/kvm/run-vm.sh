#!/usr/bin/env bash
# Boot an OpenZFS-enabled VM under KVM and run zfs-local csi-sanity inside it.
# Used by CI and by ci/bin/run-kvm-local.sh.
set -euo pipefail

WORKSPACE="${WORKSPACE:-$(pwd)}"
TEMPLATE_CONFIG_REL="${TEMPLATE_CONFIG_REL:-ci/configs/zfs-local/dataset.yaml}"
CSI_SANITY_REL="${CSI_SANITY_REL:-.ci-cache/csi-sanity}"
CI_RESULT_REL="${CI_RESULT_REL:-.ci-result}"
CSI_SANITY_SKIP="${CSI_SANITY_SKIP:-}"
VM_MEM="${VM_MEM:-3072}"
VM_CPUS="${VM_CPUS:-2}"
VM_DISK_EXTRA="${VM_DISK_EXTRA:-15G}"
BOOT_TIMEOUT="${BOOT_TIMEOUT:-1200}"
UBUNTU_IMAGE_URL="${UBUNTU_IMAGE_URL:-https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img}"
UBUNTU_SHA256_URL="${UBUNTU_SHA256_URL:-https://cloud-images.ubuntu.com/releases/24.04/release/SHA256SUMS}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

WORKDIR="$(mktemp -d -t kvm-csi-XXXXXXXX)"
cleanup() { rm -rf "$WORKDIR"; }

substitute() {
  sed -e "s#\${CSI_SANITY_REL}#${CSI_SANITY_REL}#g" \
      -e "s#\${TEMPLATE_CONFIG_REL}#${TEMPLATE_CONFIG_REL}#g" \
      -e "s#\${CI_RESULT_REL}#${CI_RESULT_REL}#g" \
      -e "s#\${CSI_SANITY_SKIP}#${CSI_SANITY_SKIP}#g" \
      "$HERE/user-data" >"$WORKDIR/user-data"
}

# qemu argv as an array (avoids word-splitting bugs from string interpolation)
QEMU_ARGS=(
  qemu-system-x86_64
  -enable-kvm -cpu host -m "${VM_MEM}" -smp "${VM_CPUS}"
  -drive "file=${WORKDIR}/overlay.qcow2,if=virtio,format=qcow2"
  -drive "file=${WORKDIR}/seed.iso,if=virtio,format=raw"
  -fsdev "local,id=fsdev0,path=${WORKSPACE},security_model=none"
  -device virtio-9p-pci,fsdev=fsdev0,mount_tag=project
  -nographic -serial mon:stdio
)

trap cleanup EXIT

# --- dry-run: construct artifacts without KVM/tools/network ---
substitute
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "=== qemu command ==="; printf ' %q' "${QEMU_ARGS[@]}"; echo
  echo "=== user-data ==="; cat "$WORKDIR/user-data"
  exit 0
fi

# --- 1. KVM present ---
if [[ ! -e /dev/kvm ]]; then
  echo "ERROR: /dev/kvm not found. Needs an x86_64 KVM host (GitHub-hosted runner with the kvm udev rule applied)." >&2
  exit 2
fi

# --- 2. tools ---
need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: missing tool: $1" >&2; exit 2; }; }
need qemu-system-x86_64
need qemu-img
need cloud-localds
need wget

# --- 3. base image + sha256 verify ---
BASE_IMG="$WORKDIR/base.img"
echo "Downloading Ubuntu 24.04 cloud image..."
wget -q -O "$BASE_IMG" "$UBUNTU_IMAGE_URL"
EXPECTED="$(wget -q -O - "$UBUNTU_SHA256_URL" | awk '/ubuntu-24.04-server-cloudimg-amd64.img/ {print $1; exit}')"
ACTUAL="$(sha256sum "$BASE_IMG" | awk '{print $1}')"
[[ "$EXPECTED" == "$ACTUAL" ]] || { echo "ERROR: sha256 mismatch (expected $EXPECTED got $ACTUAL)" >&2; exit 2; }

# --- 4. writable overlay, resized for the zpool + scratch ---
OVERLAY="$WORKDIR/overlay.qcow2"
qemu-img create -q -f qcow2 -F qcow2 -b "$BASE_IMG" "$OVERLAY"
qemu-img resize -q "$OVERLAY" "+${VM_DISK_EXTRA}"

# --- 5. cloud-init seed ---
printf 'instance-id: csi-zfs-local\nlocal-hostname: csi-zfs-local\n' >"$WORKDIR/meta-data"
cloud-localds "$WORKDIR/seed.iso" "$WORKDIR/user-data" "$WORKDIR/meta-data"

# --- 6. boot (guest powers off when done) ---
RESULT_FILE="$WORKSPACE/$CI_RESULT_REL"
rm -f "$RESULT_FILE"
echo "Booting VM (timeout ${BOOT_TIMEOUT}s)..."
set +e
timeout "${BOOT_TIMEOUT}" "${QEMU_ARGS[@]}" </dev/null
QEMU_RC=$?
set -e

if [[ "$QEMU_RC" -ne 0 ]]; then
  echo "ERROR: qemu exited non-zero or timed out (rc=$QEMU_RC)." >&2
  [[ -f "$RESULT_FILE" ]] || echo "ERROR: $CI_RESULT_REL missing — VM boot/provision failed before the test ran." >&2
  exit "$QEMU_RC"
fi

# --- 7. read sentinel ---
[[ -f "$RESULT_FILE" ]] || { echo "ERROR: $CI_RESULT_REL missing — sentinel contract violated." >&2; exit 2; }
STATUS="$(cat "$RESULT_FILE")"
echo "csi-sanity exit status: $STATUS"

# Surface the VM's runcmd/driver/csi-sanity log on failure so it's diagnosable.
# Only on failure (keeps green runs quiet) and guarded so cat can never change
# the exit code (a large dump under `set -e` can abort on SIGPIPE/EPIPE).
VM_LOG="$WORKSPACE/.ci-vm-output.log"
if [[ "$STATUS" -ne 0 && -f "$VM_LOG" ]]; then
  echo "================ VM OUTPUT LOG ================"
  cat "$VM_LOG" 2>/dev/null || true
  echo "============== END VM OUTPUT LOG =============="
fi

exit "$STATUS"
