import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { AchievementSet, CodeNote, CodeNoteSet } from "../js/achievements.js";
import { assess_achievement, assess_leaderboard, Feedback } from "../js/feedback.js";
import { current } from "../js/state.js";

// test/228-User.txt is a set of local achievements whose titles describe the issue they exercise
const issuesOf = (asset) => {
  const assessment = asset.logic ? assess_achievement(asset) : assess_leaderboard(asset);
  return new Set([].concat(...assessment.issues).map((issue) => issue.type));
};

let assets;
beforeAll(() => {
  current.notes = new CodeNoteSet();
  for (const obj of JSON.parse(readFileSync("test/228-Notes.json", "utf8"))) {
    if (obj.Note) {
      current.notes.add(new CodeNote(obj.Address, obj.Note, obj.User));
    }
  }
  current.set = new AchievementSet().addLocal(
    readFileSync("test/228-User.txt", "utf8"),
    current.notes,
  );
  current.notes.sort((a, b) => a.addr - b.addr);
  assets = new Map(
    [...current.set.getAchievements(), ...current.set.getLeaderboards()].map((a) => [a.id, a]),
  );
});

describe("detects the issue each fixture exercises", () => {
  test.each([
    [111_000_002, "NO_EMOJI"],
    [111_000_003, "NO_EMOJI"],
    [111_000_004, "FOREIGN_CHARS"],
    [111_000_005, "FOREIGN_CHARS"],
    [111_000_006, "SPECIAL_CHARS"],
    [111_000_007, "SPECIAL_CHARS"],
    [111_000_008, "SPECIAL_CHARS"],
    [111_000_010, "MISSING_NOTE"],
    [111_000_011, "BAD_CHAIN"],
    [111_000_012, "ONE_CONDITION"],
    [111_000_013, "ONE_CONDITION"],
    [111_000_014, "BAD_PRIOR"],
    [111_000_015, "BAD_PRIOR"],
    [111_000_017, "STALE_ADDADDRESS"],
    [111_000_018, "PAUSELOCK_NO_RESET"],
    [111_000_021, "HIT_NO_RESET"],
    [111_000_022, "USELESS_ANDNEXT"],
    [111_000_023, "UUO_RESET"],
    [111_000_028, "UUO_RNI"],
    [111_000_029, "UUO_RNI"],
    [111_000_030, "UUO_RNI"],
    [111_000_034, "UUO_PAUSE"],
    [111_000_037, "RESET_HITCOUNT_1"],
    [111_000_038, "TYPE_MISMATCH"],
  ])("%i reports %s", (id, key) => {
    expect(Feedback[key]).toBeDefined();
    expect(issuesOf(assets.get(id)).has(Feedback[key])).toBe(true);
  });
});

describe("does not flag the [PASS] fixtures", () => {
  test.each([
    [111_000_019, "PAUSELOCK_NO_RESET"],
    [111_000_020, "PAUSELOCK_NO_RESET"],
    [111_000_024, "UUO_RESET"],
    [111_000_025, "UUO_RESET"],
    [111_000_026, "UUO_RESET"],
    [111_000_031, "UUO_RNI"],
    [111_000_032, "UUO_RNI"],
    [111_000_035, "UUO_PAUSE"],
    [111_000_036, "UUO_PAUSE"],
  ])("%i does not report %s", (id, key) => {
    expect(issuesOf(assets.get(id)).has(Feedback[key])).toBe(false);
  });
});

// fixtures whose issue the checks do not detect yet
test.todo("111000009 reports NUM_FORMAT (Wrong Number Format)");
test.todo("111000016 reports COMMON_ALT (Shared Logic in Alt Groups)");
test.todo("111000027 reports USELESS_ALT (Useless Alt)");
test.todo("111000039 reports SOURCE_MOD_MEASURED (Source Modification on Measured)");
test.todo("111000040 reports MISSING_ENUMERATION (Missing Enumerations)");
test.todo("111000032 does not report USELESS_ANDNEXT (Pause Until)");
