import { createApp } from './bot.js';

const need = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in .env (see .env.example)`);
  return value;
};

const { bot, server } = createApp({
  botToken: need('BOT_TOKEN'),
  merchantChatId: need('MERCHANT_CHAT_ID'),
  publicUrl: need('PUBLIC_URL'),
  cigalpayAccountId: need('CIGALPAY_ACCOUNT_ID'),
  cigalpaySecret: need('CIGALPAY_NOTIFICATION_SECRET'),
  product: {
    name: process.env.PRODUCT_NAME || 'Coffee beans, 1 kg',
    description: process.env.PRODUCT_DESCRIPTION || 'freshly roasted, shipped within 2 days',
    amount: Number(process.env.PRODUCT_PRICE || 24.9),
    currency: process.env.PRODUCT_CURRENCY === 'USD' ? 'USD' : 'EUR',
  },
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`Notifications on :${port}/cigalpay/notify`));
// Long polling: no webhook to set up for Telegram itself.
bot.start({ onStart: (me) => console.log(`@${me.username} is running`) });
