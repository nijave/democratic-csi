# zfs-local KVM CI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the self-hosted `csi-sanity-zfs-local` job with an `ubuntu-latest` + nested-KVM job that boots an OpenZFS VM and runs the project's own `ci/bin/run.sh` inside it — no self-hosted runner, appliance, or secrets.

**Architecture:** On a GitHub-hosted x86_64 runner, build `csi-sanity` (Go, cached), download + verify an Ubuntu 24.04 cloud image, boot it under QEMU/KVM with a cloud-init seed that loads OpenZFS, creates a `tank` zpool, installs Node 22, mounts the checked-out project over 9p, runs `ci/bin/run.sh` (driver + csi-sanity) against the local zpool, writes an exit-code sentinel, and powers off. The runner reads the sentinel and passes/fails.

**Tech Stack:** GitHub Actions, Bash, QEMU/KVM, cloud-init (`#cloud-config`), OpenZFS, Node 22, Go 1.24.1, `csi-test` v5.5.0.

## Global Constraints

- Runner: `ubuntu-latest`, **x86_64** (KVM required; ARM runners do not expose `/dev/kvm`).
- Node: 22 (matches `build-npm-*` jobs and the `Vagrantfile`).
- Ubuntu cloud image: `https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img`, verified against `.../SHA256SUMS` at runtime.
- Go: 1.24.1 (for building `csi-sanity`).
- `csi-sanity`: built from `kubernetes-csi/csi-test` tag **v5.5.0** (the release ships no binaries — assets are empty).
- `CSI_VERSION` passed to the driver stays at the existing default (1.9.0 in `ci/bin/launch-server.sh`); do not change it.
- The project's existing scripts (`ci/bin/run.sh`, `launch-server.sh`, `launch-csi-sanity.sh`) must run **unmodified** inside the VM.
- Follow the repo's conventional-commit style (`feat(ci):`, `chore(ci):`, etc.). Stage explicit paths only.

## File Structure

- **Create `ci/kvm/user-data`** — `#cloud-config` YAML run by cloud-init inside the VM (load zfs, create zpool, install node, mount 9p share, run test, write sentinel, poweroff). Contains three `${...}` tokens substituted by `run-vm.sh`.
- **Create `ci/kvm/run-vm.sh`** — host-side orchestrator (KVM check, image download+verify, overlay, cloud-init seed, boot with timeout, read sentinel). Called by both CI and the local wrapper. Supports `--dry-run` for KVM-free testing.
- **Create `ci/bin/run-kvm-local.sh`** — contributor entrypoint that builds `csi-sanity` if missing and calls `ci/kvm/run-vm.sh` (mirrors the existing `ci/bin/run.sh` pattern).
- **Modify `.github/workflows/main.yml`** — add `workflow_dispatch`, build `csi-sanity`, add the `csi-sanity-zfs-local-kvm` job, remove the old `csi-sanity-zfs-local` job, update the Docker jobs' `needs:`.

Each task is independently committable. Tasks 1–3 are locally testable (static + dry-run, no KVM needed); Task 4 is YAML-validated locally; Task 5 is the end-to-end CI verification.

---

### Task 1: cloud-init user-data for the ZFS VM

**Files:**
- Create: `ci/kvm/user-data`

**Interfaces:**
- Consumes: three host-substituted tokens — `${CSI_SANITY_REL}`, `${TEMPLATE_CONFIG_REL}`, `${CI_RESULT_REL}` (repo-relative paths set by `run-vm.sh`).
- Produces: a VM that, on boot, has a `tank` zpool, Node 22, `csi-sanity` on PATH, the project mounted at `/project`, runs `ci/bin/run.sh`, writes the exit code to `/project/${CI_RESULT_REL}`, and powers off.

- [ ] **Step 1: Create the cloud-config file**

Create `ci/kvm/user-data` with exactly:

```yaml
#cloud-config
package_update: true
packages:
  - zfsutils-linux
  - e2fsprogs
  - xfsprogs
  - nfs-common
  - sudo
runcmd:
  - |
    set -x
    # OpenZFS + a loopback-backed tank zpool
    modprobe zfs
    truncate -s 8G /tank.img
    zpool create -f tank /tank.img
    echo "=== zpool status ==="; zpool status
    echo "=== zfs version ==="; zfs version || true

    # Node 22; run.sh expects /usr/local/lib/nodejs/bin on PATH
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
    mkdir -p /usr/local/lib/nodejs/bin
    ln -sf "$(command -v node)" /usr/local/lib/nodejs/bin/node
    ln -sf "$(command -v npm)" /usr/local/lib/nodejs/bin/npm
    node --version

    # Project shared from the runner over 9p
    mkdir -p /project
    mount -t 9p -o trans=virtio,version=9p2000.L,access=any project /project

    # csi-sanity binary built on the runner lives in the share
    install -m 0755 "/project/${CSI_SANITY_REL}" /usr/local/bin/csi-sanity
    csi-sanity --help >/dev/null 2>&1 && echo "csi-sanity OK"

    # Run the project's own sanity orchestration (driver + csi-sanity), unmodified
    cd /project
    export TEMPLATE_CONFIG_FILE="/project/${TEMPLATE_CONFIG_REL}"
    export PATH="/usr/local/lib/nodejs/bin:${PATH}"
    set +e
    ci/bin/run.sh
    STATUS=$?
    set -e

    # Sentinel for the runner; chmod so the non-root runner user can read it
    echo "${STATUS}" > "/project/${CI_RESULT_REL}"
    chmod 666 "/project/${CI_RESULT_REL}"
    sync
    poweroff
```

- [ ] **Step 2: Validate the YAML parses (raw and substituted)**

Run:
```bash
python3 -c "import yaml; yaml.safe_load(open('ci/kvm/user-data'))" && echo "raw OK"
sed -e 's#\${CSI_SANITY_REL}#.ci-cache/csi-sanity#g' \
    -e 's#\${TEMPLATE_CONFIG_REL}#ci/configs/zfs-local/dataset.yaml#g' \
    -e 's#\${CI_RESULT_REL}#.ci-result#g' \
    ci/kvm/user-data | python3 -c "import yaml,sys; yaml.safe_load(sys.stdin)" && echo "substituted OK"
```
Expected: both `raw OK` and `substituted OK`. (The `${...}` tokens live inside a YAML literal block scalar, so the raw file is still valid YAML.)

- [ ] **Step 3: Commit**

```bash
git add ci/kvm/user-data
git commit -m "feat(ci): add cloud-init user-data for zfs-local KVM VM"
```

---

### Task 2: host-side VM orchestrator `run-vm.sh`

**Files:**
- Create: `ci/kvm/run-vm.sh`

**Interfaces:**
- Consumes env: `WORKSPACE` (project root, default pwd), `TEMPLATE_CONFIG_REL` (default `ci/configs/zfs-local/dataset.yaml`), `CSI_SANITY_REL` (default `.ci-cache/csi-sanity`), `CI_RESULT_REL` (default `.ci-result`), plus size/timeout overrides; optional `--dry-run` arg.
- Consumes file: `ci/kvm/user-data` (Task 1).
- Produces: exit status equal to `ci/bin/run.sh`'s exit code inside the VM (0 = sanity passed). Writes `$WORKSPACE/$CI_RESULT_REL`. In `--dry-run`, prints the qemu command + substituted user-data and exits 0 **without** KVM/tools/network.

- [ ] **Step 1: Create the orchestrator**

Create `ci/kvm/run-vm.sh`:

