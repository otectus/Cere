# Cere next-stage plan: reconciliation with PyPersona source, deferred items and stabilization

Reviewed 15 October 2026 (EDT). This is a planning document. Producing it changed no application code, no existing document, no service and no installation. It follows `prompts/Cere-PyPersona-Enhancement-Plan.md` ("the original plan") and is written so that an implementation worker needs nothing else to carry it out. Inventory row IDs (P01–P39, C01–C30, X01–X15, H01–H37, U01–U44), proposal IDs (Q, M and A series), retained foundations (E01–E06) and rejections (R01–R12) refer to the original plan. The original plan stays the authoritative inventory except where §7 corrects it.

## 0. Summary

- **PyPersona has not drifted.** The local checkout is exactly the pinned commit `918a1ab`, its working tree is clean, and the remote `main` is the same commit. The original plan's PyPersona evidence applies unchanged (§2.1).
- **The "uncommitted, not installed" premise is out of date.** The Slices 0–5 work is still uncommitted, but it has been installed and running since 21:28 EDT today. The live memory store was migrated to schema 5 at 21:28:53, and no backup was taken first. The committed `HEAD` refuses to open a store that has a migration it does not know, so losing the working tree would leave the live memory store unreadable by any committed version (§2.3). Preserving the work in commits, with owner authorization, comes first.
- **One privacy defect blocks enabling the notes vault.** M07 treats a note as public when its front matter uses CRLF line endings, starts with a byte-order mark, has a trailing space on the opening fence, or says `private: yes` or `private: "true"`. That contradicts the agreed rule that unknown privacy fails closed (RC-01, §3). The vault is disabled on this machine, so nothing is exposed today.
- **Reconciliation against real source found twelve more fidelity gaps.** Four are worth fixing next:
  - Postures that withhold memory do not stop automatic recall (RC-02).
  - Output-section checks raise false "missing" alarms (RC-03).
  - Completion gates accept checks that predate later edits (RC-04).
  - The no-progress notice misses repeated failures (RC-05).

  The rest are small or optional (§4).
- **Live usage argues against speculative features.**
  - Of 148 sessions, 112 are Codex or Claude CLI sessions. Ollama conversations hand code work to them; delegation is the most frequent recorded action.
  - There are no saved scripts, saved recipes, styles, capsules, collections or schedules.
  - Speech and the responsiveness spans are off, so M16 has recorded nothing.
  - Memory extraction runs on an unevaluated cloud model, and every live assertion it produced is still a candidate (§2.5).
- **What not to build:** A03 and M11 (§5), M10's speech-recognition interface, and all of Slice 6.
- **What to defer:** A05 task binding, with its design ready (§6.3).
- **What to run, with owner authorization:** the extractor evaluation, re-scoped to the model actually configured (EV-01, §6.2).
- **What to add before the next memory migration:** a verified pre-migration memory backup, the one PyPersona mechanism the evidence now clearly supports (NF-01).

## 1. Scope, snapshots and evidence

### 1.1 Snapshots

| Repository | Snapshot | How it was verified |
| --- | --- | --- |
| Cere | Branch `ui-overhaul` at `0837f91870e401ce007f6d0fff7e92b9fc4cf37b` (same commit as `main`), plus the uncommitted working tree as of 21:25 EDT | `git status`, `git diff --shortstat`. `find … -newer T:final/ui-check-full-2.log` shows that only `VALIDATION.md` changed after the last validation run, so the recorded results describe this tree. |
| PyPersona | `/home/otectus/Projects/PyPersona`, `main` at `918a1abddd291fd2bc67439592a204318dc5de87` ("Prepare repository for public release", 2026-08-18) | See §2.1 |
| Live installation | `~/.local/share/cere`, `~/.local/lib/cere/cere`, `~/.local/state/cere` | Read-only checks only (Appendix A.1) |

### 1.2 Notation

- `C:` is a path in the Cere repository (`/home/otectus/Projects/cere`).
- `P:` is a path in the PyPersona repository (`/home/otectus/Projects/PyPersona`). `p/` expands to `src/pypersona/`.
- `L:` is a live machine path; `~` is `/home/otectus`.
- `T:` is the prior session's tracker directory, `~/.cache/cere-pypersona/`.
- Line numbers refer to the snapshots above. **New** marks a proposed file that does not exist yet.
- PyPersona "defaults" are the shipped `P:p/data/config/config.json` values. Several code fallbacks differ from them (IC-06).
- Statements about PyPersona come from source read in this review unless marked *inventory only*.

### 1.3 What this review ran, and what it did not

It ran only read-only commands; the full list is in Appendix A:

- git inspection of both repositories, plus a read-only `git ls-remote` for PyPersona;
- `diff -rq` between the working tree and the installed copy;
- `systemctl` and `journalctl` status reads;
- aggregate `sqlite3 -readonly` count queries against the live state and memory databases (counts only, no content);
- three small Node probes that import working-tree modules and call pure functions (Appendix A.3).

The probes were scratch files under `/tmp/cere-nextstage-probe/`. They were deleted after use and their code is reproduced in Appendix A.3.

It did not run builds, test suites, UI checks or benchmarks, and made no model calls. Test results quoted below come from the prior session's logs under `T:`.

The established practice for this machine is to measure the memory store on a `VACUUM INTO` copy, not the live file. This review's live queries were read-only aggregate counts. Every measurement step in this plan uses a copy.

## 2. Verified state

### 2.1 PyPersona checkout and drift

- **Local state:** `git rev-parse HEAD` is `918a1ab…`. `git status` reports "up to date with 'origin/main'" and "nothing to commit, working tree clean". `git status --ignored --short` prints nothing, so there are no untracked or ignored files.
- **Remote state:** `git ls-remote origin` shows `refs/heads/main` at `918a1ab…`.
  - `refs/pull/1/head` is `3d787a2`, an ancestor of `main` and already merged.
  - `refs/pull/2/head` is `6b6724b`, a Dependabot branch. `git show --stat` shows it changes only `.github/workflows/tests.yml` (9 insertions, 9 deletions).
- **Size:**
  - 1,568 Python files under `src/` and 562 under `tests/` (536 `test_*.py` modules), plus 14 elsewhere.
  - 4,548 commits.
  - `pyproject.toml`: version 1.2.0, `python = ">=3.10,<3.14"`, 103 dependency entries including Python.
  - These match the original plan's figures.
- **Drift: none.** Nothing that affects source has changed. Every PyPersona path the original plan cites resolves to the same content.

### 2.2 Cere working tree and recorded validation

The uncommitted work consists of:

- 23 new broker modules, including `broker/graph-memory/timeline.ts`;
- 11 new QML files;
- 28 new test files and fixtures, and 2 new benchmarks;
- 71 modified tracked files (+3,552/−283 excluding `artwork/`), of which code under `broker/ qml/ native/ tests/ benchmarks/` is 62 files (+3,426/−281);
- 200 `artwork/` deletions, which are the owner's own in-flight change.

The owner's other in-flight work is also present: the screenshot target in `CMakeLists.txt`, screenshot embeds in `README.md`, the screenshot section of `VALIDATION.md`, `docs/{tts,workspace-telemetry}.md`, `docs/mobile/SETUP.md`, `docs/memory/operations.md`, `screenshots/`, `tools/screenshots/` and `prompts/` (`T:PROGRESS.md:8-10`).

The last recorded validation (`T:final/`, finished 21:25 EDT):

| Check | Result | Log |
| --- | --- | --- |
| `npm run typecheck`, `git diff --check` | Passed | `T:final/typecheck.log`, `T:final/diff-check.log` |
| `CERE_TTS_DISABLED=1 npm test` | 671 tests: 669 passed, 1 skipped, 1 failed. The failure is `tests/avatar-surface-motion.test.ts`, which reads `artwork/avatars/cere/registration.json` (ENOENT) and also failed at baseline. | `T:final/npm-test.log` |
| `cmake --build build --parallel 8` | Passed | `T:final/native-build.log`, `T:final/ui-build.log` |
| `ctest --test-dir build --output-on-failure` | 3 of 4 passed. The GPU `avatar` check fails "wider cards must preserve silhouette and ground", and the untouched baseline tree fails it identically. | `T:final/ctest.log` |
| Offscreen `cere-ui-check` (full run) | 82 passed, 1 failed, 9 skipped, 861 s. The failure is `reviewTransitions`, as at baseline. | `T:final/ui-check-full-2.log` |
| A01 request equivalence | Request payloads are byte-identical to `HEAD`. | `T:slice4/golden-head-today.json` vs `T:slice4/golden-final.json`, made by `T:scripts/golden-ollama.ts` (not in the repository) |

### 2.3 Correction: the uncommitted work is installed and live

`VALIDATION.md:23` ("Nothing was installed, and the running broker and interface were not restarted") and the prior session's report no longer describe this machine:

- `diff -rq C:broker L:~/.local/share/cere/broker` reports no differences. `diff -rq C:qml L:~/.local/share/cere/qml` differs only by one stale extra file in the installation, `OllamaSessionDialog.qml`.
- `journalctl --user -u cere-broker.service`:
  - "Stopping Cere session broker…" at 21:28:21;
  - "Stopped" (the service had run for 2 h 4 min);
  - "Started Cere session broker" at 21:28:52.
- The running broker, PID 73934, started at 21:28:52 from `L:~/.local/share/cere/broker/main.ts`. The interface, PIDs 74178 and 74203, started at 21:29:09 and 21:29:11 from `L:~/.local/lib/cere/cere`, whose mtime is 21:28:21.
- **Memory schema 5 is applied live.** `L:~/.local/state/cere/graph-memory/memory.sqlite` → `schema_migrations` has row 5, `retention_pins`, applied at µs 1792114133024000, which is 21:28:53 EDT.
  - All five recorded checksums equal the working tree's: base `f81269ed…`, 2 `22e189a9…`, 3 `8d7400e8…`, 4 `2e488843…`, 5 `fa3a04d5ee812bac2a80d207c533710444649077807a1c54df46117035b1ecf5` (Appendix A.3, probe 3).
