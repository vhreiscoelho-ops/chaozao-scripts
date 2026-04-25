const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { load, save } = require('../store');

const router = express.Router();
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 120_000,
});

// ─── Sistema ──────────────────────────────────────────────────────────────────
const SYSTEM = `Você é um especialista sênior em vendas consultivas do Chãozão, maior plataforma de imóveis rurais do Brasil.
Você conhece profundamente o perfil do comprador rural brasileiro: proprietários de fazenda, produtores, investidores e corretores de interior.
Sua missão: gerar scripts que soem como uma conversa real entre um vendedor experiente e um amigo — nunca um roteiro de call center.

PRINCÍPIOS INEGOCIÁVEIS:
1. HUMANIDADE ACIMA DE TUDO — Cada fala deve soar como algo que um vendedor experiente diria naturalmente ao telefone, não como texto escrito.
2. FOCO NO FECHAMENTO — Cada etapa deve avançar em direção a uma decisão: assinar agora ou agendar data específica + proposta.
3. ZERO CORPORATIVISMO — Proibido: "excelente escolha", "com certeza", "claro que sim", "sem dúvida", "absolutamente", "perfeito", "fantástico". Proibido frases de chatbot.
4. LINGUAGEM REGIONAL — Use expressões do interior brasileiro quando pertinente ao perfil do lead. Seja direto e respeitoso como o homem do campo.
5. SEMPRE JSON PURO — Responda SEMPRE com JSON puro e válido. Nunca use markdown. Nunca adicione texto antes ou depois do JSON.`;

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
  urgencia: `ESTRATÉGIA: Urgência e Escassez.
Aplique ao longo de TODO o script, não só no fechamento.
- Na etapa 2: mencione casualmente que a condição/preço é por tempo limitado
- Na penúltima etapa: torne a urgência concreta (prazo real, não inventado)
- No fechamento: use a urgência como alavanca natural, não como pressão
- Tom: "olha, eu quero te avisar antes que mude" — não "é só até hoje!"`,

  sonho: `ESTRATÉGIA: Sonho e Identidade.
- Nas etapas de descoberta: faça o lead FALAR sobre o que quer (não você descrever)
- Use as próprias palavras do lead para espelhar o sonho de volta
- Conecte cada benefício do plano à realidade específica que ele descreveu
- No fechamento: "a gente já sabe o que você quer — isso aqui é o caminho"
- Linguagem: aspiracional mas concreta, não poética`,

  racional: `ESTRATÉGIA: Racional e ROI.
- Prepare 2-3 números concretos baseados no briefing (valorização, custo por lead, comparação)
- Cada afirmação de valor deve ter dado ou lógica por trás — não promessa vaga
- Antecipe objeções de preço com comparação custo vs. não anunciar
- No fechamento: mostre o cálculo — quanto custa não fechar agora vs. fechar
- Tom: analítico, mas não frio — "faz sentido no papel e na prática"`,

  consultivo: `ESTRATÉGIA: Consultivo.
- Etapa 1-2: APENAS perguntas — deixe o lead falar pelo menos 60% do tempo
- Use a técnica do diagnóstico: "antes de te apresentar qualquer coisa, me conta..."
- Só apresente solução depois de entender a dor real — não antes
- No fechamento: "baseado no que você me contou, isso resolve exatamente o problema X"
- Posição: parceiro que entende, não vendedor que empurra`,

  social: `ESTRATÉGIA: Prova Social.
- Use cases ESPECÍFICOS (mesmo que genéricos): "tive um cliente semana passada em MG..."
- Perfil similar ao lead — não use case de outro segmento
- Volume quando pertinente: "a maioria dos corretores da região já usa"
- No fechamento: "outros no seu perfil que foram em frente — como foi pra eles"
- Tom: "não precisa acreditar em mim — veja o que aconteceu com quem foi em frente"`
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
    ? `\n${STRATEGIES[strategy]}\nTodo o script deve seguir esta abordagem de forma consistente.\n`
    : '';

  return `Analise o briefing e retorne SOMENTE o objeto JSON abaixo. Comece com { e termine com }.
${stratBlock}
DADOS:
- Closer: ${closer}
- Horário da call: ${callTime || 'A definir'}
- Plano discutido: ${planVal}

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

REGRAS DE CONTEÚDO:
${SCORE_REGRA}
- stats: exatamente 4 cards (Lead, Imóvel, Contexto da venda, Plano)
- etapas: entre 5 e 7 (excluindo objeções e fechamento)
- objecoes: 3 a 5, baseadas no perfil real do lead
- alertas_topo: máximo 2
- personalizar COMPLETAMENTE para o perfil do lead — nada de texto genérico

REGRAS DE LINGUAGEM — CRÍTICAS:
- Falas em PRIMEIRA PESSOA de ${closer}, como se fosse dito ao telefone agora
- PROIBIDO usar: "excelente", "fantástico", "perfeito", "com certeza", "sem dúvida", "absolutamente", "claro que sim", "ótima pergunta", "entendo sua preocupação"
- PROIBIDO frases de call center: "como posso te ajudar hoje?", "estou à disposição", "qualquer dúvida estou aqui"
- USE linguagem natural do interior brasileiro quando o perfil do lead pedir: "olha", "cara", "vou te ser direto", "deixa eu te contar uma coisa", "na prática", "no dia a dia"
- Cada fala deve ter UMA ideia só — frases curtas, no máximo 2 linhas
- Cada etapa DEVE avançar em direção ao fechamento ou proposta

REGRAS DE ESTRUTURA DAS ETAPAS:
- Etapa 1: quebra-gelo RÁPIDO (máx 30s) + âncora no motivo da call — sem papo prolongado
- Etapas do meio: descoberta consultiva ou apresentação de valor, sempre com pergunta que avança
- Penúltima etapa: criar condição para decisão (não "vou pensar" — oferecer alternativas concretas)
- Última etapa antes do fechamento: confirmação do fit — lead confirma que faz sentido
- Etapa FECHAMENTO: direto, sem rodeios, com 2 opções (fecha agora OU agenda data + gera proposta)

REGRA DE OURO DO FECHAMENTO:
O fechamento NUNCA deve ser "se você quiser, posso enviar mais informações".
Deve ser: "Então vamos fechar hoje? Se não der hoje, me diz uma data e eu mando a proposta com tudo que a gente conversou — você olha e me dá o sim."
Adapte essa lógica para o tom e plano do lead.`;
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
    const stream  = client.messages.stream({
      model:      'claude-sonnet-4-6',
      max_tokens: 5000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
    });
    const message = await stream.finalMessage();
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
