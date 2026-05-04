const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const router = express.Router();

function getClaude() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000 });
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

// ── Monta prompt pronto para usar no ChatGPT ──────────────────────────────────
function gerarPromptChatGPT(d) {
  const nl = s => (s || '').replace(/\\n|\n/g, ' ').trim();

  const precoDePart = d.preco_de
    ? `"DE: ${nl(d.preco_de)}" com linha vermelha de tachado sobre o valor,\n   depois `
    : '';

  return `Crie um banner vertical de marketing digital (formato 9:16, estilo Instagram Stories/Reels) para a empresa Chãozão — maior plataforma de imóveis rurais do Brasil.

ESTILO VISUAL:
- Fundo: paisagem rural fotorrealista ao entardecer (campo verde, porteira de madeira, céu dramático laranja/dourado com nuvens)
- Paleta: verde escuro (#0a1a06) e preto como base, dourado (#F5C518) e branco como cores de texto
- Tipografia: sans-serif pesada (estilo Impact ou Bebas Neue), negrito, todas maiúsculas nos títulos
- Visual profissional de marketing digital brasileiro — alta qualidade, similar a templates premium do Canva

LAYOUT (de cima para baixo):

① Linha horizontal dourada fina na borda superior

② Linha de badges:
   - Esquerda: badge/pílula horizontal com ícone de cadeado 🔒, fundo verde escuro, borda dourada, texto branco: "${nl(d.badge_esq || 'OFERTA EXCLUSIVA')}"
   - Direita: badge circular, fundo verde escuro, borda dourada, texto dourado em 2 linhas: "${nl(d.badge_dir || 'DESTAQUE EXCLUSIVO')}"

③ Título em 3 linhas, texto grande e impactante, alinhado à esquerda:
   - Linha 1 (branco): "${nl(d.titulo_l1 || '')}"
   - Linha 2 (dourado #F5C518, a maior e mais impactante): "${nl(d.titulo_l2 || '')}"
   - Linha 3 (branco): "${nl(d.titulo_l3 || '')}"

④ Subtítulo com barra vertical dourada à esquerda:
   - Texto branco: "${nl(d.subtitulo_branco || '')}"
   - Texto dourado: "${nl(d.subtitulo_ouro || '')}"

⑤ Caixa de preço: retângulo arredondado, fundo verde escuro (#0e2a08), borda dourada:
   - Lado esquerdo: label branco "${nl(d.plano_nome || 'PLANO')}", abaixo número/destaque dourado grande "${nl(d.plano_numero || '')}"
   - Linha divisória dourada vertical no centro
   - Lado direito: ${precoDePart}badge dourado "POR:" e valor em dourado grande "${nl(d.preco_por || '')}"

⑥ Duas cards lado a lado (fundo semi-transparente escuro, borda sutil):
   - Card 1 com ícone de documento 📄: "${nl((d.features || [])[0] || 'BENEFÍCIO 1')}"
   - Card 2 com ícone de raio ⚡: "${nl((d.features || [])[1] || 'BENEFÍCIO 2')}"

⑦ Botão CTA: pílula larga, gradiente verde (#196624 → #24a033), ícone WhatsApp à esquerda, texto branco negrito itálico: "${nl(d.cta_texto || 'FALE CONOSCO AGORA')}"

⑧ Rodapé: linha dourada fina + texto branco pequeno centralizado: "chaozao.com.br  ·  Maior plataforma de imóveis rurais do Brasil"

IMPORTANTE: Todo texto deve estar perfeitamente legível e exatamente como especificado. Sem marcas d'água. Alta resolução. Fundo rural visível mas sem competir com o texto.`;
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

REGRAS DE COPY:
- titulo_l1: gancho de ação (1-3 palavras), MAIÚSCULAS
- titulo_l2: destaque principal (2-4 palavras), MAIÚSCULAS, DOURADO — o mais impactante
- titulo_l3: fechamento com urgência ou benefício + "!" (2-4 palavras), MAIÚSCULAS
- badge_esq: identifica o público ou condição, MAIÚSCULAS
- badge_dir: 2 linhas com diferencial do pagamento ou benefício-chave, separadas por \\n
- plano_nome: nome do plano em 2 linhas separadas por \\n
- plano_numero: número mais impactante (ex: 5, 3x, 15%, PRO)
- features: 2 benefícios em MAIÚSCULAS com 2 linhas cada (\\n entre elas)
- cta_texto: imperativo direto, máx 4 palavras
- whatsapp_copy: 150-280 palavras, linguagem rural, emojis, \\n\\n entre parágrafos
- PROIBIDO: travessão (—), frases genéricas

Retorne SOMENTE este JSON:
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
}`;

  try {
    console.log('[campaign] iniciando — ANTHROPIC_KEY:', process.env.ANTHROPIC_API_KEY ? '✅' : '❌ AUSENTE');

    const msg = await getClaude().messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 1800,
      system:     [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw  = (msg.content || []).map(c => c.text || '').join('');
    const json = extractJson(raw);

    json.chatgpt_prompt = gerarPromptChatGPT(json);
    console.log('[campaign] ✅ campanha gerada');
    res.json(json);
  } catch (err) {
    const status  = err.status || err.statusCode || 500;
    const message = err.message || err.error?.message || String(err) || 'Erro interno do servidor';
    console.error('[campaign] ❌ erro:', status, message, err.error || '');
    const friendly =
      status === 401 ? 'ANTHROPIC_API_KEY inválida. Verifique no Railway.' :
      status === 429 ? 'Limite de requisições atingido. Aguarde alguns minutos.' :
      status === 400 ? `Parâmetro inválido: ${message}` :
      message;
    res.status(500).json({ error: friendly });
  }
});

module.exports = router;
