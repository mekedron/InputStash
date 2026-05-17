import { getPageMetadata, metadataDomainFromUrl, normalizeMetadataDomain } from '../components/pageMetadata';
import { hasSensitiveAutocomplete, looksSensitiveFieldText } from '../components/privacy';
import type { CaptureReason, CaptureSnapshot, InputStashSettings } from '../components/types';

const SETTINGS_KEY = 'inputstash:settings:v1';
const DEBOUNCE_MS = 100;
const SHADOW_SCAN_MS = 5000;
const MAX_VALUE_CHARS = 50000;

const DEFAULT_SETTINGS: InputStashSettings = {
  historyLimit: 20,
  identityThreshold: 50,
  blockedDomains: [],
  blockedFields: {},
  colorScheme: 'auto',
};

interface ElementSession {
  sessionId: string;
  timer?: number;
  finalized: boolean;
  lastReason?: CaptureReason;
  lastValue?: string;
}

type EditableElement = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement;

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchAboutBlank: true,
  matchOriginAsFallback: {
    chrome: true,
    firefox: false,
  },
  runAt: 'document_start',
  noScriptStartedPostMessage: true,
  main(ctx) {
    const sessions = new WeakMap<Element, ElementSession>();
    const observedRoots = new WeakSet<Document | ShadowRoot>();
    const observers: MutationObserver[] = [];
    const cleanup: Array<() => void> = [];
    let settings = DEFAULT_SETTINGS;

    void refreshSettings();

    const settingsListener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local' || !changes[SETTINGS_KEY]?.newValue) return;
      settings = normalizeSettings(changes[SETTINGS_KEY].newValue);
    };

    browser.storage.onChanged.addListener(settingsListener);
    cleanup.push(() => browser.storage.onChanged.removeListener(settingsListener));

    observeRoot(document);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => scanNode(document), { once: true });
    } else {
      scanNode(document);
    }

    const shadowInterval = window.setInterval(() => scanNode(document), SHADOW_SCAN_MS);
    cleanup.push(() => window.clearInterval(shadowInterval));

    ctx.onInvalidated(() => {
      for (const observer of observers) observer.disconnect();
      for (const remove of cleanup) remove();
    });

    function observeRoot(root: Document | ShadowRoot): void {
      if (observedRoots.has(root)) return;
      observedRoots.add(root);

      root.addEventListener('input', handleInput, true);
      root.addEventListener('change', handleChange, true);
      root.addEventListener('focusin', handleFocusIn, true);
      root.addEventListener('blur', handleBlur, true);
      root.addEventListener('submit', handleSubmit, true);

      cleanup.push(() => {
        root.removeEventListener('input', handleInput, true);
        root.removeEventListener('change', handleChange, true);
        root.removeEventListener('focusin', handleFocusIn, true);
        root.removeEventListener('blur', handleBlur, true);
        root.removeEventListener('submit', handleSubmit, true);
      });

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) scanNode(node);
        }
      });

      observer.observe(root, { childList: true, subtree: true });
      observers.push(observer);
      scanNode(root);
    }

    function handleFocusIn(event: Event): void {
      const target = findEditableTarget(event);
      if (!target) return;
      const current = sessions.get(target);
      if (!current || current.finalized) sessions.set(target, createSession());
    }

    function handleInput(event: Event): void {
      const target = findEditableTarget(event);
      if (target) queueCapture(target, 'input', DEBOUNCE_MS);
    }

    function handleChange(event: Event): void {
      const target = findEditableTarget(event);
      if (target) queueCapture(target, 'change', 0);
    }

    function handleBlur(event: Event): void {
      const target = findEditableTarget(event);
      if (target) queueCapture(target, 'blur', 0);
    }

    function handleSubmit(event: Event): void {
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      const active = getDeepActiveElement();
      const target = active ? editableFromElement(active) : null;
      if (target && (!form || !('form' in target) || target.form === form)) {
        queueCapture(target, 'submit', 0);
      }
    }

    function queueCapture(target: EditableElement, reason: CaptureReason, delay: number): void {
      const session = getSession(target, reason);
      if (session.timer) window.clearTimeout(session.timer);

      session.timer = window.setTimeout(() => {
        session.timer = undefined;
        const snapshot = createSnapshot(target, reason, session.sessionId);
        if (!snapshot) return;

        const shouldSend = session.lastValue !== snapshot.value || session.lastReason !== reason;
        session.lastValue = snapshot.value;
        session.lastReason = reason;
        if (reason !== 'input') session.finalized = true;
        if (shouldSend) void sendSnapshot(snapshot);
      }, delay);
    }

    function getSession(target: Element, reason: CaptureReason): ElementSession {
      const current = sessions.get(target);
      if (current && (!current.finalized || reason !== 'input')) return current;
      const next = createSession();
      sessions.set(target, next);
      return next;
    }

    function createSnapshot(
      target: EditableElement,
      reason: CaptureReason,
      sessionId: string,
    ): CaptureSnapshot | undefined {
      const valueResult = readValue(target);
      if (!valueResult.value.trim()) return undefined;

      const domain = effectiveDomain();
      if (!domain || isBlockedDomain(domain, settings)) return undefined;

      const fieldKey = getFieldKey(target);
      if (isBlockedField(domain, fieldKey, settings)) return undefined;
      if (isHardSensitiveTarget(target)) return undefined;
      if (isSoftSensitiveTarget(target)) return undefined;

      const label = getElementLabel(target);
      const metadata = getPageMetadata();

      return {
        ...metadata,
        domain,
        fieldKey,
        elementId: target.id || undefined,
        label,
        placeholder: 'placeholder' in target ? cleanText(target.placeholder) : undefined,
        name: 'name' in target ? cleanText(target.name) : undefined,
        inputType: getInputType(target),
        selector: getElementPath(target),
        value: valueResult.value,
        truncated: valueResult.truncated,
        reason,
        sessionId,
        capturedAt: Date.now(),
      };
    }

    async function sendSnapshot(snapshot: CaptureSnapshot): Promise<void> {
      try {
        await browser.runtime.sendMessage({ type: 'inputstash:capture', snapshot });
      } catch {
        // Extension reloads can briefly invalidate the background connection.
      }
    }

    async function refreshSettings(): Promise<void> {
      try {
        const response = await browser.runtime.sendMessage({ type: 'inputstash:get-settings' });
        settings = normalizeSettings(response?.settings);
      } catch {
        settings = DEFAULT_SETTINGS;
      }
    }

    function scanNode(node: Node): void {
      if (node instanceof Element && node.shadowRoot) observeRoot(node.shadowRoot);
      if (!(node instanceof Element || node instanceof Document || node instanceof ShadowRoot)) return;

      const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const element = walker.currentNode;
        if (element instanceof Element && element.shadowRoot) observeRoot(element.shadowRoot);
      }
    }

    function findEditableTarget(event: Event): EditableElement | undefined {
      for (const item of event.composedPath()) {
        if (item instanceof Element) {
          const target = editableFromElement(item);
          if (target) return target;
        }
      }
      return event.target instanceof Element ? editableFromElement(event.target) : undefined;
    }
  },
});

