const cp = require('child_process');
const fs = require('fs');
const express = require('express');
const app = express();
const https = require('https');
const { json } = require('body-parser');
const crypto = require('crypto');

const MAGIC_1 = Buffer.from([ 0x2d, 0x35, 0x35, 0x39, 0x30, 0x33, 0x38, 0x37, 0x33, 0x37, ]) // 0xDEADBEEF
const MAGIC_2 = Buffer.from([ 0x2d, 0x35, 0x35, 0x38, 0x39, 0x30, 0x37, 0x36, 0x36, 0x35, ]); // 0xDEAFBEEF
const MAGIC_3 = Buffer.from([ 0x2d, 0x36, 0x32, 0x32, 0x30, 0x38, 0x39, 0x35, 0x35, 0x38, ]); // 0xDAEBAAAA
const METADATA_BYTE_LENGTH = 6;
const BYTES_PER_PIXEL = 4;

const server = https.createServer({
  key: fs.readFileSync('./key.pem'),
  cert: fs.readFileSync('./cert.pem'),
}, app);

const { Server } = require('socket.io');
const Jimp = require('jimp');

const width = 1100, height = 740;

const io = new Server(server, {
  maxHttpBufferSize: 1024 * 8 * 8, // **N kb
  perMessageDeflate: true,
});

app.use('*', json());

const WebRtcConnectionManager = require('./lib/server/connections/webrtcconnectionmanager');
const {mount} = require('./lib/server/rest/connectionsapi');
const options = require('./rtc.js');
const browserify = require('browserify');
const connectionManager = WebRtcConnectionManager.create(options);
mount(app, connectionManager, `/rtc`);

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

app.get('/lib/client/index.js', (req, res) => {
  browserify(['./client.js']).bundle().pipe(res);
});

server.listen(15777, () => {
  console.log(`https://127.0.0.1:15777/`);

  server.once('close', () => {
    connectionManager.close();
  });
});

let buffer = Buffer.from('');
let superMegaCache = null;
let currentWindow = null;

const openWindow = (windowId = currentWindow) => {
  cp.exec(`
    xdotool windowstate --remove MAXIMIZED_VERT ${windowId};
    xdotool windowstate --remove MAXIMIZED_HORZ ${windowId};
    xdotool windowsize ${windowId} ${width} ${height}; 
    xdotool windowactivate ${windowId}
  `, () => {
    setTimeout(() => {
      fs.writeFileSync('.window', parseInt(windowId, 16).toString());

      try {
        const backendPid = parseInt(fs.readFileSync('.pid').toString());

        process.kill(backendPid, 'SIGUSR1');
        currentWindow = windowId;
      } catch (e) {}
    }, 100);
  });
};

const getWindowsList = () => {
  cp.exec(`wmctrl -l | cut -d' ' -f1`, (err, list) => {
    const winIDs = list.split('\n').map(it => it.trim()).filter(Boolean);
    const windows = {};

    winIDs.forEach((windowID, index) => {
      cp.exec(`xprop -id ${windowID} -notype 32c _NET_WM_ICON WM_NAME`, (err, output) => {
        const [, title = ''] = output.match(/WM_NAME = '(.+?)'\n/) || [];
        const [, data = ''] = output.match(/_NET_WM_ICON = (.+?)\n/) || [];
        const dataPixels = data.split(',');

        if (!dataPixels) {
          windows[windowID] = { iconData: '', title };
          return;
        }

        const [ width, height ] = [ dataPixels[0], dataPixels[1] ];

        if (!width || !height) {
          windows[windowID] = { error: true };
          return;
        }

        new Jimp(width, height, (err, image) => {
          for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
              let color = dataPixels[2 + width * x + y];
              const alpha = color >>> 24;

              color = (color << 8) >>> 0;
              color += alpha;

              image.setPixelColor(color, x, y);
            }
          }

          image.getBuffer(Jimp.MIME_PNG, (err, buffer) => {
            windows[windowID] = { iconData: buffer.toString('base64'), title };

            if (Object.keys(windows).length === winIDs.length) {
              io.sockets.emit('windows', JSON.stringify({ windows }));
            }
          });
        });
      });
    });
  });
};

const handleImage = (image, w, h) => {
  if (!currentWindow)
    return;

  options.setImage(image, w, h);
};

io.on('connection', (socket) => {
  getWindowsList();

  socket.on('activate', (data) => {
    openWindow(JSON.parse(data));
  });

  socket.on('maximize', () => {
    // height = defaultHeight;
    openWindow();
  });

  socket.on('minimize', () => {
    // height = fullscreenHeight;
    openWindow();
  });

  socket.on('scrollDown', () => {
    cp.exec('xdotool click 5');
  });

  socket.on('scrollUp', () => {
    cp.exec('xdotool click 4');
  });

  socket.on('click', data => {
    const { x, y } = JSON.parse(data);

    cp.exec(`xdotool getwindowgeometry ${currentWindow} | head -2 | tail -1`, (err, output) => {
      try {
        const [ winX, winY ] = output.match(/([0-9]+)/g).map(it => parseInt(it));

        cp.exec(`xdotool mousemove ${winX + x} ${winY + y}; xdotool click 1`);
      } catch (e) {}
    });
  });
});

let smallBuffer = [];

const panic = (realShit = true) => {
  buffer = Buffer.from('');
  smallBuffer = [];

  if (realShit) console.log('Real shit is happening!');
};

process.stdin.on('data', data => {
  const magicCheck3 = data.indexOf(MAGIC_3) >= 0;

  smallBuffer.push(data);

  if (magicCheck3) {
    buffer = Buffer.concat(smallBuffer);
  } else {
    return;
  }

  const magicCheck1 = buffer.indexOf(MAGIC_1) >= 0;
  const magicCheck2 = buffer.indexOf(MAGIC_2) >= 0;

  if (!magicCheck1 && !magicCheck2 && !magicCheck3) {
    panic();
    return;
  }

  const metadataIndex = buffer.indexOf(MAGIC_1);
  const imageDataIndex = buffer.indexOf(MAGIC_2);
  const endIndex = buffer.indexOf(MAGIC_3);

  if (metadataIndex >= 0 && imageDataIndex >= 0 && endIndex >= 0) {
    const everything = buffer.slice(metadataIndex, endIndex + 1);

    const metadata = everything.slice(MAGIC_1.byteLength, MAGIC_1.byteLength + METADATA_BYTE_LENGTH);
    const w = metadata.readInt16LE(0);
    let h = metadata.readInt16LE(2);

    const bytesPerPixel = metadata.readInt16LE(4);

    if (!w || !h || bytesPerPixel !== BYTES_PER_PIXEL) {
      return panic();
    }

    let imageData = buffer.slice(imageDataIndex + MAGIC_2.byteLength, endIndex);
    if (!imageData || imageData.byteLength !== w * h * bytesPerPixel) {
      return;
    }

    if (h % 2 === 1) {
      h += 1;
      imageData = Buffer.concat([ imageData, Buffer.alloc(w * bytesPerPixel, 0) ]);
    }

    const finalImage = new Uint8ClampedArray(imageData)
    handleImage(finalImage, w, h);

    buffer = buffer.slice(endIndex + MAGIC_3.byteLength, buffer.length);
    smallBuffer = [ buffer ];
    buffer = Buffer.from('');
  }

  if (buffer.byteLength > 128 * 1024 * 1024) {
    console.log('Buffer overflow');
    buffer = Buffer.from('');
    smallBuffer = [];
  }
});
