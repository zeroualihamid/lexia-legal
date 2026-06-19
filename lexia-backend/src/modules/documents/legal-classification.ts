/**
 * Hierarchical legal document taxonomy (authority vs practice).
 * Used by /search filters and file metadata — no DB migration; maps
 * `collection` + `document_type` (+ optional title hints) to families/classes.
 *
 * Keep family/class ids in sync with
 * `lexia-frontend/src/shared/legalClassification.ts`.
 */

export const LEGAL_FAMILIES = [
  'normative_legislative',
  'jurisprudence',
  'practice_contracts',
  'procedural',
  'doctrinal',
] as const;

export type LegalFamily = (typeof LEGAL_FAMILIES)[number];

export const LEGAL_CLASSES = [
  'bulletin_official',
  'fundamental_laws',
  'legal_codes',
  'first_instance_judgment',
  'appeal_judgment',
  'cassation_judgment',
  'interim_order',
  'private_contract',
  'authentic_act',
  'company_statutes',
  'introductory_petition',
  'conclusions',
  'summons',
  'formal_notice',
  'case_note',
  'legal_opinion',
] as const;

export type LegalClass = (typeof LEGAL_CLASSES)[number];

export const LEGAL_CLASS_TO_FAMILY: Record<LegalClass, LegalFamily> = {
  bulletin_official: 'normative_legislative',
  fundamental_laws: 'normative_legislative',
  legal_codes: 'normative_legislative',
  first_instance_judgment: 'jurisprudence',
  appeal_judgment: 'jurisprudence',
  cassation_judgment: 'jurisprudence',
  interim_order: 'jurisprudence',
  private_contract: 'practice_contracts',
  authentic_act: 'practice_contracts',
  company_statutes: 'practice_contracts',
  introductory_petition: 'procedural',
  conclusions: 'procedural',
  summons: 'procedural',
  formal_notice: 'procedural',
  case_note: 'doctrinal',
  legal_opinion: 'doctrinal',
};

