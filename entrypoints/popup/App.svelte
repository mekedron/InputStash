<script lang="ts">
  import { Ban, Check, Coffee, Copy, Heart, History, Monitor, Moon, RotateCcw, Settings, ShieldCheck, Sun, Trash2, X } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import {
    fieldMatchesFilter,
    formatTime,
    listFields,
    normalizePopupSettings,
    preview,
    visibleRecords,
  } from '../../components/popupUtils';
  import DomainPicker from './DomainPicker.svelte';
  import {
    DEFAULT_SETTINGS,
    SETTINGS_KEY,
    STATE_KEY,
    bestFieldName,
    clearDomain,
    deleteField,
    deleteRecord,
    domainFromUrl,
    getDomain,
    getSettings,
    listDomainSummaries,
    normalizeDomain,
    saveSettings,
  } from '../../components/storage';
  import type { ColorScheme, DomainHistory, DomainSummary, FieldHistory, InputStashSettings, StashRecord } from '../../components/types';

  type View = 'domain' | 'settings';

  const THEME_OPTIONS: Array<{ value: ColorScheme; label: string; icon: typeof Monitor }> = [
    { value: 'auto', label: 'Auto', icon: Monitor },
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
  ];

  let view: View = 'domain';
  let domains: DomainSummary[] = [];
  let domainData: DomainHistory | undefined;
  let selectedDomain = '';
  let currentDomain = '';
  let expandedFieldKey = '';
  let inputSearch = '';
  let isLoading = true;
  let historyLimit = 20;
  let identityThreshold = 50;
  let blockedDomainInput = '';
  let copyFeedback = '';
  let settings: InputStashSettings = normalizePopupSettings(undefined);

  $: applyColorScheme(settings.colorScheme);
  $: fields = domainData ? Object.values(domainData.fields).sort((a, b) => b.lastUpdated - a.lastUpdated) : [];
  $: visibleFields = fields.filter((field) => fieldMatchesFilter(field, inputSearch));
  $: selectedSummary = domains.find((domain) => domain.domain === selectedDomain);
  $: selectedDomainBlocked = settings.blockedDomains.includes(selectedDomain);
  $: blockedFields = settings.blockedFields[selectedDomain] || [];
  $: blockedDomainCount = settings.blockedDomains.length;
  $: blockedFieldCount = Object.values(settings.blockedFields).reduce((count, fieldKeys) => count + fieldKeys.length, 0);

  onMount(() => {
    void initialize();

    const listener = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local') return;
      if (changes[SETTINGS_KEY]?.newValue) {
        settings = normalizePopupSettings(changes[SETTINGS_KEY].newValue);
        historyLimit = settings.historyLimit;
        identityThreshold = settings.identityThreshold;
      }
      if (changes[STATE_KEY]) void refreshData(false);
    };

    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  });

  async function initialize(): Promise<void> {
    settings = await getSettings();
    historyLimit = settings.historyLimit;
    identityThreshold = settings.identityThreshold;
    currentDomain = await getActiveDomain();
    selectedDomain = currentDomain;
    await refreshData(true);
    isLoading = false;
  }

  async function refreshData(selectFallback: boolean): Promise<void> {
    domains = await listDomainSummaries();
    if (selectFallback && !domains.some((domain) => domain.domain === selectedDomain)) {
      selectedDomain = currentDomain || domains[0]?.domain || selectedDomain;
    }
    await loadDomain(selectedDomain);
  }

  async function loadDomain(domain: string): Promise<void> {
    selectedDomain = domain;
    domainData = domain ? await getDomain(domain) : undefined;
    if (expandedFieldKey && !domainData?.fields[expandedFieldKey]) expandedFieldKey = '';
  }

  async function getActiveDomain(): Promise<string> {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      return domainFromUrl(tab?.url);
    } catch {
      return '';
    }
  }

  async function selectDomain(domain: string): Promise<void> {
    view = 'domain';
    expandedFieldKey = '';
    await loadDomain(domain);
  }

  async function saveHistoryLimit(): Promise<void> {
    const normalized = Number.isFinite(Number(historyLimit)) ? Math.max(0, Math.floor(Number(historyLimit))) : 20;
    settings = await saveSettings({ historyLimit: normalized });
    historyLimit = settings.historyLimit;
  }

  function applyColorScheme(scheme: ColorScheme): void {
    if (typeof document === 'undefined') return;
    document.documentElement.setAttribute('data-theme', scheme);
  }

  async function saveColorScheme(scheme: ColorScheme): Promise<void> {
    if (settings.colorScheme === scheme) return;
    settings = await saveSettings({ colorScheme: scheme });
  }

  async function saveIdentityThreshold(): Promise<void> {
    const value = Number(identityThreshold);
    const normalized = Number.isFinite(value) ? Math.min(100, Math.max(0, Math.floor(value))) : 50;
    settings = await saveSettings({ identityThreshold: normalized });
    identityThreshold = settings.identityThreshold;
  }

  async function resetSettingsToDefaults(): Promise<void> {
    if (!confirm('Reset InputStash settings to defaults? Saved history will stay.')) return;
    settings = await saveSettings(DEFAULT_SETTINGS);
    historyLimit = settings.historyLimit;
    identityThreshold = settings.identityThreshold;
    blockedDomainInput = '';
  }

  async function toggleSelectedDomainBlock(): Promise<void> {
    if (!selectedDomain) return;
    const blocked = new Set(settings.blockedDomains);
    if (blocked.has(selectedDomain)) blocked.delete(selectedDomain);
    else blocked.add(selectedDomain);
    settings = await saveSettings({ blockedDomains: [...blocked].sort() });
  }

  async function toggleFieldBlock(fieldKey: string): Promise<void> {
    if (!selectedDomain) return;
    const blocked = new Set(settings.blockedFields[selectedDomain] || []);
    if (blocked.has(fieldKey)) blocked.delete(fieldKey);
    else blocked.add(fieldKey);
    const nextBlockedFields = { ...settings.blockedFields };
    if (blocked.size) nextBlockedFields[selectedDomain] = [...blocked].sort();
    else delete nextBlockedFields[selectedDomain];
    settings = await saveSettings({ blockedFields: nextBlockedFields });
  }

  async function addBlockedDomain(): Promise<void> {
    const raw = blockedDomainInput;
    const domain = normalizeDomain(raw);
    if (!domain) return;

    settings = await saveSettings({ blockedDomains: [...new Set([...settings.blockedDomains, domain])].sort() });
    blockedDomainInput = '';
  }

  async function removeBlockedDomain(domain: string): Promise<void> {
    settings = await saveSettings({ blockedDomains: settings.blockedDomains.filter((item) => item !== domain) });
  }

  async function removeBlockedField(domain: string, fieldKey: string): Promise<void> {
    const next = {
      ...settings.blockedFields,
      [domain]: (settings.blockedFields[domain] || []).filter((item) => item !== fieldKey),
    };
    if (!next[domain].length) delete next[domain];

    settings = await saveSettings({ blockedFields: next });
  }

  async function clearSelectedDomain(): Promise<void> {
    if (!selectedDomain || !confirm(`Clear every saved input for ${selectedDomain}?`)) return;
    await clearDomain(selectedDomain);
    domainData = undefined;
    expandedFieldKey = '';
    await refreshData(true);
  }

  async function removeField(field: FieldHistory): Promise<void> {
    if (!selectedDomain || !confirm(`Clear "${bestFieldName(field)}"?`)) return;
    await deleteField(selectedDomain, field.fieldKey);
    expandedFieldKey = '';
    await refreshData(false);
  }

  async function removeRecord(field: FieldHistory, record: StashRecord): Promise<void> {
    if (!selectedDomain) return;
    await deleteRecord(selectedDomain, field.fieldKey, record.id);
    await refreshData(false);
  }

  async function copyValue(record: StashRecord): Promise<void> {
    await navigator.clipboard.writeText(record.value);
    copyFeedback = record.id;
    window.setTimeout(() => {
      if (copyFeedback === record.id) copyFeedback = '';
    }, 1200);
  }

  function toggleField(fieldKey: string): void {
    expandedFieldKey = expandedFieldKey === fieldKey ? '' : fieldKey;
  }

