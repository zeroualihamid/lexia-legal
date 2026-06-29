-- Adala source: Jurisprudence URL delegates to CSPJ; magazine fallback on Adala itself
INSERT INTO sources (name_ar, name_fr, url, scraper_type, collection, is_active, config)
SELECT
  'عدالة - الاجتهادات القضائية',
  'Adala Jurisprudence (→ CSPJ)',
  'https://adala.justice.gov.ma/resources/Jurisprudence',
  'adala',
  'judgments_civil',
  TRUE,
  '{"max_pages": 5, "max_downloads": 20}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM sources WHERE url = 'https://adala.justice.gov.ma/resources/Jurisprudence'
);

INSERT INTO sources (name_ar, name_fr, url, scraper_type, collection, is_active, config)
SELECT
  'مجلة القضاء والقانون',
  'Adala - Revue Judiciaire',
  'https://adala.justice.gov.ma/resources/1079',
  'adala',
  'judgments_civil',
  TRUE,
  '{"max_pages": 3, "max_downloads": 30, "folderId": 1079}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM sources WHERE url = 'https://adala.justice.gov.ma/resources/1079'
);