- **There is no pre-migration backup.** `L:~/.local/state/cere/memory-backups/` holds only `before-compaction-2026-10-13.sqlite` and its manifest.
- **Rollback hazard.** `Canonical.migrate` verifies every applied migration against the IDs and checksums the code knows. It fails with `INCOMPATIBLE_SCHEMA` "Unknown or modified memory migration" on any mismatch (`C:broker/graph-memory/canonical.ts:186-196`). `HEAD` knows migrations 1–4 (`git show HEAD:broker/graph-memory/schema.ts`). So:
  - reinstalling `HEAD` would leave memory unable to open;
  - any edit to migration 5's SQL text would do the same with the current tree.

  The state store is safer: `HEAD`'s `Store.settings()` spreads saved settings over its defaults, so unknown keys pass through (`git show HEAD:broker/store.ts`, lines 99–103).

### 2.4 Known environment at review time

These are not regressions; validation must be planned around them (§9):

- **`cere-memory.service` is failed.** It failed at 21:28:41 and again at 21:29:32 with "Qdrant did not become ready on loopback port 6333", reaching a 13–16 GB memory peak. Neo4j started; Qdrant did not. Memory therefore runs with its projections down, and canonical (lexical, anchor and overlay) recall still works. Health may report memory as degraded.
- **`ananicy-cpp` renices every `node` process to 16.** Priority tests compare against the parent's nice value.
- **The GPU `avatar` ctest fails** in this environment.
- **`tests/avatar-surface-motion.test.ts` fails** until the owner decides about `artwork/`.
- **The UI slot `reviewTransitions` fails**, as it did at baseline.

### 2.5 How the owner actually uses Cere (aggregate, read-only)

| Evidence | Value | Source |
| --- | --- | --- |
| Sessions by provider (29 Sep–15 Oct) | 148 total:<br>- Codex 68, of which 16 are delegated children<br>- Claude 44, of which 19 are delegated children<br>- Ollama 28<br>- Anthropic API 5<br>- Google API 2<br>- AntiGravity 1 | `L:cere.sqlite` `sessions` (`provider`, `parentId`) |
| Who delegates | All 35 children have a live parent:<br>- Ollama conversations started 32 (16 Codex, 16 Claude)<br>- Anthropic API conversations started 3 (Claude) | `sessions` joined on `parentId` |
| Recorded actions (all 103 `activity` rows, 28 Sep–15 Oct) | `sessions.start` 35, `sessions.send` 23, `media.control` 15, `audio.volume` 14, `windows.focus` 5, `screenshot.capture` 4, `apps.launch` 3, `files.open` 2, `workspace.switch` 1, `windows.move` 1 | `activity` |
| Default for new conversations | Ollama, model `glm-5.3:cloud`, tools on | `settings.conversationDefaults`, `settings.ollama` |
| Context of that model, from a live turn plan | `contextSize` 1,048,576. A 133,412-token history was included whole; continuity was `not_needed`. | `meta` `turn-plan:*` (counts only) |
| Workflow results | 337 results, none with a reviewed check. Result records do not store the recipe that produced them, so built-in recipe use cannot be counted (`C:broker/workflows.ts:54-61`). | `meta` `workflow:results` |
| Saved scripts, saved recipes, styles, capsules, collections, schedules | 0, 0, 0, 0, 0, 0 | `settings.scripts`; no `workflow:recipe-definitions`, `behaviorPresets`, `capsule:*`, `knowledge:*` or schedule keys |
| Notes vault, voice commands, responsiveness, extensions, custom tools | Off or empty | `settings` |
| Speech | `speechEnabled` false; provider ElevenLabs with `allowCloud` false | `settings` |
| Memory | Enabled. Embedding `nomic-embed-text-v2-moe:latest`; extraction `glm-5.3-flash:cloud`; `allowCloudMemory` true. `allowCloudExtraction` is unset, which the broker treats as true (`C:broker/memory.ts:177`). | `settings` |
| Extraction runs in the live store (1,452 total) | - `glm-5.3-flash:cloud`: 108 complete, 4 validated<br>- `nemotron-3-ultra:cloud`: 40 complete, 10 validated<br>- `gpt-oss:20b-cloud`: 10 complete, 4 validated, 1 retryable<br>- No model recorded: 1,271 (704 superseded, 292 derived, 275 retryable) plus 4 erased | `memory.sqlite` `extraction_runs` |
| Live (non-erased) assertions | - 96 accepted, none with an extraction run<br>- 35 candidates from `glm-5.3-flash:cloud` runs (34 `instrumented`, 1 `inference`)<br>- No assertion produced by an extraction run is accepted | `assertion_versions` joined to `extraction_runs` |

### 2.6 What this means for the next stage

Most Slice 1–5 features have not been used. They were installed 30 minutes before this review. The older capsule and saved-script features have no use either, and there are no saved recipes; use of the built-in recipes is not recorded. The owner works mainly through the Codex and Claude CLIs, and through a 1M-context cloud Ollama model that delegates code work to them. Memory is the subsystem in daily use, and its extraction quality is unmeasured for the configured model.

The next stage should therefore:

1. make the shipped work safe and durable (Stage S);
2. correct fidelity gaps in shipped behavior cheaply (Stage R);
3. measure the one quality that matters in daily use (EV-01);
4. leave speculative features behind explicit triggers (Stage D).

## 3. Stage S: stabilization (do first)

### S1 — Preserve the live code in commits (owner authorization required)

**Why.** The installed code is the working tree, and the live memory store depends on its migration 5 (§2.3). No commit was requested in the prior session.

**Steps.**

1. Commit on `ui-overhaul`, or on a new branch the owner names. Do not commit to `main` directly.
2. Split into:
   - **A**: the owner's in-flight screenshot and documentation work (files listed in §2.2).
   - **B**: the `artwork/` removal. This is an owner decision. Restoring the files needs their approval, and `tests/avatar-surface-motion.test.ts` depends on `artwork/avatars/cere/registration.json`.
   - **C**: Slices 0–5. This is one commit unless the owner wants it split by subsystem; splitting by slice afterwards is impractical because `broker/core.ts`, `broker/types.ts` and `tests/ui.cpp` carry every slice.
3. `README.md` and `VALIDATION.md` each contain hunks from both A and C. Interactive staging is not available in the worker environment, so stage those hunks with a filtered patch: `git diff -- VALIDATION.md > /tmp/v.patch`, remove the other workstream's hunks, then `git apply --cached /tmp/v.patch`.
4. `prompts/` holds both plans. Commit it only if the owner wants the plans versioned.
5. Do not touch migration 5's SQL.

**Acceptance.**

- `git status` shows only intentional leftovers.
- Each commit's `git show --stat` lists only its own files.
- `npm run typecheck` passes.
- `CERE_TTS_DISABLED=1 npm test` reproduces 671/669/1/1 on the tree after commit C.

### S2 — Notes-vault privacy fails open (RC-01)

**Agreed rule.** "Unknown privacy settings fail closed" (original plan open question 4; decision recorded at `T:PROGRESS.md:25`).

**Cere evidence.**

- `C:broker/notes-vault.ts:29-30`: front matter is recognized only when the file starts with exactly `---\n`; otherwise `frontMatter` returns `undefined`.
- `:51-57`: `privateNote` treats only `private === true` (plus `cere: false|private|exclude` and non-public `visibility|privacy|access`) as private.
- `:94-96`: when `meta` is `undefined`, the whole file, front matter included, becomes the indexed and model-readable body.
- `:144-149`: the edit check uses the same predicate.

Probe results (Appendix A.3, probe 2):

| Input | `frontMatter` | Private? |
| --- | --- | --- |
| LF `---\nprivate: true` | `{private:true}` | yes |
| CRLF `---\r\nprivate: true` | `undefined` | **no** |
| UTF-8 BOM before `---` | `undefined` | **no** |
| `--- ` (trailing space) | `undefined` | **no** |
| `private: yes` | `{private:"yes"}` | **no** |
| `private: "true"` | `{private:"true"}` | **no** |
| `...` closing fence | `null` | yes (counted unreadable) |
| key with a space, nested map | `null` | yes (counted unreadable) |

Existing tests use LF front matter only (`C:tests/notes-vault.test.ts:15-16, 35`).

**PyPersona comparison** (do not copy):

- The privacy key is `pypersona_private` (`P:p/core/notes/obsidian.py:26`; `P:p/core/notes/parser.py:386`).
- A YAML parse failure, or a missing PyYAML, yields `{}` and therefore *not private* (`parser.py:152-158`).
- Unindexed notes are not private (`P:p/core/notes/access.py:120-125`).

**Change** (`C:broker/notes-vault.ts`):

1. Before detecting front matter, drop a leading U+FEFF and normalize `\r\n` and `\r` to `\n`.
2. Accept an opening fence of `---` with trailing whitespace, and a closing fence of `---` or `...` with trailing whitespace.
3. Compute the body from the normalized offsets, so front matter never reaches the index.
4. Match privacy keys case-insensitively.
5. `private` is public only for boolean `false` or the strings `false`, `no` and `off`. Every other present value — `true`, `yes`, `on`, `1`, `"true"`, or anything unrecognized — is private.
6. Keep: unreadable front matter is private.
7. Owner decision D4: apply the same predicate to `.md` files in knowledge collections (`C:broker/knowledge-collections.ts:213-247`). Recommended: yes, reusing `privateNote(frontMatter(text))`.

