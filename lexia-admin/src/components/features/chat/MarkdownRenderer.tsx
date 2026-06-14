import React, { useRef, useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, ChevronUp, Printer } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { normalizeTableLikeTextToMarkdown } from './tableUtils';

const TABLE_PREVIEW_ROWS = 8;

const TableWrapper = ({ children, ...props }: any) => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const tableRef = useRef<HTMLTableElement>(null);
    const printTableRef = useRef<HTMLTableElement>(null);
    const [hasOverflow, setHasOverflow] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);

    const childArray = React.Children.toArray(children);
    const validChildren = childArray.filter((child) => React.isValidElement(child));
    const tbodyElement = validChildren.length > 0 ? validChildren[validChildren.length - 1] : null;
    const tbodyIndex = tbodyElement ? childArray.indexOf(tbodyElement) : -1;

    const tbodyRows = tbodyElement ? React.Children.toArray(tbodyElement.props?.children) : [];
    const isLongTable = tbodyRows.length > TABLE_PREVIEW_ROWS;

    const displayChildren = [...childArray];
    if (tbodyElement && isLongTable && !isExpanded) {
        displayChildren[tbodyIndex] = React.cloneElement(tbodyElement, {
            ...tbodyElement.props,
            children: tbodyRows.slice(0, TABLE_PREVIEW_ROWS),
        });
    }

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const check = () => setHasOverflow(el.scrollWidth > el.clientWidth);
        check();
        const ro = new ResizeObserver(check);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const handlePrint = () => {
        const printableTable = printTableRef.current || tableRef.current || scrollRef.current?.querySelector('table');
        if (!printableTable) return;

        const printWindow = window.open('', '_blank', 'width=1200,height=900');
        if (!printWindow) return;

        printWindow.document.write(`
            <!doctype html>
            <html>
            <head>
                <title>Impression du tableau</title>
                <style>
                    body {
                        margin: 24px;
                        font-family: Arial, sans-serif;
                        color: #111827;
                    }
                    table {
                        width: 100%;
                        border-collapse: collapse;
                        font-size: 12px;
                    }
                    th, td {
                        border: 1px solid #d1d5db;
                        padding: 8px 10px;
                        text-align: left;
                        vertical-align: top;
                        word-break: break-word;
                    }
                    th {
                        background: #f3f4f6;
                        font-weight: 700;
                    }
                    @media print {
                        body {
                            margin: 12px;
                        }
                    }
                </style>
            </head>
            <body>
                ${printableTable.outerHTML}
            </body>
            </html>
        `);
        printWindow.document.close();
        printWindow.onload = () => {
            printWindow.focus();
            printWindow.print();
            setTimeout(() => {
                printWindow.close();
            }, 150);
        };
    };

    return (
        <div className="relative my-4 overflow-hidden rounded-2xl border border-border/60 bg-background/70 shadow-sm">
            <div className="flex items-center justify-end gap-2 border-b border-border/50 bg-muted/15 px-3 py-2">
                {isLongTable && (
                    <button
                        type="button"
                        onClick={() => setIsExpanded(prev => !prev)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-background text-foreground transition-colors hover:bg-muted"
                        title={isExpanded ? 'Reduire le tableau' : 'Developper le tableau'}
                        aria-label={isExpanded ? 'Reduire le tableau' : 'Developper le tableau'}
                    >
                        {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                )}
                <button
                    type="button"
                    onClick={handlePrint}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-background text-foreground transition-colors hover:bg-muted"
                    title="Imprimer le tableau"
                    aria-label="Imprimer le tableau"
                >
                    <Printer className="h-4 w-4" />
                </button>
            </div>
            <div ref={scrollRef} className="overflow-x-auto">
                <Table ref={tableRef} className="min-w-[720px]" {...props}>
                    {displayChildren}
                </Table>
            </div>
            <div className="hidden" aria-hidden="true">
                <Table ref={printTableRef} className="min-w-[720px]" {...props}>
                    {childArray}
                </Table>
            </div>
            {hasOverflow && (
                <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background/80 to-transparent" />
            )}
            {isLongTable && (
                <div className="flex items-center justify-between gap-3 border-t border-border/50 bg-muted/20 px-4 py-2 text-xs">
                    <span className="text-muted-foreground">
                        {isExpanded
                            ? `${tbodyRows.length} lignes affichées`
                            : `Aperçu: ${TABLE_PREVIEW_ROWS} lignes sur ${tbodyRows.length}`
                        }
                    </span>
                </div>
            )}
        </div>
    );
};

const markdownComponents: any = {
    p: ({ node, ...props }: any) => <div className="mb-3 last:mb-0 leading-relaxed" {...props} />,
    strong: ({ node, ...props }: any) => <strong className="font-semibold text-foreground" {...props} />,
    h1: ({ node, ...props }: any) => <h1 className="mt-1 mb-4 text-xl font-semibold tracking-tight" {...props} />,
    h2: ({ node, ...props }: any) => <h2 className="mt-5 mb-3 text-lg font-semibold tracking-tight" {...props} />,
    h3: ({ node, ...props }: any) => <h3 className="mt-4 mb-2 text-base font-semibold" {...props} />,
    ul: ({ node, ...props }: any) => <ul className="mb-4 list-disc pl-5 space-y-1" {...props} />,
    ol: ({ node, ...props }: any) => <ol className="mb-4 list-decimal pl-5 space-y-1" {...props} />,
    li: ({ node, ...props }: any) => <li className="marker:opacity-75" {...props} />,
    table: ({ node, ...props }: any) => <TableWrapper {...props} />,
    thead: ({ node, ...props }: any) => <TableHeader className="bg-muted/40" {...props} />,
    tbody: ({ node, ...props }: any) => <TableBody {...props} />,
    tr: ({ node, ...props }: any) => <TableRow {...props} />,
    th: ({ node, ...props }: any) => <TableHead {...props} />,
    td: ({ node, ...props }: any) => {
        const raw = Array.isArray(node?.children)
            ? node.children.map((c: any) => c?.value || '').join('').trim()
            : '';
        const isNumeric = /^-?\d[\d\s.,]*$/.test(raw);
        return (
            <TableCell className={`text-xs ${isNumeric ? 'tabular-nums text-right whitespace-nowrap font-medium' : 'whitespace-nowrap'}`} {...props} />
        );
    },
    blockquote: ({ node, ...props }: any) => (
        <blockquote className="my-4 border-l-2 border-blue-500/40 pl-4 text-muted-foreground" {...props} />
    ),
    pre: ({ node, ...props }: any) => (
        <div className="overflow-x-auto my-4 rounded-2xl border border-border/60 bg-background/80 shadow-sm">
            <pre className="p-4 text-xs leading-relaxed [&>code]:bg-transparent [&>code]:p-0 [&>code]:rounded-none [&>code]:text-xs" {...props} />
        </div>
    ),
    code: ({ node, ...props }: any) => (
        <code className="bg-muted px-1.5 py-0.5 rounded-md font-mono text-[11px]" {...props} />
    )
};

interface MarkdownRendererProps {
    content: string;
}

const MarkdownRenderer: React.FC<MarkdownRendererProps> = ({ content }) => {
    const formatted = normalizeTableLikeTextToMarkdown(content);

    return (
        <div className="min-w-0 max-w-full overflow-hidden break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={markdownComponents}
            >
                {formatted}
            </ReactMarkdown>
        </div>
    );
};

export default React.memo(MarkdownRenderer);
