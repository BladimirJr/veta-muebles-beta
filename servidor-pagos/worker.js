/* Servidor de firma de pagos para Taller El Arte (Cloudflare Worker).

   Wompi exige que cada cobro lleve una firma de integridad que se calcula con tu SECRETO DE INTEGRIDAD.
   Ese secreto no puede estar en la página (cualquiera lo leería), así que la firma se hace aquí.

   Lo que hace, en orden:
   1. Solo responde a las páginas de ORIGENES (tallerelarte.com).
   2. Revisa que la referencia, la moneda y las cantidades tengan sentido.
   3. Lee los precios de catálogo de la propia página (V.PRECIOS) y calcula cuánto valen los muebles pedidos.
   4. Si llega un código, lo busca en V.DESCUENTOS (su %) o en V.VENDEDORES (V.DESCUENTO_VENDEDOR %) de la página y rebaja ese porcentaje.
      Solo firma si el monto está entre ese valor y ese valor + un tope de envío. Así nadie puede pagar
      $1.000 por un mueble de $1.350.000 cambiando el código de la página en su navegador.
   5. Devuelve { signature }, que la página le entrega al widget de Wompi.

   No guarda nada: no hay base de datos ni datos de clientes aquí. */

const REFERENCIA = /^TEA-[A-Z0-9]{1,12}-[A-Z0-9]{6,24}$/;
const MAX_LINEAS = 20;

let memoria = { t: 0, precios: null, descuentos: {}, vendedores: { pct: 0, lista: [] } };

function json(obj, estado, cabeceras) {
  return new Response(JSON.stringify(obj), {
    status: estado || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cabeceras || {})
  });
}

async function sha256hex(texto) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/* Precios en pesos por id de modelo. Salen de la página publicada; si no se pueden leer, no se firma nada. */
export function extraerPrecios(html) {
  const m = /V\.PRECIOS\s*=\s*\{([^}]*)\}/.exec(html || '');
  if (!m) return null;
  const precios = {};
  for (const x of m[1].matchAll(/([A-Za-z0-9_]+)\s*:\s*(\d+)/g)) precios[x[1]] = parseInt(x[2], 10);
  return Object.keys(precios).length ? precios : null;
}