**Acceptance.**

- Every row in the probe table above becomes private or unreadable for search, read and propose-edit.
- A CRLF public note stays searchable, and its body excludes the front matter.
- The LF cases are unchanged.
- `status.private` and `status.unreadable` counts match the fixtures.

**Verification.**

- `node --test tests/notes-vault.test.ts tests/knowledge-collections.test.ts`
- the full npm test run
- UI slot `localModelsTranscriptionAndNotes`

**Activation.** The fix goes live only through an owner-authorized reinstall (§9.4). Live exposure today is nil because `settings.notesVault.enabled` is false.

### S3 — Pin memory migration checksums, and move the request-equivalence check into the repository

1. **Migration pin test. New** `C:tests/memory-migrations.test.ts` recomputes `sha256` of `schema` and of each `migrations[i].sql` (`C:broker/graph-memory/schema.ts`). It compares them with the five values in §2.3 and fails with "add a new migration; never edit an applied one".
   - Existing tests (`C:tests/review-memory.test.ts:119, 149, 153`) check that the latest migration applies and that a tampered checksum in the database is refused. They do not catch an edit to an applied migration's SQL, because a fresh test store simply records the new digest.
   - This test prevents the bricking described in §2.3.
2. **Request-equivalence test.** The A01 equivalence check exists only as `T:scripts/golden-ollama.ts`. Bring it into the repository: **new** `C:tests/fixtures/golden-ollama-payload.json` and a test in `C:tests/context-plan.test.ts` that captures the same fixed Ollama turn and compares it byte for byte. Several Stage R items must prove "unchanged when the feature is unused".

**Acceptance.** Both tests pass on the committed tree, and fail on a one-character edit to migration 5 or to the operating rules.

### S4 — Verified pre-migration memory backup (NF-01)

**PyPersona mechanism (verified).**

- `P:p/core/db/database.py:574-605`: before migrating, it copies the database with the SQLite backup API to a temporary file, runs `PRAGMA integrity_check` on the copy, and atomically renames it into place.
- `:632-650`: it removes that backup when history is cleared, because the backup holds deleted conversations.

The original plan inventoried this as C07 but did not propose it.

**Cere evidence.**

- `Canonical.migrate` applies pending migrations without a backup (`C:broker/graph-memory/canonical.ts:186-210`).
- `backup()` already exists (`:3536-3559`): `VACUUM INTO`, mode 0600, and a manifest with `erasure_registry_required: true`.
- `restore()` stages into an empty directory with the *current* erasure registry and rebuilds (`:3560` and following), so restoring cannot resurrect records erased later.
- Live: migration 5 ran with no backup (§2.3).

**Change.** When a store that already has `schema_migrations` rows has pending migrations:

1. Write `L:~/.local/state/cere/memory-backups/before-migration-<from>-to-<to>-<UTC date>.sqlite` with the existing backup routine.
2. Open the copy read-only and require `PRAGMA integrity_check` = `ok`.
3. Only then apply the migrations.
4. Refuse with a clear health error, leaving the store untouched, when free space is below twice the store size, the backup fails, or the check fails.
5. Keep the newest two pre-migration backups.
6. Retention (owner decision D6). Recommended: delete pre-migration backups automatically after 14 days and on any "clear all memory"; show "pre-migration backup from <date>" in Health. The memory forget preview should mention that an older backup still physically contains its text, and offer to delete it.

**Acceptance** (temporary stores in tests):

- A store at migration 4 opened by the code at migration 5 produces a backup with a manifest, an `integrity_check` of `ok`, and then migration 5.
- An unwritable backup directory means no migration and a reported error.
- Retention removes the third-oldest backup and backups older than 14 days.
- A restore from the backup through `restore()` does not resurrect an assertion erased after the backup was taken.

**Size:** M. **Dependency:** must ship before any further memory migration.

### S5 — Correct the records

Update the following to say the work was installed at 21:28 EDT on 15 October and that memory migration 5 is live:

- `VALIDATION.md` (the PyPersona section, line 23);
- `T:PROGRESS.md`;
- the README sentence on identity decisions, if the owner keeps it.

These documentation edits are owner-authorized under the usual workflow: edit, then verify the changed claims against source.

### S6 — Re-baseline after S2–S4, and activate only with authorization

1. Run the §9.1 commands and compare with §2.2. The pre-existing failures are expected.
2. Reinstall only with explicit owner authorization, using the safe order in §9.4.

## 4. Reconciliation of Slices 0–5 with the real PyPersona mechanisms

### 4.1 Method

For each implemented proposal, the PyPersona source it modeled was re-read where the next stage depends on it (Appendix B records the depth). The Cere implementation was compared at the line level, and behavior was probed where possible. A finding is listed only when the real mechanism has a property that matters for Cere and Cere's implementation lacks it or contradicts it. Design differences the original plan chose deliberately are recorded in Appendix B, not "fixed".

### 4.2 Findings that need work

| ID | Finding | Priority | Size |
| --- | --- | --- | --- |
| RC-01 | Vault privacy fails open (S2) | P0 | S |
| RC-02 | Postures and styles that withhold memory still get automatic recall | P1 | S |
| RC-03 | Output-section checks raise false "missing" alarms | P1 | S |
| RC-04 | Completion gates accept checks that predate later edits | P1 | M |
| RC-05 | The no-progress notice misses repeated failures | P1 | S |
| RC-06 | Style-check detectors: false positives and misses | P2 | S |
| RC-07 | No trait-conflict warnings | P2 | S |
| RC-12 | Project convention files are sent without secret redaction | P2 | S |
| RC-13 | Extension tools cannot be hidden from the model | P2 | S |
| RC-08 | Continuity drops the opening turn first | P3 (trigger) | S |
| RC-09 | Grounding modes do not change admission | P3 (measure first) | S |
| RC-10 | No vault ignore rules or folder scope | P3 | S |
| RC-11 | No low-disk warning before model pulls | P3 | S |

#### RC-02 — Postures and styles that withhold memory still get automatic recall

**PyPersona (verified).**

- A command whose `memory_access` is `none`, or any command given `--no-memory`, resolves `memory_scope` to `none` and `retrieval_enabled` to false (`P:p/core/imode/profile.py:130-147`).
- The prompt builder then skips persona-global and graph recall (`P:p/core/prompt/prompt.py:294-330`), and the bound-index gate fails (`P:p/core/persona/retrieval.py:62-77`).
- The posture text adds "Do not retrieve or rely on stored memory for this turn." (`P:p/core/imode/postures.py:338-339`).
- Capture is not gated: `P:p/controller/chat/output.py:360` and following has no posture check.

**Cere.**

- A ceiling of `memory: false` removes memory and notes tools: `C:broker/core.ts:1191-1196` and `:1202-1205` (memory), and `:1254-1256` (notes, which use the same flag).
- Automatic recall runs whenever memory is enabled and active: `:195-199` for API and Ollama, `:742-747` for the CLIs. Capture also runs (`:202`).
- The behavior block says only that the style "withholds Cere's memory tools" (`C:broker/behavior.ts:111`).

**Change.**

1. Add a ceiling family `recall` (false means no automatic recall for turns under that style or posture). This touches:
   - `validCeiling` (`behavior.ts:55-62`) and the `ToolCeiling` type;
   - the narrow-only merge in `resolveBehavior` (`:87-89`);
   - the behavior-block wording ("withholds automatic memory recall").
2. In both recall paths, check `withheld(id, 'recall')`. Record `outcome: 'disabled', reason: 'style_withheld'` in the existing `RecallOutcome` vocabulary (`C:broker/memory.ts:115-121`), and map the reason in `C:qml/ContextExplain.js`.
3. Add one built-in posture: `posture:no-memory` ("Without memory"), with ceiling `{recall:false, memory:false}`, for one turn or pinned.
4. Package import and export carry `recall`. An older Cere refuses a package with an unknown ceiling key (`validCeiling` throws), which is the intended "unknown schemas refuse safely" behavior.
5. Owner decision D3: whether withheld recall also skips capture for that turn. Recommended default: no, which matches PyPersona. The UI text says that capture follows the memory settings and that temporary conversations remain the way to leave nothing behind.

**Acceptance.**

- A one-turn no-memory posture sends an Ollama request with no `cere_memory_data`, and the turn's recall outcome is `disabled/style_withheld`.
- The next turn recalls normally.
- A pinned no-memory posture on a CLI session adds no memory text at the instruction boundary.
- The ceiling can never re-enable recall when memory is off.
- Turns without the posture match the S3 golden payload byte for byte.

**Tests:** `tests/behavior-profiles.test.ts`, `tests/recall-outcome.test.ts`, `tests/context-plan.test.ts`.

#### RC-03 — Output-section checks raise false "missing" alarms

**PyPersona (verified).** `P:p/core/imode/contract.py:47-66`.

