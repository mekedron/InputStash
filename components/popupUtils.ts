import { bestFieldName, normalizeColorScheme } from './storage';
import type { FieldHistory, InputStashSettings, MergedField, MergedRecord, StashRecord } from './types';

export function normalizePopupSettings(raw: unknown): InputStashSettings {
  const value = raw as Partial<InputStashSettings>;
  return {
    historyLimit: Number(value?.historyLimit ?? 20),
    identityThreshold: Number(value?.identityThreshold ?? 50),
    blockedDomains: value?.blockedDomains || [],
    blockedFields: value?.blockedFields || {},
    colorScheme: normalizeColorScheme(value?.colorScheme),
  };
}

export function formatTime(timestamp: number): string {
  if (!timestamp) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  }).format(new Date(timestamp));
}

export function previewParts(value: string, max = 140): { full: string; short: string; truncated: boolean } {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return { full: 'Empty value', short: 'Empty value', truncated: false };
  if (normalized.length <= max) return { full: normalized, short: normalized, truncated: false };
  return { full: normalized, short: `${normalized.slice(0, max - 1)}...`, truncated: true };
}

export function fieldMatchesFilter(field: FieldHistory, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return fieldSearchText(field).includes(normalizedQuery);
}

export function visibleRecords(field: FieldHistory, query: string): StashRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery || metadataSearchText(field).includes(normalizedQuery)) return [...field.records].reverse();
  return [...field.records].reverse().filter((record) => recordSearchText(record).includes(normalizedQuery));
}

export function listFields(entries: Record<string, string[]>): Array<{ domain: string; fieldKey: string }> {
  return Object.entries(entries).flatMap(([domain, fieldKeys]) => fieldKeys.map((fieldKey) => ({ domain, fieldKey })));
}

export function domainInitial(domain: string): string {
  const letters = domain.trim().replace(/^www\./, '').match(/[a-z0-9]/gi) || [];
  return letters.slice(0, 2).join('').toUpperCase() || '?';
}

export function mergeFields(fields: FieldHistory[]): MergedField[] {
  const buckets = new Map<string, FieldHistory[]>();
  for (const field of fields) {
    const identity = fieldIdentity(field);
    const bucket = buckets.get(identity);
    if (bucket) bucket.push(field);
    else buckets.set(identity, [field]);
  }

  const merged: MergedField[] = [];
  for (const [identity, members] of buckets) {
    members.sort((a, b) => b.lastUpdated - a.lastUpdated);
    const records: MergedRecord[] = members
      .flatMap((m) => m.records.map((r) => ({ ...r, fieldKey: m.fieldKey })))
      .sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt));

    const head = members[0];
    merged.push({
      identity,
      displayName: bestFieldName(head),
      inputType: head.inputType,
      lastUpdated: head.lastUpdated,
      members,
      fieldKeys: members.map((m) => m.fieldKey),
      records,
      recordCount: records.length,
      latest: records[0],
      pageUrl: head.pageUrl,
      pageTitle: head.pageTitle,
      allBlocked: false,
    });
  }

  return merged.sort((a, b) => b.lastUpdated - a.lastUpdated);
}

export function mergedMatchesFilter(merged: MergedField, query: string): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;
  return mergedSearchText(merged).includes(normalizedQuery);
}

export function mergedVisibleRecords(merged: MergedField, query: string): MergedRecord[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery || mergedMetadataText(merged).includes(normalizedQuery)) return merged.records;
  return merged.records.filter((record) => recordSearchText(record).includes(normalizedQuery));
}

function normLabel(value: string | undefined): string {
  return (value || '').replace(/\s+/g, ' ').replace(/[*:•·]+$/u, '').trim().toLowerCase();
}

function fieldIdentity(field: FieldHistory): string {
  const name = normLabel(field.label) || normLabel(field.name) || normLabel(field.placeholder);
  return name ? `named:${name}` : `anon:${field.fieldKey}`;
}

function mergedMetadataText(merged: MergedField): string {
  return merged.members.map(metadataSearchText).join(' ');
}

function mergedSearchText(merged: MergedField): string {
  return `${mergedMetadataText(merged)} ${merged.records.map(recordSearchText).join(' ')}`;
}

function fieldSearchText(field: FieldHistory): string {
  return `${metadataSearchText(field)} ${field.records.map(recordSearchText).join(' ')}`.toLowerCase();
}

function metadataSearchText(field: FieldHistory): string {
  return [
    bestFieldName(field),
    field.label,
    field.placeholder,
    field.name,
    field.elementId,
    field.fieldKey,
    field.inputType,
    field.pageTitle,
    field.pageUrl,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function recordSearchText(record: StashRecord): string {
  return [record.value, record.pageTitle, record.pageUrl].filter(Boolean).join(' ').toLowerCase();
}
