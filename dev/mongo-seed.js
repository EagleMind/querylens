// MongoDB demo dataset (database `shop`) with deliberate problems for QueryLens:
//   * orders has no index on userId or status (collection scans)
//   * orders sorted by total without an index (blocking in-memory sort)
//   * events.kind is skewed and indexed
const shop = db.getSiblingDB('shop')
const countries = ['US', 'DE', 'FR', 'TN', 'JP', 'BR']
const statuses = ['pending', 'paid', 'shipped', 'delivered', 'cancelled']
const day = 24 * 3600 * 1000
const now = Date.now()

function fill(coll, total, make) {
  for (let start = 1; start <= total; start += 10000) {
    const batch = []
    for (let n = start; n < start + 10000 && n <= total; n++) batch.push(make(n))
    coll.insertMany(batch, { ordered: false })
  }
}

fill(shop.users, 100000, (n) => ({
  _id: n,
  email: `user${n}@example.com`,
  country: countries[n % 6],
  createdAt: new Date(now - (n % 1000) * day),
}))
shop.users.createIndex({ email: 1 }, { unique: true })

fill(shop.orders, 300000, (n) => ({
  _id: n,
  userId: 1 + ((n * 7919) % 100000),
  status: statuses[n % 5],
  total: ((n * 31) % 100000) / 100,
  createdAt: new Date(now - (n % 730) * day),
  items: [{ productId: 1 + ((n * 13) % 5000), quantity: 1 + (n % 4) }],
}))

fill(shop.events, 300000, (n) => ({
  _id: n,
  userId: 1 + ((n * 7919) % 100000),
  kind: n % 10000 === 0 ? 'refund' : n % 100 === 0 ? 'purchase' : n % 10 === 0 ? 'click' : 'view',
  createdAt: new Date(now - (n % 365) * day),
}))
shop.events.createIndex({ kind: 1 })
