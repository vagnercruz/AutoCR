import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  AchievementSet,
  CodeNote,
  CodeNoteSet,
  Leaderboard,
  RichPresence,
} from "../js/achievements.js";
import {
  assess_achievement,
  assess_leaderboard,
  assess_rich_presence,
  Feedback,
} from "../js/feedback.js";
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

describe("checks added on top of upstream", () => {
  test.each([
    [111_000_009, "NUM_FORMAT"],
    [111_000_016, "COMMON_ALT"],
    [111_000_027, "USELESS_ALT"],
    [111_000_039, "SOURCE_MOD_MEASURED"],
    [111_000_040, "MISSING_ENUMERATION"],
  ])("%i reports %s", (id, key) => {
    expect(issuesOf(assets.get(id)).has(Feedback[key])).toBe(true);
  });

  // the [PASS] in this fixture is about ResetNextIf; its leading AndNext really is useless
  test("111000032 still reports its useless AndNext", () => {
    expect(issuesOf(assets.get(111_000_032)).has(Feedback.USELESS_ANDNEXT)).toBe(true);
  });
});

const assessRP = (script, noteText) => {
  current.notes = new CodeNoteSet();
  current.notes.add(new CodeNote("0x10", noteText, "dev"));
  return [].concat(...assess_rich_presence(RichPresence.fromText(script)).issues).filter(
    (i) => i.type === Feedback.RP_LOOKUP_NOTE_MISMATCH,
  );
};

describe("rich presence lookups vs. code notes", () => {
  const note = "[8-bit] Character\r\n0x00 = Mario\r\n0x01 = Luigi\r\n0x02 = Peach";

  test("passes when both list the same values", () => {
    const rp = "Lookup:Char\n0=Mario\n1=Luigi\n2=Peach\n\nDisplay:\nPlaying as @Char(0xH0010)";
    expect(assessRP(rp, note)).toEqual([]);
  });

  test("reports values missing on either side", () => {
    const rp = "Lookup:Char\n0=Mario\n1=Luigi\n3=Toad\n\nDisplay:\nPlaying as @Char(0xH0010)";
    const [issue] = assessRP(rp, note);
    expect(issue.target.name).toBe("Char");
  });

  test("a default entry covers undocumented-in-lookup values", () => {
    const rp = "Lookup:Char\n0=Mario\n*=Someone\n\nDisplay:\nPlaying as @Char(0xH0010)";
    expect(assessRP(rp, note)).toEqual([]);
  });

  test("ignores lookups over computed values", () => {
    const rp = "Lookup:Char\n0=Mario\n3=Toad\n\nDisplay:\nPlaying as @Char(0xH0010*2)";
    expect(assessRP(rp, note)).toEqual([]);
  });
});

const LB_STRUCTURE = ["LB_CANCEL_ALWAYS_TRUE", "LB_CANCEL_EQUALS_START", "LB_NO_CANCEL"];
const lbIssues = (mem) => {
  const lb = Leaderboard.fromJSON({
    ID: 1,
    Title: "Fastest Run",
    Description: "Finish quickly",
    Format: "FRAMES",
    LowerIsBetter: true,
    Mem: mem,
  });
  return [...issuesOf(lb)].filter((t) => LB_STRUCTURE.some((k) => Feedback[k] === t));
};

describe("leaderboard structure", () => {
  test.each([
    ["STA:0xH0010=1_d0xH0010=0::CAN:0xH0011=1::SUB:0xH0012=1::VAL:0xH0013", []],
    ["STA:0xH0010=1_d0xH0010=0::CAN:1=1::SUB:0xH0012=1::VAL:0xH0013", ["LB_CANCEL_ALWAYS_TRUE"]],
    ["STA:0xH0010=1_d0xH0010=0::CAN:0xH0010=1_d0xH0010=0::SUB:0xH0012=1::VAL:0xH0013", ["LB_CANCEL_EQUALS_START"]],
    ["STA:0xH0010=1_d0xH0010=0::CAN:0=1::SUB:0xH0012=1::VAL:0xH0013", ["LB_NO_CANCEL"]],
    ["STA:0xH0010=1_d0xH0010=0::CAN:0=1::SUB:1=1::VAL:0xH0013", []],
  ])("%s", (mem, expected) => {
    expect(lbIssues(mem)).toEqual(expected.map((k) => Feedback[k]));
  });
});
