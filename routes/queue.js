const express = require('express');
const { load, save } = require('../store');
const router = express.Router();

// ─── GET /api/queue?date=YYYY-MM-DD&closer=Victor ─────────────────────────────
router.get('/', (req, res) => {
  const { date, closer } = req.query;
  const store = load();
  let items = Array.isArray(store.queue) ? [...store.queue] : [];

  if (date) items = items.filter(i => i.date === date);
  if (closer && closer !== 'Todos') items = items.filter(i => i.closerName === closer);

  // Sort: pending first (by creation time), then calling, then done
  const ORDER = { pending: 0, calling: 1, done: 2 };
  items.sort((a, b) => {
    const diff = (ORDER[a.status] ?? 0) - (ORDER[b.status] ?? 0);
    if (diff !== 0) return diff;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });

  res.json(items);
});

// ─── POST /api/queue — adiciona lead manualmente ──────────────────────────────
router.post('/', (req, res) => {
  const {
    leadName    = '',
    closerName  = '',
    planVal     = '',
    callTime    = '',
    briefing    = '',
    sdrSummary  = '',
    urgencyNote = '',
    recAction   = '',
    source      = 'manual',
    date        = new Date().toISOString().split('T')[0],
  } = req.body || {};

  if (!leadName.trim() && !briefing.trim())
    return res.status(400).json({ error: 'leadName ou briefing é obrigatório.' });

  const store = load();
  if (!Array.isArray(store.queue)) store.queue = [];
  if (!store._seq.queue) store._seq.queue = 1;

  const id   = store._seq.queue++;
  const item = {
    id,
    leadName:    leadName.trim(),
    closerName:  closerName.trim(),
    planVal:     planVal.trim(),
    callTime:    callTime.trim(),
    briefing:    briefing.substring(0, 600),
    sdrSummary:  (sdrSummary || briefing).substring(0, 150),
    urgencyNote: urgencyNote.trim(),
    recAction:   recAction.trim(),
    source,
    date,
    status:      'pending',
    resultado:   null,
    skipReason:  '',
    scoreValor:  null,
    scriptJson:  null,
    historyId:   null,
    createdAt:   new Date().toISOString(),
    updatedAt:   null,
  };

  store.queue.unshift(item);
  if (store.queue.length > 500) store.queue.length = 500;
  save(store);

  res.json(item);
});

// ─── POST /api/queue/webhook — recebe do KOMO e cria item na fila ─────────────
// Compatível com o payload do webhook existente (closer, briefing, callTime, planVal)
router.post('/webhook', (req, res) => {
  const expected = process.env.WEBHOOK_SECRET;
  if (expected) {
    const provided =
      (req.headers['x-webhook-secret']) ||
      (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
      req.body?.secret;
    if (provided !== expected)
      return res.status(401).json({ error: 'Token inválido.' });
  }

  const body = req.body || {};

  function extractField(text, ...keys) {
    for (const key of keys) {
      const m = text.match(new RegExp(`${key}\\s*:\\s*(.+)`, 'i'));
      if (m) return m[1].trim();
    }
    return '';
  }

  let rawBriefing = body.briefing || body.note || body.text || body.message || '';
  if (!rawBriefing.trim())
    return res.status(400).json({ error: 'Nenhum briefing encontrado no payload.' });

  const closer   = body.closer   || extractField(rawBriefing, 'Closer', 'Responsável');
  const callTime = body.callTime || (() => {
    const raw = extractField(rawBriefing, 'Agendado', 'Horário', 'Data');
    const m = raw.match(/(\d{1,2})[h:](\d{2})?/i);
    if (m) return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
    return '';
  })();
  const planVal  = body.planVal  || extractField(rawBriefing, 'Plano', 'Pacote') || '3x R$ 399,33';
  const leadName = body.leadNome || extractField(rawBriefing, 'Lead', 'Nome', 'Cliente') || '';

  if (!closer)
    return res.status(400).json({ error: 'Não foi possível identificar o Closer.' });

  const store = load();
  if (!Array.isArray(store.queue)) store.queue = [];
  if (!store._seq.queue) store._seq.queue = 1;

  const id   = store._seq.queue++;
  const item = {
    id,
    leadName:    leadName,
    closerName:  closer,
    planVal:     planVal,
    callTime:    callTime,
    briefing:    rawBriefing.substring(0, 600),
    sdrSummary:  rawBriefing.substring(0, 150),
    urgencyNote: '',
    recAction:   '',
    source:      'webhook',
    date:        new Date().toISOString().split('T')[0],
    status:      'pending',
    resultado:   null,
    skipReason:  '',
    scoreValor:  null,
    scriptJson:  null,
    historyId:   null,
    createdAt:   new Date().toISOString(),
    updatedAt:   null,
  };

  store.queue.unshift(item);
  if (store.queue.length > 500) store.queue.length = 500;
  save(store);

  console.log(`[queue/webhook] Lead adicionado — ${leadName || '?'} | Closer: ${closer}`);
  res.json({ ok: true, id, leadName, closer });
});

// ─── PATCH /api/queue/:id — atualiza status, resultado, scriptJson etc. ───────
router.patch('/:id', (req, res) => {
  const id    = Number(req.params.id);
  const store = load();
  if (!Array.isArray(store.queue)) store.queue = [];

  const item = store.queue.find(i => i.id === id);
  if (!item) return res.status(404).json({ error: 'Item não encontrado.' });

  const ALLOWED = [
    'status', 'resultado', 'skipReason', 'scriptJson',
    'scoreValor', 'historyId', 'sdrSummary', 'urgencyNote', 'recAction',
    'callTime', 'planVal', 'closerName',
  ];
  ALLOWED.forEach(k => { if (req.body[k] !== undefined) item[k] = req.body[k]; });
  item.updatedAt = new Date().toISOString();

  save(store);
  res.json(item);
});

// ─── DELETE /api/queue/:id ────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
  const id    = Number(req.params.id);
  const store = load();
  if (!Array.isArray(store.queue)) store.queue = [];

  const idx = store.queue.findIndex(i => i.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Item não encontrado.' });

  store.queue.splice(idx, 1);
  save(store);
  res.json({ ok: true });
});

module.exports = router;
