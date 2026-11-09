import { intEnv } from '../../lib/config.js';

// Cálculo OFICIAL de totales. Nada de lo que envíe el navegador (precios, descuentos, totales)
// llega hasta aquí: las líneas provienen de la cotización de inventory.
//
// Promociones del sitio (barra superior del frontend):
//  - 15 % en la primera compra con el cupón NATURALPOWER (se aplica sobre el subtotal ya promocionado).
//  - Despacho gratis sobre $15.000 (se evalúa sobre el subtotal tras promociones, antes del cupón).
//  - Martes y jueves (hora de Chile): 2x1 en smoothies pequeños.
// Supuesto propio (el frontend no define tarifa): despacho $2.500 si no alcanza el umbral.

export const DELIVERY_FEE = intEnv('DELIVERY_FEE', 2500);
export const FREE_DELIVERY_FROM = intEnv('FREE_DELIVERY_FROM', 15000);

export function chileWeekday(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'America/Santiago' }).format(date);
}

export function computePricing({ lines, fulfillment, coupon, now = new Date() }) {
  const day = chileWeekday(now);
  const twoForOne = day === 'Tue' || day === 'Thu';

  let subtotal = 0;
  let itemDiscount = 0;
  const priced = lines.map((line) => {
    let discount = 0;
    let promo = null;
    if (twoForOne && line.kind === 'product' && line.category === 'smoothie' && line.size === 'small') {
      discount = Math.floor(line.quantity / 2) * line.unitPrice;
      if (discount > 0) promo = '2x1';
    }
    subtotal += line.lineTotal;
    itemDiscount += discount;
    return { ...line, discount, promo };
  });

  const afterPromo = subtotal - itemDiscount;
  const couponDiscount = coupon ? Math.floor((afterPromo * coupon.percent) / 100) : 0;
  const deliveryFee = fulfillment === 'delivery' && afterPromo < FREE_DELIVERY_FROM ? DELIVERY_FEE : 0;
  const total = afterPromo - couponDiscount + deliveryFee;

  return {
    lines: priced,
    subtotal,
    discountTotal: itemDiscount + couponDiscount,
    couponDiscount,
    deliveryFee,
    total,
  };
}
