export type CaptureReason = 'input' | 'change' | 'blur' | 'submit';

export interface InputStashSettings {
  historyLimit: number;
  identityThreshold: number;
  blockedDomains: string[];
  blockedFields: Record<string, string[]>;
  allowedDomains: string[];
  allowedFields: Record<string, string[]>;
}

export interface CaptureSnapshot {
  domain: string;
  url: string;
  title?: string;
  faviconUrl?: string;
  topDomain?: string;
  topUrl?: string;
  topTitle?: string;
  ancestorDomains: string[];
  referrerDomain?: string;
  isFrame: boolean;
  fieldKey: string;
  elementId?: string;
  label?: string;
  placeholder?: string;
  name?: string;
  inputType: string;
  selector?: string;
  value: string;
  truncated: boolean;
  reason: CaptureReason;
  sessionId: string;
  capturedAt: number;
}

export interface StashRecord {
  id: string;
  value: string;
  createdAt: number;
  updatedAt: number;
  reason: CaptureReason;
  sessionId: string;
  draft: boolean;
  truncated: boolean;
  pageUrl: string;
  pageTitle?: string;
  topUrl?: string;
  topTitle?: string;
  isFrame: boolean;
}

export interface FieldHistory {
  fieldKey: string;
  elementId?: string;
  label?: string;
  placeholder?: string;
  name?: string;
  inputType: string;
  selector?: string;
  lastUpdated: number;
  pageUrl: string;
  pageTitle?: string;
  topUrl?: string;
  topTitle?: string;
  records: StashRecord[];
}

export interface DomainHistory {
  domain: string;
  faviconUrl?: string;
  lastUpdated: number;
  iframeDomains: string[];
  parentDomains: string[];
  fields: Record<string, FieldHistory>;
}

export interface StashState {
  domains: Record<string, DomainHistory>;
}

export interface DomainSummary {
  domain: string;
  faviconUrl?: string;
  lastUpdated: number;
  fieldCount: number;
  recordCount: number;
  iframeDomains: string[];
  parentDomains: string[];
}

export interface CaptureMessage {
  type: 'inputstash:capture';
  snapshot: CaptureSnapshot;
}

export interface GetSettingsMessage {
  type: 'inputstash:get-settings';
}

export type InputStashMessage = CaptureMessage | GetSettingsMessage;
