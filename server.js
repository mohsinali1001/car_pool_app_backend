require('dotenv').config();
const app = require('./src/app');

const PORT = Number(process.env.PORT || 7860);
<<<<<<< HEAD
const HOST = process.env.HOST || '192.168.1.6';
=======
const HOST = '0.0.0.0';
>>>>>>> 8014cc70a65325c086dc7cabeeefe1f5034855c2

const server = app.listen(PORT, HOST, () => {
  console.log(`CarPool backend running at http://${HOST}:${PORT}`);
  console.log(`Health endpoint: http://${HOST}:${PORT}/health`);
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
