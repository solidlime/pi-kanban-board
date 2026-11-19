// A session candidate shows its name AND the id's head: two sessions pi named the same way must
// still be tellable apart, and the label is what the picker stores back by.
import test from "node:test";
import assert from "node:assert/strict";
import "./_load.mjs";

const { sessionLabelOf, sessionIdOfInput } = await import("../../web/src/detail.ts");

const TOP = { id: "0c791013-aaaa-4000-8000-000000000000", name: "kanban #10", updatedAt: "2026-11-19T00:00:00.000Z" };
const OTHER = { id: "1db830f0-bbbb-4000-8000-000000000000", name: "kanban #20", updatedAt: "2026-11-18T00:00:00.000Z" };
const DOLL = { id: "01a1e97e-7761-743b-8ad4-597e69ffc064", name: "レビュー", updatedAt: "2026-11-17T00:00:00.000Z" };
const LIST = [TOP, OTHER];
const card = (sessionId) => ({ id: 1, sessionId });

test("sessionLabelOf puts the id's 8-char head next to the name", () => {
  assert.equal(sessionLabelOf(DOLL), "レビュー（id:01a1e97e）");
});

test("sessionIdOfInput reads the label the picker printed", () => {
  assert.equal(sessionIdOfInput("kanban #20（id:1db830f0）", card(TOP.id), LIST, () => {}), OTHER.id);
});

test("sessionIdOfInput still takes a bare name, as typed before labels carried the id", () => {
  assert.equal(sessionIdOfInput("kanban #10", card(null), LIST, () => {}), TOP.id);
});

test("sessionIdOfInput keeps the id of a card whose session is not in the list", () => {
  // A card that points at a doll, or at a session past the scan window, shows its bare prefix.
  const why = [];
  assert.equal(sessionIdOfInput("01a1e97e", card(DOLL.id), LIST, () => why.push("unknown")), DOLL.id);
  assert.deepEqual(why, [], "not a new session: the card already names one");
});

test("sessionIdOfInput treats an unknown name as a new session and says so", () => {
  let told = 0;
  assert.equal(sessionIdOfInput("まだ無い名前", card(TOP.id), LIST, () => told++), null);
  assert.equal(told, 1, "the user is told the id is not minted yet");
});

test("an empty field clears the session without a warning", () => {
  let told = 0;
  assert.equal(sessionIdOfInput("  ", card(TOP.id), LIST, () => told++), null);
  assert.equal(told, 0);
});
