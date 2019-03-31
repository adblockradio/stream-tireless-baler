"use strict";
const { log } = require("abr-log")("dl/worker");
const { parentPort, workerData } = require('worker_threads');
const Url = require("url");
const m3u8handler = require("./m3u8handler.js");
const http = require("http");
const https = require("https");
const cp = require('child_process');
const assert = require("assert");

assert(workerData.country);
assert(workerData.name);
assert(workerData.url);
assert(workerData.ext); // to remove in the end?
assert(!isNaN(workerData.bitrate));
assert([true, false].includes(workerData.hls));
assert(workerData.consts);

const { country, name, hls, consts } = workerData;
let { url, ext, bitrate } = workerData;
const canonical = country + "_" + name;

log.info("dl worker spawned for radio " + canonical);

log.debug(canonical + " start dl url= " + url + " ext " + ext + " bitrate expected to be " + bitrate);
/*if (this.date && timestamp && timestamp != this.date) {
	log.debug(this.canonical + " startDl has been called with the wrong timestamp, abort. current=" + timestamp + " official=" + this.date);
	return;
}*/

parentPort.on("message", function(msg) {
	if (msg.type === 'stop') {
		if (altreq && altreq.kill) {
			altreq.kill();
			log.debug(canonical + " curl child process stopped");
		}
		if (req) {
			log.info(canonical + " stop request");

			//this.toBeDestroyed = true;
			req.abort();
			/*this.res.once('close', function() {
				this.req = null;
				log.info("now ready to start it again, baby!");
				self.req = null;
				self.toBeDestroyed = false;
				self.startDl(timestamp);
			});*/
		}
		parentPort.unref(); // thread will eventually terminate
	}
});

let req = null;
let altreq = null;
let res = null;
let ffprobeLock = false; // boolean to indicate whether ffprobe is (asynchronously) determining the bitrate
let ffprobeDone = false; // boolean to indicate that ffprobe bitrate has already been read
let ffprobeBuffer = null;
let hlsKnownBitrate = false;

//setTimeout(function() { self.checkAlive(self.date); }, 5000);

const urlParsed = Url.parse(url);

