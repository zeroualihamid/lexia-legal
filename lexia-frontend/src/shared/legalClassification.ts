/**
 * Hierarchical legal document taxonomy for /search (Arabic UI).
 * Family/class ids must stay in sync with
 * lexia-backend/src/modules/documents/legal-classification.ts
 */

export type LegalFamilyId =
  | 'normative_legislative'
  | 'jurisprudence'
  | 'practice_contracts'
  | 'procedural'
  | 'doctrinal'

export type LegalClassId =
  | 'bulletin_official'
  | 'fundamental_laws'
  | 'legal_codes'
  | 'first_instance_judgment'
  | 'appeal_judgment'
  | 'cassation_judgment'
  | 'interim_order'
  | 'private_contract'
  | 'authentic_act'
  | 'company_statutes'
  | 'introductory_petition'
  | 'conclusions'
  | 'summons'
  | 'formal_notice'
  | 'case_note'
  | 'legal_opinion'

export interface LegalFamilyDef {
  id: LegalFamilyId
  label: string
  description: string
  classes: LegalClassDef[]
}

export interface LegalClassDef {
  id: LegalClassId
  label: string
  description: string
}

export const LEGAL_FAMILY_COLORS: Record<LegalFamilyId, string> = {
  normative_legislative: '#1677ff',
  jurisprudence: '#fa8c16',
  practice_contracts: '#52c41a',
  procedural: '#722ed1',
  doctrinal: '#13c2c2',
}

/** Structured taxonomy: authority texts → jurisprudence → practice → procedure → doctrine */
export const LEGAL_CLASSIFICATION: LegalFamilyDef[] = [
  {
    id: 'normative_legislative',
    label: 'النصوص المعيارية والتشريعية',
    description: 'مصادر القاعدة: نصوص تُلزم الجميع وتُنشر رسمياً (الجريدة الرسمية، القوانين، المدونات).',
    classes: [
      {
        id: 'bulletin_official',
        label: 'الجريدة / البلاغ الرسمي',
        description: 'Bulletin officiel — نشر النصوص لتصبح قابلة للتطبيق.',
      },
      {
        id: 'fundamental_laws',
        label: 'النصوص الأساسية والقوانين',
        description: 'الدستور، الظهائر، القوانين التنظيمية والعادية، المراسيم والقرارات الوزارية.',
      },
      {
        id: 'legal_codes',
        label: 'مدونات / Codes',
        description: 'تجميع القوانين حسب الموضوع (مدني، تجاري، عمل، جزائي…).',
      },
    ],
  },
  {
    id: 'jurisprudence',
    label: 'الاجتهاد القضائي',
    description: 'قرارات المحاكم — تطبيق القاعدة حسب التسلسل الهرمي للقضاء.',
    classes: [
      {
        id: 'first_instance_judgment',
        label: 'حكم ابتدائي',
        description: 'Jugement de première instance — الفصل في النزاع لأول مرة.',
      },
      {
        id: 'appeal_judgment',
        label: 'قرار استئناف',
        description: 'Arrêt d\'appel — إعادة النظر في الوقائع والقانون.',
      },
      {
        id: 'cassation_judgment',
        label: 'قرار نقض',
        description: 'Arrêt de cassation — مراقبة صحة تطبيق القانون دون إعادة الوقائع.',
      },
      {
        id: 'interim_order',
        label: 'أمر مستعجل / référé',
        description: 'Ordonnance de référé — تدابير وقتية عاجلة.',
      },
    ],
  },
  {
    id: 'practice_contracts',
    label: 'أفعال الممارسة والعقود',
    description: 'تنظيم العلاقات بين الأطراف أو إثبات وقائع قانونية.',
    classes: [
      {
        id: 'private_contract',
        label: 'عقد خاص',
        description: 'Acte sous seing privé — عمل، كراء، بيع…',
      },
      {
        id: 'authentic_act',
        label: 'عقد موثق / عدلي',
        description: 'Acte authentique — أمام موثق أو عدل.',
      },
      {
        id: 'company_statutes',
        label: 'نظام أساسي لشركة',
        description: 'Statuts — تأسيس SARL، SA…',
      },
    ],
  },
  {
    id: 'procedural',
    label: 'أفعال الإجراءات',
    description: 'مذكرات وإجراءات التقاضي (محامٍ، مُبلّغ).',
    classes: [
      {
        id: 'introductory_petition',
        label: 'مقال افتتاحي / requête',
        description: 'Requête introductive d\'instance — افتتاح الدعوى.',
      },
      {
        id: 'conclusions',
        label: 'مذكرات / conclusions',
        description: 'Conclusions — مرافعات كتابية أثناء التقاضي.',
      },
      {
        id: 'summons',
        label: 'تبليغ / assignation',
        description: 'Assignation — إعلام رسمي بوجود دعوى.',
      },
      {
        id: 'formal_notice',
        label: 'إنذار / mise en demeure',
        description: 'إمهال المنذَر قبل المتابعة القضائية.',
      },
    ],
  },
  {
    id: 'doctrinal',
    label: 'الوثائق التحليلية والفقهية',
    description: 'تحليل أكاديمي أو استشاري — لا يلزم بذاته.',
    classes: [
      {
        id: 'case_note',
        label: 'حاشية / note sous arrêt',
        description: 'تحليل نقدي لحكم مهم.',
      },
      {
        id: 'legal_opinion',
        label: 'استشارة قانونية',
        description: 'Consultation — رأي مكتوب حول فرص النجاح أو المخاطر.',
      },
    ],
  },
]

const classLabelMap = new Map<LegalClassId, string>()
const familyLabelMap = new Map<LegalFamilyId, string>()

for (const family of LEGAL_CLASSIFICATION) {
  familyLabelMap.set(family.id, family.label)
  for (const cls of family.classes) {
    classLabelMap.set(cls.id, cls.label)
  }
}

export function getLegalFamilyLabel(id?: string | null): string {
  if (!id) return ''
  return familyLabelMap.get(id as LegalFamilyId) || id
}

export function getLegalClassLabel(id?: string | null): string {
  if (!id) return ''
  return classLabelMap.get(id as LegalClassId) || id
}

/** Ant Design Cascader options (family → class). */
export const LEGAL_CLASSIFICATION_CASCADER_OPTIONS = LEGAL_CLASSIFICATION.map((family) => ({
  value: family.id,
  label: family.label,
  children: family.classes.map((cls) => ({
    value: cls.id,
    label: cls.label,
  })),
}))

/** Flat select: all classes with family prefix. */
export const LEGAL_CLASS_FLAT_OPTIONS = [
  { value: '', label: 'جميع التصنيفات' },
  ...LEGAL_CLASSIFICATION.flatMap((family) =>
    family.classes.map((cls) => ({
      value: cls.id,
      label: `${cls.label} — ${family.label}`,
    })),
  ),
]

export function resolveClassificationLabels(
  family?: string | null,
  legalClass?: string | null,
): { familyLabel: string; classLabel: string; familyColor: string } {
  const familyId = (family || '') as LegalFamilyId
  return {
    familyLabel: getLegalFamilyLabel(family),
    classLabel: getLegalClassLabel(legalClass),
    familyColor: LEGAL_FAMILY_COLORS[familyId] || '#8c8c8c',
  }
}
