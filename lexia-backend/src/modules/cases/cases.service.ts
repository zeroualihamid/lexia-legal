import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { PostgresService } from '../../database/postgres.service';
import { DocumentsService } from '../documents/documents.service';
import { AgentDocsClient } from '../agent-docs/agent-docs.client';
import {
  CourtType,
  CaseCategory,
  MahakimQuery,
} from '../mahakim/mahakim.types';

export interface CaseDto {
  title?: string;
  clientName?: string;
  caseRef?: string;
  description?: string;
  status?: string;
  // Structured court reference (drives the mahakim.ma lookup).
  courtType?: CourtType;
  courtName?: string;
  fileNumber?: string;
  fileCode?: string;
  fileYear?: string;
  courtSection?: string;
  courtPanel?: string;
  caseCategory?: CaseCategory;
}

/** Result of detecting a court reference inside a chat message. */
export interface CaseReferenceCapture {
  updated: boolean;
  caseRef: string | null;
  mahakimStatus: string;
  mahakimSupported: boolean;
  parsed: ParsedReference;
}

const VALID_STATUS = ['open', 'closed', 'archived'];
const VALID_COURT_TYPE = ['appeal', 'first_instance', 'cassation'];
const VALID_CATEGORY = ['file', 'hearings'];
const SUPREME_COURT_NAME = 'محكمة النقض';

@Injectable()
export class CasesService {
  private readonly logger = new Logger(CasesService.name);

  constructor(
    private readonly postgres: PostgresService,
    private readonly documentsService: DocumentsService,
    private readonly agentDocsClient: AgentDocsClient,
    @InjectQueue('mahakim-sync') private readonly mahakimQueue: Queue,
  ) {}

