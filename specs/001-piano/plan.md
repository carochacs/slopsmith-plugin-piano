# Implementation Plan — Piano Highway

Single-script visualisation plugin (`screen.js`, 1,771 lines).
No backend, no settings.html — settings UI is built dynamically
inside `screen.js`.

## Files

- `plugin.json` — id `piano`, type `visualization`, declares only
  `script`.
- `screen.js` — entire implementation: factory, renderer, MIDI
  input, synth, settings panel, scoring.
- `screenshot.png` — README image.
- `README.md` — user-facing docs.

## Architecture

### Factory

```js
function createFactory() {
  // closured per-instance:
  //   - canvas + context refs
  //   - draw RAF handle
  //   - held notes state
  //   - scoring state
  //   - display range (auto-zoom octaves)
  //   - settings panel DOM
  //   - MIDI input subscription (latched on focus)
  //   - WebAudioFont voices
  return {
    setRenderer, // installs draw callback on the highway
    isFocused, focus, blur,
    dispose,
    ...
  };
}
```

Single-panel mode: `window.piano = createFactory()` and used
directly. Splitscreen mode: each panel constructs its own factory
instance.

### Auto-activation

```js
const KEYS_PATTERNS = /\b(?:keys|piano|keyboard|synth)\b/i;
// inside draw / load:
if (KEYS_PATTERNS.test(arrangementName)) setRenderer(pianoRenderer);
```

For non-Keys arrangements, the user clicks the "Piano" button
(injected into player controls) to switch.

### Render loop

Per-frame draw:

```
1. Read bundle from highway.
2. Edge-detect bundle.isReady false→true (per-instance, no event).
3. Compute display range (octaves containing active notes,
   snapped clean).
4. Layout keyboard at NOW_LINE_Y_FRAC × H, KEYBOARD_H_FRAC × H tall.
5. For each note in the visible (3.0s) window:
   - Compute MIDI = string * 24 + fret (+ transpose).
   - Project (chartTime, MIDI) → (x, y) in screen space.
   - Draw bar with neon-rainbow color and multi-layer glow.
   - If approaching now-line: lerp the keyboard key's color toward
     the note's color.
6. For each held note (chart hits + freestyle): draw the press-down
   animation on the keyboard.
7. Draw HUD (accuracy / streak) if hit detection is on.
```

### MIDI input

```
on note-on:
  if (sustain or held) update visuals;
  if (hit detection enabled) {
    find nearest chart note within ±HIT_TOLERANCE;
    classify hit / freestyle / wrong;
    emit visual feedback;
  }
  play synth voice;

on note-off:
  if (sustain held) defer visual release;
  else release;

on CC#64 (sustain):
  on press: latch sustain;
  on release: flush deferred releases;
```

Focus-aware: under splitscreen the focus-change handler releases
held notes on outgoing panel and re-binds the MIDI subscription to
the incoming one.

### Synth

WebAudioFont with the 10 GM presets in the README table:

| Sound | GM Program |
|---|---|
| Grand Piano | 0 |
| Electric Piano | 4 |
| Honky-tonk | 3 |
| Organ | 19 |
| Strings | 48 |
| Synth Lead | 80 |
| Synth Pad | 88 |
| Harpsichord | 6 |
| Vibraphone | 11 |
| Music Box | 10 |

### Persisted settings (`localStorage`)

```
piano_midi_input       (MIDIInput id)
piano_instrument       (index 0-9 into the 10-preset list)
piano_synth_vol        (0.0-1.0)
piano_midi_ch          (0-15, or -1 for any)
piano_transpose        (semitones)
piano_note_names       (boolean)
piano_hit_detect       (boolean)
```

## Integration with Slopsmith Core

- **Highway**: `setRenderer(fn)` — Wave B feature. Renderer
  function is given a draw context per frame.
- **`window.slopsmithSplitscreen`** — optional splitscreen
  surface; absent or `isActive()===false` ⇒ single-instance mode.
- **Player controls**: the "Piano" button is injected into
  `#player-controls`; gear icon docks beside it.
- **Web MIDI** (Chrome / Edge only).

## Out of Scope

- Backend (none).
- MIDI output / recording.
- User SoundFont loading.
- Tests — none in repo (see analyze.md).
