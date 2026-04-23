const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { load, save } = require('../store');

const router = express.Router();
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 120_000,
});

// ─── System context (cacheado pela API do Claude) ─────────────────────────────
const SYSTEM = `Você é um especialista sênior em vendas do Chãozão, maior plataforma de imóveis rurais do Brasil.
Analise briefings de SDRs e gere scripts de fechamento ou propostas comerciais altamente personalizados.
REGRA ABSOLUTA: Responda SEMPRE com JSON puro e válido. Nunca use markdown. Nunca adicione texto antes ou depois do JSON. Sua resposta DEVE começar com { e terminar com }. Nenhuma exceção.`;

// ─── Estratégias para A/B ─────────────────────────────────────────────────────
const STRATEGIES = {
  urgencia:   'ESTRATÉGIA: Urgência e Escassez — enfatize prazo, condição especial que expira, oportunidade limitada. Crie urgência genuína sem ser agressivo. Falas e etapas devem refletir essa abordagem.',
  sonho:      'ESTRATÉGIA: Sonho e Identidade — conecte o imóvel à realização pessoal, legado, visão de futuro e identidade do comprador. Faça o lead se ver como proprietário. Linguagem aspiracional.',
  racional:   'ESTRATÉGIA: Racional e ROI — use dados, valorização histórica, comparação custo vs. benefício, retorno sobre investimento. Fale a linguagem de números e lógica.',
  consultivo: 'ESTRATÉGIA: Consultivo — faça perguntas poderosas, diagnostique a situação real do lead, co-construa a solução. Posicione-se como parceiro especialista, não vendedor.',
  social:     'ESTRATÉGIA: Prova Social — use cases de clientes com perfil similar, volume de clientes satisfeitos, depoimentos. Mostre que outros já tomaram essa decisão com sucesso.'
};

// ─── Extração robusta de JSON ─────────────────────────────────────────────────
function extractJson(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch {}
  const cb = t.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (cb) { try { return JSON.parse(cb[1].trim()); } catch {} }
  const bounds = t.match(/\{[\s\S]+\}/);
  if (bounds) { try { return JSON.parse(bounds[0]); } catch {} }
  console.error('[extractJson] falha ao parsear. Primeiros 500 chars:', t.slice(0, 500));
  throw new Error('JSON não encontrado na resposta da IA');
}

// ─── Bloco de score (comum a todos os prompts) ────────────────────────────────
const SCORE_SCHEMA = `
  "score": {
    "valor": number (1-10),
    "classificacao": "Alta propensão | Média propensão | Baixa propensão",
    "justificativa": "string (2 frases diretas baseadas no briefing)",
    "alertas": ["string (alerta prático para o closer, máx 3)"]
  },`;

const SCORE_REGRA = `- score: avalie 1-10 (8-10=alta, 5-7=média, 1-4=baixa) com base em urgência, fit, sinais de compra, perfil do decisor e objeções já mapeadas
- score.alertas: máximo 3, cada um com ação concreta para o closer`;

