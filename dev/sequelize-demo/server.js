// Records database queries for QueryLens (local only, off in production).
require('querylens-node/register');
const app = require('./app');

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Demo app on http://localhost:${port}`));
