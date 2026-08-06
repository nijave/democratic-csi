# zfs-local CSI sanity on GitHub-hosted KVM — Design

- **Date:** 2026-08-04
- **Status:** Design approved; implementation plan pending
- **Related:** PR #20 (`fix/ci-skip-matrix-on-forks`) gates the self-hosted sanity matrix to upstream on forks.

## Problem

The `csi-sanity-zfs-local` job needs a self-hosted runner with OpenZFS and a
`tank` zpool. Forks and contributor PRs have no such runner, so the job either
queues indefinitely (the original CI timeout problem) or must be gated off, which
means `zfs-local` (zvol + dataset) gets **zero coverage** outside the maintainer's
own infrastructure.

## Goal

Run the `zfs-local` csi-sanity tests (zvol + dataset) on GitHub-hosted
`ubuntu-latest` runners using **nested KVM**, with:

- no self-hosted runner,
- no external storage appliance,
- no secrets,
- the project's existing `ci/bin/run.sh` orchestration running **unmodified**.

Replace the self-hosted `csi-sanity-zfs-local` job with the new KVM job. It runs
on fork and upstream (no `github.repository` gate), so external contributor PRs
get real ZFS tests.

## Non-goals (this iteration)

- **zfs-generic drivers** (iscsi-targetcli, iscsi-pcs, nfs, smb, nvmeof) — these
  need a separate storage-server role and host↔VM networking (iSCSI/NFS/SMB).
  Future iteration; the appliance-free topology here is the foundation.
- **Synology / TrueNAS / ObjectiveFS** tests — appliance-bound, out of scope.
- **Prebuilt/cached VM images** (Approach B below) — documented as a future
  optimization if per-run boot time becomes a problem.

## Background and constraints

- **KVM on GitHub-hosted Linux runners:** x86_64 standard runners (incl. the
  2-vCPU tier) expose hardware-accelerated KVM since the 2024-04-02 changelog.
  The runner user must be given access to `/dev/kvm` via a udev rule. ARM Linux
  runners do **not** expose KVM.
- **zfs-local driver semantics:** the driver invokes the local `zfs` CLI, so the
  driver, the zpool, and `csi-sanity` must all run on the **same host** — the VM.
  Nothing ZFS-related can run on the runner itself.
- **Existing artifacts reused:**
  - `bin/democratic-csi` (Node shim) ships in the repo.
  - `build-npm-linux-amd64` already builds and uploads a `node_modules` tarball.
  - `ci/bin/run.sh` already orchestrates `launch-server.sh` (the driver) +
    `launch-csi-sanity.sh`.
- **Vagrantfile is not reusable as-is:** it provisions only the CSI client/node
  side (open-iscsi initiator, multipath, `csi-sanity` built from source). It does
  **not** install OpenZFS or create a zpool, so a new server-side provisioning is
  required. It is a useful reference for the client package set and for how the
  project builds `csi-sanity`.

## Approach chosen: A — cloud-init, build-in-runner

The runner downloads a stock Ubuntu cloud image, attaches a cloud-init NoCloud
seed that provisions OpenZFS + a `tank` zpool + Node + `csi-sanity`, boots it
under QEMU/KVM, runs the project's own `ci/bin/run.sh` inside the VM, and reads
back an exit-code sentinel.

Chosen for: zero external artifacts, full reproducibility, no image/storage
pipeline, and Ubuntu's **prebuilt** OpenZFS kernel module (no fragile DKMS).

### Alternatives considered

- **B. Prebuilt cached image** — a separate workflow bakes a qcow2 (zfs + node +
  csi-sanity) and publishes it as a release asset / Actions cache; test jobs just
  boot it. Faster boots (~1–2 min) but needs a build pipeline, multi-hundred-MB
  storage, and version invalidation. Overkill for the MVP; revisit if boot time
  matters.
