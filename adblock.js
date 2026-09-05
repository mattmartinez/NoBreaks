// NoBreaks - runs in the main world of every twitch.tv page (see manifest.json).
//
// Twitch stitches ads into the live stream on the server: while an ad plays, the media playlist the player polls
// lists ad segments, tagged with "stitched-ad" DATERANGE markers. The player fetches its playlists from a web
// worker, so this script wraps the Worker constructor, hooks fetch inside the worker and, whenever a playlist
// contains ads, requests the same stream as another player type ('embed' first, then 'thunderdome' which is
// limited to 480p) and hands the player that ad-free playlist instead. On channels where those variants carry ads
// too (Twitch's "Commercial break in progress" screen) the stream is left alone.
//
// Everything below the "Worker side" marker is copied into the worker as source text, so those functions may only
// reference each other and the globals created by declareOptions().

var NoBreaksSettings = {
    BannerVisible: true,
    AdTime: 0
};

// bridge.js owns chrome.storage and posts the settings on load and whenever they change.
window.addEventListener('message', function(event) {
    if (event.source === window && event.data && event.data.type === 'NoBreaksSettings' && event.data.settings) {
        Object.assign(NoBreaksSettings, event.data.settings);
    }
});

var adBlockDiv = null;
var adBlockStartTime = null;
var NativeWorker = window.Worker;

window.Worker = class Worker extends NativeWorker {
    constructor(scriptUrl, options) {
        // Twitch's player worker script lives on a CDN, so Twitch wraps it in a same-origin blob. Prepend our hook to
        // that blob's code and start the worker from the result. Other blob workers get the same treatment, which is
        // harmless: the hook only reacts to Twitch playlist urls.
        var url = String(scriptUrl);
        var isModule = !!(options && options.type === 'module');
        var originalScript = isModule || !url.startsWith('blob:') ? null : readBlobText(url);
        if (originalScript === null) {
            if (isModule && url.startsWith('blob:')) {
                console.warn('NoBreaks: a module worker was not hooked; ads may not be blocked.');
            }
            super(scriptUrl, options);
            return;
        }
        var workerScript = `
            ${declareOptions.toString()}
            ${isMediaPlaylistUrl.toString()}
            ${isMasterPlaylistUrl.toString()}
            ${withoutQuery.toString()}
            ${hookWorkerFetch.toString()}
            ${rememberStream.toString()}
            ${processM3U8.toString()}
            ${getAdFreeM3U8.toString()}
            ${getStreamForVariant.toString()}
            ${getStreamUrlForVariant.toString()}
            ${parseAttributes.toString()}
            ${getAccessToken.toString()}
            ${gqlRequest.toString()}
            declareOptions(self);
            DeviceID = ${JSON.stringify(getDeviceId())};
            hookWorkerFetch();
            ${originalScript}
        `;
        super(URL.createObjectURL(new Blob([workerScript], { type: 'text/javascript' })), options);
        this.addEventListener('message', onWorkerMessage);
        // A new player worker is a new playback session; whatever ad the previous one was blocking is over for us.
        hideBanner();
        // Never postMessage here: Twitch posts its configuration right after constructing the worker and the worker
        // treats the first message it receives as that configuration.
    }
};

function readBlobText(url) {
    // Blob urls are served from memory, so a synchronous request is instant.
    try {
        var request = new XMLHttpRequest();
        request.open('GET', url, false);
        request.send();
        return request.responseText;
    } catch (err) {
        return null;
    }
}

