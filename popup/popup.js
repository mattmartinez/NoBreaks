'use strict';

var banner = document.getElementById('banner');
var adTime = document.getElementById('ad-time');
var proxy = document.getElementById('proxy');
var proxyState = document.getElementById('proxy-state');

function describeProxy(value) {
    var url = (value || '').trim();
    if (!url) {
        return 'Off. Enforced ad breaks are left alone.';
    }
    if (url.indexOf('https://') !== 0 || url.indexOf('{channel}') === -1) {
        return 'Ignored: needs an https url containing {channel}.';
    }
    return 'On. Used only when no ad-free copy is available.';
}

function formatSeconds(total) {
    var seconds = Math.max(0, Math.trunc(Number(total) || 0));
    var hours = Math.trunc(seconds / 3600);
    var minutes = Math.trunc((seconds % 3600) / 60);
    return (hours ? hours + 'h ' : '') + (minutes ? minutes + 'min ' : '') + (seconds % 60) + 's';
}

chrome.storage.local.get(['bannerVisible', 'adTime', 'proxyUrl'], function(result) {
    banner.checked = result.bannerVisible !== false;
    adTime.textContent = formatSeconds(result.adTime);
    proxy.value = typeof result.proxyUrl === 'string' ? result.proxyUrl : '';
    proxyState.textContent = describeProxy(proxy.value);
});

proxy.addEventListener('change', function() {
    var url = proxy.value.trim();
    proxy.value = url;
    proxyState.textContent = describeProxy(url);
    chrome.storage.local.set({ proxyUrl: url });
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