```bash
#!/usr/bin/env bash
# Boot an OpenZFS-enabled VM under KVM and run zfs-local csi-sanity inside it.
# Used by CI and by ci/bin/run-kvm-local.sh.
set -euo pipefail

WORKSPACE="${WORKSPACE:-$(pwd)}"
TEMPLATE_CONFIG_REL="${TEMPLATE_CONFIG_REL:-ci/configs/zfs-local/dataset.yaml}"
CSI_SANITY_REL="${CSI_SANITY_REL:-.ci-cache/csi-sanity}"
CI_RESULT_REL="${CI_RESULT_REL:-.ci-result}"
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

# --- dry-run: construct artifacts without KVM/tools/network ---
substitute
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "=== qemu command ==="; printf ' %q' "${QEMU_ARGS[@]}"; echo
  echo "=== user-data ==="; cat "$WORKDIR/user-data"
  exit 0
fi

trap cleanup EXIT

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
exit "$STATUS"
```

- [ ] **Step 2: Make executable + syntax check**

Run:
```bash
chmod +x ci/kvm/run-vm.sh
bash -n ci/kvm/run-vm.sh && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 3: Dry-run test (no KVM/tools required)**

Run:
```bash
TEMPLATE_CONFIG_REL="ci/configs/zfs-local/dataset.yaml" \
CSI_SANITY_REL=".ci-cache/csi-sanity" \
CI_RESULT_REL=".ci-result" \
ci/kvm/run-vm.sh --dry-run > /tmp/kvm-dryrun.txt
grep -q -- '-enable-kvm'                       /tmp/kvm-dryrun.txt
grep -q -- 'mount_tag=project'                 /tmp/kvm-dryrun.txt
grep -q -- 'security_model=none'               /tmp/kvm-dryrun.txt
grep -q -- 'ci/configs/zfs-local/dataset.yaml' /tmp/kvm-dryrun.txt
grep -q -- '/project/.ci-cache/csi-sanity'     /tmp/kvm-dryrun.txt
echo "dry-run assertions OK"
```
Expected: `dry-run assertions OK`. This proves substitution and qemu-command construction are correct without needing KVM.

- [ ] **Step 4: Shellcheck (if available)**

Run:
```bash
command -v shellcheck >/dev/null && shellcheck ci/kvm/run-vm.sh || echo "shellcheck not installed; skipped"
```
Expected: no errors (or the skip message).

- [ ] **Step 5: Commit**

```bash
git add ci/kvm/run-vm.sh
git commit -m "feat(ci): add KVM orchestrator for zfs-local sanity"
```

---

### Task 3: local-repro wrapper `run-kvm-local.sh`

**Files:**
- Create: `ci/bin/run-kvm-local.sh`

**Interfaces:**
- Consumes: `TEMPLATE_CONFIG_REL` env (default `ci/configs/zfs-local/dataset.yaml`), local `go`/`make`/`git` if `.ci-cache/csi-sanity` is missing.
- Produces: a built `$ROOT/.ci-cache/csi-sanity` if absent; delegates to `ci/kvm/run-vm.sh`.

- [ ] **Step 1: Create the wrapper**

Create `ci/bin/run-kvm-local.sh`:

```bash
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
```

- [ ] **Step 2: Make executable + syntax check**

Run:
```bash
chmod +x ci/bin/run-kvm-local.sh
bash -n ci/bin/run-kvm-local.sh && echo "syntax OK"
```
Expected: `syntax OK`.

- [ ] **Step 3: Shellcheck (if available)**

Run:
```bash
command -v shellcheck >/dev/null && shellcheck ci/bin/run-kvm-local.sh || echo "shellcheck not installed; skipped"
```
Expected: no errors (or skip message).

- [ ] **Step 4: Commit**

```bash
git add ci/bin/run-kvm-local.sh
git commit -m "feat(ci): add local-repro wrapper for zfs-local KVM run"
```

---

### Task 4: wire the job into the workflow

**Files:**
- Modify: `.github/workflows/main.yml`

**Interfaces:**
- Consumes: `node-modules-linux-amd64` artifact (from `build-npm-linux-amd64`); `ci/kvm/run-vm.sh`, `ci/kvm/user-data`.
- Produces: a new `csi-sanity-zfs-local-kvm` job (matrix: zvol + dataset) that downstream Docker jobs depend on instead of the removed `csi-sanity-zfs-local`.

- [ ] **Step 1: Add `workflow_dispatch` to the `on:` block**

So this infra can be exercised on a branch without merging to `master`. In the `on:` section, add `workflow_dispatch:` after the `branches:` list. The block becomes:

```yaml
on:
  push:
    tags:
      - "v*"
    branches:
      - master
      - next
  workflow_dispatch:
