import { DOMParser } from 'linkedom';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

function resolveGitConfigUserEmail(startDir = process.cwd()): string | undefined {
  const extractEmail = (configPath: string): string | undefined => {
    if (!existsSync(configPath)) return undefined;
    const raw = readFileSync(configPath, 'utf8');
    const userSection = raw.match(/\[user\]([\s\S]*?)(?:\n\[|$)/);
    const emailMatch = userSection?.[1]?.match(/email\s*=\s*(.+)/);
    return emailMatch?.[1]?.trim() || undefined;
  };

  let currentDir = startDir;

  while (true) {
    const gitConfigPath = path.join(currentDir, '.git', 'config');
    if (existsSync(gitConfigPath)) {
      const email = extractEmail(gitConfigPath);
      if (email) return email;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  const globalCandidates = [
    path.join(homedir(), '.gitconfig'),
    path.join(homedir(), '.config', 'git', 'config'),
  ];

  for (const candidate of globalCandidates) {
    const email = extractEmail(candidate);
    if (email) return email;
  }

  return undefined;
}

function resolveSecUserAgent(): string {
  const explicit = process.env.DEXTER_SEC_USER_AGENT?.trim() || process.env.SEC_USER_AGENT?.trim();
  if (explicit) {
    return explicit;
  }

  const contactEmail = process.env.DEXTER_SEC_CONTACT_EMAIL?.trim()
    || process.env.SEC_CONTACT_EMAIL?.trim()
    || process.env.GIT_AUTHOR_EMAIL?.trim()
    || process.env.GIT_COMMITTER_EMAIL?.trim()
    || resolveGitConfigUserEmail();

  if (!contactEmail) {
    throw new Error(
      'SEC-backed Free-US mode requires a contact string. Set DEXTER_SEC_USER_AGENT or DEXTER_SEC_CONTACT_EMAIL.',
    );
  }

  return `Dexter Free-US Fallback (${contactEmail})`;
}

function getSecHeaders() {
  return {
    'User-Agent': resolveSecUserAgent(),
    'Accept-Encoding': 'gzip, deflate',
  };
}

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
} as const;

export interface PriceBar {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
}

export interface FreeUsPriceSnapshot {
  ticker: string;
  currency?: string;
  exchange?: string;
  regularMarketPrice?: number;
  previousClose?: number;
  latestBar?: PriceBar;
  recentBars: PriceBar[];
  sourceUrl: string;
}

export interface FreeUsFiling {
  form: string;
  filed_at: string;
  accession_number: string;
  primary_document: string;
  description?: string;
  sec_url: string;
}

export interface FinancialPoint {
  periodEnd?: string;
  filedAt?: string;
  fiscalYear?: number;
  fiscalPeriod?: string;
  form?: string;
  revenue?: number;
  netIncome?: number;
  operatingIncome?: number;
  operatingCashFlow?: number;
  assets?: number;
  cashAndEquivalents?: number;
}

export interface FreeUsFinancialSummary {
  ticker: string;
  companyName: string;
  cik: string;
  latestAnnual?: FinancialPoint;
  latestQuarterly?: FinancialPoint;
  sourceUrl: string;
}

export interface FreeUsNewsItem {
  title: string;
  link: string;
  publishedAt?: string;
  source?: string;
}

export interface FreeUsNewsResult {
  items: FreeUsNewsItem[];
  sourceUrl: string;
}

function normalizeRssPubDate(value?: string): string | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  return new Date(parsed).toISOString();
}

export interface FreeUsPocReport {
  ticker: string;
  companyName: string;
  cik: string;
  price: FreeUsPriceSnapshot;
  filings: FreeUsFiling[];
  financials: FreeUsFinancialSummary;
  news: FreeUsNewsItem[];
}

export interface FreeUsFilingsResult {
  filings: FreeUsFiling[];
  sourceUrl: string;
}

interface SecTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

interface CompanyFactsResponse {
  cik: number;
  entityName: string;
  facts: Record<string, Record<string, { units?: Record<string, SecFactValue[]> }>>;
}

interface SecFactValue {
  start?: string;
  end?: string;
  val: number;
  accn?: string;
  fy?: number;
  fp?: string;
  form?: string;
  filed?: string;
  frame?: string;
}

let secTickerMapPromise: Promise<Map<string, SecTickerEntry>> | null = null;

function toIsoDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response.json() as Promise<T>;
}

