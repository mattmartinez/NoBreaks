# Playlist proxy

Twitch decides whether to put ads in a stream partly from where the request comes from, and it serves none in some regions. On channels where every player type carries the ad, asking from one of those regions is the only way to get a clean playlist. `server.js` does that: it fetches a channel's master playlist and returns it.

Only playlists go through here, a few kilobytes every couple of seconds. The video is fetched by the browser straight from Twitch's CDN, so this needs almost no bandwidth or CPU and adds no buffering.

## Running it

Node 18 or newer, no dependencies:

```
PORT=8080 PROXY_KEY=some-long-random-string node server.js
```

Then in the NoBreaks popup, set the proxy to:

```
https://your-host/playlist/{channel}.m3u8?key=some-long-random-string
```

and reload the Twitch tab. `{channel}` is filled in for you.

Set `PROXY_KEY` if the server is reachable from the internet, otherwise anyone who finds it can use it. Check it is alive with `curl https://your-host/health`.

## Requirements

- **HTTPS.** Twitch is served over HTTPS, so the browser refuses to read a plain HTTP url, and NoBreaks ignores anything that is not `https://`. Put the server behind something that terminates TLS (Caddy does it automatically) or host it somewhere that provides HTTPS for you.
- **Cross-origin reads.** The request is made by the Twitch page, so the response needs an `Access-Control-Allow-Origin` header. The server sends `https://www.twitch.tv` by default; override with `ALLOW_ORIGIN`.

## Choosing where to run it

Which regions are ad-free changes as Twitch adjusts, so test rather than assume. Most providers bill by the hour, so trying a region costs cents.

To test one, run the server there and, while a channel is in an ad break, ask it for that channel and look for the ad marker:

```
curl -s "https://your-host/playlist/somechannel.m3u8?key=..." | head -5
```

That returns the master playlist. To check the actual stream for ads, fetch one of the variant URLs it lists and grep it:

```
curl -s "<variant url from above>" | grep -c stitched
```

`0` means that region is serving an ad-free stream for that break, which is what you want. A number above zero means ads are stamped in there too; try another region.

## What this does not do

The playlist is for a logged-out session. Anything tied to your account will not apply to the video, including subscriber ad-free perks you already pay for and subscriber-only streams. Chat is unaffected.

The proxy sees which channels you watch. Run your own rather than trusting someone else's.
