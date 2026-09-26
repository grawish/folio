const { parentPort } = require('node:worker_threads');
const { zipSync } = require('fflate');
parentPort.on('message', ({ id, entries }) => {
  const mode = Buffer.from(entries['state.json']).toString();
  if (mode === 'crash') throw new Error('Synthetic worker failure');
  if (mode === 'exit') process.exit(23);
  if (mode === 'hang')
    for (;;) {
      /* terminated by the production deadline */
    }
  if (mode === 'wrong-id') {
    parentPort.postMessage({ id: id + 1 });
    return;
  }
  if (mode === 'bad-output') {
    parentPort.postMessage({ id, archive: new Uint8Array(2) });
    return;
  }
  const archive = zipSync(entries);
  parentPort.postMessage({ id, archive }, [archive.buffer]);
});
