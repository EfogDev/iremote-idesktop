const { createCanvas, loadImage, ImageData } = require('canvas');
const { RTCVideoSink, RTCVideoSource, rgbaToI420 } = require('wrtc').nonstandard;

let width = 1100;
let height = 782;
let image = null, context = null;
let callback = null;

function setImage(newImage, w, h) {
    width = w;
    height = h;
    image = newImage;

    for (let i = 0; i < w * h; i++) {
        const b = image[i * 4];

        image[i * 4] = image[i * 4 + 2];
        image[i * 4 + 2] = b;
    }

    if (callback)
        callback();
}

function beforeOffer(peerConnection) {
    const source = new RTCVideoSource({ isScreencast: true });
    const track = source.createTrack();
    const transceiver = peerConnection.addTransceiver(track);
    const sink = new RTCVideoSink(transceiver.receiver.track);

    callback = () => {
        setTimeout(() => {
            const imageData = new ImageData(image, width, height);

            let i420Frame = { width, height, data: new Uint8ClampedArray(1.5 * width * height) };
            rgbaToI420(imageData, i420Frame);

            source.onFrame(i420Frame);
        });
    };

    const { close } = peerConnection;
    peerConnection.close = function() {
        sink.stop();
        track.stop();
        return close.apply(this, arguments);
    };
}

module.exports = { beforeOffer, setImage };
