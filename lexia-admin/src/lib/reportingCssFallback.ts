/**
 * Optional bundled CSS fallbacks for known report templates.
 *
 * The previous raw import of ``qclick-agent/data/reporting/templates/model1/report.css``
 * is intentionally disabled here because that file may not exist in all
 * workspaces, which breaks the frontend build. When the backend returns
 * ``template_assets``, those assets remain the source of truth.
 */
const FALLBACK_CSS_BY_TEMPLATE: Record<string, Record<string, string>> = {};

/**
 * Merge API-shipped ``template_assets`` with bundled fallbacks for known
 * templates.  API entries win when both exist.
 */
export function mergeReportingTemplateAssets(
    templateId: string | undefined | null,
    api: Record<string, string> | undefined | null,
): Record<string, string> {
    const out: Record<string, string> = { ...(api || {}) };
    const tid = templateId?.trim();
    if (!tid) return out;
    const fb = FALLBACK_CSS_BY_TEMPLATE[tid];
    if (!fb) return out;
    for (const [name, text] of Object.entries(fb)) {
        if (!out[name]) out[name] = text;
    }
    return out;
}
