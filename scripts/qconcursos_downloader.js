/**
 * qconcursos_downloader.js
 *
 * Execute este script no console do navegador (F12) enquanto estiver logado
 * em uma página de questões do qconcursos.com.
 *
 * Gera um arquivo JSON compatível com o importador do LPStudy.
 *
 * ── Problema resolvido ────────────────────────────────────────────────────
 * 1. Detecção dos tabs:
 *    O TreeWalker(SHOW_TEXT) falha quando o contador "(1)" está num <span>
 *    filho separado: <a>Gabarito Comentado <span>(1)</span></a>.
 *    Nenhum text node individual contém "Gabarito Comentado (" — portanto
 *    0 resultados e a função retorna Promise {<fulfilled: undefined>}.
 *    Correção: usar element.textContent (combina todos os filhos) e manter
 *    apenas o elemento mais específico (sem filho que também bata).
 *
 * 2. Filtro "Gabarito Comentado (":
 *    "Gabarito Comentado"  → 22 hits (2 elementos extras sem número)
 *    "Gabarito Comentado (" → 20 hits (somente questões com gabarito real)
 *
 * 3. Formato de saída:
 *    Compatível com o qconcursos_importer.py do LPStudy:
 *    { "questions": [ { "enunciado", "alternativas", "gabarito",
 *                       "comentario", "source", "externalId" } ] }
 *
 * USO:
 *   1. Abra a página de questões no qconcursos (já logado).
 *   2. Abra o DevTools (F12) → aba Console.
 *   3. Cole todo este conteúdo e pressione Enter.
 *   4. Aguarde "[QC] ✅ Download concluído!" e salve o arquivo.
 *   5. Importe-o na página "Importar" do LPStudy.
 */