```

- [ ] **Step 2: Remove the old self-hosted `csi-sanity-zfs-local` job**

Delete the entire `csi-sanity-zfs-local:` job block (the one with `runs-on: [self-hosted, Linux, X64, csi-sanity-zfs-local]` and matrix `zfs-local/zvol.yaml` + `zfs-local/dataset.yaml`).

- [ ] **Step 3: Add the new KVM job**

Insert this job (place it where the old zfs-local job was, after `csi-sanity-client-windows`):

```yaml
  # zfs-local drivers (GitHub-hosted + nested KVM; no self-hosted runner needed)
  csi-sanity-zfs-local-kvm:
    needs:
      - build-npm-linux-amd64
    strategy:
      fail-fast: false
      matrix:
        config:
          - zfs-local/zvol.yaml
          - zfs-local/dataset.yaml
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: node-modules-linux-amd64
      - name: extract node_modules
        run: tar -zxf node_modules-linux-amd64.tar.gz
      - uses: actions/setup-go@v5
        with:
          go-version: '1.24.1'
      - name: build csi-sanity
        run: |
          mkdir -p .ci-cache
          if [[ ! -x .ci-cache/csi-sanity ]]; then
            git clone --depth 1 --branch v5.5.0 https://github.com/kubernetes-csi/csi-test /tmp/csi-test
            ( cd /tmp/csi-test/cmd/csi-sanity && make csi-sanity )
            install -m 0755 /tmp/csi-test/cmd/csi-sanity/csi-sanity .ci-cache/csi-sanity
          fi
      - name: enable kvm + install qemu
        run: |
          echo 'KERNEL=="kvm", GROUP="kvm", MODE="0666"' | sudo tee /etc/udev/rules.d/99-kvm4all.rules
          sudo udevadm control --reload-rules
          sudo udevadm trigger --name-match=kvm
          sudo apt-get update
          sudo apt-get install -y qemu-system-x86 qemu-utils cloud-image-utils wget
          test -e /dev/kvm || { echo "KVM unavailable on this runner"; exit 1; }
      - name: csi-sanity (KVM)
        run: |
          chmod +x ci/kvm/run-vm.sh
          WORKSPACE="$GITHUB_WORKSPACE" \
          TEMPLATE_CONFIG_REL="ci/configs/${{ matrix.config }}" \
          CSI_SANITY_REL=".ci-cache/csi-sanity" \
          CI_RESULT_REL=".ci-result" \
          ci/kvm/run-vm.sh
```

- [ ] **Step 4: Update Docker jobs' `needs:` to reference the new job**

In **both** `build-docker-linux:` and `build-docker-windows:`, change the list entry `- csi-sanity-zfs-local` to `- csi-sanity-zfs-local-kvm`. Leave all other `needs:` entries unchanged.

- [ ] **Step 5: Validate the workflow YAML parses and the job is well-formed**

Run:
```bash
python3 - <<'PY'
import yaml
d = yaml.safe_load(open('.github/workflows/main.yml'))
jobs = d['jobs']
assert 'csi-sanity-zfs-local-kvm' in jobs, "new job missing"
assert 'csi-sanity-zfs-local' not in jobs, "old job not removed"
assert jobs['csi-sanity-zfs-local-kvm']['runs-on'] == 'ubuntu-latest'
for dj in ('build-docker-linux', 'build-docker-windows'):
    assert 'csi-sanity-zfs-local-kvm' in jobs[dj]['needs'], f"{dj} needs not updated"
    assert 'csi-sanity-zfs-local' not in jobs[dj]['needs'], f"{dj} still references old job"
