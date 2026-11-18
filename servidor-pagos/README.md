# Servidor de firma de pagos (Cloudflare Worker)

La página `tallerelarte.com` es estática (GitHub Pages). Wompi exige que cada cobro lleve una **firma de integridad**
calculada con tu *secreto de integridad*, y ese secreto no puede estar en la página. Este Worker hace la firma.

## Qué hace
1. Solo acepta pedidos que vengan de `tallerelarte.com`.
2. Lee los precios de catálogo de la propia página (`V.PRECIOS` en `index.html`).
3. Calcula cuánto valen los muebles del pedido y **solo firma si el monto está entre ese valor y ese valor + el tope de envío**.
4. Responde `{ "signature": "..." }`.

No guarda datos de clientes ni de pedidos.

## Desplegar (una sola vez)
Necesitas una cuenta gratuita de Cloudflare y Node.js.

```bash
cd servidor-pagos
npx wrangler login
npx wrangler secret put WOMPI_INTEGRITY_SECRET     # pega el secreto de integridad de PRODUCCIÓN (prod_integrity_...)
npx wrangler deploy
```

`wrangler deploy` te muestra la dirección del Worker, por ejemplo
`https://taller-el-arte-pagos.TU-USUARIO.workers.dev`.

## Conectarlo a la página
En `index.html`, busca `V.PAGOS` y completa:

```js
V.PAGOS={
  llavePublica:'pub_prod_XXXXXXXX',                                       // Wompi → Desarrolladores → llave pública de producción
  endpointFirma:'https://taller-el-arte-pagos.TU-USUARIO.workers.dev/firmar',
  checkoutJs:'https://checkout.wompi.co/widget.js'
};
```

Con eso, el cliente ve el botón **Pagar con Wompi** en el carrito. Mientras `V.PAGOS` esté vacío, el cliente solo ve
**Pedir por WhatsApp** y tú puedes probar con llaves de prueba desde `tallerelarte.com/?taller=1`.

## Probar antes de cobrar de verdad
1. Despliega el Worker con el secreto de **pruebas** (`test_integrity_...`) y pon la llave `pub_test_...` en `V.PAGOS`.
2. Haz un pedido con las tarjetas de prueba (4242 4242 4242 4242 aprueba, 4111 1111 1111 1111 rechaza).
3. Cuando todo funcione, vuelve a correr `npx wrangler secret put WOMPI_INTEGRITY_SECRET` con el secreto de producción y cambia la llave a `pub_prod_...`.

## Ajustes (`wrangler.toml`)
- `ORIGENES`: páginas que pueden pedir firmas. Agrega otras si usas otro dominio.
- `ENVIO_MAX_COP`: tope de envío que se acepta por encima del precio (por defecto $600.000, o el 30% del pedido si es mayor).
- `MAX_UNIDADES`: máximo de unidades por mueble.
- `URL_SITIO`: de dónde se leen los precios.

## Lo que este Worker NO hace (y qué hacer)
- **El envío lo calcula la página** con las tarifas de las transportadoras, no el Worker. El Worker solo verifica que el
  monto no sea menor al precio de los muebles ni pase el tope. Por eso, **antes de fabricar, compara el monto cobrado en
  tu panel de Wompi con el pedido** (el mensaje de WhatsApp trae la referencia y el total).
- **No confirma pagos.** Que el widget diga «aprobado» no es la confirmación final: revisa la transacción en el panel de
  Wompi por su referencia (`TEA-CODIGO-...`). Si luego quieres automatizarlo, se agrega un webhook de eventos de Wompi.
- Quien llame al Worker con `curl` puede falsificar el encabezado `Origin`; lo que realmente protege es la verificación del precio.
  Si ves abuso, activa una regla de *Rate limiting* en Cloudflare para la ruta `/firmar`.