export interface LegalClassificationInput {
  collection?: string | null;
  document_type?: string | null;
  title_ar?: string | null;
  title_fr?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface LegalClassificationResult {
  family: LegalFamily;
  legalClass: LegalClass;
}

const JUDGMENT_COLLECTIONS = new Set(
  [
    'judgments_commercial',
    'judgments_civil',
    'judgments_admin',
    'judgments_criminal',
    'judgments_family',
    'judgments_social',
    'judgments_real_estate',
    'judgments_constitutional',
  ],
);

function titleHay(input: LegalClassificationInput): string {
  return `${input.title_ar || ''} ${input.title_fr || ''}`.toLowerCase();
}

function resolveJudgmentClass(input: LegalClassificationInput): LegalClass {
  const hay = titleHay(input);
  if (
    input.collection === 'judgments_constitutional' ||
    /cassation|نقض|محكمة النقض/.test(hay)
  ) {
    return 'cassation_judgment';
  }
  if (/appel|استئناف|arrêt d'appel/.test(hay)) {
    return 'appeal_judgment';
  }
  if (/référé|refere|استعجالي|مستعجل/.test(hay)) {
    return 'interim_order';
  }
  return 'first_instance_judgment';
}

function resolveNormativeClass(input: LegalClassificationInput): LegalClass {
  const hay = titleHay(input);
  if (/bulletin|journal officiel|الجريدة الرسمية|بلاغ|r\.o\.|b\.o\./.test(hay)) {
    return 'bulletin_official';
  }
  if (/code|قانون|دستور|dahir|ظهير|constitution/.test(hay)) {
    return input.document_type === 'official_doc'
      ? 'fundamental_laws'
      : 'legal_codes';
  }
  return 'legal_codes';
}

/** Infer family + class from stored document fields (manual metadata overrides auto). */
export function resolveLegalClassification(
  input: LegalClassificationInput,
): LegalClassificationResult {
  const meta = (input.metadata || {}) as Record<string, unknown>;
  const manualClass = meta.legal_class;
  if (typeof manualClass === 'string' && isLegalClass(manualClass)) {
    const cls = manualClass as LegalClass;
    const manualFamily = meta.legal_family;
    const family =
      typeof manualFamily === 'string' && isLegalFamily(manualFamily)
        ? (manualFamily as LegalFamily)
        : LEGAL_CLASS_TO_FAMILY[cls];
    return { family, legalClass: cls };
  }

  const collection = input.collection || '';
  const docType = input.document_type || 'other';
  const hay = titleHay(input);

  if (collection === 'legal_laws') {
    return {
      family: 'normative_legislative',
      legalClass: resolveNormativeClass(input),
    };
  }

  if (
    JUDGMENT_COLLECTIONS.has(collection) ||
    docType === 'judgment'
  ) {
    return {
      family: 'jurisprudence',
      legalClass: resolveJudgmentClass(input),
    };
  }

  switch (docType) {
    case 'contract':
      if (/statut|نظام أساسي|sarl|sa\b|شركة/.test(hay)) {
        return { family: 'practice_contracts', legalClass: 'company_statutes' };
      }
      return { family: 'practice_contracts', legalClass: 'private_contract' };
    case 'power_of_attorney':
      return { family: 'practice_contracts', legalClass: 'authentic_act' };
    case 'financial':
      if (/statut|نظام أساسي/.test(hay)) {
        return { family: 'practice_contracts', legalClass: 'company_statutes' };
      }
      return { family: 'practice_contracts', legalClass: 'private_contract' };
    case 'pleading':
      if (/requête|مقال افتتاح|introduct/.test(hay)) {
        return { family: 'procedural', legalClass: 'introductory_petition' };
      }
      return { family: 'procedural', legalClass: 'conclusions' };
    case 'minutes':
      return { family: 'procedural', legalClass: 'summons' };
    case 'correspondence':
      if (/mise en demeure|إنذار|انذار|formal notice/.test(hay)) {
        return { family: 'procedural', legalClass: 'formal_notice' };
      }
      if (/assignation|citation|استدعاء|تبليغ/.test(hay)) {
        return { family: 'procedural', legalClass: 'summons' };
      }
      return { family: 'procedural', legalClass: 'formal_notice' };
    case 'legal_memo':
      if (/note sous arrêt|commentaire|commentary|حاشية/.test(hay)) {
        return { family: 'doctrinal', legalClass: 'case_note' };
      }
      return { family: 'doctrinal', legalClass: 'legal_opinion' };
    case 'expert_report':
      return { family: 'doctrinal', legalClass: 'case_note' };
    case 'official_doc':
      return {
        family: 'normative_legislative',
        legalClass: 'fundamental_laws',
      };
    default:
      if (/contrat|عقد|convention/.test(hay)) {
        return { family: 'practice_contracts', legalClass: 'private_contract' };
      }
      if (/arrêt|jugement|حكم|قرار/.test(hay)) {
        return {
          family: 'jurisprudence',
          legalClass: resolveJudgmentClass(input),
        };
      }
      return { family: 'practice_contracts', legalClass: 'private_contract' };
  }
}

function isLegalFamily(value?: string | null): value is LegalFamily {
  return !!value && (LEGAL_FAMILIES as readonly string[]).includes(value);
}

function isLegalClass(value?: string | null): value is LegalClass {
  return !!value && (LEGAL_CLASSES as readonly string[]).includes(value);
}

export function assertLegalClassification(
  legalFamily: string,
  legalClass: string,
): { family: LegalFamily; legalClass: LegalClass } {
  if (!isLegalFamily(legalFamily) || !isLegalClass(legalClass)) {
    throw new Error('Invalid legal classification');
  }
  if (LEGAL_CLASS_TO_FAMILY[legalClass] !== legalFamily) {
    throw new Error('Legal class does not belong to family');
  }
  return { family: legalFamily, legalClass };
}

function hasManualClassification(metadata?: Record<string, unknown> | null): boolean {
  const meta = metadata || {};
  return (
    meta.legal_class_manual === true ||
    (typeof meta.legal_class === 'string' && meta.legal_class.length > 0)
  );
}

export function isManualLegalClassification(
  metadata?: Record<string, unknown> | null,
): boolean {
  return hasManualClassification(metadata);
}

/** Prefer metadata override, else inferred SQL match. */
function wrapClassFilter(inferredSql: string, legalClass: LegalClass): string {
  return `(
    d.metadata->>'legal_class' = '${legalClass}'
    OR (
      COALESCE(d.metadata->>'legal_class', '') = ''
      AND (${inferredSql})
    )
  )`;
}

function wrapFamilyFilter(inferredSql: string, family: LegalFamily): string {
  return `(
    d.metadata->>'legal_family' = '${family}'
    OR (
      COALESCE(d.metadata->>'legal_family', '') = ''
      AND (${inferredSql})
    )
  )`;
}

/**
 * Build a SQL fragment `( … )` matching documents for the given family/class.
 * Appends to an existing WHERE with AND.
 */
export function buildLegalClassificationFilter(
  legalFamily?: string | null,
  legalClass?: string | null,
): { sql: string; params: any[] } {
  const cls = isLegalClass(legalClass) ? legalClass : null;
  const family = isLegalFamily(legalFamily) ? legalFamily : null;

  if (!family && !cls) {
    return { sql: '', params: [] };
  }

  if (cls) {
    return { sql: classToSql(cls), params: [] };
  }

  if (family) {
    return { sql: familyToSql(family), params: [] };
  }

  return { sql: '', params: [] };
}

function familyToSql(family: LegalFamily): string {
  let inferred: string;
  switch (family) {
    case 'normative_legislative':
      inferred = `(d.collection = 'legal_laws' OR d.document_type = 'official_doc')`;
      break;
    case 'jurisprudence':
      inferred = `(d.document_type = 'judgment' OR d.collection LIKE 'judgments_%')`;
      break;
    case 'practice_contracts':
      inferred = `(d.document_type IN ('contract', 'power_of_attorney', 'financial')
        AND d.collection IS DISTINCT FROM 'legal_laws'
        AND (d.collection NOT LIKE 'judgments_%' OR d.collection IS NULL))`;
      break;
    case 'procedural':
      inferred = `(d.document_type IN ('pleading', 'minutes', 'correspondence'))`;
      break;
    case 'doctrinal':
      inferred = `(d.document_type IN ('legal_memo', 'expert_report'))`;
      break;
    default:
      inferred = 'TRUE';
  }
  return wrapFamilyFilter(inferred, family);
}

function classToSql(legalClass: LegalClass): string {
  let inferred: string;
  switch (legalClass) {
    case 'bulletin_official':
      inferred = `(d.collection = 'legal_laws' AND (
        d.title_ar ILIKE '%بلاغ%' OR d.title_ar ILIKE '%الجريدة الرسمية%'
        OR d.title_fr ILIKE '%bulletin%' OR d.title_fr ILIKE '%journal officiel%'
        OR d.document_type = 'official_doc'
      ))`;
      break;
    case 'fundamental_laws':
      inferred = `(d.collection = 'legal_laws' AND (
        d.document_type = 'official_doc'
        OR d.title_ar ILIKE '%ظهير%' OR d.title_ar ILIKE '%دستور%'
        OR d.title_fr ILIKE '%dahir%' OR d.title_fr ILIKE '%constitution%'
      ))`;
      break;
    case 'legal_codes':
      inferred = `(d.collection = 'legal_laws')`;
      break;
    case 'cassation_judgment':
      inferred = `(d.collection = 'judgments_constitutional'
        OR d.document_type = 'judgment' AND (
          d.title_ar ILIKE '%نقض%' OR d.title_fr ILIKE '%cassation%'
        ))`;
      break;
    case 'appeal_judgment':
      inferred = `((d.collection LIKE 'judgments_%' OR d.document_type = 'judgment') AND (
        d.title_ar ILIKE '%استئناف%' OR d.title_fr ILIKE '%appel%'
      ))`;
      break;
    case 'interim_order':
      inferred = `((d.collection LIKE 'judgments_%' OR d.document_type = 'judgment') AND (
        d.title_ar ILIKE '%مستعجل%' OR d.title_ar ILIKE '%استعجالي%'
        OR d.title_fr ILIKE '%référé%' OR d.title_fr ILIKE '%refere%'
      ))`;
      break;
    case 'first_instance_judgment':
      inferred = `(d.document_type = 'judgment' OR d.collection LIKE 'judgments_%')`;
      break;
    case 'private_contract':
      inferred = `(d.document_type IN ('contract', 'financial', 'other')
        AND d.collection IS DISTINCT FROM 'legal_laws'
        AND (d.collection NOT LIKE 'judgments_%' OR d.collection IS NULL))`;
      break;
    case 'authentic_act':
      inferred = `(d.document_type = 'power_of_attorney')`;
      break;
    case 'company_statutes':
      inferred = `(d.document_type IN ('contract', 'financial')
        AND (d.title_ar ILIKE '%نظام%' OR d.title_fr ILIKE '%statut%'))`;
      break;
    case 'introductory_petition':
      inferred = `(d.document_type = 'pleading' AND (
        d.title_ar ILIKE '%مقال%' OR d.title_fr ILIKE '%requête%'
      ))`;
      break;
    case 'conclusions':
      inferred = `(d.document_type = 'pleading')`;
      break;
    case 'summons':
      inferred = `(d.document_type IN ('minutes', 'correspondence') AND (
        d.title_ar ILIKE '%تبليغ%' OR d.title_ar ILIKE '%استدعاء%'
        OR d.title_fr ILIKE '%assignation%' OR d.title_fr ILIKE '%citation%'
      ))`;
      break;
    case 'formal_notice':
      inferred = `(d.document_type = 'correspondence' OR (
        d.title_ar ILIKE '%إنذار%' OR d.title_fr ILIKE '%mise en demeure%'
      ))`;
      break;
    case 'case_note':
      inferred = `(d.document_type IN ('legal_memo', 'expert_report') AND (
        d.title_ar ILIKE '%حاشية%' OR d.title_fr ILIKE '%note sous arr%'
      ))`;
      break;
    case 'legal_opinion':
      inferred = `(d.document_type = 'legal_memo')`;
      break;
    default:
      inferred = 'TRUE';
  }
  return wrapClassFilter(inferred, legalClass);
}
