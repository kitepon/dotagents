import { homedir } from 'node:os';
import { join } from 'node:path';

// 第三者製品の公式配布先と工場の導入対象だけを所有する。
export const JEV_PRODUCTS = Object.freeze({
  'jev-ultrafast': { repository: 'https://github.com/browser-use/jev-ultrafast.git' },
  'agent-desktop': { repository: 'https://github.com/lahfir/agent-desktop.git', os: 'darwin' },
  'browser-harness': { repository: 'https://github.com/browser-use/browser-harness.git' },
});
export const jevCheckout = (id, home = homedir()) => join(home, 'Developer', id);
export const jevSupported = (id, platform = process.platform) => !JEV_PRODUCTS[id].os || JEV_PRODUCTS[id].os === platform;
