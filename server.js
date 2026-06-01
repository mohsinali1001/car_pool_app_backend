require('dotenv').config();
const app = require('./src/app');

const PORT = Number(process.env.PORT || 7860);
const HOST = '0.0.0.0';

const server = app.listen(PORT, HOST, () => {
  console.log(`CarPool backend running at http://${HOST}:${PORT}`);
  console.log(`Health endpoint: http://${HOST}:${PORT}/health`);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
