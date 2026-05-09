# Clarifications — Piano Highway

## Q1. Why per-instance rather than singleton?

**A.** Wave C (per the header comment in `screen.js`) lifted the
single-instance assumption that Wave B's `setRenderer` support
inherited. With splitscreen, N panels host N piano instances
simultaneously; rendering, scoring, display range, settings UI,
held-notes state, and listeners must all be per-instance. The
single-panel fast path keeps the same factory shape but skips the
`window.slopsmithSplitscreen` lookups.

## Q2. Why is MIDI input a singleton even with N piano instances?

**A.** Web MIDI is a browser singleton — there's only one
`MIDIInput` callback set per device. Routing it to N panels
simultaneously would either play the same note on all of them
(useless) or require a "broadcast" mode that no user actually
wants. Single focus = the panel you're looking at receives input.

## Q3. What does "release held notes on the outgoing panel" mean?

**A.** When focus moves A → B mid-key-press, A's held-notes state
still believes you're holding (e.g.) middle C. Without cleanup,
A would render middle C as held forever. The focus-change handler
flushes held-notes on the outgoing panel before re-binding MIDI
to the incoming one.

## Q4. Why decode `midi = string * 24 + fret`?

**A.** It's the convention the slopsmith editor (`gp_to_cdlc`) uses
when importing keyboard tracks from Guitar Pro. A guitar string +
fret pair has at most 24 frets, so `string * 24 + fret` yields a
unique integer in the chart-note space that doesn't collide with
real guitar string-fret encoding when both arrangements share a
sloppak.

## Q5. Why a 3.0-second visible window instead of 6.0?

**A.** Piano notes are typically denser than guitar notes; a 6 s
window puts so many bars on screen that they overlap visually. 3 s
is the visible-notes-per-frame budget that keeps the chart
readable.

## Q6. Why 10 GM instruments in the settings, not all 128?

**A.** Picked for genre coverage (piano, electric piano, organ,
strings, synth pads, etc.). All 128 in a dropdown is overwhelming
and most are unused for chart playthroughs. 10 keeps the panel
small. Power users wanting more can edit the constants in
`screen.js`.

## Q7. What does "approach color lerping" mean?

**A.** As a note approaches the now-line, the piano key it will
fall onto starts showing the note's color, intensifying the closer
the note gets. This previews the upcoming hit visually.

## Q8. Does the plugin record what the user played?

**A.** No. This plugin is display-only for input. If you want to
capture played notes as a MIDI file, that's a separate plugin (see
the editor plugin's MIDI-record prompt in user memory).

## Q9. What's `window.slopsmithSplitscreen`?

**A.** A surface exposed by the splitscreen plugin (when active)
that tells the piano plugin whether it's running inside a
splitscreen panel and which panel. Absent / `isActive() === false`
means single-instance mode and the plugin uses its singleton fast
path.