function getDeviceId() {
    // Twitch keeps its device id in localStorage; reusing it keeps our token requests consistent with the site's.
    try {
        var stored = localStorage.getItem('local_copy_unique_id');
        if (stored) {
            return stored.replace(/"/g, '');
        }
    } catch (err) {}
    return null;
}

function onWorkerMessage(e) {
    var key = e.data && e.data.key;
    if (key === 'ShowAdBlockBanner') {
        showBanner();
    } else if (key === 'HideAdBlockBanner') {
        hideBanner();
    }
}

function showBanner() {
    // The counter runs whether or not the banner is shown.
    if (adBlockStartTime === null) {
        adBlockStartTime = Date.now();
    }
    if (NoBreaksSettings.BannerVisible) {
        var banner = getAdBlockDiv();
        if (banner) {
            banner.style.display = 'block';
        }
    }
}

function hideBanner() {
    if (adBlockDiv) {
        adBlockDiv.style.display = 'none';
    }
    if (adBlockStartTime === null) {
        return;
    }
    var seconds = Math.round((Date.now() - adBlockStartTime) / 1000);
    adBlockStartTime = null;
    if (seconds >= 1) {
        NoBreaksSettings.AdTime += seconds;
        postMessage({
            type: 'NoBreaksAdTime',
            adTime: NoBreaksSettings.AdTime
        }, window.location.origin);
    }
}

function getAdBlockDiv() {
    if (adBlockDiv && adBlockDiv.isConnected) {
        return adBlockDiv;
    }
    var playerRootDiv = document.querySelector('.video-player');
    if (!playerRootDiv) {
        return null;
    }
    var overlay = playerRootDiv.querySelector('.nobreaks-overlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'nobreaks-overlay';
        overlay.style.display = 'none';
        var notice = document.createElement('div');
        notice.style.cssText = 'color: white; background-color: rgba(0, 0, 0, 0.8); position: absolute; top: 0px; left: 0px; padding: 5px;';
        var text = document.createElement('p');
        text.textContent = 'Skipping ad break...';
        notice.appendChild(text);
        overlay.appendChild(notice);
        playerRootDiv.appendChild(overlay);
    }
    adBlockDiv = overlay;
    return overlay;
}

// ---------------------------------------------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------------------------------------------

function declareOptions(scope) {
    scope.AdSignifier = 'stitched';
    scope.ClientID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // Twitch's public web client id
    scope.DeviceID = null;
    // Player types to request the stream as while the normal ('site') stream carries ads, tried in this order.
    // 'thunderdome' only offers qualities up to 480p.
    scope.FallbackPlayerTypes = ['embed', 'thunderdome'];
    scope.WasShowingAd = false;
    scope.StreamInfos = {}; // channel name -> stream info
    scope.StreamInfosByUrl = {}; // media playlist url (without query) -> stream info
    scope.EncodingCacheTimeout = 60000; // how long a fallback master playlist (and its token) is reused
    scope.AdRetryDelay = 5000; // how long a fallback that just served ads itself is left alone
}

function isMediaPlaylistUrl(url) {
    // <pop>.playlist.ttvnw.net/v1/playlist/..., formerly video-weaver.<pop>.hls.ttvnw.net/v1/playlist/...
    return url.includes('/v1/playlist/');
}

function isMasterPlaylistUrl(url) {
    // usher.ttvnw.net/api/v2/channel/hls/<channel>.m3u8 (unversioned /api/channel/hls/ until 2026).
    return /\/api\/(?:v\d+\/)?channel\/hls\//.test(url);
}

function withoutQuery(url) {
    return url.split('?')[0];
}

function hookWorkerFetch() {
    console.log('NoBreaks: hooked the player worker');
    var realFetch = fetch;
    fetch = async function(input, options) {
        var url = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
        if (isMediaPlaylistUrl(url)) {
            var playlistResponse = await realFetch(input, options);
            if (playlistResponse.status !== 200) {
                return playlistResponse;
            }
            var playlistText = await playlistResponse.clone().text();
            var resultText = playlistText;
            try {
                resultText = await processM3U8(url, playlistText, realFetch);
            } catch (err) {
                console.error('NoBreaks: failed to process a playlist, using it unmodified.', err);
            }
            if (!resultText || resultText === playlistText) {
                return playlistResponse;
            }
            var headers = new Headers(playlistResponse.headers);
            headers.delete('content-length');
            headers.delete('content-encoding');
            return new Response(resultText, { status: 200, headers: headers });
        }
        if (isMasterPlaylistUrl(url)) {
            var encodingsResponse = await realFetch(input, options);
            if (encodingsResponse.status === 200) {
                try {
                    rememberStream(url, await encodingsResponse.clone().text());
                } catch (err) {
                    console.error('NoBreaks: failed to parse a master playlist.', err);
                }
            }
            return encodingsResponse;
        }
        return realFetch.apply(this, arguments);
    };
}

function rememberStream(url, encodingsM3u8) {
    // Records which media playlist url belongs to which channel and variant.
    var match = /\/([^\/]+)\.m3u8$/.exec(new URL(url).pathname);
    if (!match) {
        return;
    }
    var channelName = match[1];
    var streamInfo = StreamInfos[channelName] || (StreamInfos[channelName] = {});
    streamInfo.ChannelName = channelName;
    streamInfo.UsherUrl = withoutQuery(url);
    streamInfo.UsherParams = new URL(url).search;
    streamInfo.Variants = {}; // media playlist url (without query) -> { Resolution, FrameRate, Video }
    streamInfo.FallbackCache = {}; // player type -> cached master playlist of that player type
    var lines = encodingsM3u8.split(/\r?\n/);
    for (var i = 0; i < lines.length - 1; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) {
            continue;
        }
        var uri = lines[i + 1].trim();
        if (!uri || uri.startsWith('#')) {
            continue;
        }
        var attributes = parseAttributes(lines[i]);
        streamInfo.Variants[withoutQuery(uri)] = {
            Resolution: attributes['RESOLUTION'] || null, // absent for audio only
            FrameRate: attributes['FRAME-RATE'],
            Video: attributes['VIDEO']
        };
        StreamInfosByUrl[withoutQuery(uri)] = streamInfo;
    }
}

