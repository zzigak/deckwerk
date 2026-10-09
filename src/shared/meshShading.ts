/**
 * How a 3D model page draws its meshes, stored in the web element's
 * `fragment` as `shading=<mode>` so the choice lives in the deck and survives
 * the HTML round trip. The viewer (src/meshViewer/viewer.js) reads the same
 * names from its address fragment.
 */
export const MESH_SHADING_MODES = ['auto', 'clay', 'normals', 'depth', 'uv', 'wireframe'] as const;
export type MeshShading = typeof MESH_SHADING_MODES[number];

/** The page's shading, or null when the fragment does not belong to a 3D model page. */
export function meshShadingOf(fragment: string | undefined): MeshShading | null {
  if (!fragment) return null;
  const mode = new URLSearchParams(fragment).get('shading');
  if (mode === null) return null;
  return (MESH_SHADING_MODES as readonly string[]).includes(mode) ? mode as MeshShading : 'auto';
}

/** The fragment with its shading set, keeping any other parameters. */
export function withMeshShading(fragment: string | undefined, mode: MeshShading): string {
  const params = new URLSearchParams(fragment ?? '');
  params.set('shading', mode);
  return params.toString();
}
