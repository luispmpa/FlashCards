/**
 * qconcursos_downloader.js
 *
 * Execute este script no console do navegador enquanto estiver logado em uma
 * página de questões do qconcursos.com.
 *
 * O script localiza exatamente as 20 questões que possuem "Gabarito Comentado ("
 * (com parêntese aberto + número), ignorando os 2 elementos extras que aparecem
 * quando se busca apenas por "Gabarito Comentado" sem parêntese — evitando a
 * inconsistência de retornar 22 hits e acabar com 18 questões incorretas.
 *
 * Para cada questão extrai:
 *   - id, numero, disciplina, assunto, ano, banca, orgao, prova
 *   - enunciado, alternativas (A-E)
 *   - gabarito (letra) e gabaritoComentado (texto completo)
 *
 * Ao finalizar, faz download automático de um arquivo JSON.
 *
 * USO:
 *   1. Abra a página de questões no qconcursos (já logado).
 *   2. Abra o DevTools (F12) → aba Console.
 *   3. Cole todo este conteúdo e pressione Enter.
 *   4. Aguarde o log "[QC] ✅ Download concluído!" e o arquivo será salvo.
 */
(async function qconcursosDownloader() {
  'use strict';

  // ── Configurações ──────────────────────────────────────────────────────────
  const CLICK_WAIT = 2500;  // ms para aguardar o conteúdo do tab carregar via AJAX
  const STEP_WAIT  = 400;   // ms entre questões (evita sobrecarga)

  // ── Utilitários ───────────────────────────────────────────────────────────
  const sleep     = ms => new Promise(r => setTimeout(r, ms));
  const log       = msg => console.log(`[QC] ${msg}`);
  const warn      = msg => console.warn(`[QC] ⚠ ${msg}`);
  const cleanText = str => (str || '').replace(/\s+/g, ' ').trim();

  /** querySelector com múltiplos seletores como fallback */
  function findFirst(root, ...selectors) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) { /* seletor inválido, ignora */ }
    }
    return null;
  }

  // ── PASSO 1: Localizar exatamente os 20 tabs "Gabarito Comentado (" ────────
  //
  // A chave da solução: filtrar por "Gabarito Comentado (" (com parêntese aberto)
  // em vez de "Gabarito Comentado" sozinho.
  // - "Gabarito Comentado"  → 22 hits (inclui 2 elementos sem contagem)
  // - "Gabarito Comentado (" → 20 hits (apenas as questões com gabarito disponível)
  //
  // Usamos TreeWalker para percorrer apenas nós de texto — mais eficiente e
  // menos suscetível a falsos positivos do que querySelectorAll('*').

  const gabaritoTabs = [];
  const seen = new Set();

  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: node =>
        node.textContent.includes('Gabarito Comentado (')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT
    }
  );

  while (walker.nextNode()) {
    // Sobe na árvore até encontrar o elemento clicável (a, button, li)
    let el = walker.currentNode.parentElement;
    while (el && el !== document.body) {
      if (['A', 'BUTTON', 'LI'].includes(el.tagName)) break;
      el = el.parentElement;
    }
    if (el && el !== document.body && !seen.has(el)) {
      seen.add(el);
      gabaritoTabs.push(el);
    }
  }

  // Fallback via XPath caso o TreeWalker não encontre nada
  if (gabaritoTabs.length === 0) {
    const xp = document.evaluate(
      "//*[contains(text(),'Gabarito Comentado (')]",
      document.body, null,
      XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
    );
    for (let i = 0; i < xp.snapshotLength; i++) {
      const el = xp.snapshotItem(i);
      if (!seen.has(el)) { seen.add(el); gabaritoTabs.push(el); }
    }
  }

  log(`${gabaritoTabs.length} questões com "Gabarito Comentado (" encontradas.`);

  if (gabaritoTabs.length === 0) {
    console.error('[QC] Nenhuma questão encontrada. Verifique se está na página correta.');
    return;
  }

  // ── PASSO 2: Processar cada questão ───────────────────────────────────────

  const questions = [];

  for (let i = 0; i < gabaritoTabs.length; i++) {
    const tabEl = gabaritoTabs[i];
    log(`Questão ${i + 1}/${gabaritoTabs.length}…`);

    // ── 2a. Encontrar o card/container da questão ─────────────────────────
    // Sobe na DOM até encontrar um nó que contenha um ID de questão (Qxxxxx)
    let card = tabEl;
    for (let depth = 0; depth < 25; depth++) {
      card = card.parentElement;
      if (!card || card === document.body) { card = null; break; }
      if (/\bQ\d{5,7}\b/.test(card.textContent)) break;
    }

    const q = {
      numero:            i + 1,
      id:                '',
      disciplina:        '',
      assunto:           '',
      ano:               '',
      banca:             '',
      orgao:             '',
      prova:             '',
      enunciado:         '',
      alternativas:      {},
      gabarito:          '',
      gabaritoComentado: ''
    };

    if (!card) {
      warn(`Card não encontrado para questão ${i + 1}. Pulando…`);
      questions.push(q);
      continue;
    }

    // ── 2b. ID da questão ────────────────────────────────────────────────
    const idMatch = card.textContent.match(/\b(Q\d{5,7})\b/);
    if (idMatch) q.id = idMatch[1];

    // ── 2c. Metadados: ano, banca, órgão, prova ──────────────────────────
    const cardText = card.innerText || card.textContent;

    const anoM   = cardText.match(/Ano[:\s]+(\d{4})/i);
    const bancaM = cardText.match(/Banca[:\s]+([^\n\r\t]+?)(?=\s{2,}|\n|[Óo]rg|Prova|$)/i);
    const orgaoM = cardText.match(/[Óo]rg[ãa]o[:\s]+([^\n\r\t]+?)(?=\s{2,}|\n|Prova|Banca|$)/i);
    const provaM = cardText.match(/Prova[:\s]+([^\n\r\t]+?)(?=\s{2,}|\n|Banca|[Óo]rg|$)/i);

    if (anoM)   q.ano   = anoM[1].trim();
    if (bancaM) q.banca = bancaM[1].trim();
    if (orgaoM) q.orgao = orgaoM[1].trim();
    if (provaM) q.prova = provaM[1].trim();

    // ── 2d. Disciplina / Assunto via breadcrumb ──────────────────────────
    const breadcrumb = findFirst(
      card,
      '[class*="breadcrumb"]', '[class*="topic"]', '[class*="subject"]',
      '[class*="category"]',  '[class*="area"]',   '[class*="trail"]'
    );
    if (breadcrumb) {
      const parts = (breadcrumb.innerText || breadcrumb.textContent).split(/[›»>\/]/);
      if (parts[0]) q.disciplina = cleanText(parts[0]);
      if (parts[1]) q.assunto    = cleanText(parts[1]);
    }

    // ── 2e. Enunciado ────────────────────────────────────────────────────
    const enunciadoEl = findFirst(
      card,
      '[class*="statement"]', '[class*="enunciado"]', '[class*="question-text"]',
      '[class*="question-body"]', '[class*="body"] p', '[class*="texto"]'
    );
    if (enunciadoEl) {
      q.enunciado = cleanText(enunciadoEl.innerText || enunciadoEl.textContent);
    }

    // ── 2f. Alternativas ─────────────────────────────────────────────────
    const LETTERS = ['A', 'B', 'C', 'D', 'E'];

    // Tenta seletores semânticos primeiro
    const altEls = card.querySelectorAll(
      '[class*="alternative"], [class*="alternativa"], [class*="option"]'
    );

    if (altEls.length >= 2) {
      altEls.forEach((el, idx) => {
        if (idx >= 5) return;
        // Remove letra inicial duplicada (ex.: "A ao Poder…" → "ao Poder…")
        const txt = cleanText(el.innerText || el.textContent)
          .replace(/^[A-E]\s+/, '');
        q.alternativas[LETTERS[idx]] = txt;
      });
    } else {
      // Fallback: radio buttons
      const radios = card.querySelectorAll('input[type="radio"]');
      radios.forEach((radio, idx) => {
        if (idx >= 5) return;
        const label = radio.closest('label') || radio.nextElementSibling;
        if (label) {
          q.alternativas[LETTERS[idx]] = cleanText(
            label.innerText || label.textContent
          ).replace(/^[A-E]\s+/, '');
        }
      });
    }

    // ── 2g. Clicar no tab e aguardar carregamento ────────────────────────
    tabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await sleep(300);
    tabEl.click();
    // Dispara evento manual para garantir compatibilidade com frameworks JS
    tabEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(CLICK_WAIT);

    // ── 2h. Extrair conteúdo do Gabarito Comentado ───────────────────────
    const gabEl = findFirst(
      card,
      '[class*="gabarito"][class*="content"]',
      '[class*="gabarito"][class*="body"]',
      '[class*="gabarito"][class*="text"]',
      '[class*="commented"]',
      '[class*="comentado"]',
      '.tab-pane.active',
      '[role="tabpanel"]:not([hidden])',
      '[class*="tab-content"] [class*="active"]',
      '[class*="collapse"].show',
      '[class*="panel"].active'
    );

    if (gabEl) {
      q.gabaritoComentado = cleanText(gabEl.innerText || gabEl.textContent);
    } else {
      // Fallback: procura no texto completo do card por padrão "Gabarito: X"
      const section = cardText.match(/Gabarito\s*:?\s*[A-E]\b[\s\S]{0,3000}/);
      if (section) q.gabaritoComentado = cleanText(section[0]);
    }

    // Extrai a letra do gabarito
    const letterM = q.gabaritoComentado.match(/[Gg]abarito\s*:?\s*([A-E])\b/);
    if (letterM) q.gabarito = letterM[1];

    questions.push(q);
    log(`  ✓ ${q.id || `#${i + 1}`} | Gabarito: ${q.gabarito || '?'}`);
    await sleep(STEP_WAIT);
  }

  // ── PASSO 3: Gerar e baixar o JSON ────────────────────────────────────────

  const output = {
    exportedAt:   new Date().toISOString(),
    url:          window.location.href,
    totalQuestoes: questions.length,
    questoes:     questions
  };

  const json = JSON.stringify(output, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href:     url,
    download: `qconcursos_questoes_${Date.now()}.json`
  });

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  log(`✅ Download concluído! ${questions.length} questões exportadas.`);

  // Retorna para inspeção no console se necessário
  return output;
})();
