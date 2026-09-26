try {
  const { DatabaseSync } = await import('node:sqlite');
  if (typeof DatabaseSync !== 'function') throw new Error('DatabaseSync 不可用');
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE probe (id INTEGER)');
  db.close();
  console.log('SQLITE_OK', process.versions.node, process.versions.electron);
} catch (error) {
  console.error('SQLITE_FAIL', error.message);
  process.exitCode = 1;
}
