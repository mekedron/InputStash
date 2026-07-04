import { findFaviconUrl, getPageMetadata, metadataDomainFromUrl, normalizeMetadataDomain } from '../components/pageMetadata';
import { hasSensitiveAutocomplete, looksSensitiveFieldText } from '../components/privacy';
import type { CaptureReason, CaptureSnapshot, InputStashSettings, SettingsUpdatedMessage } from '../components/types';

const SETTINGS_KEY = 'inputstash:settings:v1';
const SETTINGS_UPDATED_MESSAGE: SettingsUpdatedMessage['type'] = 'inputstash:settings-updated';
const DEBOUNCE_MS = 300;
const MAX_VALUE_CHARS = 50000;

const DEFAULT_SETTINGS: InputStashSettings = {
  historyLimit: 20,
  identityThreshold: 50,
  blockedDomains: [],
  blockedFields: {},
  colorScheme: 'auto',
};

// Everything derived from the DOM around a field (labels, selector paths,
// sensitivity checks) is stable while the user keeps editing it, so it is
// computed once per session instead of on every debounced capture.
interface FieldDescriptor {
  fieldKey: string;
  elementId?: string;
  label?: string;
  placeholder?: string;
  name?: string;
  inputType: string;
  selector: string;
  sensitive: boolean;
  faviconUrl?: string;
}

interface ElementSession {
  sessionId: string;
  timer?: number;
  finalized: boolean;
  lastReason?: CaptureReason;
  lastValue?: string;
  descriptor?: FieldDescriptor;
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
    const observedShadowRoots = new WeakSet<ShadowRoot>();
    const cleanup: Array<() => void> = [];
    let settings = DEFAULT_SETTINGS;

    void refreshSettings();

    // No storage.onChanged listener here on purpose: the browser delivers
    // those events (including old and new values of every changed key) to
    // every listening frame, which made all open tabs pay for every capture
    // write. Settings arrive as a push message from the popup instead.
    const messageListener = (message: unknown): undefined => {
      const typed = message as Partial<SettingsUpdatedMessage> | null;
      if (typed?.type === SETTINGS_UPDATED_MESSAGE) settings = normalizeSettings(typed.settings);
      return undefined;
    };
    browser.runtime.onMessage.addListener(messageListener);
    cleanup.push(() => browser.runtime.onMessage.removeListener(messageListener));

    attachRootListeners(document);

    const flushListener = () => flushPendingCapture();
    window.addEventListener('pagehide', flushListener, true);
    cleanup.push(() => window.removeEventListener('pagehide', flushListener, true));

    ctx.onInvalidated(() => {
      for (const remove of cleanup) remove();
    });

    // input/focusin/blur are composed events: they cross open shadow DOM
    // boundaries and reach the document-level capture listeners. change and
    // submit are not composed, so those two are attached to each shadow root
    // discovered via composedPath() the first time the user interacts with
    // it. This replaces the old MutationObserver + periodic TreeWalker scan,
    // which walked the whole DOM of every page looking for shadow roots.
    function attachRootListeners(root: Document | ShadowRoot): void {
      root.addEventListener('change', handleChange, true);
      root.addEventListener('submit', handleSubmit, true);

      if (root === document) {
        root.addEventListener('input', handleInput, true);
        root.addEventListener('focusin', handleFocusIn, true);
        root.addEventListener('blur', handleBlur, true);
        cleanup.push(() => {
          root.removeEventListener('change', handleChange, true);
          root.removeEventListener('submit', handleSubmit, true);
          root.removeEventListener('input', handleInput, true);
          root.removeEventListener('focusin', handleFocusIn, true);
          root.removeEventListener('blur', handleBlur, true);
        });
      }
      // Shadow root listeners are not registered for cleanup: keeping strong
      // references to them would leak removed components, and the handlers
      // are inert once ctx is invalidated.
    }

    function discoverShadowRoot(root: ShadowRoot): void {
      if (observedShadowRoots.has(root)) return;
      observedShadowRoots.add(root);
      attachRootListeners(root);
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
      if (!ctx.isValid) return;
      const session = getSession(target, reason);
      if (session.timer) {
        window.clearTimeout(session.timer);
        session.timer = undefined;
      }

      if (delay <= 0) {
        // Immediate reasons (change/blur/submit) capture synchronously, while
        // the value is still present — apps often clear fields right after
        // handling their own submit.
        capture(target, session, reason);
        return;
      }

      session.timer = window.setTimeout(() => {
        session.timer = undefined;
        capture(target, session, reason);
      }, delay);
    }

