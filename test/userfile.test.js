import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AchievementSet, CodeNoteSet } from "../js/achievements.js";
import { buildUserFile } from "../js/userfile.js";

test("creates a new file when none is loaded", () => {
  expect(buildUserFile({ title: "Test Game", notes: [{ addr: 0x10, note: "[8-bit] HP\n0x00 = Dead" }] })).toBe(
    '1.0.0.0\nTest Game\nN0:0x000010:"[8-bit] HP\\r\\n0x00 = Dead"\n',
  );
});

test("escapes quotes and backslashes", () => {
  expect(buildUserFile({ notes: [{ addr: 1, note: String.raw`say "hi" \o/` }] })).toContain(
    String.raw`N0:0x000001:"say \"hi\" \\o/"`,
  );
});

test("keeps local assets and replaces only the edited notes", () => {
  const existing = [
    "1.3.1.0",
    "Test Game",
    'N0:0x000010:"old note"',
    'N0:0x000020:"untouched note"',
    '100:"0xH0010=1":Title:Desc::::dev:5:::::00000',
  ].join("\r\n");

  const out = buildUserFile({ existing, notes: [{ addr: 0x10, note: "[8-bit] New note" }] });
  expect(out.split("\n")).toEqual([
    "1.3.1.0",
    "Test Game",
    'N0:0x000020:"untouched note"',
    '100:"0xH0010=1":Title:Desc::::dev:5:::::00000',
    'N0:0x000010:"[8-bit] New note"',
    "",
  ]);
});

test("round-trips through the User.txt parser", () => {
  const notes = new CodeNoteSet();
  const existing = readFileSync("test/228-User.txt", "utf8");
  const out = buildUserFile({ existing, notes: [{ addr: 2, note: "[8-bit] Fixed\n0x13 = good" }] });
  const set = new AchievementSet().addLocal(out, notes);

  expect(notes.find((n) => n.addr === 2).note).toBe("[8-bit] Fixed\r\n0x13 = good");
  expect(notes.find((n) => n.addr === 1)).toBeDefined();
  expect(set.getAchievements().length).toBe(
    new AchievementSet().addLocal(existing, new CodeNoteSet()).getAchievements().length,
  );
});
