import { defineConfig } from 'wxt';

// https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  manifest: ({ browser }) => ({
    name: 'InputStash',
    description: 'Never lose what you typed. Recover recent input from any page.',
    permissions: ['storage', 'activeTab', 'tabs', 'unlimitedStorage'],
    // Broad for now; narrow once we know which origins to skip.
    host_permissions: ['<all_urls>'],
    action: { default_title: 'InputStash' },
    // Firefox requires this for new extensions from 2025-11-03. Everything
    // lives in browser.storage.local; nothing is transmitted off-device.
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'inputstash@rabykin.dev',
              data_collection_permissions: { required: ['none'] },
            },
          },
        }
      : {}),
  }),
});
