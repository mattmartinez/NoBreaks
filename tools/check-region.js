'use strict';

// Is this machine in a region where Twitch serves no ads?
//
// Run it ON the server you are thinking of renting, during a stream you know takes ad breaks. It asks Twitch for the
// channel's playlist the same way the proxy does and reports whether an ad has been stitched into it.
//
//   node check-region.js <channel> [minutes]
//
// Read the result like this:
//   "ads: 0"  over a run that covered at least one real ad break  -> this region is clean, rent it
//   "ads: N"  with N above zero                                   -> Twitch serves ads here, try elsewhere
//
// Watch the channel yourself while this runs. If you never saw an ad break, the run proves nothing: the marker is only
// present during a break. The line printed each poll tells you which it is.

const CHANNEL = (process.argv[2] || '').toLowerCase();
const MINUTES = Number(process.argv[3] || 15);
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

if (!CHANNEL) {
    console.error('usage: node check-region.js <channel> [minutes]');
    process.exit(1);
}

const QUERY =
    'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {' +
    '  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature    __typename  }' +
    '  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature    __typename  }}';

async function masterPlaylist() {
    const tokenResponse = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            operationName: 'PlaybackAccessToken_Template', query: QUERY,
            variables: { isLive: true, login: CHANNEL, isVod: false, vodID: '', playerType: 'site' }
        })
    });
    if (!tokenResponse.ok) throw new Error('token ' + tokenResponse.status);
    const payload = await tokenResponse.json();
    const token = payload && payload.data && payload.data.streamPlaybackAccessToken;
    if (!token) throw new Error('no token (is the channel live?)');
    const url = new URL('https://usher.ttvnw.net/api/v2/channel/hls/' + encodeURIComponent(CHANNEL) + '.m3u8');
    url.searchParams.set('allow_source', 'true');
    url.searchParams.set('fast_bread', 'true');
    url.searchParams.set('player', 'twitchweb');
    url.searchParams.set('supported_codecs', 'avc1');
    url.searchParams.set('sig', token.signature);
    url.searchParams.set('token', token.value);
    const response = await fetch(url.href);
    if (response.status === 404) throw new Error(CHANNEL + ' is not live');
    if (!response.ok) throw new Error('playlist ' + response.status);
    return await response.text();
}

let master = null, masterAt = 0, variantUrl = null;
let polls = 0, adPolls = 0, breaks = 0, inBreak = false, errors = 0;

async function poll() {
    const at = new Date().toTimeString().slice(0, 8);
    try {
        if (!master || Date.now() - masterAt > 60000) {
            master = await masterPlaylist();
            masterAt = Date.now();
            variantUrl = master.split('\n').find(l => l.startsWith('http') && l.includes('.m3u8'));
        }
        const response = await fetch(variantUrl);
        if (!response.ok) { master = null; errors++; console.log(at + '  variant ' + response.status); return; }
        const text = await response.text();
        const hasAd = text.includes('stitched');
        polls++;
        if (hasAd) {
            adPolls++;
            if (!inBreak) { breaks++; inBreak = true; }
        } else {
            inBreak = false;
        }
        console.log(at + '  ' + (hasAd ? 'AD IN STREAM' : 'clean'));
    } catch (err) {
        errors++;
        console.log(at + '  error: ' + ((err && err.message) || err));
        master = null;
    }
}

function report() {
    console.log('\n--- ' + CHANNEL + ', ' + MINUTES + ' min ---');
    console.log('polls: ' + polls + '   ads: ' + adPolls + '   ad breaks seen: ' + breaks + '   errors: ' + errors);
    if (adPolls === 0 && breaks === 0) {
        console.log('\nNo ad was stitched in. That is only meaningful if the channel actually took a break while this');
        console.log('ran, so check that you saw one. If you did, this region is clean and worth renting.');
    } else if (adPolls === 0) {
        console.log('\nClean the whole time. Rent here.');
    } else {
        console.log('\nTwitch serves ads to this region. Try a different country.');
    }
    process.exit(0);
}

console.log('Checking ' + CHANNEL + ' from this machine for ' + MINUTES + ' minutes.');
console.log('Watch the stream yourself meanwhile, so you know a break really happened.\n');
poll();
const timer = setInterval(poll, 5000);
setTimeout(function () { clearInterval(timer); report(); }, MINUTES * 60 * 1000);
