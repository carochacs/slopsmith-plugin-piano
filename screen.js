// Piano Highway visualization plugin — Synthesia-style scrolling
// piano renderer with MIDI keyboard input, WebAudioFont synthesizer,
// and accuracy scoring.
//
// Wave C (slopsmith#36): per-instance refactor. Earlier Wave B
// landed setRenderer support with an explicit single-instance
// module-state assumption. Wave C lifts that: rendering, scoring,
// display range, settings UI, held-notes state, and listeners are
// now all per-instance (closured inside createFactory). Main-player
// usage keeps its single-instance fast path via the
// window.slopsmithSplitscreen helper surface — its absence OR
// isActive()===false means "we're the only instance, always
// focused."
//
// Under splitscreen (N panels, N simultaneous piano instances):
//   - each panel hosts its own overlay canvas, scoring, display
//     range, settings panel + gear docked inside the panel's bar
//   - MIDI input is a browser singleton; the currently-focused
//     panel (clicked most recently) is the sole recipient of
//     note-on / note-off / sustain events
//   - focus-change releases held notes on the outgoing panel and
//     starts fresh on the incoming one
//   - settings changes persist into _cfg and are reflected on the
//     next open of any other panel's settings.
//
// song:ready event subscription is gone: each draw() edge-detects
// bundle.isReady false→true per-instance, which is correct for N
// panels without the cross-instance fan-out of the global bus.

(function () {
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Config
// ═══════════════════════════════════════════════════════════════════════

const KEYS_PATTERNS = /\b(?:keys|piano|keyboard|synth)\b/i;
const VISIBLE_SECONDS = 3.0;
const RANGE_LERP_TAU = 0.12;    // seconds — exponential time-constant (~0.5s to 99% convergence)
const NOW_LINE_Y_FRAC = 0.82;
const KEYBOARD_H_FRAC = 0.15;
const NOTE_LABEL_MIN_H = 16;
const HIT_TOLERANCE = 0.10;        // seconds

// ── Persisted settings ───────────────────────────────────────────────

const STORE_KEYS = {
    midiInputId:   'piano_midi_input',
    instrumentIdx: 'piano_instrument',
    synthVolume:   'piano_synth_vol',
    midiChannel:   'piano_midi_ch',
    transpose:     'piano_transpose',
    showNoteNames: 'piano_note_names',
    hitDetection:  'piano_hit_detect',
    keyCount:      'piano_key_count',   // 0 = auto-detect from song
    octaveRemap:   'piano_oct_remap',   // whether dynamic octave remapping is active
    practiceMode:  'piano_practice',    // true = full-song range locked; false = dynamic remap
};

// Standard keyboard sizes: key count → [loMidi, hiMidi] centered on middle C (60)
const VALID_KEY_COUNTS = new Set([32, 49, 61, 88]);

function _rangeForKeyCount(n) {
    if (!VALID_KEY_COUNTS.has(n)) return null;
    // Display is anchored to controllerLo so the visual keyboard matches the
    // physical one exactly. _songMapLo (computed separately) tracks which song
    // note maps to the left edge, keeping the remap formula correct.
    return { lo: _cfg.controllerLo, hi: Math.min(127, _cfg.controllerLo + n - 1) };
}

// Returns the song MIDI note that should map to the controller's lowest key,
// choosing the placement that best fits the song within the controller's span.
//
// If the entire song fits within the key count, centre it (zero shifts needed
// regardless of exact placement, centering feels natural).
//
// If the song is wider than the controller, scan all candidate placements and
// pick the one that produces the fewest shift-change transitions during playback
// — i.e., where consecutive notes stay in the same octave-shift zone for the
// longest uninterrupted stretches.
function _bestSongMapLo(notes, chords, keyCount) {
    const songRange = detectRange(notes, chords);
    if (!songRange || songRange.lo > songRange.hi) return _cfg.controllerLo;

    const span = keyCount - 1;
    const songSpan = songRange.hi - songRange.lo;

    // Only octave-aligned placements are valid: a C key always sends C,
    // so _songMapLo must share the same pitch class as controllerLo.
    // Generate every candidate lo ≡ controllerLo (mod 12) in [0, 127].
    const pitchClass = _cfg.controllerLo % 12;
    // Nearest lo at or below songRange.lo with the right pitch class.
    const firstLo = songRange.lo - ((songRange.lo - pitchClass + 1200) % 12);

    if (songSpan <= span) {
        // Entire song fits — anchor the song to the left edge of the controller
        // so pressing controllerLo plays right at the start of the song's range.
        // "Left-align" by picking the octave-aligned note at or just below
        // songRange.lo (same pitch class as controllerLo). This way the user
        // plays the song with their left hand in its natural rest position rather
        // than hunting for notes in the middle of the keyboard.
        const lo = songRange.lo - ((songRange.lo - pitchClass + 1200) % 12);
        return Math.max(0, lo);
    }

    // Song is wider than the controller. Collect notes in time order.
    const seq = [];
    if (notes)  for (const n of notes)  seq.push({ t: n.t, m: noteToMidi(n.s, n.f) });
    if (chords) for (const c of chords) for (const cn of (c.notes || [])) seq.push({ t: c.t, m: noteToMidi(cn.s, cn.f) });
    seq.sort((a, b) => a.t - b.t);
    if (seq.length === 0) return Math.max(0, firstLo);

    // Only iterate octave-aligned candidates within the meaningful window:
    // [songRange.lo, songRange.hi - span] keeps at least one song boundary
    // at the controller edge. Step by 12 (one octave) not by semitone.
    const loMax = Math.max(firstLo, songRange.hi - span);

    let bestLo = firstLo, bestTransitions = Infinity;

    for (let lo = firstLo; lo <= loMax; lo += 12) {
        if (lo < 0) continue;
        const hi = lo + span;
        let transitions = 0;
        let prevShift = null;
        for (const { m } of seq) {
            const shift = m < lo ? -Math.ceil((lo - m) / 12)
                        : m > hi ?  Math.ceil((m - hi) / 12)
                        : 0;
            if (prevShift !== null && shift !== prevShift) transitions++;
            prevShift = shift;
        }
        if (transitions < bestTransitions) {
            bestTransitions = transitions;
            bestLo = lo;
        }
    }

    return bestLo;
}

function _readStore(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
}

const _cfg = {
    midiInputId:   _readStore(STORE_KEYS.midiInputId) || '',
    instrumentIdx: parseInt(_readStore(STORE_KEYS.instrumentIdx) || '0'),
    synthVolume:   parseFloat(_readStore(STORE_KEYS.synthVolume) || '0.7'),
    midiChannel:   parseInt(_readStore(STORE_KEYS.midiChannel) || '-1'),
    transpose:     parseInt(_readStore(STORE_KEYS.transpose) || '0'),
    showNoteNames: _readStore(STORE_KEYS.showNoteNames) !== 'false',
    hitDetection:  _readStore(STORE_KEYS.hitDetection) === 'true',
    keyCount:      parseInt(_readStore(STORE_KEYS.keyCount) || '0'),
    controllerLo:  48, // auto-detected from incoming MIDI; default C3
    octaveRemap:   _readStore(STORE_KEYS.octaveRemap) !== 'false',        // on by default
    practiceMode:  _readStore(STORE_KEYS.practiceMode) === 'true',        // off by default
};

function _saveCfg(key, val) {
    _cfg[key] = val;
    const storeKey = STORE_KEYS[key];
    if (!storeKey) return;
    try { localStorage.setItem(storeKey, String(val)); } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════
// Module-level singletons (browser-unique resources)
// ═══════════════════════════════════════════════════════════════════════

// ── MIDI input ────────────────────────────────────────────────────────
let _midiAccess = null;
let _midiInput = null;
let _midiActive = false;     // gates _midiInput.onmidimessage wiring
// Wave C: routes incoming MIDI events to the currently-focused piano
// instance (null when no instance is active). Instances claim this
// on focus-change and release it on defocus / destroy.
let _activeInstance = null;
// Registry of live factory instances so module-level helpers (device-
// list refresh, shutdown-when-last-destroys) can iterate.
const _instances = new Set();
// Monotonic id for per-instance DOM tagging (useful for debugging).
let _nextInstanceId = 0;

// ── Synth ─────────────────────────────────────────────────────────────
let _audioCtx = null;
let _synthPlayer = null;
let _synthPreset = null;
let _synthGain = null;
const _noteEnvelopes = new Map();   // shared: transposed midi → envelope
let _synthLoading = false;
let _playerScriptLoaded = false;

// ── MIDI expression state ─────────────────────────────────────────────
let _pitchBendSemitones = 0;           // current pitch bend in semitones
const PITCH_BEND_RANGE_ST = 2;         // ±2 semitones (standard)
let _modValue = 0;                     // CC#1 modulation wheel, 0–1 normalized

// ── Controller range auto-detection ──────────────────────────────────
// Rolling 3-second window of incoming note-ons, used to detect the
// controller's actual lowest key and physical octave transpositions.
let _autoNoteWindow = [];

// ═══════════════════════════════════════════════════════════════════════
// MIDI / Color Helpers
// ═══════════════════════════════════════════════════════════════════════

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function noteToMidi(string, fret) { return string * 24 + fret; }

function midiToNoteName(midi) {
    return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

function isBlackKey(midi) {
    const pc = midi % 12;
    return pc === 1 || pc === 3 || pc === 6 || pc === 8 || pc === 10;
}

function _noteKey(time, midi) {
    return time.toFixed(3) + '|' + midi;
}

// ── Neon rainbow per chromatic note (Openthesia-style) ────────────────

const NEON_RGB = [
    [1.0, 0.2, 0.3],
    [1.0, 0.4, 0.4],
    [1.0, 0.9, 0.2],
    [1.0, 0.8, 0.4],
    [0.2, 0.8, 1.0],
    [1.0, 0.6, 0.1],
    [1.0, 0.5, 0.3],
    [0.3, 1.0, 0.3],
    [0.4, 1.0, 0.4],
    [0.6, 0.3, 1.0],
    [0.7, 0.4, 1.0],
    [1.0, 0.3, 1.0],
];

function _neonRGB(midi) { return NEON_RGB[midi % 12]; }

function _rgbStr(r, g, b, a) {
    return a !== undefined
        ? `rgba(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0},${a})`
        : `rgb(${(r * 255) | 0},${(g * 255) | 0},${(b * 255) | 0})`;
}

// ═══════════════════════════════════════════════════════════════════════
// Instruments (WebAudioFont — GM via JCLive soundfont)
// ═══════════════════════════════════════════════════════════════════════

const WAF_BASE = 'https://surikov.github.io/webaudiofontdata/sound/';
const WAF_PLAYER_URL = 'https://surikov.github.io/webaudiofont/npm/dist/WebAudioFontPlayer.js';
const WAF_SF = 'JCLive_sf2_file';

const INSTRUMENTS = [
    { name: 'Grand Piano',    gm: 0  },
    { name: 'Electric Piano',  gm: 4  },
    { name: 'Honky-tonk',      gm: 3  },
    { name: 'Organ',            gm: 19 },
    { name: 'Strings',          gm: 48 },
    { name: 'Synth Lead',       gm: 80 },
    { name: 'Synth Pad',        gm: 88 },
    { name: 'Harpsichord',      gm: 6  },
    { name: 'Vibraphone',       gm: 11 },
    { name: 'Music Box',        gm: 10 },
];

function _wafFile(gm) {
    return String(gm * 10).padStart(4, '0') + '_' + WAF_SF;
}
function _wafVar(gm)  { return '_tone_' + _wafFile(gm); }
function _wafUrl(gm)  { return WAF_BASE + _wafFile(gm) + '.js'; }

function _loadScript(url) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) { resolve(); return; }
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Failed to load ' + url));
        document.head.appendChild(s);
    });
}

