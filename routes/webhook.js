const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { load, save } = require('../store');

const router = express.Router();
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 120_000,
});

// ─── Sistema ──────────────────────────────────────────────────────────────────
const SYSTEM = `Você é um especialista sênior em vendas do Chãozão, maior plataforma de imóveis rurais do Brasil.
Analise briefings de SDRs e gere scripts de fechamento altamente personalizados.
REGRA ABSOLUTA: Responda SEMPRE com JSON puro e válido. Nunca use markdown. Nunca adicione texto antes ou depois do JSON. Sua resposta DEVE começar com { e terminar com }. Nenhuma exceção.`;

const SCORE_SCHEMA = `
  "score": {
    "valor": number (1-10),
    "classificacao": "Alta propensão | Média propensão | Baixa propensão",
    "justificativa": "string (2 frases diretas baseadas no briefing)",
    "alertas": ["string (alerta prático para o closer, máx 3)"]
  },`;

const SCORE_REGRA = `- score: avalie 1-10 (8-10=alta, 5-7=média, 1-4=baixa) com base em urgência, fit, sinais de compra, perfil do decisor e objeções já mapeadas
- score.alertas: máximo 3, cada um com ação concreta para o closer`;

const STRATEGIES = {
  urgencia:   'ESTRATÉGIA: Urgência e Escassez — enfatize prazo, condição especial que expira, oportunidade limitada.',
  sonho:      'ESTRATÉGIA: Sonho e Identidade — conecte o imóvel à realização pessoal, legado, visão de futuro.',
  racional:   'ESTRATÉGIA: Racional e ROI — use dados, valorização histórica, comparação custo vs. benefício.',
  consultivo: 'ESTRATÉGIA: Consultivo — faça perguntas poderosas, diagnostique, posicione-se como parceiro especialista.',
  social:     'ESTRATÉGIA: Prova Social — use cases de clientes similares, volume de clientes satisfeitos.',
};

function extractJson(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch {}
  const cb = t.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (cb) { try { return JSON.parse(cb[1].trim()); } catch {} }
  const bounds = t.match(/\{[\s\S]+\}/);
  if (bounds) { try { return JSON.parse(bounds[0]); } catch {} }
  throw new Error('JSON não encontrado na resposta da IA');
}

function scriptPrompt(closer, callTime, planVal, briefing, strategy) {
  const stratBlock = strategy && STRATEGIES[strategy]
    ? `\n${STRATEGIES[strategy]}\nTodo o script deve seguir esta abordagem.\n`
    : '';

  return `Analise o briefing e retorne SOMENTE o objeto JSON abaixo. Comece diretamente com { e termine com }.
${stratBlock}
DADOS:
- Closer: ${closer}
- Horário: ${callTime || 'A definir'}
- Plano: ${planVal}

BRIEFING DO SDR:
${briefing}

JSON esperado:
{${SCORE_SCHEMA}
  "lead_nome": "string",
  "subtitulo": "string (imóvel · cidade · horário · Closer: nome)",
  "alertas_topo": [{ "tipo": "verde|aviso|alerta", "titulo": "string", "texto": "string" }],
  "stats": [{ "label": "string", "val": "string", "sub": "string" }],
  "etapas": [{
    "titulo": "string", "tempo": "string (~X min)",
    "alerta": { "tipo": "verde|aviso|alerta", "texto": "string" },
    "falas": ["string"],
    "destaque": { "titulo": "string", "texto": "string" },
    "dica": "string", "chips": ["string"]
  }],
  "objecoes": [{ "titulo": "string (Se disser: …)", "resposta": "string" }],
  "fechamento": { "titulo": "string", "tempo": "~2 min", "falas": ["string"], "dica": "string" }
}

REGRAS:
${SCORE_REGRA}
- stats: exatamente 4 cards (Lead, Imóvel, Contexto da venda, Plano)
- etapas: entre 5 e 7 (excluindo objeções e fechamento)
- objecoes: 3 a 5 objeções relevantes para o perfil
- alertas_topo: máximo 2
- falas em primeira pessoa do closer ${closer}, linguagem natural, sem markdown
- campos opcionais (alerta, destaque, chips) podem ser null ou []
- personalizar COMPLETAMENTE para o perfil do lead`;
}

// ─── Autenticação ─────────────────────────────────────────────────────────────
function authenticate(req, res) {
  const expected = process.env.WEBHOOK_SECRET;
  if (!expected) return true; // sem secret configurado = aceita tudo (dev)
  const provided =
    (req.headers['x-webhook-secret']) ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    req.body?.secret;
  if (provided !== expected) {
    res.status(401).json({ error: 'Token inválido. Verifique o WEBHOOK_SECRET.' });
    return false;
  }
  return true;
}

