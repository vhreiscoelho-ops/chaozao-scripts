const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { load } = require('../store');

const router = express.Router();
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 120_000,
});

// ─── System prompt (cacheável) ────────────────────────────────────────────────
const FOLLOWUP_SYSTEM = `Você é um especialista sênior em follow-up de vendas do Chãozão, maior plataforma de imóveis rurais do Brasil.
Analise dados de leads que receberam proposta e não responderam, e gere mensagens de follow-up altamente personalizadas.
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

// ─── Route POST / ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { nome, valor, dias, plano, canal, perfil, contexto, closer } = req.body;

  if (!nome || !valor) {
    return res.status(400).json({ error: 'Campos obrigatórios: nome, valor.' });
  }

  const diasNum = parseInt(dias) || 0;
  const urgencia = diasNum === 0 ? 'não informado' : diasNum <= 2 ? 'baixa' : diasNum <= 5 ? 'média' : 'alta';

  const prompt = `Analise os dados do lead abaixo e gere 3 mensagens de follow-up personalizadas. Retorne SOMENTE o JSON abaixo, começando com { e terminando com }. Sem markdown, sem texto fora do JSON.

DADOS DO LEAD:
- Nome: ${nome}
- Valor da proposta: ${valor}
- Dias sem resposta: ${diasNum}
- Plano / produto: ${plano || 'Não informado'}
- Canal de envio: ${canal || 'WhatsApp'}
- Perfil do lead: ${perfil || 'Não informado'}
- Contexto adicional: ${contexto || 'Nenhum'}
- Closer responsável: ${closer || 'Closer'}
- Urgência calculada: ${urgencia}

JSON esperado:
{
  "lead_nome": "string (primeiro nome do lead)",
  "dias_parado": ${diasNum},
  "urgencia": "${urgencia}",
  "canal": "${canal || 'WhatsApp'}",
  "abordagens": [
    {
      "tipo": "suave",
      "label": "Toque Leve",
      "emoji": "🌱",
      "mensagem": "string (pronta para enviar, sem aspas externas, quebras com \\n)",
      "dica": "string (quando usar)",
      "timing": "string (ex: Manha, entre 9h-11h)"
    },
    {
      "tipo": "urgencia",
      "label": "Criar Urgencia",
      "emoji": "⏰",
      "mensagem": "string",
      "dica": "string",
      "timing": "string"
    },
    {
      "tipo": "valor",
      "label": "Reforco de Valor",
      "emoji": "💡",
      "mensagem": "string",
      "dica": "string",
      "timing": "string"
    }
  ],
  "alerta": "string (observacao estrategica sobre este lead)",
  "proximo_passo": "string (o que fazer se nenhuma abordagem funcionar)"
}

REGRAS:
- Mensagens em pt-BR, linguagem natural, ${closer || 'Closer'} fala em 1a pessoa
- PROIBIDO usar travessao (—) em qualquer parte. Use hifen simples (-) se precisar
- Para WhatsApp: 3-5 linhas, emojis naturais e contextuais
- Para E-mail: mais formal, tom profissional
- Para Ligacao: script resumido do que dizer ao telefone
- Urgencia: ${urgencia === 'não informado' ? 'calibre para tom neutro/profissional' : `${urgencia} (${diasNum} dia${diasNum > 1 ? 's' : ''} parado) — calibre o tom adequadamente`}
- Nao use aspas externas na mensagem, apenas o texto puro
- Retorne APENAS o JSON, sem nenhum texto antes ou depois`;

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
