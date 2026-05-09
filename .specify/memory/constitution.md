# Piano Highway Plugin Constitution

This plugin replaces the guitar highway with a Synthesia / Openthesia-
style scrolling piano view. Notes fall onto a rendered keyboard,
optional MIDI keyboard input drives a built-in WebAudioFont
synthesizer, and accuracy can be scored.

## Principles

### 1. Per-Instance, Splitscreen-Aware

Wave C of this plugin (per the header comment in `screen.js`) lifted
the single-instance assumption. Rendering, scoring, display range,
settings UI, held-notes state, and listeners are all per-instance
inside `createFactory`. Single-panel usage uses
`window.slopsmithSplitscreen` to opt out cleanly. New code MUST keep
N-panel usage correct.

### 2. MIDI Encoding Convention: `midi = string * 24 + fret`

This is the encoding used throughout Slopsmith for keyboard tracks.
Editor imports of Guitar Pro Keys arrangements use it. The plugin
MUST decode chart notes via this convention; deviating breaks
compatibility with the editor plugin and any GP-imported sloppaks.

### 3. Auto-Activate for Keys Arrangements

When the loaded arrangement matches `\b(?:keys|piano|keyboard|synth)\b/i`,
the piano view auto-engages. For guitar arrangements the user toggles
manually — the piano view of a guitar part is a useful alternative
visualisation but it shouldn't replace the highway by default.

### 4. MIDI Singleton, Focus-Aware

Web MIDI input is a browser singleton: only one `MIDIInput` is being
listened to at a time. Under splitscreen, the *most recently focused*
panel is the sole recipient of note-on / note-off / sustain. Focus
change releases held notes on the outgoing panel and starts fresh on
the incoming one.

### 5. Built-In Synth, No External Dependencies

Sound playback uses WebAudioFont with bundled GM presets. We do not
require external sample libraries or VSTs. Volume, instrument, and
channel are settings-panel knobs.

### 6. Visual Identity: Neon Rainbow + Glow

Each chromatic pitch gets a unique neon color, with multi-layer
glow. 3D gradient keyboard. Approach color lerp. Press-down
animation. These are intentional aesthetic choices borrowed from
Synthesia / Openthesia — refactors must preserve the visual
language.

## Inherits from Slopsmith Core Constitution

- Single-script plugin (`plugin.json` declares only `script`,
  `type: "visualization"`).
- Idempotent re-eval (`screen.js` may be re-run on plugin reload).
- Highway integration via `setRenderer` (the renderer-replacement
  hook landed in Wave B per the header comment).
- Web MIDI requires Chrome / Edge — Firefox is degraded but the
  visualisation still works without input.

Where this plugin's principles disagree with the core constitution,
the core wins.