  async create(userId: string, dto: CaseDto): Promise<any> {
    const title = (dto.title || '').trim();
    if (!title) throw new BadRequestException('عنوان القضية مطلوب');
    const status = VALID_STATUS.includes(dto.status) ? dto.status : 'open';
    const court = this.normalizeCourt(dto);
    const caseRef = this.resolveRef(dto.caseRef, court);
    const supported = this.mahakimSupported(court);

    let row: any;
    try {
      row = await this.postgres.queryOne<any>(
        `INSERT INTO cases
           (owner_id, title, client_name, case_ref, description, status,
            court_type, court_name, file_number, file_code, file_year,
            court_section, court_panel, case_category, mahakim_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [
          userId,
          title,
          dto.clientName || null,
          caseRef,
          dto.description || null,
          status,
          court.courtType,
          court.courtName,
          court.fileNumber,
          court.fileCode,
          court.fileYear,
          court.courtSection,
          court.courtPanel,
          court.category,
          this.initialMahakimStatus(court),
        ],
      );
    } catch (err: any) {
      throw this.translateDbError(err);
    }

    if (supported) await this.enqueueSync(row.id, userId, court);
    return row;
  }

  async list(userId: string): Promise<any[]> {
    return this.postgres.query<any>(
      `SELECT c.*,
              COUNT(d.id)::int AS document_count,
              COUNT(d.id) FILTER (WHERE d.status = 'processing')::int AS processing_count
       FROM cases c
       LEFT JOIN documents d ON d.case_id = c.id
       WHERE c.owner_id = $1
       GROUP BY c.id
       ORDER BY c.updated_at DESC`,
      [userId],
    );
  }

  async get(id: string, userId: string): Promise<any> {
    const row = await this.postgres.queryOne<any>(
      `SELECT c.*,
              COUNT(d.id)::int AS document_count
       FROM cases c
       LEFT JOIN documents d ON d.case_id = c.id
       WHERE c.id = $1
       GROUP BY c.id`,
      [id],
    );
    if (!row) throw new NotFoundException('Case not found');
    if (row.owner_id !== userId) throw new ForbiddenException('Access denied');
    return row;
  }

  async update(id: string, userId: string, dto: CaseDto): Promise<any> {
    const current = await this.getOwnedRow(id, userId);
    const fields: string[] = [];
    const values: any[] = [];
    let i = 1;
    if (dto.title !== undefined) {
      fields.push(`title = $${i++}`);
      values.push(dto.title);
    }
    if (dto.clientName !== undefined) {
      fields.push(`client_name = $${i++}`);
      values.push(dto.clientName);
    }
    if (dto.description !== undefined) {
      fields.push(`description = $${i++}`);
      values.push(dto.description);
    }
    if (dto.status !== undefined) {
      if (!VALID_STATUS.includes(dto.status)) {
        throw new BadRequestException('حالة غير صالحة');
      }
      fields.push(`status = $${i++}`);
      values.push(dto.status);
    }

    // Court-reference edit: detect whether the tracking key changed.
    const courtTouched =
      dto.courtType !== undefined ||
      dto.courtName !== undefined ||
      dto.fileNumber !== undefined ||
      dto.fileCode !== undefined ||
      dto.fileYear !== undefined ||
      dto.courtSection !== undefined ||
      dto.courtPanel !== undefined ||
      dto.caseCategory !== undefined ||
      dto.caseRef !== undefined;

    let nextCourt: NormalizedCourt | null = null;
    let trackChanged = false;
    if (courtTouched) {
      nextCourt = this.normalizeCourt({
        courtType: dto.courtType ?? current.court_type,
        courtName: dto.courtName ?? current.court_name,
        fileNumber: dto.fileNumber ?? current.file_number,
        fileCode: dto.fileCode ?? current.file_code,
        fileYear: dto.fileYear ?? current.file_year,
        courtSection: dto.courtSection ?? current.court_section,
        courtPanel: dto.courtPanel ?? current.court_panel,
        caseCategory: dto.caseCategory ?? current.case_category,
      });
      trackChanged = this.trackingKeyChanged(current, nextCourt);
      // Rebuild the composite reference from the (new) court fields. Only fall
      // back to the existing ref when we can't build one and the caller didn't
      // pass an explicit custom ref — otherwise editing the court would leave a
      // stale reference behind.
      let caseRef = this.resolveRef(dto.caseRef, nextCourt);
      if (caseRef === null) {
        caseRef = dto.caseRef !== undefined ? null : current.case_ref || null;
      }
      fields.push(`case_ref = $${i++}`);
      values.push(caseRef);
      fields.push(`court_type = $${i++}`);
      values.push(nextCourt.courtType);
      fields.push(`court_name = $${i++}`);
      values.push(nextCourt.courtName);
      fields.push(`file_number = $${i++}`);
      values.push(nextCourt.fileNumber);
      fields.push(`file_code = $${i++}`);
      values.push(nextCourt.fileCode);
      fields.push(`file_year = $${i++}`);
      values.push(nextCourt.fileYear);
      fields.push(`court_section = $${i++}`);
      values.push(nextCourt.courtSection);
      fields.push(`court_panel = $${i++}`);
      values.push(nextCourt.courtPanel);
      fields.push(`case_category = $${i++}`);
      values.push(nextCourt.category);
      if (trackChanged) {
        const supported = this.mahakimSupported(nextCourt);
        if (supported) {
          fields.push(`mahakim_status = $${i++}`);
          values.push('queued');
          fields.push(`mahakim_error = NULL`);
        } else if (this.hasReference(nextCourt)) {
          // A complete reference, but the court (e.g. النقض) is not on the portal.
          fields.push(`mahakim_status = $${i++}`);
          values.push('unsupported');
          fields.push(`mahakim_error = $${i++}`);
          values.push(this.unsupportedReason(nextCourt));
        }
      }
    }

    if (fields.length === 0) return this.get(id, userId);
    values.push(id);
    let row: any;
    try {
      row = await this.postgres.queryOne<any>(
        `UPDATE cases SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
        values,
      );
    } catch (err: any) {
      throw this.translateDbError(err);
    }

    if (nextCourt && trackChanged && this.mahakimSupported(nextCourt)) {
      await this.enqueueSync(id, userId, nextCourt);
    }
    return row;
  }

