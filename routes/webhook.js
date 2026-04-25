const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const { load, save } = require('../store');

const router = express.Router();
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 120_000,
});

// ─── Sistema ──────────────────────────────────────────────────────────────────
const SYSTEM = `Você é um especialista sênior em fechamento de vendas do Chãozão, maior plataforma especializada em imóveis rurais do Brasil.

O QUE O CHÃOZÃO VENDE:
O Chãozão vende visibilidade qualificada — não é corretora, não divide comissão, não garante venda.
Entrega: o comprador certo chega até o imóvel com mais velocidade.
Prova: 2,5 milhões de acessos, 125 mil seguidores, +800 matérias na imprensa.
NUNCA prometa venda. NUNCA mencione comissão. O Chãozão é portal, não corretora.

PAPEL DO CLOSER:
A SDR já fez rapport, legitimação e qualificação (etapas 1-3). O closer ENTRA direto na etapa 4.
O closer JÁ RECEBE do SDR: perfil do lead, quantidade de imóveis, tempo tentando vender, valor estimado, estratégia atual e se usa plataforma paga.
O script gerado deve ser APENAS para as etapas 4-6: Ampliação do Problema, Definição do Caminho, Condução da Venda.

PRINCÍPIOS INEGOCIÁVEIS:
1. HUMANIDADE ACIMA DE TUDO — Cada fala deve soar como algo que um vendedor experiente diria ao telefone, não como texto escrito.
2. FOCO NO FECHAMENTO — Cada etapa avança em direção a uma decisão: assinar agora ou agendar data específica + proposta.
3. ZERO CORPORATIVISMO — Proibido: "excelente", "fantástico", "perfeito", "com certeza", "sem dúvida", "absolutamente", "ótima pergunta", "entendo sua preocupação". Proibido frases de chatbot ou call center.
4. LINGUAGEM DO CAMPO — Use expressões do interior brasileiro quando o perfil pedir: direto, respeitoso, sem enrolação.
5. SEMPRE JSON PURO — Responda SEMPRE com JSON puro e válido. Nunca markdown. Nunca texto fora do JSON.`;

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

BRIEFING DO SDR (qualificação já feita — rapport e legitimação não precisam ser repetidos):
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
- etapas: entre 5 e 6 (excluindo objeções e fechamento), seguindo a estrutura obrigatória abaixo
- objecoes: 3 a 5, com resposta no modelo Ouvir → Diagnosticar → Reposicionar → Avançar
- alertas_topo: máximo 2
- Personalizar COMPLETAMENTE para o perfil do lead — zero texto genérico

ESTRUTURA OBRIGATÓRIA DAS ETAPAS (nesta ordem):

ETAPA 1 — AMPLIAÇÃO DO PROBLEMA (~3 min):
- O closer ENTRA DIRETO aqui. Sem repetir apresentação que a SDR já fez.
- Use os 3 pontos do briefing: tempo tentando vender + valor do imóvel + estratégia atual
- Mostre que a estratégia atual LIMITA o resultado — sem atacar o lead
- Encerre com micro-confirmação obrigatória: o lead concorda que o canal está limitando o alcance
- Exemplo de fala de confirmação: "você concorda que o problema não é o imóvel, é para quem ele está aparecendo?"

ETAPA 2 — DEFINIÇÃO DO CAMINHO (~2 min):
- Pergunta obrigatória: "Você já conhecia o portal do Chãozão, ou chegou só pelo formulário?"
- SE viu o portal: avança direto para a venda
- SE não viu: conduz visualização rápida → marca retorno → retoma venda
- Encerre com micro-confirmação: lead concorda que faz sentido aparecer para esse público

ETAPA 3 — GERAÇÃO DE VALOR — 3 camadas nesta ordem (~3 min):
- Camada 1: conecta com a DOR específica do lead (use o que o SDR coletou)
- Camada 2: mostra a LÓGICA do portal (especializado em rural, comprador qualificado)
- Camada 3: SÓ ENTÃO traz a PROVA — 2,5M acessos, 125K seguidores, +800 matérias na imprensa
- Micro-confirmação: lead confirma que a lógica faz sentido para o caso dele

ETAPA 4 — CUSTO DE NÃO ENTRAR (~2 min):
- Use ANTES de apresentar preço. Argumentos concretos:
  * Imóvel fora do radar do comprador certo enquanto fica parado
  * Cada mês sem venda = custo de manutenção + oportunidade perdida
  * Depender de canal que não alcança quem compra rural
- Recomende o plano de forma FIRME: "O plano que faz mais sentido para o seu caso é o [X] porque..."
- Ancora SEMPRE no anual primeiro

ETAPA 5 — APRESENTAÇÃO DO PREÇO (~2 min):
- Preço só após o valor estar construído
- Apresente como investimento, não custo
- Compare com o custo de não vender (manutenção, imposto, oportunidade)
- Micro-confirmação: "Faz sentido esse investimento dado o que a gente conversou?"

REGRAS DE LINGUAGEM — CRÍTICAS:
- Falas em PRIMEIRA PESSOA de ${closer}, como se fosse dito ao telefone agora
- PROIBIDO: "excelente", "fantástico", "perfeito", "com certeza", "sem dúvida", "absolutamente", "claro que sim", "ótima pergunta", "entendo sua preocupação", "infelizmente a gente não faz assim", "é o valor, não tem o que fazer", "estou à disposição", "qualquer dúvida estou aqui"
- USE: "olha", "vou te ser direto", "deixa eu te mostrar", "na prática", "o que pesa mais pra você — o valor, o prazo ou a confiança no retorno?", "faz mais sentido fechar no anual ou começar no semestral?"
- Cada fala: UMA ideia, máximo 2 linhas
- Chips: palavras-chave curtas para o closer lembrar na hora (ex: "confirma limitação", "ancora anual", "custo de não entrar")

REGRAS DE OBJEÇÕES:
- Modelo obrigatório: Ouvir → Diagnosticar → Reposicionar → Avançar
- "Está caro": diagnostique se é valor, prazo ou confiança — "O que pesou mais: o valor, o prazo ou a confiança no retorno?"
- "Me manda no WhatsApp": descubra a objeção real — "Antes de mandar, o que ficou de dúvida — é o preço, a plataforma ou o retorno?"
- "Qual a garantia de venda?": reposicione — "Nenhum canal sério garante venda. O Chãozão entrega visibilidade qualificada e o comprador certo."
- "O mercado está parado": vire a lógica — "Justamente quando o mercado fica lento, aparecer para o comprador certo importa mais."
- NUNCA aceite "vou analisar" como fim — sempre descubra a objeção real antes de encerrar

REGRA DE OURO DO FECHAMENTO:
Ordem de negociação — mude UMA alavanca por vez, nunca pule etapas:
1. Recomendação firme no anual
2. Semestral (se travou no valor cheio)
3. Desconto (máx 15%, só após defender o valor com fit claro)
4. Troca de plano (como último recurso para proteger o fechamento)
NUNCA: "se você quiser eu te mando e você vê" / "qualquer coisa depois você me fala"
SEMPRE: "Então vamos fechar hoje? Se não der hoje, me diz uma data — mando a proposta com tudo que a gente conversou e você me dá o sim."
Adapte essa lógica para o tom e plano do lead.

ATENÇÃO FINAL — OBRIGATÓRIO: Sua resposta DEVE começar com { e terminar com }. Zero texto antes ou depois. Nenhuma explicação. Apenas o JSON completo e válido.`;
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
