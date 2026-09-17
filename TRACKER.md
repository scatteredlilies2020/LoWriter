# Work tracker

Updated 2026-09-17. Keep this checklist concise; detailed working notes stay local. Optional ideas are not commitments.

## Next session first: chat organization overhaul
User priority: make chats easy to locate, clearly separate Story from Assistant, and make deletion obvious. Plan recorded before departure; the changes below are NOT implemented yet. Do this before adding more story features.

Confirmed design rule: remove ST's feature bloat and clunky workflows, NOT its useful separation into categories. Keep Chats, Cards/worlds, Personas, Lorebooks, Connections, Presets and Appearance clearly distinguishable and directly accessible. Do not collapse them into a miscellaneous setup panel, replace resource categories with chat folders, or reproduce ST's full extension UI. Optional complexity stays inside the relevant category; categories do not impose a writing style or require one card per character.

Current verified gaps: the sidebar filters by workspace, but Load chats mixes Story and Assistant. Naming varies between Writing, Writing room and Story. Rename/export are buried in the loader. There is no chat-delete control, and no user-defined folder/category organization.

### Proposed organization
- [ ] Use two consistent top-level workspaces: Story and Assistant. Assistant remains general-purpose, including coding; Story stays free-form, not separate RP/co-writing/revision modes.
- [ ] Each workspace owns its sidebar, chat library, counts, search, recent list and new-chat action. Default to the current workspace everywhere; any cross-workspace search must be explicit and results clearly labeled.
- [ ] Within each workspace, offer optional user-named folders/collections and an Unfiled location. These organize chats only, not writing styles or prompt presets. One world/cast can have multiple chats; no required per-character cards or group-chat turns.
- [ ] Confirmed: Story has BOTH card-organized chats and card-free categories. Starting a chat from a card automatically places it under that card (Story > Card/world > Chats), with multiple independent chats per card. A card may describe a whole cast/world, not just one character. Do not put card-started chats into a generic Unfiled list by default.
- [ ] Card-free Story chats still support freely created, user-named categories and standalone chats without requiring a card. Card-free chats keep access to optional lore, personas and Continuity. Free categories complement card-based organization; they do not replace it.
- [ ] Story-only personas: provide a default user persona for new story chats and separately saved/selectable personas to override it per chat. Personas are independent of the card/cast being written about. Show the active persona clearly; changing one chat's persona must not change another chat or the default. Changing the default must not silently overwrite existing chats' selected personas or past messages.
- [ ] Confirmed: Assistant (general use and coding) supports both free categories/projectless chats AND separate project categories, in the spirit of Codex's project organization. A project groups multiple chats around an explicitly selected local project folder; ordinary questions and coding discussions never require a project.
- [ ] Assistant has no persona setup/selector and does not inherit or inject Story personas. Keep ordinary Assistant instructions/settings separate from Story identity features.
- [ ] Show where the open chat belongs: Story > card or free category > chat; Assistant > project or free category > chat, with standalone/Unfiled locations available. Make rename and move available on each chat, without opening import settings. Organizational moves must not silently change prompts, memory, model, card assignment, persona or project access. Attaching/changing a project's folder or granting tools requires an explicit action and existing trust checks; a project category alone grants no file access.
- [ ] Keep Cards, Lorebooks, Personas, Setup presets and Connections distinct from chat folders. Audit the information hierarchy and labels before implementation; avoid one miscellaneous settings panel containing unrelated actions.

### Visible chat management
- [ ] Put a clearly labeled chat menu beside each sidebar/library item and in the open-chat header: Rename, Move, Export, Delete. Support touch and keyboard, not hover-only or right-click-only controls.
- [ ] Default Delete to recoverable Trash with Restore; require explicit confirmation for permanent deletion and explain what is removed. Archive, if added, must be a separate action rather than a misleading substitute for Delete.
- [ ] Define deletion ownership for messages, swipes, story setup/history, memory, media and branches. Never remove shared cards, presets, connections or files from a trusted project. Prevent active generation/media/memory jobs from writing back into removed chats.
- [ ] Separate browsing chats from Import/Export utilities. Imported chats and branches must have a visible destination; preserve their workspace and show the resulting location. No silent conversion of Story to Assistant or vice versa.

### Implementation order and acceptance
1. [ ] Review a compact navigation/layout proposal, including desktop and mobile, against these priorities before a broad UI rewrite.
2. [ ] Add safe persistence/migration for card associations, free categories, project categories, Story persona defaults/overrides and Trash. Existing IDs, chat content, variants, setup, memory, attachments, personas and project associations stay intact. Preserve known card associations; do not guess shared card identity from matching names. Chats without a known organizational association become Unfiled in their original workspace without requiring cards or projects. Test migration on copies, not personal data.
3. [ ] Implement workspace-scoped browsing/search and discoverable chat actions, then reorganize related settings. Preserve unsaved edits and selected chat/location when navigating.
4. [ ] Verify: no mixed default lists; create/load/import/branch land in the correct workspace; rename/move survive restart; delete/restore/permanent-delete handle open chats and active jobs safely; no unrelated data is removed; mobile/keyboard controls and empty states work.
5. [ ] Verify card-started chats automatically appear under the right card, multiple independent chats per card, card-free Story categories, projectless Assistant categories, multiple chats per project, persistent locations and no implicit card attachment or project permission escalation when moving chats.
6. [ ] Verify new Story chats use the default persona, per-chat overrides remain independent and persist, default changes do not rewrite existing chats, and Assistant shows no persona controls or Story persona content in outgoing requests.

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
- [ ] Seamless update handover when an already-running process has older code; version-mismatched Story setup now fails safely with restart guidance instead of freezing.

## Completed baseline
- [x] Chat loading; cards/personas/lore; optional portraits and idle motion; configurable additional instructions.
- [x] Optional story-only memory with selectable AI; regenerate/swipes/continue/branches.
- [x] Image variants, saved voices, Markdown editing and appearance presets.
- [x] Story setup crash recovery: older-service detection, load retry/timeout and isolated panel errors keep X working. Synthetic browser recovery and normal story setup checks pass.
- [x] Console-owned startup/shutdown fix published in e9d02aa. Full suite: 132 passed; final launcher checks: 14 passed; strict TypeScript and build passed. Device/live-provider checks above remain separate.
