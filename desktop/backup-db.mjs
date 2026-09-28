import { backup, DatabaseSync } from 'node:sqlite';

const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('缺少数据库迁移路径');
const db = new DatabaseSync(source);
try { await backup(db, destination); }
finally { db.close(); }
