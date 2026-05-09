# Analysis — Piano Highway

## Coverage

| Spec area | Implementation | Notes |
|---|---|---|
| FR-001 (single-script visualisation plugin) | `plugin.json` | OK; type `visualization`. |
| FR-002 (`setRenderer`) | Wave B feature, used in `screen.js` | OK; assumes the host has the hook. |
| FR-003 (auto-activate regex) | `KEYS_PATTERNS` | OK. |
| FR-004 (`midi = string*24 + fret`) | decode block | OK; transpose offset honoured. |
| FR-005 (visible window / now-line) | constants block | OK. |
| FR-006 (hit tolerance) | `HIT_TOLERANCE = 0.10` | OK. |
| FR-007 (auto-zoom octaves) | display-range block | OK. |
| FR-008 (Web MIDI singleton + focus) | MIDI bootstrap + focus handler | OK. |
| FR-009 (10 GM presets) | settings + WebAudioFont | OK. |
| FR-010 (visual feedback colors) | renderer | OK. |
| FR-011 / FR-012 (persisted settings) | `STORE_KEYS` block | OK. |
| FR-013 (per-instance state) | `createFactory` | OK; Wave C refactor. |
| FR-014 (`isReady` edge-detect) | render loop | OK. |

## Drift

1. **Wave history is in `screen.js` header**, not in the README.
   The README lists features but doesn't capture the per-instance
   refactor (Wave C) or the renderer-replacement contract (Wave B).
   Future contributors will need to read the comment to understand
   why some code looks the way it does. Consider lifting the
   summary into README as a "Contributors" subsection.
2. **README claims sustain pedal full CC#64 support** — accurate;
   no drift.
3. **README claims "Inline settings — MIDI device, instrument,
   volume, channel, transpose, and toggles"** — accurate; matches
   `STORE_KEYS`.
4. **No mention** in README of `window.slopsmithSplitscreen` or
   the per-instance model. Splitscreen plugin authors will discover
   it via header comment. Consider adding a short paragraph.

## Gaps

1. **No tests.** Plugin is large enough (1,771 lines) that the
   absence is felt — display-range auto-zoom, MIDI encoding, and
   focus-change held-notes flush all have crisp unit-test shapes.
   Mirror the `slopsmith-plugin-notedetect` `vm`-loader pattern.
2. **No CI** in repo.
3. **No way to capture the played performance** to a MIDI file —
   user memory has a prompt for the editor plugin to handle this;
   tracked there, not here.
4. **WebAudioFont samples are loaded lazily** but are not bundled
   — they fetch from a CDN at runtime. This means the plugin is
   broken offline. Documenting this explicitly would help users
   running Slopsmith on an air-gapped network.
5. **No velocity-modulated visuals** — color is per-pitch, ignoring
   how hard the user hit the key. Lost expressive information.

## Recommendations

1. **Add a small test suite** mirroring `notedetect/test/`. Cover:
   - `string * 24 + fret` decoding (plus transpose).
   - Display range auto-zoom snapping.
   - Held-notes flush on focus change.
   - Sustain pedal CC#64 deferred release.
2. **Lift Wave history into README** under a "Contributors" or
   "Architecture" section.
3. **Document offline behaviour** of WebAudioFont samples.
4. **Velocity-modulated visuals** (T602) — easy win for expressive
   feedback; opacity / glow-size scale by `velocity / 127` would
   suffice without redesigning the color palette.
5. **Consider a tiny "preset bank" REST endpoint** in a sibling
   plugin (or a small backend addition here) to let users curate
   instrument lists across Slopsmith installs. Optional; the
   current 10-preset hardcode is not a real problem.
