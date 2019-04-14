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
const axios = require('axios');
const cp = require("child_process");

const consts = {
	SUPPORTED_EXTENSIONS: [
		"mp3",
		"aac",
		"ogg"
	],
	CODEC_FFPROBE_TRANSLATION: { // translation from codecs from ffprobe to file extensions
		"mp3": "mp3",
		"aac": "aac",
		"vorbis": "ogg",
	},
	CODEC_API_TRANSLATION: { // translation from codecs from radio-browser.info to file extensions
		"MP3": "mp3",
		"AAC": "aac",
		"AAC+": "aac",
		"OGG": "ogg",
		"HLS": "aac"
	},
	API_PATH: "http://www.radio-browser.info/webservice/json/stations/bynameexact/"
}

// function that calls an API to get metadata about a radio
const getRadioMetadata = function(country, name, callback) {

	axios.get(consts.API_PATH + encodeURIComponent(name)).then(function(response) {

		//try {
		var results = response.data;
		var i = results.map(e => e.country).indexOf(country);
		/*} catch (e) {
			log.error("getRadioMetadata: problem parsing response. err=" + e);
			return callback(e, null);
		}*/

		if (i >= 0) {
			//log.info("getRadioMetadata: metadata received for " + country + "_" + name);
			//log.debug("getRadioMetadata: metadata=" + JSON.stringify(results[i]));
			if (!isNaN(results[i].bitrate) && results[i].bitrate > 0) {
				results[i].bitrate = results[i].bitrate * 1000 / 8; // result in kbps. convert to bytes per second
			} else {
				results[i].bitrate = 0;
				log.warn(country + "_" + name + " getRadioMetadata: no ICY bitrate available");
				// we will use ffprobe instead, or read the HLS manifest if relevant
			}
			return callback(null, results[i]);
		} else {
			log.error("getRadioMetadata: radio not found: " + results);
			return callback(null, null);
		}
	}).catch(function(e) {
		log.warn("getRatioMetadata: request error. err=" + e);
		return callback(e, null);
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


		this.startDl();
	}

	async refreshMetadata() {
		const self = this;
		return new Promise(function(resolve, reject) {
			try {
				getRadioMetadata(self.country, self.name, function(err, result) {
					if (err || !result) {
						log.warn(self.canonical + " problem fetching radio info: " + err);
						self.emit("error", "problem fetching radio info: " + err);
						return reject();
					}
					let translatedCodec = consts.CODEC_API_TRANSLATION[result.codec];
					if (!consts.SUPPORTED_EXTENSIONS.includes(translatedCodec)) {
						if (result.codec === "UNKNOWN" || result.codec === "") {
							log.warn(self.canonical + ": API gives " + result.codec + " codec. Will use ffprobe to determine it.");
							translatedCodec = "UNKNOWN";
						} else {
							log.error(self.canonical + ": API returned a codec, " + result.codec + ", that is not supported");
							self.emit("error", "API returned an unsupported codec");
							return reject();
						}
					} else if (!result.codec) {
						log.warn(self.canonical + ": API returned an empty codec field");
						self.emit("error", "API returned an empty codec")
						return reject();
					}
					if (!self.url) self.url = result.url;
					self.origUrl = result.url;
					self.ext = translatedCodec;
					self.hls = result.codec === "HLS" || result.hls === "1";
					self.bitrate = result.bitrate;
					self.apiBitrate = result.bitrate;
					self.apiresult = result;
					resolve();
				});
			} catch (e) {
				log.error(self.canonical + " error getting radio metadata. err=" + e);
				reject();
			}
		});
	}

	startDl() {
		const self = this;

		(async function() {
			await self.stopDl();

			self.firstData = null;
			self.lastData = new Date();
			self.receivedBytes = 0;
			self.receivedBytesInCurrentSegment = 0;

			self.checkInterval = setInterval(function() {
				if (+new Date() - self.lastData > 10000) {
					log.info(self.canonical + " stream seems idle, we restart it");
					self.startDl();
				}
			}, 5000);

			try {
				await self.refreshMetadata();
			} catch (e) {
				return;
			}

			self.worker = cp.fork(__dirname + "/worker.js", { //new Worker(__dirname + "/worker.js", {
				//workerData: {
				env: {
					country: self.country,
					name: self.name,
					url: self.url,
					hls: self.hls,
					ext: self.ext,
					bitrate: self.bitrate,
					consts: JSON.stringify(consts),
				}
			});

			self.worker.on("message", function(msg) {
				if (msg.type === "headers") {
					log.debug(self.canonical + " will emit headers");
					self.emit("headers", msg.headers);

				} else if (msg.type === "metadata") {
					log.debug(self.canonical + " will emit metadata");
					self.emit("metadata", {
						country: self.country,
						name: self.name,
						url: self.url,
						favicon: self.apiresult.favicon,
						ext: self.ext,
						bitrate: self.bitrate,
						hls: self.apiresult.hls,
						tags: self.apiresult.tags,
						votes: self.apiresult.votes,
						lastcheckok: self.apiresult.lastcheckok,
						homepage: self.apiresult.homepage
					});

				} else if (msg.type === "data") {
					msg.data = Buffer.from(msg.data);
					//log.debug(self.canonical + " received " + msg.data.length + " bytes");
					self.onData2(msg.data, msg.isFirstSegment);

				} else if (msg.type === "bitrate") {
					log.info(self.canonical + " bitrate updated to " + msg.bitrate);
					self.bitrate = msg.bitrate;

				} else if (msg.type === "ext") {
					log.info(self.canonical + " ext updated to " + msg.ext);
					self.ext = msg.ext;

				} else if (msg.type === "url") {
					log.info(self.canonical +  " url updated to " + msg.url);
					self.url = msg.url;
					self.startDl(); // immediately restart the request

				} else {
					log.warn(self.canonical + " message not recognized. type=" + msg.type);
				}
			});

			self.worker.once("error", function(err) {
				log.error(self.canonical + " thread had error " + err);
				// thread will restart by itself with "checkInterval" function

			});

			self.worker.exited = false;
			self.worker.once("exit", function() {
				log.debug(self.canonical + " thread exited");
				self.worker = null;
			});
		})();

	}

	tBuffer() {
		// the bitrate is not perfectly known. we freeze the buffer length after a few seconds so that
		// the value does not drift over time
		if (this.lastData - this.firstData < 20000) {
			this.buffer = this.receivedBytes / this.bitrate - (this.lastData - this.firstData) / 1000;
		}
		return this.buffer;
	}

	onData2(data, isFirstSegment) {
		if (this.firstData === null) {
			this.firstData = new Date();
			log.info(this.canonical + " first data received at " + this.firstData);
		}
		this.lastData = new Date();

		let newSegment = isFirstSegment;

		const limitBytes = this.segDuration * this.bitrate;

		if (!limitBytes || this.receivedBytesInCurrentSegment + data.length < limitBytes) {

			this.receivedBytesInCurrentSegment += data.length;
			this.receivedBytes += data.length;
			this.push({ newSegment: newSegment, tBuffer: this.tBuffer(), data: data });

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
			this.receivedBytesInCurrentSegment = data.length - nSegs * limitBytes;
			this.receivedBytes += data.length - nSegs * limitBytes;
			this.push({ newSegment: true, tBuffer: this.tBuffer(), data: data.slice(nSegs*limitBytes) });
		}
	}

	async stopDl() {
		if (this.checkInterval) {
			clearInterval(this.checkInterval); // disable safety nets that restart the dl
		}
		if (this.worker) {
			this.worker.kill();
			delete this.worker;
		}
	}

	_read() {
		// pass
	}
}

exports.StreamDl = StreamDl;
exports.getRadioMetadata = getRadioMetadata;
