export const looksLikeTabularBlock = (lines: string[]): boolean => {
    if (!Array.isArray(lines) || lines.length < 2) return false;
    const nonEmpty = lines.map(l => l.trim()).filter(Boolean);
    if (nonEmpty.length < 2) return false;

    if (nonEmpty.some(line => line.includes('|'))) return false;

    const tabRows = nonEmpty.filter(line => line.includes('\t'));
    if (tabRows.length >= 2) return true;

    const firstRows = nonEmpty.slice(0, 4);
    const spacedRows = firstRows.filter(line => (line.match(/\s{2,}/g) || []).length >= 2);
    return spacedRows.length >= 3;
};

export const splitColumns = (line: string): string[] => {
    if (line.includes('\t')) {
        return line.split('\t').map(c => c.trim());
    }
    return line.trim().split(/\s{2,}/).map(c => c.trim());
};

export const isHeaderLikeRow = (cells: string[]): boolean => {
    if (!cells || cells.length < 2) return false;
    const joined = cells.join(' ').trim();
    if (!joined) return false;

    const textishCount = cells.filter((cell) => /[A-Za-zÀ-ÿ]/.test(cell)).length;
    const numericishCount = cells.filter((cell) => /^-?\d[\d\s.,/-]*$/.test(cell)).length;
    return textishCount >= Math.max(1, Math.ceil(cells.length / 2)) && numericishCount < cells.length;
};

export const normalizeTableLikeTextToMarkdown = (content: string): string => {
    if (!content || typeof content !== 'string') return content;
    const blocks = content.split(/\n\n+/);

    return blocks.map((block) => {
        const lines = block.split('\n').filter(l => l.trim() !== '');
        if (!looksLikeTabularBlock(lines)) return block;

        const rows = lines.map(splitColumns).filter(r => r.length >= 2);
        if (rows.length < 2) return block;

        const colCount = Math.max(...rows.map(r => r.length));
        if (colCount < 2) return block;

        const normalizedRows = rows.map(r => {
            const next = [...r];
            while (next.length < colCount) next.push('');
            return next;
        });

        const [header, ...body] = normalizedRows;
        if (!header || header.every(c => !c)) return block;
        if (!isHeaderLikeRow(header)) return block;

        const hasBody = body.length > 0;
        if (!hasBody) return block;

        const denseBodyRows = body.filter(r => r.filter(Boolean).length >= Math.max(2, Math.floor(header.filter(Boolean).length * 0.6)));
        if (denseBodyRows.length === 0) return block;

        const md = [
            `| ${header.join(' | ')} |`,
            `| ${header.map(() => '---').join(' | ')} |`,
            ...body.map(r => `| ${r.join(' | ')} |`)
        ].join('\n');
        return md;
    }).join('\n\n');
};