async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText} for ${url}`);
  }
  return response.text();
}

async function getSecTickerMap(): Promise<Map<string, SecTickerEntry>> {
  if (!secTickerMapPromise) {
    secTickerMapPromise = (async () => {
      try {
        const raw = await fetchJson<Record<string, SecTickerEntry>>(
          'https://www.sec.gov/files/company_tickers.json',
          { headers: getSecHeaders() },
        );
        return new Map(Object.values(raw).map((entry) => [entry.ticker.toUpperCase(), entry]));
      } catch (error) {
        secTickerMapPromise = null;
        throw error;
      }
    })();
  }
  return secTickerMapPromise;
}

async function resolveSecCompany(ticker: string): Promise<{ cik: string; companyName: string }> {
  const upper = ticker.trim().toUpperCase();
  const map = await getSecTickerMap();
  const candidates = [...new Set([
    upper,
    upper.replace(/\./g, '-'),
    upper.replace(/-/g, '.'),
  ])];
  const entry = candidates
    .map((candidate) => map.get(candidate))
    .find((value): value is SecTickerEntry => Boolean(value));
  if (!entry) {
    throw new Error(`Ticker not found in SEC company_tickers.json: ${upper}`);
  }
  return {
    cik: String(entry.cik_str).padStart(10, '0'),
    companyName: entry.title,
  };
}

export async function getFreeUsPriceSnapshot(ticker: string): Promise<FreeUsPriceSnapshot> {
  const upper = ticker.trim().toUpperCase();
  const sourceUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${upper}?range=1mo&interval=1d&includePrePost=false&events=div%2Csplits`;
  const data = await fetchJson<any>(sourceUrl, { headers: YAHOO_HEADERS });
  const result = data?.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo chart returned no result for ${upper}`);
  }

  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const bars: PriceBar[] = timestamps.map((ts, index) => ({
    date: toIsoDate(ts),
    open: quote.open?.[index] ?? null,
    high: quote.high?.[index] ?? null,
    low: quote.low?.[index] ?? null,
    close: quote.close?.[index] ?? null,
    volume: quote.volume?.[index] ?? null,
  })).filter((bar) => bar.close !== null);

  return {
    ticker: upper,
    currency: result.meta?.currency,
    exchange: result.meta?.fullExchangeName ?? result.meta?.exchangeName,
    regularMarketPrice: result.meta?.regularMarketPrice,
    previousClose: result.meta?.previousClose,
    latestBar: bars.at(-1),
    recentBars: bars.slice(-5),
    sourceUrl,
  };
}

export async function getFreeUsFilingsResult(
  ticker: string,
  forms?: string[],
  limit = 8,
): Promise<FreeUsFilingsResult> {
  const upper = ticker.trim().toUpperCase();
  const { cik } = await resolveSecCompany(upper);
  const sourceUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const data = await fetchJson<any>(sourceUrl, { headers: getSecHeaders() });
  const recent = data?.filings?.recent;
  if (!recent) {
    return { filings: [], sourceUrl };
  }

  const out: FreeUsFiling[] = [];
  for (let i = 0; i < recent.form.length; i += 1) {
    const form = recent.form[i];
    if (forms && forms.length > 0 && !forms.includes(form)) continue;
    const accessionNumber = recent.accessionNumber[i];
    const primaryDocument = recent.primaryDocument[i];
    const accessionCompact = String(accessionNumber).replace(/-/g, '');
    out.push({
      form,
      filed_at: recent.filingDate[i],
      accession_number: accessionNumber,
      primary_document: primaryDocument,
      description: recent.primaryDocDescription?.[i],
      sec_url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionCompact}/${primaryDocument}`,
    });
    if (out.length >= limit) break;
  }

  return { filings: out, sourceUrl };
}

export async function getFreeUsFilings(
  ticker: string,
  forms?: string[],
  limit = 8,
): Promise<FreeUsFiling[]> {
  const result = await getFreeUsFilingsResult(ticker, forms, limit);
  return result.filings;
}

const FACT_ALIASES = {
  revenue: [
    'RevenueFromContractWithCustomerExcludingAssessedTax',
    'SalesRevenueNet',
    'Revenues',
  ],
  netIncome: ['NetIncomeLoss', 'ProfitLoss'],
  operatingIncome: ['OperatingIncomeLoss'],
  operatingCashFlow: [
    'NetCashProvidedByUsedInOperatingActivities',
    'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations',
  ],
  assets: ['Assets'],
  totalLiabilities: ['Liabilities'],
  shareholdersEquity: [
    'StockholdersEquity',
    'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest',
    'StockholdersEquityAttributableToParent',
  ],
  cashAndEquivalents: [
    'CashAndCashEquivalentsAtCarryingValue',
    'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents',
  ],
  capitalExpenditure: [
    'PaymentsToAcquirePropertyPlantAndEquipment',
    'CapitalExpendituresIncurredButNotYetPaid',
  ],
  epsDiluted: ['EarningsPerShareDiluted'],
  epsBasic: ['EarningsPerShareBasic'],
} as const;

const DEI_FACT_ALIASES = {
  sharesOutstanding: ['EntityCommonStockSharesOutstanding'],
} as const;

export interface FreeUsStatementRow {
  report_period?: string;
  filed_date?: string;
  fiscal_year?: number;
  fiscal_period?: string;
  form?: string;
  revenue?: number;
  operating_income?: number;
  net_income?: number;
  earnings_per_share?: number;
  basic_earnings_per_share?: number;
  total_assets?: number;
  total_liabilities?: number;
  shareholders_equity?: number;
  cash_and_equivalents?: number;
  operating_cash_flow?: number;
  capital_expenditure?: number;
}

export interface FreeUsKeyMetricsSnapshot {
  ticker: string;
  market_cap?: number;
  pe_ratio?: number;
  eps?: number;
  revenue_growth_rate?: number;
  earnings_growth_rate?: number;
  operating_margin?: number;
  net_margin?: number;
  debt_to_equity?: number;
  latest_price?: number;
  latest_report_period?: string;
  sourceUrls: string[];
}