if (hls) {
	// special handler for HLS streams
	req = m3u8handler(urlParsed, function(headers) {
		parentPort.postMessage({
			type: "headers",
			headers: headers,
		});
	}, function(_bitrate) {
		log.debug(canonical + " according to hls manifest, bitrate is " + _bitrate + " bytes / s");
		if (bitrate) {
			log.debug(canonical + " overwrite the original bitrate " + bitrate + " bytes / s");
		}
		bitrate = _bitrate;
		parentPort.postMessage({
			type: "bitrate",
			bitrate: bitrate,
		});
		//self.hlsBitrate = bitrate;
		hlsKnownBitrate = true; // useless to call ffprobe if the bitrate is known reliably
	}, function(data, delay) {
		// hls blocks may provide data in too big blocks. inject it progressively in the analysis flow
		onData(data);
	});


} else {
	req = (urlParsed.protocol == "http:" ? http : https).get(urlParsed, function (_res) {
		res = _res;
		log.debug(canonical + " got response code " + res.statusCode + " and content-type " + res.headers["content-type"]);
		parentPort.postMessage({
			type: "headers",
			headers: res.headers,
		});

		res.resume();

		// management of common connection problems that may occur
		if (res.statusCode == 404) {
			throw new Error("HTTP 404");

		} else if (res.headers["www-authenticate"] || res.statusCode == 500 || res.statusCode == 502) {
			// request fail... restart required. e.g. fr_ouifm {"www-authenticate":"Basic realm=\"Icecast 2.3.3-kh9\""}
			// 404 {"server":"nginx/1.2.1","date":"Wed, 07 Sep 2016 08:48:53 GMT","content-type":"text/html","connection":"close"}
			throw new Error("HTTP AUTH");

		} else if ((res.statusCode == 301 || res.statusCode == 302) && res.headers["location"]) { //  && res.headers["connection"] == "close"
			// redirect e.g. fr_nrj {"server":"Apache-Coyote/1.1","set-cookie":["JSESSIONID=F41DB621F21B84920E2F7F0E92209B67; Path=/; HttpOnly"],
			// "location":"http://185.52.127.132/fr/30001/mp3_128.mp3","content-length":"0","date":"Wed, 13 Jul 2016 08:08:09 GMT","connection":"close"}
			url = res.headers.location;
			log.info(canonical + " following redirection to " + url);
			parentPort.postMessage({
				type: "url",
				url: url,
			});

		} else if ([
				"audio/x-mpegurl",
				"audio/x-scpls; charset=UTF-8",
				"audio/x-scpls",
				"video/x-ms-asf"
			].includes(res.headers["content-type"])) { // M3U, PLS or ASF playlist

			log.debug(canonical + " url is that of a playlist. content-type=" + res.headers["content-type"] +". read it");

			var playlistContents = "";
			var isM3U = res.headers["content-type"] == "audio/x-mpegurl";
			var isASF = res.headers["content-type"] == "video/x-ms-asf";

			res.on('data', function(data) { playlistContents += data; });

			res.on('end', function() {
				var lines = playlistContents.replace(/\r/g, '').split("\n");
				//log.debug(canonical + " received the following playlist (" + lines.length + " lines):\n" + playlistContents);
				var newUrlFound = false;
				for (var i=lines.length-1; i>=0; i--) {
					if (isM3U && lines[i].slice(0, 4) == "http") {          // audio/x-mpegurl
						url = lines[i];
						newUrlFound = true;
						break;
					} else if (isASF) {                                     // video/x-ms-asf
						var p1 = lines[i].indexOf("<REF HREF=\"");
						if (p1 < 0) continue
						if (lines[i].slice(p1+11, p1+15) == "http") {
							url = lines[i].slice(p1+11).split("\"")[0];
							newUrlFound = true;
							break;
						}
					} else if (!isM3U && !isASF) {                          // audio/x-scpls
						var p1 = lines[i].indexOf("=");
						if (p1 < 0) continue
						if (lines[i].slice(p1+1, p1+5) == "http") {
							url = lines[i].slice(p1+1);
							newUrlFound = true;
							break;
						}
					}
				}

				if (newUrlFound) {
					//startDl(null)
					parentPort.postMessage({
						type: "url",
						url: url,
					});

				} else {
					log.error(canonical + " could not parse playlist");
					log.debug(playlistContents);
					throw new Error("PARSE PLAYLIST");
				}
			});

		} else if (res.statusCode != 200) {
			throw new Error("HTTP NOT 200");
			// restart 2000

		} else { // case of success
			res.on('data', onData);

			res.on('close', function() {
				log.info(canonical + " server response has been closed");
				//throw new Error("HTTP CLOSE");

				/*if (toBeDestroyed) {
					log.info(canonical + " server response has been closed (on demand)");
				} else {
					log.warn(canonical + " server response has been unexpectedly closed.");
					// restart 5000
				}*/

			});
		}
	});

	req.on('error', function(e) {
		if (e.message == "Parse Error") {
			// node is unable to download HTTP data without headers.
			log.info(canonical + ' seems to follow HTTP/0.9 spec. retry with curl');
			altreq = cp.spawn("curl", ["-L", url], { stdio: ['pipe', 'pipe', 'pipe'] });
			return altreq.stdout.on("data", onData);
		}

		log.error(canonical + ' problem with request: ' + e.message);
		throw new Error();

		/*(function(timestamp) {
			setTimeout(function() {
				getRadioMetadata(self.country, self.name, function(err, result) {
					if (err) {
						log.warn(self.canonical + " problem fetching radio info: " + err);
					}

					// URL has been updated in the metadata database
					if (result != null && self.url != result.url) {
						log.warn(self.canonical + " URL updated from " + self.url + " to " + result.url);
						log.warn(self.canonical + " original url was " + self.origUrl);
						self.url = result.url;
						self.origUrl = result.url;
						if (result.bitrate) {
							bitrate = result.bitrate;
							parentPort.postMessage({
								type: "bitrate",
								bitrate: bitrate,
							});
						}
					}
					self.startDl(timestamp);
				});
			}, 5000);
		})(self.date);*/
	});


}




