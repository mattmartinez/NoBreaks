// NoBreaks - runs in the main world of every twitch.tv page (see manifest.json).
//
// Twitch stitches ads into the live stream on the server: while an ad plays, the media playlist the player polls
// lists ad segments, tagged with "stitched-ad" DATERANGE markers. The player fetches its playlists from a web
// worker, so this script wraps the Worker constructor, hooks fetch inside the worker and, whenever a playlist
// contains ads, requests the same stream as another player type ('embed' first, then 'thunderdome' which is
// limited to 480p) and hands the player that ad-free playlist instead. On channels where those variants carry ads
// too (Twitch's "Commercial break in progress" screen) there is no ad-free copy to swap in and the break is left
// alone.
//
// The normal stream and the alternate one do not share a timeline. When the break ends and the player is handed
// back, it is paused and resumed through Twitch's own player instance so it rejoins the live edge instead of
// waiting for segments that never arrive.
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
var playerWorkers = [];

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
            ${debugLog.toString()}
            ${summarisePlaylist.toString()}
            ${setBanner.toString()}
            ${giveUpOnThisBreak.toString()}
            ${bestHeightIn.toString()}
            ${getStickyM3U8.toString()}
            ${getAdFreeM3U8.toString()}
            ${getTwitchEncodings.toString()}
            ${getStreamForVariant.toString()}
            ${getStreamUrlForVariant.toString()}
            ${parseAttributes.toString()}
            ${getAccessToken.toString()}
            ${gqlRequest.toString()}
            declareOptions(self);
            DeviceID = ${JSON.stringify(getDeviceId())};
            DebugEnabled = ${JSON.stringify(getDebugEnabled())};
            self.addEventListener('message', function(e) {
                // Sent by the page when a swap has left the player unable to play. Twitch's own worker code below
                // ignores anything it does not recognise.
                if (e.data && e.data.key === 'NoBreaksGiveUp') {
                    giveUpOnThisBreak();
                }
            });
            hookWorkerFetch();
            ${originalScript}
        `;
        super(URL.createObjectURL(new Blob([workerScript], { type: 'text/javascript' })), options);
        NoBreaksDebug.workerSource = workerScript;
        playerWorkers.push(this);
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

function getDebugEnabled() {
    // Set localStorage.nobreaks_debug = '1' on a Twitch tab and reload to turn introspection on.
    try {
        return localStorage.getItem('nobreaks_debug') === '1';
    } catch (err) {}
    return false;
}

// Everything the extension knows, for a human or a script to read: what the worker decided and what the player did.
var NoBreaksDebug = window.NoBreaksDebug = {
    enabled: getDebugEnabled(),
    decisions: [],   // one per worker decision
    player: [],      // one per second of player state
    limit: 4000,
    // What this loaded copy can actually do. Reading a version string has twice led to a session spent debugging a
    // build that was never loaded, so ask the code itself.
    build: function() {
        var worker = this.workerSource || '';
        return {
            androidFallback: worker.indexOf("'autoplay'") !== -1 && worker.indexOf('android') !== -1,
            qualityShift: typeof lowerQualityTo === 'function' && worker.indexOf('LowerQuality') !== -1,
            bailout: typeof watchForBrokenPlayback === 'function'
        };
    },
    workerSource: null,   // the exact code the player's worker is running, set when it is created
    // What the player is showing and what it could show, which is what decides whether a smaller ad-free copy is usable.
    quality: function() {
        var player = findMediaPlayer();
        if (!player || typeof player.getQualities !== 'function') {
            return 'no player';
        }
        var current = typeof player.getQuality === 'function' ? player.getQuality() : null;
        return {
            current: current ? current.group + ' ' + current.width + 'x' + current.height : null,
            auto: typeof player.isAutoQualityMode === 'function' ? player.isAutoQualityMode() : null,
            available: (player.getQualities() || []).map(function(q) { return q.group + ' ' + q.width + 'x' + q.height; }),
            beforeBreak: qualityBeforeBreak,
            canSet: !!findQualityController()
        };
    },
    clear: function() { this.decisions.length = 0; this.player.length = 0; return 'cleared'; },
    // Compact view: the decisions, newest last, as readable lines.
    tail: function(n) {
        return this.decisions.slice(-(n || 40)).map(function(d) {
            var when = new Date(d.t).toTimeString().slice(0, 8);
            var rest = [];
            for (var k in d) {
                if (k !== 't' && k !== 'n' && k !== 'event') { rest.push(k + '=' + JSON.stringify(d[k])); }
            }
            return when + '  ' + d.event + '  ' + rest.join(' ');
        });
    },
    // Player state around a moment, to line up with a decision.
    playerTail: function(n) {
        return this.player.slice(-(n || 30)).map(function(p) {
            return p.at + ' t=' + p.t + (p.paused ? ' PAUSED' : '') + ' rs' + p.rs + ' buf' + p.buf + ' ' + p.size + (p.videos > 1 ? ' videos=' + p.videos : '') +
                (p.banner ? ' BANNER' : '') + (p.ad ? ' ADUI' : '') + (p.purple ? ' PURPLE' : '');
        });
    },
    summary: function() {
        var byEvent = {};
        this.decisions.forEach(function(d) { byEvent[d.event] = (byEvent[d.event] || 0) + 1; });
        var frozen = this.player.filter(function(p) { return p.frozen; }).length;
        return {
            enabled: this.enabled, decisions: this.decisions.length, byEvent: byEvent,
            playerSamples: this.player.length, frozenSeconds: frozen,
            pausedSeconds: this.player.filter(function(p) { return p.paused; }).length
        };
    }
};

function recordDecision(entry) {
    var log = NoBreaksDebug.decisions;
    log.push(entry);
    if (log.length > NoBreaksDebug.limit) {
        log.shift();
    }
}

function startPlayerSampler() {
    if (!NoBreaksDebug.enabled || NoBreaksDebug.sampler) {
        return;
    }
    var lastTime = null;
    NoBreaksDebug.sampler = setInterval(function() {
        var video = findStreamVideo();
        var banner = document.querySelector('.nobreaks-overlay');
        var time = video ? Math.round(video.currentTime * 10) / 10 : null;
        var sample = {
            at: new Date().toTimeString().slice(0, 8),
            t: time,
            paused: video ? video.paused : null,
            rs: video ? video.readyState : null,
            size: video ? video.videoWidth + 'x' + video.videoHeight : null,
            videos: document.querySelectorAll('video').length,
            net: video ? video.networkState : null,
            buf: (video && video.buffered.length) ? Math.round((video.buffered.end(video.buffered.length - 1) - video.currentTime) * 10) / 10 : null,
            banner: !!(banner && banner.style.display !== 'none'),
            ad: document.querySelectorAll('[data-a-target="video-ad-countdown"],[data-a-target="video-ad-label"]').length > 0,
            purple: (document.body.innerText || '').indexOf('Commercial break in progress') !== -1,
            frozen: video ? (time === lastTime && !video.paused) : false
        };
        lastTime = time;
        var log = NoBreaksDebug.player;
        log.push(sample);
        if (log.length > NoBreaksDebug.limit) {
            log.shift();
        }
    }, 1000);
}

if (NoBreaksDebug.enabled) {
    startPlayerSampler();
    console.log('NoBreaks: introspection on. window.NoBreaksDebug.tail() / .playerTail() / .summary()');
}

function onWorkerMessage(e) {
    var key = e.data && e.data.key;
    if (key === 'NoBreaksDebug') {
        recordDecision(e.data.entry);
        return;
    }
    if (key === 'ShowAdBlockBanner') {
        showBanner();
    } else if (key === 'HideAdBlockBanner') {
        hideBanner();
    } else if (key === 'ResyncPlayer') {
        resyncPlayer();
    } else if (key === 'LowerQuality') {
        lowerQualityTo(e.data.height);
    } else if (key === 'RestoreQuality') {
        restoreQuality();
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

var lastResync = 0;
var resyncTimer = null;
var resyncTries = 0;

function resyncPlayer() {
    // Recover the player after a real skip: pausing and resuming Twitch's own player instance makes it drop the
    // alternate session's timeline and rejoin the live edge.
    //
    // Never do this while Twitch is showing its own ad. A client-side ad (the "ad break" overlay with a countdown)
    // holds the player, and pausing it there also pauses the ad itself, so its countdown never finishes and the stream
    // locks up for good. While that overlay is up we wait and check again; once it clears we resync, so a genuine
    // hand-back still recovers even if the overlay lingers a moment past the playlist going clean (and we rejoin the
    // live edge after a break we could not skip). Several player workers can ask at once, so only one wait runs at a
    // time and nudges are debounced.
    if (resyncTimer !== null) {
        return;
    }
    if (isTwitchAdShowing()) {
        if (resyncTries++ > 90) {
            resyncTries = 0;
            return;
        }
        resyncTimer = setTimeout(function() {
            resyncTimer = null;
            resyncPlayer();
        }, 2000);
        return;
    }
    resyncTries = 0;
    if (Date.now() - lastResync < 2000) {
        return;
    }
    var player = findMediaPlayer();
    if (!player) {
        return;
    }
    lastResync = Date.now();
    try {
        player.pause();
        player.play();
    } catch (err) {}
}

function isTwitchAdShowing() {
    return !!document.querySelector('[data-a-target="video-ad-countdown"], [data-a-target="video-ad-label"]');
}

function findMediaPlayer() {
    // Twitch keeps its player instance in the props of a React component; walk the fiber tree from the root to it.
    var root = document.querySelector('#root');
    if (!root) {
        return null;
    }
    var rootKey = Object.keys(root).find(function(k) { return k.startsWith('__reactContainer$'); });
    var stack = rootKey && root[rootKey] ? [root[rootKey]] : [];
    var visited = 0;
    while (stack.length && visited++ < 200000) {
        var node = stack.pop();
        var props = node.memoizedProps;
        if (props && props.mediaPlayerInstance) {
            return props.mediaPlayerInstance;
        }
        if (node.child) {
            stack.push(node.child);
        }
        if (node.sibling) {
            stack.push(node.sibling);
        }
    }
    return null;
}

function findQualityController() {
    // Quality is read and written through two different objects, which is not obvious and was measured on a live
    // stream. The media player instance reports the quality list and the current one, but its setQuality is accepted
    // and does nothing: the picture stayed 1920x1080. The React component that owns the quality menu has only a
    // setQuality, and that one does move the picture, to 640x360. So: read from the player, write through this.
    var root = document.querySelector('#root');
    if (!root) {
        return null;
    }
    var rootKey = Object.keys(root).find(function(k) { return k.startsWith('__reactContainer$'); });
    var stack = rootKey && root[rootKey] ? [root[rootKey]] : [];
    var visited = 0;
    while (stack.length && visited++ < 200000) {
        var node = stack.pop();
        var instance = node.stateNode;
        if (instance && typeof instance.setQuality === 'function') {
            return instance;
        }
        if (node.child) {
            stack.push(node.child);
        }
        if (node.sibling) {
            stack.push(node.sibling);
        }
    }
    return null;
}

function findStreamVideo() {
    // During an ad break Twitch has a second <video> on the page, and at the end of one break the first match for
    // '.video-player video' was that other element, sitting paused and empty, which read as a broken player. The
    // player instance knows which element is the stream, so ask it, and only fall back to the selector.
    var player = findMediaPlayer();
    if (player && typeof player.getHTMLVideoElement === 'function') {
        try {
            var el = player.getHTMLVideoElement();
            if (el) {
                return el;
            }
        } catch (err) {}
    }
    return document.querySelector('.video-player video');
}

var qualityBeforeBreak = null;
var brokenChecks = 0;
var lastBailout = 0;

function lowerQualityTo(height) {
    // The ad-free copy of the stream only comes in smaller sizes, so move the player down to one of them for the
    // break. What the viewer had is remembered once, and put back when the break ends.
    var player = findMediaPlayer();
    var controller = findQualityController();
    if (!player || !controller || typeof player.getQualities !== 'function') {
        return;
    }
    try {
        var options = player.getQualities() || [];
        var wanted = null;
        for (var i = 0; i < options.length; i++) {
            if (options[i].height <= height && (!wanted || options[i].height > wanted.height)) {
                wanted = options[i];
            }
        }
        if (!wanted) {
            // Nothing small enough to be worth the move.
            return;
        }
        var current = typeof player.getQuality === 'function' ? player.getQuality() : null;
        if (current && current.group === wanted.group) {
            return;
        }
        if (qualityBeforeBreak === null) {
            qualityBeforeBreak = {
                group: current ? current.group : null,
                auto: typeof player.isAutoQualityMode === 'function' ? player.isAutoQualityMode() : false
            };
        }
        // Choosing a quality turns auto off by itself, so there is nothing to switch off first.
        controller.setQuality(wanted.group);
        if (NoBreaksDebug.enabled) {
            recordDecision({ n: 0, t: Date.now(), event: 'quality-dropped', from: qualityBeforeBreak.group, to: wanted.group });
        }
        console.log('NoBreaks: dropped to ' + wanted.group + ' so the ad-free copy can be used');
    } catch (err) {}
}

function restoreQuality() {
    var wanted = qualityBeforeBreak;
    qualityBeforeBreak = null;
    if (wanted === null) {
        return;
    }
    var player = findMediaPlayer();
    var controller = findQualityController();
    try {
        if (wanted.auto && player && typeof player.setAutoQualityMode === 'function') {
            // Turning auto back on lets the player climb back to what it can carry, which is where it started.
            player.setAutoQualityMode(true);
        } else if (wanted.group && controller) {
            controller.setQuality(wanted.group);
        }
        if (NoBreaksDebug.enabled) {
            recordDecision({ n: 0, t: Date.now(), event: 'quality-restored', to: wanted.auto ? 'auto' : wanted.group });
        }
        console.log('NoBreaks: quality restored');
    } catch (err) {}
}

function watchForBrokenPlayback() {
    // Only meaningful while we are serving a swapped stream, which is exactly when the banner is up.
    setInterval(function() {
        var banner = adBlockDiv && adBlockDiv.style.display !== 'none';
        if (!banner) {
            brokenChecks = 0;
            return;
        }
        var video = findStreamVideo();
        if (!video) {
            return;
        }
        // Either the player said outright that it failed, or it has been sitting with nothing to play.
        var broken = !!video.error || (video.readyState === 0 && video.paused);
        brokenChecks = broken ? brokenChecks + 1 : 0;
        if (brokenChecks < 4 || Date.now() - lastBailout < 30000) {
            return;
        }
        brokenChecks = 0;
        lastBailout = Date.now();
        console.log('NoBreaks: the swapped stream will not play, going back to the normal one');
        for (var i = 0; i < playerWorkers.length; i++) {
            try {
                playerWorkers[i].postMessage({ key: 'NoBreaksGiveUp' });
            } catch (err) {}
        }
        hideBanner();
        reloadPlayer();
    }, 1000);
}

function reloadPlayer() {
    // A full reload rather than a pause/resume: the player has to throw away what it could not decode and start again.
    var root = document.querySelector('#root');
    var rootKey = root && Object.keys(root).find(function(k) { return k.indexOf('__reactContainer') === 0; });
    if (!rootKey) {
        return;
    }
    var stack = [root[rootKey]];
    var visited = 0;
    while (stack.length && visited++ < 200000) {
        var node = stack.pop();
        if (!node) {
            continue;
        }
        var instance = node.stateNode;
        if (instance && instance.setSrc && instance.setInitialPlaybackSettings) {
            try {
                instance.setSrc({ isNewMediaPlayerInstance: true, refreshAccessToken: true });
            } catch (err) {}
            return;
        }
        if (node.child) {
            stack.push(node.child);
        }
        if (node.sibling) {
            stack.push(node.sibling);
        }
    }
}

var stuckChecks = 0;
var nudgeReloads = 0;

function watchDroppedQuality() {
    // The rendition switch that follows a quality drop can land the player on a new timeline while it is in ad mode:
    // it sits paused at 0 with data buffered and never starts, and the ad overlay it is waiting on never moves
    // because it never advances. Measured once at 52 seconds of frozen frame, ended only by the hand-back. The
    // ordinary resync is deferred while the overlay shows, for a good reason, so this nudges the player directly,
    // gently first: ask it to play, then seek to where the data is, then start it over.
    setInterval(function() {
        if (qualityBeforeBreak === null) {
            stuckChecks = 0;
            nudgeReloads = 0;
            return;
        }
        var video = findStreamVideo();
        if (!video) {
            return;
        }
        // Paused with data buffered but not even the current frame decodable: it is not going to start on its own.
        // Position is not part of it, because the seek below moves the position and the player may still not start.
        var buffered = video.buffered && video.buffered.length > 0;
        var stuck = video.paused && video.readyState < 3 && buffered;
        stuckChecks = stuck ? stuckChecks + 1 : 0;
        if (stuckChecks === 2) {
            nudge('play', video);
            try {
                var player = findMediaPlayer();
                if (player && typeof player.play === 'function') {
                    player.play();
                }
            } catch (err) {}
        } else if (stuckChecks === 4) {
            nudge('seek', video);
            try {
                video.currentTime = video.buffered.start(0) + 0.1;
                if (typeof video.play === 'function') {
                    video.play();
                }
            } catch (err) {}
        } else if (stuckChecks === 7 && nudgeReloads < 1) {
            nudge('reload', video);
            nudgeReloads++;
            stuckChecks = 0;
            reloadPlayer();
        }
    }, 1000);
}

function nudge(step, video) {
    if (NoBreaksDebug.enabled) {
        recordDecision({
            n: 0, t: Date.now(), event: 'nudge', step: step, rs: video.readyState,
            buffered: video.buffered.length ? Math.round(video.buffered.start(0) * 10) / 10 + '-' + Math.round(video.buffered.end(video.buffered.length - 1) * 10) / 10 : 'none'
        });
    }
    console.log('NoBreaks: the player did not start after the quality change, nudging it (' + step + ')');
}

watchForBrokenPlayback();
watchDroppedQuality();

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
    // Player types to request the stream as while the normal ('site') stream carries ads, tried in this order, best
    // picture first. 'embed' offers the full range but is marked on channels where Twitch enforces the break;
    // 'thunderdome' stops at 480p; 'autoplay' is asked for as an android device and tops out at 360p, but it is the
    // only one that still comes back without the ad when every other player type is marked.
    scope.FallbackPlayerTypes = ['embed', 'thunderdome', 'autoplay'];
    scope.WasShowingAd = false;
    scope.BreakEnforced = false; // set once a break proved to carry ads on every fallback; reset when the break ends
    scope.StreamInfos = {}; // channel name -> stream info
    scope.StreamInfosByUrl = {}; // media playlist url (without query) -> stream info
    scope.EncodingCacheTimeout = 60000; // how long a fallback master playlist (and its token) is reused
    scope.AdRetryDelay = 5000; // how long a fallback that just served ads itself is left alone
    scope.DebugEnabled = false;
    scope.DebugSeq = 0;
}

function debugLog(event, data) {
    if (!DebugEnabled) {
        return;
    }
    var entry = { n: ++DebugSeq, t: Date.now(), event: event };
    for (var k in data) {
        entry[k] = data[k];
    }
    postMessage({ key: 'NoBreaksDebug', entry: entry });
}

function summarisePlaylist(text) {
    // What a playlist actually contains, without shipping the whole thing to the page every couple of seconds.
    if (!text) {
        return null;
    }
    var lines = text.split(/\r?\n/);
    var live = 0, ad = 0, titles = {};
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('#EXTINF') !== 0) {
            continue;
        }
        var title = lines[i].slice(lines[i].indexOf(',') + 1).trim();
        if (title === 'live') {
            live++;
        } else {
            ad++;
            titles[title] = (titles[title] || 0) + 1;
        }
    }
    var seq = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    return {
        bytes: text.length,
        adTag: text.indexOf(AdSignifier) !== -1,
        live: live,
        adSegs: ad,
        adTitles: Object.keys(titles).slice(0, 3),
        prefetch: (text.match(/#EXT-X-TWITCH-PREFETCH:/g) || []).length,
        discontinuities: (text.match(/#EXT-X-DISCONTINUITY\b/g) || []).length,
        seq: seq ? Number(seq[1]) : null
    };
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
    var streamInfo = StreamInfos[channelName];
    if (!streamInfo) {
        streamInfo = StreamInfos[channelName] = {
            FallbackCache: {}, // player type -> cached master playlist of that player type
            Sticky: null, // player type whose session the player is on for the current break, if it was moved
            CleanPolls: 0 // consecutive polls in which the normal stream was clean while the player was moved
        };
    }
    // Only the variant list is rebuilt. The player re-reads the master playlist mid-break when the quality changes,
    // and throwing the break state away there used to strand the player on the alternate session with the banner up.
    streamInfo.ChannelName = channelName;
    streamInfo.UsherUrl = withoutQuery(url);
    streamInfo.UsherParams = new URL(url).search;
    // media playlist url (without query) -> { Resolution, FrameRate, Video }. Entries are added, never removed: the
    // player keeps polling a playlist from an earlier master read, and a later read may list different renditions.
    streamInfo.Variants = streamInfo.Variants || {};
    var added = 0;
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
        if (!streamInfo.Variants[withoutQuery(uri)]) {
            added++;
        }
        streamInfo.Variants[withoutQuery(uri)] = {
            Resolution: attributes['RESOLUTION'] || null, // absent for audio only
            FrameRate: attributes['FRAME-RATE'],
            Video: attributes['VIDEO']
        };
        StreamInfosByUrl[withoutQuery(uri)] = streamInfo;
    }
    debugLog('master', {
        channel: channelName,
        params: (function() {
            // The request parameters other than the secrets, as fields, to tell one kind of master read from another.
            var out = {};
            new URL(url).searchParams.forEach(function(value, name) {
                if (name !== 'sig' && name !== 'token') {
                    out[name] = value;
                }
            });
            return out;
        })(),
        added: added,
        // Any stream entry without a size is kept verbatim: a playlist registered without one cannot be matched to a
        // fallback by size, and mid-break the player was seen polling exactly such a playlist.
        oddLines: lines.filter(function(l) { return l.startsWith('#EXT-X-STREAM-INF') && l.indexOf('RESOLUTION=') === -1; }),
        variants: Object.keys(streamInfo.Variants).map(function(u) {
            var v = streamInfo.Variants[u];
            return (v.Resolution || 'audio') + (v.FrameRate ? '@' + v.FrameRate : '') + (v.Video ? ' video=' + v.Video : '') + ' ' + u.slice(u.lastIndexOf('/') + 1, u.lastIndexOf('/') + 9);
        })
    });
}

async function processM3U8(url, textStr, realFetch) {
    // Returns the playlist the player should get for the media playlist it asked for: an ad-free one from another
    // session while the normal stream carries ads, otherwise its own.
    //
    // The player is moved at most twice per break: once onto an alternate session and once back. Once moved it stays
    // there even if that session starts carrying ads too, and it only comes back after the normal stream has been
    // clean for two polls in a row, because the ad marker flickers at pod boundaries. Every move is a timeline jump;
    // two moves in quick succession were seen to starve the player until it paused itself, and the single move back
    // is what the resync recovers.
    var key = withoutQuery(url);
    var streamInfo = StreamInfosByUrl[key];
    if (!textStr || !streamInfo) {
        return textStr;
    }
    var variant = streamInfo.Variants[key];
    var siteHasAd = textStr.includes(AdSignifier);
    debugLog('poll', {
        variant: variant && variant.Resolution ? variant.Resolution : 'audio',
        playlist: key.slice(key.lastIndexOf('/') + 1, key.lastIndexOf('/') + 9),
        video: variant ? variant.Video : null,
        site: summarisePlaylist(textStr),
        sticky: streamInfo.Sticky,
        cleanPolls: streamInfo.CleanPolls,
        enforced: BreakEnforced,
        showing: WasShowingAd
    });

    if (streamInfo.Sticky) {
        streamInfo.CleanPolls = siteHasAd ? 0 : streamInfo.CleanPolls + 1;
        if (streamInfo.CleanPolls < 2) {
            var stickyText = null;
            try {
                stickyText = await getStickyM3U8(streamInfo, variant, realFetch);
            } catch (err) {}
            if (stickyText) {
                debugLog('serve-sticky', { playerType: streamInfo.Sticky, served: summarisePlaylist(stickyText) });
                setBanner(!stickyText.includes(AdSignifier));
                return stickyText;
            }
            debugLog('sticky-session-gone', { playerType: streamInfo.Sticky });
            // That session is gone. Leave the rest of this break alone rather than move the player a third time.
            BreakEnforced = true;
        }
        debugLog('hand-back', { from: streamInfo.Sticky, siteHasAd: siteHasAd });
        postMessage({ key: 'RestoreQuality' });
        console.log('NoBreaks: back to the normal stream');
        streamInfo.Sticky = null;
        streamInfo.CleanPolls = 0;
        setBanner(false);
        postMessage({ key: 'ResyncPlayer' });
        if (!siteHasAd) {
            BreakEnforced = false;
        }
        return textStr;
    }

    if (!siteHasAd) {
        // Nothing to skip and the player is on its own stream, so the banner must be down whatever happened before.
        setBanner(false);
        BreakEnforced = false;
        if (key === streamInfo.AdKey) {
            // The playlist that carried the ad is clean again: the break is over. The player polls other playlists
            // during a break too, and those coming back clean says nothing about it.
            streamInfo.MismatchPolls = 0;
            streamInfo.AdKey = null;
        }
        return textStr;
    }
    streamInfo.AdKey = key;
    if (!BreakEnforced) {
        // A fallback that fails on the first poll of a break often works a moment later, and dropping the picture
        // quality is not free. Only spend it once the better copies have failed a few polls running.
        streamInfo.MismatchPolls = (streamInfo.MismatchPolls || 0) + 1;
        var waitingForQuality = false;
        for (var i = 0; i < FallbackPlayerTypes.length; i++) {
            var playerType = FallbackPlayerTypes[i];
            var adFreeText = null;
            try {
                adFreeText = await getAdFreeM3U8(streamInfo, variant, playerType, realFetch);
            } catch (err) {
                console.log('NoBreaks: failed to get an ad-free stream as ' + playerType, err);
            }
            debugLog('tried-fallback', {
                playerType: playerType,
                got: adFreeText ? summarisePlaylist(adFreeText) : null,
                clean: !!(adFreeText && !adFreeText.includes(AdSignifier))
            });
            if (adFreeText && !adFreeText.includes(AdSignifier)) {
                streamInfo.Sticky = playerType;
                streamInfo.CleanPolls = 0;
                streamInfo.MismatchPolls = 0;
                setBanner(true);
                return adFreeText;
            }
            var mismatch = streamInfo.FallbackCache[playerType] ? streamInfo.FallbackCache[playerType].Mismatch : 0;
            if (adFreeText === null && mismatch > 0) {
                // This copy is free of the ad but does not come in the quality being watched: the android stream stops
                // at 360p. So the break is not hopeless and must not be written off. Rather than sit through it, ask
                // the player to drop to a size the copy does have, and put the quality back when the break ends.
                waitingForQuality = true;
                if (streamInfo.MismatchPolls >= 3) {
                    debugLog('ask-lower-quality', { playerType: playerType, height: mismatch });
                    postMessage({ key: 'LowerQuality', height: mismatch });
                }
            }
        }
        // Every fallback carries ads as well: Twitch enforces ads on this channel. A fresh session sometimes looks
        // clean for a few seconds before it is marked too; chasing that is not worth the churn, so leave the rest of
        // this break alone. The player was never moved, so there is nothing to recover.
        if (waitingForQuality) {
            // An ad-free copy is there and the player has been asked to move to a size it comes in. Say nothing about
            // the break yet: the next poll should be for a variant that copy can answer.
            return textStr;
        }
        debugLog('enforced', { tried: FallbackPlayerTypes });
        console.log('NoBreaks: no ad-free stream available, leaving this break alone');
        BreakEnforced = true;
    }
    return textStr;
}

function giveUpOnThisBreak() {
    // Put every stream back on its own playlist and stop trying for the rest of this break.
    BreakEnforced = true;
    for (var channel in StreamInfos) {
        StreamInfos[channel].Sticky = null;
        StreamInfos[channel].CleanPolls = 0;
    }
    setBanner(false);
    postMessage({ key: 'RestoreQuality' });
    debugLog('gave-up', { reason: 'the player could not play the swapped stream' });
    console.log('NoBreaks: the player could not play the swapped stream, leaving this break alone');
}

function setBanner(show) {
    if (show && !WasShowingAd) {
        WasShowingAd = true;
        postMessage({ key: 'ShowAdBlockBanner' });
    } else if (!show && WasShowingAd) {
        WasShowingAd = false;
        postMessage({ key: 'HideAdBlockBanner' });
    }
}

async function getStickyM3U8(streamInfo, variant, realFetch) {
    // The media playlist of the session the player is already on, from that session's cached master playlist. Never
    // asks for a new session: that would be another move.
    var cache = streamInfo.FallbackCache[streamInfo.Sticky];
    if (!cache || !cache.Value) {
        return null;
    }
    var streamM3u8Url = getStreamUrlForVariant(cache.Value, variant, streamInfo.Sticky === 'autoplay');
    if (!streamM3u8Url) {
        return null;
    }
    var response = await realFetch(streamM3u8Url);
    if (response.status !== 200) {
        return null;
    }
    return (await response.text()) || null;
}

async function getAdFreeM3U8(streamInfo, variant, playerType, realFetch) {
    // Master playlists are cached per player type for a while, so an ad costs one token request, not one per poll.
    // A player type whose stream just carried ads itself is left alone for a few seconds instead of hammering GQL.
    var cache = streamInfo.FallbackCache[playerType] || (streamInfo.FallbackCache[playerType] = { RequestTime: 0, Value: null, RetryAfter: 0 });
    if (cache.RetryAfter > Date.now()) {
        return null;
    }
    var text = null;
    if (cache.Value && cache.RequestTime >= Date.now() - EncodingCacheTimeout) {
        try {
            text = await getStreamForVariant(streamInfo, variant, cache.Value, playerType, realFetch);
        } catch (err) {
            cache.Value = null;
        }
    }
    if (!text && cache.Value && cache.RequestTime >= Date.now() - EncodingCacheTimeout) {
        // A current master that simply cannot serve this size. Asking for another token would not change that.
        return null;
    }
    if (!text) {
        var encodingsM3u8 = await getTwitchEncodings(streamInfo, playerType, realFetch);
        if (!encodingsM3u8) {
            return null;
        }
        console.log('NoBreaks: trying to skip ads as ' + playerType);
        text = await getStreamForVariant(streamInfo, variant, encodingsM3u8, playerType, realFetch);
    }
    if (text && text.includes(AdSignifier)) {
        // This session carries ads; forget it and do not retry this player type for a moment.
        cache.Value = null;
        cache.RetryAfter = Date.now() + AdRetryDelay;
    }
    return text;
}

async function getTwitchEncodings(streamInfo, playerType, realFetch) {
    // Asks Twitch for the same stream as a different player type, the way its own embeds do.
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
    var response = await realFetch(urlInfo.href);
    return response.status === 200 ? await response.text() : null;
}

async function getStreamForVariant(streamInfo, variant, encodingsM3u8, playerType, realFetch) {
    // Fetches the media playlist of the given fallback session that matches the variant the player is playing.
    // Returns null when the session offers no suitable variant or the request fails.
    var cache = streamInfo.FallbackCache[playerType];
    cache.RequestTime = Date.now();
    cache.Value = encodingsM3u8;
    var streamM3u8Url = getStreamUrlForVariant(encodingsM3u8, variant, playerType === 'autoplay');
    if (!streamM3u8Url) {
        // The master is fine, it just does not come in the size being watched. Before asking anyone to change quality,
        // check the closest size it does have: there is no point moving the player for a copy that carries the ad too.
        cache.Mismatch = 0;
        var probeUrl = getStreamUrlForVariant(encodingsM3u8, variant, false);
        if (probeUrl) {
            var probe = await realFetch(probeUrl);
            if (probe.status === 200 && !(await probe.text()).includes(AdSignifier)) {
                cache.Mismatch = bestHeightIn(encodingsM3u8);
            }
        }
        return null;
    }
    cache.Mismatch = 0;
    var streamM3u8Response = await realFetch(streamM3u8Url);
    if (streamM3u8Response.status !== 200) {
        cache.Value = null;
        return null;
    }
    var m3u8Text = await streamM3u8Response.text();
    return m3u8Text || null;
}

function bestHeightIn(encodingsM3u8) {
    // Tallest video variant a copy of the stream offers.
    var lines = encodingsM3u8.split(/\r?\n/);
    var best = 0;
    for (var i = 0; i < lines.length; i++) {
        var match = /RESOLUTION=\d+x(\d+)/.exec(lines[i]);
        if (match && Number(match[1]) > best) {
            best = Number(match[1]);
        }
    }
    return best;
}

function getStreamUrlForVariant(encodingsM3u8, variant, mustMatchResolution) {
    // Picks the variant matching the one the player is playing: same resolution (and ideally frame rate), else the
    // first (highest quality) video variant. Audio-only playback only ever gets the audio-only variant.
    //
    // mustMatchResolution refuses to substitute a different resolution at all. The android stream stops at 640x360,
    // and handing 360p segments to a player whose master promised 1080p makes it give up with "this video is either
    // unavailable or not supported" (error 4000). Serving nothing is better than breaking playback.
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
    if (!wantsVideo) {
        return null;
    }
    return mustMatchResolution ? matchedUrl : (matchedUrl || firstUrl);
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
    // Twitch decides whether to stitch an ad into a stream partly from the player type and the platform it is asked
    // for. The 'autoplay' player asked for as an android device is the one combination still served without the ad on
    // channels where every web player type is marked; asked for as web, or as ios, it carries the ad like the rest.
    // Platform has to be a query variable for that: the query the site itself sends hardcodes "web".
    var platform = playerType === 'autoplay' ? 'android' : 'web';
    var query = 'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!, $platform: String!) {  streamPlaybackAccessToken(channelName: $login, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature    __typename  }  videoPlaybackAccessToken(id: $vodID, params: {platform: $platform, playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature    __typename  }}';
    return gqlRequest({
        operationName: 'PlaybackAccessToken_Template',
        query: query,
        variables: {
            isLive: true,
            login: channelName,
            isVod: false,
            vodID: '',
            playerType: playerType,
            platform: platform
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
