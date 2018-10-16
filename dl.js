// MIT License

// Copyright (c) 2018 Alexandre Storelli

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

"use strict";

const { Readable } = require('stream');
const { log } = require("abr-log")("dl");
const url = require("url");
const m3u8handler = require("./m3u8handler.js");
const http = require("http");
const https = require("https");
const cp = require('child_process');

const consts = {
	SAVE_EXT: { "MP3": "mp3", "AAC": "aac", "AAC+": "aac", "OGG": "ogg", "HLS": "aac" },
	API_PATH: "http://www.radio-browser.info/webservice/json/stations/bynameexact/"
}

// helper function to download a (finite) file
const _get = function(exturl, callback) {
	var parsedUrl = url.parse(exturl);
	parsedUrl.withCredentials = false;
	var request = (parsedUrl.protocol == "https:" ? https : http).request(parsedUrl, function(res) {
		var corsEnabled = res.headers["access-control-allow-origin"] === "*";
		var result = ""
		res.on('data', function(chunk) {
			result += chunk;
		});
		res.on('end', function() {
			return callback(null, result, corsEnabled);
		});
	}).on("error", function(e) {
		return callback(e.message, null, null);
	});
	request.end();
}

// function that calls an API to get metadata about a radio
const getRadioMetadata = function(country, name, callback) {
	_get(consts.API_PATH + encodeURIComponent(name), function(err, result) { //, corsEnabled
		if (err || !result) {
			return callback(err, null);
		}

		try {
			var results = JSON.parse(result);
		} catch(e) {
			return callback(e.message, null);
		}

		const i = results.map(e => e.country).indexOf(country);

		if (i >= 0) {
			//log.info("getRadioMetadata: metadata received for " + country + "_" + name);
			if (!isNaN(results[i].bitrate) && results[i].bitrate > 0) {
				results[i].bitrate = results[i].bitrate * 1000 / 8; // result in kbps
			} else {
				results[i].bitrate = 128000 / 8;
				log.warn("getRadioMetadata: default bitrate to 128k");
			}
			return callback(null, results[i]);
		} else {
			log.error("getRadioMetadata: radio not found: " + results);
			return callback(null, null);
		}
	});
}

// main Readable class that contains workarounds for most frequent errors
// it parses playlists if necessary (M3U, SCPLS, ASF, M3U8/HLS)
// it ensures the download is still active, and restarts if stalled.
// output events can be emitted in a way to have equal audio chunks
// output also contains the length of the audio buffer in the stream

class StreamDl extends Readable {

	constructor(options) {
		if (!options) options = {};
		options.objectMode = true;
		super(options);
		this.country = options.country;
		this.name = options.name;
		this.canonical = this.country + "_" + this.name;
		this.segDuration = options.segDuration;
		this.buffer = 0;
		this.ffprobeLock = false; // boolean to indicate whether ffprobe is (asynchronously) determining the bitrate
		this.ffprobeDone = false; // boolean to indicate that ffprobe bitrate has already been read

		var self = this;
		getRadioMetadata(this.country, this.name, function(err, result) {
			if (err || !result) {
				log.warn(self.canonical + " problem fetching radio info: " + err);
				return self.emit("error", "problem fetching radio info: " + err);
			}
			self.url = result.url;
			self.origUrl = result.url;
			self.codec = result.codec;
			self.hls = result.hls;
			self.bitrate = result.bitrate;
			self.favicon = result.favicon;
			self.emit("metadata", {
				country: self.country,
				name: self.name,
				url: self.url,
				favicon: self.favicon,
				codec: self.codec,
				ext: consts.SAVE_EXT[self.codec],
				bitrate: self.bitrate,
				hls: result.hls,
				tags: result.tags,
				votes: result.votes,
				lastcheckok: result.lastcheckok,
				homepage: result.homepage
			});
			self.startDl(null);
		});
	}

	checkAlive(requestDate) {
		if (requestDate != this.date || this.toBeDestroyed) return;

		if (new Date() - this.lastData > 10000) {
			log.info(this.canonical + " stream seems idle, we restart it");
			this.startDl(null);
		} else {
			var self = this;
			setTimeout(function() { self.checkAlive(requestDate); }, 4000);
		}
	}

