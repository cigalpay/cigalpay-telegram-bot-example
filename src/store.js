// Orders, kept in a JSON file so the example has no database to set up.
// In production, use your database: the checks in bot.js stay the same.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

export function createStore(file) {
  const orders = new Map(existsSync(file) ? Object.entries(JSON.parse(readFileSync(file, 'utf8'))) : []);

  function save() {
    // Write then rename, so a crash never leaves a half-written file.
    writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(orders), null, 2));
    renameSync(`${file}.tmp`, file);
  }

  return {
    get: (id) => orders.get(id),
    put(order) {
      orders.set(order.id, order);
      save();
      return order;
    },
    update(id, changes) {
      const order = { ...orders.get(id), ...changes };
      orders.set(id, order);
      save();
      return order;
    },
  };
}
