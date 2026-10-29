import { findServer, NATIVE_HOST, tourPath } from './gloss.js';

chrome.runtime.onInstalled.addListener(() => {
  // The button lights up on pull request pages only.
  chrome.action.disable();
  chrome.declarativeContent.onPageChanged.removeRules(undefined, () => {
    chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions: [
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { urlMatches: '^https://github\\.com/[^/]+/[^/]+/pull/\\d+' },
          }),
        ],
        actions: [new chrome.declarativeContent.ShowAction()],
      },
    ]);
  });
  chrome.contextMenus.create({
    id: 'open',
    title: 'Open in gloss',
    contexts: ['link'],
    targetUrlPatterns: ['https://github.com/*/*/pull/*'],
  });
});

chrome.action.onClicked.addListener((tab) => void openInGloss(tab.url, tab));
chrome.contextMenus.onClicked.addListener((info, tab) => void openInGloss(info.linkUrl, tab));

/** Asks the native host to start `gloss serve`; undefined when the host is not installed or fails. */
async function startServer() {
  try {
    const reply = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { type: 'start' });
    return typeof reply?.url === 'string' ? reply.url : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Opens the pull request at `url` in the running gloss server, starting it through the native
 * host when none is running. Without the host, a page explains how to start it and waits.
 * @param {string | undefined} url
 * @param {{ index: number, id?: number } | undefined} from  the tab it was opened from
 */
export async function openInGloss(url, from) {
  const path = tourPath(url);
  if (!path) {
    return;
  }
  const server = (await findServer()) ?? (await startServer());
  const target = server ? `${server}${path}` : chrome.runtime.getURL(`start.html?path=${encodeURIComponent(path)}`);
  await chrome.tabs.create({ url: target, index: from ? from.index + 1 : undefined, openerTabId: from?.id });
}
