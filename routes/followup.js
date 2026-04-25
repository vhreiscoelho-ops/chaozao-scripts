const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 120_000,
});

// ─── System prompt (cacheável) ────────────────────────────────────────────────
const FOLLOWUP_SYSTEM = `Você é um especialista sênior em fechamento de vendas por mensagem do Chãozão, maior plataforma de imóveis rurais do Brasil.
Seu único objetivo: gerar mensagens que extraiam um SIM ou NÃO do lead via WhatsApp, sem precisar de ligação.
Princípios que NUNCA negocia:
1. Sem abertura genérica ("Olá, tudo bem?", "Oi, como vai?"). Vá direto ao ponto.
2. Cada mensagem termina com uma pergunta binária de resposta fácil — o lead só precisa digitar "sim", "não", ou um emoji.
3. Nada de pressão vazia. A urgência e o valor precisam ser concretos e específicos para aquele lead e plano.
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

// ─── Route POST / ─────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { nome, valor, dias, plano, canal, perfil, contexto, closer } = req.body;

  if (!nome || !valor) {
    return res.status(400).json({ error: 'Campos obrigatórios: nome, valor.' });
  }

  const diasNum = parseInt(dias) || 0;
  const urgencia = diasNum === 0 ? 'não informado' : diasNum <= 2 ? 'baixa' : diasNum <= 5 ? 'média' : 'alta';

  const prompt = `Gere 3 mensagens de fechamento por mensagem (WhatsApp) para um lead que recebeu proposta e não respondeu. Objetivo: extrair um SIM ou NÃO sem precisar de ligação. Retorne SOMENTE o JSON abaixo, começando com { e terminando com }.

CONTEXTO DO LEAD:
- Nome: ${nome}
- Valor da proposta: ${valor}
- Plano: ${plano || 'Chãozão'}
- Perfil: ${perfil || 'não informado'}
- Contexto / objeções mapeadas: ${contexto || 'nenhum'}
- Closer: ${closer || 'Closer'}

TÉCNICA DE CADA ABORDAGEM:

1. TOQUE LEVE - Remove o desconforto de decidir.
Técnica: Reconhece que ele está ocupado, tira a pressão, pede só um sinal de vida. A pergunta final deve ser do tipo "pode me mandar um sim ou não aqui mesmo?" ou "ainda faz sentido pra você?". Máximo 4 linhas. Sem emojis excessivos.

2. PUXADA DIRETA - Provoca uma decisão agora.
Técnica: Menciona algo concreto que muda se ele não decidir (prazo, condição, vaga, oportunidade que outra pessoa pode aproveitar). Não ameaça — apresenta o cenário real. A pergunta final exige um posicionamento claro. Tom: firme e respeitoso.

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

REGRAS ABSOLUTAS:
- PROIBIDO começar com "Olá tudo bem", "Oi, como vai", "Espero que esteja bem" ou qualquer abertura de aquecimento
- PROIBIDO usar travessao (—). Use hifen simples (-) se precisar separar algo
- Cada mensagem DEVE terminar com uma pergunta simples que o lead responde com sim, não, ou emoji
- Use o nome do lead, o valor e o plano nas mensagens — nada de texto genérico
- Se houver contexto/objeção, use-o na abordagem relevante
- Tom: humano, direto, sem corpo de email corporativo
- Retorne APENAS o JSON`;

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
