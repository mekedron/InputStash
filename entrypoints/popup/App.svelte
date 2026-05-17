<script lang="ts">
  import { Ban, Check, Coffee, Copy, Heart, History, Monitor, Moon, RotateCcw, Settings, ShieldCheck, Sun, Trash2, X } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import {
    formatTime,
    listFields,
    mergeFields,
    mergedMatchesFilter,
    mergedVisibleRecords,
    normalizePopupSettings,
    preview,
  } from '../../components/popupUtils';
  import DomainPicker from './DomainPicker.svelte';
  import {
    DEFAULT_SETTINGS,
    SETTINGS_KEY,
    STATE_KEY,
    clearDomain,
    deleteFields,
    deleteRecord,
    domainFromUrl,
    getDomain,
    getSettings,
    listDomainSummaries,
    normalizeDomain,
    saveSettings,
  } from '../../components/storage';
  import type { ColorScheme, DomainHistory, DomainSummary, InputStashSettings, MergedField, MergedRecord } from '../../components/types';

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
  let expandedIdentity = '';
  let inputSearch = '';
  let isLoading = true;
  let historyLimit = 20;
  let identityThreshold = 50;
  let blockedDomainInput = '';
  let copyFeedback = '';
  let settings: InputStashSettings = normalizePopupSettings(undefined);

  $: applyColorScheme(settings.colorScheme);
  $: merged = domainData
    ? mergeFields(Object.values(domainData.fields)).map((m) => ({
        ...m,
        allBlocked:
          m.fieldKeys.length > 0 &&
          m.fieldKeys.every((k) => (settings.blockedFields[selectedDomain] || []).includes(k)),
      }))
    : [];
  $: visibleMerged = merged.filter((m) => mergedMatchesFilter(m, inputSearch));
  $: selectedSummary = domains.find((domain) => domain.domain === selectedDomain);
  $: selectedDomainBlocked = settings.blockedDomains.includes(selectedDomain);
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
    expandedIdentity = '';
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
    expandedIdentity = '';
    await refreshData(true);
  }

  async function removeField(m: MergedField): Promise<void> {
    if (!selectedDomain) return;
    const message =
      m.fieldKeys.length > 1
        ? `Clear "${m.displayName}" (${m.fieldKeys.length} variants)?`
        : `Clear "${m.displayName}"?`;
    if (!confirm(message)) return;
    await deleteFields(selectedDomain, m.fieldKeys);
    expandedIdentity = '';
    await refreshData(false);
  }

  async function removeRecord(record: MergedRecord): Promise<void> {
    if (!selectedDomain) return;
    await deleteRecord(selectedDomain, record.fieldKey, record.id);
    await refreshData(false);
  }

  async function copyValue(record: { id: string; value: string }): Promise<void> {
    await navigator.clipboard.writeText(record.value);
    copyFeedback = record.id;
    window.setTimeout(() => {
      if (copyFeedback === record.id) copyFeedback = '';
    }, 1200);
  }

  function toggleIdentity(identity: string): void {
    expandedIdentity = expandedIdentity === identity ? '' : identity;
  }

  async function toggleMergedFieldBlock(m: MergedField): Promise<void> {
    if (!selectedDomain) return;
    const current = new Set(settings.blockedFields[selectedDomain] || []);
    const shouldBlock = !m.allBlocked;
    for (const key of m.fieldKeys) {
      if (shouldBlock) current.add(key);
      else current.delete(key);
    }
    const next = { ...settings.blockedFields };
    if (current.size) next[selectedDomain] = [...current].sort();
    else delete next[selectedDomain];
    settings = await saveSettings({ blockedFields: next });
  }

</script>

<main>
  <header class="mini-header">
    <button class="mini-brand" type="button" onclick={() => (view = 'domain')} aria-label="Show saved inputs">
      <img
        class="mini-mark"
        src="/icon/48.png"
        srcset="/icon/48.png 1x, /icon/96.png 2x, /icon/128.png 3x"
        width="24"
        height="24"
        alt=""
      />
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

      {#if merged.length}
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

      {#if !visibleMerged.length}
        <div class="empty">
          <strong>{merged.length ? 'No matching inputs.' : 'No saved inputs here yet.'}</strong>
          <span>{merged.length ? 'Try another label, name, id, value, or page.' : 'Type in a field on this domain, then reopen the popup.'}</span>
        </div>
      {:else}
        <div class="field-list">
          {#each visibleMerged as m (m.identity)}
            {@const records = mergedVisibleRecords(m, inputSearch)}
            {@const latest = m.latest}
            {@const isExpanded = expandedIdentity === m.identity}
            <article class:expanded={isExpanded} class="field-card">
              <div class="field-summary-row">
                <div class="field-summary">
                  <span class="field-summary-text">
                    <strong>{m.displayName}</strong>
                    <small>{records.length} {records.length === 1 ? 'record' : 'records'} · {m.inputType} · {formatTime(m.lastUpdated)}</small>
                  </span>
                </div>
                <button
                  class="icon-only field-history-toggle"
                  class:active={isExpanded}
                  type="button"
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? 'Hide history' : 'Show history'}
                  title={isExpanded ? 'Hide history' : 'Show history'}
                  onclick={() => toggleIdentity(m.identity)}
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
                      onclick={() => removeField(m)}
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </div>
                </section>
              {/if}

              {#if isExpanded}
                <div class="field-detail">
                  <dl>
                    <div>
                      <dt>{m.fieldKeys.length > 1 ? 'Keys' : 'Key'}</dt>
                      <dd>{m.fieldKeys.join(', ')}</dd>
                    </div>
                    {#if m.members[0]?.elementId}<div><dt>Element ID</dt><dd>{m.members[0].elementId}</dd></div>{/if}
                    {#if m.pageUrl}<div><dt>Page</dt><dd>{m.pageUrl}</dd></div>{/if}
                  </dl>

                  <div class="actions">
                    <button
                      class="icon-only"
                      type="button"
                      aria-label={m.allBlocked ? 'Unblock field' : 'Block field'}
                      title={m.allBlocked ? 'Unblock field' : 'Block field'}
                      onclick={() => toggleMergedFieldBlock(m)}
                    >
                      {#if m.allBlocked}
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
                      onclick={() => removeField(m)}
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
                            onclick={() => removeRecord(record)}
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
