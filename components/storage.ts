import type {
  CaptureSnapshot,
  ColorScheme,
  DomainHistory,
  DomainSummary,
  FieldHistory,
  InputStashSettings,
  StashRecord,
  StashState,
} from './types';
import { shouldUpdateExistingValue } from './textSimilarity';

// Legacy v1 layout kept the whole stash under one key. Every capture rewrote
// the full blob and storage.onChanged then delivered old+new copies of it to
// every listening context, which made typing lag grow with stash size. The v2
// layout keeps one key per domain plus a small index for summaries so each
// capture only touches data for the domain being typed on.
const LEGACY_STATE_KEY = 'inputstash:domains:v1';
export const INDEX_KEY = 'inputstash:index:v2';
export const DOMAIN_KEY_PREFIX = 'inputstash:domain:v2:';
export const SETTINGS_KEY = 'inputstash:settings:v1';
export const SETTINGS_UPDATED_MESSAGE = 'inputstash:settings-updated';
export const DEFAULT_HISTORY_LIMIT = 20;
export const DEFAULT_IDENTITY_THRESHOLD = 50;
export const DEFAULT_COLOR_SCHEME: ColorScheme = 'auto';
const COLOR_SCHEMES: readonly ColorScheme[] = ['auto', 'light', 'dark'];
const COALESCE_WINDOW_MS = 45_000;

export const DEFAULT_SETTINGS: InputStashSettings = {
  historyLimit: DEFAULT_HISTORY_LIMIT,
  identityThreshold: DEFAULT_IDENTITY_THRESHOLD,
  blockedDomains: [],
  blockedFields: {},
  colorScheme: DEFAULT_COLOR_SCHEME,
};

export function normalizeColorScheme(value: unknown): ColorScheme {
  return COLOR_SCHEMES.includes(value as ColorScheme) ? (value as ColorScheme) : DEFAULT_COLOR_SCHEME;
}

export function isStashDataKey(key: string): boolean {
  return key === INDEX_KEY || key === LEGACY_STATE_KEY || key.startsWith(DOMAIN_KEY_PREFIX);
}

interface StoredDomain {
  domain: string;
  faviconUrl?: string;
  lastUpdated: number;
  fields: Record<string, FieldHistory>;
}

interface StashIndex {
  domains: Record<string, DomainSummary>;
}

let writeQueue: Promise<void> = Promise.resolve();
let migrationPromise: Promise<void> | undefined;

export async function getSettings(): Promise<InputStashSettings> {
  const raw = await browser.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(raw[SETTINGS_KEY]);
}

export async function saveSettings(settings: Partial<InputStashSettings>): Promise<InputStashSettings> {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...settings });
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  void broadcastSettingsUpdate(next);
  return next;
}

// Content scripts intentionally have no storage.onChanged listener (see the
// v2 layout note above), so settings changes are pushed to open tabs instead.
async function broadcastSettingsUpdate(settings: InputStashSettings): Promise<void> {
  try {
    if (!browser.tabs?.query) return;
    const tabs = await browser.tabs.query({});
    await Promise.allSettled(
      tabs.map((tab) =>
        tab.id === undefined
          ? Promise.resolve()
          : browser.tabs.sendMessage(tab.id, { type: SETTINGS_UPDATED_MESSAGE, settings }),
      ),
    );
  } catch {
    // Tabs without the content script (chrome://, store pages) reject; new
    // page loads fetch fresh settings anyway.
  }
}

export async function listDomainSummaries(): Promise<DomainSummary[]> {
  await migrateIfNeeded();
  const index = await getIndex();
  return Object.values(index.domains)
    .map(normalizeSummary)
    .sort((left, right) => right.lastUpdated - left.lastUpdated);
}

export async function getDomain(domain: string): Promise<DomainHistory | undefined> {
  await migrateIfNeeded();
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) return undefined;

  const key = domainKey(normalizedDomain);
  const raw = await browser.storage.local.get([key, INDEX_KEY]);
  const entry = normalizeIndex(raw[INDEX_KEY]).domains[normalizedDomain];
  const stored = raw[key] ? normalizeStoredDomain(raw[key], normalizedDomain) : undefined;
  if (!stored && !entry) return undefined;

  return {
    domain: normalizedDomain,
    faviconUrl: stored?.faviconUrl || entry?.faviconUrl,
    lastUpdated: stored?.lastUpdated || entry?.lastUpdated || 0,
    iframeDomains: [...(entry?.iframeDomains || [])],
    parentDomains: [...(entry?.parentDomains || [])],
    fields: stored?.fields || {},
  };
}

