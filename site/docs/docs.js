// The docs page's behaviour on top of its static HTML: search as you type,
// collapsing sidebar categories, the current feature highlighted while
// scrolling, and the sidebar as a drawer on phones. No dependencies.
(() => {
  const input = document.getElementById('search');
  const side = document.querySelector('.side');
  const intro = document.querySelector('.intro');
  const empty = document.querySelector('.none');
  const categories = [...document.querySelectorAll('section.category')];
  const features = [...document.querySelectorAll('article.feature')];
  const links = new Map(
    [...side.querySelectorAll('.cat ul a')].map((a) => [a.getAttribute('href').slice(1), a]),
  );
  const navCats = new Map(
    [...side.querySelectorAll('.cat')].map((li) => [li.dataset.cat, li]),
  );
  const fold = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  // What a feature is found by: its text, and the names Keynote and
  // PowerPoint give it (data-aka), so "magic move" finds Morph.
  const haystack = new Map(features.map((el) => [
    el, ` ${fold(`${el.textContent} ${el.dataset.aka ?? ''}`.replace(/\s+/g, ' '))}`,
  ]));
  const titles = new Map(features.map((el) => [
    el, ` ${fold(`${el.querySelector('h3').textContent} ${el.dataset.aka ?? ''}`)}`,
  ]));
  // A term matches at the start of a word, so "pen" finds Pen and pencil
  // but not "open".
  const wordStart = (text, term) => {
    for (let at = text.indexOf(term); at >= 0; at = text.indexOf(term, at + 1)) {
      if (!/[a-z0-9]/.test(text[at - 1])) return true;
    }
    return false;
  };
  const categoryOf = (el) => el.closest('section.category').id;

  // ---- sidebar categories -------------------------------------------------
  // A category opens when the reader reaches it and closes again behind them,
  // unless they opened or closed it by hand.
  const pinned = new Set();
  const setOpen = (li, open) => {
    li.classList.toggle('open', open);
    li.querySelector('.chev').setAttribute('aria-expanded', String(open));
  };
  for (const li of navCats.values()) {
    setOpen(li, false);
    li.querySelector('.chev').addEventListener('click', () => {
      pinned.add(li.dataset.cat);
      setOpen(li, !li.classList.contains('open'));
    });
  }

  // ---- current feature ------------------------------------------------------
  let current = null;
  const revealInSide = (a) => {
    const box = side.getBoundingClientRect();
    const row = a.getBoundingClientRect();
    if (row.top < box.top + 8) side.scrollTop -= box.top + 8 - row.top + 40;
    else if (row.bottom > box.bottom - 8) side.scrollTop += row.bottom - box.bottom + 8 + 40;
  };
  const setCurrent = (id) => {
    if (id === current) return;
    if (current) links.get(current)?.classList.remove('current');
    current = id;
    const a = id && links.get(id);
    if (!a) return;
    a.classList.add('current');
    const cat = a.closest('.cat');
    if (!searching()) {
      for (const li of navCats.values()) {
        if (!pinned.has(li.dataset.cat)) setOpen(li, li === cat);
      }
    }
    revealInSide(a);
  };
  const spy = () => {
    const line = 120;
    let found = null;
    for (const el of features) {
      if (el.classList.contains('hidden')) continue;
      if (el.getBoundingClientRect().top <= line) found = el;
      else if (found) break;
    }
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
      const visible = features.filter((el) => !el.classList.contains('hidden'));
      found = visible[visible.length - 1] ?? found;
    }
    if (!found) found = features.find((el) => !el.classList.contains('hidden')) ?? null;
    setCurrent(found ? found.id : null);
  };
  let queued = false;
  window.addEventListener('scroll', () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; spy(); });
  }, { passive: true });
  window.addEventListener('resize', spy);

  // ---- search ---------------------------------------------------------------
  const searching = () => input.value.trim() !== '';
  const search = () => {
    const terms = fold(input.value).split(/\s+/).filter(Boolean);
    const shown = new Set();
    for (const el of features) {
      const hit = terms.every((term) => wordStart(haystack.get(el), term));
      el.classList.toggle('hidden', !hit);
      links.get(el.id)?.parentElement.classList.toggle('hidden', !hit);
      if (hit) shown.add(categoryOf(el));
    }
    for (const section of categories) section.classList.toggle('hidden', !shown.has(section.id));
    for (const [id, li] of navCats) {
      li.classList.toggle('hidden', !shown.has(id));
      if (terms.length) setOpen(li, true);
    }
    intro.classList.toggle('hidden', terms.length > 0);
    empty.classList.toggle('show', terms.length > 0 && shown.size === 0);
    if (!terms.length) {
      for (const li of navCats.values()) if (!pinned.has(li.dataset.cat)) setOpen(li, false);
      current = null;
    }
    spy();
  };
  input.addEventListener('input', () => {
    search();
    window.scrollTo(0, 0);
  });
  const go = (el) => {
    history.replaceState(null, '', `#${el.id}`);
    el.scrollIntoView();
    setCurrent(el.id);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // The first hit whose title matches, else the first hit.
      const terms = fold(input.value).split(/\s+/).filter(Boolean);
      const shown = features.filter((el) => !el.classList.contains('hidden'));
      const first = shown.find((el) => terms.every((term) => wordStart(titles.get(el), term))) ?? shown[0];
      if (first && searching()) {
        e.preventDefault();
        input.blur();
        closeMenu();
        go(first);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (searching()) {
        const keep = current;
        input.value = '';
        search();
        const el = keep && document.getElementById(keep);
        if (el) go(el);
      } else {
        input.blur();
      }
    }
  });
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t instanceof HTMLElement
      && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      input.focus();
      input.select();
    } else if (e.key === 'Escape' && document.body.classList.contains('menu-open')) {
      closeMenu();
    }
  });

  // ---- phone drawer ---------------------------------------------------------
  const menu = document.querySelector('.menu-button');
  function closeMenu() {
    document.body.classList.remove('menu-open');
    menu.setAttribute('aria-expanded', 'false');
  }
  menu.addEventListener('click', () => {
    const open = !document.body.classList.contains('menu-open');
    document.body.classList.toggle('menu-open', open);
    menu.setAttribute('aria-expanded', String(open));
    if (open && current) revealInSide(links.get(current));
  });
  side.addEventListener('click', (e) => {
    if (e.target instanceof Element && e.target.closest('a')) closeMenu();
  });
  document.querySelector('main').addEventListener('click', closeMenu);

  // ---- clips ----------------------------------------------------------------
  // Each clip plays while it is on screen, muted and looping, and stops when
  // it scrolls away. With reduced motion only its poster shows.
  const clips = [...document.querySelectorAll('figure video')];
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  const watch = new IntersectionObserver((entries) => {
    for (const { target, isIntersecting } of entries) {
      if (isIntersecting && !still.matches) {
        target.preload = 'auto';
        void target.play().catch(() => {});
      } else {
        target.pause();
      }
    }
  }, { threshold: 0.4 });
  for (const video of clips) {
    video.removeAttribute('controls');
    watch.observe(video);
  }

  spy();
})();