// ═══════════════════════════════════════════════════════════════════════
// WebAudioFont synth (module-level — one audio context per tab)
// ═══════════════════════════════════════════════════════════════════════

async function _synthInit() {
    if (_synthPlayer) return;
    try {
        if (!_playerScriptLoaded) {
            await _loadScript(WAF_PLAYER_URL);
            _playerScriptLoaded = true;
        }
        if (typeof WebAudioFontPlayer === 'undefined') return;

        _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        _synthGain = _audioCtx.createGain();
        _synthGain.gain.value = _cfg.synthVolume;
        _synthGain.connect(_audioCtx.destination);
        _synthPlayer = new WebAudioFontPlayer();

        await _synthLoadInstrument(_cfg.instrumentIdx);
    } catch (e) {
        console.warn('[Piano] Synth init failed:', e);
    }
}

async function _synthLoadInstrument(idx) {
    const inst = INSTRUMENTS[idx];
    if (!inst || !_synthPlayer || !_audioCtx) return;
    _synthLoading = true;
    const varName = _wafVar(inst.gm);

    try {
        if (!window[varName]) {
            await _loadScript(_wafUrl(inst.gm));
        }
        const preset = window[varName];
        if (preset) {
            _synthPlayer.adjustPreset(_audioCtx, preset);
            _synthPreset = preset;
        }
    } catch (e) {
        console.warn('[Piano] Failed to load instrument:', inst.name, e);
    }
    _synthLoading = false;
}

async function _synthLoadInstrumentGM(gm) {
    if (!_synthPlayer || !_audioCtx) return;
    _synthLoading = true;
    const varName = _wafVar(gm);
    try {
        if (!window[varName]) await _loadScript(_wafUrl(gm));
        const preset = window[varName];
        if (preset) {
            _synthPlayer.adjustPreset(_audioCtx, preset);
            _synthPreset = preset;
        }
    } catch (e) {
        console.warn('[Piano] Failed to load GM program', gm, e);
    }
    _synthLoading = false;
}

function _synthEnsureCtx() {
    if (_audioCtx && _audioCtx.state === 'suspended') {
        _audioCtx.resume();
    }
}

function _synthNoteOn(midi, velocity) {
    if (!_synthPlayer || !_synthPreset || !_audioCtx || !_synthGain) return;
    _synthEnsureCtx();

    const existing = _noteEnvelopes.get(midi);
    if (existing) { try { existing.cancel(); } catch (_) {} }

    const vol = (velocity / 127) * _cfg.synthVolume;
    // Apply pitch bend as a semitone offset; WebAudioFont accepts float pitch values.
    const envelope = _synthPlayer.queueWaveTable(
        _audioCtx, _synthGain, _synthPreset, 0, midi + _pitchBendSemitones, 999, vol
    );
    _noteEnvelopes.set(midi, envelope);
}

function _synthNoteOff(midi) {
    const env = _noteEnvelopes.get(midi);
    if (env) {
        try { env.cancel(); } catch (_) {}
        _noteEnvelopes.delete(midi);
    }
}

function _synthReleaseAll() {
    for (const env of _noteEnvelopes.values()) {
        try { env.cancel(); } catch (_) {}
    }
    _noteEnvelopes.clear();
}

function _synthSetVolume(vol) {
    _saveCfg('synthVolume', vol);
    if (_synthGain) _synthGain.gain.value = vol;
}

// ═══════════════════════════════════════════════════════════════════════
// Web MIDI input (module-level — one MIDI access per tab)
// ═══════════════════════════════════════════════════════════════════════

async function _midiInit() {
    if (_midiAccess) return;
    if (!navigator.requestMIDIAccess) return;
    try {
        _midiAccess = await navigator.requestMIDIAccess({ sysex: false });
        _midiAccess.onstatechange = () => _midiUpdateAllDeviceLists();
        _midiAutoConnect();
        // Populate whatever settings panels are open — may be zero
        // on first init, but if any instance has its settings open
        // we want the MIDI <select> filled.
        _midiUpdateAllDeviceLists();
    } catch (e) {
        console.warn('[Piano] MIDI access denied:', e);
    }
}

function _midiAutoConnect() {
    if (!_midiAccess) return;
    const inputs = [];
    _midiAccess.inputs.forEach(inp => inputs.push(inp));
    if (!inputs.length) return;

    const raw = _readStore(STORE_KEYS.midiInputId);
    if (raw === '') return;  // explicit "None" opt-out

    const target = inputs.find(i => i.id === raw) || inputs[0];
    _midiConnect(target.id);
}

function _midiConnect(id) {
    if (_midiInput) _midiInput.onmidimessage = null;
    _midiInput = null;

    // Release anything currently sounding + clear per-instance
    // held state on EVERY live instance, not just the focused one.
    // _activeInstance can be null (no panel focused yet, or
    // splitscreen-toggle race) or stale (focus swapped between
    // device events). Iterating _instances guarantees no panel
    // shows "stuck" held keys when it later becomes focused —
    // _heldNotes / _sustainedNotes track per-instance visual
    // state and need to be cleared in lockstep with the shared
    // synth envelope cancel.
    _synthReleaseAll();
    for (const inst of _instances) {
        if (inst && typeof inst._releaseAllHeld === 'function') {
            inst._releaseAllHeld();
        }
    }

    _saveCfg('midiInputId', id || '');

    if (!id || !_midiAccess) {
        _midiUpdateAllDeviceLists();
        return;
    }
    _midiAccess.inputs.forEach(inp => {
        if (inp.id === id) {
            _midiInput = inp;
            if (_midiActive) _midiInput.onmidimessage = _midiOnMessage;
        }
    });
    _midiUpdateAllDeviceLists();
}

function _midiPauseHandler() {
    _midiActive = false;
    if (_midiInput) _midiInput.onmidimessage = null;
}

function _midiResumeHandler() {
    _midiActive = true;
    if (_midiInput) _midiInput.onmidimessage = _midiOnMessage;
}

function _midiOnMessage(e) {
    // Only the focused instance receives MIDI. Module-level
    // _activeInstance is the routing slot; it points at null when
    // no instance is focused (splitscreen toggled off mid-session
    // between teardowns, or no instance initialised yet).
    if (!_activeInstance) return;

    const [status, note, velocity] = e.data;
    const ch = status & 0x0F;
    if (_cfg.midiChannel >= 0 && ch !== _cfg.midiChannel) return;

    const cmd = status & 0xF0;

    // ── Controller auto-detect: track rolling minimum to determine controllerLo ──
    if (cmd === 0x90 && velocity > 0) {
        const now = performance.now();
        // Trim entries older than 3 s.
        let i = 0;
        while (i < _autoNoteWindow.length && now - _autoNoteWindow[i].time > 3000) i++;
        if (i > 0) _autoNoteWindow.splice(0, i);
        _autoNoteWindow.push({ time: now, midi: note });

        // Compute rolling window minimum.
        let winMin = note;
        for (const e of _autoNoteWindow) if (e.midi < winMin) winMin = e.midi;

        if (winMin < _cfg.controllerLo) {
            // New low note seen — controller extends lower than assumed (or transposed down).
            _cfg.controllerLo = winMin;
            if (_activeInstance) _activeInstance._resetControllerLo();
        } else if (_cfg.keyCount > 0 && _autoNoteWindow.length >= 3) {
            // Transpose-up detection: if all notes in the window are >= controllerLo + 12
            // and the window minimum is close to controllerLo + 12, the player likely
            // pressed the physical transpose-up button once.
            const threshold = _cfg.controllerLo + 12;
            const allAbove = winMin >= threshold && winMin <= threshold + 2;
            if (allAbove && _autoNoteWindow.every(e => e.midi >= _cfg.controllerLo + 12)) {
                _cfg.controllerLo += 12;
                _autoNoteWindow = []; // reset so the new baseline is learned fresh
                if (_activeInstance) _activeInstance._resetControllerLo();
            }
        }
    }

    // Pass the RAW MIDI note number to instance handlers; the
    // instance applies transpose internally and remembers the
    // played value so a transpose change between note-on and
    // note-off can't strand a held note. Computing transpose
    // here would compute a different "transposed" for the same
    // raw note across messages, leaving the synth + held state
    // pointing at the wrong key.
    if (cmd === 0x90 && velocity > 0) {
        _activeInstance._handleNoteOn(note, velocity);
    } else if (cmd === 0x80 || (cmd === 0x90 && velocity === 0)) {
        _activeInstance._handleNoteOff(note);
    } else if (cmd === 0xB0 && note === 64) {
        _activeInstance._handleSustain(velocity >= 64);
    } else if (cmd === 0xB0 && note === 1) {
        // Modulation wheel (CC#1): store normalized value for future use.
        _modValue = velocity / 127;
    } else if (cmd === 0xE0) {
        // Pitch bend: 14-bit signed value centered at 8192.
        const raw14 = ((velocity & 0x7F) << 7) | (note & 0x7F);
        _pitchBendSemitones = ((raw14 - 8192) / 8192) * PITCH_BEND_RANGE_ST;
    }
}

