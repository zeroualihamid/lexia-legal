/**
 * Quick dev script: extract judgment metadata from OCR text (stdin or sample).
 * Usage: npx ts-node scripts/extract-judgment-metadata.ts
 */
import { JudgmentMetadataService } from '../src/modules/documents/judgment-metadata.service';
import { ClaudeCodeService } from '../src/common/claude/claude-code.service';
import { ConfigService } from '@nestjs/config';

const SAMPLE = `Scanné avec CamScanner

المملكة المغربية
—
الحمد لله وحده

باسم جلالة الملك وطبقا للقانون

بتاريخ : 2025/10/29
إن الغرفة التجارية الهيئة الأولى بمحكمة النقض
في جلستها العلنية أصدرت القرار الآتي نصه :

بَين : 1- شركة ستلام المغرب شركة مساهمة، في شخص رئيس وأعضاء مجلس إدارتها،
الكانن مقرها الاجتماعي بالرقم 216، شارع الزرقطوني، الدار البيضاء.
2- شركة التامين اطلنطا سند، شركة مساهمة، في شخص رئيس وأعضاء مجلس
إدارتها، الكانن مقرها بالرقم 181، شارع الفا، الدار البيضاء.
ينوب عنهما الأستاذ محمد المهدي الدبوري، المحامي بهيئة الدار البيضاء، والمقبول
للترافع أمام محكمة النقض.

الطالبة
وبين : 1- ريان الباخرة الاتيب ALATEPE، بوصفه ممثلًا لمالكي ومجهزي ومستأجري
الباخرة الممثل بالمغرب عند شركة وفا شبينغ، شركة محدودة المسؤولية، في
شخص ممثلها القانوني، الكانن مقرها الاجتماعي بشارع الجيش الملكي، مركز
إيمان الطابق 7، الدار البيضاء.
2- شركة استغلال الموانيء، شركة مساهمة، في شخص رئيس وأعضاء مجلس
إدارتها، الكانن مقرها الاجتماعي بالرقم 175، شارع الزرقطوني، الدار البيضاء.
3- شركة أكسا للتامين المغرب، شركة مساهمة، في شخص رئيس وأعضاء مجلسها
الإداري، الكانن مقرها بالرقم 122، شارع الحسن الثاني، الدار البيضاء.

المطلوب

رقم الملف : 2025/1/3/599
رقم القرار : 1722

وبعد تلاوة التقرير من طرف المستشار المفرز السيد محمد كرام والاستماع إلى ملاحظات
المحاميه العامة السيدة سهام لخضر تقرر حجز القضية للمداولة.
`;

async function main() {
  const config = {
    get: (key: string) => {
      if (key === 'claude.oauthToken') return process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (key === 'claude.classificationTimeoutMs')
        return Number(process.env.CLAUDE_CLASSIFICATION_TIMEOUT_MS || 90000);
      return undefined;
    },
  } as ConfigService;

  const service = new JudgmentMetadataService(new ClaudeCodeService(config));
  const text = process.argv[2] || SAMPLE;
  const result = await service.extractFromText(text);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
