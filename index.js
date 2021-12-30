const cp = require('child_process');
const fs = require('fs');
const express = require('express');
const app = express();
const https = require('https');
const { json } = require('body-parser');

const server = https.createServer({
  key: fs.readFileSync('./key.pem'),
  cert: fs.readFileSync('./cert.pem'),
}, app);

const { Server } = require('socket.io');
const Jimp = require('jimp');

global.image = null;
const fullscreenHeight = 782, defaultHeight = 734;
let width = 1100, height = defaultHeight;

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

const pngMagic = new Uint8Array([ 0x2d, 0x35, 0x35, 0x38, 0x39, 0x30, 0x37, 0x36, 0x36, 0x35, 0x32, 0x32, 0x39, 0x35, 0x35, 0x34, 0x38, 0x35, 0x38 ]);
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

        if (!dataPixels)
          return;

        const [ width, height ] = [ dataPixels[0], dataPixels[1] ];

        if (!width || !height) {
          winIDs.splice(index, 1);
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

const handleImage = (image) => {
  if (!currentWindow)
    return;

  options.setImage(image, width, height);
};

io.on('connection', (socket) => {
  getWindowsList();

  socket.on('activate', (data) => {
    openWindow(JSON.parse(data));
  });

  socket.on('maximize', () => {
    height = defaultHeight;
    openWindow();
  });

  socket.on('minimize', () => {
    height = fullscreenHeight;
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

process.stdin.on('data', data => {
  buffer = Buffer.concat([ buffer, data ]);

  const index = buffer.indexOf(pngMagic);
  if (index >= 0 && buffer.indexOf(pngMagic, index + 1) >= 0) {
    const chunk = buffer.slice(0, buffer.indexOf(pngMagic, index + 1));
    const imageData = chunk.slice(chunk.indexOf(pngMagic) + pngMagic.length);
    const image = imageData.slice(4);
    const hash = image.length;

    width = imageData.readInt16LE(0);
    height = imageData.readInt16LE(2);

    buffer = Buffer.from('');

    if (hash === superMegaCache)
      return;

    superMegaCache = hash;
    handleImage(image);
  }

  if (buffer.length > 512 * 1024) {
    buffer = Buffer.from('');
  }
});
