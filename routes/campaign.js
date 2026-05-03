const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000 });

const SYSTEM = `Você é um especialista em copywriting de vendas para o mercado rural brasileiro.
Trabalha para o Chãozão — maior plataforma de imóveis rurais do Brasil (2,5 M acessos/mês, 125 K seguidores).
Seu objetivo: criar campanhas de WhatsApp que geram ação imediata em proprietários rurais, investidores e compradores de terra.
Tom: direto, confiante, sem corporativismo. Proibido abertura genérica.
REGRA ABSOLUTA: Responda SEMPRE com JSON puro e válido. Nunca use markdown. Sua resposta DEVE começar com { e terminar com }.`;

function extractJson(text) {
  const t = text.trim();
  try { return JSON.parse(t); } catch {}
  const cb = t.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  if (cb) { try { return JSON.parse(cb[1].trim()); } catch {} }
  const bounds = t.match(/\{[\s\S]+\}/);
  if (bounds) { try { return JSON.parse(bounds[0]); } catch {} }
  throw new Error('JSON inválido na resposta da IA');
}

router.post('/', async (req, res) => {
  const { texto, valor, tipo = 'oferta' } = req.body;
  if (!texto || !valor) return res.status(400).json({ error: 'Campos obrigatórios: texto, valor.' });

  const prompt = `Crie uma campanha completa para o Chãozão com base nas informações abaixo.

INFORMAÇÕES DA CAMPANHA:
- Descrição / contexto: ${texto}
- Valor / oferta: ${valor}
- Tipo de campanha: ${tipo}

Retorne SOMENTE o JSON abaixo, começando com { e terminando com }.

{
  "titulo": "string — headline do banner, impactante, máx 7 palavras, SEM ponto final",
  "subtitulo": "string — complemento do título, benefício concreto, máx 10 palavras",
  "destaque_valor": "string — como exibir o preço/oferta no banner (ex: 'A partir de R$ 299/mês', 'Desconto de 30%', 'Vagas limitadas')",
  "descricao_banner": "string — texto curto do banner, 2 linhas máx, reforça urgência ou prova social",
  "cta_banner": "string — chamada para ação do banner, máx 4 palavras, imperativo (ex: 'Fale com um especialista', 'Garanta sua vaga')",
  "whatsapp_copy": "string — mensagem completa para disparar no WhatsApp. Começa com gancho forte (sem 'Olá tudo bem'). 3 a 5 parágrafos curtos. Usa quebras com \\n\\n. Inclui emojis estratégicos. Termina com CTA claro e número/link de contato fictício como placeholder.",
  "hashtags": ["string", "string", "string"],
  "cor_destaque": "string — cor hex que combina com o tema (ex: '#F5A623' para ouro, '#4CAF50' para verde, '#E53935' para urgência)"
}

REGRAS:
- whatsapp_copy DEVE ter entre 150 e 280 palavras
- titulo e subtitulo devem ser específicos para o tema informado — PROIBIDO ser genérico
- destaque_valor deve transformar o valor informado em algo visualmente atraente para o banner
- PROIBIDO usar travessão (—), use hífen (-) se necessário
- ATENÇÃO FINAL: sua resposta DEVE começar com { e terminar com }. Nenhum texto antes ou depois.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = (msg.content || []).map(c => c.text || '').join('');
    const json = extractJson(raw);
    res.json(json);
  } catch (err) {
    console.error('[campaign]', err.message);
    const msg = err.status === 401 ? 'API Key inválida.'
      : err.status === 429 ? 'Limite de requisições. Aguarde alguns segundos.'
      : err.message;
    res.status(500).json({ error: msg });
  }
});

module.exports = router;