export async function saveCapture(
  snapshot: CaptureSnapshot,
  sender?: { tab?: { favIconUrl?: string; title?: string; url?: string }; url?: string },
): Promise<void> {
  await enqueueWrite(async () => {
    await migrateIfNeeded();
    const settings = await getSettings();
    const domain = normalizeDomain(snapshot.domain);
    const topDomain = normalizeDomain(
      snapshot.topDomain || domainFromUrl(sender?.tab?.url) || snapshot.referrerDomain || domain,
    );

    if (!domain || isDomainBlocked(domain, settings) || isFieldBlocked(domain, snapshot.fieldKey, settings)) {
      return;
    }

    const value = snapshot.value;
    if (!value) return;

    const key = domainKey(domain);
    const raw = await browser.storage.local.get([key, INDEX_KEY]);
    const stored = normalizeStoredDomain(raw[key], domain);
    const index = normalizeIndex(raw[INDEX_KEY]);
    const now = snapshot.capturedAt || Date.now();

    stored.lastUpdated = now;
    stored.faviconUrl = snapshot.faviconUrl || sender?.tab?.favIconUrl || stored.faviconUrl;

    const field = ensureField(stored, snapshot, sender, now);
    field.lastUpdated = now;
    field.elementId = snapshot.elementId || field.elementId;
    field.label = snapshot.label || field.label;
    field.placeholder = snapshot.placeholder || field.placeholder;
    field.name = snapshot.name || field.name;
    field.inputType = snapshot.inputType || field.inputType;
    field.selector = snapshot.selector || field.selector;
    field.pageUrl = stripUrlQuery(snapshot.url) || field.pageUrl;
    field.pageTitle = snapshot.title || field.pageTitle;
    field.topUrl = stripUrlQuery(sender?.tab?.url || snapshot.topUrl) || field.topUrl;
    field.topTitle = sender?.tab?.title || snapshot.topTitle || field.topTitle;

    const latest = field.records[field.records.length - 1];
    const canCoalesce =
      latest &&
      (latest.sessionId === snapshot.sessionId ||
        latest.draft ||
        latest.reason === 'input' ||
        now - latest.updatedAt <= COALESCE_WINDOW_MS);
    const shouldUpdateLatest =
      canCoalesce && shouldUpdateExistingValue(latest.value, value, settings.identityThreshold);

    if (shouldUpdateLatest) {
      latest.value = value;
      latest.updatedAt = now;
      latest.reason = snapshot.reason;
      latest.draft = snapshot.reason === 'input';
      latest.truncated = snapshot.truncated;
      latest.pageUrl = stripUrlQuery(snapshot.url) || latest.pageUrl;
      latest.pageTitle = snapshot.title || latest.pageTitle;
      latest.topUrl = stripUrlQuery(sender?.tab?.url || snapshot.topUrl) || latest.topUrl;
      latest.topTitle = sender?.tab?.title || snapshot.topTitle || latest.topTitle;
      latest.isFrame = snapshot.isFrame;
    } else if (latest?.value !== value) {
      field.records.push(createRecord(snapshot, sender, now));
    }

    applyHistoryLimit(field, settings.historyLimit);

    const previous = index.domains[domain];
    index.domains[domain] = summarizeStored(stored, previous?.iframeDomains || [], previous?.parentDomains || []);
    updateFrameRelations(index, domain, topDomain, snapshot, now);

    await browser.storage.local.set({ [key]: stored, [INDEX_KEY]: index });
  });
}

