import type { CaptureSnapshot } from './types';

type PageMetadata = Omit<
  CaptureSnapshot,
  'capturedAt' | 'domain' | 'fieldKey' | 'inputType' | 'reason' | 'sessionId' | 'truncated' | 'value'
>;

interface FrameConstants {
  ancestorDomains: string[];
  referrerDomain: string;
  isFrame: boolean;
}

// Referrer, ancestor origins and frame-ness cannot change for the lifetime of
// a document, so they are computed once instead of on every capture.
let frameConstants: FrameConstants | undefined;

function getFrameConstants(): FrameConstants {
  frameConstants ??= {
    ancestorDomains: ancestorDomains(),
    referrerDomain: metadataDomainFromUrl(document.referrer),
    isFrame: isFrame(),
  };
  return frameConstants;
}

export function getPageMetadata(cachedFaviconUrl?: string): PageMetadata {
  const { ancestorDomains: ancestors, referrerDomain, isFrame } = getFrameConstants();
  const top = readableTopPage();

  return {
    url: location.href,
    title: document.title,
    faviconUrl: cachedFaviconUrl ?? findFaviconUrl(),
    topDomain: top.domain || ancestors[ancestors.length - 1] || referrerDomain,
    topUrl: top.url,
    topTitle: top.title,
    ancestorDomains: ancestors,
    referrerDomain,
    isFrame,
  };
}

export function metadataDomainFromUrl(url: string | undefined): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return normalizeMetadataDomain(parsed.hostname || parsed.protocol.replace(':', ''));
  } catch {
    return '';
  }
}

export function normalizeMetadataDomain(domain: string | undefined): string {
  return (domain || '').trim().toLowerCase().replace(/\/.*$/, '');
}

function readableTopPage(): { domain?: string; title?: string; url?: string } {
  try {
    if (window.top && window.top.location) {
      return {
        domain: metadataDomainFromUrl(window.top.location.href),
        title: window.top.document?.title,
        url: window.top.location.href,
      };
    }
  } catch {
    return {};
  }
  return {};
}

function ancestorDomains(): string[] {
  const origins = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  if (!origins) return [];
  return Array.from(origins).map(metadataDomainFromUrl).filter(Boolean);
}

function isFrame(): boolean {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

export function findFaviconUrl(): string | undefined {
  const selectors = [
    'link[rel~="icon"][href]',
    'link[rel="shortcut icon"][href]',
    'link[rel="apple-touch-icon"][href]',
    'link[rel="mask-icon"][href]',
  ];

  for (const selector of selectors) {
    const link = document.querySelector<HTMLLinkElement>(selector);
    if (link?.href) return link.href;
  }

  try {
    return new URL('/favicon.ico', location.origin).href;
  } catch {
    return undefined;
  }
}