- **C. Vagrant + libvirt** — extend the existing `Vagrantfile` and run
  `vagrant up --provider=libvirt`. Reuses local tooling but installs
  Vagrant (BSL-licensed) + libvirt + the vagrant-libvirt plugin on the runner and
  requires changing the provider from VirtualBox/qemu. More moving parts than raw
  QEMU for no CI benefit.

## Architecture

```
┌─────────────── ubuntu-latest runner (x86_64, KVM) ───────────────┐
│                                                                   │
│  checkout + node_modules artifact ──┐                             │
│                                      │  9p share (mount_tag=project)│
│                                      ▼                             │
│  ┌─────────────── QEMU/KVM VM (Ubuntu 24.04 cloud image) ──────┐ │
│  │  cloud-init provisions:                                      │ │
│  │    • zfsutils-linux  →  modprobe zfs                         │ │
│  │    • loopback file  →  zpool create tank                     │ │
│  │    • Node 22  +  csi-sanity                                  │ │
│  │  then runs (inside VM, against local `tank`):                │ │
│  │    ci/bin/run.sh  →  launch-server.sh (driver, zfs-local)    │ │
│  │                    →  launch-csi-sanity.sh (csi-sanity)      │ │
│  │  writes exit code → /project/.ci-result  →  poweroff         │ │
│  └──────────────────────────────────────────────────────────────┘ │
│  runner reads .ci-result → job pass/fail                          │
└───────────────────────────────────────────────────────────────────┘
```

The zpool never touches the runner; only the result code crosses the boundary.

## New job: `csi-sanity-zfs-local-kvm`

- `runs-on: ubuntu-latest`
- `needs: [build-npm-linux-amd64]`
- matrix over `zfs-local/zvol.yaml` and `zfs-local/dataset.yaml` (run in parallel)
- **no** `if: github.repository` gate — runs everywhere
- **no** `max-parallel` (two configs on two GitHub-hosted runners)

Steps:

1. `actions/checkout@v4`
2. `actions/download-artifact@v4` → `node-modules-linux-amd64`
3. **Enable KVM + install QEMU.** Apply the documented udev rule so the runner
   user can use `/dev/kvm`; install `qemu-system-x86`, `qemu-utils`,
   `cloud-image-utils`. **Assert `/dev/kvm` exists** and fail fast with a clear
   message if not (runner became ARM, or KVM policy changed).
4. **Fetch base image.** Download the pinned Ubuntu 24.04 server cloud qcow2,
   verify its SHA256, create a writable qcow2 overlay, resize +15 GB for the
   loopback zpool and scratch space.
5. **Build cloud-init seed.** Generate `user-data` / `meta-data` and pack a
   NoCloud ISO (see next section).
6. **Boot.**
   ```
   timeout 1200 qemu-system-x86_64 \
     -enable-kvm -cpu host -m 3072 -smp 2 \
     -drive file=overlay.qcow2,if=virtio,format=qcow2 \
     -drive file=seed.iso,if=virtio,format=raw \
     -fsdev local,id=fsdev0,path="$GITHUB_WORKSPACE",security_model=none \
     -device virtio-9p-pci,fsdev=fsdev0,mount_tag=project \
     -nographic -serial mon:stdio
   ```
   The VM powers itself off when finished.
7. **Read result.** `cat .ci-result`: `0` → pass; missing or non-zero → fail.

## cloud-init `user-data` (the VM's job)

- `packages:` `zfsutils-linux`, `e2fsprogs`, `xfsprogs` (zfs-local needs no
  iSCSI/NFS client packages; expand only if csi-sanity node tests require more).
