// Disk backend for src/world/storage.js Storage (dedicated server). One directory per world:
//   <dir>/<worldId>/meta.bin            world meta            (v8.serialize: structured-clone values)
//   <dir>/<worldId>/chunks/<cx>_<cz>.bin chunk records         { f, n, d: RLE bytes } (encodeChunkRecord)
//   <dir>/<worldId>/data/<name>.bin      saveWorldData records (Int32Array lists etc.)
// Writes go to a temporary file that is renamed over the old one, so a crash never leaves a torn file.
// Writes of a snapshot are serialized behind each other (one at a time).
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { Storage } from '../src/world/storage.js';

const SAFE_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

async function writeAtomic(file, buf) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, file);
}

async function readValue(file) {
  try {
    return v8.deserialize(await fs.readFile(file));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export class FileBackend {
  /** @param {string} dir root directory (created if missing) */
  constructor(dir) {
    this.kind = 'file';
    this.persistent = true;
    this.dir = path.resolve(dir);
    fss.mkdirSync(this.dir, { recursive: true });
    this._keys = new Map();          // worldId -> Set('cx,cz')
    this._chain = Promise.resolve();
  }

  _worldDir(worldId) {
    if (!SAFE_NAME.test(worldId)) throw new RangeError(`bad world id '${worldId}'`);
    return path.join(this.dir, worldId);
  }

  async _ensure(worldId) {
    const d = this._worldDir(worldId);
    await fs.mkdir(path.join(d, 'chunks'), { recursive: true });
    await fs.mkdir(path.join(d, 'data'), { recursive: true });
    return d;
  }

  _serial(fn) {
    const p = this._chain.then(fn, fn);
    this._chain = p.catch(() => {});
    return p;
  }

  async getData(worldId, name) {
    if (!SAFE_NAME.test(name)) return null;
    return readValue(path.join(this._worldDir(worldId), 'data', `${name}.bin`));
  }

  putData(worldId, name, value) {
    if (!SAFE_NAME.test(name)) return Promise.reject(new RangeError(`bad data name '${name}'`));
    return this._serial(async () => {
      const d = await this._ensure(worldId);
      await writeAtomic(path.join(d, 'data', `${name}.bin`), v8.serialize(value));
    });
  }

  async getAllWorlds() {
    const out = [];
    let names = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return out;
    }
    for (const n of names) {
      if (!SAFE_NAME.test(n)) continue;
      const m = await readValue(path.join(this.dir, n, 'meta.bin')).catch(() => null);
      if (m && typeof m.id === 'string') out.push(m);
    }
    return out;
  }

  putWorld(meta) {
    return this._serial(async () => {
      const d = await this._ensure(meta.id);
      await writeAtomic(path.join(d, 'meta.bin'), v8.serialize(meta));
    });
  }

  async getWorld(id) {
    return readValue(path.join(this._worldDir(id), 'meta.bin'));
  }

  deleteWorld(id) {
    return this._serial(async () => {
      await fs.rm(this._worldDir(id), { recursive: true, force: true });
      this._keys.delete(id);
    });
  }

  async getChunkKeys(worldId) {
    let set = this._keys.get(worldId);
    if (!set) {
      set = new Set();
      try {
        for (const f of await fs.readdir(path.join(this._worldDir(worldId), 'chunks'))) {
          const m = /^(-?\d+)_(-?\d+)\.bin$/.exec(f);
          if (m) set.add(`${m[1]},${m[2]}`);
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      this._keys.set(worldId, set);
    }
    return [...set];
  }

  /** True when the chunk has a saved copy (dedicated server: "modified" chunks). */
  hasChunk(worldId, cx, cz) {
    return this._keys.get(worldId)?.has(`${cx},${cz}`) ?? false;
  }

  async getChunk(worldId, cx, cz) {
    return readValue(path.join(this._worldDir(worldId), 'chunks', `${cx}_${cz}.bin`));
  }

  putChunks(worldId, records) {
    return this._serial(async () => {
      const d = await this._ensure(worldId);
      await this._writeChunks(worldId, d, records);
    });
  }

  async _writeChunks(worldId, d, records) {
    let set = this._keys.get(worldId);
    if (!set) {
      await this.getChunkKeys(worldId);
      set = this._keys.get(worldId);
    }
    for (const r of records) {
      await writeAtomic(path.join(d, 'chunks', `${r.cx}_${r.cz}.bin`), v8.serialize(r.rec));
      set.add(`${r.cx},${r.cz}`);
    }
  }

  putSnapshot(worldId, meta, records, data) {
    // Values are copied now (callers keep mutating them); the files are written in the background.
    const metaBuf = meta ? v8.serialize(meta) : null;
    const recs = records.map((r) => ({ cx: r.cx, cz: r.cz, rec: r.rec }));
    const dataBufs = data.map((x) => ({ name: x.name, buf: v8.serialize(x.value) }));
    return this._serial(async () => {
      const d = await this._ensure(worldId);
      await this._writeChunks(worldId, d, recs);
      for (const x of dataBufs) {
        if (SAFE_NAME.test(x.name)) await writeAtomic(path.join(d, 'data', `${x.name}.bin`), x.buf);
      }
      if (metaBuf) await writeAtomic(path.join(d, 'meta.bin'), metaBuf);
    });
  }

  close() {}
}

/** A Storage (src/world/storage.js API) persisted under `dir`. */
export function openFileStorage(dir) {
  const backend = new FileBackend(dir);
  const storage = new Storage(backend);
  return { storage, backend };
}