// get a reliable value of bitrate, so that tBuffer can be correctly estimated
// done before the first data is emitted.
const onData = function(data) {

	if (ffprobeDone) {
		return parentPort.postMessage({
			type: 'data',
			data: data,
			isFirstSegment: false
		});
	}

	ffprobeBuffer = ffprobeBuffer ? Buffer.concat([ffprobeBuffer, data]) : data;

	if (ffprobeBuffer.length < 16000 || ffprobeLock) return;

	ffprobeLock = true;

	const done = function() {
		ffprobeDone = true; // will not do ffprobe bitrate detection in the future
		parentPort.postMessage({
			type: 'metadata',
		});

		parentPort.postMessage({
			type: 'data',
			data: ffprobeBuffer,
			isFirstSegment: true,
		});

		ffprobeBuffer = null;
	}

	if (hlsKnownBitrate && ext !== "UNKNOWN") {
		return done();
	}

	const ffprobe = cp.spawn("ffprobe", ["-"], { stdio: ['pipe', 'pipe', 'pipe'] });
	let ffprobeRes = "";
	ffprobe.stderr.on("data", function(ffdata) {
		ffprobeRes += ffdata;
	});
	ffprobe.stderr.on("end", function() {
		//log.debug("ffprobe stderr data=" + ffprobeRes);
		let ffdatasplit = ("" + ffprobeRes).split('\n');

		ffdatasplit = ffdatasplit.filter(function(line) {
			return line.includes('Stream') &&
				line.includes('Audio') &&
				line.includes('kb/s');
		});

		if (!ffdatasplit.length) return; // will wait for further data events containing useful payload

		let linesplit = ffdatasplit[0].split(' ');

		// bitrate
		const i = linesplit.indexOf('kb/s') - 1;
		if (linesplit.length < 2 || i < 0) {
			if (bitrate) {
				log.warn(canonical + ' could not parse ffprobe result: ' + ffdatasplit[0] + '. keep bitrate=' + bitrate + ' bytes/s');
			} else {
				log.error(canonical + ' could not parse ffprobe result: ' + ffdatasplit[0] + ' no bitrate could be determined.')
			}
		} else {
			const ffprobeBitrate = Number(linesplit[i]) * 1000 / 8;
			log.info(canonical + " ffprobe bitrate = " + ffprobeBitrate + " bytes/s");
			//self.ffprobeBitrate = ffprobeBitrate;
			if (!bitrate) {
				log.debug(canonical + " use that one");
				bitrate = ffprobeBitrate;
				parentPort.postMessage({
					type: "bitrate",
					bitrate: bitrate,
				});
			} else {
				log.debug(canonical + " keep the original bitrate " + bitrate);
			}
		}

		// codec
		const j = linesplit.indexOf('Audio:') + 1;
		if (j >= linesplit.length || j <= 0) {
			log.warn(canonical + ' could not parse ffprobe result: ' + ffdatasplit[0] + '. keep ext=' + ext);
		} else {
			let codec = linesplit[j].split(',')[0]; // remove trailing comma, if any. With HLS streams, one may get: "Audio: aac (HE-AAC) ([15][0][0][0] / 0x000F),"
			ext = consts.CODEC_FFPROBE_TRANSLATION[codec];
			parentPort.postMessage({
				type: "ext",
				ext: ext,
			});
			if (!consts.SUPPORTED_EXTENSIONS.includes(ext)) {
				log.error(canonical + " codec " + codec + " is not supported");
			} else {
				log.info(canonical + " ffprobe codec = " + codec + " extension = " + ext);
			}
		}
		return done();
	});
	ffprobe.stdin.end(ffprobeBuffer);
}