async function processM3U8(url, textStr, realFetch) {
    // Returns an ad-free playlist for a media playlist that contains ads, or the playlist unchanged.
    var streamInfo = StreamInfosByUrl[withoutQuery(url)];
    if (!textStr || !streamInfo) {
        return textStr;
    }
    if (!textStr.includes(AdSignifier)) {
        if (WasShowingAd) {
            console.log('NoBreaks: ads finished');
            WasShowingAd = false;
            postMessage({ key: 'HideAdBlockBanner' });
        }
        return textStr;
    }
    var variant = streamInfo.Variants[withoutQuery(url)];
    for (var i = 0; i < FallbackPlayerTypes.length; i++) {
        var playerType = FallbackPlayerTypes[i];
        var adFreeText = null;
        try {
            adFreeText = await getAdFreeM3U8(streamInfo, variant, playerType, realFetch);
        } catch (err) {
            console.log('NoBreaks: failed to get an ad-free stream as ' + playerType, err);
        }
        if (adFreeText && !adFreeText.includes(AdSignifier)) {
            WasShowingAd = true;
            postMessage({ key: 'ShowAdBlockBanner' });
            return adFreeText;
        }
    }
    // Every variant carries ads as well; let the player show the normal stream and say so.
    if (WasShowingAd) {
        console.log('NoBreaks: no ad-free stream available');
        WasShowingAd = false;
        postMessage({ key: 'HideAdBlockBanner' });
    }
    return textStr;
}

async function getAdFreeM3U8(streamInfo, variant, playerType, realFetch) {
    // Master playlists are cached per player type for a while, so an ad costs one token request, not one per poll.
    // A player type whose stream just carried ads itself is left alone for a few seconds instead of hammering GQL.
    var cache = streamInfo.FallbackCache[playerType] || (streamInfo.FallbackCache[playerType] = { RequestTime: 0, Value: null, RetryAfter: 0 });
    if (cache.RetryAfter > Date.now()) {
        return null;
    }
    if (cache.Value && cache.RequestTime >= Date.now() - EncodingCacheTimeout) {
        try {
            var cachedResult = await getStreamForVariant(streamInfo, variant, cache.Value, playerType, realFetch);
            if (cachedResult) {
                return cachedResult;
            }
        } catch (err) {
            cache.Value = null;
        }
    }
    var accessTokenResponse = await getAccessToken(streamInfo.ChannelName, playerType, realFetch);
    if (accessTokenResponse.status !== 200) {
        return null;
    }
    var accessToken = await accessTokenResponse.json();
    var token = accessToken && accessToken.data ? accessToken.data.streamPlaybackAccessToken : null;
    if (!token || !token.value || !token.signature) {
        return null;
    }
    var urlInfo = new URL(streamInfo.UsherUrl + streamInfo.UsherParams);
    urlInfo.searchParams.set('sig', token.signature);
    urlInfo.searchParams.set('token', token.value);
    var encodingsM3u8Response = await realFetch(urlInfo.href);
    if (encodingsM3u8Response.status !== 200) {
        return null;
    }
    console.log('NoBreaks: blocking ads as ' + playerType);
    return getStreamForVariant(streamInfo, variant, await encodingsM3u8Response.text(), playerType, realFetch);
}

