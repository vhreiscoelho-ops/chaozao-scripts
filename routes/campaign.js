const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000 });

const SYSTEM = `Você é um especialista em design de campanhas e copywriting para o mercado rural brasileiro.
Trabalha para o Chãozão — maior plataforma de imóveis rurais do Brasil (2,5 M acessos/mês, 125 K seguidores).
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

O banner segue um layout específico com:
- Título dividido em 3 linhas: linha1 (branca) + linha2 (dourada/ouro, palavra de impacto) + linha3 (branca)
- Badge superior esquerdo: rótulo de contexto/urgência
- Badge superior direito: proposta de valor circular
- Caixa de preço estruturada: plano à esquerda + comparativo de preço à direita
- 2 diferenciais/features com ícone
- Botão CTA estilo WhatsApp

Retorne SOMENTE este JSON, começando com { e terminando com }:

{
  "titulo_l1": "string — primeira linha do título (branca), 1 a 3 palavras, maiúsculas",
  "titulo_l2": "string — segunda linha do título (DOURADA, destaque principal), 2 a 4 palavras, maiúsculas",
  "titulo_l3": "string — terceira linha do título (branca), 2 a 4 palavras, com ! no final, maiúsculas",
  "subtitulo_branco": "string — parte inicial do subtítulo (branca), máx 6 palavras",
  "subtitulo_ouro": "string — parte final do subtítulo (dourada), máx 6 palavras",
  "badge_esq": "string — rótulo badge superior esquerdo, máx 5 palavras, MAIÚSCULAS (ex: CONDIÇÃO EXCLUSIVA DE REATIVAÇÃO)",
  "badge_dir": "string — texto badge circular direito, máx 4 palavras em 2 linhas, MAIÚSCULAS (ex: MAIS VISIBILIDADE\\nMAIS RESULTADOS)",
  "plano_nome": "string — nome do plano em 2 linhas (ex: PLANO DE\\n5 ANÚNCIOS), MAIÚSCULAS",
  "plano_numero": "string — número ou destaque grande do plano (ex: '5', '30%', 'PRO')",
  "preco_de": "string — preço original com tachado (ex: R$ 184,00/mês), deixe vazio se não houver",
  "preco_por": "string — preço final destacado (ex: R$ 129,50/mês)",
  "features": ["string — feature 1 em MAIÚSCULAS, máx 4 palavras + complemento", "string — feature 2 em MAIÚSCULAS, máx 4 palavras + complemento"],
  "cta_texto": "string — texto do botão CTA, MAIÚSCULAS, imperativo, máx 5 palavras (ex: RETOMAR MINHA CONDIÇÃO)",
  "whatsapp_copy": "string — mensagem completa para WhatsApp. Começa com gancho forte. 3 a 5 parágrafos. Quebras com \\n\\n. Emojis estratégicos. CTA no final.",
  "hashtags": ["#chaozao", "#imovelrural", "#vendamais"]
}

REGRAS:
- titulo_l2 é a linha de MAIOR impacto — deve capturar a essência da oferta em poucas palavras
- preco_de e preco_por devem refletir o valor informado de forma atraente
- features devem ser diferenciais reais e concretos (forma de pagamento, prazo, benefício)
- whatsapp_copy: 150 a 280 palavras, proibido "Olá tudo bem"
- PROIBIDO usar travessão (—)
- ATENÇÃO FINAL: sua resposta DEVE começar com { e terminar com }. Nenhum texto fora do JSON.`;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1800,
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
