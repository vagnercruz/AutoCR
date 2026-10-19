// Formats a whole-set review as Markdown, ready to paste in a review thread or Discord.

const SEVERITY_ICON = { 1: "ℹ️", 2: "⚠️", 3: "❌", 4: "❌" };

/**
 * @param {string} title
 * @param {Array<{heading: string, items: Array<{severity: number, text: string}>, comment?: string}>} sections
 */
export function buildSetReport(title, sections) {
  const withIssues = sections
    .map(({ heading, items, comment = "" }) => ({
      heading,
      items: items.filter((i) => i.severity > 0),
      comment: comment.trim(),
    }))
    .filter(({ items, comment }) => items.length > 0 || comment);

  const counts = { error: 0, warning: 0, info: 0 };
  for (const { items } of withIssues) {
    for (const { severity } of items) {
      counts[severity >= 3 ? "error" : severity === 2 ? "warning" : "info"]++;
    }
  }

  const out = [`# AutoCR review: ${title || "Untitled"}`, ""];
  if (withIssues.length === 0) {
    out.push("No issues found.");
    return out.join("\n") + "\n";
  }
  out.push(
    `${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info across ${withIssues.length} section(s).`,
  );

  for (const { heading, items, comment } of withIssues) {
    out.push("", `## ${heading}`);
    if (comment) {
      out.push(...comment.split(/\r?\n/).map((line) => `> 💬 ${line}`));
    }

    // collapse repeated findings (e.g. the same check firing on several conditions)
    const seen = new Map();
    for (const item of [...items].sort((a, b) => b.severity - a.severity)) {
      const key = `${item.severity}|${item.text}`;
      seen.set(key, { ...item, count: (seen.get(key)?.count ?? 0) + 1 });
    }
    for (const { severity, text, count } of seen.values()) {
      out.push(`- ${SEVERITY_ICON[severity]} ${text}${count > 1 ? ` (x${count})` : ""}`);
    }
  }
  return out.join("\n") + "\n";
}
