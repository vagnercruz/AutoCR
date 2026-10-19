import { describe, expect, test } from "bun:test";

import { AchievementSet, AssetState, CodeNote, CodeNoteSet } from "../js/achievements.js";

const published = {
  ID: 1,
  Title: "Test Game",
  ConsoleId: 3,
  Achievements: [
    {
      ID: 100,
      Title: "Beat the Boss",
      Description: "Defeat the final boss",
      Points: 10,
      Author: "dev",
      Type: "win_condition",
      BadgeURL: "https://media.retroachievements.org/Badge/12345.png",
      Flags: 3,
      MemAddr: "0xH0010=1_d0xH0010=0",
    },
    {
      ID: 101,
      Title: "Untouched",
      Description: "Not edited locally",
      Points: 5,
      Author: "dev",
      Type: "",
      BadgeURL: "https://media.retroachievements.org/Badge/12346.png",
      Flags: 3,
      MemAddr: "0xH0020=1_d0xH0020=0",
    },
  ],
  Leaderboards: [
    {
      ID: 200,
      Title: "Fastest Run",
      Description: "Finish quickly",
      Format: "FRAMES",
      LowerIsBetter: true,
      Mem: "STA:0xH0010=1::CAN:0xH0011=1::SUB:0xH0012=1::VAL:0xH0013",
    },
  ],
};

const local = [
  "1.3.1.0",
  "Test Game",
  '100:"0xH0010=2_d0xH0010=0":Beat the Final Boss:Defeat the final boss:::win_condition:dev:25:::::12345',
  'L200:"0xH0010=1":"0xH0011=1":"0xH0012=1":"0xH0014":FRAMES:Fastest Run:Finish quickly:1',
  '300:"0xH0030=1_d0xH0030=0":Brand New:Only exists locally::::dev:5:::::00000',
].join("\n");

const changedFields = (asset) => asset.changes().map((c) => c.field);

describe.each([
  ["published first", (set) => set.addJSON(published).addLocal(local, new CodeNoteSet())],
  ["local first", (set) => set.addLocal(local, new CodeNoteSet()).addJSON(published)],
])("local vs. published (%s)", (_, load) => {
  const set = load(new AchievementSet());

  test("keeps the local edit and remembers the published version", () => {
    const ach = set.achievements.get(100);
    expect(ach.state).toBe(AssetState.LOCAL);
    expect(ach.published.state).toBe(AssetState.CORE);
  });

  test("lists the changed achievement fields", () => {
    expect(changedFields(set.achievements.get(100))).toEqual(["Title", "Points", "Logic"]);
    expect(set.achievements.get(100).changes()[1]).toEqual({
      field: "Points",
      before: 10,
      after: 25,
    });
  });

  test("lists the changed leaderboard components", () => {
    expect(changedFields(set.leaderboards.get(200))).toEqual(["VAL"]);
  });

  test("does not report untouched or local-only assets", () => {
    expect(set.achievements.get(101).changes()).toEqual([]);
    expect(set.achievements.get(300).published).toBeNull();
    expect(set.getModifiedAssets().map((a) => a.id)).toEqual([100, 200]);
  });
});

test("an achievement voided locally moves to the archived list", () => {
  const voided = local.replace("Beat the Final Boss", "[VOID] Beat the Boss");
  const set = new AchievementSet().addJSON(published).addLocal(voided, new CodeNoteSet());
  expect(set.achievements.has(100)).toBe(false);
  expect(changedFields(set.archivedAchievements.get(100))).toEqual(["Title", "Points", "Logic"]);
});

describe("CodeNote enumerations", () => {
  test.each([
    ["LF", "[8-bit] Character\n0x00 = Mario\n0x01 = Luigi"],
    ["CRLF", "[8-bit] Character\r\n0x00 = Mario\r\n0x01 = Luigi"],
    ["dash bullets", "Character [8bit]\r\n--- 00 | Mario\r\n--- 01 | Luigi"],
  ])("parses %s notes", (_, text) => {
    expect(CodeNote.parseEnumerations(text)?.map((e) => e.meaning)).toEqual(["Mario", "Luigi"]);
  });

  test("keeps negative values negative", () => {
    expect(CodeNote.parseEnumerations("[8-bit] Delta\n-1 = Left\n1 = Right").map((e) => e.value)).toEqual([
      -1, 1,
    ]);
  });
});
