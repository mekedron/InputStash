<script lang="ts">
  import { ChevronDown, RotateCcw } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { domainInitial, formatTime } from '../../components/popupUtils';
  import type { DomainSummary } from '../../components/types';

  export let currentDomain = '';
  export let domains: DomainSummary[] = [];
  export let selectedDomain = '';
  export let onSelect: (domain: string) => void | Promise<void> = () => {};

  let search = '';
  let open = false;
  let root: HTMLElement;
  let brokenFavicons = new Set<string>();

  function markFaviconBroken(url: string): void {
    if (brokenFavicons.has(url)) return;
    brokenFavicons = new Set(brokenFavicons).add(url);
  }

  $: filteredDomains = domains.filter((domain) => domain.domain.includes(search.trim().toLowerCase()));
  $: selectedSummary = domains.find((domain) => domain.domain === selectedDomain);

  onMount(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') open = false;
    };

    document.addEventListener('pointerdown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  });

  async function select(domain: string): Promise<void> {
    search = '';
    open = false;
    await onSelect(domain);
  }

  function autofocus(node: HTMLInputElement): void {
    node.focus();
  }
</script>

<section class="domain-picker-row" bind:this={root}>
  <div class="domain-picker">
    <button class:open class="domain-trigger" type="button" aria-expanded={open} onclick={() => (open = !open)}>
      {#if selectedSummary?.faviconUrl && !brokenFavicons.has(selectedSummary.faviconUrl)}
        <img class="favicon" src={selectedSummary.faviconUrl} alt="" onerror={() => markFaviconBroken(selectedSummary!.faviconUrl!)} />
      {:else}
        <span class="favicon fallback">{domainInitial(selectedDomain)}</span>
      {/if}
      <span class="domain-trigger-text">
        <strong>{selectedDomain || 'Choose domain'}</strong>
        <small>
          {#if selectedSummary}
            {selectedSummary.fieldCount} fields · {formatTime(selectedSummary.lastUpdated)}
          {:else}
            Search saved domains
          {/if}
        </small>
      </span>
      <ChevronDown class="chevron" size={16} aria-hidden="true" />
    </button>

    {#if open}
      <div class="domain-menu">
        <input use:autofocus aria-label="Filter domains" placeholder="Filter domains" bind:value={search} />
        <div class="domain-options">
          {#each filteredDomains as domain}
            <button class:selected={domain.domain === selectedDomain} type="button" onclick={() => select(domain.domain)}>
              {#if domain.faviconUrl && !brokenFavicons.has(domain.faviconUrl)}
                <img class="favicon" src={domain.faviconUrl} alt="" onerror={() => markFaviconBroken(domain.faviconUrl!)} />
              {:else}
                <span class="favicon fallback">{domainInitial(domain.domain)}</span>
              {/if}
              <span>
                <strong>{domain.domain}</strong>
                <small>{domain.fieldCount} fields · {formatTime(domain.lastUpdated)}</small>
              </span>
            </button>
          {:else}
            <p>No matching domains.</p>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  {#if currentDomain}
    <button class="current" type="button" aria-label="Current domain" title="Current domain" onclick={() => select(currentDomain)}>
      <RotateCcw size={14} aria-hidden="true" />
    </button>
  {/if}
</section>

<style>
  .domain-picker-row {
    position: relative;
    display: flex;
    gap: 8px;
    padding: 12px 14px;
  }

  .domain-picker {
    position: relative;
    flex: 1;
    min-width: 0;
  }

  .domain-trigger {
    display: grid;
    grid-template-columns: 24px 1fr 18px;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 46px;
    padding: 8px 10px;
    color: var(--fg);
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--border-input);
    border-radius: 8px;
  }

  .domain-trigger.open,
  .domain-trigger:hover {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-focus-shadow);
  }

  .domain-trigger-text,
  .domain-trigger-text strong,
  .domain-trigger-text small {
    min-width: 0;
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  :global(.chevron) {
    justify-self: center;
    color: var(--fg-muted);
    transition: transform 120ms ease;
  }

  .domain-trigger.open :global(.chevron) {
    transform: rotate(180deg);
  }

  .favicon {
    width: 22px;
    height: 22px;
    border-radius: 6px;
    object-fit: cover;
  }

  .favicon.fallback {
    display: grid;
    place-items: center;
    color: var(--surface);
    background: var(--accent);
    font-size: 11px;
    font-weight: 800;
  }

  .domain-menu {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    left: 0;
    z-index: 4;
    display: grid;
    gap: 8px;
    padding: 9px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    box-shadow: var(--shadow-menu);
  }

  .domain-menu input {
    min-width: 0;
    padding: 9px 10px;
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--border-input);
    border-radius: 8px;
    outline: none;
  }

  .domain-menu input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .current {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    width: 46px;
    height: 46px;
    padding: 0;
    color: var(--fg);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .current:hover {
    border-color: var(--accent);
    box-shadow: inset 0 -2px 0 var(--accent-shadow);
  }

  .domain-options {
    display: grid;
    max-height: 260px;
    overflow: auto;
  }

  .domain-options button {
    display: grid;
    grid-template-columns: 24px 1fr;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 8px;
    color: var(--fg);
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: 8px;
  }

  .domain-options button:hover,
  .domain-options button.selected {
    background: var(--bg-option-hover);
  }

  .domain-options strong,
  .domain-options small {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .domain-options p {
    padding: 18px 8px;
    color: var(--fg-muted);
    text-align: center;
  }
</style>