// ─── POST /api/webhook/briefing ───────────────────────────────────────────────
// Payload esperado (JSON):
// {
//   "closer":   "Nome do Closer",         ← obrigatório
//   "briefing": "Texto completo do SDR",  ← obrigatório
//   "callTime": "14:30",                  ← opcional
//   "planVal":  "3x R$ 399,33",           ← opcional
//   "strategy": "urgencia",               ← opcional (urgencia|sonho|racional|consultivo|social)
//   "secret":   "seu-token"               ← alternativo ao header
// }
router.post('/briefing', async (req, res) => {
  if (!authenticate(req, res)) return;

  const {
    closer   = '',
    briefing = '',
    callTime = '',
    planVal  = '3x R$ 399,33',
    strategy = null,
  } = req.body || {};

  if (!closer.trim())
    return res.status(400).json({ error: 'Campo "closer" é obrigatório.' });
  if (!briefing.trim())
    return res.status(400).json({ error: 'Campo "briefing" é obrigatório.' });
  if (briefing.length > 4000)
    return res.status(400).json({ error: 'Briefing muito longo (máx 4000 caracteres).' });

  // Verifica se o closer existe no cadastro (aviso, não bloqueia)
  const store     = load();
  const closerObj = store.closers.find(c => c.name.toLowerCase() === closer.toLowerCase());
  if (!closerObj) console.warn(`[webhook] Closer "${closer}" não encontrado no cadastro.`);

  try {
    const prompt  = scriptPrompt(closer, callTime, planVal, briefing, strategy);
    const message = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 8000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
    });
    const raw  = (message.content || []).map(c => c.text || '').join('');
    const json = extractJson(raw);

    const id = store._seq.history++;
    store.history.unshift({
      id,
      mode:       'script',
      source:     'webhook',        // marca a origem
      closer:     closerObj?.name || closer,
      callTime,
      planVal,
      briefing:   briefing.substring(0, 600),
      leadNome:   json.lead_nome || 'Lead',
      scoreValor: json.score?.valor ?? null,
      resultJson: json,
      resultado:  null,
      observacao: '',
      createdAt:  new Date().toISOString(),
    });
    if (store.history.length > 200) store.history.length = 200;
    save(store);

    console.log(`[webhook] Script gerado — Lead: ${json.lead_nome} | Closer: ${closer} | Score: ${json.score?.valor}`);
    res.json({ ok: true, id, leadNome: json.lead_nome, score: json.score?.valor });

  } catch (err) {
    console.error('[webhook] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/webhook/komo ───────────────────────────────────────────────────
// Endpoint dedicado para o Komo CRM / SDR IA
// O briefing do Komo tem este formato:
//   Perfil: Proprietário
//   Imóveis: 1
//   Localização: Bahia
//   Valor estimado: R$ 20.000.000,00
//   Closer: Isabel
//   Agendado: amanhã às 10h
//   ---
//   **Briefing para Isabel - Lead Bahia...**
//   (texto completo)
router.post('/komo', async (req, res) => {
  if (!authenticate(req, res)) return;

  // Komo pode enviar como JSON ou form-encoded
  const body = req.body || {};

  // Campo "briefing" pode vir diretamente ou dentro de campos do Komo
  let rawBriefing = body.briefing || body.note || body.text || body.message || '';

  if (!rawBriefing.trim())
    return res.status(400).json({ error: 'Nenhum briefing encontrado no payload.' });

  // ── Extrai campos do formato do briefing da SDR IA ──────────────────────
  function extractField(text, ...keys) {
    for (const key of keys) {
      const m = text.match(new RegExp(`${key}\\s*:\\s*(.+)`, 'i'));
      if (m) return m[1].trim();
    }
    return '';
  }

  const closer   = body.closer   || extractField(rawBriefing, 'Closer', 'Responsável', 'Atendente');
  const callTime = body.callTime || (() => {
    const raw = extractField(rawBriefing, 'Agendado', 'Horário', 'Data');
    // Extrai HH:MM se encontrar padrão de hora
    const m = raw.match(/(\d{1,2})[h:](\d{2})?/i);
    if (m) return `${m[1].padStart(2,'0')}:${(m[2]||'00').padStart(2,'0')}`;
    return '';
  })();
  const planVal  = body.planVal  || extractField(rawBriefing, 'Plano', 'Pacote', 'Valor do plano') || '3x R$ 399,33';
  const leadNomeHint = body.leadNome || extractField(rawBriefing, 'Lead', 'Nome', 'Cliente') || '';

  if (!closer)
    return res.status(400).json({ error: 'Não foi possível identificar o Closer no briefing. Inclua "Closer: Nome" no texto ou envie o campo "closer" no payload.' });

  if (rawBriefing.length > 4000)
    rawBriefing = rawBriefing.substring(0, 4000);

  const store     = load();
  const closerObj = store.closers.find(c => c.name.toLowerCase() === closer.toLowerCase());
  if (!closerObj) console.warn(`[webhook/komo] Closer "${closer}" não cadastrado.`);

  try {
    const prompt  = scriptPrompt(closer, callTime, planVal, rawBriefing, null);
    const message = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 8000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
    });
    const raw  = (message.content || []).map(c => c.text || '').join('');
    const json = extractJson(raw);

    const id = store._seq.history++;
    store.history.unshift({
      id,
      mode:       'script',
      source:     'webhook',
      closer:     closerObj?.name || closer,
      callTime,
      planVal,
      briefing:   rawBriefing.substring(0, 600),
      leadNome:   json.lead_nome || leadNomeHint || 'Lead',
      scoreValor: json.score?.valor ?? null,
      resultJson: json,
      resultado:  null,
      observacao: '',
      createdAt:  new Date().toISOString(),
    });
    if (store.history.length > 200) store.history.length = 200;
    save(store);

    console.log(`[webhook/komo] Script gerado — Lead: ${json.lead_nome} | Closer: ${closer} | Score: ${json.score?.valor}`);
    res.json({ ok: true, id, leadNome: json.lead_nome, closer, score: json.score?.valor, callTime });

  } catch (err) {
    console.error('[webhook/komo] Erro:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/webhook/info ─────────────────────────────────────────────────────
// Retorna status do webhook (sem expor o secret)
router.get('/info', (_req, res) => {
  res.json({
    ok:            true,
    secretConfig:  !!process.env.WEBHOOK_SECRET,
    endpoints: {
      generico: '/api/webhook/briefing',
      komo:     '/api/webhook/komo',
    },
    method:        'POST',
    contentType:   'application/json',
    camposObrigatorios: ['closer', 'briefing'],
    camposOpcionais:    ['callTime', 'planVal', 'strategy', 'secret'],
    estrategias:   Object.keys(STRATEGIES),
  });
});

module.exports = router;
