// Copy buttons, and the app catalog's search + category filter. Nothing else.
(() => {
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const target = document.querySelector(btn.dataset.copy);
    if (!target) return;
    const label = btn.textContent;
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      btn.textContent = btn.dataset.done || 'Copied';
    } catch {
      // No clipboard permission (plain http, old browser): select it instead,
      // so a Ctrl+C still works.
      const range = document.createRange();
      range.selectNodeContents(target);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    setTimeout(() => { btn.textContent = label; }, 1600);
  });

  const grid = document.getElementById('apps');
  if (!grid) return;
  const search = document.querySelector('.search');
  const chips = [...document.querySelectorAll('[data-filter]')];
  const empty = document.querySelector('.empty');
  let cat = '';

  const apply = () => {
    const q = (search.value || '').trim().toLowerCase();
    let shown = 0;
    for (const card of grid.children) {
      const ok = (!cat || card.dataset.cat === cat) && (!q || card.dataset.search.includes(q));
      card.hidden = !ok;
      if (ok) shown += 1;
    }
    empty.hidden = shown !== 0;
  };

  search.addEventListener('input', apply);
  for (const chip of chips) {
    chip.addEventListener('click', () => {
      cat = chip.dataset.filter;
      for (const c of chips) c.setAttribute('aria-pressed', String(c === chip));
      apply();
    });
  }
})();
