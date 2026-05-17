import { bestFieldName } from './storage';
import type { FieldHistory, InputStashSettings, StashRecord } from './types';

export function normalizePopupSettings(raw: unknown): InputStashSettings {
  const value = raw as Partial<InputStashSettings>;
  return {
    historyLimit: Number(value?.historyLimit ?? 20),
    identityThreshold: Number(value?.identityThreshold ?? 50),
    blockedDomains: value?.blockedDomains || [],
    blockedFields: value?.blockedFields || {},
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

export function preview(value: string, max = 140): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Empty value';
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
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
  return (domain.trim()[0] || '?').toUpperCase();
}

export function hideBrokenIcon(event: Event): void {
  if (event.currentTarget instanceof HTMLImageElement) event.currentTarget.hidden = true;
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
