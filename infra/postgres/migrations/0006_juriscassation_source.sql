-- Default scraping source: Juriscassation (CSPJ) — Cour de cassation decisions
INSERT INTO sources (name_ar, name_fr, url, scraper_type, collection, is_active, config)
SELECT
  'الاجتهاد القضائي',
  'Juriscassation CSPJ',
  'https://juriscassation.cspj.ma/ar',
  'juriscassation',
  'judgments_civil',
  TRUE,
  '{"max_pages": 10, "max_downloads": 100, "locale": "ar"}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM sources WHERE scraper_type = 'juriscassation'
);
