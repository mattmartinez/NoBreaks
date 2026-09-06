# Playlist proxy

Twitch decides whether to put ads in a stream partly from where the request comes from, and it serves none in some regions. On channels where every player type carries the ad, asking from one of those regions is the only way to get a clean playlist. `server.js` does that: it fetches a channel's master playlist and returns it.

Only playlists go through here, a few kilobytes every couple of seconds. The video is fetched by the browser straight from Twitch's CDN, so this needs almost no bandwidth or CPU and adds no buffering.

## What a playlist is

Worth understanding, because it is the whole reason this costs so little to run and why ads are hard to remove in the first place.

Twitch delivers live video over HLS. The stream is not one long file. It is chopped into **segments**, each about two seconds of video, published one after another as the broadcast is encoded. A **playlist** is a small plain-text file, ending in `.m3u8`, that lists them. There are two kinds:

- The **master playlist** lists the quality options for a channel (1080p60, 720p, 480p, audio only) and gives a URL for each. The player reads it once when playback starts. This is what the proxy fetches and returns.
- A **media playlist**, one per quality, lists the URLs of the most recent segments, a rolling window of roughly the last minute. The player re-downloads it every couple of seconds to find out what is new.

So playback is a loop: read the media playlist, fetch the segments it names, play them, read it again. The playlists are text and measure in kilobytes. The segments are the actual video and measure in megabytes per minute.

**Ads live inside the media playlist.** When Twitch runs an ad break it splices the ad's segments into that list alongside the stream's own, and marks the region with a tag:

```
#EXT-X-DATERANGE:ID="stitched-ad-...",CLASS="twitch-stitched-ad",DURATION=30.000
```

The player cannot tell an ad segment from a stream segment. Both are ordinary video files served from the same CDN, and it simply plays whatever the list says, in order. This is called server-side ad insertion, and it is why blocking requests by hostname does not work: there is no separate ad server to block. The ad arrives inside the stream itself.

That is what NoBreaks looks for. It reads each media playlist as it goes past, checks for the `twitch-stitched-ad` marker, and when it finds one it substitutes a playlist for the same channel that does not have it.

And it is what "only the playlist is proxied" means. This server fetches those few kilobytes of text on your behalf, from a country where Twitch splices nothing in, and hands them back. Your browser still downloads every video segment directly from Twitch, exactly as it normally would. The proxy never sees or carries the video. That is why a bandwidth allowance meant for a website is far more than this will ever use, and why routing through another continent costs you no buffering: only the index takes the long way around, never the pictures.

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
