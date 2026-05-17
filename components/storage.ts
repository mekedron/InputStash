import type {
  CaptureSnapshot,
  DomainHistory,
  DomainSummary,
  FieldHistory,
  InputStashSettings,
  StashRecord,
  StashState,
} from './types';
import { shouldUpdateExistingValue } from './textSimilarity';

export const STATE_KEY = 'inputstash:domains:v1';
export const SETTINGS_KEY = 'inputstash:settings:v1';
export const DEFAULT_HISTORY_LIMIT = 20;
export const DEFAULT_IDENTITY_THRESHOLD = 50;
const COALESCE_WINDOW_MS = 45_000;

export const DEFAULT_SETTINGS: InputStashSettings = {
  historyLimit: DEFAULT_HISTORY_LIMIT,
  identityThreshold: DEFAULT_IDENTITY_THRESHOLD,
  blockedDomains: [],
  blockedFields: {},
};

const EMPTY_STATE: StashState = { domains: {} };

let writeQueue: Promise<void> = Promise.resolve();

export async function getSettings(): Promise<InputStashSettings> {
  const raw = await browser.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(raw[SETTINGS_KEY]);
}

export async function saveSettings(settings: Partial<InputStashSettings>): Promise<InputStashSettings> {
  const current = await getSettings();
  const next = normalizeSettings({ ...current, ...settings });
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function listDomainSummaries(): Promise<DomainSummary[]> {
  const state = await getState();
  return Object.values(state.domains)
    .map((domain) => {
      const fields = Object.values(domain.fields);
      return {
        domain: domain.domain,
        faviconUrl: domain.faviconUrl,
        lastUpdated: domain.lastUpdated,
        fieldCount: fields.length,
        recordCount: fields.reduce((sum, field) => sum + field.records.length, 0),
        iframeDomains: [...domain.iframeDomains].sort(),
        parentDomains: [...domain.parentDomains].sort(),
      };
    })
    .sort((left, right) => right.lastUpdated - left.lastUpdated);
}

export async function getDomain(domain: string): Promise<DomainHistory | undefined> {
  const state = await getState();
  const normalizedDomain = normalizeDomain(domain);
  const domainData = state.domains[normalizedDomain];
  return domainData ? cloneDomain(domainData) : undefined;
}

export async function saveCapture(
  snapshot: CaptureSnapshot,
  sender?: { tab?: { favIconUrl?: string; title?: string; url?: string }; url?: string },
): Promise<void> {
  await enqueueWrite(async () => {
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

    const state = await getState();
    const now = snapshot.capturedAt || Date.now();
    const domainData = ensureDomain(state, domain, now);
    const field = ensureField(domainData, snapshot, sender, now);

    domainData.lastUpdated = now;
    domainData.faviconUrl = snapshot.faviconUrl || sender?.tab?.favIconUrl || domainData.faviconUrl;
    field.lastUpdated = now;
    field.elementId = snapshot.elementId || field.elementId;
    field.label = snapshot.label || field.label;
    field.placeholder = snapshot.placeholder || field.placeholder;
    field.name = snapshot.name || field.name;
    field.inputType = snapshot.inputType || field.inputType;
    field.selector = snapshot.selector || field.selector;
    field.pageUrl = snapshot.url || field.pageUrl;
    field.pageTitle = snapshot.title || field.pageTitle;
    field.topUrl = sender?.tab?.url || snapshot.topUrl || field.topUrl;
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
      latest.pageUrl = snapshot.url;
      latest.pageTitle = snapshot.title || latest.pageTitle;
      latest.topUrl = sender?.tab?.url || snapshot.topUrl || latest.topUrl;
      latest.topTitle = sender?.tab?.title || snapshot.topTitle || latest.topTitle;
      latest.isFrame = snapshot.isFrame;
    } else if (latest?.value !== value) {
      field.records.push(createRecord(snapshot, sender, now));
    }

    applyHistoryLimit(field, settings.historyLimit);
    updateFrameRelations(state, domain, topDomain, snapshot, now);

    await setState(state);
  });
}

export async function deleteRecord(domain: string, fieldKey: string, recordId: string): Promise<void> {
  await enqueueWrite(async () => {
    const state = await getState();
    const domainKey = normalizeDomain(domain);
    const domainData = state.domains[domainKey];
    const field = domainData?.fields[fieldKey];
    if (!field) return;
    field.records = field.records.filter((record) => record.id !== recordId);
    if (field.records.length === 0) {
      delete domainData.fields[fieldKey];
    }
    if (domainData && Object.keys(domainData.fields).length === 0) {
      delete state.domains[domainKey];
    }
    await setState(state);
  });
}

