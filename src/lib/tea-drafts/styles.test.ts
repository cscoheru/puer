/**
 * Tests for styles.ts.
 *
 * Run: node --test --test-reporter=spec src/lib/tea-drafts/styles.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STYLES, styleFor, styleByKey, type StyleKey } from "./styles.ts";

test("STYLES: five distinct styles, each with a key, label and voice", () => {
  assert.equal(STYLES.length, 5);
  const keys = new Set<string>(STYLES.map((s) => s.key));
  assert.equal(keys.size, STYLES.length, "style keys must be unique");
  for (const s of STYLES) {
    assert.ok(s.label.trim().length > 0, `style ${s.key} has an empty label`);
    assert.ok(s.voice.trim().length > 0, `style ${s.key} has an empty voice`);
  }
});

test("styleFor: the same note always gets the same style", () => {
  // The whole re-rewrite story rests on this: the admin "重写" action has no
  // stored style to read back, so it recomputes from the note id. If two calls
  // could disagree, a re-rewrite button would sometimes silently keep the
  // original voice.
  for (const id of ["cmrmyf1w7000001oid3vlz1br", "0a1b-4e5f-6789-abcd-ef01", "x", ""]) {
    assert.equal(styleFor(id).key, styleFor(id).key, `unstable for ${id}`);
  }
});

test("styleFor: dispatch covers every style — not a degenerate subset", () => {
  // A hash that only ever landed on one or two indices would still pass a
  // determinism test while making "多种风格的创作" a lie. Sweep a wide id space
  // and assert the whole set is reachable.
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) seen.add(styleFor(`note-${i}`).key);
  assert.deepEqual(
    [...seen].sort(),
    STYLES.map((s) => s.key).sort(),
    `only ${seen.size} of ${STYLES.length} styles were reached`,
  );
});

test("styleFor: also spreads across realistic cuid / uuid shaped ids", () => {
  // Production ids are Prisma cuid() (24 lowercase alnum) and imported-evernote
  // uuids. The distribution must hold for those shapes too, not just for "note-N".
  const seen = new Set<string>();
  for (let i = 0; i < 3000; i++) {
    const hex = i.toString(16).padStart(8, "0");
    seen.add(styleFor(`cm${hex}${hex}abcd`).key);
    seen.add(styleFor(`${hex}-1111-2222-3333-${hex}4444`).key);
  }
  assert.equal(seen.size, STYLES.length, `only ${seen.size}/${STYLES.length} styles reached`);
});

test("styleFor: never indexes outside the set", () => {
  // `h` is a signed 32-bit accumulator and can reach -2147483648, where
  // `Math.abs` overflows rather than negating. `% length` still stays in range,
  // but this is the edge that would index undefined without the guard.
  for (const id of ["", "a", " ", "z".repeat(24), "一".repeat(64)]) {
    const s = styleFor(id);
    assert.ok(STYLES.some((x) => x.key === s.key), `styleFor(${id}) left the set`);
  }
  for (let i = 0; i < 20000; i++) {
    const s = styleFor(i.toString(36));
    assert.ok(STYLES.some((x) => x.key === s.key), `index out of range for ${i}`);
  }
});

test("styleFor: pure — does not disturb the shared STYLES table", () => {
  // `STYLES` is module-level shared state and `styleFor` indexes into it. An
  // edit that sorted or filtered it in place would re-voice every other note.
  const before = STYLES.map((s) => s.key);
  for (let i = 0; i < 200; i++) styleFor(`note-${i}`);
  assert.deepEqual(STYLES.map((s) => s.key), before, "STYLES was mutated");
});

test("styleFor: tolerates non-string input without throwing", () => {
  // The admin rewrite path takes the id off a request body. A throw 500s the button.
  for (const bad of [null, undefined, 42, {}, []] as unknown[]) {
    assert.ok(styleFor(bad as string) !== undefined);
  }
});

test("styleByKey: round-trips every style emitted by styleFor", () => {
  for (let i = 0; i < 500; i++) {
    const s = styleFor(`note-${i}`);
    assert.equal(styleByKey(s.key), s, `styleByKey lost ${s.key}`);
  }
  assert.equal(styleByKey("nope"), null);
  assert.equal(styleByKey(""), null);
  // Absent provenance (rows predating style dispatch) reads as "no voice", same
  // as an unknown key — neither may be rendered as a named style.
  assert.equal(styleByKey(null), null);
  assert.equal(styleByKey(undefined), null);
});

test("styleByKey: accepts every key in the table", () => {
  for (const s of STYLES) {
    assert.equal(styleByKey(s.key), s);
    assert.equal(styleByKey(s.key as StyleKey)?.key, s.key);
  }
});