export async function deleteRecord(domain: string, fieldKey: string, recordId: string): Promise<void> {
  await enqueueWrite(async () => {
    await migrateIfNeeded();
    const domainName = normalizeDomain(domain);
    const key = domainKey(domainName);
    const raw = await browser.storage.local.get([key, INDEX_KEY]);
    if (!raw[key]) return;

    const stored = normalizeStoredDomain(raw[key], domainName);
    const field = stored.fields[fieldKey];
    if (!field) return;

    field.records = field.records.filter((record) => record.id !== recordId);
    if (field.records.length === 0) {
      delete stored.fields[fieldKey];
    }

    await writeStoredDomain(domainName, stored, normalizeIndex(raw[INDEX_KEY]), false);
  });
}

export async function deleteField(domain: string, fieldKey: string): Promise<void> {
  await deleteFields(domain, [fieldKey]);
}

export async function deleteFields(domain: string, fieldKeys: string[]): Promise<void> {
  if (!fieldKeys.length) return;
  await enqueueWrite(async () => {
    await migrateIfNeeded();
    const domainName = normalizeDomain(domain);
    const key = domainKey(domainName);
    const raw = await browser.storage.local.get([key, INDEX_KEY]);
    if (!raw[key]) return;

    const stored = normalizeStoredDomain(raw[key], domainName);
    for (const fieldKey of fieldKeys) delete stored.fields[fieldKey];
    stored.lastUpdated = newestFieldTime(stored);

    await writeStoredDomain(domainName, stored, normalizeIndex(raw[INDEX_KEY]), true);
  });
}

export async function clearDomain(domain: string): Promise<void> {
  await enqueueWrite(async () => {
    await migrateIfNeeded();
    const normalized = normalizeDomain(domain);
    const index = await getIndex();

    delete index.domains[normalized];
    for (const entry of Object.values(index.domains)) {
      entry.iframeDomains = (entry.iframeDomains || []).filter((item) => item !== normalized);
      entry.parentDomains = (entry.parentDomains || []).filter((item) => item !== normalized);
    }

    await browser.storage.local.set({ [INDEX_KEY]: index });
    await browser.storage.local.remove(domainKey(normalized));
  });
}

export async function clearAll(): Promise<void> {
  await enqueueWrite(async () => {
    const everything = await browser.storage.local.get(null);
    const keys = Object.keys(everything).filter(isStashDataKey);
    if (keys.length) await browser.storage.local.remove(keys);
    migrationPromise = Promise.resolve();
  });
}

export function bestFieldName(field: FieldHistory): string {
  return field.label || field.placeholder || field.name || field.elementId || 'No label';
}

export function isDomainBlocked(domain: string, settings: InputStashSettings): boolean {
  const normalized = normalizeDomain(domain);
  return settings.blockedDomains.some((blocked) => normalizeDomain(blocked) === normalized);
}

export function isFieldBlocked(
  domain: string,
  fieldKey: string,
  settings: InputStashSettings,
): boolean {
  return (settings.blockedFields[normalizeDomain(domain)] || []).includes(fieldKey);
}

export function normalizeDomain(domain: string | undefined): string {
  if (!domain) return '';
  const value = domain.trim().toLowerCase();
  if (!value) return '';
  if (!value.includes('://')) return value.replace(/\/.*$/, '');
  return domainFromUrl(value);
}

export function domainFromUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return (parsed.hostname || parsed.protocol.replace(':', '')).toLowerCase();
  } catch {
    return '';
  }
}