function getUsdFacts(facts: CompanyFactsResponse['facts'], conceptNames: readonly string[]): SecFactValue[] {
  return getFactValues(facts, 'us-gaap', conceptNames, ['USD']);
}

function getPerShareFacts(facts: CompanyFactsResponse['facts'], conceptNames: readonly string[]): SecFactValue[] {
  return getFactValues(facts, 'us-gaap', conceptNames, ['USD/shares']);
}

function getShareFacts(facts: CompanyFactsResponse['facts'], conceptNames: readonly string[]): SecFactValue[] {
  return getFactValues(facts, 'dei', conceptNames, ['shares']);
}

function getFactValues(
  facts: CompanyFactsResponse['facts'],
  namespace: string,
  conceptNames: readonly string[],
  unitKeys: readonly string[],
): SecFactValue[] {
  const scopedFacts = facts[namespace] ?? {};
  for (const conceptName of conceptNames) {
    const concept = scopedFacts[conceptName];
    for (const unitKey of unitKeys) {
      const values = concept?.units?.[unitKey];
      if (values?.length) {
        return values;
      }
    }
  }
  return [];
}

function sortFactValues(values: SecFactValue[]): SecFactValue[] {
  return [...values].sort((a, b) => {
    const aFiled = a.filed ?? a.end ?? '';
    const bFiled = b.filed ?? b.end ?? '';
    if (aFiled !== bFiled) return bFiled.localeCompare(aFiled);
    const aEnd = a.end ?? '';
    const bEnd = b.end ?? '';
    return bEnd.localeCompare(aEnd);
  });
}

function pickLatestFact(values: SecFactValue[], mode: 'annual' | 'quarterly'): SecFactValue | undefined {
  const filtered = sortFactValues(values).filter((value) => {
    if (typeof value.val !== 'number') return false;
    if (mode === 'annual') {
      return value.form === '10-K' || value.fp === 'FY';
    }
    return value.form === '10-Q' || /^Q[1-4]$/.test(value.fp ?? '');
  });
  return filtered[0];
}

function buildFinancialPoint(
  facts: CompanyFactsResponse['facts'],
  mode: 'annual' | 'quarterly',
): FinancialPoint | undefined {
  const latestRow = buildStatementRows(facts, mode)[0];
  if (!latestRow) return undefined;

  return {
    periodEnd: latestRow.report_period,
    filedAt: latestRow.filed_date,
    fiscalYear: latestRow.fiscal_year,
    fiscalPeriod: latestRow.fiscal_period,
    form: latestRow.form,
    revenue: latestRow.revenue,
    netIncome: latestRow.net_income,
    operatingIncome: latestRow.operating_income,
    operatingCashFlow: latestRow.operating_cash_flow,
    assets: latestRow.total_assets,
    cashAndEquivalents: latestRow.cash_and_equivalents,
  };
}

export async function getFreeUsFinancialSummary(ticker: string): Promise<FreeUsFinancialSummary> {
  const upper = ticker.trim().toUpperCase();
  const { cik, companyName } = await resolveSecCompany(upper);
  const sourceUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const data = await fetchJson<CompanyFactsResponse>(sourceUrl, { headers: getSecHeaders() });

  return {
    ticker: upper,
    companyName,
    cik,
    latestAnnual: buildFinancialPoint(data.facts, 'annual'),
    latestQuarterly: buildFinancialPoint(data.facts, 'quarterly'),
    sourceUrl,
  };
}