// ─── Prompts ──────────────────────────────────────────────────────────────────
function scriptPrompt(closer, callTime, planVal, briefing, strategy = null) {
  const stratBlock = strategy && STRATEGIES[strategy]
    ? `\n${STRATEGIES[strategy]}\nTodo o script deve seguir esta abordagem de forma consistente.\n`
    : '';

  return `Analise o briefing e retorne SOMENTE o objeto JSON abaixo. NÃO inclua explicações, markdown, texto antes ou depois. Comece sua resposta diretamente com { e termine com }.
${stratBlock}
DADOS:
- Closer: ${closer}
- Horário: ${callTime}
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

function proposalPrompt(closer, planVal, briefing) {
  return `Crie uma proposta comercial personalizada. Retorne SOMENTE o objeto JSON abaixo. NÃO inclua explicações, markdown, texto antes ou depois. Comece sua resposta diretamente com { e termine com }.

DADOS:
- Closer: ${closer}
- Plano: ${planVal}

BRIEFING DO SDR:
${briefing}

JSON esperado:
{${SCORE_SCHEMA}
  "lead_nome": "string",
  "subtitulo": "string (Proposta Comercial · imóvel · cidade · Closer: nome)",
  "resumo": "string (2-3 frases apresentando a proposta ao lead)",
  "alerta": { "tipo": "verde|aviso", "titulo": "string", "texto": "string" },
  "stats": [{ "label": "string", "val": "string", "sub": "string" }],
  "por_que_chaozao": ["string"],
  "solucao": { "titulo": "string", "descricao": "string", "beneficios": ["string"] },
  "investimento": { "plano": "string", "condicoes": "string", "inclui": ["string"] },
  "proximos_passos": ["string"],
  "validade": "string",
  "cta": "string"
}

REGRAS:
${SCORE_REGRA}
- stats: exatamente 4 cards (Lead, Imóvel, Investimento, Validade)
- por_que_chaozao: 3 a 5 razões específicas para ESTE lead
- linguagem calorosa, consultiva e personalizada`;
}

// ─── Chamada à API ─────────────────────────────────────────────────────────────
async function callClaude(prompt) {
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: prompt }]
  });
  const raw = (message.content || []).map(c => c.text || '').join('');
  return extractJson(raw);
}

// ─── Salvar no histórico ───────────────────────────────────────────────────────
function saveItem(store, fields) {
  const id = store._seq.history++;
  store.history.unshift({
    id,
    resultado: null,
    observacao: '',
    ...fields,
    createdAt: new Date().toISOString()
  });
  return id;
}

// ─── Route ────────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    mode      = 'script',
    closer    = 'Closer',
    callTime  = '',
    planVal   = '',
    briefing  = '',
    strategyA = 'urgencia',
    strategyB = 'sonho'
  } = req.body;

  if (!briefing.trim())
    return res.status(400).json({ error: 'Briefing é obrigatório.' });
  if (briefing.length > 4000)
    return res.status(400).json({ error: 'Briefing muito longo (máx 4000 caracteres).' });

  try {
    // ── Modo A/B: duas variantes em paralelo ──────────────────────────────────
    if (mode === 'ab') {
      const [jsonA, jsonB] = await Promise.all([
        callClaude(scriptPrompt(closer, callTime, planVal, briefing, strategyA)),
        callClaude(scriptPrompt(closer, callTime, planVal, briefing, strategyB))
      ]);

      const abSessionId = Date.now().toString(36);
      const store = load();

      const base = { mode: 'script', closer, callTime, planVal, briefing: briefing.substring(0, 600), leadNome: jsonA.lead_nome || 'Lead', abSessionId };
      const idA = saveItem(store, { ...base, abGroup: 'A', strategy: strategyA, scoreValor: jsonA.score?.valor ?? null, leadNome: jsonA.lead_nome || 'Lead', resultJson: jsonA });
      const idB = saveItem(store, { ...base, abGroup: 'B', strategy: strategyB, scoreValor: jsonB.score?.valor ?? null, leadNome: jsonB.lead_nome || 'Lead', resultJson: jsonB });

      if (store.history.length > 200) store.history.length = 200;
      save(store);

      return res.json({
        ab: true,
        abSessionId,
        a: { id: idA, result: jsonA, strategy: strategyA },
        b: { id: idB, result: jsonB, strategy: strategyB }
      });
    }

    // ── Modo normal: script ou proposta ───────────────────────────────────────
    const prompt = mode === 'proposal'
      ? proposalPrompt(closer, planVal, briefing)
      : scriptPrompt(closer, callTime, planVal, briefing);

    const json = await callClaude(prompt);

    const store = load();
    const id = saveItem(store, {
      mode, closer, callTime, planVal,
      briefing: briefing.substring(0, 600),
      leadNome: json.lead_nome || 'Lead',
      scoreValor: json.score?.valor ?? null,
      resultJson: json
    });
    if (store.history.length > 200) store.history.length = 200;
    save(store);

    res.json({ id, result: json });

  } catch (err) {
    console.error('[generate] status:', err.status, '| type:', err.constructor?.name, '| msg:', err.message);
    const msg = err.status === 401 ? 'API Key inválida. Verifique o arquivo .env.'
      : err.status === 429 ? 'Limite de requisições atingido. Aguarde alguns segundos.'
      : err.message;
    res.status(500).json({ error: msg });
  }
});

module.exports = router;
