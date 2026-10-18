export class Auditor {
  /**
   * Analyzes a CodeNote instance and returns a list of QA issues.
   * @param {CodeNote} codeNote
   * @returns {Array} List of found errors and warnings
   */
  static auditCodeNote(codeNote) {
    const issues = [];

    // 1. Audit Header (Format and Bracket Content)
    const headerIssues = this.auditHeader(codeNote.getHeader());
    issues.push(...headerIssues);

    // 2. Audit Enumerations (Separators, Hex, and Bits)
    if (codeNote.note) {
      const enumIssues = this.auditEnumerations(codeNote.note);
      issues.push(...enumIssues);
    }

    return issues;
  }

  static auditHeader(headerText) {
    const issues = [];
    const header = headerText.trim();

    const bracketMatches = [...header.matchAll(/\[(.*?)\]/g)];
    let hasValidSizeBracket = false;

    const validSizeRegex =
      /^(\d+-bit(?: BE)?(?: BCD)?|Float(?: BE)?|\d+x\d+ bytes?|\d+ bytes?|Lower4|Upper4|ASCII|General game notes)$/i;

    const validMetadataRegex = /^(JP|EU|EUR|US|USA|EUA|ALL|World|BCD|BE)$/i;

    for (const match of bracketMatches) {
      const innerText = match[1].trim();

      if (innerText.toLowerCase() === "bitflags" || innerText.toLowerCase() === "bit-flags") {
        issues.push({
          level: "ERROR",
          rule: "INVALID_BRACKET_BITFLAGS",
          message: `"Bitflags" shall not be bracketed.`,
        });
      } else if (validSizeRegex.test(innerText)) {
        hasValidSizeBracket = true;
      } else if (validMetadataRegex.test(innerText)) {
        // valid modifier (region, standalone BCD or BE)
      } else {
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

    // Strip the tags so only the description is evaluated
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
    const lines = fullNoteText.split(/\r\n|\n/);
    const isDecimalNoted = fullNoteText.toLowerCase().includes("decimal");


    const enumLineRegex =
      /^([.+\s|]*)(Bit\s*\d+|0x[0-9a-f]+|(?=[0-9a-f]*[a-f])[0-9a-f]{2,}\b|-?\d+(?:\.\d+)?)\s*([:=|>-]{1,2})\s*(.+)$/i;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) {
        continue;
      }

      const match = line.match(enumLineRegex);
      if (match) {
        const literal = match[2];
        const separator = match[3];

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
      }
    }
    return issues;
  }
}
