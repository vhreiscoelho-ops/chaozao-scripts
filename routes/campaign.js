const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const OpenAI    = require('openai');

const router = express.Router();

function getClaude() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000 });
}
function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 120_000 });
}

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

// ── Gera fundo fotográfico rural com gpt-image-1 ─────────────────────────────
async function gerarImagemFundo() {
  const key = process.env.OPENAI_API_KEY;
  console.log('[DALLE] key:', key ? '✅ ' + key.slice(0,14) + '...' : '❌ AUSENTE');

  const prompt = [
    'Photorealistic Brazilian rural landscape background for a marketing banner.',
    'Vast green farmland with a wooden fence gate and dirt road leading into the distance.',
    'Golden hour sunset: warm orange and gold light on the horizon, dramatic dark sky with purple-orange clouds.',
    'Lush tropical vegetation silhouettes on the left edge.',
    'Strong dark vignette on all edges — especially heavy at top and bottom — for text overlay readability.',
    'No text, no logos, no people, no watermarks.',
    'Vertical 9:16 portrait. Cinematic DSLR photography. Hyper-realistic.',
  ].join(' ');

  const response = await getOpenAI().images.generate({
    model:   'gpt-image-1',
    prompt,
    n:       1,
    size:    '1024x1536',
    quality: 'high',
  });

  const imgData = response.data[0];
  if (imgData.b64_json) {
    console.log('[DALLE] fundo gerado (base64)');
    return 'data:image/png;base64,' + imgData.b64_json;
  }
  console.log('[DALLE] fundo gerado (url):', imgData.url?.slice(0,60) + '...');
  return imgData.url;
}

