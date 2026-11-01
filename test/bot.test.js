// The whole purchase against a fake Telegram and a fake CigalPay.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/bot.js';

const SECRET = 'test-signing-secret';
const calls = []; // Telegram API calls
const checkouts = []; // checkouts created at CigalPay
let n = 0;

function listen(handler) {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => handler(req, res, raw));
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const url = (s) => `http://127.0.0.1:${s.address().port}`;

let telegram, cigalpay, app, notifyUrl;
before(async () => {
  telegram = await listen((req, res, raw) => {
    const method = req.url.split('/').pop();
    const body = raw ? JSON.parse(raw) : {};
    calls.push({ method, body });
    const result =
      method === 'getMe' ? { id: 1, is_bot: true, first_name: 'Shop', username: 'shop_test_bot' }
      : method === 'createChatInviteLink' ? { invite_link: `x${++n}` }
      : true;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result }));
  });
  cigalpay = await listen((req, res, raw) => {
    const body = JSON.parse(raw);
    checkouts.push(body);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `chk-${checkouts.length}`, chargeLink: `https://pay.cigalpay.com/charge/chk-${checkouts.length}` }));
  });
  app = createApp({
    botToken: '123:test',
    merchantChatId: 777,
    publicUrl: 'https://shop.example.com/',
    cigalpayAccountId: 'acc-1',
    cigalpaySecret: SECRET,
    product: { name: 'Coffee beans, 1 kg', description: 'freshly roasted', amount: 24.9, currency: 'EUR' },
    ordersFile: join(mkdtempSync(join(tmpdir(), 'cp-bot-')), 'orders.json'),
    botOptions: { client: { apiRoot: url(telegram) } },
    cigalpayOptions: { checkoutUrl: url(cigalpay) },
  });
  await app.bot.init();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  notifyUrl = `${url(app.server)}/cigalpay/notify`;
});
after(() => {
  telegram.close();
  cigalpay.close();
  app.server.close();
});

let updateId = 0;
const fromUser = { id: 42, is_bot: false, first_name: 'Ana', username: 'ana', language_code: 'fr' };
const message = (text) => ({ update_id: ++updateId, message: { message_id: updateId, date: 0, chat: { id: 42, type: 'private' }, from: fromUser, text, entities: text.startsWith('/') ? [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }] : undefined } });
const tap = (data) => ({ update_id: ++updateId, callback_query: { id: `cb${updateId}`, from: fromUser, chat_instance: '1', data, message: { message_id: 1, date: 0, chat: { id: 42, type: 'private' } } } });

