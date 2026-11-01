// A Telegram shop bot that takes crypto payments with CigalPay. The customer
// taps "Buy", sends a delivery address, pays on the CigalPay checkout (it
// opens inside Telegram) and gets a confirmation; you get the paid order in
// your own chat, ready to ship. Works the same for a real-world service:
// ask for an appointment slot instead of an address.
//
// Telegram's rules: physical goods and services can use any payment provider.
// Digital goods and services sold inside Telegram must use Telegram Stars.
// https://telegram.org/tos/bot-developers

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Bot, InlineKeyboard } from 'grammy';
import CigalPay, { isPaid } from 'cigalpay-js-sdk';
import { createStore } from './store.js';

const TEXT = {
  en: {
    welcome: (p) => `Welcome! <b>${p.name}</b>, ${p.price}: ${p.description}\n\nPay with Bitcoin, USDT, Ethereum, Solana and more.`,
    buy: (p) => `Buy for ${p.price}`,
    askAddress: 'Where should we deliver it? Send your full address (name, street, city, postcode, country) in one message.',
    addressTooShort: 'That looks too short for an address. Please send your full delivery address.',
    pay: 'Pay in crypto',
    checkout: (p, address) => `Your order: <b>${p.name}</b>, ${p.price}.\nDelivery to:\n${address}\n\nTap the button, pick a coin and send the exact amount shown. The price is locked for 30 minutes.`,
    unavailable: 'Payments are unavailable right now. Please try again in a few minutes.',
    confirming: 'Payment seen on the network. We\'ll confirm your order as soon as it\'s confirmed.',
    paid: (p, address) => `✅ Payment confirmed, thank you! Your <b>${p.name}</b> will be shipped to:\n${address}\n\nWe'll message you here when it's on its way.`,
    partial: 'We received less than the amount due. Send the rest to the same address on the payment page before it expires.',
    expired: 'Your payment link expired before the payment arrived. Tap below to start again.',
  },
  fr: {
    welcome: (p) => `Bienvenue ! <b>${p.name}</b>, ${p.price} : ${p.description}\n\nPayez en Bitcoin, USDT, Ethereum, Solana et plus.`,
    buy: (p) => `Acheter pour ${p.price}`,
    askAddress: 'Où devons-nous livrer ? Envoyez votre adresse complète (nom, rue, ville, code postal, pays) en un seul message.',
    addressTooShort: 'C\'est un peu court pour une adresse. Envoyez votre adresse de livraison complète.',
    pay: 'Payer en crypto',
    checkout: (p, address) => `Votre commande : <b>${p.name}</b>, ${p.price}.\nLivraison à :\n${address}\n\nTouchez le bouton, choisissez une crypto et envoyez le montant exact affiché. Le prix est bloqué 30 minutes.`,
    unavailable: 'Le paiement est indisponible pour le moment. Réessayez dans quelques minutes.',
    confirming: 'Paiement repéré sur le réseau. Nous confirmerons votre commande dès qu\'il sera confirmé.',
    paid: (p, address) => `✅ Paiement confirmé, merci ! Votre <b>${p.name}</b> sera livré à :\n${address}\n\nNous vous écrirons ici à l'expédition.`,
    partial: 'Nous avons reçu moins que le montant dû. Envoyez le reste à la même adresse sur la page de paiement avant qu\'elle expire.',
    expired: 'Votre lien de paiement a expiré avant l\'arrivée du paiement. Touchez ci-dessous pour recommencer.',
  },
};
const textFor = (lang) => TEXT[(lang || '').slice(0, 2)] ?? TEXT.en;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * @param {object} config
 * @param {string} config.botToken          From @BotFather
 * @param {string|number} config.merchantChatId  Your Telegram chat: paid orders are sent there
 * @param {{ name: string, description: string, amount: number, currency: 'USD'|'EUR' }} config.product
 * @param {string} config.publicUrl         Where CigalPay can reach this server (notifications)
 * @param {string} config.cigalpayAccountId Dashboard > Settings > API
 * @param {string} config.cigalpaySecret    Notification signing secret, same page
 * @param {string} [config.ordersFile]
 * @param {object} [config.botOptions]      Passed to grammY (tests point it at a fake Telegram)
 * @param {object} [config.cigalpayOptions] Passed to the SDK (tests point it at a fake CigalPay)
 */
