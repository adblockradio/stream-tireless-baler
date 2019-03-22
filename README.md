# stream-tireless-baler
Universal and failsafe radio stream downloader as a Node Readable module

This module is part of the [Adblock Radio](https://www.adblockradio.com) project.

Build status: [![CircleCI](https://circleci.com/gh/adblockradio/stream-tireless-baler.svg?style=svg)](https://circleci.com/gh/adblockradio/stream-tireless-baler)

## Description

- you give a radio name, it fetches metadata using [radio-browser.info API](http://www.radio-browser.info/gui/#/)
- it supports regular HTTP/1.x audio streams, HTTP/0.9 streams, as well as playlists (M3U, SCPLS, ASF) and even M3U8/HLS streams.
- it ensures the download is still active, and restarts if stalled. run it production for months without worrying (hence the "tireless" in the repo's name)
- output events can be emitted in a way to have audio chunks of a given length (hence the repo's name "baler")
- it informs you about the length of the audio buffer of the stream.

![baler](http://www.machinisme-agricole.wikibis.com/illustrations/rundballenpresse.gif)

## Installation
```bash
npm install stream-tireless-baler
```
Your system needs those packages: [curl](https://curl.haxx.se/download.html) and [ffmpeg](https://ffmpeg.org/).

## Usage

```javascript
const { log } = require("abr-log")("dldemo");
const Dl = require("./dl.js").StreamDl;

const country = "France"; const name = "Radio Nova"; // example of classic HTTP stream

const dl = new Dl({ country: country, name: name, segDuration: 3 });

dl.on("metadata", function(data) {
	log.info("metadata received\n" + JSON.stringify(data, null, "\t"));
	//log.info("metadata url=" + data.url + " codec=" + data.codec + " ext=" + data.ext + " bitrate=" + data.bitrate);
});

dl.on("headers", function(headers) {
	log.info("stream headers\n" + JSON.stringify(headers, null, "\t"));
});

dl.on("data", function(obj) {
	log.debug("received " + obj.data.length + " bytes. tBuffer=" + obj.tBuffer.toFixed(2) + "s. newSeg=" + obj.newSegment);
});

dl.on("error", function(err) {
	log.warn("dl err=" + err);
});

setTimeout(function() {
	log.info("stopping stream download.");
	dl.stopDl();
}, 8000);
```

## Sample output
```
[2018-05-17T18:29:02.559Z] info dldemo: 	metadata received
{
	"country": "France",
	"name": "Radio Nova",
	"url": "http://novazz.ice.infomaniak.ch/novazz-128.mp3",
	"favicon": "http://www.nova.fr/sites/default/files/styles/ratio_1_8_xl/public/2017-06/Grand_Mix_460x460.jpg?itok=f3KYi58S",
	"codec": "MP3",
	"ext": "mp3",
	"bitrate": 16000,
	"hls": "0",
	"tags": "alternative,pop,world music,world music,world music",
	"votes": "476",
	"lastcheckok": "1",
	"homepage": "http://www.nova.fr/radionova/radio-nova"
}
[2018-05-17T18:29:02.562Z] debug dl: 	France_Radio Nova start dl url= http://novazz.ice.infomaniak.ch/novazz-128.mp3 codec MP3 (*.mp3), bitrate expected to be 16000
[2018-05-17T18:29:03.330Z] debug dl: 	France_Radio Nova got response code 200 and content-type audio/mpeg
[2018-05-17T18:29:03.331Z] info dldemo: 	stream headers
{
	"icy-br": "128",
	"icy-pub": "0",
	"icy-description": "Le grand mix !",
	"icy-audio-info": "ice-samplerate=44100;ice-bitrate=128;ice-channels=2",
	"icy-url": "",
	"instance-id": "150a2871b0f75c26b786d98eaaf8835e",
	"cache-control": "no-cache",
	"server": "AIS aise12.infomaniak.ch Streaming Server 7.7.6",
	"icy-genre": "",
	"expires": "Mon, 26 Jul 1997 05:00:00 GMT",
	"icy-metaint": "0",
	"pragma": "no-cache",
	"icy-name": "novazz",
	"connection": "close",
	"content-type": "audio/mpeg",
	"set-cookie": [
		"AISSessionId=5af2e18b5e79a99e_714851_1tLpKZRm_MTg1Ljc0LjcwLjI!_0000000NfIf; Path=/; Domain=novazz.ice.infomaniak.ch; Max-Age=6000; Expires=Thu, 17 May 2018 20:09:03 GMT"
	]
}
[2018-05-17T18:29:03.729Z] info dl: 	France_Radio Nova first data received at Thu May 17 2018 20:29:03 GMT+0200 (CEST)
[2018-05-17T18:29:03.730Z] debug dldemo: 	received 11680 bytes. tBuffer=0.73s. newSeg=true
[2018-05-17T18:29:03.731Z] debug dldemo: 	received 2920 bytes. tBuffer=0.91s. newSeg=false
[2018-05-17T18:29:03.733Z] debug dldemo: 	received 2920 bytes. tBuffer=1.09s. newSeg=false
[2018-05-17T18:29:03.737Z] debug dldemo: 	received 11680 bytes. tBuffer=1.82s. newSeg=false
[2018-05-17T18:29:03.738Z] debug dldemo: 	received 14600 bytes. tBuffer=2.73s. newSeg=false
[2018-05-17T18:29:03.739Z] debug dldemo: 	received 2920 bytes. tBuffer=2.91s. newSeg=false
[2018-05-17T18:29:03.740Z] debug dldemo: 	received 1280 bytes. tBuffer=3.09s. newSeg=false
[2018-05-17T18:29:03.740Z] debug dldemo: 	received 1640 bytes. tBuffer=3.09s. newSeg=true
[2018-05-17T18:29:03.744Z] debug dldemo: 	received 2920 bytes. tBuffer=3.27s. newSeg=false
[2018-05-17T18:29:03.746Z] debug dldemo: 	received 8760 bytes. tBuffer=3.81s. newSeg=false
[2018-05-17T18:29:03.746Z] debug dldemo: 	received 4300 bytes. tBuffer=4.08s. newSeg=false
[2018-05-17T18:29:04.125Z] debug dldemo: 	received 5840 bytes. tBuffer=4.07s. newSeg=false
[2018-05-17T18:29:04.126Z] debug dldemo: 	received 24540 bytes. tBuffer=6.17s. newSeg=false
[2018-05-17T18:29:04.126Z] debug dldemo: 	received 9040 bytes. tBuffer=6.17s. newSeg=true
[2018-05-17T18:29:04.133Z] debug dldemo: 	received 2920 bytes. tBuffer=6.34s. newSeg=false
[2018-05-17T18:29:04.133Z] debug dldemo: 	received 23279 bytes. tBuffer=7.80s. newSeg=false
[2018-05-17T18:29:04.524Z] debug dldemo: 	received 7300 bytes. tBuffer=7.86s. newSeg=false
[2018-05-17T18:29:04.525Z] debug dldemo: 	received 5461 bytes. tBuffer=9.21s. newSeg=false
[2018-05-17T18:29:04.525Z] debug dldemo: 	received 16079 bytes. tBuffer=9.21s. newSeg=true
[2018-05-17T18:29:04.960Z] debug dldemo: 	received 5840 bytes. tBuffer=9.14s. newSeg=false
[2018-05-17T18:29:04.961Z] debug dldemo: 	received 7116 bytes. tBuffer=9.58s. newSeg=false
[2018-05-17T18:29:05.397Z] debug dldemo: 	received 8760 bytes. tBuffer=9.69s. newSeg=false
[2018-05-17T18:29:05.398Z] debug dldemo: 	received 4197 bytes. tBuffer=9.95s. newSeg=false
[2018-05-17T18:29:05.724Z] debug dldemo: 	received 5840 bytes. tBuffer=9.99s. newSeg=false
[2018-05-17T18:29:05.725Z] debug dldemo: 	received 168 bytes. tBuffer=10.02s. newSeg=false
[2018-05-17T18:29:05.726Z] debug dldemo: 	received 261 bytes. tBuffer=10.02s. newSeg=true
[2018-05-17T18:29:06.123Z] debug dldemo: 	received 6270 bytes. tBuffer=10.01s. newSeg=false
[2018-05-17T18:29:06.522Z] debug dldemo: 	received 5840 bytes. tBuffer=9.98s. newSeg=false
[2018-05-17T18:29:06.523Z] debug dldemo: 	received 429 bytes. tBuffer=10.01s. newSeg=false
[2018-05-17T18:29:06.921Z] debug dldemo: 	received 5840 bytes. tBuffer=9.97s. newSeg=false
[2018-05-17T18:29:06.922Z] debug dldemo: 	received 847 bytes. tBuffer=10.02s. newSeg=false
[2018-05-17T18:29:07.322Z] debug dldemo: 	received 5840 bytes. tBuffer=9.99s. newSeg=false
[2018-05-17T18:29:07.323Z] debug dldemo: 	received 430 bytes. tBuffer=10.01s. newSeg=false
[2018-05-17T18:29:07.733Z] debug dldemo: 	received 6687 bytes. tBuffer=10.02s. newSeg=false
[2018-05-17T18:29:08.128Z] debug dldemo: 	received 5840 bytes. tBuffer=9.99s. newSeg=false
[2018-05-17T18:29:08.129Z] debug dldemo: 	received 430 bytes. tBuffer=10.02s. newSeg=false
[2018-05-17T18:29:08.526Z] debug dldemo: 	received 5840 bytes. tBuffer=9.99s. newSeg=false
[2018-05-17T18:29:08.527Z] debug dldemo: 	received 429 bytes. tBuffer=10.01s. newSeg=false
[2018-05-17T18:29:08.924Z] debug dldemo: 	received 3017 bytes. tBuffer=10.01s. newSeg=false
[2018-05-17T18:29:08.925Z] debug dldemo: 	received 3252 bytes. tBuffer=10.01s. newSeg=true
[2018-05-17T18:29:09.325Z] debug dldemo: 	received 6688 bytes. tBuffer=10.02s. newSeg=false
[2018-05-17T18:29:09.725Z] debug dldemo: 	received 5840 bytes. tBuffer=9.99s. newSeg=false
[2018-05-17T18:29:09.726Z] debug dldemo: 	received 429 bytes. tBuffer=10.02s. newSeg=false
[2018-05-17T18:29:10.127Z] debug dldemo: 	received 6270 bytes. tBuffer=10.01s. newSeg=false
[2018-05-17T18:29:10.449Z] info dldemo: 	stopping stream download.
[2018-05-17T18:29:10.451Z] debug dl: 	France_Radio Nova http request aborted on demand
[2018-05-17T18:29:10.452Z] warn dl: 	France_Radio Nova server response has been closed (on demand)
```

## Testing

Test a sample of ~10 radios with known varying features.
```
npm test
```

Test all radios supported by Adblock Radio:
```
./node_modules/mocha/bin/mocha test.js --test-all-radios --delay
```

Test a particular radio:
```
./node_modules/mocha/bin/mocha test.js --test-one-radio 'United States of America_NPR Program (AAC)' --delay
```

## License

MIT
