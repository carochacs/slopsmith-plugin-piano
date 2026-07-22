# Known UI Issues — Piano Visualization

Findings from a frontend UI-bug audit of `screen.js` (2026-07-22, 2465 lines, single file — no `screen.html`/`settings.html`/`assets/` exist; renders directly on the shared highway canvas via `window.slopsmithViz_piano`). Ranked by severity/confidence. No code changes have been made — this is a catalog for follow-up work.

## 1. No `contextType` declared on the renderer instance (Critical)

The returned `instance` (`screen.js:2279-2450`) exposes `init`, `draw`, `resize`, `destroy`, and MIDI hooks, but never declares `contextType`. The only context acquisition is `_pianoCanvas.getContext('2d')` at `screen.js:2328`. Per the setRenderer contract, core reads `contextType` *before* calling `init()` to decide whether the canvas element needs to be swapped for a fresh one.

**Failure scenario:** If the previously-active renderer on the canvas used `webgl2` (or any renderer with a different `contextType`), core has no way to know Piano needs `'2d'` and won't swap the canvas element. `getContext('2d')` on a canvas already bound to `webgl2` returns `null` per spec, so `_pianoCtx` is null, `init()` hits its `console.warn('[Piano] init: could not get 2d context...')` branch and aborts — the piano view renders blank/black whenever switching into Piano mode from a WebGL-based renderer.

## 2. Sibling DOM never listens for `highway:visibility` / `highway:canvas-replaced` (High)

The settings gear button (`_injectSettingsGear`, `screen.js:1342-1376`) and settings panel (`_createSettingsPanel`, `screen.js:1396-1595`) are mounted as siblings of the highway canvas. Nowhere in the file does it subscribe to `window.slopsmith`'s `'highway:canvas-replaced'` or `'highway:visibility'` events.

**Failure scenario:** Core's visibility toggling on the canvas (e.g. hiding an unfocused splitscreen panel) stops `draw()` from being invoked, but the gear icon and any open settings panel remain visible and fully interactive as separate DOM nodes — users can see/click orphaned Piano controls with no corresponding visible canvas, and changes made there (MIDI device, instrument, transpose) silently apply to a hidden instance.

## 3. Window resize listener defined and torn down, but never registered (Medium)

`_onWinResize` (`screen.js:823`) is carefully removed in both the defensive re-init path and `destroy()` (`screen.js:2292`, `screen.js:2425`), but there is no matching `window.addEventListener('resize', _onWinResize)` anywhere in the file — dead code that was presumably meant to be wired in `init()`.

**Failure scenario:** `draw()` calls `_applyCanvasDims()` every frame during active playback, largely masking this. But resizing the window while playback is *paused* leaves the DPR transform stale until playback resumes — the last-painted frame can appear mis-scaled/blurry relative to the newly-resized canvas.

## 4. Note-name labels can index out of range under octave remap (Medium)

`midiToNoteName` (`screen.js:209`, `NOTE_NAMES[midi % 12]`) is called with remap-shifted values (`screen.js:1838, 1840, 2030-2033`) where `_midiOffset` (`screen.js:1158`, `controllerLo - _songMapLo`) is added with no clamping to `[0, 127]`. JS's `%` returns a negative remainder for negative operands, so `NOTE_NAMES[-1]` is `undefined`.

**Failure scenario:** With a small `keyCount` (e.g. 32) and `octaveRemap` enabled on a song whose range sits far from the controller's `controllerLo`, computed offsets can push some MIDI values below 0 or above 127 — on-screen note labels render as `"undefinedN"` instead of a valid note name.

## 5. Vestigial unused `_prevHighwayDisplay` snapshot (Low, informational)

`screen.js:2320` captures `canvas.style.visibility` into `_prevHighwayDisplay` and resets it to `''` at lines 2260/2333, but nothing ever restores it — leftover from an earlier overlay-canvas design the code comments (lines 2313-2325) say was eliminated. Currently inert, flagged because a future change that hides the canvas via `visibility` would have no matching restore path.

---

*Verified clean:* no hardcoded `stringCount`/fret assumptions (this plugin is MIDI-note-based, not string/fret-based); no lefty/inverted mirroring gap (not applicable to a piano keyboard); `draw()` correctly reads per-instance closured state and the bundle snapshot rather than internal/global state; `init()`/`destroy()` re-entrancy is well-guarded (defensive `_teardown()` if a prior `init()` wasn't paired with `destroy()`); no arbitrary-bracket Tailwind classes, so no missing `styles` manifest concern.
