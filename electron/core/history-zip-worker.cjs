const { parentPort } = require('node:worker_threads');
const { zipSync } = require('fflate');
const limits = require('./history-archive-limits.json');

// This worker receives validated snapshots, never filenames to read or code to run.
// Repeat byte/count bounds here before allocating compression output.
parentPort.on('message', ({ id, entries, timestamp }) => {
  try {
    const names = Object.keys(entries);
    if (!names.length || names.length > limits.entries)
      throw new Error('History exceeds the archive file-count limit.');
    let bytes = 0;
    const files = Object.create(null);
    for (const name of names) {
      const data = entries[name];
      if (
        !/^(state\.json|versions\/[a-zA-Z0-9_-]{1,100}\/(source\.json|resume\.pdf))$/.test(name) ||
        !(data instanceof Uint8Array) ||
        data.byteLength > limits.entryBytes
      )
        throw new Error('A history entry is invalid or exceeds the 25 MB archive limit.');
      bytes += data.byteLength;
      if (bytes > limits.expandedBytes)
        throw new Error('History is too large to bundle in this project (200 MB limit).');
      // PDFs already contain compressed streams. Store their exact bytes;
      // compress the source and conversation JSON where it is useful.
      files[name] = [data, { level: name.endsWith('/resume.pdf') ? 0 : 6 }];
    }
    let archive = zipSync(files, { mtime: new Date(timestamp) });
    // Keep previously savable near-limit histories compatible: if storing the
    // PDFs is too large, retry the original fully deflated ZIP representation.
    if (archive.byteLength > limits.compressedBytes) {
      archive = null;
      archive = zipSync(entries, { mtime: new Date(timestamp) });
    }
    if (archive.byteLength > limits.compressedBytes)
      throw new Error('Compressed history exceeds the 100 MB archive limit.');
    parentPort.postMessage({ id, archive }, [archive.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
