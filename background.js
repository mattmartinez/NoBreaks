'use strict';

// Development convenience. Chrome only picks up changes to the extension's files when the extension is reloaded, which
// normally means clicking the reload button on chrome://extensions by hand. This lets a Twitch tab ask for that
// instead, so an edit can be tried without leaving the page:
//
//     window.postMessage({ type: 'NoBreaksReload' }, location.origin)
//
// bridge.js relays that here. Reloading the extension does not re-inject content scripts into tabs that are already
// open, so the tab still has to be refreshed afterwards to actually run the new code.

chrome.runtime.onMessage.addListener(function (message) {
    if (message === 'nobreaks-reload') {
        chrome.runtime.reload();
    }
});
