// Copyright (c) 2018 Alexandre Storelli
// This file is licensed under the Affero General Public License version 3 or later.
// See the LICENSE file.

const { log } = require("abr-log")("dl/m3u8handler");
const m3u8 = require("m3u8");
//var m3u8stream = require("m3u8stream"); // that was buggy when tested
const http = require("http");
const https = require("https");
const url = require("url");
const fs = require("fs");
const cp = require('child_process');

var timeStamp = null;
const EMIT_INTERVAL = 2;

var parseIntParameter = function(data, name) {
	var p1 = data.indexOf(name) + name.length;
	var p2 = data.slice(p1).indexOf("\n");
	return parseInt(data.slice(p1, p1 + p2));
}

let remainingData = null;
let incrementalTimeoutHandle = null;

// this function will return small chunks of data at regular intervals, not to clog the system behind
const incrementalEmitter = function(size, delay, origin, emitter) {
	if (timeStamp == "stop") return log.debug("incremental emit aborted");
	//log.debug("incrementalEmitter: send " + size + " bytes to analyser " + origin.segment + ":" + origin.substep);
	emitter(remainingData.slice(0, size), delay);
	remainingData = remainingData.slice(size);
	if (remainingData.length == 0) return;
	origin.substep += 1;
	incrementalTimeoutHandle = setTimeout(function() {
		incrementalEmitter(size, delay, origin, emitter);
	}, EMIT_INTERVAL * 1000);
}

// parses the m3u8 child playlist, that contains the list of audio files that changes over time.
const parsePlaylist = function(playlistUrl, lastSegment, localTimeStamp, callback) {
	//log.debug("get playlist given last segment=" + lastSegment);
	if (timeStamp == "stop") return log.info("stream download abort");
	if (timeStamp !== localTimeStamp) return log.warn("timestamp mismatch. hls download aborted");

	(url.parse(playlistUrl).protocol == "http:" ? http : https).get(playlistUrl, function (res) {
		var playlist = "";
		res.on("data", function(data) {
			playlist += data;
		});
		res.on("end", function() {
			// now playlist is ready to be processed
			var delay = parseIntParameter(playlist, "#EXT-X-TARGETDURATION:");
			var sequence = parseIntParameter(playlist, "#EXT-X-MEDIA-SEQUENCE:");
			//log.debug("playlist delay=" + delay + " sequence=" + sequence);
			var initialBuffer = false;
			if (lastSegment == -1) {
				initialBuffer = true;
				lastSegment = sequence - 2; // will dl the second to last segment
			} else if (lastSegment < sequence - 5 || lastSegment > sequence) {
				lastSegment = sequence - 1; // will dl the last segment
			}

			var lines = playlist.split("\n");
			var segmentUrl = null;

			// download the (sequence - lastSegment) last item of the playlist, then refresh
			var urlsToIgnore = sequence - 1 - lastSegment;

			for (var i=lines.length-1; i>=0; i--) {
				if (lines[i].slice(0, 7) === "http://" || lines[i].slice(lines[i].length-3, lines[i].length) == ".ts") {
					if (urlsToIgnore > 0) {
						urlsToIgnore--;
					} else if (urlsToIgnore == 0) {
						segmentUrl = lines[i];
						break;
					}
				}
			}

			if (segmentUrl) {
				if (segmentUrl.indexOf("://") < 0) {
					var playlistUrlSplit = playlistUrl.split("/");
					playlistUrlSplit[playlistUrlSplit.length-1] = segmentUrl;
					//log.info("uri " + segmentUrl + " completed with path is " + playlistUrlSplit.join("/"));
					segmentUrl = playlistUrlSplit.join("/");
				}
				(url.parse(segmentUrl).protocol == "http:" ? http : https).get(segmentUrl, function(res) {
					var hlsData = null;
					var converter = cp.spawn('ffmpeg', ['-i', 'pipe:0', '-vn', '-acodec', 'copy', '-v', 'fatal', '-f', 'adts', 'pipe:1'], { stdio: ['pipe', 'pipe', process.stderr] });
					res.pipe(converter.stdin);
					converter.stdout.on("data", function(data) {
						//log.debug("ffmpeg sent " + data.length + " bytes");
						hlsData = (hlsData ? Buffer.concat([hlsData, data]) : new Buffer(data))
					});
					converter.stdout.on("end", function() {
						if (remainingData && remainingData.length > 0) {
							log.debug("prematurely flushing " + remainingData.length + " from buffer");
							clearTimeout(incrementalTimeoutHandle);
							incrementalEmitter(remainingData.length, delay, { segment: lastSegment-1, substep: 99 }, callback);
						}
						if (!hlsData || !hlsData.length) {
							log.warn("empty data after extraction from container");
							return;
						}
						remainingData = hlsData;
						if (initialBuffer || EMIT_INTERVAL >= delay) { //if EMIT_INTERVAL is bigger than delay, sends everything at once
							incrementalEmitter(hlsData.length, delay, { segment: lastSegment, substep: 0 }, callback);
						} else { // if EMIT_INTERVAL is smaller	than delay, sends in steps.
							var nSteps = Math.ceil(delay / EMIT_INTERVAL);
							incrementalEmitter(Math.ceil(hlsData.length / nSteps), delay, { segment: lastSegment, substep: 0 }, callback);
						}
					});
				});
				lastSegment += 1;
			}
			setTimeout(function() { parsePlaylist(playlistUrl, lastSegment, localTimeStamp, callback)}, delay / 4 * 1000)
		});
	});
}

