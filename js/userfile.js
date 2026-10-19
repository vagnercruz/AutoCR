// Builds RAIntegration local files ([gameid]-User.txt) for importing changes back into the toolkit.

const NOTE_LINE_RE = /^N\d*:(0x[0-9a-f]+):/i;

const formatAddr = (addr) => "0x" + addr.toString(16).padStart(6, "0");

// RAIntegration stores note text as a quoted string with escaped CRLF line breaks
const formatNoteLine = (addr, text) =>
  `N0:${formatAddr(addr)}:${JSON.stringify(text.replaceAll(/\r?\n/g, "\r\n"))}`;

/**
 * Writes code notes into a User.txt, keeping everything else an existing file already has
 * (local achievements, leaderboards, other notes).
 * @param {{existing?: string, title?: string, notes: Array<{addr: number, note: string}>}} options
 */
export function buildUserFile({ existing = null, title = "", notes }) {
  const replaced = new Set(notes.map((n) => n.addr));
  const lines = existing ? existing.split(/\r?\n/).filter((line) => line !== "") : [];

  const header = lines.length >= 2 ? lines.slice(0, 2) : ["1.0.0.0", title ?? ""];
  const body = lines.slice(2).filter((line) => {
    const m = line.match(NOTE_LINE_RE);
    return !m || !replaced.has(Number.parseInt(m[1], 16));
  });

  return (
    [...header, ...body, ...notes.map((n) => formatNoteLine(n.addr, n.note))].join("\n") + "\n"
  );
}
