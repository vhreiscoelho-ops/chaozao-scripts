const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'chaozao.json');

const DEFAULT = {
  closers: [
    { id: 1, name: 'Victor', active: true },
    { id: 2, name: 'Ana',    active: true },
    { id: 3, name: 'Rafael', active: true },
    { id: 4, name: 'Julia',  active: true }
  ],
  history: [],
  _seq: { closer: 5, history: 1 }
};

// In-memory cache — JS is single-threaded, so no race conditions here.
// All reads/writes go through _db; disk is only for persistence.
let _db = null;

function load() {
  if (_db) return _db;
  try {
    _db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    // Ensure structure integrity after loading from disk
    if (!Array.isArray(_db.closers)) _db.closers = JSON.parse(JSON.stringify(DEFAULT.closers));
    if (!Array.isArray(_db.history)) _db.history = [];
    if (!_db._seq) _db._seq = { closer: 5, history: 1 };
  } catch {
    _db = JSON.parse(JSON.stringify(DEFAULT));
    _persist();
  }
  return _db;
}

function save(data) {
  _db = data;
  // Write to disk async — in-memory is the source of truth
  _persist();
}

function _persist() {
  const dir = path.dirname(FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFile(FILE, JSON.stringify(_db, null, 2), err => {
    if (err) console.error('[store] Erro ao gravar disco:', err.message);
  });
}

module.exports = { load, save };