function editableFromElement(element: Element): EditableElement | undefined {
  if (element instanceof HTMLInputElement && isSupportedInput(element)) return element;
  if (element instanceof HTMLTextAreaElement) return element;
  if (element instanceof HTMLSelectElement) return element;

  if (element instanceof HTMLElement && element.isContentEditable) {
    return closestEditableRoot(element);
  }

  const editable = element.closest('[contenteditable="true"], [contenteditable="plaintext-only"], [contenteditable=""]');
  return editable instanceof HTMLElement ? editable : undefined;
}

function isSupportedInput(input: HTMLInputElement): boolean {
  const type = (input.type || 'text').toLowerCase();
  return [
    'date',
    'datetime-local',
    'email',
    'month',
    'number',
    'search',
    'tel',
    'text',
    'time',
    'url',
    'week',
  ].includes(type);
}

function closestEditableRoot(element: HTMLElement): HTMLElement {
  let root = element;
  let current = element.parentElement;
  while (current instanceof HTMLElement && current.isContentEditable) {
    if (current.hasAttribute('contenteditable')) root = current;
    current = current.parentElement;
  }
  return root;
}

function readValue(target: EditableElement): { value: string; truncated: boolean } {
  const raw =
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
      ? target.value
      : target.innerText || target.textContent || '';
  const normalized = raw.replace(/\u00a0/g, ' ');
  if (normalized.length <= MAX_VALUE_CHARS) return { value: normalized, truncated: false };
  return { value: normalized.slice(0, MAX_VALUE_CHARS), truncated: true };
}

function getInputType(target: EditableElement): string {
  if (target instanceof HTMLInputElement) return target.type || 'text';
  if (target instanceof HTMLTextAreaElement) return 'textarea';
  if (target instanceof HTMLSelectElement) return 'select';
  return target.getAttribute('role') || 'contenteditable';
}

function isHardSensitiveTarget(target: EditableElement): boolean {
  if (target instanceof HTMLInputElement) {
    const type = (target.type || 'text').toLowerCase();
    if (['button', 'checkbox', 'file', 'hidden', 'image', 'password', 'radio', 'range', 'reset', 'submit'].includes(type)) {
      return true;
    }
  }

  const autocomplete = target.getAttribute('autocomplete') || '';
  return hasSensitiveAutocomplete(autocomplete);
}