// parses the master playlist, that contains the url of the child playlist that will have to be regularly refreshed
const parseMaster = function(masterUrl, bitrateCallback, playlistUrlCallback) {
	var parser = m3u8.createStream();

	var file = (url.parse(masterUrl).protocol == "http:" ? http : https).get(masterUrl, function (res) {
		res.on("data", function(data) {
			parser.write(data);
		});
		res.on("end", function() {
			parser.end();
		});
	});

	const M3U8_TARGET_BANDWIDTH = 128000;

	parser.on('m3u', function(m3u) {
		//log.debug("m3u: " + JSON.stringify(m3u, null, "\t"));
		const nStreams = m3u.items.StreamItem.length;

		let iTargetBandwidth;
		let selectedBandwidth;
		let selectedUri;
		for (let i=0; i<nStreams; i++) {
			let bandwidth = m3u.items.StreamItem[i].get("bandwidth");
			let uri = m3u.items.StreamItem[i].get("uri");
			//log.debug("stream " + i + " has bw=" + bandwidth + " and uri=" + uri);
			// choose the stream whose bandwidth is the closest from the target
			if (i == 0 || Math.abs(bandwidth - M3U8_TARGET_BANDWIDTH) <
				Math.abs(m3u.items.StreamItem[iTargetBandwidth].get("bandwidth") - M3U8_TARGET_BANDWIDTH)) {
				iTargetBandwidth = i;
				selectedBandwidth = bandwidth;
				selectedUri = uri;
			}
		}
		log.info("selected stream is #" + iTargetBandwidth + " at " + selectedBandwidth + "bps and uri=" + selectedUri);
		bitrateCallback(selectedBandwidth / 8);

		if (selectedUri.indexOf("://") < 0) {
			log.debug("masterUrl=" + url.format(masterUrl));
			let mstSplit = url.format(masterUrl).split("/");
			mstSplit[mstSplit.length-1] = selectedUri;
			log.info("uri " + selectedUri + " completed with path is " + mstSplit.join("/"));
			return playlistUrlCallback(mstSplit.join("/"));
		} else {
			return playlistUrlCallback(selectedUri);
		}
	});
}

module.exports = function(masterUrl, bitrateCallback, dataCallback) {
	timeStamp = new Date(); // timeStamp helps having maximum one download at the same time.
	parseMaster(masterUrl, bitrateCallback, function(playlistUrl) {
		parsePlaylist(playlistUrl, -1, timeStamp, dataCallback);
	});

	return {
		abort: function() {
			log.info("request hls download abort");
			timeStamp = "stop"; // will cause parsePlaylist and incrementalEmmiter next executions to stop.
		}
	}
}
