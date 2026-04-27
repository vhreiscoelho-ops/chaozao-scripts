const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 120_000,
});

// ─── System prompt (cacheável) ────────────────────────────────────────────────
const FOLLOWUP_SYSTEM = `Você é um especialista sênior em fechamento de vendas por mensagem do Chãozão, maior plataforma de imóveis rurais do Brasil.
Seu único objetivo: gerar mensagens WhatsApp que movem o lead para o próximo passo sem precisar de ligação.
Princípios que NUNCA negocia:
1. Sem abertura genérica ("Olá, tudo bem?", "Oi, como vai?"). Vá direto ao ponto.
2. Cada mensagem termina com uma pergunta ou ação clara — o lead sabe exatamente o que fazer.
3. Nada de pressão vazia. Urgência e valor precisam ser concretos e específicos para aquele lead.
4. Tom: humano, direto, sem corporativismo.
REGRA ABSOLUTA: Responda SEMPRE com JSON puro e válido. Nunca use markdown. Nunca adicione texto antes ou depois do JSON. Sua resposta DEVE começar com { e terminar com }. Nenhuma exceção.`;

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

// ─── Contexto comum ───────────────────────────────────────────────────────────
function ctxBlock({ nome, valor, plano, perfil, contexto, closer }) {
  return `CONTEXTO DO LEAD:
- Nome: ${nome}
- Valor da proposta: ${valor}
- Plano: ${plano || 'Chãozão'}
- Perfil: ${perfil || 'não informado'}
- Contexto / situação: ${contexto || 'nenhum'}
- Closer: ${closer || 'Closer'}`;
}

const REGRAS_COMUNS = `REGRAS ABSOLUTAS:
- PROIBIDO começar com "Olá tudo bem", "Oi, como vai", "Espero que esteja bem" ou qualquer abertura de aquecimento
- PROIBIDO usar travessao (—). Use hifen simples (-) se precisar separar algo
- Use o nome do lead, o valor e o plano nas mensagens — nada de texto genérico
- Tom: humano, direto, sem corpo de email corporativo
- Retorne APENAS o JSON`;

// ─── Prompts por tipo ─────────────────────────────────────────────────────────
function promptProposta(ctx) {
  return `Gere 3 mensagens de fechamento (WhatsApp) para um lead que recebeu proposta e não respondeu. Objetivo: extrair um SIM ou NÃO sem precisar de ligação. Retorne SOMENTE o JSON abaixo, começando com { e terminando com }.

${ctx}

TÉCNICA DE CADA ABORDAGEM:

1. TOQUE LEVE - Remove o desconforto de decidir.
Técnica: Reconhece que ele está ocupado, tira a pressão, pede só um sinal de vida. A pergunta final deve ser do tipo "pode me mandar um sim ou não aqui mesmo?" ou "ainda faz sentido pra você?". Máximo 4 linhas. Sem emojis excessivos.

2. PUXADA DIRETA - Provoca uma decisão agora.
Técnica: Menciona algo concreto que muda se ele não decidir (prazo, condição, oportunidade). Não ameaça — apresenta o cenário real. A pergunta final exige um posicionamento claro. Tom: firme e respeitoso.

3. REFORÇO CIRÚRGICO - Reacende o desejo pelo benefício específico.
Técnica: Lembra UMA dor específica do lead (baseada no perfil/contexto) e conecta diretamente ao que ele ganha com o plano. Não lista benefícios genéricos — foca no que importa PRA ELE. Fecha com uma pergunta que só exige um "sim" para avançar.

JSON esperado:
{
  "lead_nome": "string (primeiro nome)",
  "abordagens": [
    {
      "tipo": "suave",
      "label": "Toque Leve",
      "emoji": "🌱",
      "mensagem": "string (mensagem pronta, quebras com \\n, termina com pergunta binária)",
      "gatilho": "string (o que essa mensagem ativa psicologicamente no lead)",
      "quando_usar": "string (situação ideal para enviar esta versão)"
    },
    {
      "tipo": "urgencia",
      "label": "Puxada Direta",
      "emoji": "🎯",
      "mensagem": "string",
      "gatilho": "string",
      "quando_usar": "string"
    },
    {
      "tipo": "valor",
      "label": "Reforço Cirúrgico",
      "emoji": "🔎",
      "mensagem": "string",
      "gatilho": "string",
      "quando_usar": "string"
    }
  ],
  "alerta": "string (leitura estratégica deste lead — por que ainda não respondeu e o que isso indica)",
  "proximo_passo": "string (se nenhuma mensagem funcionar, o que fazer — seja específico)"
}

- Cada mensagem DEVE terminar com uma pergunta simples que o lead responde com sim, não, ou emoji
- Se houver contexto/objeção, use-o na abordagem relevante
${REGRAS_COMUNS}`;
}

