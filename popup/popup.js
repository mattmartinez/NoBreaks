'use strict';

var banner = document.getElementById('banner');
var adTime = document.getElementById('ad-time');

function formatSeconds(total) {
    var seconds = Math.max(0, Math.trunc(Number(total) || 0));
    var hours = Math.trunc(seconds / 3600);
    var minutes = Math.trunc((seconds % 3600) / 60);
    return (hours ? hours + 'h ' : '') + (minutes ? minutes + 'min ' : '') + (seconds % 60) + 's';
}

chrome.storage.local.get(['bannerVisible', 'adTime'], function(result) {
    banner.checked = result.bannerVisible !== false;
    adTime.textContent = formatSeconds(result.adTime);
});

banner.addEventListener('change', function() {
    chrome.storage.local.set({ bannerVisible: banner.checked });
});

// Keep the counter current while the popup is open.
chrome.storage.onChanged.addListener(function(changes, area) {
    if (area === 'local' && changes.adTime) {
        adTime.textContent = formatSeconds(changes.adTime.newValue);
    }
});
