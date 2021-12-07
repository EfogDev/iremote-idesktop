const cp = require('child_process');
const stream = require('stream');
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require('socket.io');
const Jimp = require('jimp');
const io = new Server(server, {
  maxHttpBufferSize: 4e6,
});

app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

server.listen(15777);

const pngMagic = new Uint8Array([ 0xFF, 0xD8 ]);
let buffer = Buffer.from('');
let superMegaCache = null;
let currentWindow = null;

const openWindow = (windowId) => {
  cp.exec(`xdotool windowsize ${windowId} 1000 700; xdotool windowactivate ${windowId}`, () => {
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
  cp.exec('wmctrl -l | cut -d" " -f1', (err, list) => {
    const winIDs = list.split('\n').map(it => it.trim());
    const windows = {};

    winIDs.forEach((windowID, index) => {
      cp.exec(`xprop -id ${windowID} -notype 32c _NET_WM_ICON`, (err, iconData) => {
        const data = iconData.replace('_NET_WM_ICON = ', '').split(', ').map(it => parseInt(it));
        const [ width, height ] = [ data[0], data[1] ];

        if (!width || !height) {
          winIDs.splice(index, 1);
          return;
        }

        new Jimp(width, height, (err, image) => {
          for (let x = 0; x < width; x++) {
            for (let y = 0; y < height; y++) {
              let color = data[2 + width * x + y];
              const alpha = color >>> 24;

              color = (color << 8) >>> 0;
              color += alpha;

              image.setPixelColor(color, x, y);
            }
          }

          image.getBuffer(Jimp.MIME_PNG, (err, buffer) => {
            windows[windowID] = { iconData: buffer.toString('base64') };

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

  const quant = cp.spawn('pngquant', ['128', '--speed', '10', '--strip'], {
    stdio: [null, null, 'ignore'],
  });

  let output = [];

  quant.stdout.on('data', data => output.push(data));
  quant.stdin.write(image);

  quant.on('close', () => {
    const image = Buffer.concat(output);

    zlib.deflateRaw(image, (err, compressed) => {
      io.sockets.emit('img', JSON.stringify({ i: compressed.toString('base64') }));
    });
  });
};

io.on('connection', (socket) => {
  getWindowsList();

  socket.on('activate', (data) => {
    openWindow(JSON.parse(data));
  });
});

process.stdin.on('data', data => {
  buffer = Buffer.concat([ buffer, data ]);

  const index = buffer.indexOf(pngMagic);
  if (index >= 0 && buffer.indexOf(pngMagic, index + 1) >= 0) {
    const chunk = buffer.slice(0, buffer.indexOf(pngMagic, index + 1));
    const image = chunk.slice(chunk.indexOf(pngMagic));
    const hash = image.length;

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
