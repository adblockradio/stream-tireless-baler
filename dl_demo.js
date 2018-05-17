// Copyright (c) 2018 Alexandre Storelli
// This file is licensed under the Affero General Public License version 3 or later.
// See the LICENSE file.

"use strict";

const { log } = require("abr-log")("dldemo");
const Dl = require("./dl.js").StreamDl;

const country = "France"; const name = "Radio Nova"; // example of classic HTTP stream
//const country = "Spain"; const name = "RAC1"; // example of HTTP/0.9 stream
//const country = "Italy"; const name = "Radio Capital"; // example of HLS stream
//const country = "Belgium"; const name = "Zen FM"; // example of audio/x-scpls playlist parsed to find the final URL

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