function promptCobranca(ctx) {
  return `Gere 3 mensagens de WhatsApp para um lead que DISSE SIM e recebeu o link de pagamento, mas ainda não pagou. Objetivo: fazer ele completar o pagamento sem soar como cobrança agressiva. Retorne SOMENTE o JSON abaixo, começando com { e terminando com }.

${ctx}

TÉCNICA DE CADA ABORDAGEM:

1. LEMBRETE GENTIL - Remove fricção, assume esquecimento.
Técnica: Tom leve, sem acusação. Assume que foi correria ou esquecimento — não arrependimento. Oferece ajuda para completar: "precisa de ajuda ou quer que eu gere um novo link?". Máximo 4 linhas.

2. VERIFICAÇÃO TÉCNICA - Dá uma saída honrosa.
Técnica: Sugere que o link pode ter expirado ou tido problema técnico, e se oferece para resolver imediatamente. Elimina a desculpa técnica como barreira. Tom: prestativo e proativo.

3. RETOMADA DO SIM - Reativa a decisão que ele já tomou.
Técnica: Lembra brevemente por que ele disse sim, reconfirma que a decisão foi certa, e encaminha direto para a ação de pagar. Tom: confiante, como quem está ajudando a completar algo que ele mesmo quis.

JSON esperado:
{
  "lead_nome": "string (primeiro nome)",
  "abordagens": [
    {
      "tipo": "gentil",
      "label": "Lembrete Gentil",
      "emoji": "🔔",
      "mensagem": "string (mensagem pronta, quebras com \\n, termina com ação ou pergunta clara)",
      "gatilho": "string (o que essa mensagem ativa no lead)",
      "quando_usar": "string (quando enviar esta versão)"
    },
    {
      "tipo": "tecnico",
      "label": "Verificação Técnica",
      "emoji": "🔧",
      "mensagem": "string",
      "gatilho": "string",
      "quando_usar": "string"
    },
    {
      "tipo": "reativacao",
      "label": "Retomada do Sim",
      "emoji": "✅",
      "mensagem": "string",
      "gatilho": "string",
      "quando_usar": "string"
    }
  ],
  "alerta": "string (por que ainda não pagou — leitura estratégica do momento)",
  "proximo_passo": "string (se não pagar após as mensagens, próximo passo concreto)"
}

- PROIBIDO cobrar de forma agressiva ou acusatória — ele JÁ disse sim
- PROIBIDO mencionar que ele está devendo ou atrasado
- A pergunta/ação final de cada mensagem deve ser fácil de responder
${REGRAS_COMUNS}`;
}

function promptRelacionamento(ctx) {
  return `Gere 3 mensagens de WhatsApp para manter relacionamento com um lead que NÃO fechou agora (disse não, pediu mais tempo, ou esfriou). Objetivo: manter presença qualificada e reabrir a conversa na hora certa, sem forçar venda. Retorne SOMENTE o JSON abaixo, começando com { e terminando com }.

${ctx}

TÉCNICA DE CADA ABORDAGEM:

1. CHECK-IN LEVE - Reaparece sem pressão comercial.
Técnica: Mensagem curta e humana. Pode comentar algo relacionado ao mercado rural, à região, ou simplesmente perguntar como está a situação do imóvel. A pergunta final é casual, não comercial. Use semanas ou meses depois do não.

2. GATILHO DE MERCADO - Usa contexto externo para reabrir.
Técnica: Menciona uma movimentação do mercado rural, uma época favorável, ou tendência relevante para o perfil dele. Conecta ao imóvel ou situação dele e reabre o assunto de forma natural. Tom: informativo, não vendedor.

3. NOVA CONDIÇÃO - Apresenta algo que mudou.
Técnica: Apresenta algo real ou plausível que mudou (novo plano, resultado de cliente similar, nova audiência no portal). Tom: "lembrei de você quando vi isso". Fecha com pergunta aberta que convida à conversa — não cobra decisão.

JSON esperado:
{
  "lead_nome": "string (primeiro nome)",
  "abordagens": [
    {
      "tipo": "checkin",
      "label": "Check-in Leve",
      "emoji": "👋",
      "mensagem": "string (mensagem pronta, quebras com \\n, pergunta casual no final)",
      "gatilho": "string (o que essa mensagem ativa no lead)",
      "quando_usar": "string (quando enviar esta versão)"
    },
    {
      "tipo": "mercado",
      "label": "Gatilho de Mercado",
      "emoji": "📊",
      "mensagem": "string",
      "gatilho": "string",
      "quando_usar": "string"
    },
    {
      "tipo": "nova_condicao",
      "label": "Nova Condição",
      "emoji": "💡",
      "mensagem": "string",
      "gatilho": "string",
      "quando_usar": "string"
    }
  ],
  "alerta": "string (leitura do momento deste lead — quando e como reabrir sem desgastar)",
  "proximo_passo": "string (se não engajar em nenhuma das 3, o que fazer)"
}

- PROIBIDO mencionar preço ou plano nas abordagens 1 e 2 — é relacionamento, não venda
- PROIBIDO pressionar por decisão — o objetivo é manter presença qualificada
- A pergunta final deve ser fácil de responder sem comprometimento
${REGRAS_COMUNS}`;
}

// ─── Route POST / ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { nome, valor, plano, canal, perfil, contexto, closer, tipo = 'proposta' } = req.body;

  if (!nome || !valor) {
    return res.status(400).json({ error: 'Campos obrigatórios: nome, valor.' });
  }

  const ctx = ctxBlock({ nome, valor, plano, perfil, contexto, closer });

  let prompt;
  if (tipo === 'cobranca')       prompt = promptCobranca(ctx);
  else if (tipo === 'relacionamento') prompt = promptRelacionamento(ctx);
  else                           prompt = promptProposta(ctx);

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: [{ type: 'text', text: FOLLOWUP_SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }]
    });
    const message = await stream.finalMessage();
    const raw = (message.content || []).map(c => c.text || '').join('');
    const json = extractJson(raw);
    json._tipo = tipo; // passa o tipo de volta para o frontend renderizar corretamente
    res.json(json);
  } catch (err) {
    console.error('[followup] status:', err.status, '| type:', err.constructor?.name, '| msg:', err.message);
    const msg = err.status === 401 ? 'API Key inválida. Verifique o arquivo .env.'
      : err.status === 429 ? 'Limite de requisições atingido. Aguarde alguns segundos.'
      : err.message;
    res.status(500).json({ error: msg });
  }
});

module.exports = router;
