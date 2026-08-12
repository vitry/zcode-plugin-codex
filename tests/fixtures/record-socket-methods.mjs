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
const invalidateFirstBrokerIdentity = process.env.ZCODE_TEST_INVALIDATE_FIRST_BROKER_IDENTITY === '1';
if (fsRecordPath || invalidateFirstBrokerIdentity) {
  let invalidatedBrokerIdentity = false;
  for (const method of ['chmod', 'lstat', 'mkdir', 'open', 'opendir', 'readFile', 'realpath', 'rename', 'unlink']) {
    const operation = fs.promises[method];
    fs.promises[method] = async function instrumentedFileOperation(...args) {
      if (method === 'readFile' && invalidateFirstBrokerIdentity && !invalidatedBrokerIdentity
        && /[\\/]broker[\\/]identity(?:-[a-f0-9]{16})?\.json$/.test(String(args[0]))) {
        invalidatedBrokerIdentity = true;
        return '{';
      }
      try { return await operation.apply(this, args); }
      catch (error) { if (fsRecordPath) appendFileSync(fsRecordPath, `${method}:${error?.code ?? 'UNKNOWN'}\n`); throw error; }
    };
  }
  syncBuiltinESMExports();
}