</script>

<main>
  <header class="mini-header">
    <button class="mini-brand" type="button" onclick={() => (view = 'domain')} aria-label="Show saved inputs">
      <span class="mini-mark">IS</span>
      <span>
        <strong>InputStash</strong>
        <small>{domains.length} domains</small>
      </span>
    </button>
    <div class="mini-actions">
      <a
        class="mini-donate"
        href="https://buymeacoffee.com/mekedron"
        target="_blank"
        rel="noopener noreferrer"
        title="Buy me a coffee — support the developer"
      >
        <Coffee size={13} aria-hidden="true" />
        <span>Donate</span>
      </a>
      {#if view === 'settings'}
        <button class="mini-action" type="button" aria-label="History" title="History" onclick={() => (view = 'domain')}>
          <History size={14} aria-hidden="true" />
        </button>
      {:else}
        <button class="mini-action" type="button" aria-label="Settings" title="Settings" onclick={() => (view = 'settings')}>
          <Settings size={14} aria-hidden="true" />
        </button>
      {/if}
    </div>
  </header>

  {#if isLoading}
    <section class="empty">
      <strong>Loading</strong>
      <span>Reading local history.</span>
    </section>
  {:else if view === 'settings'}
    <section class="panel settings-panel">
      <div class="section-title">
        <h2>Settings</h2>
        <span>{blockedDomainCount} blocked domains · {blockedFieldCount} blocked inputs</span>
      </div>

      <div class="setting-row">
        <span>
          <strong>Theme</strong>
          <small>Match the browser, or pick one.</small>
        </span>
        <div class="theme-switch" role="group" aria-label="Color scheme">
          {#each THEME_OPTIONS as option}
            <button
              type="button"
              class:active={settings.colorScheme === option.value}
              aria-pressed={settings.colorScheme === option.value}
              aria-label={option.label}
              title={option.label}
              onclick={() => saveColorScheme(option.value)}
            >
              <option.icon size={14} aria-hidden="true" />
            </button>
          {/each}
        </div>
      </div>

      <label class="setting-row">
        <span>
          <strong>Records per field</strong>
          <small>Default is 20. Set 0 for unlimited local history.</small>
        </span>
        <input type="number" min="0" bind:value={historyLimit} onchange={saveHistoryLimit} />
      </label>

      <label class="setting-row">
        <span>
          <strong>New message threshold</strong>
          <small>Below this identity percentage, a live rewrite becomes a new record. Set 0 to always update latest.</small>
        </span>
        <input
          type="number"
          min="0"
          max="100"
          bind:value={identityThreshold}
          onchange={saveIdentityThreshold}
        />
      </label>

      <div class="list-manager">
        <h3>Blocked domains</h3>
        <div class="inline-form">
          <input placeholder="example.com" bind:value={blockedDomainInput} />
          <button class="icon-only" type="button" aria-label="Block domain" title="Block domain" onclick={addBlockedDomain}>
            <Ban size={15} aria-hidden="true" />
          </button>
        </div>
        {#if settings.blockedDomains.length}
          {#each settings.blockedDomains as domain}
            <span class="rule-chip">
              <button type="button" onclick={() => selectDomain(domain)}>{domain}</button>
              <button class="danger icon-only" type="button" aria-label={`Remove ${domain}`} title="Remove" onclick={() => removeBlockedDomain(domain)}>
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </span>
          {/each}
        {:else}
          <p>No blocked domains.</p>
        {/if}
      </div>

      <div class="list-manager">
        <h3>Blocked inputs</h3>
        {#if listFields(settings.blockedFields).length}
          {#each listFields(settings.blockedFields) as item}
            <span class="rule-chip wide">
              <button type="button" onclick={() => selectDomain(item.domain)}>{item.domain}</button>
              <code>{item.fieldKey}</code>
              <button
                class="danger icon-only"
                type="button"
                aria-label={`Remove blocked input rule for ${item.domain}`}
                title="Remove"
                onclick={() => removeBlockedField(item.domain, item.fieldKey)}
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </span>
          {/each}
        {:else}
          <p>No blocked inputs.</p>
        {/if}
      </div>

      <aside class="support-card">
        <div class="support-text">
          <strong>
            <Heart size={13} aria-hidden="true" />
            Support InputStash
          </strong>
          <small>
            InputStash is built and maintained by one indie developer. If it saved you a
            painful retype, a coffee goes a long way toward keeping it free and ad-free.
          </small>
        </div>
        <a
          class="support-cta"
          href="https://buymeacoffee.com/mekedron"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Coffee size={14} aria-hidden="true" />
          <span>Buy me a coffee</span>
        </a>
      </aside>

      <div class="settings-reset">
        <button class="danger icon-only" type="button" aria-label="Reset defaults" title="Reset defaults" onclick={resetSettingsToDefaults}>
          <RotateCcw size={15} aria-hidden="true" />
        </button>
        <small>Saved history stays in place.</small>
      </div>
    </section>
  {:else}
    <DomainPicker {currentDomain} {domains} {selectedDomain} onSelect={selectDomain} />

    <section class="panel">
      <div class="domain-head">
        <div>
          <h1>{selectedDomain || 'No domain selected'}</h1>
          <p>
            {selectedSummary?.fieldCount || 0} fields · {selectedSummary?.recordCount || 0} records
            {#if selectedDomainBlocked} · blocked{/if}
          </p>
        </div>
        {#if selectedDomain}
          <div class="domain-actions">
            <button
              class="icon-only"
              type="button"
              aria-label={selectedDomainBlocked ? 'Unblock domain' : 'Block domain'}
              title={selectedDomainBlocked ? 'Unblock domain' : 'Block domain'}
              onclick={toggleSelectedDomainBlock}
            >
              {#if selectedDomainBlocked}
                <ShieldCheck size={15} aria-hidden="true" />
              {:else}
                <Ban size={15} aria-hidden="true" />
              {/if}
            </button>
            <button
              class="danger icon-only"
              type="button"
              aria-label="Clear domain history"
              title="Clear domain history"
              onclick={clearSelectedDomain}
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          </div>
        {/if}
      </div>

      {#if domainData?.iframeDomains.length || domainData?.parentDomains.length}
        <div class="relations">
          {#each domainData.parentDomains as domain}
            <button type="button" onclick={() => selectDomain(domain)}>Parent: {domain}</button>
          {/each}
          {#each domainData.iframeDomains as domain}
            <button type="button" onclick={() => selectDomain(domain)}>Frame: {domain}</button>
          {/each}
        </div>
      {/if}

      {#if fields.length}
        <div class="input-filter">
          <input
            aria-label="Filter inputs and history"
            placeholder="Filter by input label, name, id, value, or page"
            bind:value={inputSearch}
          />
          {#if inputSearch}
            <button class="icon-only" type="button" aria-label="Clear input filter" title="Clear filter" onclick={() => (inputSearch = '')}>
              <X size={15} aria-hidden="true" />
            </button>
          {/if}
        </div>
      {/if}

      {#if !visibleFields.length}
        <div class="empty">
          <strong>{fields.length ? 'No matching inputs.' : 'No saved inputs here yet.'}</strong>
          <span>{fields.length ? 'Try another label, name, id, value, or page.' : 'Type in a field on this domain, then reopen the popup.'}</span>
        </div>
      {:else}
        <div class="field-list">
          {#each visibleFields as field (field.fieldKey)}
            {@const latest = field.records[field.records.length - 1]}
            {@const records = visibleRecords(field, inputSearch)}
            <article class:expanded={expandedFieldKey === field.fieldKey} class="field-card">
              <div class="field-summary-row">
                <div class="field-summary">
                  <span class="field-summary-text">
                    <strong>{bestFieldName(field)}</strong>
                    <small>{records.length} {records.length === 1 ? 'record' : 'records'} · {field.inputType} · {formatTime(field.lastUpdated)}</small>
                  </span>
                </div>
                <button
                  class="icon-only field-history-toggle"
                  class:active={expandedFieldKey === field.fieldKey}
                  type="button"
                  aria-expanded={expandedFieldKey === field.fieldKey}
                  aria-label={expandedFieldKey === field.fieldKey ? 'Hide history' : 'Show history'}
                  title={expandedFieldKey === field.fieldKey ? 'Hide history' : 'Show history'}
                  onclick={() => toggleField(field.fieldKey)}
                >
                  <History size={15} aria-hidden="true" />
                </button>
              </div>

              {#if latest}
                <section class="field-latest">
                  <p>{preview(latest.value)}</p>
                  <div class="field-latest-actions">
                    <button
                      class="icon-only"
                      type="button"
                      aria-label="Copy latest value"
                      title={copyFeedback === latest.id ? 'Copied' : 'Copy latest value'}
                      onclick={() => copyValue(latest)}
                    >
                      {#if copyFeedback === latest.id}
                        <Check size={15} aria-hidden="true" />
                      {:else}
                        <Copy size={15} aria-hidden="true" />
                      {/if}
                    </button>
                    <button
                      class="danger icon-only"
                      type="button"
                      aria-label="Clear field history"
                      title="Clear field history"
                      onclick={() => removeField(field)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                </section>
              {/if}

              {#if expandedFieldKey === field.fieldKey}
                <div class="field-detail">
                  <dl>
                    <div><dt>Key</dt><dd>{field.fieldKey}</dd></div>
                    {#if field.elementId}<div><dt>Element ID</dt><dd>{field.elementId}</dd></div>{/if}
                    {#if field.pageUrl}<div><dt>Page</dt><dd>{field.pageUrl}</dd></div>{/if}
                  </dl>

                  <div class="actions">
                    <button
                      class="icon-only"
                      type="button"
                      aria-label={blockedFields.includes(field.fieldKey) ? 'Unblock field' : 'Block field'}
                      title={blockedFields.includes(field.fieldKey) ? 'Unblock field' : 'Block field'}
                      onclick={() => toggleFieldBlock(field.fieldKey)}
                    >
                      {#if blockedFields.includes(field.fieldKey)}
                        <ShieldCheck size={15} aria-hidden="true" />
                      {:else}
                        <Ban size={15} aria-hidden="true" />
                      {/if}
                    </button>
                    <button
                      class="danger icon-only"
                      type="button"
                      aria-label="Clear field history"
                      title="Clear field history"
                      onclick={() => removeField(field)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>

                  <div class="records">
                    {#each records as record (record.id)}
                      <section class="record">
                        <div>
                          <strong>{formatTime(record.updatedAt)}</strong>
                          <span>{record.draft ? 'Live draft' : record.reason}{record.truncated ? ' · truncated' : ''}</span>
                        </div>
                        <p>{preview(record.value, 260)}</p>
                        <div class="record-actions">
                          <button
                            class="icon-only"
                            type="button"
                            aria-label="Copy value"
                            title={copyFeedback === record.id ? 'Copied' : 'Copy value'}
                            onclick={() => copyValue(record)}
                          >
                            {#if copyFeedback === record.id}
                              <Check size={15} aria-hidden="true" />
                            {:else}
                              <Copy size={15} aria-hidden="true" />
                            {/if}
                          </button>
                          <button
                            class="ghost danger icon-only"
                            type="button"
                            aria-label="Delete history item"
                            title="Delete history item"
                            onclick={() => removeRecord(field, record)}
                          >
                            <Trash2 size={15} aria-hidden="true" />
                          </button>
                        </div>
                      </section>
                    {/each}
                  </div>
                </div>
              {/if}
            </article>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
</main>