- `runcmd:` (run as root)
  1. `modprobe zfs`; create an 8 GB sparse `/tank.img`; `zpool create tank /tank.img`;
     log `zpool status` and `zfs version` (implicit KVM+ZFS smoke check in every
     run log).
  2. Install Node 22 (NodeSource) onto `PATH` (the driver shim is
     `#!/usr/bin/env node`).
  3. Install `csi-sanity` — prefer a pinned release binary to
     `/usr/local/bin`; fall back to building from `kubernetes-csi/csi-test`
     source exactly as the existing `Vagrantfile` does.
  4. `mount -t 9p -o trans=virtio,version=9p2000.L project /project`.
  5. Run the test **inside `/project`** with the project's own scripts: set
     `TEMPLATE_CONFIG_FILE=./ci/configs/zfs-local/<config>.yaml`, a fresh
     `CI_BUILD_KEY`, and `PATH`; invoke `ci/bin/run.sh`. A shell `trap` writes
     `$?` to `/project/.ci-result` unconditionally (success or failure).
  6. `poweroff`.

## Data flow

1. Runner extracts the `node_modules` tarball into `$GITHUB_WORKSPACE`.
2. `$GITHUB_WORKSPACE` is shared into the VM via 9p (`mount_tag=project`).
3. VM creates the local `tank` zpool.
4. `run.sh` starts the `zfs-local` driver (`launch-server.sh`), which creates
   `tank/ci/<key>/v` datasets/zvols; then runs `csi-sanity`
   (`launch-csi-sanity.sh`), which mounts/unmounts locally.
5. The exit code is written to `/project/.ci-result` on the 9p share.
6. After `poweroff`, the runner reads `.ci-result` and the step passes/fails.

## Error handling and reliability

- **KVM availability check:** assert `/dev/kvm` before booting; fail with a clear
  message instead of a mystery hang.
- **Boot/test timeout:** `timeout 1200 qemu …`; if the VM never powers off the
  job fails as "VM timed out" rather than hanging to the 6-hour job limit.
- **Sentinel contract:** no `.ci-result` after QEMU exits ⇒ boot/provision failed
  (distinct from a real test failure, so the two are diagnosable separately).
- **Live serial console:** `-serial mon:stdio` streams the VM console to the job
  log in real time; failures are debuggable without re-running locally.
- **Pinning for reproducibility:** pin the cloud image URL + SHA256, Node 22, and
  a `csi-sanity` version so upstream bumps cannot silently break CI.
- **9p performance:** running over 9p is functional but slower for the many-file
  `node_modules`. If it shows up in timings, switch to **virtiofs** via
  `virtiofsd` (documented optimization; not needed for the MVP).

## Testing and local reproducibility

- Every run logs `zpool status` / `zfs version` before the real test — a built-in
  smoke check that KVM + ZFS work, visible in each job log.
- Add `ci/bin/run-kvm-local.sh` that performs the same QEMU boot, so contributors
  can reproduce the CI VM locally (mirrors the existing `ci/bin/run.sh` pattern).
- **Verification plan for the first run on the fork:**
  1. KVM enables and `/dev/kvm` is accessible.
  2. `tank` zpool is created inside the VM.
  3. The `zfs-local` driver starts against it.
  4. `csi-sanity` executes and emits a result.
  5. Compare the pass/skip set against historical self-hosted `zfs-local` runs to
     confirm parity.

## Workflow integration

- **Remove** the existing `csi-sanity-zfs-local` (self-hosted) job.
- **Add** `csi-sanity-zfs-local-kvm` (above), ungated.
- **Update** the `needs:` lists of `build-docker-linux` and `build-docker-windows`
  to reference the new job name.
- The other self-hosted sanity jobs and the upstream gate from PR #20 are
  unaffected.

## Risks and open items

- **GitHub could change runner KVM policy or arch.** Mitigated by the explicit
  `/dev/kvm` assertion and the live console.
- **Cloud image / OpenZFS version drift.** Mitigated by URL + SHA256 pinning.
- **`csi-sanity` release binaries:** confirm availability in
  `kubernetes-csi/csi-test` releases; the build-from-source fallback already
  exists in the `Vagrantfile`.
- **9p performance over `node_modules`:** acceptable for the MVP; virtiofs is the
  documented escape hatch.
- **End-to-end time:** estimated ~5–8 min/job (boot + apt + zpool + sanity), well
  within the 6-hour limit; two matrix entries run in parallel.
