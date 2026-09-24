const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const output = fs.createWriteStream(path.join(__dirname, '..', 'public', 'tars-vision-bridge.zip'));
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', function () {
  console.log('Successfully zipped ' + archive.pointer() + ' bytes into public/tars-vision-bridge.zip');
});

archive.on('error', function (err) {
  throw err;
});

archive.pipe(output);
archive.directory(path.join(__dirname, '..', 'public', 'tars-extension'), false);
archive.finalize();