  /** Manually (re)trigger the mahakim.ma background lookup for a case. */
  async refreshMahakim(id: string, userId: string): Promise<any> {
    const row = await this.getOwnedRow(id, userId);
    const court = this.normalizeCourt({
      courtType: row.court_type,
      courtName: row.court_name,
      fileNumber: row.file_number,
      fileCode: row.file_code,
      fileYear: row.file_year,
      courtSection: row.court_section,
      courtPanel: row.court_panel,
      caseCategory: row.case_category,
    });
    if (court.courtType === 'cassation') {
      throw new BadRequestException(
        'تتبع محكمة النقض غير متاح على بوابة محاكم العمومية (تغطي فقط المحاكم الابتدائية ومحاكم الاستئناف)',
      );
    }
    if (!this.canTrack(court)) {
      throw new BadRequestException(
        'مرجع المحكمة غير مكتمل (المحكمة، رقم الملف، رمز الملف، والسنة مطلوبة)',
      );
    }
    await this.postgres.query(
      `UPDATE cases SET mahakim_status = 'queued', mahakim_error = NULL WHERE id = $1`,
      [id],
    );
    await this.enqueueSync(id, userId, court);
    return { success: true, status: 'queued' };
  }

  async remove(id: string, userId: string): Promise<void> {
    await this.assertOwnership(id, userId);
    // Clean MinIO objects + Qdrant vectors for every document, then drop the
    // case row (documents + pages cascade via FK ON DELETE CASCADE).
    await this.documentsService.purgeCaseDocuments(id, userId);
    await this.postgres.query(`DELETE FROM cases WHERE id = $1`, [id]);
  }

  async listDocuments(id: string, userId: string): Promise<any[]> {
    await this.assertOwnership(id, userId);
    return this.documentsService.getCaseDocuments(id, userId);
  }

  /** Semantic search scoped to one case (owner + case filter). */
  async search(
    id: string,
    userId: string,
    query: string,
    limit = 10,
  ): Promise<any[]> {
    await this.assertOwnership(id, userId);
    if (!query || !query.trim()) return [];
    const hits = await this.agentDocsClient.search({
      ownerId: userId,
      caseId: id,
      query,
      limit,
    });
    return this.enrichHits(hits);
  }

  /** Attach document titles to agent search hits. */
  private async enrichHits(hits: any[]): Promise<any[]> {
    if (hits.length === 0) return [];
    const ids = [...new Set(hits.map((h) => h.documentId).filter(Boolean))];
    if (ids.length === 0) return hits;
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ');
    const docs = await this.postgres.query<{
      id: string;
      title_ar: string;
      document_type: string;
    }>(
      `SELECT id, title_ar, document_type FROM documents WHERE id IN (${placeholders})`,
      ids,
    );
    const map = new Map(docs.map((d) => [d.id, d]));
    return hits.map((h) => ({
      ...h,
      titleAr: map.get(h.documentId)?.title_ar || null,
      documentType: map.get(h.documentId)?.document_type || h.docType || null,
    }));
  }