function _midiUpdateAllDeviceLists() {
    if (!_midiAccess) return;
    const inputs = [];
    _midiAccess.inputs.forEach(inp => inputs.push(inp));

    // Every instance's settings panel (if open) has a
    // `.piano-midi-select` node. Iterate all of them so a
    // device plug/unplug reflects everywhere simultaneously.
    const selects = document.querySelectorAll('.piano-midi-select');
    for (const sel of selects) {
        sel.textContent = '';
        const noneOpt = document.createElement('option');
        noneOpt.value = '';
        noneOpt.textContent = 'None';
        sel.appendChild(noneOpt);
        for (const inp of inputs) {
            const opt = document.createElement('option');
            opt.value = inp.id;
            opt.textContent = inp.name || inp.manufacturer || inp.id || 'Unknown device';
            if (_midiInput && _midiInput.id === inp.id) opt.selected = true;
            sel.appendChild(opt);
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Pure drawing / geometry helpers (stateless)
// ═══════════════════════════════════════════════════════════════════════

function buildKeyLayout(lo, hi, areaX, areaW) {
    const keys = [];
    let whiteCount = 0;
    for (let m = lo; m <= hi; m++) {
        if (!isBlackKey(m)) whiteCount++;
    }
    if (whiteCount === 0) return keys;

    const whiteW = areaW / whiteCount;
    const blackW = whiteW * 0.6;

    let wx = areaX;
    for (let m = lo; m <= hi; m++) {
        if (!isBlackKey(m)) {
            keys.push({ midi: m, x: wx, w: whiteW, black: false });
            wx += whiteW;
        }
    }
    for (let m = lo; m <= hi; m++) {
        if (!isBlackKey(m)) continue;
        const prevWhite = keys.find(k => !k.black && k.midi === m - 1);
        if (prevWhite) {
            keys.push({ midi: m, x: prevWhite.x + prevWhite.w - blackW / 2, w: blackW, black: true });
        }
    }
    return keys;
}

function keyForMidi(midi, layout) {
    for (const k of layout) {
        if (k.midi === midi) return k;
    }
    return null;
}

function _timeToY(dt, nowLineY, topY) {
    if (dt <= 0) return nowLineY + (-dt / 0.3) * 20;
    const frac = dt / VISIBLE_SECONDS;
    return nowLineY - frac * (nowLineY - topY);
}

function _roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

function _roundRectBottom(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.closePath();
}

function detectRange(notes, chords) {
    let lo = 127, hi = 0;
    if (notes) {
        for (const n of notes) {
            const m = noteToMidi(n.s, n.f);
            if (m < lo) lo = m;
            if (m > hi) hi = m;
        }
    }
    if (chords) {
        for (const c of chords) {
            for (const cn of (c.notes || [])) {
                const m = noteToMidi(cn.s, cn.f);
                if (m < lo) lo = m;
                if (m > hi) hi = m;
            }
        }
    }
    if (lo > hi) { lo = 36; hi = 83; }
    lo = Math.max(0, Math.floor(lo / 12) * 12);
    hi = Math.min(127, Math.ceil((hi + 1) / 12) * 12 - 1);
    while (hi - lo < 47) { hi = Math.min(127, hi + 12); if (hi - lo < 47 && lo > 0) lo -= 12; }
    return { lo, hi };
}

function _visibleMidiRange(notes, chords, t) {
    let lo = 127, hi = 0;
    const tMax = t + VISIBLE_SECONDS;

    if (notes) {
        for (const n of notes) {
            const end = n.t + (n.sus || 0);
            if (end < t - 0.1) continue;
            if (n.t > tMax) break;
            const m = noteToMidi(n.s, n.f);
            if (m < lo) lo = m;
            if (m > hi) hi = m;
        }
    }
    if (chords) {
        for (const c of chords) {
            if (c.t < t - 0.1) continue;
            if (c.t > tMax) break;
            for (const cn of (c.notes || [])) {
                const m = noteToMidi(cn.s, cn.f);
                if (m < lo) lo = m;
                if (m > hi) hi = m;
            }
        }
    }
    return lo <= hi ? { lo, hi } : null;
}

// midi is in display space; midiOffset converts it back to song space for lookup.
function _approachAlpha(midi, notes, chords, t, midiOffset) {
    const songMidi = midi - (midiOffset || 0);
    const lookAhead = VISIBLE_SECONDS * 0.6;
    let closest = Infinity;
    if (notes) {
        for (const n of notes) {
            if (n.t < t - 0.05) continue;
            if (n.t > t + lookAhead) break;
            if (noteToMidi(n.s, n.f) === songMidi) {
                closest = Math.min(closest, n.t - t);
            }
        }
    }
    if (chords) {
        for (const c of chords) {
            if (c.t < t - 0.05) continue;
            if (c.t > t + lookAhead) break;
            for (const cn of (c.notes || [])) {
                if (noteToMidi(cn.s, cn.f) === songMidi) {
                    closest = Math.min(closest, c.t - t);
                }
            }
        }
    }
    if (closest === Infinity) return 0;
    return Math.max(0, 1 - closest / lookAhead);
}

// ═══════════════════════════════════════════════════════════════════════
// Splitscreen helper wrappers
// ═══════════════════════════════════════════════════════════════════════
//
// Centralise the "am I in splitscreen?" / "which panel are my chrome
// anchors?" queries so instance code can read the runtime environment
// cheaply. Absence of window.slopsmithSplitscreen OR isActive()===false
// means "main-player, always focused" from the plugin's POV.

function _ssActive() {
    const ss = window.slopsmithSplitscreen;
    if (!ss || typeof ss.isActive !== 'function' || !ss.isActive()) return false;
    // Validate the FULL surface this plugin consumes, not just
    // isActive(). If a future splitscreen build ships partial
    // helpers (or an older bundled splitscreen lacks one of the
    // newer methods), report "not active" so the wrappers fall
    // back to the main-player single-instance fast path rather
    // than reaching a half-broken splitscreen state where focus
    // never lands on any instance and MIDI routing dies.
    return typeof ss.isCanvasFocused === 'function'
        && typeof ss.panelChromeFor === 'function'
        && typeof ss.settingsAnchorFor === 'function'
        && typeof ss.onFocusChange === 'function'
        && typeof ss.offFocusChange === 'function';
}

function _ssPanelChrome(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return (ss && typeof ss.panelChromeFor === 'function')
        ? ss.panelChromeFor(highwayCanvas) : null;
}

function _ssSettingsAnchor(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return null;
    return (ss && typeof ss.settingsAnchorFor === 'function')
        ? ss.settingsAnchorFor(highwayCanvas) : null;
}

function _ssIsCanvasFocused(highwayCanvas) {
    const ss = window.slopsmithSplitscreen;
    if (!_ssActive()) return true;  // main-player fast path
    return !!(ss && typeof ss.isCanvasFocused === 'function' &&
              ss.isCanvasFocused(highwayCanvas));
}

// ═══════════════════════════════════════════════════════════════════════
// Factory — slopsmith#36 setRenderer contract (multi-instance)
// ═══════════════════════════════════════════════════════════════════════

function createFactory() {
    const _instanceId = ++_nextInstanceId;

    // Lifecycle
    let _isReady = false;

    // Rendering state
    let _pianoCanvas = null;
    let _pianoCtx = null;
    let _highwayCanvas = null;
    let _prevHighwayDisplay = '';

    // Controls-style snapshot — only populated when we actually nudged
    // `#player-controls`, which is main-player-only. Splitscreen panels
    // already have their control bar layered above the canvas.
    let _controlsStyleTouched = false;
    let _prevControlsPosition = '';
    let _prevControlsZIndex = '';
    let _controlsAnchor = null;

    // Settings UI
    let _settingsPanel = null;
    let _settingsGear = null;
    let _settingsVisible = false;

    // MIDI held / sustain state — per-instance so each panel's
    // keyboard only shows the keys ITS user is holding, not
    // keys held on another focused panel.
    //
    // _heldNotes / _sustainedNotes are keyed by the TRANSPOSED
    // (played) midi value because that's what the keyboard draws
    // and the synth plays. _rawToPlayed is the cross-reference
    // so note-off can release the EXACT same key its matching
    // note-on opened, even if _cfg.transpose changed in between.
    // Without it, a transpose change while a note is held would
    // strand the synth envelope + the visual "held" state until
    // focus / device / destroy released them.
    const _heldNotes = new Map();
    let _sustainOn = false;
    const _sustainedNotes = new Set();
    const _rawToPlayed = new Map();

    // Scoring
    let _hits = 0, _misses = 0, _streak = 0, _bestStreak = 0;
    const _hitNoteKeys = new Set();
    const _wrongFlashes = [];
    const _missedNoteKeys = new Set();

    // Display range — interpolated toward a target for smooth transitions.
    // _displayLoF/_displayHiF are the live float values (lerped each frame).
    // _displayLo/_displayHi are their rounded integer counterparts used for
    // layout building; they're only treated as "set" once the target is known.
    let _displayLo = null, _displayHi = null;
    let _displayLoF = null, _displayHiF = null;   // float interpolated
    let _targetLo = null, _targetHi = null;        // desired integer range
    let _lastWallMs = null;                         // performance.now() at last draw
    let _lastShiftSongT = -Infinity;               // song-time of last allowed shift
    let _lastMeasureSongT = -Infinity;             // song-time of last observed measure beat
    // When key count is set, _songMapLo is the song note that maps to controllerLo.
    // _midiOffset = controllerLo - _songMapLo shifts song-space midis into display space.
    let _songMapLo = null;
    let _midiOffset = 0;
    let _cachedLayout = null, _lastLayoutW = 0;
    let _lastRangeLo = -1, _lastRangeHi = -1;

    // Latest bundle snapshot — cached each frame so MIDI handler
    // (async wrt draw) can score against the filter-aware chart
    // the user sees.
    let _latestNotes = null, _latestChords = null, _latestTime = 0;

    // Tone-change watcher state
    let _currentToneName = null;
    let _toneChangeWall = 0;   // performance.now() of last tone switch, for HUD fade

    // Wave C: replace the module-level `song:ready` subscription
    // with a bundle.isReady edge-detect per-instance. The global
    // event fires N times under splitscreen (once per panel's
    // highway); edge-detecting locally scopes the reset correctly.
    let _lastBundleIsReady = false;

    // Wave C focus state
    let _isFocused = false;

    // ── Listener refs (per-instance so destroy() detach matches) ──
    const _onWinResize = () => _applyCanvasDims();
    const _onFocusChange = () => _updateFocusState();

    // ── Focus management ──
    //
    // _instanceDestroyed is a belt-and-suspenders gate: even if the
    // splitscreen helper ever ships without an unsubscribe (or a
    // future version renames offFocusChange), the focus-change
    // handler will no-op against a destroyed instance rather than
    // mutating torn-down state. Defensive because the helper's
    // unsubscribe pathway is the only thing standing between a
    // lingering listener and a stale closure.
    let _instanceDestroyed = false;

    function _updateFocusState() {
        if (_instanceDestroyed) return;
        // _highwayCanvas is nulled by _teardown; a focus-change
        // callback fired between destroy() and the handler
        // detaching would otherwise call isCanvasFocused(null).
        if (!_highwayCanvas) return;
        const shouldFocus = _ssIsCanvasFocused(_highwayCanvas);
        if (shouldFocus && !_isFocused) {
            _isFocused = true;
            _activeInstance = instance;
        } else if (!shouldFocus && _isFocused) {
            _isFocused = false;
            _releaseAllHeld();
            if (_activeInstance === instance) _activeInstance = null;
        }
    }

    // Called by _midiConnect and focus-change to clear any held
    // state that was being visualised when focus / device switches.
    function _releaseAllHeld() {
        for (const midi of _heldNotes.keys()) _synthNoteOff(midi);
        _heldNotes.clear();
        _sustainedNotes.clear();
        _rawToPlayed.clear();
        _sustainOn = false;
    }

    // ── MIDI event handlers (called by _midiOnMessage via _activeInstance) ──
    //
    // These receive the RAW midi note from the device. Transpose is
    // applied here and the resulting `played` value is stored under
    // the raw note so note-off can find it even if _cfg.transpose
    // shifted between the matching note-on and note-off.

    function _handleNoteOn(rawMidi, velocity) {
        if (rawMidi < 0 || rawMidi > 127) return;
        // When a key count is selected, remap the physical controller range
        // onto the current display range so pressing the lowest controller key
        // triggers _displayLo, pressing the next triggers _displayLo+1, etc.
        // Transpose is applied on top of the remapped pitch.
        let played;
        if (_cfg.keyCount > 0 && _cfg.octaveRemap && _songMapLo !== null) {
            played = _songMapLo + (rawMidi - _cfg.controllerLo) + _cfg.transpose;
        } else {
            played = rawMidi + _cfg.transpose;
        }
        if (played < 0 || played > 127) return;
        _rawToPlayed.set(rawMidi, played);
        _heldNotes.set(played, velocity);
        _synthNoteOn(played, velocity);
        _synthEnsureCtx();
        if (_cfg.hitDetection) _checkHit(played);
    }

    function _handleNoteOff(rawMidi) {
        if (rawMidi < 0 || rawMidi > 127) return;
        const played = _rawToPlayed.get(rawMidi);
        // Stray note-off (no matching note-on, or already released).
        // Common after a focus / device switch that cleared held
        // state, or a transpose change that's been followed by a
        // note-on at the same raw midi (the most recent note-on
        // overwrites the entry, which is correct: only the latest
        // played value is the "real" held key).
        if (played == null) return;
        _rawToPlayed.delete(rawMidi);
        if (_sustainOn) {
            _sustainedNotes.add(played);
            return;
        }
        _heldNotes.delete(played);
        _synthNoteOff(played);
    }

    function _handleSustain(down) {
        if (down) {
            _sustainOn = true;
        } else {
            _sustainOn = false;
            for (const midi of _sustainedNotes) {
                _heldNotes.delete(midi);
                _synthNoteOff(midi);
            }
            _sustainedNotes.clear();
        }
    }

    // ── Hit detection / accuracy scoring ──

    function _checkHit(playedMidi) {
        const t = _latestTime;
        const notes = _latestNotes;
        const chords = _latestChords;

        const notesEmpty = !notes || notes.length === 0;
        const chordsEmpty = !chords || chords.length === 0;
        if (notesEmpty && chordsEmpty) return;

        let foundHit = false;

        if (notes) {
            for (const n of notes) {
                if (n.t > t + HIT_TOLERANCE + 0.5) break;
                if (n.t < t - HIT_TOLERANCE - 0.5) continue;
                const songMidi = noteToMidi(n.s, n.f);
                const key = _noteKey(n.t, songMidi);
                if (songMidi === playedMidi && Math.abs(n.t - t) <= HIT_TOLERANCE && !_hitNoteKeys.has(key)) {
                    _hitNoteKeys.add(key);
                    foundHit = true;
                    break;
                }
            }
        }

        if (!foundHit && chords) {
            for (const c of chords) {
                if (c.t > t + HIT_TOLERANCE + 0.5) break;
                if (c.t < t - HIT_TOLERANCE - 0.5) continue;
                for (const cn of (c.notes || [])) {
                    const songMidi = noteToMidi(cn.s, cn.f);
                    const key = _noteKey(c.t, songMidi);
                    if (songMidi === playedMidi && Math.abs(c.t - t) <= HIT_TOLERANCE && !_hitNoteKeys.has(key)) {
                        _hitNoteKeys.add(key);
                        foundHit = true;
                        break;
                    }
                }
                if (foundHit) break;
            }
        }

        if (foundHit) {
            _hits++;
            _streak++;
            if (_streak > _bestStreak) _bestStreak = _streak;
        } else {
            _misses++;
            _streak = 0;
            _wrongFlashes.push({ midi: playedMidi, wall: performance.now() });
        }
    }

    function _updateMissedNotes(t, notes, chords) {
        if (!_cfg.hitDetection) return;
        const cutoff = t - HIT_TOLERANCE - 0.05;

        if (notes) {
            for (const n of notes) {
                if (n.t > cutoff) break;
                if (n.t < cutoff - 2) continue;
                const songMidi = noteToMidi(n.s, n.f);
                const key = _noteKey(n.t, songMidi);
                if (!_hitNoteKeys.has(key) && !_missedNoteKeys.has(key) && n.t < cutoff) {
                    _missedNoteKeys.add(key);
                }
            }
        }
        if (chords) {
            for (const c of chords) {
                if (c.t > cutoff) break;
                if (c.t < cutoff - 2) continue;
                for (const cn of (c.notes || [])) {
                    const songMidi = noteToMidi(cn.s, cn.f);
                    const key = _noteKey(c.t, songMidi);
                    if (!_hitNoteKeys.has(key) && !_missedNoteKeys.has(key) && c.t < cutoff) {
                        _missedNoteKeys.add(key);
                    }
                }
            }
        }

        const now = performance.now();
        while (_wrongFlashes.length && now - _wrongFlashes[0].wall > 400) {
            _wrongFlashes.shift();
        }
    }

    function _resetScoring() {
        _hits = 0; _misses = 0; _streak = 0; _bestStreak = 0;
        _hitNoteKeys.clear();
        _missedNoteKeys.clear();
        _wrongFlashes.length = 0;
    }

    function _resetForNewChart() {
        _resetScoring();
        _cachedLayout = null;
        _lastLayoutW = 0;
        _lastRangeLo = -1;
        _lastRangeHi = -1;
        _displayLo = null;
        _displayHi = null;
        _displayLoF = null;
        _displayHiF = null;
        _targetLo = null;
        _targetHi = null;
        _lastWallMs = null;
        _lastShiftSongT = -Infinity;
        _lastMeasureSongT = -Infinity;
        _songMapLo = null;
        _midiOffset = 0;
        _currentToneName = null;   // force tone re-apply on first draw after song load
        // Wave C: no _primeLatestSnapshot — we don't consult the
        // bare `window.highway` global anymore (it's the main-
        // player's highway, not ours under splitscreen). First
        // MIDI hits before the first draw() just don't score.
    }

    // ── Tone change watcher ──

    function _applyToneForTime(tones, t) {
        if (!tones) return;
        let activeName = tones.base || null;
        for (const ch of (tones.changes || [])) {
            if (ch.t <= t) activeName = ch.name;
            else break;
        }
        if (activeName === _currentToneName) return;
        _currentToneName = activeName;
        _toneChangeWall = performance.now();
        if (!activeName) return;
        const def = (tones.definitions || []).find(d => d.name === activeName);
        if (def && def.gm !== undefined) {
            _synthInit().then(() => _synthLoadInstrumentGM(def.gm));
        }
    }

    // ── Display range update (per-instance) ──

    // Compute the desired integer range for the current moment, respecting
    // the mode, key-count override, section-boundary snapping, and hold-freeze.
    // Returns {lo, hi} or null if the chart is empty.
    function _computeTargetRange(notes, chords, t, beats) {
        // When key count is set, display is always anchored to controllerLo so the
        // visual keyboard matches the physical one exactly. _midiOffset handles the
        // song→display note remapping separately.
        if (VALID_KEY_COUNTS.has(_cfg.keyCount)) {
            return _rangeForKeyCount(_cfg.keyCount);
        }

        if (_cfg.practiceMode) {
            // Practice: full song range, never shifts.
            const full = detectRange(notes, chords);
            return (full && full.lo <= full.hi) ? full : { lo: 36, hi: 83 };
        }

        // Performance auto-range: use notes currently visible on screen.
        const raw = _visibleMidiRange(notes, chords, t);
        if (!raw) {
            // During rests or before first notes, hold the current target.
            // On the very first frame fall back to the full song range so the
            // screen never shows black just because no notes are visible yet.
            if (_targetLo !== null) return { lo: _targetLo, hi: _targetHi };
            const full = detectRange(notes, chords);
            return (full && full.lo <= full.hi) ? full : { lo: 36, hi: 83 };
        }

        let lo = Math.max(0, raw.lo - 2);
        let hi = Math.min(127, raw.hi + 2);
        lo = Math.floor(lo / 12) * 12;
        hi = Math.ceil((hi + 1) / 12) * 12 - 1;
        while (hi - lo < 47) {
            if (lo > 0) lo -= 12; else hi = Math.min(127, hi + 12);
        }
        return { lo, hi };
    }

    function _updateDisplayRange(notes, chords, t, beats, wallMs) {
        // Track the latest measure beat we've passed (used for section snapping).
        if (beats) {
            for (const b of beats) {
                if (b.measure > 0 && b.time > _lastMeasureSongT && b.time <= t) {
                    _lastMeasureSongT = b.time;
                }
            }
        }

        const desired = _computeTargetRange(notes, chords, t, beats);
        if (!desired) return;

        const isFirstInit = _targetLo === null;

        // In performance mode, only allow a target shift at section boundaries
        // and while no note is physically held (freeze during held notes).
        const wantShift = !isFirstInit && (desired.lo !== _targetLo || desired.hi !== _targetHi);
        if (wantShift && !_cfg.practiceMode && !_rangeForKeyCount(_cfg.keyCount)) {
            const atSectionBoundary = _lastMeasureSongT > _lastShiftSongT;
            const heldFrozen = _heldNotes.size > 0;
            if (!atSectionBoundary || heldFrozen) {
                // Defer — keep current target, let interpolation finish.
                desired.lo = _targetLo;
                desired.hi = _targetHi;
            } else {
                _lastShiftSongT = _lastMeasureSongT;
            }
        }

        _targetLo = desired.lo;
        _targetHi = desired.hi;

        // Initialise float accumulators on first call (no lerp, snap instantly).
        if (_displayLoF === null) {
            _displayLoF = _targetLo;
            _displayHiF = _targetHi;
            if (isFirstInit) _lastShiftSongT = _lastMeasureSongT;
        } else {
            // Exponential lerp toward target — frame-rate independent via wall-clock dt.
            const dtWall = wallMs !== null && _lastWallMs !== null
                ? Math.min((wallMs - _lastWallMs) / 1000, 0.1)
                : 1 / 60;
            const alpha = 1 - Math.exp(-dtWall / RANGE_LERP_TAU);
            _displayLoF += (_targetLo - _displayLoF) * alpha;
            _displayHiF += (_targetHi - _displayHiF) * alpha;
        }

        _displayLo = Math.round(_displayLoF);
        _displayHi = Math.round(_displayHiF);

        if (VALID_KEY_COUNTS.has(_cfg.keyCount) && _songMapLo === null) {
            _songMapLo = _bestSongMapLo(notes, chords, _cfg.keyCount);
        }
        if (!VALID_KEY_COUNTS.has(_cfg.keyCount)) _songMapLo = null;
        _midiOffset = (_songMapLo !== null) ? (_cfg.controllerLo - _songMapLo) : 0;
    }

    // Called when keyCount changes at runtime so the range re-locks
    // immediately on the next draw rather than waiting for a song reload.
    function _resetDisplayRange() {
        _displayLo = null;
        _displayHi = null;
        _displayLoF = null;
        _displayHiF = null;
        _targetLo = null;
        _targetHi = null;
        _lastRangeLo = -1;
        _lastRangeHi = -1;
        _lastShiftSongT = -Infinity;
        _lastMeasureSongT = -Infinity;
        _lastWallMs = null;
        _songMapLo = null;
        _midiOffset = 0;
        _cachedLayout = null;
    }

    // Called by the module-level auto-detect when controllerLo changes.
    function _resetControllerLo() {
        _resetDisplayRange();
    }

    // ── Range mismatch badge ──

    // Returns how many unique MIDI pitches in the song fall outside the
    // current keyboard range after accounting for the app transpose.
    // Controllers can also shift octaves in hardware, so we show how many
    // octave shifts would resolve the mismatch rather than treating it as
    // a hard error.
    function _checkRangeMismatch(notes, chords) {
        if (_displayLo === null || _cfg.keyCount === 0) return null;

        // With remapping on: the controller maps 1:1 onto [_displayLo, _displayHi],
        // so every note in that window is reachable.
        // With remapping off: the controller sends raw MIDI, so the reachable
        // window is [controllerLo, controllerLo + keyCount - 1].
        const tr = _cfg.transpose || 0;
        let effLo, effHi;
        if (_cfg.octaveRemap && _songMapLo !== null) {
            // Remapping on: pressing controllerLo plays _songMapLo, so the reachable
            // window in song space is [_songMapLo, _songMapLo + keyCount - 1].
            effLo = _songMapLo + tr;
            effHi = _songMapLo + _cfg.keyCount - 1 + tr;
        } else {
            // Remapping off: controller sends raw MIDI pitched at [controllerLo, ...].
            effLo = _cfg.controllerLo + tr;
            effHi = _cfg.controllerLo + _cfg.keyCount - 1 + tr;
        }

        let below = 0, above = 0;
        const seen = new Set();
        const scan = m => {
            if (seen.has(m)) return;
            seen.add(m);
            if (m < effLo) below++;
            else if (m > effHi) above++;
        };
        if (notes) for (const n of notes) scan(noteToMidi(n.s, n.f));
        if (chords) for (const c of chords) for (const cn of (c.notes || [])) scan(noteToMidi(cn.s, cn.f));
        if (!below && !above) return null;

        // Suggest the octave shift of controllerLo that would best center
        // the song's range within the display span.
        const songRange = detectRange(notes, chords);
        const span = _displayHi - _displayLo;
        const center = Math.round((songRange.lo + songRange.hi) / 2);
        const bestLo = center - Math.floor(span / 2);
        const octaveShift = Math.round((bestLo - effLo) / 12);
        return { below, above, octaveShift };
    }

    function _updateRangeBadge() {
        if (!_settingsGear) return;
        const mismatch = _checkRangeMismatch(_latestNotes, _latestChords);
        let badge = _settingsGear.querySelector('.piano-range-badge');
        if (!mismatch) {
            if (badge) badge.remove();
            _updateRangeBadgeInPanel(null);
            return;
        }
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'piano-range-badge';
            badge.style.cssText = 'position:absolute;top:2px;right:2px;width:7px;height:7px;' +
                'border-radius:50%;background:#f59e0b;pointer-events:none;';
            _settingsGear.style.position = 'relative';
            _settingsGear.appendChild(badge);
        }
        const parts = [];
        if (mismatch.below) parts.push(`${mismatch.below} note${mismatch.below > 1 ? 's' : ''} below`);
        if (mismatch.above) parts.push(`${mismatch.above} note${mismatch.above > 1 ? 's' : ''} above`);
        const shiftHint = mismatch.octaveShift
            ? ` · shift controller ${mismatch.octaveShift > 0 ? '+' : ''}${mismatch.octaveShift} oct to fit`
            : '';
        badge.title = `Song has ${parts.join(' & ')} keyboard range${shiftHint}`;
        // Mirror the warning into the open settings panel if present
        _updateRangeBadgeInPanel(mismatch);
    }

    function _updateRangeBadgeInPanel(mismatch) {
        if (!_settingsPanel) return;
        let warn = _settingsPanel.querySelector('.piano-range-warn');
        if (!mismatch) {
            if (warn) warn.remove();
            return;
        }
        if (!warn) {
            warn = document.createElement('div');
            warn.className = 'piano-range-warn';
            warn.style.cssText = 'margin-top:5px;font-size:10px;color:#f59e0b;';
            _settingsPanel.appendChild(warn);
        }
        const parts = [];
        if (mismatch.below) parts.push(`${mismatch.below} note${mismatch.below > 1 ? 's' : ''} below range`);
        if (mismatch.above) parts.push(`${mismatch.above} note${mismatch.above > 1 ? 's' : ''} above range`);
        const shiftHint = mismatch.octaveShift
            ? ` — shift controller ${mismatch.octaveShift > 0 ? '+' : ''}${mismatch.octaveShift} octave${Math.abs(mismatch.octaveShift) > 1 ? 's' : ''} to fit`
            : '';
        warn.textContent = `⚠ ${parts.join(' & ')}${shiftHint}`;
    }

    // ── Canvas / overlay management ──

    function _applyCanvasDims() {
        // The highway canvas is sized and managed by the host; we just
        // need to re-apply the DPR transform that a canvas.width/height
        // assignment resets (assigning those attributes clears all
        // context state including the transform).
        if (!_pianoCtx) return;
        const dpr = window.devicePixelRatio || 1;
        _pianoCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function _createOverlayCanvas() {
        const panelChrome = _ssPanelChrome(_highwayCanvas);
        const mount = panelChrome || document.getElementById('player');
        if (!mount) return null;

        const canvas = document.createElement('canvas');
        canvas.className = 'piano-highway-canvas';
        canvas.dataset.pianoInstance = String(_instanceId);
        canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;z-index:5;pointer-events:none;';

        if (panelChrome) {
            // Splitscreen panel chrome already has a bar at the
            // bottom; appending is fine — the bar has z-index above
            // our overlay's z-index:5.
            panelChrome.appendChild(canvas);
        } else {
            // Main-player path: insert before controls so controls
            // stay clickable above the overlay. Snapshot their
            // style and nudge them above z-index 5.
            const controls = document.getElementById('player-controls');
            if (controls) {
                if (controls.parentNode === mount) {
                    mount.insertBefore(canvas, controls);
                } else {
                    mount.appendChild(canvas);
                }
                _prevControlsPosition = controls.style.position;
                _prevControlsZIndex = controls.style.zIndex;
                _controlsStyleTouched = true;
                _controlsAnchor = controls;
                controls.style.position = 'relative';
                controls.style.zIndex = '20';
            } else {
                mount.appendChild(canvas);
            }
        }
        return canvas;
    }

    function _restoreControlsStyle() {
        if (!_controlsStyleTouched || !_controlsAnchor) return;
        _controlsAnchor.style.position = _prevControlsPosition;
        _controlsAnchor.style.zIndex = _prevControlsZIndex;
        _controlsStyleTouched = false;
        _prevControlsPosition = '';
        _prevControlsZIndex = '';
        _controlsAnchor = null;
    }

    // ── Settings panel + gear button (per-instance) ──

    function _injectSettingsGear() {
        if (_settingsGear) return;
        const anchor = _ssSettingsAnchor(_highwayCanvas) ||
                       document.getElementById('player-controls');
        if (!anchor) return;

        const gear = document.createElement('button');
        gear.className = 'btn-piano-settings px-2 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition';
        gear.dataset.pianoInstance = String(_instanceId);
        gear.type = 'button';
        gear.title = 'Piano settings (MIDI, sound, scoring)';
        gear.setAttribute('aria-label', 'Piano settings');
        const glyph = document.createElement('span');
        glyph.setAttribute('aria-hidden', 'true');
        glyph.textContent = '⚙';
        gear.appendChild(glyph);
        gear.onclick = _toggleSettings;

        if (_ssActive()) {
            // Splitscreen: append to the panel bar.
            anchor.appendChild(gear);
        } else {
            // Main-player: insert before the last direct-child button (✕ Close).
            // Use ':scope > button' to restrict to direct children — a plain
            // 'button:last-child' traverses the full subtree and can match a
            // nested button (e.g. inside #mixer-anchor) that is not a direct
            // child of anchor, causing insertBefore to throw NotFoundError.
            const btns = anchor.querySelectorAll(':scope > button');
            const closeBtn = btns.length ? btns[btns.length - 1] : null;
            if (closeBtn) anchor.insertBefore(gear, closeBtn);
            else anchor.appendChild(gear);
        }
        _settingsGear = gear;
    }

    function _removeSettingsGear() {
        if (_settingsGear) {
            _settingsGear.remove();
            _settingsGear = null;
        }
    }

    function _toggleSettings() {
        _settingsVisible = !_settingsVisible;
        if (!_settingsPanel && _settingsVisible) _createSettingsPanel();
        if (_settingsPanel) _settingsPanel.style.display = _settingsVisible ? '' : 'none';
        if (_settingsVisible) {
            _midiInit();
            _synthInit();
            _midiUpdateAllDeviceLists();
        }
    }

    function _createSettingsPanel() {
        if (_settingsPanel) return;
        const panelChrome = _ssPanelChrome(_highwayCanvas);
        const mount = panelChrome || document.getElementById('player');
        if (!mount) return;

        const panel = document.createElement('div');
        panel.className = 'piano-settings-panel';
        panel.dataset.pianoInstance = String(_instanceId);
        panel.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:25;' +
            'background:rgba(8,8,20,0.94);border-bottom:1px solid #222;padding:6px 12px;' +
            'font-family:system-ui,sans-serif;display:none;';

        const channelOpts = '<option value="-1"' + (_cfg.midiChannel === -1 ? ' selected' : '') + '>All</option>' +
            Array.from({length: 16}, (_, i) =>
                `<option value="${i}"${_cfg.midiChannel === i ? ' selected' : ''}>${i + 1}</option>`
            ).join('');

        const instrumentOpts = INSTRUMENTS.map((inst, i) =>
            `<option value="${i}"${_cfg.instrumentIdx === i ? ' selected' : ''}>${inst.name}</option>`
        ).join('');

        // All form controls use classes (not ids) so N panels don't
        // collide on getElementById lookups. Handlers bind via
        // panel.querySelector scoped to this specific panel.
        panel.innerHTML = `
            <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;">
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">MIDI</span>
                    <select class="piano-midi-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;max-width:180px;">
                        <option value="">None</option>
                    </select>
                </div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">Sound</span>
                    <select class="piano-instrument-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;">
                        ${instrumentOpts}
                    </select>
                </div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">Vol</span>
                    <input type="range" class="piano-vol-slider" min="0" max="100"
                        value="${Math.round(_cfg.synthVolume * 100)}"
                        style="width:70px;accent-color:#6366f1;height:14px;">
                </div>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">Ch</span>
                    <select class="piano-channel-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;width:52px;">
                        ${channelOpts}
                    </select>
                </div>
                <div style="display:flex;align-items:center;gap:3px;">
                    <span style="font-size:10px;color:#666;">Transpose</span>
                    <button class="piano-tr-down" type="button" style="background:#1a1a2e;border:1px solid #333;border-radius:4px;
                        width:20px;height:20px;color:#aaa;font-size:12px;cursor:pointer;line-height:1;">-</button>
                    <span class="piano-tr-val" style="font-size:11px;color:#ccc;min-width:18px;text-align:center;">${_cfg.transpose}</span>
                    <button class="piano-tr-up" type="button" style="background:#1a1a2e;border:1px solid #333;border-radius:4px;
                        width:20px;height:20px;color:#aaa;font-size:12px;cursor:pointer;line-height:1;">+</button>
                </div>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;">
                    <input type="checkbox" class="piano-chk-names" ${_cfg.showNoteNames ? 'checked' : ''}
                        style="accent-color:#6366f1;"> Notes
                </label>
                <label style="display:flex;align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;">
                    <input type="checkbox" class="piano-chk-hits" ${_cfg.hitDetection ? 'checked' : ''}
                        style="accent-color:#22cc66;"> Hits
                </label>
                <div style="display:flex;align-items:center;gap:4px;">
                    <span style="font-size:10px;color:#666;">Keys</span>
                    <select class="piano-key-count-select" style="background:#1a1a2e;border:1px solid #333;border-radius:6px;
                        padding:3px 6px;font-size:11px;color:#ccc;outline:none;">
                        <option value="0"${_cfg.keyCount === 0 ? ' selected' : ''}>Auto</option>
                        ${[32, 49, 61, 88].map(n =>
                            `<option value="${n}"${_cfg.keyCount === n ? ' selected' : ''}>${n}</option>`
                        ).join('')}
                    </select>
                </div>
                <label class="piano-ctrl-lo-wrap" style="display:${_cfg.keyCount > 0 ? 'flex' : 'none'};align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;">
                    <input type="checkbox" class="piano-chk-remap" ${_cfg.octaveRemap ? 'checked' : ''}
                        style="accent-color:#6366f1;"> Remap
                </label>
                <label class="piano-ctrl-lo-wrap" style="display:${_cfg.keyCount > 0 ? 'flex' : 'none'};align-items:center;gap:3px;font-size:11px;color:#999;cursor:pointer;">
                    <input type="checkbox" class="piano-chk-practice" ${_cfg.practiceMode ? 'checked' : ''}
                        style="accent-color:#22cc66;"> Practice
                </label>
            </div>`;

        if (panelChrome) {
            panelChrome.appendChild(panel);
        } else {
            const controls = document.getElementById('player-controls');
            if (controls) {
                if (controls.parentNode === mount) mount.insertBefore(panel, controls);
                else mount.appendChild(panel);
            }
            else mount.appendChild(panel);
        }
        _settingsPanel = panel;

        // Scope handler wiring to this specific panel via
        // panel.querySelector (not document.querySelector) so each
        // instance's controls drive its own state.
        panel.querySelector('.piano-midi-select').onchange = function () {
            _midiConnect(this.value);
            _synthInit();
        };
        panel.querySelector('.piano-instrument-select').onchange = async function () {
            const idx = parseInt(this.value);
            _saveCfg('instrumentIdx', idx);
            await _synthInit();
            await _synthLoadInstrument(idx);
        };
        panel.querySelector('.piano-vol-slider').oninput = function () {
            _synthSetVolume(parseInt(this.value) / 100);
        };
        panel.querySelector('.piano-channel-select').onchange = function () {
            _saveCfg('midiChannel', parseInt(this.value));
        };
        panel.querySelector('.piano-tr-down').onclick = function () {
            const v = Math.max(-12, _cfg.transpose - 1);
            _saveCfg('transpose', v);
            panel.querySelector('.piano-tr-val').textContent = v;
        };
        panel.querySelector('.piano-tr-up').onclick = function () {
            const v = Math.min(12, _cfg.transpose + 1);
            _saveCfg('transpose', v);
            panel.querySelector('.piano-tr-val').textContent = v;
        };
        panel.querySelector('.piano-chk-names').onchange = function () {
            _saveCfg('showNoteNames', this.checked);
        };
        panel.querySelector('.piano-chk-hits').onchange = function () {
            _saveCfg('hitDetection', this.checked);
            if (this.checked) _resetScoring();
        };
        panel.querySelector('.piano-key-count-select').onchange = function () {
            _saveCfg('keyCount', parseInt(this.value));
            _resetDisplayRange();
            const show = _cfg.keyCount > 0 ? 'flex' : 'none';
            for (const el of panel.querySelectorAll('.piano-ctrl-lo-wrap')) {
                el.style.display = show;
            }
        };
        panel.querySelector('.piano-chk-remap').onchange = function () {
            _saveCfg('octaveRemap', this.checked);
        };
        panel.querySelector('.piano-chk-practice').onchange = function () {
            _saveCfg('practiceMode', this.checked);
            _resetDisplayRange();
        };
    }

    function _removeSettingsPanel() {
        if (_settingsPanel) {
            _settingsPanel.remove();
            _settingsPanel = null;
        }
        _settingsVisible = false;
    }

    // ── Drawing ──

    function _draw(notes, chords, t, beats, templates) {
        if (!_pianoCanvas || !_pianoCtx) return;

        _latestNotes = notes;
        _latestChords = chords;
        _latestTime = t;

        const W = _pianoCanvas.width / (window.devicePixelRatio || 1);
        const H = _pianoCanvas.height / (window.devicePixelRatio || 1);
        const ctx = _pianoCtx;

        // Render the keyboard at the cached display range (or
        // detectRange's C3-B6 fallback) regardless of whether
        // the chart arrays happen to be empty for this frame.
        // Long rests and aggressive difficulty filtering can
        // produce zero in-window notes during normal playback —
        // the previous "empty arrays = no chart" early-return
        // collapsed those cases into the same blank-canvas path
        // we use during loading. The actual loading-state guard
        // is in draw() above (gated on bundle.isReady), so by
        // the time we get here the chart is confirmed loaded
        // even if the per-frame note window is empty.
        const _nowWallMs = performance.now();
        _updateDisplayRange(notes || [], chords || [], t, beats, _nowWallMs);
        _lastWallMs = _nowWallMs;
        _updateRangeBadge();
        if (_displayLo === null) {
            ctx.fillStyle = '#040408';
            ctx.fillRect(0, 0, W, H);
            return;
        }
        const lo = _displayLo;
        const hi = _displayHi;

        const kbH = H * KEYBOARD_H_FRAC;
        const kbTop = H - kbH;
        const padL = 10, padR = 10;

        if (!_cachedLayout || _lastLayoutW !== W || lo !== _lastRangeLo || hi !== _lastRangeHi) {
            _cachedLayout = buildKeyLayout(lo, hi, padL, W - padL - padR);
            _lastLayoutW = W;
            _lastRangeLo = lo;
            _lastRangeHi = hi;
        }
        const layout = _cachedLayout;

        _updateMissedNotes(t, notes, chords);

        ctx.fillStyle = '#040408';
        ctx.fillRect(0, 0, W, H);

        const noteAreaTop = 0;
        const nowLineY = kbTop * NOW_LINE_Y_FRAC;

        for (const k of layout) {
            if (k.black) continue;
            const isC = k.midi % 12 === 0;
            ctx.strokeStyle = isC ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.04)';
            ctx.lineWidth = isC ? 1.5 : 0.5;
            ctx.beginPath();
            ctx.moveTo(k.x + k.w - 0.5, noteAreaTop);
            ctx.lineTo(k.x + k.w - 0.5, kbTop);
            ctx.stroke();
        }

        if (beats) {
            for (const b of beats) {
                const dt = b.time - t;
                if (dt < -0.1 || dt > VISIBLE_SECONDS) continue;
                const y = _timeToY(dt, nowLineY, noteAreaTop);
                ctx.strokeStyle = b.measure > 0 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.04)';
                ctx.lineWidth = b.measure > 0 ? 1.5 : 0.5;
                ctx.beginPath();
                ctx.moveTo(padL, y);
                ctx.lineTo(W - padR, y);
                ctx.stroke();
            }
        }

        ctx.strokeStyle = 'rgba(255,255,255,0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(padL, nowLineY);
        ctx.lineTo(W - padR, nowLineY);
        ctx.stroke();

        _drawScrollingNotes(ctx, notes, chords, t, layout, noteAreaTop, nowLineY, templates);
        _drawOctaveShiftCues(ctx, notes, chords, t, noteAreaTop, nowLineY, W);
        _drawControllerRangeOverlay(ctx, layout, kbTop, W);
        _drawKeyboard(ctx, layout, kbTop, kbH, notes, chords, t);

        if (_cfg.hitDetection && (_hits + _misses) > 0) {
            _drawAccuracyHUD(ctx, W);
        }

        // MIDI indicator — show on the focused panel only; non-focused
        // panels don't receive input so the dot would be misleading.
        if (_midiInput && _isFocused) {
            ctx.fillStyle = '#22cc66';
            ctx.beginPath();
            ctx.arc(W - 20, 16, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#22cc6688';
            ctx.font = '9px sans-serif';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText('MIDI', W - 28, 16);
        }

        // Tone name pill — fades out 2 s after a tone switch.
        if (_currentToneName) {
            const age = performance.now() - _toneChangeWall;
            const fadeStart = 1400, fadeDur = 600;
            const alpha = age < fadeStart ? 1 : Math.max(0, 1 - (age - fadeStart) / fadeDur);
            if (alpha > 0) {
                const label = '♪ ' + _currentToneName;
                ctx.font = 'bold 10px sans-serif';
                const tw = ctx.measureText(label).width;
                const padX = 6, padY = 3;
                const pillW = tw + padX * 2;
                const pillH = 10 + padY * 2;
                const kbTop = H * (1 - KEYBOARD_H_FRAC);
                const pillY = kbTop - pillH - 6;
                const pillX = W - pillW - 10;

                ctx.fillStyle = `rgba(8,8,20,${0.78 * alpha})`;
                _roundRect(ctx, pillX, pillY, pillW, pillH, 4);
                ctx.fill();

                ctx.fillStyle = `rgba(180,180,220,${alpha})`;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, pillX + padX, pillY + pillH / 2);
            }
        }
    }

    function _drawScrollingNotes(ctx, notes, chords, t, layout, topY, nowLineY, templates) {
        const allNotes = [];

        if (notes) {
            for (const n of notes) {
                const dt = n.t - t;
                if (dt > VISIBLE_SECONDS + 1) break;
                if (dt < -1 && (n.t + (n.sus || 0)) < t - 0.5) continue;
                allNotes.push({ midi: noteToMidi(n.s, n.f) + _midiOffset, t: n.t, sus: n.sus || 0, accent: n.ac });
            }
        }
        if (chords) {
            for (const c of chords) {
                const dt = c.t - t;
                if (dt > VISIBLE_SECONDS + 1) break;
                if (dt < -1) continue;
                for (const cn of (c.notes || [])) {
                    allNotes.push({ midi: noteToMidi(cn.s, cn.f) + _midiOffset, t: c.t, sus: cn.sus || 0, accent: cn.ac });
                }
            }
        }

        for (const n of allNotes) {
            const key = keyForMidi(n.midi, layout);
            if (!key) continue;

            const dt = n.t - t;
            const dtEnd = (n.t + n.sus) - t;

            const yBottom = _timeToY(dt, nowLineY, topY);
            const yTop = n.sus > 0.05 ? _timeToY(Math.max(dt, dtEnd), nowLineY, topY) : yBottom - 8;

            const y1 = Math.max(topY, Math.min(yTop, yBottom));
            const y2 = Math.min(nowLineY + 10, Math.max(yTop, yBottom));
            const noteH = y2 - y1;
            if (noteH < 1) continue;

            const isActive = dt <= 0.05 && dtEnd >= -0.05;
            const isOnBlack = key.black;

            const inset = isOnBlack ? 1 : 2;
            const barX = key.x + inset;
            const barW = key.w - inset * 2;
            const radius = Math.min(4, barW / 3, noteH / 2);

            const nk = _noteKey(n.t, n.midi);
            let useHitColor = false, useMissColor = false;
            if (_cfg.hitDetection) {
                if (_hitNoteKeys.has(nk)) useHitColor = true;
                else if (_missedNoteKeys.has(nk)) useMissColor = true;
            }

            const [cr, cg, cb] = _neonRGB(n.midi);
            const df = isOnBlack ? 0.7 : 1.0;
            let r = cr * df, g = cg * df, b = cb * df;

            if (useHitColor) { r = 0; g = 1; b = 0.27; }
            else if (useMissColor) { r = 0.33; g = 0.33; b = 0.4; }

            if (!useMissColor) {
                const glowAlpha = isActive ? 0.5 : 0.25;
                for (let i = 2; i >= 0; i--) {
                    const spread = (i + 1) * 2;
                    const a = glowAlpha * (0.15 + (2 - i) * 0.12);
                    ctx.strokeStyle = _rgbStr(r, g, b, a);
                    ctx.lineWidth = spread;
                    _roundRect(ctx, barX - 1, y1 - 1, barW + 2, noteH + 2, radius + 1);
                    ctx.stroke();
                }
            }

            ctx.fillStyle = _rgbStr(r, g, b, useMissColor ? 0.4 : 1);
            _roundRect(ctx, barX, y1, barW, noteH, radius);
            ctx.fill();

            if (!useMissColor && noteH > 4) {
                const grad = ctx.createLinearGradient(0, y1, 0, y1 + Math.min(noteH, 12));
                grad.addColorStop(0, _rgbStr(Math.min(r + 0.3, 1), Math.min(g + 0.3, 1), Math.min(b + 0.3, 1), 0.4));
                grad.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = grad;
                _roundRect(ctx, barX, y1, barW, noteH, radius);
                ctx.fill();
            }

            if (_cfg.showNoteNames && noteH >= NOTE_LABEL_MIN_H && barW >= 14) {
                const fontSize = Math.min(10, barW * 0.45);
                ctx.font = `bold ${fontSize}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillStyle = 'rgba(0,0,0,0.6)';
                ctx.fillText(midiToNoteName(n.midi), barX + barW / 2 + 0.5, y1 + noteH / 2 + 0.5);
                ctx.fillStyle = '#fff';
                ctx.fillText(midiToNoteName(n.midi), barX + barW / 2, y1 + noteH / 2);
            }
        }

        // Chord-name floating labels — drawn after all bars so they sit on top.
        if (_cfg.showNoteNames && chords && templates) {
            const activeChordLabels = [];
            for (const c of chords) {
                const dt = c.t - t;
                if (dt > VISIBLE_SECONDS + 1) break;
                if (dt < -1) continue;

                const tmpl = c.tmpl != null ? templates[c.tmpl] : null;
                const chordName = tmpl && tmpl.name ? tmpl.name : null;
                if (!chordName) continue;

                let isActive = false;
                let leftmostMidi = Infinity;
                for (const cn of (c.notes || [])) {
                    const dtEnd = (c.t + (cn.sus || 0)) - t;
                    if (dt <= 0.05 && dtEnd >= -0.05) isActive = true;
                    const m = noteToMidi(cn.s, cn.f);
                    if (m < leftmostMidi) leftmostMidi = m;
                }
                if (!isActive || leftmostMidi === Infinity) continue;

                const leftKey = keyForMidi(leftmostMidi, layout);
                if (!leftKey) continue;

                activeChordLabels.push({ name: chordName, x: leftKey.x + leftKey.w / 2 });
            }

            const labelFontSize = 11;
            const labelPadX = 5;
            const labelPadY = 3;
            const labelH = labelFontSize + labelPadY * 2;
            const labelY = nowLineY - 8 - labelH;

            ctx.font = `bold ${labelFontSize}px sans-serif`;
            for (const label of activeChordLabels) {
                const tw = ctx.measureText(label.name).width;
                const lx = label.x - tw / 2 - labelPadX;
                const lw = tw + labelPadX * 2;

                ctx.fillStyle = 'rgba(10,10,28,0.82)';
                _roundRect(ctx, lx, labelY, lw, labelH, 4);
                ctx.fill();

                ctx.fillStyle = '#fff';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label.name, label.x, labelY + labelH / 2);
            }
        }
    }

    // Draws octave-shift cue labels on the left edge of the highway whenever
    // upcoming notes require the player to move their controller to a different
    // octave. Only active when a key count is selected; behavior differs based
    // on whether remapping is on or off.
    function _drawOctaveShiftCues(ctx, notes, chords, t, topY, nowLineY, W) {
        if (_cfg.keyCount === 0 || _displayLo === null) return;

        const span = _displayHi - _displayLo; // semitones the display covers

        // For each upcoming note decide which octave shift (in 12-semitone steps)
        // would be needed to bring it into the reachable window, then record the
        // earliest time that shift is first required.
        // shiftMap: octaveShift (integer) → earliest note time requiring it
        const shiftMap = new Map();

        const scan = (midi, time) => {
            let shift;
            if (_cfg.octaveRemap) {
                // Remapping on: reachable window is [_songMapLo, _songMapLo + keyCount - 1]
                // in song space. Out-of-range notes need the display to shift, which isn't
                // possible mid-song with a locked range — show how many octave presses the
                // song deviates so the player knows to skip / watch.
                if (_songMapLo === null) return;
                const smLo = _songMapLo, smHi = _songMapLo + _cfg.keyCount - 1;
                if (midi >= smLo && midi <= smHi) return;
                // Fewest full-octave presses to bring midi into [smLo, smHi].
                shift = midi > smHi
                    ? Math.ceil((midi - smHi) / 12)
                    : -Math.ceil((smLo - midi) / 12);
            } else {
                // Remapping off: reachable = [controllerLo, controllerLo + span].
                const ctrlLo = _cfg.controllerLo, ctrlHi = ctrlLo + span;
                if (midi >= ctrlLo && midi <= ctrlHi) return;
                // Fewest full-octave presses to bring midi into [ctrlLo, ctrlHi].
                shift = midi > ctrlHi
                    ? Math.ceil((midi - ctrlHi) / 12)
                    : -Math.ceil((ctrlLo - midi) / 12);
            }
            if (!shiftMap.has(shift) || time < shiftMap.get(shift)) {
                shiftMap.set(shift, time);
            }
        };

        if (notes) {
            for (const n of notes) {
                const dt = n.t - t;
                if (dt > VISIBLE_SECONDS) break;
                if (dt < 0) continue;
                scan(noteToMidi(n.s, n.f), n.t);
            }
        }
        if (chords) {
            for (const c of chords) {
                const dt = c.t - t;
                if (dt > VISIBLE_SECONDS) break;
                if (dt < 0) continue;
                for (const cn of (c.notes || [])) scan(noteToMidi(cn.s, cn.f), c.t);
            }
        }

        if (shiftMap.size === 0) return;

        ctx.save();
        ctx.font = 'bold 11px sans-serif';
        ctx.textBaseline = 'middle';

        for (const [shift, time] of shiftMap) {
            const dt = time - t;
            const y = _timeToY(dt, nowLineY, topY);

            const label = shift > 0 ? `▲ +${shift} oct` : `▼ ${shift} oct`;
            const isUrgent = dt < VISIBLE_SECONDS * 0.25;
            const color = isUrgent ? '#f87171' : '#f59e0b';

            // Pill background
            const tw = ctx.measureText(label).width;
            const ph = 16, pw = tw + 12, px = 6, py = y - ph / 2;
            ctx.fillStyle = isUrgent ? 'rgba(248,113,113,0.18)' : 'rgba(245,158,11,0.15)';
            _roundRect(ctx, px, py, pw, ph, 4);
            ctx.fill();

            // Border
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            _roundRect(ctx, px, py, pw, ph, 4);
            ctx.stroke();

            // Label text
            ctx.fillStyle = color;
            ctx.textAlign = 'left';
            ctx.fillText(label, px + 6, y);
        }

        ctx.restore();
    }

    // Draws a translucent strip just above the keyboard showing the controller's
    // currently-mapped physical span, with note-name labels at its edges so the
    // player can orient themselves after a range shift.
    function _drawControllerRangeOverlay(ctx, layout, kbTop, W) {
        if (_cfg.keyCount === 0 || _displayLo === null) return;

        // Always show the physical controller span — controllerLo is the left edge
        // the player sees on their device regardless of remap mode.
        const mapLo = _cfg.controllerLo;
        const mapHi = _cfg.controllerLo + _cfg.keyCount - 1;

        // Find X extents from the layout for mapLo and mapHi.
        const loKey = keyForMidi(mapLo, layout);
        const hiKey = keyForMidi(mapHi, layout);
        if (!loKey && !hiKey) return;

        const x1 = loKey ? loKey.x : layout[0].x;
        const hiK = hiKey || layout[layout.length - 1];
        const x2 = hiK.x + hiK.w;

        const stripH = 6;
        const stripY = kbTop - stripH - 1;

        // Filled bar
        ctx.fillStyle = 'rgba(99,102,241,0.35)';
        ctx.fillRect(x1, stripY, x2 - x1, stripH);

        // Border
        ctx.strokeStyle = 'rgba(99,102,241,0.8)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x1 + 0.5, stripY + 0.5, x2 - x1 - 1, stripH - 1);

        // Edge labels (lowest and highest mapped note names)
        ctx.font = 'bold 9px sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(180,180,255,0.9)';

        // Show physical note → mapped song note so the player can orient themselves.
        const songLo = _songMapLo !== null ? midiToNoteName(_songMapLo) : midiToNoteName(mapLo);
        const songHi = _songMapLo !== null ? midiToNoteName(_songMapLo + (mapHi - mapLo)) : midiToNoteName(mapHi);
        const loLabel = _midiOffset !== 0 ? `${midiToNoteName(mapLo)}→${songLo}` : midiToNoteName(mapLo);
        const hiLabel = _midiOffset !== 0 ? `${midiToNoteName(mapHi)}→${songHi}` : midiToNoteName(mapHi);

        ctx.textAlign = 'left';
        ctx.fillText(loLabel, x1 + 2, stripY);
        ctx.textAlign = 'right';
        ctx.fillText(hiLabel, x2 - 2, stripY);
    }

    function _drawKeyboard(ctx, layout, kbTop, kbH, notes, chords, t) {
        const songActiveSet = new Set();
        const window_ = 0.06;
        if (notes) {
            for (const n of notes) {
                if (n.t > t + window_) continue;
                const end = n.t + (n.sus || 0);
                if (end < t - window_) continue;
                if (n.t <= t + window_ && end >= t - window_)
                    songActiveSet.add(noteToMidi(n.s, n.f) + _midiOffset);
            }
        }
        if (chords) {
            for (const c of chords) {
                if (c.t > t + window_) continue;
                if (c.t < t - 1) continue;
                for (const cn of (c.notes || [])) {
                    const end = c.t + (cn.sus || 0);
                    if (c.t <= t + window_ && end >= t - window_)
                        songActiveSet.add(noteToMidi(cn.s, cn.f) + _midiOffset);
                }
            }
        }

        const wrongSet = new Set();
        const now = performance.now();
        for (const wf of _wrongFlashes) {
            if (now - wf.wall < 400) wrongSet.add(wf.midi);
        }

        ctx.fillStyle = '#060610';
        ctx.fillRect(0, kbTop - 1, ctx.canvas.width / (window.devicePixelRatio || 1), kbH + 3);

        const blackH = kbH * 0.62;
        const cornerR = 5;

        for (const k of layout) {
            if (k.black) continue;
            const songActive = songActiveSet.has(k.midi);
            const playerHeld = _heldNotes.has(k.midi);
            const isWrong = wrongSet.has(k.midi);
            const pressed = songActive || playerHeld;
            const pressOffset = pressed ? 2 : 0;
            const kw = k.w - 1;

            const [nr, ng, nb] = _neonRGB(k.midi);
            let fr = 0.91, fg = 0.91, fb = 0.94;
            if (playerHeld && songActive) {
                fr = 0; fg = 1; fb = 0.27;
            } else if (isWrong && playerHeld) {
                fr = 1; fg = 0.27; fb = 0.27;
            } else if (playerHeld) {
                fr = 0.27; fg = 0.53; fb = 1;
            } else if (songActive) {
                fr = nr; fg = ng; fb = nb;
            } else {
                const ap = _approachAlpha(k.midi, notes, chords, t, _midiOffset);
                if (ap > 0) {
                    fr += (nr - fr) * ap * 0.6;
                    fg += (ng - fg) * ap * 0.6;
                    fb += (nb - fb) * ap * 0.6;
                }
            }

            const grad = ctx.createLinearGradient(0, kbTop + pressOffset, 0, kbTop + kbH);
            grad.addColorStop(0, _rgbStr(Math.min(fr + 0.08, 1), Math.min(fg + 0.08, 1), Math.min(fb + 0.08, 1)));
            grad.addColorStop(0.85, _rgbStr(fr, fg, fb));
            grad.addColorStop(1, _rgbStr(fr * 0.75, fg * 0.75, fb * 0.75));
            ctx.fillStyle = grad;
            _roundRectBottom(ctx, k.x, kbTop + pressOffset, kw, kbH - pressOffset, cornerR);
            ctx.fill();

            ctx.strokeStyle = 'rgba(100,100,120,0.4)';
            ctx.lineWidth = 0.5;
            _roundRectBottom(ctx, k.x, kbTop + pressOffset, kw, kbH - pressOffset, cornerR);
            ctx.stroke();

            if (!pressed) {
                const ap = _approachAlpha(k.midi, notes, chords, t, _midiOffset);
                if (ap > 0.15) {
                    const ba = Math.min((ap - 0.15) * 1.5, 1);
                    ctx.strokeStyle = _rgbStr(nr, ng, nb, ba * 0.6);
                    ctx.lineWidth = 2;
                    _roundRectBottom(ctx, k.x + 1, kbTop + 1, kw - 2, kbH - 2, cornerR);
                    ctx.stroke();
                }
            }

            if (pressed) {
                ctx.shadowColor = _rgbStr(fr, fg, fb);
                ctx.shadowBlur = 12;
                ctx.fillStyle = 'rgba(0,0,0,0)';
                _roundRectBottom(ctx, k.x, kbTop + pressOffset, kw, kbH - pressOffset, cornerR);
                ctx.fill();
                ctx.shadowBlur = 0;
            }

            const pc = k.midi % 12;
            const noteLetter = ['C','','D','','E','F','','G','','A','','B'][pc];
            if (noteLetter) {
                const isC = pc === 0;
                const label = isC ? 'C' + (Math.floor(k.midi / 12) - 1) : noteLetter;
                ctx.fillStyle = pressed ? 'rgba(0,0,0,0.7)' : 'rgba(80,80,100,0.5)';
                ctx.font = `${isC ? 'bold ' : ''}${Math.min(10, kw * 0.45)}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillText(label, k.x + kw / 2, kbTop + kbH - 3 + pressOffset);
            }
        }

        for (const k of layout) {
            if (!k.black) continue;
            const songActive = songActiveSet.has(k.midi);
            const playerHeld = _heldNotes.has(k.midi);
            const isWrong = wrongSet.has(k.midi);
            const pressed = songActive || playerHeld;
            const pressOffset = pressed ? 1 : 0;

            const [nr, ng, nb] = _neonRGB(k.midi);
            let fr = 0.1, fg = 0.1, fb = 0.12;
            if (playerHeld && songActive) {
                fr = 0; fg = 0.8; fb = 0.2;
            } else if (isWrong && playerHeld) {
                fr = 0.8; fg = 0.15; fb = 0.15;
            } else if (playerHeld) {
                fr = 0.2; fg = 0.4; fb = 0.8;
            } else if (songActive) {
                fr = nr * 0.8; fg = ng * 0.8; fb = nb * 0.8;
            } else {
                const ap = _approachAlpha(k.midi, notes, chords, t, _midiOffset);
                if (ap > 0) {
                    fr += (nr * 0.7 - fr) * ap * 0.6;
                    fg += (ng * 0.7 - fg) * ap * 0.6;
                    fb += (nb * 0.7 - fb) * ap * 0.6;
                }
            }

            const grad = ctx.createLinearGradient(0, kbTop + pressOffset, 0, kbTop + blackH);
            grad.addColorStop(0, _rgbStr(Math.min(fr + 0.06, 1), Math.min(fg + 0.06, 1), Math.min(fb + 0.06, 1)));
            grad.addColorStop(0.7, _rgbStr(fr, fg, fb));
            grad.addColorStop(1, _rgbStr(fr * 0.6, fg * 0.6, fb * 0.6));
            ctx.fillStyle = grad;
            _roundRectBottom(ctx, k.x, kbTop + pressOffset, k.w, blackH - pressOffset, 3);
            ctx.fill();

            ctx.strokeStyle = 'rgba(50,50,60,0.5)';
            ctx.lineWidth = 0.5;
            _roundRectBottom(ctx, k.x, kbTop + pressOffset, k.w, blackH - pressOffset, 3);
            ctx.stroke();

            if (!pressed) {
                const ap = _approachAlpha(k.midi, notes, chords, t, _midiOffset);
                if (ap > 0.15) {
                    const ba = Math.min((ap - 0.15) * 1.5, 1);
                    ctx.strokeStyle = _rgbStr(nr, ng, nb, ba * 0.5);
                    ctx.lineWidth = 1.5;
                    _roundRectBottom(ctx, k.x + 1, kbTop + 1, k.w - 2, blackH - 2, 3);
                    ctx.stroke();
                }
            }

            if (pressed) {
                ctx.shadowColor = _rgbStr(fr, fg, fb);
                ctx.shadowBlur = 10;
                ctx.fillStyle = 'rgba(0,0,0,0)';
                _roundRectBottom(ctx, k.x, kbTop + pressOffset, k.w, blackH - pressOffset, 3);
                ctx.fill();
                ctx.shadowBlur = 0;
            }
        }
    }

    function _drawAccuracyHUD(ctx, W) {
        const total = _hits + _misses;
        const pct = total > 0 ? Math.round((_hits / total) * 100) : 0;

        const hudY = 10;
        const hudH = 22;
        const text = `Accuracy: ${pct}%   Streak: ${_streak}   Best: ${_bestStreak}   ${_hits}/${total}`;

        ctx.font = 'bold 11px sans-serif';
        const tw = ctx.measureText(text).width;
        const hudX = (W - tw) / 2 - 12;
        const hudW = tw + 24;

        ctx.fillStyle = 'rgba(8,8,20,0.75)';
        _roundRect(ctx, hudX, hudY, hudW, hudH, 6);
        ctx.fill();

        ctx.fillStyle = pct >= 80 ? '#22cc66' : pct >= 50 ? '#ffcc33' : '#ff6644';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, W / 2, hudY + hudH / 2);
    }

    // ── Teardown ──

    function _teardown() {
        if (_pianoCanvas) {
            // _pianoCanvas IS the highway canvas — do not remove it from
            // the DOM. Just clear our refs so draw() gates correctly.
            _pianoCanvas = null;
            _pianoCtx = null;
        }
        _removeSettingsPanel();
        _removeSettingsGear();
        _restoreControlsStyle();

        _releaseAllHeld();

        if (_highwayCanvas) {
            // We never hid the highway canvas, so nothing to restore.
            _highwayCanvas = null;
            _prevHighwayDisplay = '';
        }

        // Removing our gear may unwrap #player-controls back to one
        // row, which would leave the host's canvas style.height at our
        // smaller-bar value and the next renderer drawing into an
        // undersized box. Re-trigger the host's measure pass to match
        // the post-teardown DOM. Best-effort — host may already be
        // gone if the page is unloading.
        try { window.highway && window.highway.resize && window.highway.resize(); }
        catch (e) { console.warn('[Piano] host resize on teardown failed:', e); }

        _latestNotes = null;
        _latestChords = null;
        _latestTime = 0;
    }

    // ── Factory return: setRenderer contract ──

    const instance = {
        init(canvas /* , bundle */) {
            // Defensive teardown if a prior init wasn't paired with
            // destroy. Remove listeners, restore canvas, release
            // held state — mirrors destroy() exactly, INCLUDING
            // removing from _instances and pausing MIDI if we're
            // the last live instance. Without the _instances
            // cleanup, a re-init that subsequently fails early
            // (no mount / null ctx) would leave the instance
            // orphaned in the set, making _instances.size checks
            // inaccurate and preventing _midiPauseHandler from
            // ever running.
            if (_pianoCanvas || _isReady) {
                window.removeEventListener('resize', _onWinResize);
                const ss = window.slopsmithSplitscreen;
                if (ss && typeof ss.offFocusChange === 'function') {
                    ss.offFocusChange(_onFocusChange);
                }
                _instances.delete(instance);
                if (_activeInstance === instance) _activeInstance = null;
                _teardown();
                _isReady = false;
                _isFocused = false;
                if (_instances.size === 0) _midiPauseHandler();
            }

            // Clear the destroyed sentinel so an init() following a
            // destroy() on the same factory object (e.g. highway
            // re-using a renderer across songs) re-enables focus
            // updates. Set to true in destroy() above — without this
            // reset, _updateFocusState would permanently no-op.
            _instanceDestroyed = false;

            _highwayCanvas = canvas;
            // Snapshot/restore via `visibility` (not `display`): the host's
            // rAF loop gates draw on `canvas.offsetParent !== null`, which is
            // null whenever `display:none` is on the element or any ancestor.
            // Hiding the host canvas via display:none therefore stops the
            // host from ever calling our draw() and leaves the overlay
            // permanently black. `visibility:hidden` keeps offsetParent live
            // while still hiding the host's last-painted frame.
            _prevHighwayDisplay = canvas ? canvas.style.visibility : '';

            // Draw directly on the highway canvas passed to init — no
            // separate overlay canvas needed. Eliminates the z-index /
            // position / visibility-hide complexity that broke on layouts
            // where #player-controls is nested inside #player-footer
            // (which has z-index:10, above our former overlay's z-index:5).
            _pianoCanvas = _highwayCanvas;
            _pianoCtx = _pianoCanvas ? _pianoCanvas.getContext('2d') : null;
            if (!_pianoCtx) {
                console.warn('[Piano] init: could not get 2d context from highway canvas; aborting');
                _pianoCanvas = null;
                _highwayCanvas = null;
                _prevHighwayDisplay = '';
                return;
            }

            _injectSettingsGear();
            // Re-apply DPR transform — the highway resize that ran just
            // before our init() will have cleared context state via a
            // canvas.width = … assignment.
            _applyCanvasDims();

            const ss = window.slopsmithSplitscreen;
            // Subscribe only when BOTH on/offFocusChange exist on
            // the helper. A subscribe-without-unsubscribe path
            // would leak the listener every init/destroy cycle and
            // — combined with _ssActive's strict surface check
            // returning false — also produce inconsistent focus
            // routing where the listener fires but the wrappers
            // treat splitscreen as inactive.
            if (ss && typeof ss.onFocusChange === 'function'
                   && typeof ss.offFocusChange === 'function') {
                ss.onFocusChange(_onFocusChange);
            }

            _resetForNewChart();

            _instances.add(instance);

            // Kick off MIDI + synth. One-time init — subsequent
            // instances no-op out because the module singletons are
            // already populated.
            _midiInit();
            _synthInit();

            _isReady = true;

            // Determine focus BEFORE resuming the MIDI handler so
            // _activeInstance is populated when onmidimessage gets
            // wired. Otherwise a MIDI message arriving in the
            // window between _midiResumeHandler and the first
            // focus-change event would route through _midiOnMessage
            // → null _activeInstance → silently dropped. Main-player
            // fast path takes effect synchronously here too.
            _updateFocusState();
            _midiResumeHandler();
        },
        draw(bundle) {
            if (!_isReady || !bundle) return;

            // Wave C: bundle.isReady edge detect in place of the
            // global song:ready subscription. Each panel's highway
            // emits song:ready independently; subscribing at module
            // scope would fire N×. Edge-detecting per-instance
            // correctly scopes the reset.
            const isReady = !!bundle.isReady;
            if (isReady && !_lastBundleIsReady) {
                _resetForNewChart();
            }
            _lastBundleIsReady = isReady;

            // Loading / reconnect window — chart isn't confirmed
            // yet. Paint the plugin's base background so the
            // previous chart's notes + HUD don't sit frozen on
            // screen, but DON'T render the keyboard either since
            // we don't know what tuning / range applies. Once
            // bundle.isReady flips true we hand off to _draw
            // which renders the keyboard at the discovered range
            // (or a sane default if the visible window is empty).
            if (!isReady) {
                if (_pianoCanvas && _pianoCtx) {
                    _applyCanvasDims();
                    const W = _pianoCanvas.width / (window.devicePixelRatio || 1);
                    const H = _pianoCanvas.height / (window.devicePixelRatio || 1);
                    _pianoCtx.fillStyle = '#040408';
                    _pianoCtx.fillRect(0, 0, W, H);
                }
                return;
            }
            _applyCanvasDims();

            if (bundle.tones) _applyToneForTime(bundle.tones, bundle.currentTime);
            _draw(bundle.notes, bundle.chords, bundle.currentTime, bundle.beats, bundle.templates);
        },
        resize(/* w, h */) {
            _applyCanvasDims();
        },
        destroy() {
            _isReady = false;
            // Set BEFORE attempting the (best-effort) unsubscribe so
            // the focus-change handler's _instanceDestroyed guard
            // catches any event that sneaks through a failed /
            // missing offFocusChange call.
            _instanceDestroyed = true;
            window.removeEventListener('resize', _onWinResize);
            const ss = window.slopsmithSplitscreen;
            if (ss && typeof ss.offFocusChange === 'function') {
                ss.offFocusChange(_onFocusChange);
            }
            _instances.delete(instance);
            if (_activeInstance === instance) _activeInstance = null;
            _isFocused = false;
            // Pause the MIDI handler only if we're the last instance
            // standing. Otherwise other instances still need MIDI
            // events flowing into _midiOnMessage (which routes to the
            // currently-focused instance).
            if (_instances.size === 0) {
                _midiPauseHandler();
            }
            _teardown();
        },
        // Internal hooks used by module-level MIDI router.
        _handleNoteOn,
        _handleNoteOff,
        _handleSustain,
        _releaseAllHeld,
        _resetControllerLo,
    };

    return instance;
}

createFactory.matchesArrangement = function (songInfo) {
    if (!songInfo) return false;
    if (songInfo.arrangement && KEYS_PATTERNS.test(songInfo.arrangement)) return true;
    if (Array.isArray(songInfo.arrangements)) {
        const idx = songInfo.arrangement_index;
        const arr = songInfo.arrangements.find(a => a.index === idx);
        if (arr && KEYS_PATTERNS.test(arr.name)) return true;
    }
    return false;
};

window.slopsmithViz_piano = createFactory;

})();
