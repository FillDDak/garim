/** Absolute URL of a file shipped in public/ (works under any GitHub Pages sub-path). */
export const assetUrl = (path: string) => new URL(`${import.meta.env.BASE_URL}${path}`, window.location.href).href
