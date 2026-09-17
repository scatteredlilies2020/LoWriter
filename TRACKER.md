# Work tracker

Updated 2026-09-17. Keep this checklist concise; detailed working notes stay local. Optional ideas are not commitments.

## Unfinished
- [ ] Runtime-inclusive Windows package, standalone Android app and easy Termux launch path.
- [ ] Fuller ST card compatibility: macro/world-info scheduling behavior, defined extension support and ST-format re-export. Preserving fields does not implement every extension.
- [ ] Portable chat/card/lore/media bundles, including image/audio bytes and reviewed memory corrections.
- [ ] Encrypted cross-device sync, enrollment and recovery.
- [ ] Story-only Continuity improvements: recursive promotion, targeted repairs, durable queues, cost controls and large-chat indexing. Preserve optional activation and selectable AI.
- [ ] Chapter/bookmark navigation; decide on opt-in restart-safe drafts (currently in-tab only).

## Optional / needs design
- [ ] Automatic multi-voice narration, lip sync, sound effects/music and broader media/video support.
- [ ] Bundled or managed Tor/I2P routers; current routing requires an external router.
- [ ] Permissioned browser/shell/desktop tools for Assistant; not available today.

## Verification remaining
- [ ] Physical Windows CMD close-button/Ctrl+C checks, including closure during startup; forced-process shutdown and reopening already pass automated tests.
- [ ] Real Android/Termux installation, credential storage, background recovery, shutdown, updates/data retention, battery and RAM testing.
- [ ] Broader authorized live-provider/image/voice and audible playback tests. Reported Tor generation success is not a full integration acceptance pass.
- [ ] Dedicated browser checks for memory corrections and authored narrative; visual review of idle animation.
- [ ] Broader security, performance and long-chat hardening.

## Completed baseline
- [x] Chat loading; cards/personas/lore; optional portraits and idle motion; configurable additional instructions.
- [x] Optional story-only memory with selectable AI; regenerate/swipes/continue/branches.
- [x] Image variants, saved voices, Markdown editing and appearance presets.
- [x] Console-owned startup/shutdown fix published in e9d02aa. Full suite: 132 passed; final launcher checks: 14 passed; strict TypeScript and build passed. Device/live-provider checks above remain separate.
