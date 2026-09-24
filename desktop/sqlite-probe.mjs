import('node:sqlite')
  .then((m) => console.log('SQLITE_OK', typeof m.DatabaseSync, 'node', process.versions.node, 'electron', process.versions.electron))
  .catch((e) => console.log('SQLITE_FAIL', e.message, 'node', process.versions.node, 'electron', process.versions.electron));
setTimeout(() => process.exit(0), 1000);