    function capture(target: EditableElement, session: ElementSession, reason: CaptureReason): void {
      const snapshot = createSnapshot(target, reason, session);
      if (!snapshot) return;

      const shouldSend = session.lastValue !== snapshot.value || session.lastReason !== reason;
      session.lastValue = snapshot.value;
      session.lastReason = reason;
      if (reason !== 'input') session.finalized = true;
      if (shouldSend) void sendSnapshot(snapshot);
    }

    // Tab closes and navigations flush the pending debounced capture so the
    // last keystrokes before leaving are not lost.
    function flushPendingCapture(): void {
      if (!ctx.isValid) return;
      const active = getDeepActiveElement();
      const target = active ? editableFromElement(active) : undefined;
      if (!target) return;
      const session = sessions.get(target);
      if (!session?.timer) return;
      window.clearTimeout(session.timer);
      session.timer = undefined;
      capture(target, session, 'blur');
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
      session: ElementSession,
    ): CaptureSnapshot | undefined {
      const valueResult = readValue(target);
      if (!valueResult.value.trim()) return undefined;

      const domain = effectiveDomain();
      if (!domain || isBlockedDomain(domain, settings)) return undefined;

      const descriptor = (session.descriptor ||= buildFieldDescriptor(target));
      if (descriptor.sensitive) return undefined;
      if (isBlockedField(domain, descriptor.fieldKey, settings)) return undefined;

      return {
        ...getPageMetadata(descriptor.faviconUrl),
        domain,
        fieldKey: descriptor.fieldKey,
        elementId: descriptor.elementId,
        label: descriptor.label,
        placeholder: descriptor.placeholder,
        name: descriptor.name,
        inputType: descriptor.inputType,
        selector: descriptor.selector,
        value: valueResult.value,
        truncated: valueResult.truncated,
        reason,
        sessionId: session.sessionId,
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
        const raw = await browser.storage.local.get(SETTINGS_KEY);
        if (raw[SETTINGS_KEY]) settings = normalizeSettings(raw[SETTINGS_KEY]);
      } catch {
        settings = DEFAULT_SETTINGS;
      }
    }

    function findEditableTarget(event: Event): EditableElement | undefined {
      let found: EditableElement | undefined;
      for (const item of event.composedPath()) {
        if (item instanceof ShadowRoot) {
          discoverShadowRoot(item);
        } else if (!found && item instanceof Element) {
          found = editableFromElement(item);
        }
      }
      if (found) return found;
      return event.target instanceof Element ? editableFromElement(event.target) : undefined;
    }
  },
});

function editableFromElement(element: Element): EditableElement | undefined {
  if (element instanceof HTMLInputElement) return isSupportedInput(element) ? element : undefined;
  if (element instanceof HTMLTextAreaElement) return element;
  if (element instanceof HTMLSelectElement) return element;

  if (element instanceof HTMLElement) {
    // isContentEditable is inherited, so a false here means the element is
    // not inside an editable region either — no need for a closest() lookup.
    return element.isContentEditable ? closestEditableRoot(element) : undefined;
  }

  // Non-HTML elements (SVG/MathML) can still sit inside an editable region.
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

function buildFieldDescriptor(target: EditableElement): FieldDescriptor {
  const label = getElementLabel(target);
  return {
    fieldKey: getFieldKey(target, label),
    elementId: target.id || undefined,
    label,
    placeholder: 'placeholder' in target ? cleanText(target.placeholder) : undefined,
    name: 'name' in target ? cleanText(target.name) : undefined,
    inputType: getInputType(target),
    selector: getElementPath(target),
    sensitive: isHardSensitiveTarget(target) || isSoftSensitiveTarget(target, label),
    faviconUrl: findFaviconUrl(),
  };
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

function isSoftSensitiveTarget(target: EditableElement, label: string | undefined): boolean {
  const searchableText = [
    label,
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

function getFieldKey(target: EditableElement, label: string | undefined): string {
  if (target.id) return limitKey(`id:${target.id}`);

  const name = 'name' in target ? cleanText(target.name) : '';
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

let cachedEffectiveDomain: string | undefined;

function effectiveDomain(): string {
  cachedEffectiveDomain ??=
    metadataDomainFromUrl(location.href) || metadataDomainFromUrl(document.referrer) || location.protocol.replace(':', '');
  return cachedEffectiveDomain;
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
