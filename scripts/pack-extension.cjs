const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const extDir = path.join(__dirname, '..', 'public', 'tars-extension');
const publicZip = path.join(__dirname, '..', 'public', 'tars-vision-bridge.zip');
const extFolderZip = path.join(extDir, 'tars-vision-bridge.zip');

if (fs.existsSync(extFolderZip)) {
  fs.unlinkSync(extFolderZip);
}
if (fs.existsSync(publicZip)) {
  fs.unlinkSync(publicZip);
}

const output = fs.createWriteStream(publicZip);
const archive = typeof archiver === 'function' ? archiver('zip', { zlib: { level: 9 } }) : new archiver.ZipArchive({ zlib: { level: 9 } });

output.on('close', function () {
  const bytes = archive.pointer();
  console.log(`Successfully zipped ${bytes} bytes into public/tars-vision-bridge.zip`);
  
  // Copy to public/tars-extension/tars-vision-bridge.zip
  fs.copyFileSync(publicZip, extFolderZip);
  console.log(`Successfully copied zip to public/tars-extension/tars-vision-bridge.zip`);
});

archive.on('error', function (err) {
  throw err;
});

archive.pipe(output);

const files = fs.readdirSync(extDir);
for (const file of files) {
  if (file.endsWith('.zip')) continue;
  const fullPath = path.join(extDir, file);
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    archive.directory(fullPath, file);
  } else {
    archive.file(fullPath, { name: file });
  }
}

archive.finalize();