/* Códigos de descuento { CODIGO: porcentaje } de la página publicada. */
export function extraerDescuentos(html) {
  const m = /V\.DESCUENTOS\s*=\s*\{([^}]*)\}/.exec(html || '');
  const d = {};
  if (!m) return d;
  for (const x of m[1].matchAll(/['"]?([A-Za-z0-9]+)['"]?\s*:\s*(\d+)/g)) {
    const p = parseInt(x[2], 10);
    if (p > 0 && p < 100) d[x[1].toUpperCase()] = p;
  }
  return d;
}

/* Códigos de vendedor: { pct, lista } desde V.DESCUENTO_VENDEDOR y V.VENDEDORES de la página. */
export function extraerVendedores(html) {
  const p = /V\.DESCUENTO_VENDEDOR\s*=\s*(\d+)/.exec(html || '');
  const l = /V\.VENDEDORES\s*=\s*\[([^\]]*)\]/.exec(html || '');
  const pct = p ? parseInt(p[1], 10) : 0;
  const lista = l ? [...l[1].matchAll(/['"]([A-Za-z0-9]+)['"]/g)].map(x => x[1].toUpperCase()) : [];
  return { pct: pct > 0 && pct < 100 ? pct : 0, lista };
}

async function cargarPrecios(env) {
  if (env.PRECIOS) {
    try { return JSON.parse(env.PRECIOS); } catch (e) { return null; }
  }
  if (memoria.precios && Date.now() - memoria.t < 60000) return memoria.precios;
  try {
    const r = await fetch(env.URL_SITIO || 'https://tallerelarte.com/', { cf: { cacheTtl: 60 } });
    if (!r.ok) return null;
    const html = await r.text();
    const precios = extraerPrecios(html);
    if (precios) memoria = { t: Date.now(), precios, descuentos: extraerDescuentos(html), vendedores: extraerVendedores(html) };
    return precios;
  } catch (e) {
    return null;
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origenes = String(env.ORIGENES || 'https://tallerelarte.com,https://www.tallerelarte.com').split(',').map(x => x.trim()).filter(Boolean);
    const origen = req.headers.get('Origin') || '';
    const permitido = origenes.includes(origen);
    const cors = { Vary: 'Origin' };
    if (permitido) Object.assign(cors, {
      'Access-Control-Allow-Origin': origen,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    });

    if (req.method === 'OPTIONS') return new Response(null, { status: permitido ? 204 : 403, headers: cors });
    if (url.pathname !== '/firmar') return json({ error: 'No encontrado' }, 404, cors);
    if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405, cors);
    if (!permitido) return json({ error: 'Origen no permitido' }, 403, cors);
    if (!env.WOMPI_INTEGRITY_SECRET) return json({ error: 'Servidor sin configurar' }, 500, cors);

    let b;
    try { b = await req.json(); } catch (e) { return json({ error: 'JSON inválido' }, 400, cors); }
    if (!b || typeof b !== 'object') return json({ error: 'Datos inválidos' }, 400, cors);

    const { reference, amountInCents, currency, items, codigo } = b;
    if (currency !== 'COP') return json({ error: 'Moneda no válida' }, 400, cors);
    if (typeof reference !== 'string' || !REFERENCIA.test(reference)) return json({ error: 'Referencia no válida' }, 400, cors);
    if (!Number.isSafeInteger(amountInCents) || amountInCents <= 0 || amountInCents % 100 !== 0) return json({ error: 'Monto no válido' }, 400, cors);
    if (!Array.isArray(items) || items.length < 1 || items.length > MAX_LINEAS) return json({ error: 'Pedido no válido' }, 400, cors);

    const precios = await cargarPrecios(env);
    if (!precios) return json({ error: 'No se pudieron leer los precios. Intenta de nuevo.' }, 503, cors);

    const maxUnidades = parseInt(env.MAX_UNIDADES || '9', 10);
    let subtotal = 0;
    for (const it of items) {
      const precio = it && typeof it.id === 'string' && Object.prototype.hasOwnProperty.call(precios, it.id) ? precios[it.id] : null;
      if (!precio || !Number.isInteger(it.n) || it.n < 1 || it.n > maxUnidades) return json({ error: 'Pedido no válido' }, 422, cors);
      subtotal += precio * it.n;
    }

    /* Descuento: solo si el código está en la lista de la página (o en la variable DESCUENTOS). */
    let descuentos = memoria.descuentos || {};
    if (env.DESCUENTOS) { try { descuentos = JSON.parse(env.DESCUENTOS); } catch (e) { descuentos = {}; } }
    const cod = typeof codigo === 'string' ? codigo.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) : '';
    if (cod) {
      let pct = descuentos[cod];
      if (!(pct > 0 && pct < 100)) {
        let v = memoria.vendedores || { pct: 0, lista: [] };
        if (env.VENDEDORES) v = { pct: parseInt(env.DESCUENTO_VENDEDOR || '0', 10), lista: String(env.VENDEDORES).split(',').map(x => x.trim().toUpperCase()).filter(Boolean) };
        pct = v.lista.includes(cod) ? v.pct : 0;
      }
      if (!(pct > 0 && pct < 100)) return json({ error: 'Código de descuento no válido' }, 422, cors);
      subtotal -= Math.round(subtotal * pct / 100);
    }

    /* El envío lo calcula la página con las tarifas de las transportadoras; aquí solo se le pone un techo. */
    const tope = Math.max(parseInt(env.ENVIO_MAX_COP || '600000', 10), Math.round(subtotal * 0.3));
    const pesos = amountInCents / 100;
    if (pesos < subtotal || pesos > subtotal + tope) return json({ error: 'El monto no coincide con el pedido' }, 422, cors);

    const signature = await sha256hex(reference + amountInCents + currency + env.WOMPI_INTEGRITY_SECRET);
    return json({ signature }, 200, cors);
  }
};