function isSoftSensitiveTarget(target: EditableElement): boolean {
  const searchableText = [
    getElementLabel(target),
    target.id,
    target.getAttribute('aria-label'),
    target.getAttribute('data-testid'),
    target.getAttribute('data-test'),
    target.getAttribute('title'),
    'name' in target ? target.name : '',
    'placeholder' in target ? target.placeholder : '',
  ].join(' ');

  return looksSensitiveFieldText(searchableText);
}

function getFieldKey(target: EditableElement): string {
  if (target.id) return limitKey(`id:${target.id}`);

  const name = 'name' in target ? cleanText(target.name) : '';
  const label = getElementLabel(target);
  const form = 'form' in target ? target.form : undefined;
  const formPart = form ? form.id || form.getAttribute('name') || getElementPath(form) : '';

  if (name) return limitKey(`name:${formPart}:${name}:${getElementPath(target)}`);
  if (label) return limitKey(`label:${slug(label)}:${getElementPath(target)}`);
  return limitKey(`path:${getInputType(target)}:${getElementPath(target)}`);
}

function getElementLabel(target: Element): string | undefined {
  const doc = target.ownerDocument;
  const labels: string[] = [];

  if (target.id) {
    const label = doc.querySelector(`label[for="${escapeCss(target.id)}"]`);
    if (label) labels.push(label.textContent || '');
  }

  const wrappingLabel = target.closest('label');
  if (wrappingLabel) labels.push(wrappingLabel.textContent || '');

  const ariaLabel = target.getAttribute('aria-label');
  if (ariaLabel) labels.push(ariaLabel);

  const labelledBy = target.getAttribute('aria-labelledby');
  if (labelledBy) {
    labels.push(
      ...labelledBy
        .split(/\s+/)
        .map((id) => doc.getElementById(id)?.textContent || '')
        .filter(Boolean),
    );
  }

  labels.push(target.getAttribute('placeholder') || '', target.getAttribute('name') || '');
  labels.push(
    target.getAttribute('data-name') || '',
    target.getAttribute('data-testid') || '',
    target.getAttribute('title') || '',
    target.id || '',
  );

  return labels.map(cleanText).find(Boolean);
}

function getElementPath(target: Element): string {
  const parts: string[] = [];
  let current: Element | null = target;

  while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 7) {
    const tag = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`${tag}#${current.id}`);
      break;
    }

    const name = current.getAttribute('name');
    const role = current.getAttribute('role');
    const parent: Element | null = current.parentElement;
    const index = parent
      ? Array.from(parent.children).filter((child) => child.tagName === current!.tagName).indexOf(current) + 1
      : 1;
    const attrs = [name ? `[name="${name}"]` : '', role ? `[role="${role}"]` : ''].join('');
    parts.unshift(`${tag}${attrs}:nth-of-type(${index})`);
    current = parent;
  }

  return parts.join(' > ');
}

function getDeepActiveElement(): Element | undefined {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active || undefined;
}

function effectiveDomain(): string {
  return metadataDomainFromUrl(location.href) || metadataDomainFromUrl(document.referrer) || location.protocol.replace(':', '');
}

function createSession(): ElementSession {
  return {
    sessionId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    finalized: false,
  };
}

function normalizeSettings(raw: unknown): InputStashSettings {
  const settings = raw as Partial<InputStashSettings> | undefined;
  return {
    historyLimit: Number(settings?.historyLimit ?? DEFAULT_SETTINGS.historyLimit),
    identityThreshold: Number(settings?.identityThreshold ?? DEFAULT_SETTINGS.identityThreshold),
    blockedDomains: Array.isArray(settings?.blockedDomains) ? settings.blockedDomains.map(normalizeMetadataDomain) : [],
    blockedFields: settings?.blockedFields || {},
    colorScheme: DEFAULT_SETTINGS.colorScheme,
  };
}

function isBlockedDomain(domain: string, settings: InputStashSettings): boolean {
  const normalized = normalizeMetadataDomain(domain);
  return settings.blockedDomains.some((blocked) => normalizeMetadataDomain(blocked) === normalized);
}

function isBlockedField(domain: string, fieldKey: string, settings: InputStashSettings): boolean {
  return (settings.blockedFields[normalizeMetadataDomain(domain)] || []).includes(fieldKey);
}

function cleanText(value: string | null | undefined): string | undefined {
  const cleaned = (value || '').replace(/\s+/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 160) : undefined;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function limitKey(value: string): string {
  return value.replace(/\s+/g, ' ').slice(0, 400);
}

function escapeCss(value: string): string {
  const css = globalThis.CSS as { escape?: (input: string) => string } | undefined;
  return typeof css?.escape === 'function' ? css.escape(value) : value.replace(/["\\]/g, '\\$&');
}
