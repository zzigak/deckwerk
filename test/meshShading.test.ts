// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { emptyDeck, type SlideElement } from '../src/shared/deck.js';
import { elementFromNode, slideToHtml, type MeasuredNode } from '../src/shared/htmlSlides.js';
import { referencedAssets } from '../src/main/exportDeck.js';
import { MESH_SHADING_MODES, meshShadingOf, withMeshShading } from '../src/shared/meshShading.js';
import { renderElement } from '../src/renderer/player/render.js';

/**
 * Shading for a dropped 3D model (normals, depth, UV checker, wireframe) is a
 * deck setting, not an agent job: it is stored on the web element as a
 * fragment and handed to the viewer page as its address `#…`.
 */

type Web = Extract<SlideElement, { type: 'web' }>;

function web(over: Partial<Web> = {}): Web {
  return {
    id: 'model', type: 'web', x: 0, y: 0, w: 720, h: 720, rot: 0, z: 1, opacity: 1,
    class: [], style: {}, src: 'assets/web/bunny.abcd1234.html', poster: null,
    interactive: true, title: 'bunny', fragment: 'shading=normals',
    ...over,
  } as Web;
}

describe('the shading setting', () => {
  it('reads the mode, and marks only 3D model pages', () => {
    expect(meshShadingOf('shading=depth')).toBe('depth');
    expect(meshShadingOf('shading=bogus')).toBe('auto');
    expect(meshShadingOf('')).toBeNull();
    expect(meshShadingOf(undefined)).toBeNull();
    expect(meshShadingOf('other=1')).toBeNull();
  });

  it('sets the mode and keeps other page settings', () => {
    expect(withMeshShading('shading=auto', 'uv')).toBe('shading=uv');
    expect(withMeshShading('spin=off&shading=auto', 'wireframe')).toBe('spin=off&shading=wireframe');
    expect(withMeshShading(undefined, 'clay')).toBe('shading=clay');
  });

  it('offers the same modes the viewer understands', async () => {
    const { readFile } = await import('node:fs/promises');
    const viewer = await readFile('src/meshViewer/viewer.js', 'utf8');
    for (const mode of MESH_SHADING_MODES) expect(viewer).toContain(`'${mode}'`);
  });
});

describe('the fragment on a web element', () => {
  it('round-trips through the HTML an agent edits', () => {
    const deck = emptyDeck('Mesh');
    deck.slides[0].elements.push(web());
    const html = slideToHtml(deck.slides[0], deck.canvas);
    expect(html).toContain('data-fragment="shading=normals"');
    const back = elementFromNode({
      tag: 'div', elementId: null, classes: [], rect: { x: 0, y: 0, w: 720, h: 720 }, rotation: 0,
      opacity: 1, style: {}, html: '', attrs: {},
      dataset: { element: 'web', src: 'assets/web/bunny.abcd1234.html', fragment: 'shading=normals' },
    } as MeasuredNode, 'model', 1) as Web;
    expect(back.fragment).toBe('shading=normals');
    expect(back.src).toBe('assets/web/bunny.abcd1234.html');
  });

  it('reaches the page as its address fragment, after the path is escaped', () => {
    const node = renderElement(web(), {
      resolveSrc: (src: string) => `/decks/d/${src.split('/').map(encodeURIComponent).join('/')}`,
    } as never);
    const frame = node.querySelector('iframe');
    expect(frame?.getAttribute('src')).toBe('/decks/d/assets/web/bunny.abcd1234.html#shading=normals');
  });

  it('never leaks into the file path the export copies', () => {
    const deck = emptyDeck('Mesh');
    deck.slides[0].elements.push(web());
    expect([...referencedAssets(deck)]).toContain('assets/web/bunny.abcd1234.html');
  });
});
