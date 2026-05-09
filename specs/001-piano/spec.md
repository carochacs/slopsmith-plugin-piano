# Feature Specification: Piano Highway

**Feature Branch**: `001-piano`
**Created**: 2026-05-09 (retrospective)
**Status**: Implemented (v4.0.0; Wave C per-instance refactor)
**Input**: `README.md`, `screen.js`.

## User Scenarios & Testing

### User Story 1 — Replace highway with a Synthesia-style piano view (P1)

As a player on a Keys / Piano / Synth arrangement, I want my highway
replaced with a scrolling piano view: chart notes fall onto a
rendered keyboard with neon rainbow colors and approach glow.

**Why this priority**: Core function.

**Independent Test**: Open a sloppak with a Keys arrangement. The
plugin auto-activates. Confirm the highway is replaced, falling note
bars are colored by chromatic pitch, the keyboard renders below with
3D shading and rounded corners, and bars darken into approach glow
as they near the now-line.

**Acceptance Scenarios**:

1. **Given** a Keys arrangement loads, **When** the plugin
   detects `\bkeys|piano|keyboard|synth\b` in the arrangement
   name, **Then** the piano renderer is set on the highway via
   `setRenderer` and falls into place automatically.
2. **Given** a guitar arrangement loads, **When** the user clicks
   the "Piano" button in player controls, **Then** the highway
   renders the guitar notes mapped to MIDI pitches as a piano
   view.
3. **Given** the song's note range fits in 3 octaves, **When**
   the renderer chooses zoom, **Then** it snaps to the smallest
   octave count that contains all active notes, in clean octave
   steps.

---

### User Story 2 — Play along with a USB MIDI keyboard (P1)

As a player with a USB MIDI keyboard, I want to plug in, pick the
device in settings, and have the plugin show hit / miss feedback as
I play.

**Acceptance Scenarios**:

1. **Given** Web MIDI permission and a connected device, **When**
   the user picks the device, **Then** subsequent note-on events
   are routed to the focused piano panel.
2. **Given** a chart note is currently within the hit window
   (`HIT_TOLERANCE = 0.10` s) and the user plays its MIDI value
   (with optional `transpose` offset), **Then** the matching key
   glows green (hit).
3. **Given** the user plays a key with no matching chart note,
   **When** the key is in held-notes state, **Then** it glows
   blue (freestyle).
4. **Given** the user plays a wrong note while a chart note is
   within the hit window, **When** the press fires, **Then** a
   red flash is shown.
5. **Given** sustain pedal CC#64 is pressed, **When** the user
   releases keys, **Then** held notes remain visually held until
   sustain releases.

---

### User Story 3 — Built-in synthesizer playback (P2)

As a user without a hardware piano, I want pressing MIDI keys to
produce sound through a WebAudioFont GM voice.

**Acceptance Scenarios**:

1. **Given** an instrument is selected (default Grand Piano,
   GM 0), **When** the user plays a key, **Then** the
   corresponding sample plays at the configured volume.
2. **Given** the user picks "Strings" from the settings, **When**
   they play, **Then** the next note triggers the GM 48 sample.
3. **Given** sustain pedal is active, **When** the user releases
   a key, **Then** the synth voice continues until sustain
   releases.

---

### User Story 4 — Settings panel with inline gear (P2)

As a user, I want to configure MIDI device, instrument, volume,
channel, transpose, note-name display, and hit-detection toggle
without leaving the player.

**Acceptance Scenarios**:

1. **Given** the user clicks the gear icon next to the Piano
   button, **When** the panel opens, **Then** all settings are
   visible and changes persist via `localStorage` keys
   `piano_midi_input`, `piano_instrument`, `piano_synth_vol`,
   `piano_midi_ch`, `piano_transpose`, `piano_note_names`,
   `piano_hit_detect`.

---

### User Story 5 — Multi-panel splitscreen support (P3)

As a splitscreen user, I want each panel to host its own
independent piano instance.

**Acceptance Scenarios**:

1. **Given** N panels are active, **When** each instantiates the
   piano factory, **Then** each panel has its own overlay canvas,
   scoring, display range, settings panel + gear docked inside the
   panel's bar.
2. **Given** Web MIDI is active and the user clicks panel B,
   **When** focus changes from A to B, **Then** held notes on A
   are released cleanly, MIDI events are routed to B, and B starts
   fresh.

## Functional Requirements

- **FR-001**: Plugin id `piano`, type `visualization`, single-script
  (`plugin.json` declares only `script`).
- **FR-002**: Renderer registers via the highway's
  `setRenderer(...)` hook (Wave B feature).
- **FR-003**: Auto-activate condition:
  `KEYS_PATTERNS = /\b(?:keys|piano|keyboard|synth)\b/i` matches
  the loaded arrangement name.
- **FR-004**: Note decoding: `midi = string * 24 + fret` per the
  Slopsmith / editor convention. Optional `transpose` offset
  applied at decode + at play.
- **FR-005**: Visible window: `VISIBLE_SECONDS = 3.0`. Now-line at
  `NOW_LINE_Y_FRAC = 0.82`. Keyboard height fraction
  `KEYBOARD_H_FRAC = 0.15`.
- **FR-006**: Hit window: `HIT_TOLERANCE = 0.10` s.
- **FR-007**: Display range auto-zoom: snap to smallest clean
  octave count that contains active notes.
- **FR-008**: MIDI input: Web MIDI singleton; focus-aware routing
  under splitscreen; sustain pedal CC#64 supported.
- **FR-009**: Synth playback: WebAudioFont with 10 GM presets
  exposed in settings (see README table).
- **FR-010**: Visual feedback: green = correct hit, blue =
  freestyle (no matching chart note), red flash = wrong, approach
  glow lerps toward the note's color as it approaches the now
  line.
- **FR-011**: Settings persisted in `localStorage` under the keys
  in FR-12 below.
- **FR-012**: Persisted setting keys:
  - `piano_midi_input` — MIDIInput id.
  - `piano_instrument` — index into the 10-instrument list.
  - `piano_synth_vol` — synth volume.
  - `piano_midi_ch` — MIDI channel filter.
  - `piano_transpose` — semitone offset.
  - `piano_note_names` — boolean, label keys.
  - `piano_hit_detect` — boolean, scoring on/off.
- **FR-013**: Per-instance state — rendering, scoring, display
  range, settings UI, held-notes state, listeners — closured
  inside `createFactory`. The single-instance fast path uses
  `window.slopsmithSplitscreen?.isActive() === false || absent`
  as the indicator.
- **FR-014**: Edge-detection of `bundle.isReady` per draw frame —
  no global `song:ready` subscription, so N panels each detect
  readiness independently.

## Out of Scope

- MIDI output (recording the played performance to MIDI is a
  different plugin's job).
- General-MIDI bank switching beyond the 10 presets exposed.
- Real piano-style velocity-modulated visuals (color stays per
  pitch, not per velocity).
- Loading user-supplied SoundFonts.
