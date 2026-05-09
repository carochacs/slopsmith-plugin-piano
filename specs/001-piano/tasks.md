# Tasks — Piano Highway

## US1 — Synthesia-style piano renderer (P1)

- [DONE] T101 `setRenderer(fn)` integration with the highway
  (Wave B).
- [DONE] T102 Falling-bar layout with 3.0 s visible window.
- [DONE] T103 3D gradient keyboard rendering.
- [DONE] T104 Neon-rainbow per-pitch coloring + multi-layer glow.
- [DONE] T105 Approach color lerp on the keyboard.
- [DONE] T106 Press-down animation for held notes.
- [DONE] T107 Auto-zoom display range (snap to clean octave
  steps).
- [DONE] T108 Auto-activate on Keys / Piano / Synth arrangement
  names.
- [DONE] T109 Manual "Piano" toggle for guitar arrangements.

## US2 — MIDI keyboard play-along (P1)

- [DONE] T201 Web MIDI bootstrap + device picker.
- [DONE] T202 Note-on / note-off → held-notes state.
- [DONE] T203 Sustain pedal CC#64 support.
- [DONE] T204 Hit / miss / freestyle classification.
- [DONE] T205 HUD (accuracy %, current streak, best streak).
- [DONE] T206 Note encoding `midi = string * 24 + fret` (with
  transpose offset).

## US3 — Built-in synth (P2)

- [DONE] T301 WebAudioFont integration.
- [DONE] T302 10 GM presets exposed.
- [DONE] T303 Volume / channel / instrument settings.

## US4 — Settings panel (P2)

- [DONE] T401 Inline settings (gear icon).
- [DONE] T402 `localStorage` persistence (FR-012 keys).
- [DONE] T403 Note-name labels toggle.
- [DONE] T404 Hit-detection toggle.

## US5 — Splitscreen / multi-instance (P3)

- [DONE] T501 `createFactory()` per-instance closure.
- [DONE] T502 Per-frame `bundle.isReady` edge-detection (no
  global `song:ready` subscription).
- [DONE] T503 Focus-aware MIDI routing (singleton).
- [DONE] T504 Held-notes flush on outgoing panel during focus
  change.
- [DONE] T505 Settings panel + gear docked inside the panel's
  bar.

## Cross-cutting

- [OPEN] T601 [P] Tests — no test harness in repo. The renderer's
  display-range auto-zoom and the `string * 24 + fret` decoding
  are unit-test-shaped. Could mirror the
  `slopsmith-plugin-notedetect` `vm`-loader pattern.
- [OPEN] T602 [P] Velocity-modulated visuals (color stays
  per-pitch, but velocity could control opacity / glow size).
- [OPEN] T603 [P] User-supplied SoundFont loading.
- [OPEN] T604 [P] Capture played notes to a MIDI file (more
  naturally lives in the editor plugin per existing prompts).
- [OPEN] T605 [P] Export the piano view as a video clip.
