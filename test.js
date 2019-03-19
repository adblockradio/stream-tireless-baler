const assert = require("assert").strict;
const { log } = require("abr-log")("test");
const Dl = require("./dl.js").StreamDl;
const axios = require("axios");
const LIST_URL = "https://www.adblockradio.com/models/list.json";
const DL_DURATION = 5; // in seconds
const SEG_DURATION = 2; // in seconds
const SUPPORTED_EXTENSIONS = [ "mp3", "aac", "ogg" ];

let radios = [
	{ country: "France", name: "Radio Nova" },            // regular HTTP stream
	{ country: "France", name: "Djam Radio" },            // stream where radio-browser.info gives no codec info;
	{ country: "France", name: "BFM Business" },          // stream with many redirections
	{ country: "Spain", name: "Cadena 100" },
	{ country: "Spain", name: "RAC1" },                   // HTTP/0.9 stream
	{ country: "Italy", name: "Radio Capital" },          // HLS stream
	{ country: "Belgium", name: "Zen FM" },               // audio/x-scpls playlist parsed to find the final URL
	{ country: "Switzerland", name: "Basspistol (OGG)" }, // OGG stream
	{ country: "Italy", name: "RTL 102.5" },
	{ country: "New Zealand", name: "Radio Hauraki" },    // low bitrate, ffprobe is often wrong
];

const TEST_ALL_RADIOS = process.argv.includes("--test-all-radios");
if (TEST_ALL_RADIOS) {
	log.info("will test all radios supported by Adblock Radio");
}

const paramIndex = process.argv.indexOf("--test-one-radio")
if (paramIndex >= 0 && process.argv.length >= paramIndex + 2) {
	const spl = process.argv[paramIndex + 1].split("_");
	radios = [ { country: spl[0], name: spl[1] } ];
	log.info("will test only the radio " + radios[0].country + "_" + radios[0].name);
}

(async function() {

	if (TEST_ALL_RADIOS) {
		radios = (await axios.get(LIST_URL)).data;
	} else {
		await new Promise(setImmediate);
	}

	log.info(radios.length + " radios will be tested");

	describe('Dl', function() {
		for (let i=0; i<radios.length; i++) {
			const { country, name } = radios[i];
			log.debug("will test " + country + "_" + name);
			//test(country, name);

			(function() { //test(country, name) {

				let metadataReceived = null;
				let bitrate = 0;
				let headersReceived = false;
				let receivedBytes = 0;
				let receivedBytesInSegment = 0;
				let receivedBytesBySegment = [];
				let hadErrors = false;
				let dl = null;
				let tBuffer = 0;
				let http09 = false;

				before(function(done) {
					this.timeout(1000 * (DL_DURATION + 1));
					log.info("testing dl for radio " + country + "_" + name);

					//return new Promise(function(resolve, reject) {
					dl = new Dl({ country: country, name: name, segDuration: SEG_DURATION });

					dl.on("metadata", function(data) {
						log.info("metadata received\n" + JSON.stringify(data, null, "\t"));
						//log.info("metadata url=" + data.url + " codec=" + data.codec + " ext=" + data.ext + " bitrate=" + data.bitrate);
						metadataReceived = data;
						bitrate = data.bitrate;
					});

					dl.on("headers", function(headers) {
						log.info("stream headers\n" + JSON.stringify(headers, null, "\t"));
						headersReceived = true;
					});

					dl.on("data", function(obj) {
						if (obj.newSegment) {
							log.debug("new segment begins. last segment contained " + receivedBytesInSegment + " bytes");
							receivedBytesBySegment.push(receivedBytesInSegment);
							receivedBytesInSegment = 0;
						}
						receivedBytesInSegment += obj.data.length;
						receivedBytes += obj.data.length;
						tBuffer = obj.tBuffer;
						//log.debug("received " + obj.data.length + " bytes. tBuffer=" + obj.tBuffer.toFixed(2) + "s. newSeg=" + obj.newSegment);
						if (dl.altreq) http09 = true;
					});

					dl.on("error", function(err) {
						log.warn("dl err=" + err);
						hadErrors = true;
					});

					setTimeout(function() {
						log.info("stopping stream download for radio " + country + "_" + name);
						log.info("total amount of bytes received: " + receivedBytes);
						log.info("tBuffer=" + tBuffer + " s vs totalAmount/bitrate=" + (receivedBytes/bitrate).toFixed(2));
						if (dl.hlsBitrate) log.info("HLS bitrate " + dl.hlsBitrate + " vs that of API " + dl.apiBitrate);
						if (dl.ffprobeBitrate) log.info("FFProbe bitrate " + dl.ffprobeBitrate + " vs that of API " + dl.apiBitrate)
						dl.stopDl();
						done();
					}, 1000 * DL_DURATION);
				});

				describe(country + "_" + name, function() {

					it('should not raise an error', function() {
						assert(!hadErrors);
					});

					it('should have received metadata', function() {
						assert(metadataReceived);
						assert(metadataReceived.country);
						assert(metadataReceived.name);
						assert(metadataReceived.url);
						assert(metadataReceived.favicon);
						assert(metadataReceived.ext);
						assert(SUPPORTED_EXTENSIONS.includes(metadataReceived.ext));
						assert(metadataReceived.bitrate);
						assert(metadataReceived.hls); // "0" or "1", strings, so should be trueish
						assert(metadataReceived.votes);
						assert(metadataReceived.lastcheckok);
					});

					it('should have received headers', function() {
						if (http09) this.skip(); // HTTP/0.9
						assert(headersReceived);
					});

					it('should have received data', function() {
						assert(receivedBytes > 0)
					});

					it('should have a valid bitrate', function() {
						assert(bitrate >= 3000 && bitrate <= 100000);

						// there are sometimes discrepancies in the ffprobe bitrate vs that reported by the API
						// e.g. VBR streams.
						// note that when the API does not contain a bitrate, bitrate is set to ffprobeBitrate
						if (dl.ffprobeBitrate) {
							assert(dl.ffprobeBitrate >= bitrate * 0.8);
							assert(bitrate >= dl.ffprobeBitrate * 0.8);
						}

						//if (dl.hlsBitrate) assert.equal(dl.hlsBitrate, bitrate);
						// API bitrate for HLS streams is always the lowest available
						// We select streams differently (closest to 128k), there is no reason to enable this test
					});

					it('should have a valid buffer duration', function() {
						assert(tBuffer > 0 && tBuffer < 60);
						assert(receivedBytes/bitrate >= tBuffer);
						assert(receivedBytes/bitrate < tBuffer + DL_DURATION);
					});

					it('should segment audio data properly', function() {
						const targetSegmentSize = bitrate * SEG_DURATION;
						const nSegments = receivedBytesBySegment.length - 1; // first one has zero length
						assert.equal(receivedBytesBySegment[0], 0);
						assert.deepEqual(receivedBytesBySegment.slice(1), new Array(nSegments).fill(targetSegmentSize));
					});

					it('should stop properly', function() {
						assert(dl.toBeDestroyed);
						assert.equal(dl.req, undefined);
						assert.equal(dl.altreq, undefined);
					});

				});
			})();

		}
		run();
	});
})();