(async function qconcursosDownloader() {
  'use strict';

  // ── Configurações ──────────────────────────────────────────────────────────
  const CLICK_WAIT = 2500;  // ms para aguardar o conteúdo do tab carregar via AJAX
  const STEP_WAIT  = 500;   // ms entre questões

  // ── Utilitários ───────────────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log   = (...a) => console.log('%c[QC]', 'color:teal;font-weight:bold', ...a);
  const warn  = (...a) => console.warn('[QC]', ...a);
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  // ── PASSO 1: Localizar exatamente os 20 tabs "Gabarito Comentado (" ────────
  //
  // Usa element.textContent (combina todos os nós filhos) em vez de
  // TreeWalker(SHOW_TEXT). Mantém apenas o elemento mais específico:
  // sem filho direto que também contenha o mesmo texto.

  const gabaritoTabs = Array.from(
    document.querySelectorAll('a, button, li, span')
  ).filter(el => {
    const txt = clean(el.textContent);
    if (!txt.includes('Gabarito Comentado (')) return false;
    return !Array.from(el.children).some(
      c => clean(c.textContent).includes('Gabarito Comentado (')
    );
  });

  log(`${gabaritoTabs.length} tabs "Gabarito Comentado (" encontrados`);

  if (!gabaritoTabs.length) {
    warn('Nenhum tab encontrado! Verifique se está na página de questões.');
    return;
  }

  // ── PASSO 2: Processar cada questão ───────────────────────────────────────

  const LETTERS = ['A', 'B', 'C', 'D', 'E'];
  const questions = [];

  for (let i = 0; i < gabaritoTabs.length; i++) {
    const tabEl = gabaritoTabs[i];
    log(`Questão ${i + 1}/${gabaritoTabs.length}…`);

    // Subir na DOM até encontrar o card da questão (contém "Qxxxxx")
    let card = tabEl;
    for (let d = 0; d < 25; d++) {
      card = card.parentElement;
      if (!card || card === document.body) { card = null; break; }
      if (/\bQ\d{5,7}\b/.test(card.textContent)) break;
    }

    // Formato compatível com qconcursos_importer.py do LPStudy
    const q = {
      enunciado:    '',
      alternativas: {},
      gabarito:     '',
      comentario:   '',   // ← campo esperado pelo LPStudy (não "gabaritoComentado")
      source:       window.location.href,
      externalId:   ''    // ← ID da questão (Qxxxxx)
    };

    if (!card) {
      warn(`Card não encontrado para questão ${i + 1}`);
      questions.push(q);
      continue;
    }

    // ── externalId ─────────────────────────────────────────────────────────
    const idM = card.textContent.match(/\b(Q\d{5,7})\b/);
    if (idM) q.externalId = idM[1];

    // ── Metadados para enriquecer o enunciado ──────────────────────────────
    const ct = card.innerText || card.textContent;
    const ano   = (ct.match(/Ano[:\s]+(\d{4})/i)?.[1] || '').trim();
    const banca = (ct.match(/Banca[:\s]+([^\n\r]+?)(?=\s{2,}|[Óo]rg|Prova|\n|$)/i)?.[1] || '').trim();
    const orgao = (ct.match(/[Óo]rg[ãa]o[:\s]+([^\n\r]+?)(?=\s{2,}|Prova|Banca|\n|$)/i)?.[1] || '').trim();
    const prova = (ct.match(/Prova[:\s]+([^\n\r]+?)(?=\s{2,}|Banca|[Óo]rg|\n|$)/i)?.[1] || '').trim();

    // ── Enunciado ──────────────────────────────────────────────────────────
    for (const sel of [
      '[class*="statement"]', '[class*="enunciado"]', '[class*="question-text"]',
      '[class*="question-body"]', '[class*="texto"]'
    ]) {
      const el = card.querySelector(sel);
      if (el) { q.enunciado = clean(el.innerText || el.textContent); break; }
    }
    // Fallback: texto do card antes das alternativas
    if (!q.enunciado) {
      const headerInfo = [ano, banca, orgao, prova].filter(Boolean).join(' — ');
      q.enunciado = headerInfo ? `[${headerInfo}]` : '';
    }
    // Inclui identificação da questão no enunciado
    if (q.externalId) {
      q.enunciado = q.enunciado
        ? `${q.enunciado}`
        : `${q.externalId}`;
    }

    // ── Alternativas ───────────────────────────────────────────────────────
    for (const sel of ['[class*="alternative"]','[class*="alternativa"]','[class*="option"]']) {
      const els = card.querySelectorAll(sel);
      if (els.length >= 2) {
        els.forEach((el, idx) => {
          if (idx < 5) {
            q.alternativas[LETTERS[idx]] = clean(el.innerText || el.textContent)
              .replace(/^[A-E]\s+/, '');
          }
        });
        break;
      }
    }
    // Fallback: radio buttons
    if (!Object.keys(q.alternativas).length) {
      card.querySelectorAll('input[type="radio"]').forEach((r, idx) => {
        if (idx >= 5) return;
        const lbl = r.closest('label') || r.nextElementSibling;
        if (lbl) q.alternativas[LETTERS[idx]] =
          clean(lbl.innerText || lbl.textContent).replace(/^[A-E]\s+/, '');
      });
    }
    // Garante todas as 5 chaves
    LETTERS.forEach(l => { if (!q.alternativas[l]) q.alternativas[l] = ''; });

    // ── Clicar no tab e aguardar AJAX ──────────────────────────────────────
    tabEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await sleep(300);
    tabEl.click();
    tabEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(CLICK_WAIT);

    // ── Extrair Gabarito Comentado → campo "comentario" ────────────────────
    const gabSelectors = [
      '[class*="gabarito"][class*="content"]',
      '[class*="gabarito"][class*="body"]',
      '[class*="gabarito"][class*="text"]',
      '[class*="commented"]', '[class*="comentado"]',
      '.tab-pane.active', '[role="tabpanel"]:not([hidden])',
      '[class*="tab-content"] [class*="active"]',
      '[class*="collapse"].show', '[class*="panel"].active'
    ];

    for (const root of [card, document]) {
      if (q.comentario) break;
      for (const sel of gabSelectors) {
        try {
          const el = root.querySelector(sel);
          if (el && clean(el.textContent).length > 20) {
            q.comentario = clean(el.innerText || el.textContent);
            break;
          }
        } catch (_) {}
      }
    }
    // Fallback: trecho de texto com padrão "Gabarito: X"
    if (!q.comentario) {
      const m = ct.match(/Gabarito\s*:?\s*[A-E]\b[\s\S]{0,2000}/);
      if (m) q.comentario = clean(m[0]);
    }

    // Extrai letra do gabarito do campo comentario
    const lm = q.comentario.match(/[Gg]abarito\s*:?\s*([A-E])\b/);
    if (lm) q.gabarito = lm[1];

    questions.push(q);
    log(`  ✓ ${q.externalId || '#' + (i + 1)} | Gabarito: ${q.gabarito || '?'}`);
    await sleep(STEP_WAIT);
  }

  // ── PASSO 3: Gerar JSON no formato LPStudy e baixar ───────────────────────
  //
  // Formato esperado pelo qconcursos_importer.py / página de importação:
  // { "questions": [ { enunciado, alternativas, gabarito, comentario, source, externalId } ] }

  const output = { questions };
  const json   = JSON.stringify(output, null, 2);

  // Método 1: link de download
  try {
    const blob = new Blob([json], { type: 'application/json' });
    const burl = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = burl;
    a.download = `questoes.json`;   // nome padrão esperado pelo LPStudy
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(burl); }, 1500);
    log('✅ Download concluído! Importe o arquivo questoes.json no LPStudy.');
  } catch (e) {
    // Método 2: clipboard
    warn('Download bloqueado, copiando para clipboard…');
    try {
      await navigator.clipboard.writeText(json);
      log('✅ JSON copiado! Cole num editor e salve como questoes.json');
    } catch (e2) {
      // Método 3: variável global
      window._qcData = output;
      log('✅ Dados em window._qcData — execute: copy(JSON.stringify(window._qcData,null,2))');
    }
  }

  log(`Total: ${questions.length} questões exportadas.`);
  return output;
})();
