const { createCanvas, loadImage } = require('canvas');
const { RTCVideoSink, RTCVideoSource, rgbaToI420 } = require('wrtc').nonstandard;

let width = 1100;
let height = 782;
let image = null, context = null;
let callback = null;

function setImage(newImage, w, h) {
    width = w;
    height = h;
    image = newImage;

    if (callback)
        callback();
}

function beforeOffer(peerConnection) {
    const source = new RTCVideoSource({ isScreencast: true });
    const track = source.createTrack();
    const transceiver = peerConnection.addTransceiver(track);
    const sink = new RTCVideoSink(transceiver.receiver.track);

    const canvas = createCanvas(width, height);
    context = canvas.getContext('2d');
    context.fillStyle = 'white';
    context.fillRect(0, 0, width, height);
    context.save();

    callback = () => {
        const now = performance.now();

        loadImage(image).then((img) => {
            context.drawImage(img, 0, 0, width, height);

            let rgbaFrame = context.getImageData(0, 0, width, height);
            let i420Frame = { width, height, data: new Uint8ClampedArray(1.5 * width * height) };
            rgbaToI420(rgbaFrame, i420Frame);

            source.onFrame(i420Frame);
            console.log(`Frame: ${performance.now() - now} ms`);
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
