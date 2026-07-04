import { getSettings, migrateIfNeeded, saveCapture } from '../components/storage';
import type { InputStashMessage } from '../components/types';

export default defineBackground(() => {
  // Split any legacy single-blob state into per-domain keys as soon as the
  // worker starts, so the first capture does not pay for the migration.
  migrateIfNeeded().catch(() => {});

  browser.runtime.onMessage.addListener((message: InputStashMessage, sender) => {
    if (message?.type === 'inputstash:get-settings') {
      return getSettings().then((settings) => ({ ok: true, settings }));
    }

    if (message?.type === 'inputstash:capture') {
      return saveCapture(message.snapshot, sender).then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
    }

    return undefined;
  });
});