  private async assertOwnership(id: string, userId: string): Promise<void> {
    const row = await this.postgres.queryOne<{ owner_id: string }>(
      `SELECT owner_id FROM cases WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('Case not found');
    if (row.owner_id !== userId) throw new ForbiddenException('Access denied');
  }

  /** Fetch a case row and assert the caller owns it. */
  private async getOwnedRow(id: string, userId: string): Promise<any> {
    const row = await this.postgres.queryOne<any>(
      `SELECT * FROM cases WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('Case not found');
    if (row.owner_id !== userId) throw new ForbiddenException('Access denied');
    return row;
  }

  private normalizeCourt(dto: CaseDto): NormalizedCourt {
    const norm = (v?: string) => {
      const t = (v || '').trim();
      return t.length ? t : null;
    };
    let courtName = norm(dto.courtName);
    let courtType: CourtType | null = VALID_COURT_TYPE.includes(dto.courtType)
      ? (dto.courtType as CourtType)
      : null;
    // Infer the court type from the name when not given explicitly.
    if (!courtType && courtName) {
      if (/النقض|المجلس الأعلى/.test(courtName)) courtType = 'cassation';
      else if (/ابتدائية/.test(courtName)) courtType = 'first_instance';
      else courtType = 'appeal';
    }
    // Cassation always carries the canonical court name.
    if (courtType === 'cassation' && !courtName) courtName = SUPREME_COURT_NAME;
    const category = VALID_CATEGORY.includes(dto.caseCategory)
      ? dto.caseCategory
      : 'file';
    return {
      courtType,
      courtName,
      fileNumber: norm(dto.fileNumber),
      fileCode: norm(dto.fileCode),
      fileYear: norm(dto.fileYear),
      courtSection: norm(dto.courtSection),
      courtPanel: norm(dto.courtPanel),
      category: category as CaseCategory,
    };
  }

  /** A composite display reference, derived from court fields when not given. */
  private resolveRef(explicit: string | undefined, court: NormalizedCourt): string | null {
    const given = (explicit || '').trim();
    if (given) return given;
    if (!court.courtName || !court.fileNumber || !court.fileYear) return null;
    const mid = court.fileCode
      ? `${court.fileNumber}/${court.fileCode}/${court.fileYear}`
      : `${court.fileNumber}/${court.fileYear}`;
    const extras = [court.courtSection, court.courtPanel].filter(Boolean);
    const suffix = extras.length ? ` (${extras.join('، ')})` : '';
    return `${court.courtName} — ${mid}${suffix}`;
  }

  /** Enough fields to look the file up on mahakim.ma (appeal/first-instance). */
  private canTrack(court: NormalizedCourt): boolean {
    return !!(
      court.courtName &&
      court.fileNumber &&
      court.fileCode &&
      court.fileYear
    );
  }

  /** A meaningful court reference was captured (even if not portal-searchable). */
  private hasReference(court: NormalizedCourt): boolean {
    return !!(court.courtName && court.fileNumber && court.fileYear);
  }

  /** Whether the reference can actually be fetched from the mahakim.ma portal. */
  private mahakimSupported(court: NormalizedCourt): boolean {
    return court.courtType !== 'cassation' && this.canTrack(court);
  }

  private initialMahakimStatus(court: NormalizedCourt): string {
    if (this.mahakimSupported(court)) return 'queued';
    if (court.courtType === 'cassation' && this.hasReference(court)) {
      return 'unsupported';
    }
    return 'idle';
  }

  private unsupportedReason(court: NormalizedCourt): string {
    if (court.courtType === 'cassation') {
      return 'تتبع ملفات محكمة النقض غير متاح على بوابة محاكم العمومية (تغطي المحاكم الابتدائية ومحاكم الاستئناف فقط). تم حفظ المرجع.';
    }
    return 'رمز الملف ناقص أو غير صالح للبحث على بوابة محاكم.';
  }

  private trackingKeyChanged(prev: any, next: NormalizedCourt): boolean {
    return (
      (prev.court_name || null) !== next.courtName ||
      (prev.file_number || null) !== next.fileNumber ||
      (prev.file_code || null) !== next.fileCode ||
      (prev.file_year || null) !== next.fileYear ||
      (prev.court_section || null) !== next.courtSection ||
      (prev.court_panel || null) !== next.courtPanel ||
      (prev.court_type || null) !== next.courtType ||
      (prev.case_category || 'file') !== next.category
    );
  }

  private async enqueueSync(
    caseId: string,
    ownerId: string,
    court: NormalizedCourt,
  ): Promise<void> {
    const query: MahakimQuery = {
      courtType: court.courtType || 'appeal',
      courtName: court.courtName,
      fileNumber: court.fileNumber,
      fileCode: court.fileCode,
      fileYear: court.fileYear,
      category: court.category,
      courtSection: court.courtSection,
      courtPanel: court.courtPanel,
    };
    try {
      await this.mahakimQueue.add('sync', { caseId, ownerId, query });
    } catch (err: any) {
      this.logger.error(`Failed to enqueue mahakim sync: ${err?.message}`);
    }
  }

  private translateDbError(err: any): Error {
    if (err?.code === '23505') {
      return new ConflictException('يوجد قضية أخرى بنفس المرجع');
    }
    return err;
  }

  // ─── Conversational reference capture ───────────────────────
  /**
   * Detect a court-file reference inside a chat message (the lawyer typing the
   * case numbers in the case chat) and, when found, persist it onto the case and
   * (re)trigger the mahakim.ma lookup. Returns a summary so the chat can
   * acknowledge it, or null when no reference is present.
   */
  async captureReferenceFromText(
    caseId: string,
    userId: string,
    text: string,
  ): Promise<CaseReferenceCapture | null> {
    const parsed = parseReferenceFromText(text);
    if (!parsed) return null;

    const current = await this.getOwnedRow(caseId, userId);

    // Does the lawyer describe a DIFFERENT court file than the one on record?
    // If so we must not let stale fields (e.g. an old رمز) bleed into the new
    // reference — clear every court field, keeping only what was just parsed.
    const sameText = (a?: string | null, b?: string | null) =>
      (a || '').replace(/\s+/g, '') === (b || '').replace(/\s+/g, '');
    const freshFile =
      (!!parsed.courtType && parsed.courtType !== (current.court_type || null)) ||
      (!!parsed.courtName && !sameText(parsed.courtName, current.court_name)) ||
      (!!parsed.fileNumber &&
        !!current.file_number &&
        parsed.fileNumber !== current.file_number);

    // When it's a fresh file, pass '' to actively clear unspecified fields;
    // otherwise pass undefined to keep the existing value (incremental edit).
    const clear = freshFile ? '' : undefined;
    const dto: CaseDto = {
      courtType: parsed.courtType ?? undefined,
      courtName: parsed.courtName ?? clear,
      fileNumber: parsed.fileNumber ?? clear,
      fileCode: parsed.fileCode ?? clear,
      fileYear: parsed.fileYear ?? clear,
      courtSection: parsed.courtSection ?? clear,
      courtPanel: parsed.courtPanel ?? clear,
    };

    let row: any;
    try {
      row = await this.update(caseId, userId, dto);
    } catch (err: any) {
      this.logger.warn(`Reference capture update failed: ${err?.message}`);
      return null;
    }

    const court = this.normalizeCourt({
      courtType: row.court_type,
      courtName: row.court_name,
      fileNumber: row.file_number,
      fileCode: row.file_code,
      fileYear: row.file_year,
      courtSection: row.court_section,
      courtPanel: row.court_panel,
      caseCategory: row.case_category,
    });

    return {
      updated: true,
      caseRef: row.case_ref || null,
      mahakimStatus: row.mahakim_status,
      mahakimSupported: this.mahakimSupported(court),
      parsed,
    };
  }
}

interface NormalizedCourt {
  courtType: CourtType | null;
  courtName: string | null;
  fileNumber: string | null;
  fileCode: string | null;
  fileYear: string | null;
  courtSection: string | null;
  courtPanel: string | null;
  category: CaseCategory;
}

export interface ParsedReference {
  courtType: CourtType | null;
  courtName: string | null;
  fileNumber: string | null;
  fileCode: string | null;
  fileYear: string | null;
  courtSection: string | null;
  courtPanel: string | null;
}

/** Normalise Arabic-Indic digits, tatweel and common OCR/typo variants. */
function normalizeArabic(raw: string): string {
  if (!raw) return '';
  let s = raw;
  // Arabic-Indic + Eastern Arabic-Indic digits → ASCII.
  const map: Record<string, string> = {
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  };
  s = s.replace(/[٠-٩۰-۹]/g, (d) => map[d] ?? d);
  s = s.replace(/\u0640/g, ''); // tatweel
  // Common typos seen in real lawyer input / OCR.
  s = s.replace(/الق[يی]م(?=\s|التجار)/g, 'القسم'); // القيم → القسم
  s = s.replace(/اله[يیؤ]ؤ?[اأ]?ة/g, 'الهيئة'); // الهيؤاة / الهيأة → الهيئة
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Parse a free-text Arabic court reference such as:
 *   "ملف عدد 1378، القسم التجاري عدد 3، الهيئة عدد 3، السنة 2025، محكمة النقض"
 * Returns null when the text carries no recognisable reference signal.
 */
export function parseReferenceFromText(raw: string): ParsedReference | null {
  const s = normalizeArabic(raw);
  if (!s) return null;

  const out: ParsedReference = {
    courtType: null,
    courtName: null,
    fileNumber: null,
    fileCode: null,
    fileYear: null,
    courtSection: null,
    courtPanel: null,
  };

  // Court. Stop the city capture before any reference keyword so the court name
  // doesn't absorb "ملف عدد ...".
  const STOP = '(?:ملف|رقم|رمز|الس?نة|سنة|عدد|القسم|الغرفة|الهيئة|المؤرخ|بتاريخ)';
  if (/محكمة\s+النقض|المجلس\s+الأعلى/.test(s)) {
    out.courtType = 'cassation';
    out.courtName = SUPREME_COURT_NAME;
  } else {
    const appeal = s.match(
      new RegExp(
        `محكمة\\s+الاستئناف(\\s+التجارية|\\s+الإدارية)?\\s+(ب[^\\d،,.\\n]+?)(?=\\s+${STOP}|[\\d،,.\\n]|$)`,
      ),
    );
    const first = s.match(
      new RegExp(
        `المحكمة\\s+الابتدائية(\\s+التجارية|\\s+الإدارية)?\\s+(ب[^\\d،,.\\n]+?)(?=\\s+${STOP}|[\\d،,.\\n]|$)`,
      ),
    );
    if (appeal) {
      out.courtType = 'appeal';
      out.courtName = `محكمة الاستئناف${appeal[1] || ''} ${appeal[2]}`
        .replace(/\s+/g, ' ')
        .trim();
    } else if (first) {
      out.courtType = 'first_instance';
      out.courtName = `المحكمة الابتدائية${first[1] || ''} ${first[2]}`
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  // File number: "ملف عدد 1378" / "رقم الملف 1378" (tolerate ، , . : around).
  const num = s.match(/(?:رقم\s+الملف|ملف(?:\s+عدد)?)[\s:،,.()\-]*(\d{1,7})/);
  if (num) out.fileNumber = num[1];

  // File code: "رمز الملف 6060" / "رمز 6060".
  const code = s.match(/رمز(?:\s+الملف)?[\s:،,.()\-]*(\d{1,7})/);
  if (code) out.fileCode = code[1];

  // Year: "السنة 2025" / "سنة 2025" / bare 19xx-20xx.
  const yr =
    s.match(/(?:الس?نة|سنة)[\s:،,.()\-]*((?:19|20)\d{2})/) ||
    s.match(/\b((?:19|20)\d{2})\b/);
  if (yr) out.fileYear = yr[1];

  // Chamber / section: "القسم التجاري عدد 3" / "الغرفة المدنية عدد 2".
  const section = s.match(/(?:القسم|الغرفة)\s+[^\d،,.\n]*?(?:عدد\s*)?\d+/);
  if (section) out.courtSection = section[0].replace(/\s+/g, ' ').trim();

  // Panel / bench: "الهيئة عدد 3".
  const panel = s.match(/الهيئة\s*(?:عدد\s*)?\d+/);
  if (panel) out.courtPanel = panel[0].replace(/\s+/g, ' ').trim();

  const hasSignal =
    out.courtType ||
    out.fileNumber ||
    out.fileCode ||
    out.courtSection ||
    out.courtPanel ||
    // A bare year alone is too weak a signal on its own.
    (out.fileYear && (out.courtName || out.fileNumber));
  return hasSignal ? out : null;
}