export function createApp(config) {
  const bot = new Bot(config.botToken, config.botOptions);
  const cigalpay = new CigalPay({ accountId: config.cigalpayAccountId, ...config.cigalpayOptions });
  const store = createStore(config.ordersFile ?? 'orders.json');
  const product = config.product;
  const price = `${product.amount.toFixed(2)} ${product.currency}`;
  const shown = { name: esc(product.name), description: esc(product.description), price };
  // Customers who tapped Buy and owe us an address: Telegram user id -> order id.
  const awaitingAddress = new Map();

  bot.command('start', (ctx) => {
    const t = textFor(ctx.from?.language_code);
    return ctx.reply(t.welcome(shown), { parse_mode: 'HTML', reply_markup: new InlineKeyboard().text(t.buy(shown), 'buy') });
  });

  bot.callbackQuery('buy', async (ctx) => {
    await ctx.answerCallbackQuery();
    const order = store.put({
      id: randomUUID(),
      telegramUserId: ctx.from.id,
      telegramUsername: ctx.from.username ?? null,
      language: ctx.from.language_code ?? null,
      amount: product.amount,
      currency: product.currency,
      status: 'awaiting_address',
      createdAt: new Date().toISOString(),
    });
    awaitingAddress.set(ctx.from.id, order.id);
    await ctx.reply(textFor(ctx.from.language_code).askAddress);
  });

  // The next text message after Buy is the delivery address.
  bot.on('message:text', async (ctx) => {
    const orderId = awaitingAddress.get(ctx.from.id);
    if (!orderId || ctx.message.text.startsWith('/')) return;
    const t = textFor(ctx.from.language_code);
    const address = ctx.message.text.trim().slice(0, 500);
    if (address.length < 15) return ctx.reply(t.addressTooShort);
    awaitingAddress.delete(ctx.from.id);

    const order = store.update(orderId, { address, status: 'pending' });
    let checkout;
    try {
      checkout = await cigalpay.createCheckout({
        amount: order.amount,
        currency: order.currency,
        orderId: order.id,
        description: product.name,
        returnUrl: `https://t.me/${bot.botInfo.username}`,
        notifyUrl: `${config.publicUrl.replace(/\/+$/, '')}/cigalpay/notify`,
        lang: ['en', 'fr', 'es', 'de'].includes(order.language?.slice(0, 2)) ? order.language.slice(0, 2) : 'en',
      });
    } catch (err) {
      console.error('Checkout not created:', err.message);
      return ctx.reply(t.unavailable);
    }
    // The checkout id is what the notification must carry (see onNotification).
    store.update(order.id, { checkoutId: checkout.id });
    await ctx.reply(t.checkout(shown, esc(address)), { parse_mode: 'HTML', reply_markup: new InlineKeyboard().url(t.pay, checkout.chargeLink) });
  });

  /** Applies a verified notification to its order. Returns what happened, for logs and tests. */
  async function onNotification(payment) {
    const order = store.get(String(payment.extraId ?? ''));
    if (!order || !order.checkoutId) return 'unknown order';
    // Anyone can create a checkout with your account ID and an order number:
    // only trust a payment for the checkout this bot created, at this price.
    if (payment.checkoutId !== order.checkoutId) return 'other checkout';
    if (payment.checkoutCurrency !== order.currency || Math.abs(Number(payment.checkoutAmount) - order.amount) > 0.01) return 'wrong price';
    const t = textFor(order.language);

    if (isPaid(payment.status)) {
      // Notifications can repeat: confirm and forward the order once.
      if (order.status === 'paid') return 'already confirmed';
      store.update(order.id, { status: 'paid', paymentId: payment.id, paidAt: new Date().toISOString() });
      await bot.api.sendMessage(order.telegramUserId, t.paid(shown, esc(order.address)), { parse_mode: 'HTML' });
      await bot.api.sendMessage(
        config.merchantChatId,
        `🛒 <b>New paid order</b>\n${shown.name}, ${price}\n` +
          `Customer: ${order.telegramUsername ? `@${esc(order.telegramUsername)}` : `id ${order.telegramUserId}`}\n` +
          `Ship to:\n${esc(order.address)}\n\nOrder ${order.id}\nCigalPay payment ${esc(payment.id)}`,
        { parse_mode: 'HTML' },
      );
      return 'confirmed';
    }
    if (order.status === 'paid') return 'already confirmed';
    if (payment.status === 'CONFIRMING') {
      await bot.api.sendMessage(order.telegramUserId, t.confirming);
      return 'confirming';
    }
    if (payment.status === 'PARTIALLY_PAID') {
      await bot.api.sendMessage(order.telegramUserId, t.partial);
      return 'partial';
    }
    if (payment.status === 'EXPIRED') {
      store.update(order.id, { status: 'expired' });
      await bot.api.sendMessage(order.telegramUserId, t.expired, { reply_markup: new InlineKeyboard().text(t.buy(shown), 'buy') });
      return 'expired';
    }
    return 'ignored';
  }

  // CigalPay's payment notifications. The body is checked as received, before parsing.
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/cigalpay/notify') return res.writeHead(404).end();
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) req.destroy();
    });
    req.on('end', async () => {
      if (!CigalPay.verifyWebhook(raw, req.headers['x-cigalpay-sig'], config.cigalpaySecret)) return res.writeHead(401).end();
      try {
        const result = await onNotification(JSON.parse(raw));
        console.log(`Notification: ${result}`);
        res.writeHead(200).end();
      } catch (err) {
        // 500: CigalPay sends the notification again later.
        console.error('Notification failed:', err.message);
        res.writeHead(500).end();
      }
    });
  });

  return { bot, server, store, onNotification };
}