function textContent(node: Element | null | undefined): string | undefined {
  const text = node?.textContent?.trim();
  return text ? text : undefined;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export async function getFreeUsNewsResult(ticker: string, limit = 5): Promise<FreeUsNewsResult> {
  const upper = ticker.trim().toUpperCase();
  const { companyName } = await resolveSecCompany(upper);
  const query = encodeURIComponent(`"${companyName}" OR ${upper}`);
  const sourceUrl = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  const xml = await fetchText(sourceUrl, { headers: YAHOO_HEADERS });
  const document = new DOMParser().parseFromString(xml, 'text/xml');
  const items = Array.from(document.querySelectorAll('item')) as Element[];

  return {
    items: items.slice(0, limit).map((item) => ({
      title: decodeHtmlEntities(textContent(item.querySelector('title')) ?? ''),
      link: textContent(item.querySelector('link')) ?? '',
      publishedAt: normalizeRssPubDate(textContent(item.querySelector('pubDate'))),
      source: textContent(item.querySelector('source')),
    })),
    sourceUrl,
  };
}

export async function getFreeUsNews(ticker: string, limit = 5): Promise<FreeUsNewsItem[]> {
  const result = await getFreeUsNewsResult(ticker, limit);
  return result.items;
}

export async function buildFreeUsPocReport(ticker: string): Promise<FreeUsPocReport> {
  const upper = ticker.trim().toUpperCase();
  const { cik, companyName } = await resolveSecCompany(upper);
  const [price, filingsResult, financials, newsResult] = await Promise.all([
    getFreeUsPriceSnapshot(upper),
    getFreeUsFilingsResult(upper),
    getFreeUsFinancialSummary(upper),
    getFreeUsNewsResult(upper),
  ]);

  return {
    ticker: upper,
    companyName,
    cik,
    price,
    filings: filingsResult.filings,
    financials,
    news: newsResult.items,
  };
}

function toUnixSeconds(date: string, mode: 'start' | 'end' = 'start'): number {
  const suffix = mode === 'start' ? 'T00:00:00Z' : 'T23:59:59Z';
  return Math.floor(Date.parse(`${date}${suffix}`) / 1000);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function mapIntervalToYahoo(interval: 'day' | 'week' | 'month' | 'year'): string {
  switch (interval) {
    case 'day': return '1d';
    case 'week': return '1wk';
    case 'month': return '1mo';
    case 'year': return '1mo';
    default: return '1d';
  }
}

function aggregateYearlyPrices(prices: Array<PriceBar & { ticker: string }>): Array<PriceBar & { ticker: string }> {
  const grouped = new Map<string, Array<PriceBar & { ticker: string }>>();

  for (const price of prices) {
    const year = price.date.slice(0, 4);
    const bucket = grouped.get(year) ?? [];
    bucket.push(price);
    grouped.set(year, bucket);
  }

  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, bucket]) => {
      const ordered = [...bucket].sort((a, b) => a.date.localeCompare(b.date));
      const first = ordered[0];
      const last = ordered[ordered.length - 1];
      const highs = ordered.map((row) => row.high).filter((value): value is number => value !== null);
      const lows = ordered.map((row) => row.low).filter((value): value is number => value !== null);
      const volumes = ordered.map((row) => row.volume).filter((value): value is number => value !== null);

      return {
        ticker: first.ticker,
        date: last.date,
        open: first.open,
        high: highs.length ? Math.max(...highs) : null,
        low: lows.length ? Math.min(...lows) : null,
        close: last.close,
        volume: volumes.length ? volumes.reduce((sum, value) => sum + value, 0) : null,
      };
    });
}

