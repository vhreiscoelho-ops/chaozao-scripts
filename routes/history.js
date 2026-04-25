const express = require('express');
const { load, save } = require('../store');

const router = express.Router();

// Pendências diárias agrupadas por closer
router.get('/pending', (_req, res) => {
  const { history } = load();
  const now = new Date();

  // Proposta enviada aguardando resposta (resultado === 'proposta' há mais de 1 dia)
  const propostas = history.filter(h =>
    h.resultado === 'proposta' &&
    h.mode === 'script' &&
    (now - new Date(h.createdAt)) > 86_400_000  // >1 dia
  );

  // Reagendados (resultado === 'reagendou') — sempre pendente até fechar
  const reagendados = history.filter(h => h.resultado === 'reagendou');

  // Scripts gerados hoje sem resultado ainda
  const today = now.toISOString().slice(0, 10);
  const semResultado = history.filter(h =>
    h.resultado === null &&
    h.mode === 'script' &&
    h.createdAt.startsWith(today)
  );

  // Agrupa por closer
  const byCloser = {};
  const add = (item, tipo, diasEspera) => {
    const c = item.closer || 'Sem closer';
    if (!byCloser[c]) byCloser[c] = [];
    byCloser[c].push({ ...item, _tipo: tipo, _diasEspera: diasEspera });
  };

  propostas.forEach(h => {
    const dias = Math.floor((now - new Date(h.createdAt)) / 86_400_000);
    add(h, 'proposta_aguardando', dias);
  });
  reagendados.forEach(h => add(h, 'reagendado', null));
  semResultado.forEach(h => add(h, 'sem_resultado_hoje', null));

  const total = propostas.length + reagendados.length + semResultado.length;
  res.json({ total, byCloser });
});

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
