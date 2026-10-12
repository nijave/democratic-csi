# zfs.cloneDatasetProperties Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `zfs.cloneDatasetProperties` (copy + set) so volumes created from a snapshot/volume content source can inherit chosen ZFS user properties from the source snapshot and/or get fixed properties, without breaking the default path.

**Architecture:** Validate/merge the new option in `CsiBaseDriver.getMergedDriverOptions` (src/driver/index.js) alongside `zfs.datasetProperties`; to give copies/`set` a precedence slot *between* driver-level datasetProperties and overlay datasetProperties, datasetProperties overlays are now tracked in a separate `zfs.datasetPropertiesOverlay` object instead of being merged into `zfs.datasetProperties`. `controller-zfs` CreateVolume renders driver-level props → copies from the source snapshot (pure helper) → renders `set` → applies overlay props → driver-generated props still win (validated user-props-only overlays can never collide with them).

**Tech Stack:** Node 22, node:test, lodash, handlebars, zetabyte (`zb.zfs.get` returns `{ [dataset]: { [prop]: { value, received, source } } }` via `parsePropertyList`).

**Spec:** Task brief (this conversation): `zfs.cloneDatasetProperties` for content-source volumes — copy user properties from the source snapshot, set fixed user properties, full precedence chain, overlay-capable, docs + FORK.md row 20.

## Global Constraints

- Do NOT commit, push, or switch branches (brief).
- Default (option absent) must be byte-for-byte current behaviour; no extra `zfs get` when unset (and none when only `set` is configured).
- Only user properties (name contains `:`) copyable/settable; never `democratic-csi:*` — even when a pattern like `*` would match.
- `npm test` and `npm run lint` (0 errors, no new warnings) must pass.
- Don't touch other drivers' logic (freenas/api.js has its own CreateVolume reading `driver.options.zfs.datasetProperties` directly — unaffected), no package.json changes.

## Review Focus

- A source snapshot inheriting from ancestors must NOT double-copy values the clone already inherits (copy filter source check: `local`/`received`/`inherited from <snapshot's own dataset>` only) — pinned in copy-filter tests.
- `*` copy pattern must never leak `democratic-csi:*` reserved props — pinned in copy-filter test.
- Overlay values must beat copied values; copied values must beat driver-level values — pinned in precedence test.
- Malformed overlay shapes must return INVALID_ARGUMENT, not silently ignored — pinned in merge tests.
- Existing PR #58 overlay tests asserting `merged.zfs.datasetProperties` contains overlay entries must be updated to the new provenance split (documented breaking change of the internal merge shape; runtime behaviour for users unchanged).

## File Structure

- Modify `src/driver/index.js` — extract `validateOverlayDatasetPropertyName(name, {allowPattern})` out of `validateOverlayDatasetProperty`; extend `getMergedDriverOptions` (`zfs.datasetProperties` case → `zfs.datasetPropertiesOverlay`; new `zfs.cloneDatasetProperties` case).
- Modify `src/driver/controller-zfs/index.js` — CreateVolume rendering/merge order; new exported helpers `selectCopiedDatasetProperties` (pure) and `buildCloneDatasetProperties` (zb + handlebars).
- Modify `test/driver/merged-driver-options-dataset-properties.test.js` (update overlay assertions to provenance split), add `test/driver/merged-driver-options-clone-dataset-properties.test.js`, extend `test/driver/controller-zfs.test.js` (copy filter, buildCloneDatasetProperties, thin CreateVolume integration with stubbed zb).
- Modify `examples/zfs-generic-iscsi.yaml`, `examples/zfs-generic-nvmeof.yaml` (commented example), `FORK.md` (row 20).

---

### Task 1: Validation helpers (src/driver/index.js) — TDD

- [x] Failing tests in a new test file for `validateOverlayDatasetPropertyName` exact/pattern/reserved rules (via getMergedDriverOptions since methods are on the class; direct method access is fine too)
- [x] Extract `validateOverlayDatasetPropertyName(name, { allowPattern = false } = {})`: string, exact → must contain `:`, `democratic-csi:` reserved (same messages as today); pattern (`allowPattern`): `*` allowed, `prefix*` allowed, prefix starting `democratic-csi` reserved; non-pattern call rejects `*`-suffixed names (no colon)
- [x] `validateOverlayDatasetProperty` delegates name check, keeps value checks (string/number/boolean → String)
- [x] Run tests

### Task 2: getMergedDriverOptions provenance split + cloneDatasetProperties merge — TDD

- [x] Update existing PR #58 tests to expect `zfs.datasetPropertiesOverlay` for overlay entries; driver-level stays in `zfs.datasetProperties`
- [x] New tests: cloneDatasetProperties driver-level normalization, overlay union (copy, deduped), overlay set merge order, bad shapes → INVALID_ARGUMENT, `democratic-csi:*` rejected in copy and set, unknown keys rejected
- [x] Implement: `zfs.datasetProperties` case merges overlays into `driverOptions.zfs.datasetPropertiesOverlay` (validated); new `zfs.cloneDatasetProperties` case normalizes driver-level then merges overlays (copy: union preserving order, dedupe; set: later overrides; validate all entries; unknown top-level keys rejected)
- [x] Run tests

### Task 3: Copy filter + build helper (controller-zfs) — TDD

- [x] Tests for `selectCopiedDatasetProperties(entries, patterns, fullSnapshotName)`: exact name, prefix `homelab:*`, lone `*`, skip `democratic-csi:*`, skip `source: inherited from <other dataset>`, skip `source: default`/value `-`, copy `local`/`received`/`inherited from <own dataset>`, later pattern overrides earlier
- [x] Tests for `buildCloneDatasetProperties(zb, fullSnapshotName, cloneDatasetProperties, {parameters})`: no `zb.zfs.get` when `copy` empty/absent; get called with `["all"]` when copy present; copied values literal; `set` values handlebars-rendered with `{parameters}`; set overrides copied on name collision
- [x] Implement both module-level functions, export them
- [x] Run tests

### Task 4: CreateVolume integration — TDD

- [x] Thin integration test: `ControllerZfsBaseDriver` subclass with stubbed zb (snapshot content source containing `@` so no snapshot creation needed), assert `zb.zfs.clone` receives merged properties in precedence order (driver-level < copied < set < overlay), driver-generated `democratic-csi:*` keys intact; and with no content source assert no extra `zfs get` beyond the volsize/refquota check
- [x] Implement in CreateVolume:
  - render `driverOptions.zfs.datasetPropertiesOverlay` → `overlayProperties` (handlebars, deferred)
  - per content-source branch, after fullSnapshotName is established/created: `cloneProps = await buildCloneDatasetProperties(...)`, `cloneVolumeProperties = Object.assign({}, volumeProperties, cloneProps, overlayProperties)`
  - detached path: `zb.zfs.set(datasetName, cloneVolumeProperties)`; clone path: delete the 4 acl keys from `cloneVolumeProperties` (fresh object — fixes the alias mutation without changing behaviour) and clone with it
  - no-content-source path: `Object.assign(volumeProperties, overlayProperties)` before `zb.zfs.create`
- [x] Run full `npm test`

### Task 5: Docs

- [x] Commented `cloneDatasetProperties` example next to `#datasetProperties:` in `examples/zfs-generic-iscsi.yaml` + `examples/zfs-generic-nvmeof.yaml`
- [x] FORK.md row 20 (branch `feat/clone-dataset-properties`, PR `—`)

### Task 6: Gates

- [x] `npm test` — full pass
- [x] `npm run lint` — 0 errors, no new warnings