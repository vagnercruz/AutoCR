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

        // Extrai tudo o que estiver dentro de colchetes na primeira linha
        const bracketMatches = [...header.matchAll(/\[(.*?)\]/g)];
        let hasValidSizeBracket = false;

        // Padrões de tamanho base permitidos pela documentação
        const validSizeRegex = /^(\d+-bit(?: BE)?(?: BCD)?(?: BE BCD)?|Float(?: BE)?|\d+x\d+ bytes?|\d+ bytes?|Lower4|Upper4|ASCII|General game notes)$/i;
        
        // Padrões de metadados permitidos como tags secundárias independentes
        const validMetadataRegex = /^(JP|EU|EUR|US|USA|EUA|ALL|World|BCD|BE)$/i;

        for (const match of bracketMatches) {
            const innerText = match[1].trim();

            if (innerText.toLowerCase() === "bitflags" || innerText.toLowerCase() === "bit-flags") {
                issues.push({
                    level: "ERROR",
                    rule: "INVALID_BRACKET_BITFLAGS",
                    message: `"Bitflags" shall not be bracketed.`
                });
            } else if (validSizeRegex.test(innerText)) {
                hasValidSizeBracket = true;
            } else if (validMetadataRegex.test(innerText)) {
                // É um metadado válido (região, BCD separado ou BE separado), deixa passar sem erro
            } else {
                issues.push({
                    level: "ERROR",
                    rule: "INVALID_BRACKET_CONTENT",
                    message: `The tag [${innerText}] is invalid. Brackets must ONLY contain size information (e.g. [8-bit], [16-bit BE], [4x4 bytes]) or valid modifiers (like regions, BCD, BE).`
                });
            }
        }

        if (!hasValidSizeBracket) {
            issues.push({
                level: "ERROR",
                rule: "SIZE_FORMAT_ERROR",
                message: "Code notes must have size information."
            });
            return issues; 
        }

        // Remove as tags para avaliar apenas a descrição limpa
        const description = header.replace(/\[.*?\]/g, '').trim();

        if (description.length <= 3 || (/^[\w]+$/.test(description) && description.toLowerCase() === "test")) {
            issues.push({
                level: "WARNING",
                rule: "VAGUE_DESCRIPTION",
                message: `The description "${description}" is too vague. Please clearly document what the address represents.`
            });
        }

        return issues;
    }

    static auditEnumerations(fullNoteText) {
        const issues = [];
        const lines = fullNoteText.split(/\r\n|\n/);
        const isDecimalNoted = fullNoteText.toLowerCase().includes("decimal");

        // Captura o prefixo estrutural, o valor e o separador usado
        const enumLineRegex = /^([.\+\s\|]*)(0x[0-9a-fA-F]+|-?\d+(?:\.\d+)?|Bit\s*\d+)\s*([:=|\-]{1,2})\s*(.+)$/i;

        // Inicia em 1 para ignorar a linha do cabeçalho
        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            const match = line.match(enumLineRegex);
            if (match) {
                const literal = match[2];
                const separator = match[3];

                // Validação do separador obrigatório "="
                if (separator !== "=") {
                    issues.push({
                        level: "ERROR",
                        rule: "INVALID_SEPARATOR",
                        message: `Values must use an '=' sign. Found '${separator}' in "${line}". Do not use colons or dashes.`
                    });
                }

                // Validação rigorosa de bits
                const bitMatch = literal.match(/^Bit\s*(\d+)$/i);
                if (bitMatch) {
                    const bitNum = parseInt(bitMatch[1], 10);
                    if (bitNum > 7) {
                        issues.push({
                            level: "ERROR",
                            rule: "INVALID_BIT_INDEX",
                            message: `Treat consecutive bitfields as stand alone 8-bit addresses. Do not note anything as Bit${bitNum}. Use Bit0 through Bit7.`
                        });
                    }
                } else {
                    // Validação do prefixo Hexadecimal
                    if (!literal.toLowerCase().startsWith('0x') && !literal.includes('.')) {
                        const containsHexChars = /[a-f]/i.test(literal);
                        if (containsHexChars || !isDecimalNoted) {
                            issues.push({
                                level: "WARNING",
                                rule: "HEX_PREFIX_MISSING",
                                message: `The value "${literal}" should be prefixed with '0x' if it is hexadecimal, or the note should specify that values are in decimal.`
                            });
                        }
                    }
                }
            }
        }
        return issues;
    }
}