	startDl(timestamp) {
		var self = this;

		log.debug(this.canonical + " start dl url= " + this.url + " codec " + this.codec + " (*." + consts.SAVE_EXT[this.codec] + "), bitrate expected to be " + this.bitrate);
		if (!consts.SAVE_EXT[this.codec]) {
			log.error("codec " + this.codec + " is not supported");
			return this.emit("error", "codec " + codec + " is not supported");
		}
		if (this.date && timestamp && timestamp != this.date) {
			log.debug("startDl has been called with the wrong timestamp, abort. current=" + timestamp + " official=" + this.date);
			return;
		}
		this.date = new Date();
		this.firstData = null;
		this.lastData = new Date();
		this.receivedBytes = 0;
		this.receivedBytesInCurrentSegment = 0;
		this.res = null;

		if (this.req) this.req.abort();

		setTimeout(function() { self.checkAlive(self.date); }, 5000);

		var urlParsed = url.parse(this.url);

		// special handler for HLS streams
		if (this.codec == "HLS" || this.hls == "1") {
			return this.req = m3u8handler(urlParsed, function(bitrate) {
				log.debug("update bitrate to " + bitrate);
				self.bitrate = bitrate;
			}, function(data, delay) {
				// hls blocks may provide data in too big blocks. inject it progressively in the analysis flow
				self.onData(data);
			});
		}

		//log.debug(JSON.stringify(urlloc));
		this.req = (urlParsed.protocol == "http:" ? http : https).get(urlParsed, function (res) {
			self.res = res;
			log.debug(self.canonical + " got response code " + res.statusCode + " and content-type " + res.headers["content-type"]);
			self.emit("headers", res.headers);

			res.resume();

			// management of common connection problems that may occur
			if (res.statusCode == 404) {
				self.stopDl();
				return this.emit("error", "404");
			} else if (res.headers["www-authenticate"] || res.statusCode == 500 || res.statusCode == 502) {
				// request fail... restart required. e.g. fr_ouifm {"www-authenticate":"Basic realm=\"Icecast 2.3.3-kh9\""}
				// 404 {"server":"nginx/1.2.1","date":"Wed, 07 Sep 2016 08:48:53 GMT","content-type":"text/html","connection":"close"}
				(function(timestamp) { setTimeout(function() { self.startDl(timestamp); }, 10000); })(self.date);
				self.req.abort();
				return;
			} else if ((res.statusCode == 301 || res.statusCode == 302) && res.headers["location"]) { //  && res.headers["connection"] == "close"
				// redirect e.g. fr_nrj {"server":"Apache-Coyote/1.1","set-cookie":["JSESSIONID=F41DB621F21B84920E2F7F0E92209B67; Path=/; HttpOnly"],
				// "location":"http://185.52.127.132/fr/30001/mp3_128.mp3","content-length":"0","date":"Wed, 13 Jul 2016 08:08:09 GMT","connection":"close"}
				self.url = res.headers.location;
				log.info(self.canonical + "following redirection to " + self.url);
				self.req.abort();
				self.startDl(null);
				return;
			} else if (["audio/x-mpegurl", "audio/x-scpls; charset=UTF-8", "audio/x-scpls", "video/x-ms-asf"].indexOf(res.headers["content-type"]) >= 0) { // M3U, PLS or ASF playlist
				log.debug(self.canonical + " url is that of a playlist. content-type=" + res.headers["content-type"] +". read it");
				var playlistContents = "";
				var isM3U = res.headers["content-type"] == "audio/x-mpegurl";
				var isASF = res.headers["content-type"] == "video/x-ms-asf";
				self.res.on('data', function(data) {
					playlistContents += data;
				});
				self.res.on('end', function() {
					//log.debug(self.country + "_" + self.name + " received the following playlist:\n" + playlistContents);
					var lines = playlistContents.split("\n");
					var newUrlFound = false;
					for (var i=lines.length-1; i>=0; i--) {
						if (isM3U && lines[i].slice(0, 7) == "http://") { 		// audio/x-mpegurl
							self.url = lines[i];
							newUrlFound = true;
							break;
						} else if (isASF) { 									// video/x-ms-asf
							var p1 = lines[i].indexOf("<REF HREF=\"");
							if (p1 < 0) continue
							if (lines[i].slice(p1+11, p1+18) == "http://") {
								self.url = lines[i].slice(p1+11).split("\"")[0];
								newUrlFound = true;
								break;
							}
						} else if (!isM3U && !isASF) { 							// audio/x-scpls
							var p1 = lines[i].indexOf("=");
							if (p1 < 0) continue
							if (lines[i].slice(p1+1, p1+8) == "http://") {
								self.url = lines[i].slice(p1+1);
								newUrlFound = true;
								break;
							}
						}
					}
					if (newUrlFound) {
						self.startDl(null)
					} else {
						log.error(self.canonical + " could not parse playlist");
						return self.emit("error", "could not parse playlist"); //predictionCallback(42, null, stream.getStatus());
					}
				});

			} else if (res.statusCode != 200) {
				(function(timestamp) { setTimeout(function() { self.startDl(timestamp); }, 2000); })(self.date);
			} else {
				self.res.on('data', function(data) {
					self.onData(data);
				});

				self.res.on('close', function() {
					log.warn(self.canonical + " server response has been closed" + (self.toBeDestroyed ? " (on demand)" : ""));
					self.req.abort();
					if (!self.toBeDestroyed) {
						(function(timestamp) { setTimeout(function() { self.startDl(timestamp); }, 5000); })(self.date);
					}
				});
			}
		});

		this.req.on('error', function(e) {
			if (e.message == "Parse Error") {
				// node is unable to download HTTP data without headers.
				log.info(self.canonical + ' seems to follow HTTP/0.9 spec. retry with curl');
				self.altreq = cp.spawn("curl", ["-L", self.url], { stdio: ['pipe', 'pipe', 'pipe'] });
				return self.altreq.stdout.on("data", function(data) {
					self.onData(data);
				});
			}

			log.error(self.canonical + ' problem with request: ' + e.message);
			(function(timestamp) {
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
							self.bitrate = result.bitrate;
						}
						self.startDl(timestamp);
					});
				}, 5000);
			})(self.date);
		});
	}

	tBuffer() {
		// the bitrate is not perfectly known. we freeze the buffer length after a few seconds so that
		// the value does not drift over time
		if (this.lastData - this.firstData < 20000) {
			this.buffer = this.receivedBytes / this.bitrate - (this.lastData - this.firstData) / 1000;
		}
		return this.buffer;
	}


	// get a reliable value of bitrate, so that tBuffer can be correctly estimated
	// done before the first data is emitted.
	onData(data) {
		if (this.firstData == null) {
			this.firstData = new Date();
			log.info(this.canonical + " first data received at " + this.firstData);
		}

		if (this.ffprobeDone) return this.onData2(data, false);

		this.ffprobeBuffer = this.ffprobeBuffer ? Buffer.concat([this.ffprobeBuffer, data]) : data;

		if (this.ffprobeBuffer.length < 16000 || this.ffprobeLock) return;

		this.ffprobeLock = true;

		const self = this;
		const ffprobe = cp.spawn("ffprobe", ["-"], { stdio: ['pipe', 'pipe', 'pipe'] });
		ffprobe.stderr.on("data", function(ffdata) {
			//log.debug("ffprobe stderr data=" + ffdata);
			let ffdatasplit = ("" + ffdata).split('\n');
			ffdatasplit = ffdatasplit.filter(line => line.includes('Duration') && line.includes('bitrate'));
			if (!ffdatasplit.length) return; // will wait for further data events containing useful payload
			let linesplit = ffdatasplit[0].split(' ');
			if (linesplit.length < 2) {
				log.warn('could not parse ffprobe result: ' + ffdatasplit[0] + '. keep bitrate=' + self.bitrate + ' bytes/s');
				self.ffprobeDone = true; // abort ffprobe bitrate detection
				self.onData2(self.ffprobeBuffer, true);
				delete self.ffprobeBuffer;
				return;
			}
			self.bitrate = Number(linesplit[linesplit.length - 2]) * 1000 / 8;
			log.info(self.canonical + " ffprobe bitrate = " + self.bitrate + " bytes/s");
			self.ffprobeDone = true; // abort ffprobe bitrate detection
			self.onData2(self.ffprobeBuffer, true);
			delete self.ffprobeBuffer;
		});
		ffprobe.stdin.end(this.ffprobeBuffer);
	}

	onData2(data, isFirstSegment) {
		const self = this;
		let newSegment = false || isFirstSegment;
		this.lastData = new Date();

		const limitBytes = this.segDuration * this.bitrate;

		if (!limitBytes || this.receivedBytesInCurrentSegment + data.length < limitBytes) {

			this.receivedBytesInCurrentSegment += data.length;
			this.receivedBytes += data.length;
			this.push({ newSegment: newSegment, tBuffer: self.tBuffer(), data: data });

		} else {

			// send the correct amount of bytes to fill the current segment
			var fillAmount = (limitBytes - this.receivedBytesInCurrentSegment) % limitBytes;
			if (fillAmount > 0) {
				this.receivedBytes += fillAmount;
				this.push({ newSegment: newSegment, tBuffer: this.tBuffer(), data: data.slice(0, fillAmount) });
				data = data.slice(fillAmount);
			}
			this.receivedBytesInCurrentSegment = 0;

			// send as many full segments as necessary
			var nSegs = Math.floor(data.length / limitBytes);
			for (let i=0; i<nSegs; i++) {
				this.receivedBytes += limitBytes;
				this.push({ newSegment: true, tBuffer: this.tBuffer(), data: data.slice(i*limitBytes, (i+1)*limitBytes) });
			}

			// send the remaining amount of bytes in a new segment
			if (nSegs * limitBytes < data.length) {
				this.receivedBytesInCurrentSegment = data.length - nSegs * limitBytes;
				this.receivedBytes += data.length - nSegs * limitBytes;
				this.push({ newSegment: true, tBuffer: this.tBuffer(), data: data.slice(nSegs*limitBytes) });
			}
		}
	}

	stopDl() {
		this.toBeDestroyed = true; // disables safety nets that restart the dl
		if (this.req && this.req.abort) {
			this.req.abort();
			log.debug(this.canonical + " http request aborted on demand");
		}
		if (this.altreq && this.altreq.kill) {
			this.altreq.kill();
			log.debug(this.canonical + " curl child process killed");
		}
	}

	_read() {

	}
}

exports.StreamDl = StreamDl;
exports.getRadioMetadata = getRadioMetadata;
