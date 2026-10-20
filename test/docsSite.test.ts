import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { capabilities } from '../src/shared/capabilities.js';

/**
 * site/docs: the feature reference on deckwerk.org. Its content is one data
 * file (features.js) that render.mjs writes into index.html as plain HTML.
 * These checks keep the page from falling behind the app: every topic
 * `slide-agent capabilities` knows has an entry, and the HTML is the data's.
 */

interface Feature {
  id: string;
  title: string;
  topic?: string | string[];
  new?: boolean;
  what: string;
  where: string;
  html?: string;
  aka?: string[];
  media?: string;
  alt?: string;
  noVisual?: string;
}

interface Category {
  id: string;
  title: string;
  features: Feature[];
}

const docs = resolve(__dirname, '../site/docs');

// Plain JavaScript modules, loaded as the browser-free script loads them.
const load = async (file: string) => import(pathToFileURL(join(docs, file)).href);
const { categories } = (await load('features.js')) as { categories: Category[] };
const { renderPage, indexPath, media } = (await load('render.mjs')) as {
  renderPage: (page: string) => string;
  indexPath: string;
  media: Record<string, { kind: 'still' | 'clip'; w: number; h: number }>;
};

const features = categories.flatMap((category) => category.features);
const topics = (feature: Feature) => [feature.topic ?? []].flat();

describe('the docs site', () => {
  it('has an entry for every capabilities topic', () => {
    const covered = new Set(features.flatMap(topics));
    const missing = capabilities().map((capability) => capability.id).filter((id) => !covered.has(id));
    expect(missing).toEqual([]);
  });

  it('gives every entry a unique anchor, a title, a What and a Where', () => {
    const ids = [...categories.map((category) => category.id), ...features.map((feature) => feature.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const feature of features) {
      expect(feature.id, feature.title).toMatch(/^[a-z0-9-]+$/);
      for (const part of ['title', 'what', 'where'] as const) {
        expect(feature[part]?.trim(), `${feature.id}.${part}`).toBeTruthy();
      }
    }
  });

  it('shows every feature, or says why it cannot', () => {
    for (const feature of features) {
      const name = feature.media ?? feature.id;
      if (feature.noVisual) {
        expect(media[name], `${feature.id} has a picture and a noVisual reason`).toBeUndefined();
        expect(feature.noVisual.trim().length, feature.id).toBeGreaterThan(10);
      } else {
        expect(media[name], `${feature.id} has no picture in media/manifest.json and no noVisual reason`).toBeDefined();
      }
    }
  });

  it('keeps media/ to the pictures the page uses, small enough to load', () => {
    const used = new Set(features.filter((f) => !f.noVisual).map((f) => f.media ?? f.id));
    const files = readdirSync(join(docs, 'media')).filter((name) => name !== 'manifest.json');
    const expected = [...used].flatMap((name) => (media[name]?.kind === 'clip' ? [`${name}.mp4`, `${name}.webp`] : [`${name}.webp`]));
    expect(files.sort()).toEqual(expected.sort());
    expect(Object.keys(media).sort()).toEqual([...used].sort());
    let total = 0;
    for (const file of files) {
      const size = statSync(join(docs, 'media', file)).size;
      total += size;
      if (file.endsWith('.mp4')) expect(size, file).toBeLessThan(350 * 1024);
    }
    expect(total).toBeLessThan(12 * 1024 * 1024);
  });

  it('has index.html rendered from features.js (node site/docs/render.mjs)', () => {
    const page = readFileSync(indexPath, 'utf8');
    expect(renderPage(page) === page).toBe(true);
  });

  it('keeps to the writing rules', () => {
    const banned = /[\u2014\u2013\u00b7]|\b(powerful|seamless(ly)?|effortless(ly)?|robust|elevate|unlock|simply|just)\b|worth noting/i;
    const texts = [
      ...readdirSync(docs).filter((name) => /\.(html|js|mjs|css)$/.test(name)),
      ...readdirSync(join(docs, 'media-src')).map((name) => join('media-src', name)),
    ];
    for (const file of texts) {
      readFileSync(join(docs, file), 'utf8').split('\n').forEach((line, index) => {
        expect(line.match(banned)?.[0], `${file}:${index + 1}`).toBeUndefined();
      });
    }
  });
});