function durationDays(value: SecFactValue): number | undefined {
  if (!value.start || !value.end) return undefined;
  const start = Date.parse(value.start);
  const end = Date.parse(value.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.round((end - start) / 86_400_000) + 1;
}

function sortRelevantFacts(
  values: SecFactValue[],
  mode: 'annual' | 'quarterly',
  kind: 'flow' | 'point',
): SecFactValue[] {
  return [...values]
    .filter((value) => {
      if (typeof value.val !== 'number') return false;
      const fp = value.fp ?? '';
      const form = value.form ?? '';
      if (mode === 'annual') {
        if (kind === 'flow') {
          const days = durationDays(value);
          return fp === 'FY' || form === '10-K' || (days !== undefined && days >= 330);
        }
        return fp === 'FY' || form === '10-K';
      }

      if (kind === 'flow') {
        const days = durationDays(value);
        return (form === '10-Q' || /^Q[1-4]$/.test(fp)) && (
          Boolean(value.frame) || (days !== undefined && days <= 110)
        );
      }
      return form === '10-Q' || /^Q[1-4]$/.test(fp);
    })
    .sort((a, b) => {
      const aFiled = a.filed ?? a.end ?? '';
      const bFiled = b.filed ?? b.end ?? '';
      if (aFiled !== bFiled) return bFiled.localeCompare(aFiled);
      const aEnd = a.end ?? '';
      const bEnd = b.end ?? '';
      if (aEnd !== bEnd) return bEnd.localeCompare(aEnd);
      if (mode === 'quarterly' && kind === 'flow') {
        const aHasFrame = Boolean(a.frame);
        const bHasFrame = Boolean(b.frame);
        if (aHasFrame !== bHasFrame) return aHasFrame ? -1 : 1;
        const aDays = durationDays(a) ?? 9999;
        const bDays = durationDays(b) ?? 9999;
        if (aDays !== bDays) return aDays - bDays;
      }
      return 0;
    });
}

function factRowKey(value: SecFactValue): string {
  return [value.form ?? '', value.fp ?? '', value.end ?? '', value.filed ?? ''].join('|');
}

type RowKind = 'flow' | 'point';

function sortStatementRows(rows: FreeUsStatementRow[]): FreeUsStatementRow[] {
  return [...rows].sort((a, b) => {
    const aPeriod = a.report_period ?? '';
    const bPeriod = b.report_period ?? '';
    if (aPeriod !== bPeriod) return bPeriod.localeCompare(aPeriod);
    const aFiled = a.filed_date ?? '';
    const bFiled = b.filed_date ?? '';
    return bFiled.localeCompare(aFiled);
  });
}

function dedupeRowsByReportPeriod(rows: FreeUsStatementRow[]): FreeUsStatementRow[] {
  const byPeriod = new Map<string, FreeUsStatementRow>();
  for (const row of rows) {
    if (!row.report_period) continue;
    const existing = byPeriod.get(row.report_period);
    if (!existing) {
      byPeriod.set(row.report_period, row);
      continue;
    }

    byPeriod.set(row.report_period, {
      ...Object.fromEntries(
        Object.entries(row).filter(([, value]) => value !== undefined),
      ),
      ...Object.fromEntries(
        Object.entries(existing).filter(([, value]) => value !== undefined),
      ),
    });
  }
  return sortStatementRows([...byPeriod.values()]);
}

function buildRowsForKind(
  facts: CompanyFactsResponse['facts'],
  mode: 'annual' | 'quarterly',
  rowKind: RowKind,
): FreeUsStatementRow[] {
  const rows = new Map<string, FreeUsStatementRow>();

  const addField = (
    fieldName: keyof FreeUsStatementRow,
    values: SecFactValue[],
    kind: 'flow' | 'point',
  ) => {
    for (const value of sortRelevantFacts(values, mode, kind)) {
      const key = factRowKey(value);
      const row = rows.get(key) ?? {
        report_period: value.end,
        filed_date: value.filed,
        fiscal_year: value.fy,
        fiscal_period: value.fp,
        form: value.form,
      };
      if ((row as Record<string, string | number | undefined>)[fieldName] === undefined) {
        (row as Record<string, string | number | undefined>)[fieldName] = value.val;
      }
      rows.set(key, row);
    }
  };

  if (rowKind === 'flow') {
    addField('revenue', getUsdFacts(facts, FACT_ALIASES.revenue), 'flow');
    addField('operating_income', getUsdFacts(facts, FACT_ALIASES.operatingIncome), 'flow');
    addField('net_income', getUsdFacts(facts, FACT_ALIASES.netIncome), 'flow');
    addField('operating_cash_flow', getUsdFacts(facts, FACT_ALIASES.operatingCashFlow), 'flow');
    addField('capital_expenditure', getUsdFacts(facts, FACT_ALIASES.capitalExpenditure), 'flow');
    addField('earnings_per_share', getPerShareFacts(facts, FACT_ALIASES.epsDiluted), 'flow');
    addField('basic_earnings_per_share', getPerShareFacts(facts, FACT_ALIASES.epsBasic), 'flow');
  } else {
    addField('total_assets', getUsdFacts(facts, FACT_ALIASES.assets), 'point');
    addField('total_liabilities', getUsdFacts(facts, FACT_ALIASES.totalLiabilities), 'point');
    addField('shareholders_equity', getUsdFacts(facts, FACT_ALIASES.shareholdersEquity), 'point');
    addField('cash_and_equivalents', getUsdFacts(facts, FACT_ALIASES.cashAndEquivalents), 'point');
  }

  return dedupeRowsByReportPeriod([...rows.values()]
    .filter((row) => Object.keys(row).some((key) => !['report_period', 'filed_date', 'fiscal_year', 'fiscal_period', 'form'].includes(key)))
  );
}

function subtractQuarterWindow(
  annualValue: number | undefined,
  quarterRows: Array<FreeUsStatementRow | undefined>,
  field: NumericStatementField,
): number | undefined {
  if (annualValue === undefined) return undefined;
  if (quarterRows.some((row) => row?.[field] === undefined)) return undefined;
  return annualValue - quarterRows.reduce((sum, row) => sum + Number(row?.[field] ?? 0), 0);
}

function buildQuarterlyFlowRows(facts: CompanyFactsResponse['facts']): FreeUsStatementRow[] {
  const quarterlyRows = buildRowsForKind(facts, 'quarterly', 'flow');
  const annualRows = buildRowsForKind(facts, 'annual', 'flow');
  const derivedQ4Rows: FreeUsStatementRow[] = [];

  for (const annualRow of annualRows) {
    if (!annualRow.report_period || annualRow.fiscal_year === undefined) continue;
    const q1 = quarterlyRows.find((row) => row.fiscal_year === annualRow.fiscal_year && row.fiscal_period === 'Q1');
    const q2 = quarterlyRows.find((row) => row.fiscal_year === annualRow.fiscal_year && row.fiscal_period === 'Q2');
    const q3 = quarterlyRows.find((row) => row.fiscal_year === annualRow.fiscal_year && row.fiscal_period === 'Q3');
    if (!q1 || !q2 || !q3) continue;

    derivedQ4Rows.push({
      report_period: annualRow.report_period,
      filed_date: annualRow.filed_date,
      fiscal_year: annualRow.fiscal_year,
      fiscal_period: 'Q4',
      form: '10-K',
      revenue: subtractQuarterWindow(annualRow.revenue, [q1, q2, q3], 'revenue'),
      operating_income: subtractQuarterWindow(annualRow.operating_income, [q1, q2, q3], 'operating_income'),
      net_income: subtractQuarterWindow(annualRow.net_income, [q1, q2, q3], 'net_income'),
      operating_cash_flow: subtractQuarterWindow(annualRow.operating_cash_flow, [q1, q2, q3], 'operating_cash_flow'),
      capital_expenditure: subtractQuarterWindow(annualRow.capital_expenditure, [q1, q2, q3], 'capital_expenditure'),
    });
  }

  return dedupeRowsByReportPeriod([...quarterlyRows, ...derivedQ4Rows]);
}

function buildStatementRows(
  facts: CompanyFactsResponse['facts'],
  mode: 'annual' | 'quarterly',
): FreeUsStatementRow[] {
  const flowRows = mode === 'quarterly'
    ? buildQuarterlyFlowRows(facts)
    : buildRowsForKind(facts, mode, 'flow');
  const pointRows = buildRowsForKind(facts, mode, 'point');
  const pointByPeriod = new Map(
    pointRows
      .filter((row) => row.report_period)
      .map((row) => [row.report_period as string, row]),
  );

  return sortStatementRows(flowRows.map((row) => {
    const pointRow = row.report_period ? pointByPeriod.get(row.report_period) : undefined;
    return {
      ...row,
      total_assets: pointRow?.total_assets,
      total_liabilities: pointRow?.total_liabilities,
      shareholders_equity: pointRow?.shareholders_equity,
      cash_and_equivalents: pointRow?.cash_and_equivalents,
    };
  }));
}

function applyReportFilters(
  rows: FreeUsStatementRow[],
  filters: {
    report_period?: string;
    report_period_gt?: string;
    report_period_gte?: string;
    report_period_lt?: string;
    report_period_lte?: string;
    limit?: number;
  },
): FreeUsStatementRow[] {
  const filtered = rows.filter((row) => {
    const period = row.report_period ?? '';
    if (!period) return false;
    if (filters.report_period && period !== filters.report_period) return false;
    if (filters.report_period_gt && period <= filters.report_period_gt) return false;
    if (filters.report_period_gte && period < filters.report_period_gte) return false;
    if (filters.report_period_lt && period >= filters.report_period_lt) return false;
    if (filters.report_period_lte && period > filters.report_period_lte) return false;
    return true;
  });

  return filtered.slice(0, filters.limit ?? filtered.length);
}

async function fetchCompanyFactsWithMeta(ticker: string): Promise<{
  ticker: string;
  cik: string;
  companyName: string;
  sourceUrl: string;
  data: CompanyFactsResponse;
}> {
  const upper = ticker.trim().toUpperCase();
  const { cik, companyName } = await resolveSecCompany(upper);
  const sourceUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;
  const data = await fetchJson<CompanyFactsResponse>(sourceUrl, { headers: getSecHeaders() });
  return { ticker: upper, cik, companyName, sourceUrl, data };
}

function computeGrowthRate(current?: number, previous?: number): number | undefined {
  if (current === undefined || previous === undefined || previous === 0) return undefined;
  return (current - previous) / Math.abs(previous);
}

function computeRatio(numerator?: number, denominator?: number): number | undefined {
  if (numerator === undefined || denominator === undefined || denominator === 0) return undefined;
  return numerator / denominator;
}

function findComparableRow(rows: FreeUsStatementRow[], target: FreeUsStatementRow): FreeUsStatementRow | undefined {
  if (target.fiscal_period === 'TTM') {
    const idx = rows.indexOf(target);
    if (idx >= 0 && idx + 4 < rows.length) return rows[idx + 4];
    return undefined;
  }

  const targetYear = target.fiscal_year;
  const targetPeriod = target.fiscal_period;
  const samePeriodPriorYear = rows.find((row) =>
    row !== target && row.fiscal_period === targetPeriod && targetYear !== undefined && row.fiscal_year === targetYear - 1,
  );
  if (samePeriodPriorYear) return samePeriodPriorYear;
  const idx = rows.indexOf(target);
  if (idx >= 0 && idx + 1 < rows.length) return rows[idx + 1];
  return undefined;
}

function latestValue(values: SecFactValue[]): number | undefined {
  return sortFactValues(values).find((value) => typeof value.val === 'number')?.val;
}

type NumericStatementField =
  | 'revenue'
  | 'operating_income'
  | 'net_income'
  | 'earnings_per_share'
  | 'basic_earnings_per_share'
  | 'operating_cash_flow'
  | 'capital_expenditure';

function sumField(window: FreeUsStatementRow[], field: NumericStatementField): number | undefined {
  const values = window.map((row) => row[field]);
  if (values.some((value) => value === undefined)) return undefined;
  const definedValues = values as number[];
  return definedValues.reduce((sum, value) => sum + value, 0);
}

function buildTtmRows(quarterlyRows: FreeUsStatementRow[]): FreeUsStatementRow[] {
  const ttmRows: FreeUsStatementRow[] = [];

  for (let i = 0; i + 3 < quarterlyRows.length; i += 1) {
    const anchor = quarterlyRows[i];
    const window = quarterlyRows.slice(i, i + 4);

    ttmRows.push({
      report_period: anchor.report_period,
      filed_date: anchor.filed_date,
      fiscal_year: anchor.fiscal_year,
      fiscal_period: 'TTM',
      form: 'TTM',
      revenue: sumField(window, 'revenue'),
      operating_income: sumField(window, 'operating_income'),
      net_income: sumField(window, 'net_income'),
      earnings_per_share: sumField(window, 'earnings_per_share'),
      basic_earnings_per_share: sumField(window, 'basic_earnings_per_share'),
      operating_cash_flow: sumField(window, 'operating_cash_flow'),
      capital_expenditure: sumField(window, 'capital_expenditure'),
      total_assets: anchor.total_assets,
      total_liabilities: anchor.total_liabilities,
      shareholders_equity: anchor.shareholders_equity,
      cash_and_equivalents: anchor.cash_and_equivalents,
    });
  }

  return ttmRows;
}

function attachAnnualTtmEps(
  ttmRows: FreeUsStatementRow[],
  annualRows: FreeUsStatementRow[],
): FreeUsStatementRow[] {
  const annualByPeriod = new Map(
    annualRows
      .filter((row) => row.report_period)
      .map((row) => [row.report_period as string, row]),
  );

  return ttmRows.map((row) => {
    const annualRow = row.report_period ? annualByPeriod.get(row.report_period) : undefined;
    return {
      ...row,
      earnings_per_share: annualRow?.earnings_per_share ?? row.earnings_per_share,
      basic_earnings_per_share: annualRow?.basic_earnings_per_share ?? row.basic_earnings_per_share,
    };
  });
}

function getPeriodRows(
  facts: CompanyFactsResponse['facts'],
  period: 'annual' | 'quarterly' | 'ttm',
): FreeUsStatementRow[] {
  if (period === 'annual') {
    return buildStatementRows(facts, 'annual');
  }

  const quarterlyRows = buildStatementRows(facts, 'quarterly');
  if (period === 'quarterly') {
    return quarterlyRows;
  }

  return attachAnnualTtmEps(buildTtmRows(quarterlyRows), buildRowsForKind(facts, 'annual', 'flow'));
}

function findClosestClose(
  prices: Array<PriceBar & { ticker: string }>,
  targetDate: string,
): number | undefined {
  const onOrAfter = prices.find((price) => price.date >= targetDate && price.close !== null);
  if (onOrAfter?.close !== null && onOrAfter?.close !== undefined) {
    return onOrAfter.close;
  }

  const onOrBefore = [...prices].reverse().find((price) => price.date <= targetDate && price.close !== null);
  if (onOrBefore?.close !== null && onOrBefore?.close !== undefined) {
    return onOrBefore.close;
  }

  return undefined;
}

export async function getFreeUsTickers(): Promise<string[]> {
  const map = await getSecTickerMap();
  return [...map.keys()].sort();
}

export async function getFreeUsPriceHistory(
  ticker: string,
  interval: 'day' | 'week' | 'month' | 'year',
  startDate: string,
  endDate: string,
): Promise<{ prices: Array<PriceBar & { ticker: string }>; sourceUrl: string }> {
  const upper = ticker.trim().toUpperCase();
  const yahooInterval = mapIntervalToYahoo(interval);
  const period1 = toUnixSeconds(startDate, 'start');
  const period2 = toUnixSeconds(endDate, 'end');
  const sourceUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${upper}?period1=${period1}&period2=${period2}&interval=${yahooInterval}&includePrePost=false&events=div%2Csplits`;
  const data = await fetchJson<any>(sourceUrl, { headers: YAHOO_HEADERS });
  const result = data?.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo chart returned no historical result for ${upper}`);
  }
  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const prices = timestamps.map((ts, index) => ({
    ticker: upper,
    date: toIsoDate(ts),
    open: quote.open?.[index] ?? null,
    high: quote.high?.[index] ?? null,
    low: quote.low?.[index] ?? null,
    close: quote.close?.[index] ?? null,
    volume: quote.volume?.[index] ?? null,
  })).filter((bar) => bar.close !== null);
  return { prices: interval === 'year' ? aggregateYearlyPrices(prices) : prices, sourceUrl };
}