export function stripUrlQuery(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function domainKey(domain: string): string {
  return `${DOMAIN_KEY_PREFIX}${domain}`;
}

async function getIndex(): Promise<StashIndex> {
  const raw = await browser.storage.local.get(INDEX_KEY);
  return normalizeIndex(raw[INDEX_KEY]);
}

// Applies a mutated stored domain: drops the key and index entry when the
// last field is gone, otherwise persists both in one write.
async function writeStoredDomain(
  domain: string,
  stored: StoredDomain,
  index: StashIndex,
  refreshLastUpdated: boolean,
): Promise<void> {
  const key = domainKey(domain);

  if (Object.keys(stored.fields).length === 0) {
    delete index.domains[domain];
    await browser.storage.local.set({ [INDEX_KEY]: index });
    await browser.storage.local.remove(key);
    return;
  }

  const previous = index.domains[domain];
  const summary = summarizeStored(stored, previous?.iframeDomains || [], previous?.parentDomains || []);
  if (!refreshLastUpdated && previous) summary.lastUpdated = previous.lastUpdated;
  index.domains[domain] = summary;

  await browser.storage.local.set({ [key]: stored, [INDEX_KEY]: index });
}

export function migrateIfNeeded(): Promise<void> {
  migrationPromise ||= migrateLegacyState().catch((error) => {
    migrationPromise = undefined;
    throw error;
  });
  return migrationPromise;
}

async function migrateLegacyState(): Promise<void> {
  const raw = await browser.storage.local.get([LEGACY_STATE_KEY, INDEX_KEY]);
  const legacy = raw[LEGACY_STATE_KEY] as Partial<StashState> | undefined;
  if (!legacy?.domains || typeof legacy.domains !== 'object') return;

  const index = normalizeIndex(raw[INDEX_KEY]);
  const payload: Record<string, unknown> = {};

  for (const [rawDomain, domainData] of Object.entries(legacy.domains)) {
    if (!domainData || typeof domainData !== 'object') continue;
    const domain = normalizeDomain(rawDomain) || rawDomain;
    const existing = index.domains[domain];
    // A v2 entry can already exist if a previous migration attempt was
    // interrupted after writing; never overwrite newer v2 data with v1 data.
    if (existing && existing.lastUpdated >= (domainData.lastUpdated || 0)) continue;

    const stored: StoredDomain = {
      domain,
      faviconUrl: domainData.faviconUrl,
      lastUpdated: domainData.lastUpdated || 0,
      fields: domainData.fields || {},
    };

    if (Object.keys(stored.fields).length > 0) payload[domainKey(domain)] = stored;
    index.domains[domain] = summarizeStored(
      stored,
      domainData.iframeDomains || [],
      domainData.parentDomains || [],
    );
  }

  payload[INDEX_KEY] = index;
  await browser.storage.local.set(payload);
  await browser.storage.local.remove(LEGACY_STATE_KEY);
}

async function enqueueWrite(operation: () => Promise<void>): Promise<void> {
  writeQueue = writeQueue.then(operation, operation);
  return writeQueue;
}

function normalizeSettings(raw: unknown): InputStashSettings {
  const settings = raw as Partial<InputStashSettings> | undefined;
  const historyLimit = Number(settings?.historyLimit ?? DEFAULT_HISTORY_LIMIT);
  const identityThreshold = Number(settings?.identityThreshold ?? DEFAULT_IDENTITY_THRESHOLD);
  const blockedFields: Record<string, string[]> = {};

  for (const [domain, fields] of Object.entries(settings?.blockedFields || {})) {
    blockedFields[normalizeDomain(domain)] = Array.isArray(fields) ? [...new Set(fields)] : [];
  }

  return {
    historyLimit: Number.isFinite(historyLimit) && historyLimit >= 0 ? Math.floor(historyLimit) : DEFAULT_HISTORY_LIMIT,
    identityThreshold:
      Number.isFinite(identityThreshold) && identityThreshold >= 0
        ? Math.min(100, Math.floor(identityThreshold))
        : DEFAULT_IDENTITY_THRESHOLD,
    blockedDomains: [...new Set((settings?.blockedDomains || []).map(normalizeDomain).filter(Boolean))].sort(),
    blockedFields,
    colorScheme: normalizeColorScheme(settings?.colorScheme),
  };
}

function normalizeIndex(raw: unknown): StashIndex {
  const index = raw as Partial<StashIndex> | undefined;
  if (!index?.domains || typeof index.domains !== 'object') return { domains: {} };
  return { domains: index.domains as Record<string, DomainSummary> };
}

function normalizeStoredDomain(raw: unknown, domain: string): StoredDomain {
  const stored = raw as Partial<StoredDomain> | undefined;
  return {
    domain,
    faviconUrl: stored?.faviconUrl,
    lastUpdated: stored?.lastUpdated || 0,
    fields: stored?.fields && typeof stored.fields === 'object' ? stored.fields : {},
  };
}

function normalizeSummary(entry: DomainSummary): DomainSummary {
  return {
    domain: entry.domain,
    faviconUrl: entry.faviconUrl,
    lastUpdated: entry.lastUpdated || 0,
    fieldCount: entry.fieldCount || 0,
    recordCount: entry.recordCount || 0,
    iframeDomains: entry.iframeDomains || [],
    parentDomains: entry.parentDomains || [],
  };
}

function summarizeStored(stored: StoredDomain, iframeDomains: string[], parentDomains: string[]): DomainSummary {
  const fields = Object.values(stored.fields);
  return {
    domain: stored.domain,
    faviconUrl: stored.faviconUrl,
    lastUpdated: stored.lastUpdated,
    fieldCount: fields.length,
    recordCount: fields.reduce((sum, field) => sum + field.records.length, 0),
    iframeDomains,
    parentDomains,
  };
}

function ensureField(
  stored: StoredDomain,
  snapshot: CaptureSnapshot,
  sender: { tab?: { title?: string; url?: string } } | undefined,
  timestamp: number,
): FieldHistory {
  stored.fields[snapshot.fieldKey] ||= {
    fieldKey: snapshot.fieldKey,
    elementId: snapshot.elementId,
    label: snapshot.label,
    placeholder: snapshot.placeholder,
    name: snapshot.name,
    inputType: snapshot.inputType,
    selector: snapshot.selector,
    lastUpdated: timestamp,
    pageUrl: stripUrlQuery(snapshot.url) || '',
    pageTitle: snapshot.title,
    topUrl: stripUrlQuery(sender?.tab?.url || snapshot.topUrl),
    topTitle: sender?.tab?.title || snapshot.topTitle,
    records: [],
  };
  return stored.fields[snapshot.fieldKey];
}

function createRecord(
  snapshot: CaptureSnapshot,
  sender: { tab?: { title?: string; url?: string } } | undefined,
  timestamp: number,
): StashRecord {
  return {
    id: `${timestamp}-${Math.random().toString(36).slice(2, 10)}`,
    value: snapshot.value,
    createdAt: timestamp,
    updatedAt: timestamp,
    reason: snapshot.reason,
    sessionId: snapshot.sessionId,
    draft: snapshot.reason === 'input',
    truncated: snapshot.truncated,
    pageUrl: stripUrlQuery(snapshot.url) || '',
    pageTitle: snapshot.title,
    topUrl: stripUrlQuery(sender?.tab?.url || snapshot.topUrl),
    topTitle: sender?.tab?.title || snapshot.topTitle,
    isFrame: snapshot.isFrame,
  };
}

function applyHistoryLimit(field: FieldHistory, historyLimit: number): void {
  if (historyLimit === 0 || field.records.length <= historyLimit) return;
  field.records = field.records.slice(field.records.length - historyLimit);
}

// Frame relations live only in the index, so an iframe capture never has to
// read or write the parent domain's (potentially large) record data.
function updateFrameRelations(
  index: StashIndex,
  domain: string,
  topDomain: string,
  snapshot: CaptureSnapshot,
  timestamp: number,
): void {
  const relatedDomains = [...snapshot.ancestorDomains, snapshot.referrerDomain, topDomain]
    .map(normalizeDomain)
    .filter((item) => item && item !== domain);

  if (!relatedDomains.length) return;

  const child = ensureIndexEntry(index, domain, timestamp);
  for (const parentDomain of relatedDomains) {
    const parent = ensureIndexEntry(index, parentDomain, timestamp);
    parent.lastUpdated = Math.max(parent.lastUpdated, timestamp);
    parent.iframeDomains = uniqueSorted([...parent.iframeDomains, domain]);
    child.parentDomains = uniqueSorted([...child.parentDomains, parentDomain]);
  }
}

function ensureIndexEntry(index: StashIndex, domain: string, timestamp: number): DomainSummary {
  index.domains[domain] ||= {
    domain,
    lastUpdated: timestamp,
    fieldCount: 0,
    recordCount: 0,
    iframeDomains: [],
    parentDomains: [],
  };
  return index.domains[domain];
}

function newestFieldTime(stored: StoredDomain): number {
  return Object.values(stored.fields).reduce((latest, field) => Math.max(latest, field.lastUpdated), 0);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}
