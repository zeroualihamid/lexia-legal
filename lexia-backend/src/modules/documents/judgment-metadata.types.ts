export interface JudgmentFileReference {
  /** Composite reference e.g. 2025/1/3/599 */
  fileReferenceRaw?: string | null;
  fileNumber?: string | null;
  fileCode?: string | null;
  fileYear?: string | null;
  decisionNumber?: string | null;
  decisionDate?: string | null;
  courtName?: string | null;
  courtSection?: string | null;
  courtPanel?: string | null;
  courtType?: string | null;
  /** Lower-court file referenced in cassation appeals */
  appealedFileReference?: string | null;
}

export interface JudgmentParties {
  plaintiffs: string[];
  defendants: string[];
  /** e.g. interveners, third parties */
  others: string[];
}

export interface JudgmentMetadata {
  fileReference: JudgmentFileReference;
  judges: string[];
  parties: JudgmentParties;
  lawyers: string[];
  /** How the metadata was produced */
  source: 'regex' | 'claude' | 'hybrid';
}
