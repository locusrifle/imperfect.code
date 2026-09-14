// Two product compositions share one server. Stock is the ready-to-run Pi GUI.
// imperfect is Noah's overlay. Unset GUEY_PRODUCT keeps today's live unit
// (IMPERFECT_HOST) personal; desktop sets stock explicitly.

export function resolveProduct(options = {}) {
  const raw = options.product ?? process.env.GUEY_PRODUCT;
  if (raw === 'stock' || raw === 'guey') return 'stock';
  if (raw === 'imperfect') return 'imperfect';
  if (process.env.IMPERFECT_HOST) return 'imperfect';
  return options.defaultProduct ?? 'imperfect';
}

// The customer-facing name. A deployment may sell this foundation under its own
// label without forking the composition; unset it and the product keeps its own name.
export function resolveBrand(options = {}) {
  const raw = options.brand ?? process.env.GUEY_BRAND;
  const name = typeof raw === 'string' ? raw.trim() : '';
  // Injected into a script and a document title, so refuse anything but a plain name.
  if (!name || !/^[\w .'-]{1,32}$/.test(name)) return 'Guey';
  return name;
}

export const PERSONAL_CONTROL_IDS = new Set([
  'capture',
]);
