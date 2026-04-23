const express = require('express');
const { load, save } = require('../store');

const router = express.Router();

router.get('/', (_req, res) => {
  const { closers } = load();
  res.json(closers.filter(c => c.active));
});

router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });

  const store = load();
  const closer = { id: store._seq.closer++, name: name.trim(), active: true };
  store.closers.push(closer);
  save(store);

  res.status(201).json(closer);
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Nome obrigatório' });

  const store = load();
  const closer = store.closers.find(c => c.id === id);
  if (!closer) return res.status(404).json({ error: 'Closer não encontrado' });

  closer.name = name.trim();
  save(store);
  res.json(closer);
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const store = load();
  const closer = store.closers.find(c => c.id === id);
  if (!closer) return res.status(404).json({ error: 'Closer não encontrado' });

  closer.active = false;
  save(store);
  res.json({ ok: true });
});

module.exports = router;
