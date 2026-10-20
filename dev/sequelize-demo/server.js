// Monitors the database queries for QueryLens (set QUERYLENS_DSN).
require('querylens-node/register');
const app = require('./app');

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Demo app on http://localhost:${port}`));