export async function getFreeUsStatementData(
  ticker: string,
  period: 'annual' | 'quarterly' | 'ttm',
  filters: {
    limit?: number;
    report_period?: string;
    report_period_gt?: string;
    report_period_gte?: string;
    report_period_lt?: string;
    report_period_lte?: string;
  } = {},
): Promise<{
  incomeStatements: FreeUsStatementRow[];
  balanceSheets: FreeUsStatementRow[];
  cashFlowStatements: FreeUsStatementRow[];
  sourceUrl: string;
}> {
  const { sourceUrl, data } = await fetchCompanyFactsWithMeta(ticker);
  const rows = applyReportFilters(getPeriodRows(data.facts, period), filters);

  const incomeStatements = rows.map((row) => ({
    report_period: row.report_period,
    filed_date: row.filed_date,
    fiscal_year: row.fiscal_year,
    fiscal_period: row.fiscal_period,
    form: row.form,
    revenue: row.revenue,
    operating_income: row.operating_income,
    net_income: row.net_income,
    earnings_per_share: row.earnings_per_share,
    basic_earnings_per_share: row.basic_earnings_per_share,
  }));

  const balanceSheets = rows.map((row) => ({
    report_period: row.report_period,
    filed_date: row.filed_date,
    fiscal_year: row.fiscal_year,
    fiscal_period: row.fiscal_period,
    form: row.form,
    total_assets: row.total_assets,
    total_liabilities: row.total_liabilities,
    shareholders_equity: row.shareholders_equity,
    cash_and_equivalents: row.cash_and_equivalents,
  }));

  const cashFlowStatements = rows.map((row) => ({
    report_period: row.report_period,
    filed_date: row.filed_date,
    fiscal_year: row.fiscal_year,
    fiscal_period: row.fiscal_period,
    form: row.form,
    operating_cash_flow: row.operating_cash_flow,
    capital_expenditure: row.capital_expenditure,
  }));

  return {
    incomeStatements,
    balanceSheets,
    cashFlowStatements,
    sourceUrl,
  };
}

