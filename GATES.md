# Gates: Native stuck wakeup

Scope: configurable stuck detection wakes one coordinator agent exactly once per stuck episode, enabling event-driven recovery without PM sleep/poll loops.

- [x] G1: config defaults `stuckWakeAgent` to null and accepts a project override
  CHECK: bun run test tests/config.test.ts
  EXPECT: /4 passed|4 tests/
  EVIDENCE: Vitest: tests/config.test.ts 4 tests passed; default-null and project-override tests green.

- [x] G2: configured coordinator receives a steering turn exactly once when a reserved peer crosses the configured threshold
  CHECK: bun run test tests/status-heartbeat.test.ts -t "wakes the configured coordinator"
  EXPECT: /1 passed|1 test/
  EVIDENCE: integration test green; asserts customType agent_stuck, triggerTurn true, deliverAs steer, and no repeat during the same stuck episode.

- [x] G3: configurable threshold is effective below the prior hardcoded five-minute idle floor
  EVIDENCE: status heartbeat test uses threshold 60 seconds and a peer idle 120 seconds; prior implementation failed red because computeStatus returned idle until 5 minutes; reordered logic makes it pass.

- [x] G4: README documents the new option and project config targets the monitor
  EVIDENCE: README configuration sample/table includes `stuckWakeAgent`; hackgong `.pi/pi-messenger.json` sets threshold 120, stuckNotify true, stuckWakeAgent mesh-monitor.

- [x] G5: live hackgong monitor wakes from a native stuck event
  EVIDENCE: at 12:12 messenger logged s2-realplans stuck; at 12:13 Herdr reported mesh-monitor working and its pane showed `herdr agent list` inspection caused by the injected stuck steering turn. No PM sleep or polling command was active.

- [x] G6: focused tests pass
  CHECK: bun run test tests/config.test.ts tests/status-heartbeat.test.ts
  EXPECT: /2 passed|2 tests/
  EVIDENCE: 2 test files, 7 tests passed.

- [x] G7: Full-suite green
  CHECK: bun run test
  EXPECT: /46 passed/
  EVIDENCE: Vitest: 46 test files, 425 tests passed with mocked pi-tui in tests/crew/team-overlay-render.test.ts matching sibling test files.

- [x] G8: Whole-repo tsc green
  CHECK: bun x tsc --noEmit
  EXPECT: exit code 0
  EVIDENCE: TypeScript compiler passes with 0 diagnostics after typing registerTool parameters as PiSchema and removing unsupported promptSnippet property.

# Gates: SDK 18.2.7 update and self-contained tool rendering

Scope: peer deps bumped to the current SDK (`@oh-my-pi/*` 18.2.7, floor `>=18.2.6`); omp_messenger renders its own hub-style IRC cards without deep imports into `@oh-my-pi/pi-coding-agent` or pi-tui subpaths, which the compiled omp binary cannot resolve (`Failed to load extension: Cannot find package '@oh-my-pi/pi-tui'` / `'@oh-my-pi/pi-utils'` — deep subpaths resolve to the filesystem copy and their nested `@oh-my-pi/*` imports fail under the binary's embedded-module loader; the package root maps to the embedded copy and loads fine).

- [x] R1: no runtime imports beyond `@oh-my-pi/pi-coding-agent` (root/types), `@oh-my-pi/pi-tui` (root), `@oh-my-pi/pi-ai` (types), typebox
  CHECK: grep index.ts for @oh-my-pi import specifiers
  EVIDENCE: only root specifiers + type-only imports remain; renderer state comes from the `theme` renderer argument.

- [x] R2: merged call+result frame, no duplicated message body
  EVIDENCE: tests/bun/tool-renderers.test.ts asserts mergeCallAndResult true and that pending shows header + one dim preview line while the delivered result shows the quoted body once.

- [x] R3: every action renders visibly (status-line fallback)
  EVIDENCE: same file asserts pending/result status lines for non-messaging actions (channels, leave).

- [x] R4: full suites green on 18.2.7
  CHECK: bun x tsc --noEmit && bun run test
  EVIDENCE: tsc 0 diagnostics; Vitest 44 files / 411 tests passed; bun test 92 passed.

- [x] R5: extension loads in the real compiled-binary TUI
  CHECK: omp --profile debug session in /tmp/omp-tui-check; inspect ~/.omp/profiles/debug/logs/omp.2026-09-21.31410.log; ask the agent for tool presence
  EVIDENCE: no "Failed to load extension" entry (previously logged immediately at startup); agent answered TOOL_PRESENT.

# Gates: Review triage (blockers + selected majors)

Scope: address review findings from range `acd18bb..HEAD` — all 4 blockers verified and fixed; selected high-leverage majors fixed across security, durability, routing, packaging, and config.

- [x] T1: B1 — feed.jsonl preserved across session starts
  EVIDENCE: removed unconditional `fs.rmSync` in `session_start` (index.ts); feed retention is handled exclusively by `pruneFeed`.

- [x] T2: B2 — mesh server stamps authenticated sender identity
  EVIDENCE: `mesh/server.ts` forces `from: ws.data.name` and `to: frame.to` on incoming send frames, preventing sender impersonation.

- [x] T3: B3 / M12 — atomic message publish + quarantine durability
  EVIDENCE: `mesh/fs.ts` writes messages to a `.tmp` sibling with UUID filenames before atomic rename, avoiding partial reads by fast watchers and eliminating timestamp collisions; unreadable/corrupt messages are renamed to `.dead` rather than deleted, with a 24-hour prune cycle.

- [x] T4: B4 / M13 — idle receivers wake via steer + triggerTurn
  EVIDENCE: `deliverMessage` routes non-gentle messages via `steer + triggerTurn` unconditionally, ensuring real peer messages wake idle and Esc'd sessions (SDK's `irc:incoming` carve-out in `#resumeStrandedIrcAsides`); gentle messages remain `aside`. `tests/delivery-mode.test.ts` updated to match.

