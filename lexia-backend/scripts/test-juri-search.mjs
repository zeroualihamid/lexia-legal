import axios from 'axios';
import * as cheerio from 'cheerio';
import * as https from 'https';

const BASE = 'https://juriscassation.cspj.ma';
const insecureAgent = new https.Agent({ rejectUnauthorized: false });

async function main() {
  const client = axios.create({
    timeout: 45000,
    httpsAgent: insecureAgent,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    },
  });

  const formPage = await client.get(`${BASE}/ar/Decisions/RechercheDecisions`);
  const $ = cheerio.load(formPage.data);
  const token = $('input[name="__RequestVerificationToken"]').attr('value');
  const rooms = $('select[name="ChambreIds"] option')
    .map((_, el) => $(el).attr('value'))
    .get()
    .filter(Boolean);

  console.log('token', !!token, 'rooms', rooms.length);

  const params = new URLSearchParams();
  params.append('__RequestVerificationToken', token || '');
  params.append('NumeroDos', '');
  params.append('NumeroDec', '');
  params.append('DateDec', '');
  for (const id of rooms) params.append('ChambreIds', id);
  params.append('DecisionPriseParId', '1');
  params.append('Sujet', 'تأمين');

  const res = await client.post(
    `${BASE}/ar/Decisions/RechercheDecisionsRes?page=1`,
    params.toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
      },
    },
  );

  const $$ = cheerio.load(res.data);
  const links = [];
  $$('a.dis-dec').each((_, el) => {
    links.push({ href: $$(el).attr('href'), title: $$(el).text().trim().slice(0, 80) });
  });
  const modals = [];
  $$('.show-modal-btn').each((_, el) => {
    modals.push({ id: $$(el).attr('data-id'), title: $$(el).text().trim().slice(0, 80) });
  });

  console.log('dis-dec', links.length, 'modal', modals.length);
  console.log(JSON.stringify({ links: links.slice(0, 3), modals: modals.slice(0, 3) }, null, 2));
  if (String(res.data).includes('لا توجد نتائج')) console.log('NO RESULTS');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