async function getStreamForVariant(streamInfo, variant, encodingsM3u8, playerType, realFetch) {
    var cache = streamInfo.FallbackCache[playerType];
    cache.RequestTime = Date.now();
    cache.Value = encodingsM3u8;
    var streamM3u8Url = getStreamUrlForVariant(encodingsM3u8, variant);
    if (!streamM3u8Url) {
        cache.Value = null;
        return null;
    }
    var streamM3u8Response = await realFetch(streamM3u8Url);
    if (streamM3u8Response.status !== 200) {
        cache.Value = null;
        return null;
    }
    var m3u8Text = await streamM3u8Response.text();
    if (!m3u8Text || m3u8Text.includes(AdSignifier)) {
        cache.Value = null;
        cache.RetryAfter = Date.now() + AdRetryDelay;
    }
    return m3u8Text;
}

function getStreamUrlForVariant(encodingsM3u8, variant) {
    // Picks the variant matching the one the player is playing: same resolution (and ideally frame rate), else the
    // first (highest quality) video variant. Audio-only playback only ever gets the audio-only variant.
    var lines = encodingsM3u8.split(/\r?\n/);
    var firstUrl = null;
    var matchedUrl = null;
    var wantsVideo = !variant || !!variant.Resolution;
    for (var i = 0; i < lines.length - 1; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF')) {
            continue;
        }
        var uri = lines[i + 1].trim();
        if (!uri || uri.startsWith('#')) {
            continue;
        }
        var attributes = parseAttributes(lines[i]);
        if (!wantsVideo) {
            if (!attributes['RESOLUTION'] && attributes['VIDEO'] == variant.Video) {
                return uri;
            }
            continue;
        }
        if (!attributes['RESOLUTION']) {
            continue;
        }
        if (firstUrl === null) {
            firstUrl = uri;
        }
        if (!variant || attributes['RESOLUTION'] != variant.Resolution) {
            continue;
        }
        if (attributes['FRAME-RATE'] == variant.FrameRate) {
            return uri;
        }
        if (matchedUrl === null) {
            matchedUrl = uri;
        }
    }
    return wantsVideo ? (matchedUrl || firstUrl) : null;
}

function parseAttributes(str) {
    return Object.fromEntries(
        str.split(/(?:^|,)((?:[^=]*)=(?:"[^"]*"|[^,]*))/)
        .filter(Boolean)
        .map(x => {
            const idx = x.indexOf('=');
            const key = x.substring(0, idx);
            const value = x.substring(idx + 1);
            const num = Number(value);
            return [key, Number.isNaN(num) ? value.startsWith('"') ? JSON.parse(value) : value : num];
        }));
}

function getAccessToken(channelName, playerType, realFetch) {
    var query = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature    __typename  }  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature    __typename  }}';
    return gqlRequest({
        operationName: 'PlaybackAccessToken_Template',
        query: query,
        variables: {
            isLive: true,
            login: channelName,
            isVod: false,
            vodID: '',
            playerType: playerType
        }
    }, realFetch);
}

function gqlRequest(body, realFetch) {
    if (!DeviceID) {
        var characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
        DeviceID = '';
        for (var i = 0; i < 32; i++) {
            DeviceID += characters.charAt(Math.floor(Math.random() * characters.length));
        }
    }
    return realFetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: {
            'Client-ID': ClientID,
            'Device-ID': DeviceID,
            'X-Device-Id': DeviceID
        }
    });
}