# PyYAML parses the `on:` key as boolean True (older) or 'on' (newer); handle both
on_key = True if True in d else 'on'
assert 'workflow_dispatch' in d[on_key], "workflow_dispatch missing"
print("workflow OK")
PY
```
Expected: `workflow OK`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/main.yml
git commit -m "feat(ci): run zfs-local sanity on GitHub-hosted KVM"
```

---

### Task 5: end-to-end verification on CI

**Files:** none (verification only).

**Interfaces:**
- Consumes: the branch from Tasks 1–4 pushed to the fork; `workflow_dispatch`.

- [ ] **Step 1: Push the branch and run the workflow manually**

```bash
git push -u origin feat/zfs-local-kvm-ci
gh workflow run CI --ref feat/zfs-local-kvm-ci
sleep 5
gh run list --workflow=CI --branch feat/zfs-local-kvm-ci --limit 1
```

- [ ] **Step 2: Watch the `csi-sanity-zfs-local-kvm (dataset)` job log**

```bash
RUN_ID=$(gh run list --workflow=CI --branch feat/zfs-local-kvm-ci --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RUN_ID" --exit-status || true
JID=$(gh run view "$RUN_ID" --json jobs --jq '.jobs[] | select(.name | contains("dataset")) | .databaseId')
gh run view --job="$JID" --log | grep -E "zpool status|csi-sanity OK|csi-sanity exit status|PASS|FAIL|ERROR" | tail -40
```
Expected: log shows `=== zpool status ===` with a healthy `tank`, then `csi-sanity OK`, and finally `csi-sanity exit status: 0`. The job is green.

- [ ] **Step 3: If it fails, debug from the serial console (do not guess)**

The VM's full serial console streams into the job log (`-serial mon:stdio`). Read it with `gh run view --job="$JID" --log`. Common failure modes and their meanings:
- No `/dev/kvm` → runner not x86_64 or udev rule didn't apply (check the "enable kvm" step).
- `zpool status` absent / `modprobe zfs` failed → OpenZFS module issue on the image (check `apt-get install zfsutils-linux` output; consider `linux-modules-extra`).
- `csi-sanity OK` absent → `csi-sanity` not found in the share (check `install -m 0755 /project/.ci-cache/csi-sanity`).
- Sentinel missing → boot/provision failed before the test; read the full console.
Fix the offending task, push, re-run via `gh run rerun --job="$JID"` (or re-dispatch). Repeat until green.

- [ ] **Step 4: Confirm parity vs. the old self-hosted job**

Compare the pass/skip set of `csi-sanity` for `dataset` (and `zvol`) against historical self-hosted `csi-sanity-zfs-local` results. Any new failures must be explained by an environment difference (e.g., loopback zpool vs. real disks), not a regression.

- [ ] **Step 5: Open the PR**

```bash
gh pr create --base master --head feat/zfs-local-kvm-ci \
  --title "feat(ci): zfs-local sanity on GitHub-hosted KVM" \
  --body "Replaces the self-hosted csi-sanity-zfs-local job with an ubuntu-latest + nested-KVM job ... (reference the design doc)"
```

---

## Notes / known trade-offs

- **9p performance:** reading `node_modules` over 9p is functional but slower than native. `virtiofs` (`virtiofsd`) is the documented optimization if it shows up in timings; not needed for the MVP.
- **Per-run cost:** ~5–8 min/job (image download + apt + zpool create + sanity); two matrix entries run in parallel. Image download is the biggest chunk and could be cached (future work).
- **`csi-sanity` rebuild each run:** `actions/setup-go` caches Go modules, so subsequent builds are fast. Binary caching (`.ci-cache` via `actions/cache`) is a future optimization.
- **`workflow_dispatch`** is added permanently — useful for manually re-running CI and for testing CI infra changes on a branch.