export async function getFreeUsKeyMetricsSnapshot(ticker: string): Promise<FreeUsKeyMetricsSnapshot> {
  const upper = ticker.trim().toUpperCase();
  const [priceSnapshot, factsWithMeta] = await Promise.all([
    getFreeUsPriceSnapshot(upper),
    fetchCompanyFactsWithMeta(upper),
  ]);

  const quarterlyRows = buildStatementRows(factsWithMeta.data.facts, 'quarterly');
  const annualRows = buildStatementRows(factsWithMeta.data.facts, 'annual');
  const latestQuarter = quarterlyRows[0];
  const priorComparable = latestQuarter ? findComparableRow(quarterlyRows, latestQuarter) : undefined;
  const latestAnnual = annualRows[0];
  const price = priceSnapshot.regularMarketPrice ?? priceSnapshot.latestBar?.close ?? undefined;
  const sharesOutstanding = latestValue(getShareFacts(factsWithMeta.data.facts, DEI_FACT_ALIASES.sharesOutstanding));
  const eps = latestAnnual?.earnings_per_share
    ?? latestAnnual?.basic_earnings_per_share
    ?? (latestAnnual?.net_income !== undefined && sharesOutstanding ? latestAnnual.net_income / sharesOutstanding : undefined);

  return {
    ticker: upper,
    market_cap: price !== undefined && sharesOutstanding !== undefined ? price * sharesOutstanding : undefined,
    pe_ratio: price !== undefined && eps !== undefined && eps > 0 ? price / eps : undefined,
    eps,
    revenue_growth_rate: computeGrowthRate(latestQuarter?.revenue, priorComparable?.revenue),
    earnings_growth_rate: computeGrowthRate(latestQuarter?.net_income, priorComparable?.net_income),
    operating_margin: computeRatio(latestQuarter?.operating_income, latestQuarter?.revenue),
    net_margin: computeRatio(latestQuarter?.net_income, latestQuarter?.revenue),
    debt_to_equity: computeRatio(latestQuarter?.total_liabilities, latestQuarter?.shareholders_equity),
    latest_price: price,
    latest_report_period: latestQuarter?.report_period ?? latestAnnual?.report_period,
    sourceUrls: [priceSnapshot.sourceUrl, factsWithMeta.sourceUrl],
  };
}