export async function deleteField(domain: string, fieldKey: string): Promise<void> {
  await enqueueWrite(async () => {
    const state = await getState();
    const domainData = state.domains[normalizeDomain(domain)];
    if (!domainData) return;
    delete domainData.fields[fieldKey];
    if (Object.keys(domainData.fields).length === 0) {
      delete state.domains[normalizeDomain(domain)];
      await setState(state);
      return;
    }
    domainData.lastUpdated = newestFieldTime(domainData);
    await setState(state);
  });
}

export async function clearDomain(domain: string): Promise<void> {
  await enqueueWrite(async () => {
    const state = await getState();
    delete state.domains[normalizeDomain(domain)];
    const normalized = normalizeDomain(domain);
    for (const domainData of Object.values(state.domains)) {
      domainData.iframeDomains = domainData.iframeDomains.filter((item) => item !== normalized);
      domainData.parentDomains = domainData.parentDomains.filter((item) => item !== normalized);
    }
    await setState(state);
  });
}

export async function clearAll(): Promise<void> {
  await enqueueWrite(async () => {
    await browser.storage.local.set({ [STATE_KEY]: EMPTY_STATE });
  });
}

export function bestFieldName(field: FieldHistory): string {
  return field.label || field.placeholder || field.name || field.elementId || field.inputType || 'Unknown field';
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

async function getState(): Promise<StashState> {
  const raw = await browser.storage.local.get(STATE_KEY);
  return normalizeState(raw[STATE_KEY]);
}

async function setState(state: StashState): Promise<void> {
  await browser.storage.local.set({ [STATE_KEY]: state });
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
  };
}

function normalizeState(raw: unknown): StashState {
  const state = raw as Partial<StashState> | undefined;
  if (!state?.domains || typeof state.domains !== 'object') return { domains: {} };
  return { domains: state.domains as Record<string, DomainHistory> };
}

function ensureDomain(state: StashState, domain: string, timestamp: number): DomainHistory {
  state.domains[domain] ||= {
    domain,
    lastUpdated: timestamp,
    iframeDomains: [],
    parentDomains: [],
    fields: {},
  };
  return state.domains[domain];
}

function ensureField(
  domainData: DomainHistory,
  snapshot: CaptureSnapshot,
  sender: { tab?: { title?: string; url?: string } } | undefined,
  timestamp: number,
): FieldHistory {
  domainData.fields[snapshot.fieldKey] ||= {
    fieldKey: snapshot.fieldKey,
    elementId: snapshot.elementId,
    label: snapshot.label,
    placeholder: snapshot.placeholder,
    name: snapshot.name,
    inputType: snapshot.inputType,
    selector: snapshot.selector,
    lastUpdated: timestamp,
    pageUrl: snapshot.url,
    pageTitle: snapshot.title,
    topUrl: sender?.tab?.url || snapshot.topUrl,
    topTitle: sender?.tab?.title || snapshot.topTitle,
    records: [],
  };
  return domainData.fields[snapshot.fieldKey];
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
    pageUrl: snapshot.url,
    pageTitle: snapshot.title,
    topUrl: sender?.tab?.url || snapshot.topUrl,
    topTitle: sender?.tab?.title || snapshot.topTitle,
    isFrame: snapshot.isFrame,
  };
}

function applyHistoryLimit(field: FieldHistory, historyLimit: number): void {
  if (historyLimit === 0 || field.records.length <= historyLimit) return;
  field.records = field.records.slice(field.records.length - historyLimit);
}

function updateFrameRelations(
  state: StashState,
  domain: string,
  topDomain: string,
  snapshot: CaptureSnapshot,
  timestamp: number,
): void {
  const relatedDomains = [...snapshot.ancestorDomains, snapshot.referrerDomain, topDomain]
    .map(normalizeDomain)
    .filter((item) => item && item !== domain);

  for (const parentDomain of relatedDomains) {
    const parent = ensureDomain(state, parentDomain, timestamp);
    parent.lastUpdated = Math.max(parent.lastUpdated, timestamp);
    parent.iframeDomains = uniqueSorted([...parent.iframeDomains, domain]);

    const child = ensureDomain(state, domain, timestamp);
    child.parentDomains = uniqueSorted([...child.parentDomains, parentDomain]);
  }
}

function newestFieldTime(domainData: DomainHistory): number {
  return Object.values(domainData.fields).reduce((latest, field) => Math.max(latest, field.lastUpdated), 0);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function cloneDomain(domain: DomainHistory): DomainHistory {
  return {
    ...domain,
    iframeDomains: [...domain.iframeDomains],
    parentDomains: [...domain.parentDomains],
    fields: Object.fromEntries(
      Object.entries(domain.fields).map(([fieldKey, field]) => [
        fieldKey,
        { ...field, records: field.records.map((record) => ({ ...record })) },
      ]),
    ),
  };
}
