'use strict';

// Runs as an isolated-world content script. It is the only part with access to chrome.storage and relays settings
// to adblock.js, which runs in the page itself.

function pushSettings() {
    chrome.storage.local.get(['bannerVisible', 'adTime'], function(result) {
        window.postMessage({
            type: 'NoBreaksSettings',
            settings: {
                BannerVisible: result.bannerVisible !== false,
                AdTime: Number(result.adTime) || 0
            }
        }, window.location.origin);
    });
}

// Development convenience: let a Twitch tab ask the extension to reload itself, so an edit can be picked up without
// clicking reload on chrome://extensions. See background.js.
window.addEventListener('message', function(event) {
    if (event.source === window && event.data && event.data.type === 'NoBreaksReload') {
        try {
            chrome.runtime.sendMessage('nobreaks-reload');
        } catch (err) {}
    }
});

// adblock.js reports the running total of blocked seconds whenever an ad ends.
window.addEventListener('message', function(event) {
    if (event.source === window && event.data && event.data.type === 'NoBreaksAdTime') {
        var adTime = Number(event.data.adTime);
        if (Number.isFinite(adTime) && adTime >= 0) {
            chrome.storage.local.set({ adTime: Math.round(adTime) });
        }
    }
});

// Re-push on any change so the popup toggle applies live and the counter stays in sync across tabs.
chrome.storage.onChanged.addListener(function(changes, area) {
    if (area === 'local') {
        pushSettings();
    }
});

pushSettings();