- Each line has leading ``[\s>#*\-\d\.\)\[\]_`|:]*`` stripped. A section is present when a line then starts with its name (or the name with underscores as spaces).
- Otherwise a permissive fallback counts the name appearing anywhere in the text.
- The module's rule is to "prefer under-reporting over false alarms" (`:17-19`).
- Enforcement is off by default (`config.json:236`).

**Cere.** `C:broker/output-contracts.ts:33-45` requires the folded line to equal the section name exactly, as a heading, a bold label or a `Name:` label.

Probe (Appendix A.3, probe 1):

| Line | Reported present? |
| --- | --- |
| `## 1. Findings` | **no** |
| `## Findings and evidence` | **no** |
| `1. **Findings**` | **no** |
| `Findings` (bare line) | **no** |
| `## Findings` | yes |
| `**Findings:**` | yes |

A false "missing" reaches the user as an amber "Output sections missing: …" line on the result (`C:qml/Workflows.qml:353-355`, fed by `C:broker/workflows.ts:572`).

**Change.**

- Normalize each line outside code fences. Strip heading hashes, blockquote markers, list bullets, ordered-list numbers and bold, italic and code markers.
- A section is present when the normalized, folded line starts with the folded name followed by end of line, whitespace or punctuation.
- A name that appears only in prose is present with `how: 'mentioned'`. The contract status stays `met`, and the UI says "mentioned, not as a heading".
- `missing` only when the name does not appear at all.
- Keep the code-fence exclusion.

**Acceptance.**

- All probe lines are present.
- `Riskscore` does not satisfy `Risk`.
- A heading inside a fence still does not count.
- `tests/workflows.test.ts:198-201` is updated to the new contract.

#### RC-04 — Completion gates accept checks that predate later edits

**PyPersona (verified).** Applying a reviewed edit resets every verification gate to pending: `P:p/plugin/cmd_code_interpreter/harness/commands/apply_edit.py:25-34, 56` calls `VerificationStore.mark_all_pending` (`verification.py:231`). This covers edits made through its own apply path only.

**Cere.**

- `checklist()` judges a check by its latest run and by whether the check's definition changed (`C:broker/output-contracts.ts:60-76`). Edits made after the run are ignored.
- Completing a task through an observed check accepts *any* result from the project whose gate passed (`C:broker/workflows.ts:257-266`), even when files changed afterwards.

**Edit evidence Cere already has.**

- Workspace telemetry records file edits with timestamps for watched roots (`C:broker/telemetry/files.ts`). It honors its exclusions (`:6`) and `.gitignore` (`:12`). Live telemetry is enabled with one root.
- M22 note edits are observed as `notes.edit` actions (`C:broker/core.ts:1278-1279`).

**Change.**

- Keep a `lastObservedEdit` per canonical cwd (time and source) from those two sources.
- In `checklist()`, a passed run older than a later observed edit in the same cwd becomes `stale` with the reason "files changed after this check".
- Completion through an observed check requires a passed gate with no later observed edit.
- When no source covers the cwd (telemetry off or the root not watched), the checklist says "later edits are not observable" instead of implying the check is current.
- Optional extension: Codex `fileChange` item completions (`C:broker/providers.ts:302-303`) and Claude edit tool events as further sources.

**Acceptance.**

- pass, then a later telemetry edit → `stale`
- an edit, then a pass → `passed`
- a later `notes.edit` → `stale`
- completion with stale evidence is refused
- an unobservable cwd is labeled
- edits to excluded build outputs do not mark checks stale

#### RC-05 — The no-progress notice misses repeated failures

**PyPersona (verified).** `P:p/plugin/cmd_code_interpreter/harness/loop_detector.py` has three signals:

- the same command with identical parameters run N times in a row (`:66-74`);
- **N consecutive failures of the same command regardless of parameters** (`:76-83`);
- repeated installs (`:85-90`).

N defaults to 3. The harness shows the result to the model as a prompt nudge (`P:p/plugin/cmd_code_interpreter/plugin.py:377-414`; `P:p/plugin/cmd_code_interpreter/harness/injection.py:133-150`), but the harness plugin itself is disabled by default (`P:p/data/config/config.json:479`).

**Cere.** `C:broker/tool-progress.ts:25-34` flags only the same tool with the same arguments returning the same result. Failures reach the loop as `{error}` results (`C:broker/ollama.ts:427`), and a model retrying a failing tool with new arguments is never flagged.

**Change.**

- `ToolProgress` also counts consecutive failures per tool name, reset by a success of that tool.
- At 3 failures it shows one user-facing notice per streak, for example "web_read failed 3 times in a row". Polling tools count for failures.
- The notice is not added to the model's history, as today.
- Owner option: a model-facing nudge (PyPersona parity), off by default. It changes requests only on turns that hit the condition.

**Acceptance.**

- Three failing calls with different arguments produce one notice.
- A success resets the count.
- The existing identical-result signal is unchanged.

**Test:** `tests/tool-progress.test.ts`.

#### RC-06 — Style-check detectors: false positives and misses (P2)

**PyPersona (verified).** `P:p/core/style/checks.py:36-96`:

- emoji are code points in the blocks U+1F1E6–U+1F1FF, U+1F300–U+1FAFF, U+2600–U+26FF and U+2700–U+27BF;
- a table is any separator row made only of `|:- ` characters that contains both a pipe and a dash.

**Cere.** `C:broker/style-checks.ts:21-34`:

- `\p{Extended_Pictographic}` counts ©, ™, ↔ and ✓ (probe: "© … ™ ↔ ✓" counted 3).
- The table pattern needs a pipe-bounded header, at least two columns and at least three dashes. Probe: a pipe-less GFM table, a one-column table and `|-|-|` were not detected.

**Change.**

- Emoji: count `\p{Emoji_Presentation}` code points, plus `\p{Extended_Pictographic}` followed by U+FE0F, with a regional-indicator pair counted once.
- Tables: GFM delimiter rows. Cells of `:?-+:?` separated by `|`, at least one `|`, leading and trailing pipes optional, after a header line.
- Code stays excluded, a Cere improvement over PyPersona.

**Acceptance.**

- 😀, 👍🏽, ❤️ and 🇺🇸 are counted.
- ©, ®, ™, →, ↔, • and plain ✓ are not.
- All GFM table variants are detected.
- Fenced tables are ignored.

#### RC-07 — No trait-conflict warnings (P2)

**PyPersona (verified).** `P:p/core/style/validate.py:42-46` lists three conservative conflicts, surfaced as warnings only (`:58-63`):

- clinical warmth with playful humor;
- formal register with playful humor;
- blunt directness with warm tone.

**Cere.** `C:broker/behavior.ts` has no conflict diagnostics, and posture traits override base traits (`:86`).

**Change.** Map the three pairs to Cere's −2…2 scale:

- warmth ≤ −1 with humor 2;
- formality ≥ 1 with humor 2;
- directness 2 with warmth ≥ 1.

Include the merged posture traits. Return warnings from `behavior.preview` and `behavior.resolve` (`C:broker/core.ts:1593-1600`) and show them in `C:qml/BehaviorProfileEditor.qml`. Never block, never change the rendered text.

**Acceptance.** Each pair warns, including a posture-merged pair, and the rendered block is unchanged.

#### RC-12 — Project convention files are sent without secret redaction (P2)

**PyPersona (verified).** Repository rules are redacted with the harness redactor before injection (`P:p/plugin/cmd_code_interpreter/harness/rules.py:116-135`).

**Cere.** `C:broker/project-instructions.ts:14-32` sends `AGENTS.md`, `CLAUDE.md` and `CONVENTIONS.md` verbatim (capped at 8,000 characters), including to cloud models.

**Change.**

- Redact credential-shaped tokens with the patterns Cere already applies to terminal telemetry, in `redact` at `C:broker/telemetry/protocol.ts:9` (verify its pattern set at implementation time).
- Record `redactions: n` in the `conventions` plan layer.

**Acceptance.**

- A convention file containing a fake `sk-…` key is redacted in the request, and the count appears in Context.
- Files without matches are byte-identical.

#### RC-13 — Extension tools cannot be hidden from the model (P2)

**PyPersona (verified).** Per-server `allowed_commands` and `disabled_commands` hide tools during discovery (`P:p/plugin/mcp/plugin.py:232-233, 288-290`).

**Cere.** `allowed` is an auto-approve list (`C:broker/extensions.ts:22-31`), and every usable tool is offered (`:298-307`).

**Change.**

- Add a per-server `hidden: string[]`. A hidden tool is neither offered nor callable.
- Add toggles in `C:qml/ToolServers.qml`.
- Reconfiguring refuses pending approvals for tools that became hidden, as the disable path already does.

**Acceptance.** A hidden tool is absent from `toolsFor` and refused by `call()`. **Test:** `tests/extensions.test.ts`.

#### RC-08 — Continuity drops the opening turn first (P3, trigger)

**PyPersona (verified).** The rolling summary folds the previous summary into each update, so early turns stay represented (`P:p/core/persona/memory.py`).

**Cere.** `continuityBlock` keeps the newest omitted turns and drops older ones first (`C:broker/context-plan.ts:53-83`), so the conversation's opening request is the first thing lost.

**Live.** The default model has a 1,048,576-token context, and continuity was `not_needed` (§2.5).

**Change, only when small-context models are in use.** Reserve up to 25% of the continuity cap for the earliest omitted user message, kept as `opening`.

**Acceptance.**

- A small-context fixture keeps the opening request.
- The output is byte-identical when nothing is omitted.

#### RC-09 — Grounding modes do not change admission (P3, measure first)

**PyPersona (verified).** Each answer mode pairs its instruction with a similarity threshold: strict 0.5, balanced 0.3, exploratory 0.0 (`P:p/core/memory/retrieval.py:46-62`).

**Cere.** Modes change only the instruction text. Every mode retrieves with `relevance_floor: true, max_items: 6` (`C:broker/knowledge-collections.ts:263-293`).

**Step 1.** The offline document baseline is lexical-only; it reports embedding-backed recall as unmeasured (`C:docs/memory/evaluation.md:73`). The lexical floor is computed from the corpus size, with no caller-supplied knob (`C:broker/graph-memory/canonical.ts:1556-1561`, `lexicalFloor`). The semantic floor is a parameter (`:1415, 1575-1577`). So:

- Add an optional lexical-floor scale for collection queries; strict mode uses a scale above 1. Extend `C:benchmarks/memory/document-baseline.ts` to report hit@1 and abstention per mode while sweeping that scale.
- A `semantic_floor` sweep needs a local embedding model. It is a separate, opt-in run.
- Adopt a strict floor only if abstention improves on the baseline 0.667 with no loss of hit@1 from 0.923.

Collections are unused on this machine.

#### RC-10 — No vault ignore rules or folder scope (P3)

**PyPersona (verified).**

- A `.pypersonaignore` file in gitignore style, plus built-in exclusions of `.obsidian/`, `.pypersona/`, `.trash/` and `.git/` (`P:p/core/notes/obsidian.py:26-34, 72-124`), applied before indexing and retrieval.
- Model access defaults to `notes.model.scope = active_folder`, with 600-character excerpts and 8 hits (`config.json:383-389`).

**Cere.** Fixed ignored folders (`C:broker/notes-vault.ts:16`), whole-vault scope, 400-character excerpts, 20 results, and reads of up to 40,000 characters (`:15`).

**Change.**

- An optional `.cereignore` at the vault root, using a gitignore subset with `matchesGlob` as in `C:broker/telemetry/files.ts:12`, applied before indexing.
- An optional folder allowlist in settings.

The vault is disabled on this machine.

#### RC-11 — No low-disk warning before model pulls (P3)

**PyPersona (verified).** It warns below 4 GiB free and reports "unknown" when the model directory cannot be found (`P:p/controller/ollama/models.py:38, 453-467`).

**Cere.** `C:broker/local-models.ts` does no disk check.

**Change.**

- For a loopback Ollama host, `statfs` the first directory that exists among `$OLLAMA_MODELS`, `~/.ollama/models` and `/var/lib/ollama`.
- Warn below 4 GiB; otherwise say "unknown".
- Never block the pull.

### 4.3 Confirmed faithful or stronger (no work)

Appendix B has the full matrix. Notable cases:

- **M14 schedules are stronger than PyPersona.** PyPersona's `skip` and `run_once` policies behave identically. Its schedule state lives in memory only, so runs missed while the app was closed are never seen (IC-01). Cere implements a real skip with persisted claims.
- **A02 is stronger than PyPersona's MCP plugin.** Cere keeps a persistent connection with a protocol check, per-call timeouts, cancellation, quarantine and per-call approval. PyPersona opens a fresh session per call batch, has no call timeout and supports only an `Authorization` header (IC-02).
- **A04 jobs are stronger.** PyPersona's `TaskSupervisor` only *counts* plugin work; the work starts on the shared pool regardless of capacity (IC-07). Cere actually yields to foreground work.
- **M01 withholds tools from the request.** PyPersona drops tool calls at dispatch while still offering the tools (IC-05).
- **M23 is stronger.** It has no shell path at all and refuses slot values that start with `-`. PyPersona's argv templates add no leading-dash check (`P:p/core/proc/argv.py`).
- **M22 is faithful and stronger.** It matches PyPersona's stale-base hash refusal and atomic, mode-preserving replace (`P:p/plugin/cmd_code_interpreter/harness/diff_workflow.py:275-322`), and adds one-use proposals and a private backup.
- **M12 is a deliberate design difference.** Cere refuses malformed constraints, which returns an error the model can correct. PyPersona silently drops invalid values (`P:p/plugin/cmd_web/plan.py:137-171`). Cere skips the cache only for `fresh` and past-day searches; PyPersona skips it for any freshness or date bound (`websearch.py:312-319`). Either is reasonable, so no change.
- **M16 covers more than PyPersona.** PyPersona's diagnostics record startup phases, conversation loading and storage, rendering, plugin dispatch and its lifecycle helpers. The call sites are in `p/ui/main.py:95-126`, `p/controller/ctx/ctx.py`, `p/core/ctx/ctx.py`, `p/provider/core/ctx/db_sqlite/storage.py`, `p/core/render/web/renderer.py`, `p/core/dispatcher/isolation.py` and `p/core/lifecycle/`. None of them time a turn, a provider's first token, a tool call or speech synthesis. Cere times turns, first token, memory, tools, synthesis and Stop.

## 5. The deferred remainder of Slice 5

### 5.1 A03, read-only code context — decision: do not build in this stage

**Evidence.**

1. **No working PyPersona mechanism exists to model.** `CodeGraphIngestor.ingest_project` and `ingest_files` have no caller anywhere in `src/`; the only callers are tests (`P:tests/core/persona/test_code_graph.py`, `test_append_events.py`, `test_code_analyzer.py`). Production code recall (`P:p/core/prompt/prompt.py:403-425`) and the analyzer (`p/core/persona/consolidator.py:334`) therefore read an empty graph. Only a Python AST parser ships (`p/core/persona/graph/code_graph/parser.py:17`).
2. **Demand is served elsewhere.** 112 of 148 sessions run Codex or Claude, which have native code intelligence. The Ollama conversations delegate code work: `sessions.start` is the most frequent recorded action, and there are 35 delegated children (§2.5).
3. **The original blocker remains.** There is still no corpus of real code questions.
4. **It would be a new privacy boundary.** An index would be the first channel from project files to a model in Cere's own loop, and the default model is a cloud model (`glm-5.3:cloud`).

**Re-entry**, only if the owner asks for code answers inside Ollama or API conversations without delegation:

1. Collect 30 real code questions from the owner's own delegated sessions, with expected file references, as a fixture.
2. First slice: bounded read-only `project.search` and `project.read` tools confined to the session cwd, reusing the M06 exclusion rules, with their own approval category and cloud-route consent.
3. Build a symbol index only if the corpus shows that search and read are insufficient. The original plan's A03 acceptance criteria still apply.

### 5.2 M11, speech-result cache — decision: do not build in this stage

**Evidence.**

1. Speech is off on this machine (`speechEnabled` false), and the paid provider is not allowed to reach the cloud (`elevenlabs.allowCloud` false).
2. **M16 has recorded nothing.** `settings.responsiveness` is false, and spans are an in-memory ring of 500 that is cleared when turned off (`C:broker/spans.ts:19-33`).
3. **Even when on, M16 cannot measure M11's benefit.** The synthesis span records only latency, outcome and backend (`C:broker/core.ts:184`; `C:broker/tts.ts:252-257`), not whether the same text was spoken again.
4. **PyPersona offers no evidence of benefit either.** Its cache ships enabled with up to 1,000 files (`config.json:111-112`), but its speech-output plugin is disabled by default (`config.json:476`). The key is the SHA-1 of the text alone, so a voice change replays the old voice (`P:p/core/audio/audio.py:187-203`; `plugin/audio_output/plugin.py:181-195`).

**Re-entry, through EV-02 (optional).** If the owner wants M11 reconsidered:

- Add an in-memory repeat counter to M16, active only while M16 is on. It keeps a SHA-256 of the normalized text plus provider, voice and every synthesis option for the last 256 utterances.
- The summary reports `utterances`, `repeats` and `repeatShare`, as counts only and never exported beyond them.
- Revisit M11 when speech is enabled and `repeatShare` is at least 15% over at least 100 utterances, or when a paid provider is enabled with at least 20 repeats a week.
- The original M11 acceptance criteria then apply unchanged: the complete key, attributed purge on forgetting, and no durable audio for temporary or unbound text.

## 6. Demand-gated and optional items

### 6.1 Recommendations

| Item | PyPersona reference (verified) | Demand on this machine | Recommendation |
| --- | --- | --- | --- |
| A05 cloud extractor evaluation | None; PyPersona has only parser unit tests (`P:tests/core/persona/test_graph_extractor.py`) | High. Extraction runs on an unevaluated cloud model, and none of its output is accepted (§2.5). | **Run EV-01** with owner authorization (§6.2) |
| A05 task binding | No "active task" concept. PyPersona tasks are plain `has_task` edges with no status (`P:p/core/imode/project_state.py:45, 151-170`). | None (no capsules) | **Defer; design ready** (§6.3) |
| M10 speech-recognition interface | `BaseProvider.transcribe(path) -> str` (`P:p/provider/audio_input/base.py`). Seven providers, mostly cloud; local Whisper reloads its model on every call (`openai_whisper_local.py`). | None; dictation is off, and cloud ASR is excluded by decision | **Leave**. Trigger: the owner asks for a second *local* backend. |
| M18 capture and generative media | DALL·E plugin, Google video provider, camera controller (`P:p/plugin/openai_dalle/plugin.py`, `p/provider/api/google/video.py`, `p/controller/camera/camera.py`) | None | **Leave**. Cloud media plus camera privacy; explicit request only. |
| M19 realtime voice | OpenAI, xAI and Google realtime clients (`P:p/provider/api/{openai,x_ai,google}/realtime/`, `p/controller/realtime/realtime.py`) | None; speech is off | **Leave**. It would contradict the no-cloud-ASR decision. |
| A07 service management | Ownership-aware Ollama supervisor (`P:p/core/ollama/supervisor.py:10-20`); Docker Neo4j manager (`p/core/persona/graph/neo4j_service.py`) | `cere-memory.service` fails on a Qdrant readiness timeout (§2.4) | **Leave**. The decision keeps services external. The Qdrant failure is an operations fix in `C:tools/memory-dependencies.sh`, outside this plan. |
| A08 browser companion | Portal disabled by default, loopback, with a configurable token requirement (`config.json:212, 677-685`; `p/core/web_portal/auth.py:73-85`) | None; the Android client exists | **Leave** |
| A02 HTTP/SSE MCP transports | stdio, streamable HTTP and SSE (`P:p/plugin/mcp/plugin.py:373-394`) | None; no extensions configured | **Leave** until a requested server needs one. It would need M23-style origin binding and private-address checks. |
| NF-02 delegation work-order guidance | `/prompt --target` work-order guidance (`P:p/core/imode/postures.py:302-312`) and the `/handoff` contract (`p/data/config/commands.json`) | Delegation is the most frequent recorded action | **Optional, owner choice** (§6.4) |

### 6.2 EV-01 — Evaluate extraction for the model actually configured (recommended; owner authorization required)

**Why.**

- The configured extraction model is `glm-5.3-flash:cloud` (settings).
- The recorded evaluation covers only `gpt-oss:20b-cloud`, on 5 cases. The code default `nemotron-3-super` is unevaluated (`C:docs/memory/evaluation.md:31`; `C:docs/memory/versions.md:12-14`).
- The existing evaluator hard-codes the model and its digest (`C:benchmarks/memory/evaluate-extraction.ts:7-8`).
- It never submits proposals through `Canonical.remember`, so the accepted-assertion precision gate stays unmet (`evaluation.md:100`; `implementation-report.md` gate 2).
- It writes to `benchmarks/memory/extraction-results.json`, which would overwrite the two preserved runs.

**Steps.**

1. **Offline, no model calls.** Make a `VACUUM INTO` copy of the live memory store in a private temporary directory, with owner consent to read it. Report counts only: extraction-linked assertions by `status`, `epistemic_type`, predicate and source role, explaining why every one is a candidate.
2. **Harness.**
   - Take model and digest from arguments, defaulting to the configured `settings.memory.extractionModel`. Write to `benchmarks/memory/extraction-results-<model-slug>.json`, never to the preserved file.
   - **New** held-out fixture `C:tests/fixtures/memory/extraction-cases.json` with at least 40 synthetic statements: the existing 5 plus at least 35 across every registered predicate. Include negatives that should yield nothing, and some drawn from the wording style of `tests/fixtures/memory/natural-language-cases.json`.
   - Add a canonical pass: submit each proposal through `Canonical.remember` in a temporary store and record accepted, candidate and rejected, with reasons.
3. **Cloud runs.** Require `CERE_ALLOW_CLOUD_EVAL=1` and explicit owner approval per model. Run `glm-5.3-flash:cloud` (configured), `nemotron-3-super` (code default) and `gpt-oss:20b-cloud` (reference). Record digests.
4. **Report** in `docs/memory/evaluation.md`. Include counts as well as ratios, predicate precision, accepted-assertion precision, abstention on negatives, and p50/p95 latency, plus a recommendation for the default model.

**Acceptance.**

- Only synthetic text leaves the machine. The `fetch` guard used by `tests/review-benchmark.test.ts` covers the offline parts.
- Each model has its own result file, and the preserved results are unchanged.
- The gates are reported as passed, failed or unmeasured, never inferred.

**Risks.** Cost and quota; model drift (record digests); small samples (report counts).

### 6.3 A05 task binding — deferred, design ready

**Trigger.** The owner uses capsule tasks (at least one project with three or more open tasks), or asks for task-scoped memory.

**Design.**

- **Definition.** A conversation is bound by an explicit user action, "Work on this here", to one M08 task in state `accepted` or `active` (`C:broker/workflows.ts:15-34`).
  - The binding is stored on the session as `{cwd, taskId, revision}`, one task per conversation.
  - It ends on unbinding, or when the task becomes `done` or `dropped`.
  - A desktop focus change never binds or unbinds a task, as the design document requires (`C:docs/Cere_Graph_Memory_Implementation.md:511-513`).
- **Canonical mirror.**
  - Ensure a `tasks` row with `binding: 'capsule:<cwd digest>:<taskId>'` in the project scope, with its status mirrored. The table already exists (`C:broker/graph-memory/schema.ts:23`).
  - Observations from bound turns carry `task_id`. The ingest path validates it in scope (`C:broker/graph-memory/canonical.ts:498`) and threads by it (`:619-624`).
  - Automatic recall passes `task_id`, which retrieval already accepts and uses as an anchor (`:1405, 1535`).
- **Semantics** (owner decision D9). Recommended: the task is a thread and an anchor inside the project scope, not a visibility boundary. Task memories stay visible to the whole project and rank first in bound conversations. The alternative is a child scope, which would hide task memories outside the task.

**Acceptance.**

- Bound turns' observations have `task_id`.
- In a fixture, task-linked memories rank first for a bound conversation and are unchanged for unbound ones.
- Unbound requests match the golden payload.
- A task id from another project is rejected.
- No `task_id` is sent after `done`.
- The binding survives a restart.
- Gate 3 in `docs/memory/implementation-report.md` is updated.

### 6.4 NF-02 — Delegation work-order guidance (optional)

**Evidence.**

- Delegation is the most frequent recorded action (§2.5), and every delegation prompt is reviewed by the user before sending.
- The current field description is "The complete task and context to send to this provider. The user reviews it before sending." (`C:broker/orchestration.ts:6`).
- PyPersona's `/prompt --target` posture asks for "the reconnaissance the agent must perform before any change", the objective, relevant files, implementation order, explicit non-goals, safety constraints, testing requirements, the definition of done and the expected final report (`P:p/core/imode/postures.py:302-312`).
- Its `/handoff` contract lists goals, current state, constraints, files touched and next steps (`P:p/data/config/commands.json`).

**Change.** Add a one-sentence structure hint to the `prompt` description of `sessions.start` and `sessions.send`.

**Acceptance.** The golden payload for a tool-enabled turn changes only in that description, and the fixture is updated deliberately.

**Owner decision D7.** This is a model-facing change with no measured benefit.

## 7. New findings from the PyPersona source

### 7.1 Contradictions with the original inventory

| ID | Row | Original claim | What the source shows | Impact |
| --- | --- | --- | --- | --- |
| IC-01 | C21 | "Missed-run policy: … skip/run-once/bounded catch-up, handles sleep/time jumps" | `_runs_for` returns 1 for both `skip` and `run_once` once any occurrence was missed, so they are identical (`P:p/plugin/crontab/scheduler.py:264-280`). Job state is in memory only (`:152`), and new jobs plan from now (`:187`), so occurrences missed while the app was closed are never seen, despite the module docstring (`:25-29`). The plugin is disabled by default (`config.json:487`). | Cere M14 is stronger; no change |
| IC-02 | C13, H27 | "per-server headers", "per-server sessions/calls" | Only an `Authorization` header (`P:p/plugin/mcp/worker.py:257-262`). Each call batch opens a new session, which for stdio means a new process. `call_tool` has no timeout (`:107`); only discovery has 8 s (`plugin.py:196, 275`). | Cere A02 is stronger |
| IC-03 | P24–P27 | Production capture caller "not verified" | No caller of `ingest_project` or `ingest_files` exists in `src/`; only tests call them. Production code recall and analysis read an empty graph. | Decisive for A03 (§5.1) |
| IC-04 | X09 | "unindexed items default not-private" | That, and also: YAML errors or a missing PyYAML make a note not private (`P:p/core/notes/parser.py:152-158`). The key is `pypersona_private`, not `private`. Model access is off by default with `active_folder` scope (`config.json:383-389`). | Supports RC-01 and RC-10 |
| IC-05 | X02 | "modes carry narrow tool ceilings and retrieval scopes" | Only `none` changes retrieval, by turning it off (`profile.py:130-147`). The other scopes decide only whether the bound project's decisions, tasks and state are injected (`p/controller/imode/imode.py:203-225`), plus one next-step hint (`postures.py:350-362`); they never partition persona or graph retrieval. A `deny` ceiling drops calls at dispatch (`p/controller/chat/command.py:71-73`), but the tools are still offered (`p/core/command/command.py:411-429`). | RC-02; Cere's tool ceiling is stronger |
| IC-06 | U18 | "cached MP3 paths keyed by text with count pruning" | True, and the shipped defaults enable it with up to 1,000 files (`config.json:111-112`) while the code fallback is off and 10 (`plugin/audio_output/plugin.py:181-182`). The output plugin is disabled by default (`config.json:476`). | Adds a retention concern; supports §5.2 |
| IC-07 | U21–U23, U27 | Application integration "not established" | `TaskSupervisor` and `GuiGateway` are constructed in `P:p/ui/main.py:110-113`. Plugin workers record supervisor accounting but start immediately on the shared pool (`p/plugin/base/worker.py:296-313`). No `GuiGateway.commit` caller exists. The heartbeat is started at `ui/main.py:253` (inert unless diagnostics are on, `:270-290`), and `ShutdownCoordinator` runs named phases at close (`:428, 446-500`). | None; Cere A04 has real admission |
| IC-08 | P33 | "Neutral trait values emit no tokens" | Trait axes have 5, 3, 3, 3 and 4 values (`p/item/style_traits.py:35-41`). Humor has no neutral value: every humor value emits an instruction (`:62-64`). | None; Cere's uniform −2…2 scale is a deliberate simplification |

### 7.2 Precision the inventory lacked

| ID | Row | Detail | Used by |
| --- | --- | --- | --- |
| IC-09 | H22 | Loop detection is a model-facing prompt nudge, on by default inside a harness plugin that is itself off by default (`p/plugin/cmd_code_interpreter/plugin.py:377-414`; `p/data/config/config.json:479`) | RC-05 |
| IC-10 | X03 | The section rule: strip leading markers, a prefix match, then an anywhere-in-text fallback (`p/core/imode/contract.py:47-66`) | RC-03 |
| IC-11 | H20 | An applied edit resets every gate to pending, through the harness's own apply path only (`p/plugin/cmd_code_interpreter/harness/commands/apply_edit.py:25-34, 56`) | RC-04 |
| IC-12 | C07 | Pre-migration backup with `integrity_check`, removed when history is cleared (`p/core/db/database.py:574-650`) | NF-01 / S4 |
| IC-13 | License | The package-level `P:src/pypersona/LICENSE` names only "2026 Marcin Szczygliński", while the root `P:LICENSE` carries both the PyGPT (2023–2025) and Otectus (2026) notices; file headers say "Created By: Otectus" | Matters only if code is ever copied; preserve the root notice |
| IC-14 | U15 | Local Whisper loads its model on every transcription (`p/provider/audio_input/openai_whisper_local.py`) | Supports leaving M10's interface unbuilt |
| IC-15 | U01 | The default send mode is Shift+Enter (`config.json:582`; `p/ui/layout/chat/input.py:209-215`) | None; Cere's choice is deliberate |
| IC-16 | P31 | Answer modes pair instructions with thresholds 0.5, 0.3 and 0.0 (`p/core/memory/retrieval.py:46-62`) | RC-09 |
| IC-17 | X04 | Project tasks have no status or lifecycle (`p/core/imode/project_state.py:45, 151-170`) | §6.3: Cere's M08 lifecycle is the only basis for task binding |
| IC-18 | C13 | Allowed and disabled lists hide tools during discovery (`p/plugin/mcp/plugin.py:232-233, 288-290`) | RC-13 |
| IC-19 | H34 | Repository rules are redacted before injection (`p/plugin/cmd_code_interpreter/harness/rules.py:116-135`) | RC-12 |

### 7.3 Mechanisms outside the inventory, considered

| Mechanism | Evidence | Disposition |
| --- | --- | --- |
| `/summarize --mode` output shapes (brief, technical, executive, action items, changelog, decision log) | `p/core/imode/postures.py:163-170` | Not adopted. Recipes with M17 output sections can express these if requested. |
| Next-command hints (research → plan → prompt → code → review) | `postures.py:261-268` | Not adopted; low value |
| `/prompt --target` work-order shape | `postures.py:302-312` | NF-02 (optional) |
| Plan contract variants (`--deep`, `--quick`) | `p/core/imode/profile.py:150-166`; `commands.json` | Not adopted |

## 8. Delivery order, dependencies and exit conditions

```
S1 preserve ──┬── S2 privacy (RC-01) ──┐
              ├── S3 pins + golden test ─┼── S5 records ── S6 re-baseline (+ authorized reinstall)
              └── S4 pre-migration backup┘
S3 ── R: RC-02, RC-03, RC-04, RC-05 (independent of each other)
S3 ── R2: RC-06, RC-07, RC-12, RC-13 (independent)
S1 ── EV-01 (owner-authorized; independent of R)
Triggers only: RC-08, RC-09 (measure first), RC-10, RC-11, NF-02, EV-02 → M11, A05 task binding (§6.3), A03 re-entry (§5.1), M10/M18/M19/A07/A08/A02-HTTP
S4 before any new memory migration (including A05 task binding if it ever needs one)
```

| Stage | Items | Exit condition |
| --- | --- | --- |
| S | S1–S6 | The work is committed. The privacy cases are fixed with tests. Migration checksums are pinned. The golden payload check is in the repository. The pre-migration backup works. The records are accurate. The re-baseline matches §2.2 apart from the known failures. |
| R | RC-02–RC-05 | Each item meets its acceptance criteria. Golden payloads are unchanged for turns that use none of the features. The full npm test run and the affected UI slots pass. |
| R2 | RC-06, RC-07, RC-12, RC-13 | As for R |
| E | EV-01 | Per-model results are committed, the gates are reported honestly, and the default model is reconsidered |
| D | Triggered items | Built only when the trigger in §5 or §6 fires, with the original plan's acceptance criteria |

## 9. Validation approach

### 9.1 Commands

Run from `C:` (from `VALIDATION.md` and the prior session's logs):

- `npm run typecheck`
- `git diff --check`
- `CERE_TTS_DISABLED=1 npm test`
- `cmake --build build --parallel 8`
- `ctest --test-dir build --output-on-failure`
- `QT_QPA_PLATFORM=offscreen:configfile=$PWD/tests/fixtures/offscreen-scales.json QT_QUICK_BACKEND=software QT_QUICK_CONTROLS_STYLE=Basic ./build/cere-ui-check [slot …]`
- `node benchmarks/memory/nl-baseline.ts` and `node benchmarks/memory/document-baseline.ts` (their floors are pinned by `tests/memory-nl-baseline.test.ts` and `tests/document-baseline.test.ts`)

### 9.2 Expected failures that are not regressions

- `tests/avatar-surface-motion.test.ts` (artwork)
- UI slot `reviewTransitions`
- the GPU `avatar` ctest
- 9 UI skips that need a live compositor or Spotify

Any other failure is new.

### 9.3 Environment rules

- **Process priority.** Tests compare against the parent's nice value, because `ananicy-cpp` renices `node`.
- **Memory health.** Tests use temporary stores and do not depend on `cere-memory.service`. Live "degraded" memory while Qdrant or Neo4j is down is not a regression, and canonical recall still answers.
- **Live store.** Never run checks against the live memory directory. Measure on a `VACUUM INTO` copy.
- **Provider checks.** Live provider checks need an isolated broker: any `CERE_STATE_DIR`, and a short `CERE_RUNTIME_DIR` such as `$XDG_RUNTIME_DIR/cere-livecheck`, because a Unix socket path is at most 108 bytes.
- **Native dialogs.** Native file dialogs cannot be driven offscreen. Cover them with broker tests and RPC-level UI checks, as the prior session did.

### 9.4 Activation, only with explicit owner authorization

The established safe order on this machine is below. Verify each command before use.

1. Check for busy sessions. A broker restart interrupts running Claude and Codex turns and does not replay them.
2. Quit the interface through the broker so drafts are flushed: `node ~/.local/share/cere/broker/cli.ts ui.quit`, which sends `stopTasks: false`.
3. Run `python3 tools/install-user.py`. Installing while the interface runs replaces mapped libraries, and the old interface crashed on 12 October when that was done.
4. Run `systemctl --user restart cere-broker.service`.
5. Relaunch with `systemctl --user start app-cere@autostart.service`.
6. Confirm with `diff -rq broker ~/.local/share/cere/broker` and `systemctl --user is-active cere-broker.service`.

## 10. Scope

**In scope:**

- Stage S;
- the RC corrections listed in §4.2;
- EV-01, with owner authorization;
- the decisions and triggers for A03, M11, A05 task binding, M10's interface, Slice 6 and the A02 HTTP transport;
- record corrections in `VALIDATION.md` and the tracker.

**Out of scope:**

- **Standing exclusions:**
  - everything rejected in R01–R12 (workbench framework, JSONL memory, pin-as-truth, emotion engine, Jinja templates, bulk plugin parity; LanceDB, Zep, Graphiti or Docker for parity);
  - re-architecture of E01–E06;
  - new chat providers;
  - cloud ASR.
- **Requires authorization:**
  - installing or restarting services without authorization;
  - restoring `artwork/` without the owner's decision.
- **Not part of this plan:**
  - the Qdrant readiness failure in `tools/memory-dependencies.sh` (an operations item);
  - README documentation of the new features (owner decision D8; the global rule is no unrequested documentation);
  - choosing a license for Cere (still the owner's decision; no PyPersona code or assets have been copied).

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| The working tree is lost or reverted while the live store depends on migration 5 | S1 first, the S3 pin test, and S4 before any further migration |
| The vault is enabled before RC-01 is installed | Keep the vault off until S2 and S6 are done; note it in the commit message and in Health |
| RC-03 now under-reports missing sections | That is acceptable: contracts are warnings, and PyPersona's rule is to prefer under-reporting |
| RC-04 marks checks stale because of build outputs | Telemetry exclusions and `.gitignore`; label unobservable cwds |
| RC-02 changes recall for existing styles with `memory:false` | It uses a new `recall` key, so existing styles are unchanged; none exist on this machine |
| EV-01 costs money or sends private data | Synthetic data only, the flag, per-model approval and pinned digests; the offline analysis runs on a copy |
| Pre-migration backups physically retain text that is erased later | Restore re-applies the current erasure registry; 14-day retention; deletion offered in the forget preview |
| UI slot races, as seen in the prior session | Reuse the `stableClick` and settled-list helpers in `tests/ui.cpp`; rerun a failing slot alone before diagnosing |
| The installation and the working tree drift apart again | S5 records; the `diff -rq` check in §9.4 |

## 12. Decisions the owner must make

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Authorize commits (S1): branch, split, whether to include `prompts/` | Commit on `ui-overhaul` as A, B and C; include `prompts/` only if you want the plans versioned |
| D2 | `artwork/`: restore it, or update the avatar-surface test fixture | Your call. The artwork was moved to `~/Pictures/artwork` before the prior session, and nobody should restore it without asking (`T:PROGRESS.md:10`). |
| D3 | Whether a style that withholds recall also skips memory capture (RC-02) | No; temporary conversations remain the way to leave nothing behind |
| D4 | Apply vault privacy rules to collection Markdown files (RC-01) | Yes |
| D5 | Authorize EV-01: models, budget, reading a copy of the live store | Yes, for the three models in §6.2 |
| D6 | Pre-migration backup retention (S4) | Newest two, deleted after 14 days or on clear-all |
| D7 | NF-02 delegation guidance (model-facing) | Optional; low risk |
| D8 | Document the new features in `README.md` | Your call |
| D9 | Task-binding semantics if A05 task binding is triggered | Thread and anchor inside the project scope |
| D10 | Reinstall after Stage S (S6) | Yes, following §9.4 |

## Appendix A — Evidence commands and probes

### A.1 Commands run in this review (all read-only)

- PyPersona:
  - `git -C ~/Projects/PyPersona log -5 --format='%H %ad %an %s' --date=iso`
  - `git status --short`, `git status`, `git remote -v`, `git branch -a`, `git rev-parse HEAD`
  - `git status --ignored --short` (no output)
  - `GIT_TERMINAL_PROMPT=0 timeout 20 git ls-remote origin`
  - `git show --stat origin/dependabot/github_actions/actions-962aee6d35`
  - `git merge-base --is-ancestor 918a1ab origin/dependabot/…`
  - `git cat-file -t 3d787a2…` and `git branch -a --contains 3d787a2…`
- PyPersona file counts: `find src -name '*.py' | wc -l` (1,568); `find tests -name '*.py' | wc -l` (562); `find tests -name 'test_*.py' | wc -l` (536). Parsing `pyproject.toml` with `python3 -I`.
- Cere:
  - `git status --porcelain --untracked-files=all`
  - `git diff --shortstat -- . ':(exclude)artwork'`
  - `find broker qml native tests tools benchmarks docs README.md VALIDATION.md CMakeLists.txt -newer ~/.cache/cere-pypersona/final/ui-check-full-2.log -type f` (only `VALIDATION.md`)
- Installation:
  - `diff -rq broker ~/.local/share/cere/broker` (no output)
  - `diff -rq qml ~/.local/share/cere/qml` (one stale installed file)
  - `ls -la --time-style=full-iso` of the installation and state directories
  - `cmp ~/.local/lib/cere/cere build/cere` (sizes equal; the bytes differ, consistent with the installer rewriting the installed binary)
  - `ps -eo pid,lstart,cmd`
  - `systemctl --user status cere-memory.service`
  - `journalctl --user -u cere-broker.service --since "2026-10-15 21:20"`
  - `journalctl --user -u cere-memory.service -n 25`
- Live databases: `sqlite3 -readonly "file:$HOME/.local/state/cere/…?mode=ro"` with aggregate queries only:
  - `sessions` by `json_extract(data,'$.provider')` with `parentId` counts and time span;
  - `activity` by action with time span;
  - `meta` keys grouped by prefix;
  - `settings` fields (feature switches only);
  - `workflow:results` counted by outcome and verification;
  - turn-plan layer counts;
  - `schema_migrations` IDs and checksums;
  - `extraction_runs` by model and status;
  - `assertion_versions` joined to `extraction_runs` by status and epistemic type.
- PyPersona source was read with `sed -n` and `grep -n` on the files cited in §4–§7, plus the plugin defaults in `src/pypersona/data/config/config.json`.

### A.2 Recorded results reused

The results are in `T:final/*.log`, `T:slice4/golden-{head-today,final}.json` and `T:PROGRESS.md` (§2.2).

### A.3 Probes

Run with `node <file>` from any directory. They import working-tree modules and change nothing.

Probe 1 — sections and style checks:

```js
const { checkSections } = await import('/home/otectus/Projects/cere/broker/output-contracts.ts');
const { checkReply } = await import('/home/otectus/Projects/cere/broker/style-checks.ts');
for (const c of ['## 1. Findings','## Findings and evidence','### Risks (high level)','1. **Findings**','Findings','**Findings:**','## Findings'])
  console.log(JSON.stringify(c), checkSections(c, [c.includes('Risks') ? 'Risks' : 'Findings'])[0].present);
console.log(checkReply('a | b\n--- | ---\n1 | 2', ['no-markdown-table']));          // [] (missed)
console.log(checkReply('| a |\n| --- |\n| 1 |', ['no-markdown-table']));            // [] (missed)
console.log(checkReply('| a | b |\n|-|-|\n| 1 | 2 |', ['no-markdown-table']));      // [] (missed)
console.log(checkReply('Copyright © 2026, Cere™ ↔ ok ✓', ['no-emoji']));            // count 3
```

Result: the first five sections printed `false`, the last two `true`, with the table and emoji results noted in the comments.

Probe 2 — vault privacy:

```js
const { frontMatter, privateNote } = await import('/home/otectus/Projects/cere/broker/notes-vault.ts');
const cases = { lf:'---\nprivate: true\n---\nbody', crlf:'---\r\nprivate: true\r\n---\r\nbody', bom:'\uFEFF---\nprivate: true\n---\nbody',
  spacedKey:'---\ndate created: 2026-01-01\nprivate: true\n---\nbody', nested:'---\nmeta:\n  owner: me\n---\nbody', dotsEnd:'---\nprivate: true\n...\nbody',
  yes:'---\nprivate: yes\n---\nbody', quotedTrue:'---\nprivate: "true"\n---\nbody', trailingSpaceFence:'--- \nprivate: true\n---\nbody' };
for (const [k, v] of Object.entries(cases)) { const m = frontMatter(v); console.log(k, JSON.stringify(m), privateNote(m)); }
```

Result: as in the S2 table.

Probe 3 — migration checksums:

```js
const s = await import('/home/otectus/Projects/cere/broker/graph-memory/schema.ts');
const { createHash } = await import('node:crypto');
console.log(1, createHash('sha256').update(s.schema).digest('hex'));
for (const m of s.migrations) console.log(m.id, createHash('sha256').update(m.sql).digest('hex'));
```

Result: equal to the live `schema_migrations` checksums in §2.3.

## Appendix B — Reconciliation matrix for Slices 0–5

The "Depth" column records how closely the PyPersona source was checked in this review: **Read** means the cited mechanism was read; **Spot** means a targeted grep or partial read; **Inventory** means it was not re-read and the original row stands. No work in this plan depends on an *Inventory* row.

| Proposal | PyPersona rows | Depth | Verdict | Follow-up |
| --- | --- | --- | --- | --- |
| Q01 behavior presets | P01–P02, P33, U44 | Inventory | Faithful adaptation | — |
| Q02 recipe starters and palette | C04, X01, U01, U40 | Read (`commands.json`, 18 commands) | Faithful | NF-02 optional |
| Q03 personality preview | P04, P34, U08, U44 | Read (`style/resolver.py` measures characters and tokens) | Faithful | — |
| Q04 recall outcomes | P08, P17, P21, C29, U08, U29 | Spot (`persona/retrieval.py:62-77`) | Faithful | RC-02 adds `style_withheld` |
| Q05 web trace | C18–C19, U13 | Read (`cmd_web/plan.py`, `cache.py`, `websearch.py:230-330`) | Faithful | — |
| Q06 tool progress | H22–H23 | Read | Partial: identical-call signal only | RC-05 |
| Q07 regressions | C06, H37, U30–U33 | n/a | n/a | S3 golden test |
| Q08 send keys | U01–U03 | Spot | Deliberate difference (IC-15) | — |
| M08 capsule tasks | X04–X06, P27, H18, U09 | Read (`project_state.py`) | Cere is richer (PyPersona tasks have no lifecycle) | §6.3 |
| A01 context plan | P04–P05, P28, C04–C05, H17, H29–H30 | Spot (`prompt.py:280-425`) | Faithful; byte-identical to `HEAD` | S3 moves the golden test in |
| M03 continuity | P07, P09–P12, C05 | Read (`persona/memory.py`) | Deliberately extractive; loses the opening turn first | RC-08 (trigger) |
| M04 context inspector | P28, P31, C05, U08, U11–U12, H29–H30 | Spot | Faithful | — |
| A05 gates | P03, P09–P23, P28–P32, … | Inventory | Faithful; PyPersona has no evaluation equivalent | EV-01, §6.3 |
| M05 pins and timeline | P15–P17, P21–P23, U06–U10 | Inventory | Faithful; pins mean retention, not truth (R03) | — |
| M01 profiles and postures | P01–P03, P06, P33–P34, P37, X02 | Read | Tool ceiling stronger; lacks a recall-off posture | RC-02 |
| M02 checkpoints and checks | P33–P36, U44 | Read | Faithful; adds restore; detector gaps; no conflict warnings | RC-06, RC-07 |
| M07 notes vault | X07–X10, C25 | Read | Fail-open defect; no ignore rules or scope | RC-01, RC-10 |
| M06 collections | P08, P18, P28–P32, C14–C15, U11–U12, U34 | Read (`memory/retrieval.py`) | Faithful; modes lack thresholds | RC-09 |
| M15 export | U37, U40–U42, H16 | Inventory | Faithful | — |
| M20 file transcription | U15, U34, U39 | Spot (`audio_input/base.py`) | Faithful | — |
| M09 local models | X11–X14, C02, P18–P20 | Spot (`controller/ollama/models.py`) | Faithful; no disk warning | RC-11 |
| A06 packages and conventions | P01–P06, P33–P36, C04, H25, H34 | Read (`harness/rules.py`) | Faithful; no redaction | RC-12 |
| M12 search constraints and cache | C18–C20, U13 | Read | Deliberate differences (§4.3) | — |
| M13 compatible endpoint | C02, C12, H17, H30 | Inventory | Faithful | — |
| A02 MCP client | C08–C13, H01–H08, H25–H28, … | Read | Stronger; no tool hiding | RC-13 |
| M23 custom tools | C23, H06, H36 | Spot (`cmd_custom/worker.py`, `proc/argv.py`) | Stronger | — |
| M17 gates and contracts | X03, C17, H14–H15, H18–H20, H32 | Read | Strict matching; no invalidation after edits | RC-03, RC-04 |
| M10 audio devices | U15, U17 | Inventory | Faithful | — |
| M21 voice commands | U18, U20 | Inventory | Deliberately deterministic | — |
| M16 spans | U21–U29, C29, H07 | Read (`diagnostics/spans.py`, heartbeat wiring) | Broader than PyPersona | EV-02 optional |
| A04 jobs | P11, P20, P23, P30, C09, H04, H11, H19, H23–H24, H28, U21–U23 | Read (`ui/main.py`, `plugin/base/worker.py`) | Stronger (IC-07) | — |
| M22 file proposals | H05, H12–H13, H21 | Read (`harness/diff_workflow.py`) | Faithful and stronger | — |
| M14 schedules | C09, C21, H04 | Read | Stronger (IC-01) | — |
