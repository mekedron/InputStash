import { getSettings, saveCapture } from '../components/storage';
import type { InputStashMessage } from '../components/types';

export default defineBackground(() => {
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