export async function getFreeUsHistoricalKeyMetrics(
  ticker: string,
  period: 'annual' | 'quarterly' | 'ttm',
  filters: {
    limit?: number;
    report_period?: string;
    report_period_gt?: string;
    report_period_gte?: string;
    report_period_lt?: string;
    report_period_lte?: string;
  } = {},
): Promise<{ rows: Record<string, unknown>[]; sourceUrls: string[] }> {
  const upper = ticker.trim().toUpperCase();
  const factsWithMeta = await fetchCompanyFactsWithMeta(upper);
  const allRows = getPeriodRows(factsWithMeta.data.facts, period);
  const filteredRows = applyReportFilters(allRows, {
    ...filters,
    limit: undefined,
  });
  const resultRows = filteredRows.slice(0, filters.limit ?? filteredRows.length);

  let historicalPrices: Array<PriceBar & { ticker: string }> = [];
  let priceSourceUrl: string | undefined;
  const reportDates = resultRows.map((row) => row.report_period).filter((value): value is string => Boolean(value));
  if (reportDates.length > 0) {
    const sortedDates = [...reportDates].sort();
    const history = await getFreeUsPriceHistory(
      upper,
      'day',
      sortedDates[0],
      addDays(sortedDates[sortedDates.length - 1], 10),
    );
    historicalPrices = history.prices;
    priceSourceUrl = history.sourceUrl;
  }

  const out = resultRows.map((row) => {
    const comparable = findComparableRow(allRows, row);
    const eps = row.earnings_per_share ?? row.basic_earnings_per_share;
    const periodPrice = row.report_period ? findClosestClose(historicalPrices, row.report_period) : undefined;
    return {
      report_period: row.report_period,
      date: row.report_period,
      pe_ratio: periodPrice !== undefined && eps !== undefined && eps > 0 ? periodPrice / eps : undefined,
      eps,
      revenue_growth_rate: computeGrowthRate(row.revenue, comparable?.revenue),
      operating_margin: computeRatio(row.operating_income, row.revenue),
      net_margin: computeRatio(row.net_income, row.revenue),
      roe: computeRatio(row.net_income, row.shareholders_equity),
    };
  });

  return {
    rows: out,
    sourceUrls: priceSourceUrl ? [priceSourceUrl, factsWithMeta.sourceUrl] : [factsWithMeta.sourceUrl],
  };
}

export async function getFreeUsEarningsSnapshot(ticker: string): Promise<{ data: Record<string, unknown>; sourceUrls: string[] }> {
  const upper = ticker.trim().toUpperCase();
  const historical = await getFreeUsHistoricalKeyMetrics(upper, 'quarterly', { limit: 8 });
  const latest = historical.rows[0] ?? {};
  const financials = await getFreeUsStatementData(upper, 'quarterly', { limit: 2 });
  const latestIncome = financials.incomeStatements[0] ?? {};
  return {
    data: {
      revenue: latestIncome.revenue,
      eps: latest.eps,
      revenue_surprise: undefined,
      eps_surprise: undefined,
      report_period: latestIncome.report_period,
    },
    sourceUrls: historical.sourceUrls,
  };
}
