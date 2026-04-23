const express = require('express');
const { load, save } = require('../store');

const router = express.Router();

// Lista sem payload pesado
router.get('/', (_req, res) => {
  const { history } = load();
  res.json(history.map(({ resultJson: _r, briefing: _b, ...rest }) => rest));
});

// Item completo (para recarregar da tela de histórico)
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const item = load().history.find(h => h.id === id);
  if (!item) return res.status(404).json({ error: 'Não encontrado' });
  res.json(item);
});

// Registrar resultado e/ou observação pós-call
router.patch('/:id/resultado', (req, res) => {
  const id = Number(req.params.id);
  const { resultado, observacao, transcricao } = req.body;

  const OPCOES = ['fechou', 'proposta', 'reagendou', 'sem_perfil', 'perdeu'];
  if (resultado !== undefined && !OPCOES.includes(resultado))
    return res.status(400).json({ error: 'Resultado inválido' });

  const store = load();
  const item  = store.history.find(h => h.id === id);
  if (!item) return res.status(404).json({ error: 'Não encontrado' });

  if (resultado   !== undefined) item.resultado   = resultado;
  if (observacao  !== undefined) item.observacao  = String(observacao).substring(0, 1000);
  if (transcricao !== undefined) item.transcricao = String(transcricao).substring(0, 20000);
  item.updatedAt = new Date().toISOString();

  save(store);
  res.json({ ok: true });
});

// Remover entrada
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const store = load();
  const idx = store.history.findIndex(h => h.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  store.history.splice(idx, 1);
  save(store);
  res.json({ ok: true });
});

module.exports = router;
