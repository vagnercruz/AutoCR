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

const pointer = (lines) => ["[32-bit] Pointer to player struct", ...lines].join("\n");

describe("pointer notes", () => {
  test("accepts well-formed offsets", () => {
    expect(rules(pointer(["+0x10 | [8-bit] Current HP", "+0x14 | [16-bit] Max HP"]))).toEqual([]);
  });

  test("audits each offset like a header", () => {
    expect(rules(pointer(["+0x10 | Current HP", "+0x14 | [16-bit] Max HP"]))).toEqual([
      "SIZE_FORMAT_ERROR",
    ]);
  });

  test("warns on offsets without 0x", () => {
    expect(rules(pointer(["+10 | [8-bit] Current HP", "+14 | [16-bit] Max HP"]))).toEqual([
      "POINTER_OFFSET_HEX",
      "POINTER_OFFSET_HEX",
    ]);
  });

  test("audits enumerations under an offset", () => {
    const text = pointer(["+0x10 | [8-bit] Character", "  0x00 = Mario", "  0x01: Luigi", "+0x14 | [8-bit] Lives"]);
    expect(rules(text)).toEqual(["INVALID_SEPARATOR"]);
  });

  test("scopes duplicate values to their offset", () => {
    const text = pointer(["+0x10 | [8-bit] Door state", "  0x00 = Off", "  0x01 = On", "+0x14 | [8-bit] Chest state", "  0x00 = Off", "  0x01 = On"]);
    expect(rules(text)).toEqual([]);
  });
});

describe("enumeration values", () => {
  test("warns on duplicate values", () => {
    expect(rules("[8-bit] Character\n0x01 = Mario\n0x01 = Luigi")).toEqual(["DUPLICATE_ENUM_VALUE"]);
    expect(rules("[8-bit] Flags\nBit0 = Sword\nBit 0 = Shield")).toEqual(["DUPLICATE_ENUM_VALUE"]);
  });

  test("rejects nibble values above 0xF", () => {
    expect(rules("[Lower4] Stage\n0x0F = Last")).toEqual([]);
    expect(rules("[Upper4] Stage\n0x10 = Overflow")).toEqual(["NIBBLE_VALUE_OUT_OF_RANGE"]);
  });
});

describe("suggestFix", () => {
  test.each([
    ["Lives [8 bits]\n0x00: none", "[8-bit] Lives 8 bits\n0x00=none"],
    ["[16-bits be] Score", "[16-bit BE] Score"],
    ["[8-bit] Character\n0x01 => Luigi\n1F = Peach", "[8-bit] Character\n0x01=Luigi\n0x1F=Peach"],
    ["[8-bit] [Bitflags] Unlocks\nBit0 = Sword", "[8-bit] Bitflags Unlocks\nBit0 = Sword"],
    ["[8-bit] [JP] Lives", "[8-bit] [JP] Lives"],
    [
      "[32-bit] Pointer to player\n+10 | Current HP\n+0x14 | [16-bits] Max HP",
      "[32-bit] Pointer to player\n+0x10 | [8-bit] Current HP\n+0x14 | [16-bit] Max HP",
    ],
  ])("%p", (input, expected) => {
    expect(Auditor.suggestFix(input)).toBe(expected);
  });
});

describe("formatReport", () => {
  test("renders one section per note", () => {
    const results = Auditor.auditNotes([
      { addr: 0x10, ...note("[8-bit] Character\n0x01: Luigi") },
      { addr: 0x20, ...note("[8-bit] Lives counter") },
    ]);
    expect(results).toHaveLength(1);
    expect(Auditor.formatReport(results, "Test Game")).toBe(
      [
        "## AutoCR code note report: Test Game",
        "",
        "1 code note(s) with issues.",
        "",
        "### `0x00000010` [8-bit] Character",
        "- **Error:** Values must use an '=' sign. Found ':' in \"0x01: Luigi\". Do not use colons or dashes.",
        "",
        "Suggested correction:",
        "```",
        "[8-bit] Character\n0x01=Luigi",
        "```",
        "",
      ].join("\n"),
    );
  });
});