router.post('/', async (req, res) => {
  const { texto, valor, tipo = 'oferta' } = req.body;
  if (!texto || !valor) return res.status(400).json({ error: 'Campos obrigatórios: texto, valor.' });

  const prompt = `Crie uma campanha completa para o Chãozão com base nas informações abaixo.

INFORMAÇÕES DA CAMPANHA:
- Descrição / contexto: ${texto}
- Valor / oferta: ${valor}
- Tipo de campanha: ${tipo}

══════════════════════════════════════════
EXEMPLOS REAIS DE CAMPANHAS CHÃOZÃO (use como referência de tom, estilo e estrutura):

EXEMPLO 1 — Campanha de reativação para corretor (plano 5 anúncios, 30% off):
{
  "titulo_l1": "LIBERAMOS",
  "titulo_l2": "UMA CONDIÇÃO",
  "titulo_l3": "PRA SUA CONTA!",
  "subtitulo_branco": "Porque você já chegou",
  "subtitulo_ouro": "muito perto de fechar.",
  "badge_esq": "CONDIÇÃO EXCLUSIVA\\nDE REATIVAÇÃO",
  "badge_dir": "MAIS VISIBILIDADE\\nMAIS RESULTADOS",
  "plano_nome": "PLANO DE\\nANÚNCIOS",
  "plano_numero": "5",
  "preco_de": "R$ 184,00/mês",
  "preco_por": "R$ 129,50/mês",
  "features": ["PAGAMENTO NO BOLETO\\n(SEM CARTÃO)", "ATIVAÇÃO RÁPIDA\\nAPÓS PAGAMENTO"],
  "cta_texto": "RETOMAR MINHA CONDIÇÃO",
  "whatsapp_copy": "...",
  "hashtags": ["#chaozao", "#imovelrural", "#corretorrural"]
}

EXEMPLO 2 — Campanha para proprietário (plano único, pagamento boleto):
{
  "titulo_l1": "PLANO ÚNICO",
  "titulo_l2": "CHÃOZÃO",
  "titulo_l3": "ANUNCIE AGORA!",
  "subtitulo_branco": "O jeito mais fácil e seguro",
  "subtitulo_ouro": "de anunciar seu imóvel rural.",
  "badge_esq": "PARA PROPRIETÁRIOS",
  "badge_dir": "PAGAMENTO\\nVIA BOLETO",
  "plano_nome": "PLANO\\nPROPRIETÁRIO",
  "plano_numero": "3x",
  "preco_de": "R$ 1.199,00",
  "preco_por": "R$ 339,43/mês",
  "features": ["1 ANÚNCIO\\nATIVO ATÉ VENDER", "SIMPLES E SEGURO\\nSEM CARTÃO"],
  "cta_texto": "CONTRATAR AGORA",
  "whatsapp_copy": "...",
  "hashtags": ["#chaozao", "#imovelrural", "#vendamais"]
}
══════════════════════════════════════════

REGRAS DE COPY (siga à risca):
- titulo_l1: gancho de ação (1-3 palavras), MAIÚSCULAS, branco
- titulo_l2: destaque principal (2-4 palavras), MAIÚSCULAS, DOURADO — o mais impactante
- titulo_l3: fechamento com urgência ou benefício + "!" (2-4 palavras), MAIÚSCULAS, branco
- badge_esq: identifica o público ou condição (ex: PARA CORRETORES, OFERTA EXCLUSIVA)
- badge_dir: 2 linhas com o diferencial do pagamento ou benefício-chave
- plano_nome: nome do plano em 2 linhas (ex: PLANO DE\\nANÚNCIOS ou CORRETOR\\nPRO)
- plano_numero: o número mais impactante (ex: 5, 3x, 15%, PRO)
- features: 2 benefícios práticos em MAIÚSCULAS com 2 linhas cada (\\n entre elas)
- cta_texto: imperativo direto, máx 4 palavras (ex: CONTRATAR AGORA, GARANTIR DESCONTO)
- whatsapp_copy: 150-280 palavras, linguagem direta e rural, emojis, \\n\\n entre parágrafos
- PROIBIDO: travessão (—), frases genéricas, palavras fora do contexto rural/imobiliário

Retorne SOMENTE este JSON, começando com { e terminando com }:

{
  "titulo_l1": "...",
  "titulo_l2": "...",
  "titulo_l3": "...",
  "subtitulo_branco": "...",
  "subtitulo_ouro": "...",
  "badge_esq": "...",
  "badge_dir": "...",
  "plano_nome": "...",
  "plano_numero": "...",
  "preco_de": "...",
  "preco_por": "...",
  "features": ["...", "..."],
  "cta_texto": "...",
  "whatsapp_copy": "...",
  "hashtags": ["#chaozao", "#imovelrural", "..."]
}

REGRAS: titulo_l2 é o destaque central. preco_de e preco_por refletem o valor informado. PROIBIDO travessão (—).
ATENÇÃO FINAL: sua resposta DEVE começar com { e terminar com }. Nenhum texto fora do JSON.`;

  try {
    // 1. Claude gera o copy
    let claudeMsg;
    try {
      claudeMsg = await getClaude().messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 1800,
        system:     [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages:   [{ role: 'user', content: prompt }],
      });
    } catch (err) {
      console.error('[campaign] Claude falhou:', err.status, err.message);
      const s = err.status || 500;
      return res.status(500).json({ error: s === 401 ? 'ANTHROPIC_API_KEY inválida.' : s === 429 ? 'Limite Claude atingido.' : err.message });
    }

    const raw  = (claudeMsg.content || []).map(c => c.text || '').join('');
    const json = extractJson(raw);

    // 2. gpt-image-1 gera fundo fotográfico; canvas renderiza o texto por cima
    try {
      json.banner_bg_url = await gerarImagemFundo();
    } catch (dErr) {
      console.error('[campaign] DALLE falhou:', dErr.status, dErr.message);
      json.dall_e_error = `${dErr.status || ''} ${dErr.message || ''}`.trim();
    }

    res.json(json);
  } catch (err) {
    console.error('[campaign] erro geral:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
