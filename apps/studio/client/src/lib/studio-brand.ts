export interface StudioBrand { name: string; logoUrl?: string; title?: string }
export function parseStudioBrand(value?: StudioBrand): StudioBrand | undefined {
  if (value === undefined) return;
  if (!value || typeof value.name !== 'string' || !value.name.trim() || value.title !== undefined && (typeof value.title !== 'string' || !value.title.trim())) throw new Error('Invalid Studio brand');
  if (value.logoUrl !== undefined && (typeof value.logoUrl !== 'string' || !value.logoUrl.startsWith('/') || value.logoUrl.startsWith('//') || /[\\\s]/.test(value.logoUrl))) throw new Error('Studio logo must be a same-origin absolute path');
  return { name: value.name.trim(), ...(value.logoUrl ? { logoUrl: value.logoUrl } : {}), ...(value.title ? { title: value.title.trim() } : {}) };
}
