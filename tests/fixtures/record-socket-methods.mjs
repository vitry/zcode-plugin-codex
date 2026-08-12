// @ts-nocheck
import fs, { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

const recordPath = process.env.ZCODE_TEST_SOCKET_METHOD_RECORD;
if (recordPath) {
  const write = net.Socket.prototype.write;
  net.Socket.prototype.write = function instrumentedWrite(chunk, ...args) {
    try {
      const frame = JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      if (typeof frame?.method === 'string') appendFileSync(recordPath, `${frame.method}\n`);
    } catch { /* Only complete JSON-RPC request frames are diagnostic evidence. */ }
    return write.call(this, chunk, ...args);
  };
}

const fsRecordPath = process.env.ZCODE_TEST_FS_ERROR_RECORD;
if (fsRecordPath) {
  for (const method of ['chmod', 'lstat', 'mkdir', 'open', 'opendir', 'readFile', 'realpath', 'rename', 'unlink']) {
    const operation = fs.promises[method];
    fs.promises[method] = async function instrumentedFileOperation(...args) {
      try { return await operation.apply(this, args); }
      catch (error) { appendFileSync(fsRecordPath, `${method}:${error?.code ?? 'UNKNOWN'}\n`); throw error; }
    };
  }
  syncBuiltinESMExports();
}
