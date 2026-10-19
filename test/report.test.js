import { expect, test } from "bun:test";

import { buildSetReport } from "../js/report.js";

test("lists sections with issues, worst first, and collapses repeats", () => {
  const report = buildSetReport("Test Game", [
    { heading: "🗺️ Set", items: [] },
    {
      heading: "🏆 Beat the Boss (10)",
      items: [
        { severity: 1, text: "Titles should be in title case." },
        { severity: 3, text: "Missing delta." },
        { severity: 3, text: "Missing delta." },
      ],
    },
    { heading: "🏆 Clean (5)", items: [{ severity: 0, text: "passed" }] },
    { heading: "📝 Code Notes", items: [{ severity: 2, text: "`0x00000010`: duplicate value" }] },
  ]);

  expect(report).toBe(
    [
      "# AutoCR review: Test Game",
      "",
      "2 error(s), 1 warning(s), 1 info across 2 section(s).",
      "",
      "## 🏆 Beat the Boss (10)",
      "- ❌ Missing delta. (x2)",
      "- ℹ️ Titles should be in title case.",
      "",
      "## 📝 Code Notes",
      "- ⚠️ `0x00000010`: duplicate value",
      "",
    ].join("\n"),
  );
});

test("says so when there is nothing to report", () => {
  expect(buildSetReport("Clean Game", [{ heading: "🗺️ Set", items: [] }])).toBe(
    "# AutoCR review: Clean Game\n\nNo issues found.\n",
  );
});

test("includes reviewer comments, even on sections without issues", () => {
  const report = buildSetReport("Test Game", [
    { heading: "🏆 Clean (5)", items: [], comment: "Looks good.\nMaybe raise points?" },
    { heading: "🏆 Skipped (5)", items: [], comment: "   " },
  ]);
  expect(report).toContain("## 🏆 Clean (5)\n> 💬 Looks good.\n> 💬 Maybe raise points?");
  expect(report).not.toContain("Skipped");
});
