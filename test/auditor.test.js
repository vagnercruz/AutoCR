import { describe, expect, test } from "bun:test";

import { Auditor } from "../js/auditor.js";

const note = (text) => ({ note: text, getHeader: () => text.split("\n")[0] });
const rules = (text) => Auditor.auditCodeNote(note(text)).map((issue) => issue.rule);

describe("auditHeader", () => {
  test.each([
    "[8-bit] Player lives",
    "[16-bit BE] Score",
    "[32-bit BE BCD] Timer",
    "[16-bit BCD] Timer",
    "[Float] Speed",
    "[Float BE] Speed",
    "[4x4 bytes] Inventory",
    "[20 bytes] Player name",
    "[Lower4] Stage",
    "[Upper4] World",
    "[ASCII] Player name",
    "[8-bit] [JP] Player lives",
    "[16-bit] [BE] [BCD] Score",
  ])("accepts %p", (header) => {
    expect(rules(header)).toEqual([]);
  });

  test.each(["Player lives", "[Pointer] Player struct"])("requires a size tag in %p", (header) => {
    expect(rules(header)).toContain("SIZE_FORMAT_ERROR");
  });

  test("rejects unknown tags", () => {
    expect(rules("[8-bit] [Pointer] Player struct")).toEqual(["INVALID_BRACKET_CONTENT"]);
  });

  test("rejects repeated modifiers inside a size tag", () => {
    expect(rules("[16-bit BE BCD BE BCD] Score")).toContain("INVALID_BRACKET_CONTENT");
  });

  test.each(["[Bitflags]", "[bit-flags]"])("rejects bracketed %p", (tag) => {
    expect(rules(`[8-bit] ${tag} Unlocks`)).toContain("INVALID_BRACKET_BITFLAGS");
  });

  test.each(["[8-bit] HP", "[8-bit] test", "[8-bit] TEST"])("warns on vague %p", (header) => {
    expect(rules(header)).toEqual(["VAGUE_DESCRIPTION"]);
  });
});

describe("auditEnumerations", () => {
  test("accepts a well-formed enumeration", () => {
    expect(rules("[8-bit] Character\n0x00 = Mario\n0x01 = Luigi\n0x1F = Peach")).toEqual([]);
  });

  test.each([":", "-", "=>", "->", "|"])("rejects the %p separator", (sep) => {
    expect(rules(`[8-bit] Character\n0x00 ${sep} Mario`)).toContain("INVALID_SEPARATOR");
  });

  test("accepts Bit0 through Bit7", () => {
    expect(rules("[8-bit] Unlocks\nBit0 = Sword\nBit7 = Shield")).toEqual([]);
  });

  test("rejects bit indexes above 7", () => {
    expect(rules("[16-bit] Unlocks\nBit8 = Bow")).toEqual(["INVALID_BIT_INDEX"]);
  });

  test("warns on unprefixed decimal values unless the note says decimal", () => {
    expect(rules("[8-bit] Stage\n1 = Forest")).toEqual(["HEX_PREFIX_MISSING"]);
    expect(rules("[8-bit] Stage (decimal)\n1 = Forest\n10 = Castle")).toEqual([]);
  });

  test("warns on unprefixed hex values even when the note says decimal", () => {
    expect(rules("[8-bit] Stage\n1F = Castle")).toEqual(["HEX_PREFIX_MISSING"]);
    expect(rules("[8-bit] Stage (decimal)\nFF = Credits")).toEqual(["HEX_PREFIX_MISSING"]);
  });

  test("does not treat words as hex values", () => {
    expect(rules("[8-bit] Stage\nBad things happen here")).toEqual([]);
  });

  test("accepts nested enumeration prefixes", () => {
    expect(rules("[8-bit] Mode\n| 0x00 = Title\n+ 0x01 = Game")).toEqual([]);
  });
});
