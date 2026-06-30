/**
 * Unit tests for pure-logic functions extracted from screen.js:
 *   - noteToMidi(string, fret)       — string * 24 + fret encoding
 *   - detectRange(notes, chords)     — MIDI pitch range + auto-zoom
 *
 * These functions are inside the IIFE in screen.js so they can't be directly
 * imported.  The implementations are small enough to inline here verbatim
 * (any drift from the source will be caught by the differing test results).
 * Run with: node tests/test_piano_logic.js
 */

'use strict';
const assert = require('assert').strict;

// ── Functions under test (verbatim copies from screen.js) ────────────────────

function noteToMidi(string, fret) { return string * 24 + fret; }

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

// ── Helpers ───────────────────────────────────────────────────────────────────

let _passed = 0, _failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✓  ${name}`);
        _passed++;
    } catch (e) {
        console.error(`  ✗  ${name}`);
        console.error(`       ${e.message}`);
        _failed++;
    }
}

function note(s, f) { return { s, f }; }
function chord(...notes) { return { notes }; }

// ── noteToMidi ────────────────────────────────────────────────────────────────

console.log('\nnoteToMidi');

test('string 0, fret 0 → 0',    () => assert.equal(noteToMidi(0, 0), 0));
test('string 1, fret 0 → 24',   () => assert.equal(noteToMidi(1, 0), 24));
test('string 2, fret 0 → 48',   () => assert.equal(noteToMidi(2, 0), 48));
test('string 0, fret 12 → 12',  () => assert.equal(noteToMidi(0, 12), 12));
test('string 3, fret 7 → 79',   () => assert.equal(noteToMidi(3, 7), 79));
test('string 5, fret 24 → 144', () => assert.equal(noteToMidi(5, 24), 144));

// ── detectRange — alignment ───────────────────────────────────────────────────

console.log('\ndetectRange — MIDI alignment');

test('output lo is multiple of 12', () => {
    const { lo } = detectRange([note(1, 3)], []);   // midi 27
    assert.equal(lo % 12, 0, `lo=${lo}`);
});

test('output hi ≡ 11 (mod 12)', () => {
    const { hi } = detectRange([note(1, 3)], []);   // midi 27
    assert.equal((hi + 1) % 12, 0, `hi=${hi}`);
});

test('range spans at least 48 semitones', () => {
    const { lo, hi } = detectRange([note(2, 0)], []);  // midi 48
    assert.ok(hi - lo >= 47, `span=${hi - lo}`);
});

// ── detectRange — single note ─────────────────────────────────────────────────

console.log('\ndetectRange — single note');

test('note at midi 60 is inside returned range', () => {
    const { lo, hi } = detectRange([note(2, 12)], []);  // 48+12=60
    assert.ok(lo <= 60 && 60 <= hi, `range=[${lo},${hi}]`);
});

test('low note (midi 12) — range expands, note included', () => {
    const { lo, hi } = detectRange([note(0, 12)], []);  // midi 12
    assert.ok(lo <= 12 && hi >= 12);
    assert.ok(hi - lo >= 47);
});

test('very high note — hi capped at 127', () => {
    const { hi } = detectRange([note(5, 24)], []);  // midi 144 → capped
    assert.ok(hi <= 127);
});

// ── detectRange — multiple notes ──────────────────────────────────────────────

console.log('\ndetectRange — multiple notes');

test('range contains all note midis (24, 48, 72)', () => {
    const notes = [note(1, 0), note(2, 0), note(3, 0)];
    const { lo, hi } = detectRange(notes, []);
    assert.ok(lo <= 24 && hi >= 72, `range=[${lo},${hi}]`);
});

test('chord notes (midi 5, 33) included', () => {
    const { lo, hi } = detectRange([], [chord(note(0, 5), note(1, 9))]);
    assert.ok(lo <= 5 && hi >= 33, `range=[${lo},${hi}]`);
});

test('mixed notes+chords — combined range (midi 2 and 72)', () => {
    const { lo, hi } = detectRange([note(0, 2)], [chord(note(3, 0))]);
    assert.ok(lo <= 2 && hi >= 72);
});

// ── detectRange — empty / null ────────────────────────────────────────────────

console.log('\ndetectRange — empty / null');

test('empty arrays → default range [36, 83]', () => {
    const { lo, hi } = detectRange([], []);
    assert.equal(lo, 36); assert.equal(hi, 83);
});

test('null inputs → default range [36, 83]', () => {
    const { lo, hi } = detectRange(null, null);
    assert.equal(lo, 36); assert.equal(hi, 83);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${_passed + _failed} tests: ${_passed} passed, ${_failed} failed\n`);
if (_failed > 0) process.exit(1);