// Signed like CigalPay: HMAC-SHA512 of the JSON with its top-level keys sorted.
function notify(payment, secret = SECRET) {
  const body = JSON.stringify(payment);
  const sig = createHmac('sha512', secret).update(JSON.stringify(payment, Object.keys(payment).sort())).digest('hex');
  return fetch(notifyUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cigalpay-sig': sig }, body });
}
const sent = (method) => calls.filter((c) => c.method === method);
const lastMessage = () => sent('sendMessage').at(-1)?.body;

let order;
const ADDRESS = 'Ana Silva, 12 rue des Lilas, 75011 Paris, France';
const toUser = () => sent('sendMessage').filter((m) => m.body.chat_id === 42);
const toMerchant = () => sent('sendMessage').filter((m) => m.body.chat_id === 777);

test('/start shows the product and a Buy button, in the customer\'s language', async () => {
  await app.bot.handleUpdate(message('/start'));
  const m = lastMessage();
  assert.match(m.text, /<b>Coffee beans, 1 kg<\/b>, 24\.90 EUR/);
  assert.equal(m.reply_markup.inline_keyboard[0][0].callback_data, 'buy');
});

test('Buy asks for the delivery address; a too-short one is refused', async () => {
  await app.bot.handleUpdate(tap('buy'));
  assert.match(lastMessage().text, /Où devons-nous livrer/);
  await app.bot.handleUpdate(message('Paris'));
  assert.match(lastMessage().text, /un peu court/);
  assert.equal(checkouts.length, 0);
});

test('the address creates a CigalPay checkout and a Pay button', async () => {
  await app.bot.handleUpdate(message(ADDRESS));
  const c = checkouts.at(-1);
  assert.equal(c.accountId, 'acc-1');
  assert.equal(c.amount, 24.9);
  assert.equal(c.currency, 'EUR');
  assert.equal(c.description, 'Coffee beans, 1 kg');
  assert.equal(c.callback, 'https://t.me/shop_test_bot');
  assert.equal(c.ipn, 'https://shop.example.com/cigalpay/notify');
  assert.equal(c.lang, 'fr');
  order = app.store.get(c.extraId);
  assert.equal(order.address, ADDRESS);
  assert.equal(order.checkoutId, 'chk-1');
  assert.match(lastMessage().text, /Livraison à :\nAna Silva/);
  assert.equal(lastMessage().reply_markup.inline_keyboard[0][0].url, 'https://pay.cigalpay.com/charge/chk-1');
});

const paid = (over = {}) => ({ id: 'pay-1', status: 'CONFIRMED', extraId: order.id, checkoutId: 'chk-1', checkoutAmount: '24.9', checkoutCurrency: 'EUR', amount: 25, currency: 'USDT_TRX', ...over });

test('a notification with a bad signature is refused', async () => {
  assert.equal((await notify(paid(), 'wrong-secret')).status, 401);
  assert.equal(toMerchant().length, 0);
});

test('a payment for another checkout or at another price confirms nothing', async () => {
  assert.equal((await notify(paid({ checkoutId: 'someone-elses' }))).status, 200);
  assert.equal((await notify(paid({ checkoutAmount: '1' }))).status, 200);
  assert.equal(toMerchant().length, 0);
  assert.equal(app.store.get(order.id).status, 'pending');
});

test('CONFIRMING tells the customer to wait', async () => {
  await notify(paid({ status: 'CONFIRMING' }));
  assert.match(lastMessage().text, /Paiement repéré/);
});

test('a confirmed payment confirms to the customer and sends the order to the merchant, once', async () => {
  assert.equal((await notify(paid())).status, 200);
  assert.match(toUser().at(-1).body.text, /Paiement confirmé.*livré à :\nAna Silva/s);
  const m = toMerchant().at(-1).body.text;
  assert.match(m, /New paid order<\/b>\nCoffee beans, 1 kg, 24\.90 EUR/);
  assert.match(m, /Customer: @ana/);
  assert.match(m, /Ship to:\nAna Silva, 12 rue des Lilas/);
  assert.equal(app.store.get(order.id).status, 'paid');
  await notify(paid({ status: 'FINISHED' }));
  await notify(paid());
  assert.equal(toMerchant().length, 1);
});

test('partial and expired payments tell the customer what to do', async () => {
  await app.bot.handleUpdate(tap('buy'));
  await app.bot.handleUpdate(message('Ana Silva, 3 avenue Foch, 69006 Lyon'));
  const second = app.store.get(checkouts.at(-1).extraId);
  const base = { id: 'pay-2', extraId: second.id, checkoutId: second.checkoutId, checkoutAmount: '24.9', checkoutCurrency: 'EUR' };
  await notify({ ...base, status: 'PARTIALLY_PAID' });
  assert.match(lastMessage().text, /moins que le montant dû/);
  await notify({ ...base, status: 'EXPIRED' });
  assert.match(lastMessage().text, /a expiré/);
  assert.equal(lastMessage().reply_markup.inline_keyboard[0][0].callback_data, 'buy');
  assert.equal(toMerchant().length, 1);
});

test('a message without a pending order is ignored', async () => {
  const before = sent('sendMessage').length;
  await app.bot.handleUpdate(message('hello'));
  assert.equal(sent('sendMessage').length, before);
});
