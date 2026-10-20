// Writes the features in features.js into index.html as plain HTML, so the
// page reads with scripts off, from file://, and to a search engine.
//
//   node site/docs/render.mjs
//
// Run it after editing features.js. test/docsSite.test.ts fails while
// index.html is out of date. The page's own script (docs.js) only adds search,
// the collapsing sidebar and the scroll highlight on top of this HTML.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { categories } from './features.js';

const here = dirname(fileURLToPath(import.meta.url));
/** The pictures: media/<id>.webp, and for a clip media/<id>.mp4 (media-src/capture.mjs). */
export const media = JSON.parse(readFileSync(join(here, 'media', 'manifest.json'), 'utf8'));

const escapeHtml = (text) => String(text)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Prose: HTML-escaped, with `backticks` as code. */
function inline(text) {
  return escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** A UI path: "Build tab > effect menu > anvil", the steps set apart. */
function path(text) {
  return text
    .split(' > ')
    .map(inline)
    .join('<span class="sep">&#8250;</span>');
}

function feature(item) {
  const lines = [
    `<article class="feature" id="${item.id}"${item.aka ? ` data-aka="${escapeHtml(item.aka.join(', '))}"` : ''}>`,
    `<h3><a class="self" href="#${item.id}">${inline(item.title)}</a>${item.new ? ' <span class="new">(new)</span>' : ''}</h3>`,
    `<p class="what">${inline(item.what)}</p>`,
    `<p class="where"><b>Where:</b> <span class="path">${path(item.where)}</span></p>`,
  ];
  const name = item.media ?? item.id;
  const picture = media[name];
  if (picture) {
    const alt = escapeHtml(item.alt ?? item.title);
    const size = `width="${picture.w}" height="${picture.h}"`;
    // A clip has controls until docs.js plays it on sight, so it can be
    // played with scripts off; with reduced motion only its poster shows.
    lines.push(picture.kind === 'clip'
      ? `<figure><video ${size} poster="media/${name}.webp" muted loop playsinline controls preload="none" aria-label="${alt}">`
        + `<source src="media/${name}.mp4" type="video/mp4"></video></figure>`
      : `<figure><img src="media/${name}.webp" ${size} alt="${alt}" loading="lazy" decoding="async"></figure>`);
  }
  if (item.html) {
    lines.push(`<details class="html"><summary>In HTML</summary><pre><code>${escapeHtml(item.html)}</code></pre></details>`);
  }
  lines.push('</article>');
  return lines.join('\n');
}

export function renderNav(list = categories) {
  return list.map((category) => [
    `<li class="cat" data-cat="${category.id}">`,
    '<div class="cat-head">'
      + `<button class="chev" type="button" aria-expanded="true" aria-label="${escapeHtml(category.title)}">`
      + '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>'
      + `<a href="#${category.id}">${inline(category.title)}</a></div>`,
    '<ul>',
    ...category.features.map((item) => `<li><a href="#${item.id}">${inline(item.title)}</a></li>`),
    '</ul>',
    '</li>',
  ].join('\n')).join('\n');
}

export function renderContent(list = categories) {
  return list.map((category) => [
    `<section class="category" id="${category.id}">`,
    `<h2>${inline(category.title)}</h2>`,
    category.blurb ? `<p class="blurb">${inline(category.blurb)}</p>` : '',
    ...category.features.map(feature),
    '</section>',
  ].filter(Boolean).join('\n')).join('\n');
}

/** index.html with both generated regions replaced. */
export function renderPage(page, list = categories) {
  const fill = (html, name, body) => {
    const start = `<!-- docs:${name} -->`;
    const end = `<!-- /docs:${name} -->`;
    const from = html.indexOf(start);
    const to = html.indexOf(end);
    if (from < 0 || to < from) throw new Error(`index.html has no ${start} … ${end} region`);
    return `${html.slice(0, from + start.length)}\n${body}\n${html.slice(to)}`;
  };
  return fill(fill(page, 'nav', renderNav(list)), 'content', renderContent(list));
}

export const indexPath = resolve(here, 'index.html');

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const before = readFileSync(indexPath, 'utf8');
  const after = renderPage(before);
  writeFileSync(indexPath, after);
  console.log(before === after ? 'index.html already up to date' : 'index.html updated');
}