- [x] T5: M5 — auto-generated agent names sanitized
  EVIDENCE: `lib.ts` filters custom words to valid identifier characters (`/^[A-Za-z][A-Za-z0-9_-]*$/`) before composition; `mesh/fs.ts` verifies generated names with `isValidAgentName` before registration.

- [x] T6: M8 — corrupt claims/completions store refuses mutation
  EVIDENCE: `assertStoreReadable` in `mesh/fs.ts` quarantines corrupt JSON stores to `.corrupt-<ts>` and throws to block read-modify-write data loss.

- [x] T7: M14 / M15 — channel join reconciliation and guarded full leave
  EVIDENCE: `executeJoin` calls `mesh.join` when registered with channels to reconcile membership; `executeLeaveChannels` delegates to `executeLeave` when leaving all channels, enforcing planning/autonomous/task/claim safety guards.

- [x] T8: M18 — channel wire validation
  EVIDENCE: `normalizeAgentMailMessage` validates wire `channel` strings via `isValidChannelName`, discarding invalid channel names.

- [x] T9: M1 — server-side inbox ownership tracking with reconnect reclaim
  EVIDENCE: `mesh/server.ts` tracks inbox ownership via an `inboxOwners` map; stale/zombie sockets are evicted on reconnect rather than returning `name_taken`. Client retries up to 5 times before giving up.

- [x] T10: M25 / M31 / M28 — packaging, peer range, and shebang
  EVIDENCE: `package.json` `files` explicitly specifies `mesh/*.ts`, `mesh/Dockerfile`, `mesh/docker-compose.yml`, excluding `mesh/.env` (verified via `npm pack --dry-run`: 68 files, no `.env`); peer dependencies capped at `^18.2.6`; `mesh/server.ts` adds `#!/usr/bin/env bun` shebang.

- [x] T11: M26 / M27 / M33 — config fallback, token preservation, parse warnings, and bounds
  EVIDENCE: `config.ts` falls back from `.omp` to legacy `.pi` paths for user config, project config, and token file; `saveMeshSettings` preserves existing inline JSON tokens; `readJsonFile` emits warnings on malformed JSON; `feedRetention` (1..10000) and `stuckThreshold` (5..86400) clamped.

- [x] T12: M29 — CHANGELOG updated for 0.16.0
  EVIDENCE: `CHANGELOG.md` documents 0.16.0 breaking changes (tool/pkg rename, config/storage move, env vars, SDK peer floor), features, and fixes.

- [x] T13: Full verification pass
  CHECK: bun x tsc --noEmit && bun run test:node && bun run test:bun
  EVIDENCE: tsc 0 diagnostics; Vitest 44 files / 411 passed; Bun 8 files / 92 passed (503 total).
