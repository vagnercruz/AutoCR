const SIZE_TAG_RE =
  /^(\d+-bit(?: BE)?(?: BCD)?|Float(?: BE)?|\d+x\d+ bytes?|\d+ bytes?|Lower4|Upper4|ASCII|General game notes)$/i;
const MODIFIER_TAG_RE = /^(JP|EU|EUR|US|USA|EUA|ALL|World|BCD|BE)$/i;
const NIBBLE_TAG_RE = /\[(Lower4|Upper4)\]/i;

// prefix, value literal, separator, meaning
// hex literals without 0x are only recognized when they contain a hex letter (e.g. 1F, FF)
const ENUM_LINE_RE =
  /^([.+\s|]*)(Bit\s*\d+|0x[0-9a-f]+|(?=[0-9a-f]*[a-f])[0-9a-f]{2,}\b|-?\d+(?:\.\d+)?)\s*([:=|>-]{1,2})\s*(.+)$/i;
// prefix, offset, description (e.g. "+0x10 | [8-bit] HP")
const OFFSET_LINE_RE = /^([.\s]*)\+\s*((?:0x)?[0-9a-f]+)\b\s*[|:=-]?\s*(.*)$/i;

const splitLines = (text) => text.split(/\r\n|\n/);
const toHex = (addr) => "0x" + addr.toString(16).padStart(8, "0");

function parseLiteral(literal) {
  const bit = literal.match(/^Bit\s*(\d+)$/i);
  if (bit) {
    return `bit${Number.parseInt(bit[1], 10)}`;
  }
  if (/^0x/i.test(literal) || /[a-f]/i.test(literal)) {
    return Number.parseInt(literal.replace(/^0x/i, ""), 16);
  }
  return literal.includes(".") ? Number.parseFloat(literal) : Number.parseInt(literal, 10);
}

export class Auditor {
  /**
   * Analyzes a CodeNote instance and returns a list of QA issues.
   * @param {CodeNote} codeNote
   * @returns {Array} List of found errors and warnings
   */
  static auditCodeNote(codeNote) {
    const issues = [];

    issues.push(...this.auditHeader(codeNote.getHeader()));

    if (codeNote.note) {
      issues.push(...this.auditEnumerations(codeNote.note));
    }

    return issues;
  }

  /**
   * Audits every note and returns the ones with issues, along with a suggested correction.
   * @returns {Array<{note, addr: number, issues: Array, fix: string}>}
   */
  static auditNotes(notes) {
    const results = [];
    for (const note of notes) {
      const issues = this.auditCodeNote(note);
      if (issues.length > 0) {
        results.push({ note, addr: note.addr, issues, fix: this.suggestFix(note.note) });
      }
    }
    return results;
  }

  static isPointerNote(text) {
    const lines = splitLines(text);
    if (/ptr|pointer/i.test(lines[0])) {
      return true;
    }
    return lines.filter((line, i) => i > 0 && /^[.\s]*\+/.test(line)).length >= 2;
  }

  static auditHeader(headerText) {
    const issues = [];
    const header = headerText.trim();

    const bracketMatches = [...header.matchAll(/\[(.*?)\]/g)];
    let hasValidSizeBracket = false;

    for (const match of bracketMatches) {
      const innerText = match[1].trim();

      if (innerText.toLowerCase() === "bitflags" || innerText.toLowerCase() === "bit-flags") {
        issues.push({
          level: "ERROR",
          rule: "INVALID_BRACKET_BITFLAGS",
          message: `"Bitflags" shall not be bracketed.`,
        });
      } else if (SIZE_TAG_RE.test(innerText)) {
        hasValidSizeBracket = true;
      } else if (!MODIFIER_TAG_RE.test(innerText)) {
        issues.push({
          level: "ERROR",
          rule: "INVALID_BRACKET_CONTENT",
          message: `The tag [${innerText}] is invalid. Brackets must ONLY contain size information (e.g. [8-bit], [16-bit BE], [4x4 bytes]) or valid modifiers (like regions, BCD, BE).`,
        });
      }
    }

    if (!hasValidSizeBracket) {
      issues.push({
        level: "ERROR",
        rule: "SIZE_FORMAT_ERROR",
        message: "Code notes must have size information.",
      });
      return issues;
    }

    const description = header.replaceAll(/\[.*?\]/g, "").trim();

    if (description.length <= 3 || description.toLowerCase() === "test") {
      issues.push({
        level: "WARNING",
        rule: "VAGUE_DESCRIPTION",
        message: `The description "${description}" is too vague. Please clearly document what the address represents.`,
      });
    }

    return issues;
  }

  static auditEnumerations(fullNoteText) {
    const issues = [];
    const lines = splitLines(fullNoteText);
    const isDecimalNoted = fullNoteText.toLowerCase().includes("decimal");
    const isPointer = this.isPointerNote(fullNoteText);

    // values are scoped to the address (or pointer offset) they describe
    let seen = new Map();
    let isNibble = NIBBLE_TAG_RE.test(lines[0]);

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }

      const offsetMatch = isPointer && lines[i].match(OFFSET_LINE_RE);
      if (offsetMatch) {
        const [, , offset, description] = offsetMatch;
        if (!/^0x/i.test(offset)) {
          issues.push({
            level: "WARNING",
            rule: "POINTER_OFFSET_HEX",
            message: `The pointer offset "+${offset}" should be written in hex with a '0x' prefix.`,
          });
        }
        for (const issue of this.auditHeader(description)) {
          issues.push({ ...issue, message: `Offset +${offset}: ${issue.message}` });
        }
        seen = new Map();
        isNibble = NIBBLE_TAG_RE.test(description);
        continue;
      }

      const match = line.match(ENUM_LINE_RE);
      if (!match) {
        continue;
      }
      const [, , literal, separator, meaning] = match;

      if (separator !== "=") {
        issues.push({
          level: "ERROR",
          rule: "INVALID_SEPARATOR",
          message: `Values must use an '=' sign. Found '${separator}' in "${line}". Do not use colons or dashes.`,
        });
      }

      const bitMatch = literal.match(/^Bit\s*(\d+)$/i);
      if (bitMatch) {
        const bitNum = Number.parseInt(bitMatch[1], 10);
        if (bitNum > 7) {
          issues.push({
            level: "ERROR",
            rule: "INVALID_BIT_INDEX",
            message: `Treat consecutive bitfields as stand alone 8-bit addresses. Do not note anything as Bit${bitNum}. Use Bit0 through Bit7.`,
          });
        }
      } else if (!literal.toLowerCase().startsWith("0x") && !literal.includes(".")) {
        const containsHexChars = /[a-f]/i.test(literal);
        if (containsHexChars || !isDecimalNoted) {
          issues.push({
            level: "WARNING",
            rule: "HEX_PREFIX_MISSING",
            message: `The value "${literal}" should be prefixed with '0x' if it is hexadecimal, or the note should specify that values are in decimal.`,
          });
        }
      }

      const value = parseLiteral(literal);
      if (seen.has(value)) {
        issues.push({
          level: "WARNING",
          rule: "DUPLICATE_ENUM_VALUE",
          message: `The value "${literal}" is listed more than once ("${seen.get(value)}" and "${meaning.trim()}").`,
        });
      } else {
        seen.set(value, meaning.trim());
      }

      if (isNibble && typeof value === "number" && value > 0xf) {
        issues.push({
          level: "ERROR",
          rule: "NIBBLE_VALUE_OUT_OF_RANGE",
          message: `The value "${literal}" does not fit in a nibble. [Lower4] and [Upper4] values must be between 0x0 and 0xF.`,
        });
      }
    }
    return issues;
  }

  static suggestHeader(header) {
    let foundSize = null;

    header = header.replaceAll(/\[(.*?)\]/g, (match, innerText) => {
      // accepts plural 'Bits' and normalizes to the official singular
      const bitMatch = innerText.match(/^(\d+-bit)(?:s)?((?: BE)?(?: BCD)?)$/i);
      if (bitMatch) {
        foundSize = `[${bitMatch[1].toLowerCase()}${bitMatch[2].toUpperCase()}]`;
        return "";
      }
      if (SIZE_TAG_RE.test(innerText)) {
        foundSize = `[${innerText}]`;
        return "";
      }
      if (MODIFIER_TAG_RE.test(innerText)) {
        return match;
      }
      // incorrectly bracketed descriptions (like Bitflags) lose their brackets
      return innerText;
    });

    header = header.replaceAll(/(^[-:\s]+|[-:\s]+$)/g, "").trim();
    return `${foundSize ?? "[8-bit]"} ${header}`.trim().replaceAll(/\s{2,}/g, " ");
  }

  static suggestFix(noteText) {
    const lines = splitLines(noteText);
    const isPointer = this.isPointerNote(noteText);
    lines[0] = this.suggestHeader(lines[0]);

    for (let i = 1; i < lines.length; i++) {
      const offsetMatch = isPointer && lines[i].match(OFFSET_LINE_RE);
      if (offsetMatch) {
        const [, prefix, offset, description] = offsetMatch;
        const hexOffset = /^0x/i.test(offset) ? offset : `0x${offset}`;
        lines[i] = `${prefix}+${hexOffset} | ${this.suggestHeader(description)}`;
        continue;
      }

      const match = lines[i].match(ENUM_LINE_RE);
      if (match) {
        const [, prefix, literal, separator, meaning] = match;
        const isBareHex = /[a-f]/i.test(literal) && !/^0x|^bit/i.test(literal);
        if (separator !== "=" || isBareHex) {
          lines[i] = `${prefix}${isBareHex ? "0x" + literal : literal}=${meaning}`;
        }
      }
      lines[i] = lines[i].replaceAll(/\[(.*?)\]/g, "$1");
    }
    return lines.join("\n");
  }

  /**
   * Formats audit results as Markdown, ready to paste in a review thread or Discord.
   */
  static formatReport(results, title = "") {
    const out = [`## AutoCR code note report${title ? `: ${title}` : ""}`, ""];
    out.push(`${results.length} code note(s) with issues.`, "");

    for (const { addr, note, issues, fix } of results) {
      out.push(`### \`${toHex(addr)}\` ${splitLines(note.note)[0].trim()}`);
      for (const issue of issues) {
        out.push(`- **${issue.level === "ERROR" ? "Error" : "Warning"}:** ${issue.message}`);
      }
      out.push("", "Suggested correction:", "```", fix, "```", "");
    }
    return out.join("\n").trimEnd() + "\n";
  }
}
