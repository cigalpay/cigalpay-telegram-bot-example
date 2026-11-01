# Accept crypto payments in a Telegram bot

A complete Telegram shop bot that takes payment in Bitcoin, USDT, Ethereum, Solana and more with [CigalPay](https://cigalpay.com/?utm_source=github&utm_medium=readme&utm_campaign=telegram-bot-example).
About 250 lines of Node.js, built on [grammY](https://grammy.dev) and the official
[`cigalpay-js-sdk`](https://www.npmjs.com/package/cigalpay-js-sdk).

Step-by-step article: [How to accept crypto payments in a Telegram bot](https://cigalpay.com/blog/accept-crypto-payments-telegram-bot?utm_source=github&utm_medium=readme&utm_campaign=telegram-bot-example).

## What it does

1. A customer opens the bot and taps **Buy**, then sends their delivery address.
2. The bot creates a CigalPay checkout and answers with a **Pay in crypto** button. The checkout opens inside Telegram:
   the customer picks a coin and sends the exact amount shown, locked for 30 minutes.
3. CigalPay sends a signed notification to your server when the payment is confirmed.
4. The bot checks it, confirms the order to the customer, and sends you the paid order (product, customer, address) in
   your own Telegram chat, ready to ship.

The example sells a bag of coffee. The same flow fits any physical product or real-world service: ask for an
appointment slot or a table instead of an address.

It also tells the customer when a payment is seen on the network, partly paid, or expired (with a button to start again),
in English or French.

## Run it

You need Node.js 20.6 or later, a Telegram bot from [@BotFather](https://t.me/BotFather) and a
[CigalPay account](https://cigalpay.com/register?utm_source=github&utm_medium=readme&utm_campaign=telegram-bot-example).

```bash
git clone https://github.com/cigalpay/cigalpay-telegram-bot-example.git
cd cigalpay-telegram-bot-example
npm install
cp .env.example .env     # fill it in
npm start
```

- **Your chat**: `MERCHANT_CHAT_ID` is where paid orders arrive. Send `/start` to [@userinfobot](https://t.me/userinfobot)
  to get your id, and start a chat with your own bot once so it can message you.
- **CigalPay**: your Account ID and notification signing secret are in the dashboard, Settings → API.
- **Notifications**: CigalPay posts to `{PUBLIC_URL}/cigalpay/notify`, so the server must be reachable over HTTPS. On your
  own computer, a tunnel works: `npx localtunnel --port 3000`, `ngrok` or `cloudflared`.

## The checks that matter

Before delivering anything, the bot verifies the notification (`src/bot.js`):

- **The signature** (`CigalPay.verifyWebhook`), on the raw body as received.
- **The checkout**: `checkoutId` must be the checkout this bot created for that order. Your Account ID isn't secret, so
  anyone could create their own checkout for your order number and pay $1; the signature alone doesn't stop that.
- **The price**: `checkoutAmount` and `checkoutCurrency` must match the order.
- **Once**: notifications can repeat, so a paid order is confirmed and forwarded once.

Never deliver because the customer came back from the checkout: only the signed notification proves the payment.

## Adapting it

- **A service**: ask for what you need (a date, a table, a phone number) instead of the address.
- **Shipping updates**: reply to the customer from the bot when you ship, using the Telegram user id stored with the order.
- **Several products**: give each one its own button and price; the checks stay the same.
- **A database**: `src/store.js` keeps orders in a JSON file to stay simple. Use your database in production.
- **Webhooks for Telegram**: the bot uses long polling; switch to grammY's webhook mode if you prefer.

## Telegram's rules

Telegram lets bots use any payment provider for **physical goods and services**. **Digital goods and services** sold
inside Telegram (access to a channel, files, courses, subscriptions) must be paid in Telegram Stars. You're responsible
for following [Telegram's terms for bot developers](https://telegram.org/tos/bot-developers) and
[CigalPay's terms](https://cigalpay.com/terms-of-service): no illegal goods or services.

## Tests

```bash
npm test
```

The tests run the whole purchase against a fake Telegram and a fake CigalPay: wrong signature, someone else's checkout,
wrong price, a too-short address, repeated notifications, partial and expired payments.

## License

MIT
