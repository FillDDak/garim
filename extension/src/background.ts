/**
 * Tabs that were already open when the extension was installed, updated or re-enabled don't get the
 * content script until they are reloaded. Inject it into those AI-site tabs right away, so
 * pasting works without the user knowing to refresh.
 */
import './store'

async function ensureInjected() {
  for (const cs of chrome.runtime.getManifest().content_scripts ?? []) {
    if (!cs.matches?.length) continue
    const tabs = await chrome.tabs!.query({ url: cs.matches }).catch(() => [])
    for (const tab of tabs) {
      if (tab.id == null) continue
      // a tab loaded after install already has a live script that answers
      const alive = await chrome.tabs!.sendMessage(tab.id, { type: 'garim:ping' }).then(
        () => true,
        () => false,
      )
      if (alive) continue
      await chrome.scripting?.executeScript({ target: { tabId: tab.id }, files: cs.js ?? ['content.js'] }).catch(() => {})
    }
  }
}

// Runs whenever the service worker starts: after install, update, or re-enabling the extension
// (all of which leave open tabs without a working script). Cheap when nothing is missing.
void ensureInjected()
