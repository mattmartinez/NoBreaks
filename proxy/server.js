'use strict';

// A minimal Twitch playlist proxy for NoBreaks.
//
// Run this on a small server in a region where Twitch serves no ads. It asks Twitch for a channel's master playlist
// from wherever it is running and hands that back. Only playlists pass through here, a few kilobytes every couple of
// seconds; the video segments are fetched by the browser straight from Twitch's CDN, so this needs almost no bandwidth.
//
// Node 18 or newer (it uses the built-in fetch). No dependencies.
//
//   PORT=8080 node server.js
//
// Then point NoBreaks at https://your-host/playlist/{channel}.m3u8
//
// Environment:
//   PORT          port to listen on (default 8080)
//   ALLOW_ORIGIN  CORS origin to allow (default https://www.twitch.tv)
//   PROXY_KEY     if set, requests must include ?key=<value>; use this so the endpoint is not an open relay

const http = require('http');

const PORT = Number(process.env.PORT) || 8080;
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || 'https://www.twitch.tv';
const PROXY_KEY = process.env.PROXY_KEY || '';
const CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // Twitch's public web client id

const ACCESS_TOKEN_QUERY =
    'query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {' +
    '  streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {    value    signature    __typename  }' +
    '  videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {    value    signature    __typename  }}';

async function getMasterPlaylist(channel) {
    // An anonymous token: no account of yours is involved, which is the point -- Twitch decides on ads from where this
    // request comes from.
    const tokenResponse = await fetch('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: { 'Client-ID': CLIENT_ID, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            operationName: 'PlaybackAccessToken_Template',
            query: ACCESS_TOKEN_QUERY,
            variables: { isLive: true, login: channel, isVod: false, vodID: '', playerType: 'site' }
        })
    });
    if (!tokenResponse.ok) {
        throw new Error('token request failed: ' + tokenResponse.status);
    }
    const payload = await tokenResponse.json();
    const token = payload && payload.data && payload.data.streamPlaybackAccessToken;
    if (!token || !token.value || !token.signature) {
        throw new Error('no access token for ' + channel);
    }

    const url = new URL('https://usher.ttvnw.net/api/v2/channel/hls/' + encodeURIComponent(channel) + '.m3u8');
    url.searchParams.set('allow_source', 'true');
    url.searchParams.set('fast_bread', 'true');
    url.searchParams.set('player', 'twitchweb');
    url.searchParams.set('supported_codecs', 'avc1');
    url.searchParams.set('sig', token.signature);
    url.searchParams.set('token', token.value);

    const playlistResponse = await fetch(url.href);
    if (playlistResponse.status === 404) {
        throw new Error(channel + ' is not live');
    }
    if (!playlistResponse.ok) {
        throw new Error('playlist request failed: ' + playlistResponse.status);
    }
    return await playlistResponse.text();
}

const server = http.createServer(async function (req, res) {
    res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    let requestUrl;
    try {
        requestUrl = new URL(req.url, 'http://localhost');
    } catch (err) {
        res.writeHead(400);
        return res.end('bad request');
    }

    if (requestUrl.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
    }

    if (PROXY_KEY && requestUrl.searchParams.get('key') !== PROXY_KEY) {
        res.writeHead(403);
        return res.end('forbidden');
    }

    // Only ever a Twitch channel name, so this cannot be pointed at anything else.
    const match = /^\/playlist\/([A-Za-z0-9_]{1,32})\.m3u8$/.exec(requestUrl.pathname);
    if (!match) {
        res.writeHead(404);
        return res.end('not found');
    }

    try {
        const playlist = await getMasterPlaylist(match[1].toLowerCase());
        res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-store'
        });
        res.end(playlist);
    } catch (err) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(String((err && err.message) || err));
    }
});

server.listen(PORT, function () {
    console.log('NoBreaks playlist proxy listening on ' + PORT + (PROXY_KEY ? ' (key required)' : ''));
});
